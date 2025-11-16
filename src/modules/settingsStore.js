const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULT_SETTINGS = {
  memory: {
    min: 2048,
    max: 4096
  },
  network: {
    maxMbps: 0
  }
};

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function ensureSettingsFile() {
  const file = getSettingsPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
  return file;
}

function mergeSettings(input = {}) {
  const memory = input.memory || {};
  const network = input.network || {};
  return {
    memory: {
      min: Number(memory.min) || DEFAULT_SETTINGS.memory.min,
      max: Number(memory.max) || DEFAULT_SETTINGS.memory.max
    },
    network: {
      maxMbps: Number(network.maxMbps) || DEFAULT_SETTINGS.network.maxMbps
    }
  };
}

function readSettings() {
  const file = ensureSettingsFile();
  try {
    const content = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(content);
    return mergeSettings(parsed);
  } catch {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  const file = ensureSettingsFile();
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettingsPath,
  readSettings,
  writeSettings,
  mergeSettings
};
