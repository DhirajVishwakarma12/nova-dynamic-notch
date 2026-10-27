"use strict";

const $ = id => document.getElementById(id);
const api = window.desktopAPI;

const notch = $("notch");
const topbar = $("topbar");

let pinned = false;
let audioURL = null;
let volumeDebounce = null;
let brightnessDebounce = null;
let refreshingVolume = false;
let performancePoll = null;
let controlsPoll = null;
let hoverCheckId = 0;

const audio = $("audio");
const picker = $("filePicker");
const playButton = $("play");
const controlStatus = $("controlStatus");

const fmt = seconds =>
  Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "0:00";

/* Clock */
function updateClock() {
  $("clock").textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

updateClock();
setInterval(updateClock, 60000);

function stopPagePolling() {
  clearInterval(performancePoll);
  clearInterval(controlsPoll);
  performancePoll = null;
  controlsPoll = null;
}

function refreshActivePage() {
  if (
    document.visibilityState !== "visible" ||
    !notch.classList.contains("expanded")
  ) {
    stopPagePolling();
    return;
  }

  if ($("performance").classList.contains("active")) {
    clearInterval(controlsPoll);
    controlsPoll = null;
    updatePerformance();
    if (!performancePoll) {
      performancePoll = setInterval(updatePerformance, 15000);
    }
    return;
  }

  clearInterval(performancePoll);
  performancePoll = null;

  if ($("controls").classList.contains("active")) {
    refreshConnections();
    refreshSystemVolume();
    refreshDisplayBrightness();
    if (!controlsPoll) {
      controlsPoll = setInterval(() => {
        refreshConnections();
        refreshSystemVolume();
        refreshDisplayBrightness();
      }, 30000);
    }
    return;
  }

  clearInterval(controlsPoll);
  controlsPoll = null;
}

async function collapseIfPointerLeft() {
  const checkId = ++hoverCheckId;
  if (
    pinned ||
    !notch.classList.contains("expanded") ||
    !api?.isCursorOverNotch
  ) return;

  try {
    if (await api?.isCursorOverNotch()) return;
  } catch (error) {
    showControlError("Could not check pointer position.", error);
    return;
  }

  if (checkId === hoverCheckId && !pinned) {
    notch.classList.remove("expanded");
    stopPagePolling();
  }
}

/* Notch behaviour */
notch.addEventListener("mouseenter", () => {
  hoverCheckId += 1;
  notch.classList.add("expanded");
  refreshActivePage();
});

notch.addEventListener("mouseleave", () => {
  if (!pinned) {
    notch.classList.remove("expanded");
    stopPagePolling();
  }
});

window.addEventListener("focus", collapseIfPointerLeft);

topbar.addEventListener("click", () => {
  hoverCheckId += 1;
  const wasExpanded = notch.classList.contains("expanded");
  pinned = !pinned;
  notch.classList.toggle("expanded", pinned);
  if (!pinned) stopPagePolling();
  else if (!wasExpanded) refreshActivePage();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    hoverCheckId += 1;
    pinned = false;
    notch.classList.remove("expanded");
    stopPagePolling();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshActivePage();
  else stopPagePolling();
});

window.addEventListener("beforeunload", () => {
  if (audioURL) URL.revokeObjectURL(audioURL);
  clearTimeout(volumeDebounce);
  clearTimeout(brightnessDebounce);
  stopPagePolling();
});

/* Tabs */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(item => {
      item.classList.toggle("active", item === tab);
    });

    document.querySelectorAll(".page").forEach(page => {
      page.classList.toggle("active", page.id === tab.dataset.page);
    });

    refreshActivePage();
  });
});

/* Local music player: no online fallback */
$("chooseMusic").addEventListener("click", () => picker.click());
$("next").addEventListener("click", () => picker.click());

$("previous").addEventListener("click", () => {
  if (!audio.src) {
    $("musicStatus").textContent = "Choose an audio file first.";
    return;
  }

  audio.currentTime = 0;
  if (audio.paused) {
    audio.play().catch(() => {});
  }
});

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (!file) return;

  if (audioURL) URL.revokeObjectURL(audioURL);

  audioURL = URL.createObjectURL(file);
  audio.src = audioURL;
  audio.load();

  $("trackName").textContent = file.name.replace(/\.[^.]+$/, "");
  $("artistName").textContent = "Local audio file";
  $("musicStatus").textContent = "Loading audio…";
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  $("progress").value = 0;

  audio.play().catch(() => {
    $("musicStatus").textContent = "Ready — press Play";
  });

  picker.value = "";
});

playButton.addEventListener("click", async () => {
  if (!audio.src) {
    $("musicStatus").textContent = "Choose a local audio file first.";
    picker.click();
    return;
  }

  if (audio.paused) {
    try {
      await audio.play();
    } catch {
      $("musicStatus").textContent = "Playback failed. Try another file.";
    }
  } else {
    audio.pause();
  }
});

audio.addEventListener("play", () => {
  playButton.textContent = "Ⅱ";
  playButton.title = "Pause";
  $("musicStatus").textContent = "Playing";
});

audio.addEventListener("pause", () => {
  playButton.textContent = "▶";
  playButton.title = "Play";

  if (audio.src && !audio.ended) {
    $("musicStatus").textContent = "Paused";
  }
});

audio.addEventListener("ended", () => {
  playButton.textContent = "▶";
  $("musicStatus").textContent = "Finished";
});

audio.addEventListener("error", () => {
  if (audio.src) $("musicStatus").textContent = "Unable to play this file.";
});

audio.addEventListener("loadedmetadata", () => {
  $("duration").textContent = fmt(audio.duration);
});

audio.addEventListener("timeupdate", () => {
  $("currentTime").textContent = fmt(audio.currentTime);

  $("progress").value = audio.duration
    ? (audio.currentTime / audio.duration) * 100
    : 0;
});

$("progress").addEventListener("input", event => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = Number(event.target.value) / 100 * audio.duration;
  }
});

/* Music volume: affects only local audio playback */
const musicVolume = $("musicVolume");

function setMusicVolume() {
  const value = Number(musicVolume.value);
  audio.volume = Math.max(0, Math.min(1, value / 100));

  $("musicVolumeText").textContent = `${value}%`;
  $("volumeIcon").textContent =
    value === 0 ? "🔇" : value < 45 ? "🔉" : "🔊";
}

musicVolume.addEventListener("input", setMusicVolume);
setMusicVolume();

/* System volume: affects Windows master volume */
function showControlError(message, error) {
  controlStatus.textContent =
    `${message}${error?.message ? ` ${error.message}` : ""}`;
}

async function refreshSystemVolume() {
  if (!api?.getSystemAudio) return;

  try {
    const data = await api.getSystemAudio();
    if (!data || !Number.isFinite(data.volume)) {
      throw new Error("Windows did not return a valid volume.");
    }

    refreshingVolume = true;

    $("systemVolume").value = data.volume;
    $("systemVolumeText").textContent = `${data.volume}%`;
    $("systemVolumeIcon").textContent =
      data.muted || data.volume === 0
        ? "🔇"
        : data.volume < 45 ? "🔉" : "🔊";

    $("systemMuteState").textContent = data.muted ? "Muted" : "Not muted";
    $("systemMute").classList.toggle("on", Boolean(data.muted));

    refreshingVolume = false;
  } catch (error) {
    refreshingVolume = false;
    $("systemVolumeText").textContent = "Unavailable";
    $("systemMuteState").textContent = "Unavailable";
  }
}

$("systemVolume").addEventListener("input", () => {
  const value = Number($("systemVolume").value);

  $("systemVolumeText").textContent = `${value}%`;
  $("systemVolumeIcon").textContent =
    value === 0 ? "🔇" : value < 45 ? "🔉" : "🔊";

  if (refreshingVolume || !api?.setSystemVolume) return;

  clearTimeout(volumeDebounce);

  volumeDebounce = setTimeout(async () => {
    try {
      await api.setSystemVolume(value);
      controlStatus.textContent = `Windows volume set to ${value}%.`;
    } catch (error) {
      showControlError("Could not change Windows volume.", error);
    }
  }, 100);
});

$("systemMute").addEventListener("click", async () => {
  const wasMuted = $("systemMute").classList.contains("on");
  const muted = !wasMuted;
  $("systemMuteState").textContent = muted ? "Muting…" : "Unmuting…";
  $("systemMute").classList.toggle("on", muted);
  setButtonBusy($("systemMute"), true);

  try {
    if (!api?.toggleSystemMute) {
      throw new Error("Electron system audio API is unavailable.");
    }

    const result = await api.toggleSystemMute();
    $("systemMuteState").textContent = result.muted ? "Muted" : "Not muted";
    $("systemMute").classList.toggle("on", result.muted);
    controlStatus.textContent = result.muted ? "System muted." : "System unmuted.";
  } catch (error) {
    $("systemMuteState").textContent = wasMuted ? "Muted" : "Not muted";
    $("systemMute").classList.toggle("on", wasMuted);
    showControlError("Could not change Windows mute state.", error);
  } finally {
    setButtonBusy($("systemMute"), false);
  }
});

async function refreshDisplayBrightness() {
  if (!api?.getDisplayBrightness) return;

  try {
    const data = await api.getDisplayBrightness();
    if (!data || !Number.isFinite(data.brightness)) {
      throw new Error("Windows did not return a valid brightness level.");
    }

    const value = Math.max(0, Math.min(100, Number(data.brightness)));
    $("displayBrightness").value = value;
    $("displayBrightnessText").textContent = `${value}%`;
    $("brightnessIcon").textContent = value === 0 ? "☾" : "☀";
  } catch (error) {
    $("displayBrightnessText").textContent = "Unavailable";
    $("brightnessIcon").textContent = "☀";
    showControlError("Could not read display brightness.", error);
  }
}

$("displayBrightness").addEventListener("input", () => {
  const value = Number($("displayBrightness").value);
  $("displayBrightnessText").textContent = `${value}%`;
  $("brightnessIcon").textContent = value === 0 ? "☾" : "☀";

  if (!api?.setDisplayBrightness) return;

  clearTimeout(brightnessDebounce);
  brightnessDebounce = setTimeout(async () => {
    try {
      await api.setDisplayBrightness(value);
    } catch (error) {
      showControlError("Could not change display brightness.", error);
    }
  }, 100);
});

/* Wi-Fi and Bluetooth */
const wifiButton = $("wifi");
const bluetoothButton = $("bluetooth");

function setButtonBusy(button, busy) {
  button.disabled = busy;
}

function showRadioState(button, stateElement, enabled) {
  button.classList.toggle("on", enabled);
  stateElement.textContent = enabled ? "On" : "Off";
}

async function refreshConnections() {
  if (!api?.getConnections) {
    controlStatus.textContent = "Run this application through Electron on Windows.";
    return;
  }

  try {
    const data = await api.getConnections();
    const wifi = data.wifi || {};
    const bluetooth = data.bluetooth || {};

    wifiButton.classList.toggle("on", Boolean(wifi.enabled));

    $("wifiState").textContent = !wifi.enabled
      ? "Off"
      : wifi.connected
        ? "Connected"
        : "On · Not connected";

    $("wifiName").textContent = wifi.connected
      ? (wifi.name || "Connected network")
      : "Not connected";

    bluetoothButton.classList.toggle("on", Boolean(bluetooth.enabled));

    $("bluetoothState").textContent = !bluetooth.available
      ? "Unavailable"
      : bluetooth.enabled
        ? "On"
        : "Off";

    $("bluetoothName").textContent =
      bluetooth.radioName
        ? `Radio: ${bluetooth.radioName}`
        : "No Bluetooth radio detected";

  } catch (error) {
    showControlError("Could not read connection status.", error);
  }
}

wifiButton.addEventListener("click", async () => {
  const enabled = !wifiButton.classList.contains("on");
  showRadioState(wifiButton, $("wifiState"), enabled);
  setButtonBusy(wifiButton, true);
  controlStatus.textContent = `Turning Wi-Fi ${enabled ? "on" : "off"}…`;

  try {
    const result = await api.setWifi(enabled);
    controlStatus.textContent = `Wi-Fi turned ${result.enabled ? "on" : "off"}.`;
    $("wifiState").textContent = result.enabled ? "On · Refreshing…" : "Off";
    if (!result.enabled) $("wifiName").textContent = "Not connected";
    void refreshConnections();
  } catch (error) {
    showControlError("Wi-Fi change failed.", error);
    void refreshConnections();
  } finally {
    setButtonBusy(wifiButton, false);
    await collapseIfPointerLeft();
  }
});

bluetoothButton.addEventListener("click", async () => {
  const enabled = !bluetoothButton.classList.contains("on");
  showRadioState(bluetoothButton, $("bluetoothState"), enabled);
  setButtonBusy(bluetoothButton, true);
  controlStatus.textContent = `Turning Bluetooth ${enabled ? "on" : "off"}…`;

  try {
    const result = await api.setBluetooth(enabled);
    controlStatus.textContent = `Bluetooth turned ${result.enabled ? "on" : "off"}.`;
    $("bluetoothState").textContent = result.enabled ? "On" : "Off";
    if (!result.enabled) $("bluetoothName").textContent = "No connected device";
    void refreshConnections();
  } catch (error) {
    showControlError("Bluetooth change failed.", error);
    void refreshConnections();
  } finally {
    setButtonBusy(bluetoothButton, false);
    await collapseIfPointerLeft();
  }
});

$("openWifiSettings").addEventListener("click", async () => {
  try {
    await api.openSystemSettings("wifi");
  } catch (error) {
    showControlError("Could not open connection settings.", error);
  }
});

/* Battery */
async function loadBattery() {
  try {
    if (!navigator.getBattery) throw new Error("Unsupported");

    const battery = await navigator.getBattery();

    function render() {
      $("batteryText").textContent =
        `${Math.round(battery.level * 100)}%`;

      $("powerText").textContent = battery.charging
        ? "Charging"
        : "On battery";
    }

    render();
    battery.addEventListener("levelchange", render);
    battery.addEventListener("chargingchange", render);
  } catch {
    $("batteryText").textContent = "Unavailable";
    $("powerText").textContent = "Unavailable";
  }
}

/* Performance */
async function updatePerformance() {
  if (!api?.getPerformance) {
    $("performanceStatus").textContent =
      "Performance metrics require the Electron backend.";
    return;
  }

  try {
    const data = await api.getPerformance();

    for (const key of ["cpu", "ram", "gpu"]) {
      const raw = data?.[key];
      const value = raw == null ? NaN : Number(raw);
      const text = $(`${key}Text`);
      const bar = $(`${key}Bar`);

      if (!Number.isFinite(value)) {
        text.textContent = "Unavailable";
        bar.style.width = "0%";
        continue;
      }

      const safe = Math.max(0, Math.min(100, value));
      text.textContent = `${Math.round(safe)}%`;
      bar.style.width = `${safe}%`;
    }

    $("performanceStatus").textContent =
      "CPU and memory readings updated.";
  } catch {
    $("performanceStatus").textContent =
      "Could not read performance information.";
  }
}

/* Initial setup */
loadBattery();

window.addEventListener("beforeunload", () => {
  if (audioURL) URL.revokeObjectURL(audioURL);
  clearTimeout(volumeDebounce);
  clearTimeout(brightnessDebounce);
  stopPagePolling();
});
