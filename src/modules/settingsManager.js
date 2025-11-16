const { ipcMain } = require("electron");

const berry = require("./logger")();
const { DEFAULT_SETTINGS, readSettings, writeSettings, mergeSettings } = require("./settingsStore");

module.exports = () => {
  function sanitizeMemory(payload) {
    const min = Math.max(512, Number(payload?.min) || DEFAULT_SETTINGS.memory.min);
    let max = Math.max(min + 256, Number(payload?.max) || DEFAULT_SETTINGS.memory.max);
    if (max > 32768) max = 32768;
    return { min, max };
  }

  function sanitizeNetwork(payload) {
    let maxMbps = Number(payload?.maxMbps) || 0;
    if (maxMbps < 0) maxMbps = 0;
    if (maxMbps > 1000) maxMbps = 1000;
    return { maxMbps };
  }

  ipcMain.handle("settings:get", () => {
    return readSettings();
  });

  ipcMain.handle("settings:update", (event, payload) => {
    try {
      const current = readSettings();
      const next = mergeSettings({
        memory: sanitizeMemory(payload?.memory || current.memory),
        network: sanitizeNetwork(payload?.network || current.network)
      });
      writeSettings(next);
      return next;
    } catch (error) {
      berry.error("Failed to update settings: " + error?.stack, "settingsManager");
      return readSettings();
    }
  });
};
