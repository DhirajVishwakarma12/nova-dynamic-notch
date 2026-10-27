
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const allowedSettings = new Set([
  "wifi",
  "bluetooth",
  "sound",
  "network"
]);

contextBridge.exposeInMainWorld("desktopAPI", {
  isCursorOverNotch() {
    return ipcRenderer.invoke("ui:is-cursor-over-notch");
  },

  openSystemSettings(page) {
    if (!allowedSettings.has(page)) {
      return Promise.reject(new Error("Unsupported settings page."));
    }

    return ipcRenderer.invoke("settings:open", page);
  },

  getConnections() {
    return ipcRenderer.invoke("connections:get");
  },

  setWifi(enabled) {
    if (typeof enabled !== "boolean") {
      return Promise.reject(new Error("Invalid Wi-Fi state."));
    }

    return ipcRenderer.invoke("connections:wifi:set", enabled);
  },

  setBluetooth(enabled) {
    if (typeof enabled !== "boolean") {
      return Promise.reject(new Error("Invalid Bluetooth state."));
    }

    return ipcRenderer.invoke("connections:bluetooth:set", enabled);
  },

  getSystemAudio() {
    return ipcRenderer.invoke("audio:get");
  },

  setSystemVolume(value) {
    const volume = Number(value);

    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      return Promise.reject(new Error("Invalid volume."));
    }

    return ipcRenderer.invoke("audio:volume:set", volume);
  },

  toggleSystemMute() {
    return ipcRenderer.invoke("audio:mute:toggle");
  },

  getDisplayBrightness() {
    return ipcRenderer.invoke("display:brightness:get");
  },

  setDisplayBrightness(value) {
    const brightness = Number(value);

    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
      return Promise.reject(new Error("Invalid brightness."));
    }

    return ipcRenderer.invoke("display:brightness:set", brightness);
  },

  getPerformance() {
    return ipcRenderer.invoke("performance:get");
  }
});
