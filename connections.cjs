"use strict";

const radioWinRtPowerShell = `
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]

  function Wait-WinRtOperation($operation, [Type]$resultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1
      } |
      Select-Object -First 1

    $task = $method.MakeGenericMethod([type[]]@($resultType)).Invoke(
      $null,
      [object[]]@($operation)
    )
    $task.GetAwaiter().GetResult()
  }
`;

const wifiInfoPowerShell = `
  $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue)
  $adapter = $adapters |
    Where-Object { $_.NdisPhysicalMedium -eq 9 } |
    Select-Object -First 1

  if (-not $adapter) {
    $adapter = $adapters |
      Where-Object { $_.Name -match 'Wi-Fi|Wireless|WLAN' } |
      Select-Object -First 1
  }

  if ($adapter) {
    $profile = Get-NetConnectionProfile -InterfaceAlias $adapter.Name -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $connected = $adapter.Status -eq 'Up' -and [bool]$profile

    $wifi = [pscustomobject]@{
      enabled = ($adapter.Status -ne 'Disabled')
      connected = $connected
      name = if ($connected) { $profile.Name } else { $null }
      adapterName = $adapter.Name
      status = [string]$adapter.Status
    }
  } else {
    $wifi = [pscustomobject]@{
      enabled = $false
      connected = $false
      name = $null
      adapterName = $null
      status = 'Unavailable'
    }
  }
`;

function createConnectionService({
  runPowerShell,
  runPowerShellElevated,
  parseJson,
  radioWinRtPowerShell: radioPowerShell = radioWinRtPowerShell
}) {
  const bluetoothInfoPowerShell = `
    ${radioPowerShell}
    $radios = Wait-WinRtOperation ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $radio = $radios | Where-Object { $_.Kind.ToString() -eq 'Bluetooth' } |
      Select-Object -First 1

    $bluetooth = [pscustomobject]@{
      enabled = [bool]($radio -and $radio.State.ToString() -eq 'On')
      available = [bool]$radio
      radioName = if ($radio) { $radio.Name } else { $null }
    }
  `;

  async function getWifiInfo() {
    return parseJson(await runPowerShell(
      `${wifiInfoPowerShell}\n$wifi | ConvertTo-Json -Compress`
    ));
  }

  async function getBluetoothInfo() {
    return parseJson(await runPowerShell(
      `${bluetoothInfoPowerShell}\n$bluetooth | ConvertTo-Json -Compress`
    ));
  }

  async function getConnections() {
    const script = `
      ${wifiInfoPowerShell}
      ${bluetoothInfoPowerShell}
      [pscustomobject]@{
        wifi = $wifi
        bluetooth = $bluetooth
      } | ConvertTo-Json -Compress -Depth 3
    `;

    return parseJson(await runPowerShell(script));
  }

  async function setWifi(enabled) {
    if (typeof enabled !== "boolean") {
      throw new Error("Invalid Wi-Fi state.");
    }

    const command = enabled ? "Enable-NetAdapter" : "Disable-NetAdapter";
    const script = `
      $ErrorActionPreference = 'Stop'
      $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue)
      $adapter = $adapters |
        Where-Object { $_.NdisPhysicalMedium -eq 9 } |
        Select-Object -First 1

      if (-not $adapter) {
        $adapter = $adapters |
          Where-Object { $_.Name -match 'Wi-Fi|Wireless|WLAN' } |
          Select-Object -First 1
      }

      if (-not $adapter) {
        throw 'Wi-Fi adapter was not found.'
      }

      ${command} -Name $adapter.Name -Confirm:$false -ErrorAction Stop
      'OK'
    `;

    await runPowerShellElevated(script, 60000);
    return { success: true, enabled };
  }

  async function setBluetooth(enabled) {
    if (typeof enabled !== "boolean") {
      throw new Error("Invalid Bluetooth state.");
    }

    const script = `
      $ErrorActionPreference = 'Stop'
      ${radioPowerShell}

      $access = Wait-WinRtOperation ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
      if ($access.ToString() -ne 'Allowed') {
        throw "Windows denied Bluetooth radio access: $access"
      }

      $radios = Wait-WinRtOperation ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
      $radio = $radios | Where-Object { $_.Kind.ToString() -eq 'Bluetooth' } |
        Select-Object -First 1
      if (-not $radio) {
        throw 'Windows Bluetooth radio was not found.'
      }

      $requestedState = if (${enabled ? "$true" : "$false"}) {
        [Windows.Devices.Radios.RadioState]::On
      } else {
        [Windows.Devices.Radios.RadioState]::Off
      }
      $result = Wait-WinRtOperation ($radio.SetStateAsync($requestedState)) ([Windows.Devices.Radios.RadioAccessStatus])
      if ($result.ToString() -ne 'Allowed') {
        throw "Windows did not allow changing Bluetooth: $result"
      }
    `;

    await runPowerShell(script, 60000);
    return { success: true, enabled };
  }

  return { getConnections, getWifiInfo, getBluetoothInfo, setWifi, setBluetooth };
}

module.exports = { createConnectionService, radioWinRtPowerShell };
