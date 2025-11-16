const settingsStore = require("./settingsStore");

function getLimitBytesPerSecond() {
  try {
    const settings = settingsStore.readSettings();
    const maxMbps = settings?.network?.maxMbps || 0;
    if (maxMbps > 0) {
      return (maxMbps * 1024 * 1024) / 8;
    }
  } catch {
    // ignore
  }
  return 0;
}

function pipeWithThrottle(readable, writer, onChunk) {
  const limit = getLimitBytesPerSecond();
  return new Promise((resolve, reject) => {
    let windowBytes = 0;
    let windowStart = Date.now();
    readable.on("data", (chunk) => {
      writer.write(chunk);
      onChunk && onChunk(chunk.length);
      if (limit > 0) {
        windowBytes += chunk.length;
        const now = Date.now();
        const elapsed = now - windowStart;
        if (elapsed >= 1000) {
          windowBytes = 0;
          windowStart = now;
        } else if (windowBytes >= limit) {
          readable.pause();
          setTimeout(() => {
            windowBytes = 0;
            windowStart = Date.now();
            readable.resume();
          }, Math.max(0, 1000 - elapsed));
        }
      }
    });
    readable.on("end", () => {
      writer.end();
      resolve();
    });
    readable.on("error", (err) => {
      writer.destroy();
      reject(err);
    });
  });
}

module.exports = {
  getLimitBytesPerSecond,
  pipeWithThrottle
};
