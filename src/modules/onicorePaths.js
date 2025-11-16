const path = require("path");
const { app } = require("electron");

function getBaseDir() {
  if (process.platform === "win32") {
    return path.join(app.getPath("appData"), ".Onicore");
  }
  if (process.platform === "darwin") {
    return path.join(app.getPath("home"), "Library", "Application Support", "Onicore");
  }
  if (process.platform === "linux") {
    return path.join(app.getPath("home"), ".Onicore");
  }
  throw new Error("Unsupported platform");
}

module.exports = {
  getOnicoreDir: getBaseDir,
  getVersionsDir: () => path.join(getBaseDir(), "versions")
};
