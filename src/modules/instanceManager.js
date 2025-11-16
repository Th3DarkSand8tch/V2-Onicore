const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const axios = require("axios");
const extract = require("extract-zip");
const crypto = require("crypto");
const os = require("os");
const { app, ipcMain } = require("electron");

const berry = require("./logger")();
const LoaderInstaller = require("./loaderInstaller");
const { getOnicoreDir } = require("./onicorePaths");
const { pipeWithThrottle } = require("./bandwidthLimiter");

const DEFAULT_CONFIG = {
  enabled: false,
  baseUrl: "",
  instancesEndpoint: "/instances",
  headers: {},
  autoSyncMinutes: 15,
  downloadTimeout: 30 * 60 * 1000,
  install: {
    targetFolder: "flexberry-instances",
    versionFolders: ["versions"]
  },
  defaults: {
    memory: {
      min: 2048,
      max: 4096
    }
  }
};

const CONFIG_NAME = "instance-server.json";

module.exports = (win) => {
  class InstanceManager {
    constructor(window) {
      this.win = window;
      this.config = this.loadConfig();
      this.enabled = !!this.config.enabled && !!this.config.baseUrl;
      this.instances = [];
      this.syncing = false;
      this.minecraftDir = this.getMinecraftDir();
      this.instancesDir = path.join(this.minecraftDir, this.config.install?.targetFolder || "flexberry-instances");
      this.statePath = path.join(app.getPath("userData"), "remote-instances.json");
      this.state = this.loadState();
      this.syncInterval = null;
      this.init();
    }

    loadConfig() {
      const packagedConfigPath = path.join(__dirname, "..", "config", CONFIG_NAME);
      const userConfigPath = path.join(app.getPath("userData"), CONFIG_NAME);
      let config = { ...DEFAULT_CONFIG };
      const applyConfig = (configPath) => {
        try {
          if (fs.existsSync(configPath)) {
            const file = JSON.parse(fs.readFileSync(configPath, "utf8"));
            config = {
              ...config,
              ...file,
              install: { ...config.install, ...file.install },
              defaults: { ...config.defaults, ...file.defaults }
            };
          }
        } catch (error) {
          berry.error(`Could not read instance server config at ${configPath}. Stack:\n${error.stack}`, "instanceManager");
        }
      };
      applyConfig(packagedConfigPath);
      applyConfig(userConfigPath);
      return config;
    }

    loadState() {
      try {
        if (fs.existsSync(this.statePath)) {
          return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        }
      } catch (error) {
        berry.error("Could not load remote instance state file. Stack:\n" + error.stack, "instanceManager");
      }
      return { installed: {} };
    }

    saveState() {
      try {
        fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
      } catch (error) {
        berry.error("Could not persist remote instance state. Stack:\n" + error.stack, "instanceManager");
      }
    }

    getMinecraftDir() {
      return getOnicoreDir();
    }

    async init() {
      await this.ensureDirs();
      this.bindIPC();
      if (!this.enabled) {
        berry.log("Remote instance sync is disabled. Update src/config/instance-server.json or place an override inside userData to enable it.", "instanceManager");
        return;
      }
      await this.syncRemoteInstances();
      this.scheduleSync();
    }

    async ensureDirs() {
      await fsp.mkdir(this.instancesDir, { recursive: true });
      await fsp.mkdir(path.join(this.minecraftDir, "versions"), { recursive: true });
    }

    scheduleSync() {
      const minutes = +this.config.autoSyncMinutes;
      if (!minutes || minutes <= 0) {
        return;
      }
      this.syncInterval = setInterval(() => {
        this.syncRemoteInstances().catch((error) => {
          berry.error("Automatic instance sync failed: " + error?.message, "instanceManager");
        });
      }, minutes * 60 * 1000);
    }

    bindIPC() {
      ipcMain.handle("instances:list", async () => {
        if (!this.enabled) {
          return { status: "disabled" };
        }
        return this.instancesWithStatus();
      });

      ipcMain.handle("instances:sync", async () => {
        if (!this.enabled) {
          return { status: "disabled" };
        }
        await this.syncRemoteInstances(true);
        return this.instancesWithStatus();
      });

      ipcMain.handle("instances:install", async (event, payload) => {
        const { instanceId } = payload || {};
        if (!instanceId) {
          throw new Error("Missing instanceId");
        }
        await this.ensureInstalled(instanceId);
        return { status: "ok" };
      });

      ipcMain.handle("instances:prepareLaunch", async (event, payload) => {
        const { instanceId } = payload || {};
        if (!instanceId) {
          throw new Error("Missing instanceId");
        }
        const launchPayload = await this.prepareLaunch(instanceId);
        return launchPayload;
      });
    }

    async syncRemoteInstances(force = false) {
      if (!this.enabled) {
        return [];
      }
      if (this.syncing && !force) {
        return this.instancesWithStatus();
      }
      this.syncing = true;
      try {
        const endpoint = new URL(this.config.instancesEndpoint || "/instances", this.config.baseUrl).toString();
        const response = await axios.get(endpoint, { headers: this.config.headers || {}, timeout: this.config.downloadTimeout || 30000 });
        let data = response.data;
        if (data && data.instances && Array.isArray(data.instances)) {
          data = data.instances;
        }
        if (!Array.isArray(data)) {
          throw new Error("Remote instance API must return an array or { instances: [] }");
        }
        this.instances = data
          .map((instance) => this.normalizeInstance(instance))
          .filter(Boolean);
        this.send("instances:data", this.instancesWithStatus());
        berry.log(`Fetched ${this.instances.length} remote instances`, "instanceManager");
      } catch (error) {
        berry.error("Could not sync remote instances. Stack:\n" + error.stack, "instanceManager");
      } finally {
        this.syncing = false;
      }
      return this.instancesWithStatus();
    }

    normalizeInstance(instance) {
      if (!instance) return null;
      const id = instance.id || instance.slug;
      const downloadUrl = instance.downloadUrl || instance.url || instance.archiveUrl;
      if (!id || !downloadUrl) {
        berry.error(`Skipping malformed instance entry: ${JSON.stringify(instance)}`, "instanceManager");
        return null;
      }
      const loader = (instance.loader || instance.modloader || "vanilla").toLowerCase();
      const minecraftVersion = instance.minecraftVersion || instance.gameVersion || instance.version;
      const loaderVersion = instance.loaderVersion || instance.modloaderVersion || instance.build || null;
      const versionId = instance.versionId || [id, loader, minecraftVersion].filter(Boolean).join("-");
      const memory = instance.memory || instance.recommendedMemory || {};
      const normalized = {
        id,
        name: instance.name || instance.displayName || id,
        description: instance.description || "",
        minecraftVersion,
        loader,
        loaderVersion,
        versionId,
        downloadUrl,
        sha1: instance.sha1 || instance.hash || instance.digest || null,
        updatedAt: instance.updatedAt || instance.modifiedAt || instance.versionUpdatedAt || instance.lastUpdate || null,
        archiveRoot: instance.archiveRoot || instance.archive?.root || null,
        icon: instance.icon || instance.iconUrl || null,
        size: instance.size || instance.archive?.size || null,
        javaComponent: instance.javaComponent || instance.javaVersion?.component || null,
        autoUpdate: instance.autoUpdate !== undefined ? instance.autoUpdate : true,
        memory: {
          min: memory.min || memory.minimum || this.config.defaults?.memory?.min || 2048,
          max: memory.max || memory.maximum || this.config.defaults?.memory?.max || 4096
        }
      };
      if (instance.tags) normalized.tags = instance.tags;
      if (instance.meta) normalized.remoteMeta = instance.meta;
      return normalized;
    }

    instancesWithStatus() {
      return this.instances.map((instance) => {
        const local = this.state.installed?.[instance.id];
        const hash = this.getHashForInstance(instance);
        return {
          ...instance,
          installed: !!(local && fs.existsSync(local.path)),
          needsUpdate: local ? local.hash !== hash : true,
          path: local?.path || null
        };
      });
    }

    getHashForInstance(instance) {
      return instance.sha1 || instance.updatedAt || crypto.createHash("md5").update(instance.versionId || instance.id).digest("hex");
    }

    async prepareLaunch(instanceId) {
      const installed = await this.ensureInstalled(instanceId);
      const instance = this.instances.find((inst) => inst.id === instanceId) || installed.remote;
      const manifest = installed.manifest || {};
      const gameDirectory = path.join(installed.path, manifest.gameDirectory || ".");
      const versionId = manifest.versionId || instance.versionId;
      const versionJsonPath = path.join(this.minecraftDir, "versions", versionId, `${versionId}.json`);
      let versionMeta = null;
      try {
        if (fs.existsSync(versionJsonPath)) {
          versionMeta = JSON.parse(fs.readFileSync(versionJsonPath, "utf8"));
        }
      } catch (error) {
        berry.error("Could not parse custom version json for " + versionId + ". Stack:\n" + error.stack, "instanceManager");
      }

      const payload = {
        id: versionId,
        type: manifest.type || "custom",
        actualVersion: manifest.baseVersion ? { id: manifest.baseVersion.id, url: manifest.baseVersion.url, type: manifest.baseVersion.type || "release" } : null,
        versionMeta,
        javaComponent: manifest.javaComponent || manifest.java?.component || instance.javaComponent,
        profile: {
          memory: manifest.memory?.max || instance.memory?.max || this.config.defaults?.memory?.max || 4096,
          directory: gameDirectory,
          directoryName: manifest.gameDirectory || ".",
          appearance: {
            name: instance.name,
            icon: manifest.icon || instance.loader
          }
        },
        remoteInstance: {
          id: instance.id,
          loader: instance.loader,
          loaderVersion: instance.loaderVersion,
          minecraftVersion: instance.minecraftVersion,
          path: gameDirectory
        }
      };
      if ((manifest.requiresInstaller?.loader || instance.loader) === "neoforge" && manifest.requiresInstaller?.version) {
        payload.requiresInstaller = manifest.requiresInstaller;
      }
      return payload;
    }

    async ensureInstalled(instanceId) {
      if (!this.enabled) {
        throw new Error("Remote instances are disabled");
      }
      const instance = this.instances.find((inst) => inst.id === instanceId);
      if (!instance) {
        throw new Error("Instance not found: " + instanceId);
      }
      const hash = this.getHashForInstance(instance);
      const local = this.state.installed?.[instanceId];
      if (local && local.hash === hash && fs.existsSync(local.path)) {
        return { ...local, remote: instance };
      }
      const downloadPath = path.join(os.tmpdir(), `${instance.id}-${Date.now()}.zip`);
      const extractedPath = path.join(os.tmpdir(), `${instance.id}-${Date.now()}`);
      try {
        await this.downloadInstance(instance, downloadPath);
        await extract(downloadPath, { dir: extractedPath });
        const { manifest, manifestDir } = await this.locateManifest(extractedPath);
        if (!manifest) {
          throw new Error(`Downloaded instance ${instance.id} is missing instance.meta.json`);
        }
        const targetDir = path.join(this.instancesDir, instance.id);
        await fsp.rm(targetDir, { recursive: true, force: true });
        await fsp.mkdir(targetDir, { recursive: true });
        await this.copyDir(manifestDir, targetDir);
        await this.registerVersionFolders(targetDir);
        await this.installRequiredLoader(manifest, instance);
        const metadata = {
          path: targetDir,
          hash,
          manifest,
          remote: instance,
          installedAt: Date.now()
        };
        this.state.installed[instance.id] = metadata;
        this.saveState();
        this.send("instances:data", this.instancesWithStatus());
        return metadata;
      } finally {
        this.cleanTmp([downloadPath, extractedPath]);
      }
    }

    async installRequiredLoader(manifest, instance) {
      const requirement = manifest.requiresInstaller;
      if (!requirement) return;
      const loader = (requirement.loader || instance.loader || "").toLowerCase();
      if (loader !== "neoforge") return;
      const loaderVersion = requirement.version || instance.loaderVersion;
      const minecraftVersion = requirement.minecraftVersion || manifest.minecraftVersion || manifest.baseVersion?.id || instance.minecraftVersion;
      if (!loaderVersion || !minecraftVersion) {
        throw new Error(`Missing loaderVersion or minecraftVersion for NeoForge installer requirement on instance ${instance.id}`);
      }
      const versionId = requirement.versionId || manifest.versionId || `neoforge-${minecraftVersion}-${loaderVersion}`;
      const versionJson = path.join(this.minecraftDir, "versions", versionId, `${versionId}.json`);
      if (fs.existsSync(versionJson)) {
        manifest.versionId = manifest.versionId || versionId;
        return;
      }
      this.send("instances:progress", { id: instance.id, phase: "installer", message: `Installing NeoForge ${loaderVersion}` });
      await LoaderInstaller.installNeoForge({
        version: loaderVersion,
        minecraftVersion,
        installDir: requirement.installDir || this.minecraftDir,
        installerUrl: requirement.installerUrl,
        progress: (meta) => {
          this.send("instances:progress", { id: instance.id, ...meta });
        }
      });
      manifest.versionId = manifest.versionId || versionId;
    }

    async registerVersionFolders(instancePath) {
      const versionFolders = this.config.install?.versionFolders || [];
      for (const folderName of versionFolders) {
        const folderPath = path.join(instancePath, folderName);
        if (!fs.existsSync(folderPath)) continue;
        const entries = await fsp.readdir(folderPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const source = path.join(folderPath, entry.name);
          const dest = path.join(this.minecraftDir, folderName, entry.name);
          await fsp.rm(dest, { recursive: true, force: true });
          await this.copyDir(source, dest);
        }
      }
    }

    async locateManifest(root) {
      const manifestFile = "instance.meta.json";
      const stack = [{ dir: root, depth: 0 }];
      const maxDepth = 6;
      while (stack.length) {
        const { dir, depth } = stack.pop();
        const directPath = path.join(dir, manifestFile);
        if (fs.existsSync(directPath)) {
          const manifest = JSON.parse(fs.readFileSync(directPath, "utf8"));
          return { manifest, manifestDir: dir };
        }
        if (depth >= maxDepth)
          continue;
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory())
            continue;
          stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
      return { manifest: null, manifestDir: root };
    }

    async downloadInstance(instance, destination) {
      berry.log(`Downloading remote instance ${instance.id} from ${instance.downloadUrl}`, "instanceManager");
      const response = await axios.get(instance.downloadUrl, {
        responseType: "stream",
        timeout: this.config.downloadTimeout || 30 * 60 * 1000,
        headers: this.config.headers || {}
      });
      const writer = fs.createWriteStream(destination);
      const totalLength = Number(response.headers["content-length"]) || instance.size || 0;
      let downloaded = 0;
      await pipeWithThrottle(response.data, writer, (chunkLength) => {
        downloaded += chunkLength;
        this.send("instances:progress", {
          id: instance.id,
          phase: "downloading",
          downloaded,
          total: totalLength
        });
      });
      if (instance.sha1) {
        const sha1 = await this.calculateSha1(destination);
        if (sha1 !== instance.sha1) {
          throw new Error(`Checksum mismatch for instance ${instance.id}`);
        }
      }
    }

    async calculateSha1(filePath) {
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha1");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (data) => hash.update(data));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
      });
    }

    async copyDir(source, destination) {
      await fsp.mkdir(destination, { recursive: true });
      const entries = await fsp.readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(source, entry.name);
        const destPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
          await this.copyDir(srcPath, destPath);
        } else {
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }

    cleanTmp(paths) {
      for (const filePath of paths) {
        try {
          if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
          }
        } catch (error) {
          berry.error("Could not clean temporary file " + filePath + ". Stack:\n" + error.stack, "instanceManager");
        }
      }
    }

    send(channel, payload) {
      try {
        this.win?.webContents.send(channel, payload);
      } catch (error) {
        berry.error("Could not send IPC message for instances. Stack:\n" + error.stack, "instanceManager");
      }
    }
  }

  new InstanceManager(win);
};
