const { app, ipcMain } = require("electron");
const { Launch } = require("minecraft-java-core");
const msmc = require("msmc");
const path = require("path");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const berry = require("./logger")();
const { getOnicoreDir } = require("./onicorePaths");
const { pipeWithThrottle } = require("./bandwidthLimiter");

module.exports = (win) => {
  class GameManager {
    constructor() {
      this.minecraftDir = getOnicoreDir();
      this.alreadyLaunched = false;
    }

    resolveMemory(profile = {}) {
      const memory = profile.memory;
      let max;
      let min;
      if (typeof memory === "object") {
        max = Number(memory.max || memory.maximum);
        min = Number(memory.min || memory.minimum);
      } else if (memory) {
        max = Number(memory);
      }
      if (!max || max < 512)
        max = Number(profile.memoryMax) || 4096;
      if (!min || min < 512)
        min = Number(profile.memoryMin) || Math.max(512, max - 512);
      if (max <= min)
        max = min + 256;
      return {
        min,
        max
      };
    }

    formatMemory(value) {
      if (!value || value < 512)
        return "512M";
      if (value % 1024 === 0) {
        return `${Math.max(1, Math.floor(value / 1024))}G`;
      }
      return `${value}M`;
    }

    createOfflineAuth(name) {
      const offlineName = name || `Flexberry${Math.floor(Math.random() * 1000) + 100}`;
      return {
        access_token: offlineName,
        client_token: `${offlineName}-${Date.now()}`,
        uuid: offlineName,
        name: offlineName,
        meta: {
          type: "msa",
          demo: true
        },
        user_properties: "{}"
      };
    }

    getAuthenticator(account) {
      if (account?.profile) {
        try {
          return msmc.getMCLC().getAuth(account.profile);
        } catch (err) {
          berry.error("Could not convert msmc profile to minecraft-java-core auth Stack:\n" + err?.stack, "gameManager");
        }
      }
      if (typeof account === "string")
        return this.createOfflineAuth(account);
      return this.createOfflineAuth(account?.profile?.name);
    }

    parseMemoryValue(value) {
      if (typeof value === "string") {
        const normalized = value.trim().toUpperCase();
        if (normalized.endsWith("G"))
          return parseInt(normalized.replace("G", ""), 10) * 1024;
        if (normalized.endsWith("M"))
          return parseInt(normalized.replace("M", ""), 10);
      }
      return Number(value) || 0;
    }

    normalizeMemoryOption(memory, profile) {
      const fallback = this.resolveMemory(profile || {});
      const min = this.parseMemoryValue(memory?.min) || fallback.min;
      const max = this.parseMemoryValue(memory?.max) || fallback.max;
      return {
        min: this.formatMemory(min),
        max: this.formatMemory(max)
      };
    }

    resolveGamePath(target) {
      if (!target)
        return this.minecraftDir;
      if (path.isAbsolute(target))
        return target;
      return path.join(this.minecraftDir, target);
    }

    async downloadJava(javaVersionCode) {
      return new Promise(async (resolve, reject) => {
        const javaPath = path.join(this.minecraftDir, "flexberry-jre", javaVersionCode, "bin", "javaw.exe");
        if (fs.existsSync(javaPath)) {
          win.webContents.send("progress", "Required Java is already installed");
          return resolve(javaPath);
        } else {
          require("./javaManager")(javaVersionCode)
            .then(async (java) => {
              try {
                let res = await axios(java.manifest.url);
                const files = Object.keys(res.data.files).map((file) => {
                  return { name: file, downloads: res.data.files[file].downloads, type: res.data.files[file].type };
                });

                let directory = files.filter((file) => file.type == "directory");
                let filesToDownload = files.filter((file) => file.type == "file");

                let javaDirs = [this.minecraftDir, "flexberry-jre", javaVersionCode]
                javaDirs.forEach((dir, i) => {
                  let _dir = javaDirs.slice(0, i + 1).join(path.sep);
                  if (!fs.existsSync(_dir)) {
                    berry.log(`Creating directory ${_dir}`, "gameManager");
                    win.webContents.send("progress", "Creating directory: " + _dir);
                    fs.mkdirSync(_dir);
                  }
                });

                directory.forEach((dir) => {
                  berry.log(`Creating directory ${dir.name}`, "gameManager");
                  win.webContents.send("progress", "Creating directory: " + dir.name);
                  fs.mkdirSync(path.join(this.minecraftDir, "flexberry-jre", javaVersionCode, dir.name));
                });

                let downloadedFiles = 0;
                for (let file of filesToDownload) {
                  win.webContents.send("progress", { type: "Java", task: downloadedFiles, total: filesToDownload.length });
                  let download = await axios.get(file.downloads["raw"].url, { responseType: "stream", timeout: 2147483647, httpsAgent: new https.Agent({ keepAlive: true }) });
                  let stream = fs.createWriteStream(path.join(this.minecraftDir, "flexberry-jre", javaVersionCode, file.name));
                  await pipeWithThrottle(download.data, stream);
                  downloadedFiles++;
                  win.webContents.send("progress", { type: "Java", task: downloadedFiles, total: filesToDownload.length });
                  berry.log(downloadedFiles + " of " + filesToDownload.length + " files downloaded (" + file.name + ")", "gameManager");
                }
                return resolve(javaPath);
              } catch (err) {
                berry.error(err);
                return reject("Could not download java")
              }
            })
            .catch((err) => {
              berry.error(err);
              return reject(err);
            });
        }
      });
    }

    async launch(arg) {
      if (arg.launchOptions) {
        return this.launchModpack(arg);
      }
      return this.launchVanilla(arg);
    }

    async launchModpack(arg) {
      return new Promise(async (resolve, reject) => {
        const options = JSON.parse(JSON.stringify(arg.launchOptions || {}));
        const account = this.getAuthenticator(arg.account);
        options.authenticator = account;
        options.path = this.resolveGamePath(options.path);
        options.memory = this.normalizeMemoryOption(options.memory, arg.profile);
        if (options.loader && options.loader.type) {
          options.loader.type = options.loader.type.toLowerCase();
        } else if (!options.loader) {
          options.loader = { enable: false };
        }
        const launcher = new Launch();
        launcher.on("progress", (progress, size, resource) => {
          win.webContents.send("progress", { type: resource || "download", task: progress, total: size });
        });

        launcher.on("data", (e) => {
          console.log(e);
        });

        launcher.on("error", (err) => {
          berry.error(err, "gameManager");
          win.webContents.send("progress", { type: "error", error: true, message: err?.error || err?.message || err });
        });

        try {
          await launcher.Launch(options);
          this.alreadyLaunched = true;
          resolve(launcher);
        } catch (err) {
          berry.error(err, "gameManager");
          reject({
            code: 580,
            error: err
          });
        }
      });
    }

    async launchVanilla(arg) {
      return new Promise(async (resolve, reject) => {
        let versionMeta = arg.versionMeta;
        let versionMetaURL = arg.url || arg.actualVersion?.url;
        if (!versionMeta) {
          if (!versionMetaURL) {
            berry.error("Missing version metadata url for launch request " + (arg?.id || ""), "gameManager");
            return reject({ code: 776, error: "Version meta is missing" });
          }
          try {
            versionMeta = (await axios.get(versionMetaURL)).data;
          } catch (err) {
            berry.error("Could not get version meta Stack:\n" + err?.stack, "gameManager");
            return reject({ code: 777, error: "Could not download version meta, skipping automatic java download" });
          }
        }
        const javaVersionCode = arg.javaComponent || versionMeta?.javaVersion?.component || "jre-legacy";
        /*
          currently only 1.6.x versions does not have javaVersion.component property, jre-legacy is used instead
          if Mojang decides to change the API, it'll attemp to use jre-legacy for all versions
          and jre-legacy won't launch versions over 1.16
        */
        let javaPath;
        try {
          javaPath = await this.downloadJava(javaVersionCode)
        } catch (err) {
          win.webContents.send("progress", "Could not download java, skipping automatic java download");
          return reject({ code: 778, error: "Could not download java, " + err });
        }
        berry.log("Java path: " + javaPath, "gameManager");
        const launcher = new Launch();
        let version = {
          number: arg.actualVersion?.id || arg.id,
          type: arg.type
        }
        if (arg.actualVersion)
          version.custom = arg.id;

        const account = this.getAuthenticator(arg.account);
        const memoryConfig = this.resolveMemory(arg.profile || {});
        const launchOptions = {
          path: this.minecraftDir,
          version: version.custom || version.number,
          authenticator: account,
          memory: {
            min: this.formatMemory(memoryConfig.min),
            max: this.formatMemory(memoryConfig.max)
          },
          loader: {
            enable: false
          },
          GAME_ARGS: []
        };
        if (arg.profile?.directory) {
          launchOptions.GAME_ARGS.push("--gameDir", arg.profile.directory);
        }
        if (javaPath) {
          launchOptions.java = {
            path: javaPath,
            type: "jre"
          };
        }

        berry.log("Launching " + (version.custom || version.number) + " with account " + (arg.account?.profile?.name || account?.name || "???"), "gameManager");

        launcher.on("progress", (progress, size, resource) => {
          win.webContents.send("progress", { type: resource || "assets", task: progress, total: size });
        });

        launcher.on("data", (e) => {
          console.log(e);
        });

        launcher.on("error", (err) => {
          berry.error(err, "gameManager");
          win.webContents.send("progress", { type: "error", error: true, message: err?.error || err?.message || err });
        });

        await wait(500);
        try {
          await launcher.Launch(launchOptions);
          this.alreadyLaunched = true;
          resolve(launcher);
        } catch (err) {
          berry.error(err, "gameManager");
          reject({
            code: 580,
            error: err
          });
        }
      });
    }
  }

  const Minecraft = new GameManager();

  ipcMain.on("launch", async (event, arg) => {
    win.webContents.send("progress", { action: "ui", state: true });
    Minecraft.launch(arg).then((instance) => {
      win.webContents.send("progress", "Launching");
      instance.on("data", (d) => {
        // berry.log("[Minecraft] " + d, "gameManager", true);
        if (win.isVisible()) {
          win.webContents.send("progress", { action: "ui", state: true });
          win.hide();
        }
      });
      instance.on("close", (d) => {
        berry.log("Minecraft is closed: " + d);
        if (!win.isVisible()) {
          win.webContents.send("progress", { action: "ui", state: false });
          win.show();
        }
      });
    }).catch(err => {
      berry.error(err, "gameManager");
    });
  });
}
