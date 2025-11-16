const axios = require("axios");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { getOnicoreDir } = require("./onicorePaths");

const berry = require("./logger")();

async function resolveJavaFromEnv() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
  }
  candidates.push(process.platform === "win32" ? "java.exe" : "java");

  const checkBinary = (binary) => new Promise((resolve, reject) => {
    const proc = spawn(binary, ["-version"]);
    proc.on("exit", (code) => {
      if (code === 0) return resolve(binary);
      reject(new Error(`Java command ${binary} exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  for (const candidate of candidates) {
    try {
      await checkBinary(candidate);
      return candidate;
    } catch (error) {
      berry.error(`Failed to validate java binary candidate ${candidate}: ${error.message}`, "loaderInstaller");
    }
  }
  throw new Error("Java runtime not found. Please install Java or set JAVA_HOME.");
}

async function ensureJavaBinary() {
  return resolveJavaFromEnv();
}

async function downloadFile(url, destination, onProgress) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 30 * 60 * 1000,
    maxRedirects: 5
  });
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const writer = fs.createWriteStream(destination);
  const totalLength = Number(response.headers["content-length"]) || 0;
  let downloaded = 0;
  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    onProgress && onProgress({ downloaded, total: totalLength });
  });
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    response.data.pipe(writer);
  });
}

class LoaderInstaller {
  static async installNeoForge(options = {}) {
    const { version, minecraftVersion, installDir, installerUrl, progress } = options;
    if (!version) throw new Error("NeoForge version is required");
    const installDirectory = installDir || getOnicoreDir();
    const url = installerUrl || `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
    const tmpJar = path.join(os.tmpdir(), `neoforge-installer-${version}-${Date.now()}.jar`);
    berry.log(`Downloading NeoForge installer from ${url}`, "loaderInstaller");
    progress && progress({ phase: "neoforge-download", message: `Downloading NeoForge ${version}` });
    await downloadFile(url, tmpJar, (meta) => {
      progress && progress({ phase: "neoforge-download", ...meta });
    });
    const javaExecutable = await ensureJavaBinary();
    berry.log(`Running NeoForge installer for ${version} using ${javaExecutable}`, "loaderInstaller");
    progress && progress({ phase: "neoforge-install", message: `Installing NeoForge ${version}` });
    await new Promise((resolve, reject) => {
      const args = ["-jar", tmpJar, "--installClient", installDirectory];
      const child = spawn(javaExecutable, args, { stdio: "ignore" });
      child.on("exit", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`NeoForge installer ended with code ${code}`));
      });
      child.on("error", reject);
    });
    try {
      await fsp.rm(tmpJar, { force: true });
    } catch (error) {
      berry.error(`Failed to remove temporary NeoForge installer: ${error.message}`, "loaderInstaller");
    }
    progress && progress({ phase: "neoforge-install", message: `NeoForge ${version} installed.` });
    const versionId = `neoforge-${minecraftVersion}-${version}`;
    return versionId;
  }
}

module.exports = LoaderInstaller;
