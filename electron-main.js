  "use strict";

  const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    screen,
    shell
  } = require("electron");

  const path = require("node:path");
  const os = require("node:os");
  const fs = require("node:fs/promises");
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");

  const execFileAsync = promisify(execFile);

  let mainWindow;

  function runPowerShell(script, timeout = 12000) {
    return execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024
      }
    ).then(({ stdout }) => stdout.trim());
  }

  function powershellLiteral(value) {
    return "'" + value.replace(/'/g, "''") + "'";
  }

  function quoteWindowsArgument(value) {
    let quoted = '"';
    let backslashes = 0;

    for (const character of String(value)) {
      if (character === "\\") {
        backslashes += 1;
      } else if (character === '"') {
        quoted += "\\".repeat(backslashes * 2 + 1) + '"';
        backslashes = 0;
      } else {
        quoted += "\\".repeat(backslashes) + character;
        backslashes = 0;
      }
    }

    return quoted + "\\".repeat(backslashes * 2) + '"';
  }

  async function runPowerShellElevated(script, timeout = 60000) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-radio-"));
    const resultPath = path.join(tempDir, "result.txt");
    const resultLiteral = powershellLiteral(resultPath);
    const elevatedScript = `
      $ErrorActionPreference = 'Stop'
      try {
        [void](& {
  ${script}
        })
        [System.IO.File]::WriteAllText(${resultLiteral}, 'OK')
        exit 0
      } catch {
        [System.IO.File]::WriteAllText(${resultLiteral}, [string]$_.Exception.Message)
        exit 1
      }
    `;
    const launcher = `
      $script = @'
  ${elevatedScript}
'@

      $encodedCommand = [Convert]::ToBase64String(
        [System.Text.Encoding]::Unicode.GetBytes($script)
      )

      $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"

      if ($process.ExitCode -ne 0) {
        $errorText = Get-Content -LiteralPath ${resultLiteral} -Raw -ErrorAction SilentlyContinue
        throw "Elevated command failed: $errorText"
      }

      Get-Content -LiteralPath ${resultLiteral} -Raw -ErrorAction SilentlyContinue
    `;

    try {
      const result = await runPowerShell(launcher, timeout);
      if (result !== "OK") {
        throw new Error(result || "Elevated command returned no result.");
      }

      return result;
    } catch (error) {
      if (/canceled by the user|operation was canceled|1223/i.test(error.message)) {
        throw new Error("Administrator approval was canceled; no system setting was changed.");
      }

      throwConnectionError("change the system radio state", error);
    } finally {
      await fs.unlink(resultPath).catch(() => {});
      await fs.rmdir(tempDir).catch(() => {});
    }
  }

  function parseJson(output) {
    const text = output.trim();
    if (!text) throw new Error("Windows returned no data.");
    return JSON.parse(text);
  }

  const {
    getConnections,
    setWifi,
    setBluetooth
  } = require("./connections.cjs").createConnectionService({
    runPowerShell,
    runPowerShellElevated,
    parseJson
  });

  function throwConnectionError(action, error) {
    const details = `${error.stderr || ""} ${error.message || ""}`;
    if (/access is denied|permissiondenied|system error 5/i.test(details)) {
      throw new Error(
        `Windows denied permission to ${action}. Run Nova as administrator, or use Connection Settings.`
      );
    }

    throw error;
  }

  function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth } = primaryDisplay.workAreaSize;
    const windowWidth = 364;

    mainWindow = new BrowserWindow({
      width: windowWidth,
      height: 274,
      minWidth: 300,
      minHeight: 250,
      x: Math.max(0, Math.round((screenWidth - windowWidth) / 2)),
      y: 0,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.setPosition(Math.max(0, Math.round((screenWidth - windowWidth) / 2)), 0);
    mainWindow.loadFile(path.join(__dirname, "index.html"));
  }

  async function createStartupShortcut() {
    if (process.platform !== "win32") return;

    const startupFolder = path.join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup"
    );
    const shortcutPath = path.join(startupFolder, "Nova Dynamic Notch.lnk");
    const appArguments = app.isPackaged
      ? ""
      : quoteWindowsArgument(app.getAppPath());
    const script = `
      $startupFolder = ${powershellLiteral(startupFolder)}
      New-Item -ItemType Directory -Path $startupFolder -Force | Out-Null
      $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut(${powershellLiteral(shortcutPath)})
      $shortcut.TargetPath = ${powershellLiteral(process.execPath)}
      $shortcut.Arguments = ${powershellLiteral(appArguments)}
      $shortcut.WorkingDirectory = ${powershellLiteral(app.getAppPath())}
      $shortcut.IconLocation = ${powershellLiteral(process.execPath)}
      $shortcut.Save()
    `;

    await runPowerShell(script);
  }

  ipcMain.handle("ui:is-cursor-over-notch", event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return false;

    const { x, y, width } = window.getBounds();
    const notchWidth = Math.min(340, width - 24);
    const notchLeft = x + (width - notchWidth) / 2;
    const notchTop = y + 3;
    const cursor = screen.getCursorScreenPoint();

    return cursor.x >= notchLeft &&
      cursor.x <= notchLeft + notchWidth &&
      cursor.y >= notchTop &&
      cursor.y <= notchTop + 250;
  });

  const settingsUris = {
    wifi: "ms-settings:network-wifi",
    bluetooth: "ms-settings:bluetooth",
    sound: "ms-settings:sound",
    network: "ms-settings:network"
  };

  /* Windows system settings */
  ipcMain.handle("settings:open", async (_event, page) => {
    const uri = settingsUris[page];

    if (!uri) {
      throw new Error("Unsupported settings page.");
    }

    await shell.openExternal(uri);
    return { success: true };
  });

  ipcMain.handle("connections:get", () => getConnections());
  ipcMain.handle("connections:wifi:set", (_event, enabled) => setWifi(enabled));
  ipcMain.handle("connections:bluetooth:set", (_event, enabled) => setBluetooth(enabled));

  /*
  * Windows Core Audio interop.
  * Get/set default output endpoint volume and mute.
  */
  const audioInterop = String.raw`
  $ErrorActionPreference = 'Stop'

  $source = @'
  using System;
  using System.Runtime.InteropServices;

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject {}

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
      [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  }

  [ComImport]
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, ref Guid context);
    int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
    int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    int GetChannelVolumeLevel(uint channel, out float level);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public static class NovaAudio {
    static IAudioEndpointVolume GetEndpoint() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(
        enumerator.GetDefaultAudioEndpoint(0, 1, out device));
      Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
      object instance;
      Marshal.ThrowExceptionForHR(
        device.Activate(ref iid, 23, IntPtr.Zero, out instance));
      return (IAudioEndpointVolume)instance;
    }

    public static int GetVolume() {
      float value;
      Marshal.ThrowExceptionForHR(GetEndpoint().GetMasterVolumeLevelScalar(out value));
      return (int)Math.Round(value * 100);
    }

    public static bool GetMute() {
      bool muted;
      Marshal.ThrowExceptionForHR(GetEndpoint().GetMute(out muted));
      return muted;
    }

    public static void SetVolume(int value) {
      if (value < 0 || value > 100) throw new ArgumentOutOfRangeException("value");
      Guid context = Guid.Empty;
      Marshal.ThrowExceptionForHR(
        GetEndpoint().SetMasterVolumeLevelScalar(value / 100f, ref context));
    }

    public static void SetMute(bool muted) {
      Guid context = Guid.Empty;
      Marshal.ThrowExceptionForHR(GetEndpoint().SetMute(muted, ref context));
    }
  }
'@

  Add-Type -TypeDefinition $source -Language CSharp

  switch ($env:NOVA_AUDIO_ACTION) {
    'get' {
      [pscustomobject]@{
        volume = [NovaAudio]::GetVolume()
        muted = [NovaAudio]::GetMute()
      } | ConvertTo-Json -Compress
    }
    'set' {
      [NovaAudio]::SetVolume([int]$env:NOVA_AUDIO_VALUE)
      'OK'
    }
    'mute' {
      [NovaAudio]::SetMute([bool]::Parse($env:NOVA_AUDIO_VALUE))
      'OK'
    }
    'toggle-mute' {
      $muted = -not [NovaAudio]::GetMute()
      [NovaAudio]::SetMute($muted)
      [pscustomobject]@{ muted = $muted } | ConvertTo-Json -Compress
    }
  }
  `;

  async function runAudioAction(action, value) {
    const script = audioInterop + "\n";
    const env = {
      ...process.env,
      NOVA_AUDIO_ACTION: action,
      NOVA_AUDIO_VALUE: String(value ?? "")
    };

    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env
      }
    );

    return stdout.trim();
  }

  ipcMain.handle("audio:get", async () => {
    return parseJson(await runAudioAction("get"));
  });

  ipcMain.handle("audio:volume:set", async (_event, value) => {
    const volume = Number(value);

    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw new Error("Volume must be between 0 and 100.");
    }

    await runAudioAction("set", volume);
    return { success: true };
  });

  ipcMain.handle("audio:mute:toggle", async () => {
    return {
      success: true,
      ...parseJson(await runAudioAction("toggle-mute"))
    };
  });

  async function getDisplayBrightness() {
    const script = `
      $monitor = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop |
        Select-Object -First 1

      if (-not $monitor) {
        throw 'Display brightness is not supported on this system.'
      }

      [pscustomobject]@{
        brightness = [int]$monitor.CurrentBrightness
      } | ConvertTo-Json -Compress
    `;

    return parseJson(await runPowerShell(script));
  }

  ipcMain.handle("display:brightness:get", async () => {
    return getDisplayBrightness();
  });

  ipcMain.handle("display:brightness:set", async (_event, value) => {
    const brightness = Number(value);

    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
      throw new Error("Brightness must be between 0 and 100.");
    }

    const script = `
      $ErrorActionPreference = 'Stop'
      $methods = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
      if (-not $methods) {
        throw 'Display brightness controls are unavailable on this system.'
      }

      foreach ($method in $methods) {
        $null = Invoke-CimMethod -InputObject $method -MethodName WmiSetBrightness -ErrorAction Stop -Arguments @{
          Timeout = 0
          Brightness = ${brightness}
        }
      }

      'OK'
    `;

    const result = await runPowerShell(script);
    if (result !== "OK") {
      throw new Error("Windows refused the brightness change.");
    }

    return { success: true };
  });

  /* CPU and RAM metrics */
  let previousCpu = null;
  let cachedGpu = null;
  let lastGpuSampleAt = 0;
  let gpuSamplePromise = null;

  function refreshGpuSample() {
    if (gpuSamplePromise) return gpuSamplePromise;

    gpuSamplePromise = runPowerShell(`
      $counters = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop
      $values = @($counters.CounterSamples |
        Where-Object { $_.InstanceName -match 'engtype_3D' } |
        ForEach-Object { $_.CookedValue })

      if ($values.Count -gt 0) {
        [math]::Round([math]::Min(100, ($values | Measure-Object -Sum).Sum))
      } else {
        'NA'
      }
    `, 10000)
      .then(result => {
        const value = Number(result);
        cachedGpu = Number.isFinite(value) && result !== "" ? value : null;
      })
      .catch(() => {
        cachedGpu = null;
      })
      .finally(() => {
        gpuSamplePromise = null;
      });

    return gpuSamplePromise;
  }

  function readCpuUsage() {
    const cpus = os.cpus();

    const total = cpus.reduce((sum, cpu) => {
      return sum + Object.values(cpu.times).reduce((a, b) => a + b, 0);
    }, 0);

    const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);

    if (!previousCpu) {
      previousCpu = { total, idle };
      return null;
    }

    const totalDelta = total - previousCpu.total;
    const idleDelta = idle - previousCpu.idle;
    previousCpu = { total, idle };

    if (totalDelta <= 0) return null;

    return Math.round(
      Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
    );
  }

  ipcMain.handle("performance:get", async () => {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();

    const now = Date.now();
    if (now - lastGpuSampleAt >= 60000) {
      lastGpuSampleAt = now;
      void refreshGpuSample();
    }

    return {
      cpu: readCpuUsage(),
      ram: Math.round(((totalMemory - freeMemory) / totalMemory) * 100),
      gpu: cachedGpu
    };
  });

app.whenReady().then(() => {
  createStartupShortcut().catch(error => {
    console.error("Could not create the Nova startup shortcut:", error);
    dialog.showErrorBox(
      "Nova startup shortcut",
      `Could not create the Windows Startup shortcut. ${error.message}`
    );
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
