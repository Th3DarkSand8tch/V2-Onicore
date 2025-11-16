const { ipcMain } = require("electron");
const fetch = require("node-fetch");
const convert = require("xml-js");
const pkgJson = require("../../package.json");

class ModpackManager {
  constructor() {
    this.baseUrl = this.resolveBaseUrl();
    this.cache = {
      config: null,
      instances: null
    };
    ipcMain.handle("modpacks:config", async (event, options) => {
      return this.getLauncherConfig(options?.force);
    });
    ipcMain.handle("modpacks:list", async (event, options) => {
      return this.getInstanceList(options?.force);
    });
  }

  resolveBaseUrl() {
    const raw = pkgJson.user ? `${pkgJson.url}/${pkgJson.user}` : pkgJson.url;
    if (!raw || typeof raw !== "string" || !raw.trim()) {
      return "";
    }
    return raw.replace(/\/+$/, "");
  }

  ensureBaseUrl() {
    if (!this.baseUrl) {
      throw new Error("package.json is missing the \"url\" (and optional \"user\") fields required for modpack hosting.");
    }
    return this.baseUrl;
  }

  async fetchJSON(endpoint) {
    const base = this.ensureBaseUrl();
    const target = `${base}${endpoint}`;
    const response = await fetch(target, { timeout: 20000 });
    if (!response.ok) {
      throw new Error(`Failed to load ${endpoint} (HTTP ${response.status})`);
    }
    return response.json();
  }

  async getLauncherConfig(force = false) {
    if (this.cache.config && !force) {
      return this.cache.config;
    }
    const data = await this.fetchJSON("/launcher/config-launcher/config.json");
    if (data?.rss) {
      try {
        data.news = await this.fetchNewsFeed(data.rss);
      } catch (err) {
        data.news = [];
      }
    }
    this.cache.config = data;
    return data;
  }

  async getInstanceList(force = false) {
    if (this.cache.instances && !force) {
      return this.cache.instances;
    }
    const payload = await this.fetchJSON("/files");
    const list = Object.entries(payload || {}).map(([name, data]) => ({
      name,
      ...data
    }));
    this.cache.instances = list;
    return list;
  }

  async fetchNewsFeed(rssUrl) {
    const response = await fetch(rssUrl, { timeout: 20000 });
    if (!response.ok) {
      throw new Error(`Failed to load RSS feed (${response.status})`);
    }
    const xml = await response.text();
    const parsed = JSON.parse(convert.xml2json(xml, { compact: true }));
    const items = parsed?.rss?.channel?.item;
    if (!items)
      return [];
    const entries = Array.isArray(items) ? items : [items];
    return entries.map(entry => ({
      title: entry?.title?._text || "",
      author: entry?.["dc:creator"]?._text || "",
      publish_date: entry?.pubDate?._text || "",
      content: entry?.["content:encoded"]?._text || entry?.description?._text || ""
    }));
  }
}

module.exports = () => {
  return new ModpackManager();
};
