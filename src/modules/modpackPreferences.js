const { ipcMain, app } = require("electron");
const fs = require("fs");
const path = require("path");
const { NodeBDD, DataType } = require("node-bdd");

class ModpackPreferences {
  constructor() {
    this.db = new NodeBDD();
    this.tablePromise = null;
    ipcMain.handle("modpacks:preferences:get", async () => {
      return this.getPreferences();
    });
    ipcMain.handle("modpacks:preferences:set", async (event, payload) => {
      return this.savePreferences(payload);
    });
  }

  async getTable() {
    if (!this.tablePromise) {
      const dir = path.join(app.getPath("userData"), "databases");
      fs.mkdirSync(dir, { recursive: true });
      this.tablePromise = this.db.intilize({
        databaseName: "Databases",
        fileType: app.isPackaged ? "db" : "sqlite",
        tableName: "modpackPreferences",
        path: dir,
        tableColumns: {
          json_data: DataType.TEXT.TEXT
        }
      });
    }
    return this.tablePromise;
  }

  defaultPreferences() {
    return {
      instance: null,
      downloadMulti: 5,
      intelEnabledMac: true,
      closeLauncher: "hide",
      javaPath: null
    };
  }

  async getPreferences() {
    const table = await this.getTable();
    const record = await this.db.getDataById(table, 1);
    if (!record) {
      const defaults = this.defaultPreferences();
      await this.savePreferences(defaults);
      return defaults;
    }
    try {
      const stored = JSON.parse(record.json_data);
      return { ...this.defaultPreferences(), ...stored };
    } catch {
      const defaults = this.defaultPreferences();
      await this.savePreferences(defaults);
      return defaults;
    }
  }

  async savePreferences(prefs = {}) {
    const table = await this.getTable();
    const merged = { ...this.defaultPreferences(), ...prefs };
    const existing = await this.db.getDataById(table, 1);
    if (existing) {
      await this.db.updateData(table, { json_data: JSON.stringify(merged) }, 1);
    } else {
      await this.db.createData(table, { json_data: JSON.stringify(merged) });
    }
    return merged;
  }
}

module.exports = () => new ModpackPreferences();
