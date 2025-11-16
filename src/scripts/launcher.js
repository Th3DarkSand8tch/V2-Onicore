const { createApp, toRaw } = Vue;

// TO-DO: Migrate some of the CSS @keyframes to JS

createApp({
  data() {
    return {
      activeTab: "",

      profiles: [],
      profilesSearch: "",
      accounts: [],
      accountsSearch: "",
      versions: [],
      versionsFilter: [],
      instances: [],
      instancesSearch: "",
      selectedInstance: null,
      instancesIntegrationEnabled: false,
      modpackConfig: null,
      modpackPreferences: null,
      modpackError: null,
      settings: {
        memoryMin: 2048,
        memoryMax: 4096,
        networkMaxMbps: 0
      },
      settingsState: {
        saving: false,
        success: false,
        error: null
      },

      skins: [],

      meta: {
        launcher: {},
        system: {},
      },
      
      tooltip: {
        visible: false,
        actions: [],
      },

      // I don't recommend you to edit this if you have no idea about what you are doing
      eventsToInvoke: [{ data: "versions", association: "versionManager", name: "getVersions", loaded: false }, { data: "profiles", association: "versionManager", name: "getProfiles", loaded: false }, { data: "accounts", bindIntoState: true, association: "accountManager", name: "getAccounts", loaded: false }],

      loadingStates: {
        accounts: true,
        launcher: false,
        addProfile: false,
        instances: true,
        settings: false,
      },
      progress: {
        state: undefined
      },
      blocks: ["glass", "grass_block", "diamond_block", "bedrock", "cobblestone", "crying_obsidian", "netherrack", "oak_log", "spruce_planks", "copper_block", "redstone_ore", "andesite"],
      wizard: {
        alert: undefined,
        mode: "data",
        data: {
          appearance: {}
        },
        edit: {
          appearance: {}
        }
      }
    }
  },
  computed: {
    filteredVersions: {
      get() {
        return this.versions.filter(version => this.versionsFilter.some(filter => version.type.includes(filter)));
      }
    },
    filteredProfiles: {
      get() {
        return this.profiles.filter(profile => profile.appearance.name.toLowerCase().includes(this.profilesSearch.toLowerCase()) || profile.version.toLowerCase().includes(this.profilesSearch.toLowerCase()));
      }
    },
    filteredAccounts: {
      get() {
        return this.accounts.filter(account => account.username.toLowerCase().includes(this.accountsSearch?.toLowerCase()));
      }
    },
    filteredInstances: {
      get() {
        return this.instances.filter(instance => {
          if (!this.instancesSearch)
            return true;
          const keyword = this.instancesSearch.toLowerCase();
          return instance.name?.toLowerCase().includes(keyword) || instance.id?.toLowerCase().includes(keyword) || instance.loader?.toLowerCase().includes(keyword);
        });
      }
    },
    skin: {
      get() {
        const account = this.accounts.find(account => account.isSelected)?.profile;
        return (account && account.skins && account.skins.length && account.skins[0].url) || "http://assets.mojang.com/SkinTemplates/steve.png";
      }
    }
  },
  methods: {
    // General methods
    toggleTab(tab) {
      if (this.activeTab == tab) {
        this.activeTab = "";
      } else {
        this.activeTab = tab;
      }
      (tab == "addProfile") && this.resetWizard();
    },
    load() {
      this.loadingStates.launcher = false;
      IPC.send("loaded");
      document.querySelector("link[href='style/loading.css']")?.remove();
    },
    async fetchSettings() {
      try {
        this.loadingStates.settings = true;
        this.settingsState.error = null;
        this.settingsState.success = false;
        const settings = await IPC.invoke("settings:get");
        this.settings.memoryMin = settings?.memory?.min || 2048;
        this.settings.memoryMax = settings?.memory?.max || 4096;
        this.settings.networkMaxMbps = settings?.network?.maxMbps || 0;
      } catch (error) {
        console.error(error);
      } finally {
        this.loadingStates.settings = false;
      }
    },
    normalizeMemoryValues() {
      let min = Number(this.settings.memoryMin) || 2048;
      let max = Number(this.settings.memoryMax) || 4096;
      if (min < 512) min = 512;
      if (max <= min) max = min + 256;
      if (max > 32768) max = 32768;
      this.settings.memoryMin = min;
      this.settings.memoryMax = max;
      return { min, max };
    },
    normalizeNetworkLimit() {
      let limit = Number(this.settings.networkMaxMbps) || 0;
      if (limit < 0) limit = 0;
      if (limit > 1000) limit = 1000;
      this.settings.networkMaxMbps = limit;
      return limit;
    },
    async saveSettings() {
      this.normalizeMemoryValues();
      const maxMbps = this.normalizeNetworkLimit();
      this.settingsState.saving = true;
      this.settingsState.error = null;
      this.settingsState.success = false;
      try {
        const payload = await IPC.invoke("settings:update", {
          memory: {
            min: this.settings.memoryMin,
            max: this.settings.memoryMax
          },
          network: {
            maxMbps
          }
        });
        this.settings.memoryMin = payload?.memory?.min || this.settings.memoryMin;
        this.settings.memoryMax = payload?.memory?.max || this.settings.memoryMax;
        this.settings.networkMaxMbps = payload?.network?.maxMbps ?? this.settings.networkMaxMbps;
        this.settingsState.success = true;
        setTimeout(() => (this.settingsState.success = false), 2500);
      } catch (error) {
        console.error(error);
        this.settingsState.error = error?.message || "Could not save settings.";
      } finally {
        this.settingsState.saving = false;
      }
    },
    applyMemoryToProfile(profile) {
      if (!profile) return;
      this.normalizeMemoryValues();
      const fallbackMax = Number(this.settings.memoryMax) || 4096;
      const fallbackMin = Number(this.settings.memoryMin) || 2048;
      let memory = profile.memory;
      if (typeof memory === "number") {
        memory = { max: memory };
      }
      let max = Number(memory?.max ?? memory?.maximum);
      let min = Number(memory?.min ?? memory?.minimum);
      if (!max || max < 512)
        max = fallbackMax;
      if (!min || min < 512)
        min = fallbackMin;
      if (max <= min)
        max = min + 256;
      profile.memory = { min, max };
    },
    async showTooltip(event, options) {
      this.tooltip.actions = options;
      const tooltipRef = this.$refs.tooltip;
      await new Promise(resolve => setTimeout(resolve, 60)); // Wait for click event to be fired
      const tooltipBounds = tooltipRef.getBoundingClientRect();
      const buttonBounds = event.target.getBoundingClientRect();
      tooltipRef.style.top = buttonBounds.top - tooltipBounds.height - 10 + "px";
      tooltipRef.style.left = buttonBounds.left + buttonBounds.width / 2 - tooltipBounds.width / 2 + "px";
      this.tooltip.visible = true;
    },
    // Instance management
    applyModpackList(list) {
      if (!Array.isArray(list)) {
        this.instancesIntegrationEnabled = false;
        this.instances = [];
        return;
      }
      const normalized = list.map(instance => {
        const loader = instance.loadder || {};
        const loaderType = (loader.loadder_type || instance.loader || "vanilla")?.toLowerCase();
        const displayName = instance.displayName || instance.title || instance.label || instance.name;
        return {
          id: instance.id || instance.name,
          ...instance,
          displayName,
          loader: loaderType,
          loaderVersion: loader.loadder_version || instance.loaderVersion || "",
          minecraftVersion: loader.minecraft_version || instance.minecraftVersion || instance.version || ""
        };
      });
      this.instances = normalized;
      this.instancesIntegrationEnabled = true;
      if (!normalized.length) {
        this.selectedInstance = null;
        return;
      }
      const preferred = this.modpackPreferences?.instance;
      if (preferred) {
        const match = normalized.find(item => item.name === preferred);
        this.selectedInstance = match || normalized[0];
      } else if (!this.selectedInstance) {
        this.selectedInstance = normalized[0];
      } else {
        const updated = normalized.find(item => item.name === this.selectedInstance?.name);
        this.selectedInstance = updated || normalized[0];
      }
    },
    async loadModpackPreferences() {
      try {
        this.modpackPreferences = await IPC.invoke("modpacks:preferences:get");
      } catch (error) {
        console.error(error);
        this.modpackPreferences = { instance: null, downloadMulti: 5, intelEnabledMac: true, closeLauncher: "hide", javaPath: null };
      }
    },
    async saveModpackPreferences() {
      try {
        await IPC.invoke("modpacks:preferences:set", this.modpackPreferences);
      } catch (error) {
        console.error(error);
      }
    },
    async loadModpackConfig(force = false) {
      try {
        const config = await IPC.invoke("modpacks:config", { force });
        this.modpackConfig = config;
        return config;
      } catch (error) {
        console.error(error);
        this.modpackError = error?.message || "Unable to load modpack configuration";
        throw error;
      }
    },
    async loadModpacks(force = false) {
      this.loadingStates.instances = true;
      try {
        if (!this.modpackConfig || force)
          await this.loadModpackConfig(force);
        const list = await IPC.invoke("modpacks:list", { force });
        this.modpackError = null;
        this.applyModpackList(list);
      } catch (error) {
        console.error(error);
        this.instancesIntegrationEnabled = false;
        this.modpackError = error?.message || "Unable to load modpacks";
      } finally {
        this.loadingStates.instances = false;
      }
    },
    async syncInstances() {
      await this.loadModpackConfig(true).catch(() => {});
      await this.loadModpacks(true);
    },
    selectInstance(instance) {
      this.selectedInstance = instance;
      if (this.modpackPreferences) {
        this.modpackPreferences.instance = instance?.name || null;
        this.saveModpackPreferences();
      }
    },
    async installInstance(instance) {
      const target = instance || this.selectedInstance;
      if (!target)
        return;
      if (!this.isInstanceAllowed(target))
        return alert("Vous n'êtes pas autorisé à installer ce modpack.");
      const proceed = confirm("L'installation téléchargera les fichiers et lancera Minecraft. Continuer ?");
      if (!proceed)
        return;
      return this.launchInstance(target);
    },
    getInstanceStatus(instance) {
      if (!instance)
        return "Unavailable";
      if (!this.instancesIntegrationEnabled)
        return "Disabled";
      if (!instance.url)
        return "Incomplete";
      if (instance.whitelistActive && !this.isInstanceAllowed(instance))
        return "Locked";
      return "Ready";
    },
    getInstanceProgress() {
      return null;
    },
    isInstanceAllowed(instance) {
      if (!instance?.whitelistActive)
        return true;
      const username = this.accounts.find(account => account.isSelected)?.profile?.name;
      if (!username)
        return false;
      return instance.whitelist?.includes(username);
    },
    buildLaunchOptions(instance) {
      const loader = instance?.loadder || {};
      const preferences = this.modpackPreferences || {};
      const memory = this.normalizeMemoryValues();
      return {
        url: instance.url,
        path: this.modpackConfig?.dataDirectory || "FlexberryLauncher",
        instance: instance.name,
        version: loader.minecraft_version || instance.minecraftVersion || instance.version || "latest_release",
        detached: preferences.closeLauncher !== "close-launcher",
        downloadFileMultiple: preferences.downloadMulti || 5,
        intelEnabledMac: preferences.intelEnabledMac !== false,
        verify: instance.verify !== undefined ? instance.verify : true,
        ignored: instance.ignored || [],
        JVM_ARGS: instance.jvm_args || [],
        GAME_ARGS: instance.game_args || [],
        loader: {
          enable: loader.loadder_type && loader.loadder_type !== "none",
          type: loader.loadder_type || null,
          build: loader.loadder_version || "latest"
        },
        memory: {
          min: memory.min,
          max: memory.max
        },
        java: {
          path: preferences.javaPath || null
        }
      };
    },
    async launchInstance(instance) {
      const selected = instance || this.selectedInstance || this.instances[0];
      if (!selected)
        return alert("Please select an instance");
      const targetInstance = JSON.parse(JSON.stringify(toRaw(selected)));
      if (!targetInstance.url)
        return alert("Instance files are not configured yet.");
      if (!this.isInstanceAllowed(targetInstance))
        return alert("Vous n'êtes pas autorisé à lancer ce modpack.");
      const account = JSON.parse(JSON.stringify(toRaw(this.accounts.find(account => account.isSelected))));
      if (!account)
        return alert("Please log in with a Microsoft account first.");
      const launchPayload = {
        launchOptions: this.buildLaunchOptions(targetInstance),
        account,
        profile: {
          memory: this.normalizeMemoryValues()
        }
      };
      this.toggleTab();
      this.loadingStates.launcher = true;
      this.progress.state = "Preparing modpack...";
      IPC.send("launch", launchPayload);
    },
    // Account and version profile methods
    deleteProfile(profile) {
      this.profiles = this.profiles.filter(pf => pf.appearance?.name != profile);
      IPC.send("deleteProfile", profile);
      // If there is no selected profile, select the first one
      if (!this.profiles.find(profile => profile.isSelected)) {
        this.selectProfile(this.profiles[0].appearance.name);
        this.profiles[0].isSelected = true;
      }
    },
    selectProfile(profile) {
      const profileToSelect = this.profiles.find(pf => pf.appearance?.name == profile);
      if (!profileToSelect)
        return;
      profileToSelect.selected = true;
      IPC.send("selectProfile", profile);
    },
    login() {
      this.loadingStates.accounts = true;
      IPC.send("addAccount");
    },
    selectAccount(uuid) {
      this.loadingStates.accounts = true;
      const accountValidity = JSON.parse(IPC.sendSync("verifyAccount", uuid));
      if (accountValidity.status == "error")
        return alert(accountValidity.error);
      if (accountValidity.valid)
        IPC.send("selectAccount", uuid);
      else 
        IPC.send("refreshAccount", uuid);
    },
    logout(uuid) {
      this.loadingStates.accounts = true;
      IPC.send("deleteAccount", uuid);
    },
    // Wizard methods
    openEditProfile(profile) {
      this.toggleTab("addProfile");
      this.wizard.edit = JSON.parse(JSON.stringify(profile));
      this.wizard.staticName = profile?.appearance?.name;
      this.wizard.mode = "edit";
    },
    resetWizard() {
      this.wizard.data = {
        version: "",
        type: "",
        directory: "",
        appearance: {
          icon: "glass",
          name: ""
        },
        memory: Math.min(Math.floor(this.meta.system.memory / 1024 / 1024 / 2.5), 8000),
        dimensions: {
          width: 500,
          height: 420
        }
      };
      this.wizard.mode = "data";
      this.wizard.alert = undefined;
    },
    createProfile() {
      const profile = toRaw(this.wizard[this.wizard.mode]);
      if (!profile.appearance.name)
        return alert("Please enter a profile name");
      if (!profile.version)
        return alert("Please select a version");
      this.loadingStates.addProfile = true;
      if (this.wizard.mode == "edit")
        IPC.send("editProfile", profile);
      else
        IPC.send("addProfile", profile);
      this.wizard.mode = "data"
      this.toggleTab("profiles");
    },
    async openDirectory() {
      this.loadingStates.addProfile = true;
      this.wizard[this.wizard.mode].directory = (await IPC.invoke("openDirectory")) || "";
      this.loadingStates.addProfile = false;
    },
    // Launch methods
    launch() {
      const selectedProfile = toRaw(this.profiles.find(profile => profile.isSelected));
      const launchProfile = {
        ...toRaw(this.versions.find(version => version.id == selectedProfile.version)),
        profile: selectedProfile,
        account: toRaw(this.accounts.find(account => account.isSelected)) || ("flexberry" + Math.floor(Math.random() * 1000) + 100)
      }
      this.applyMemoryToProfile(launchProfile.profile);
      this.toggleTab();
      this.loadingStates.launcher = true;
      this.progress.state = "Preparing...";
      IPC.send("launch", launchProfile);
    }
  },
  watch: {
    "loadingStates.launcher"(value) {
      if (value)
        document.body.classList.add("loaded");
      else
        document.body.classList.remove("loaded");
    }
  },
  mounted() {
    this.meta = IPC.sendSync("getMeta"); 
    this.resetWizard();
    this.fetchSettings();
    this.loadModpackPreferences()
      .then(() => this.loadModpackConfig().catch(() => undefined))
      .finally(() => this.loadModpacks().catch(() => undefined));

    IPC.on("pong", (meta) => {
      for (const event of meta.call) {
        IPC.invoke(event).then(result => {
          let eventToInvoke = this.eventsToInvoke.find(e => e.name == event);
          if (eventToInvoke.bindIntoState)
            this.loadingStates[eventToInvoke.data] = false;
          this[eventToInvoke.data] = result;
          eventToInvoke.loaded = true;
          if (this.eventsToInvoke.every(e => e.loaded) && !this.loadingStates.launcher)
            this.load();
          // console.log(`Loaded ${event} from ${eventToInvoke.association} with ${result.length} data length`);
        }).catch(error => {
          // alert(`Error while loading ${event}: ${error}`);
          console.error(error.stack);
        });

      }
    });

    IPC.on("profiles", (profiles) => {
      this.loadingStates.addProfile = false;
      if (!profiles || profiles.status == "error") {
        profiles?.message && alert(profiles.message);
        return console.error(profiles);
      }
      this.profiles = profiles;
    });

    IPC.on("accounts", (result) => {
      result = JSON.parse(result);
      this.loadingStates.accounts = false;
      if (result.status == "error")
        return console.error(result.error || "Unknown error");
      this.accounts = JSON.parse(result.accounts);
    });

    IPC.on("refreshAccountResult", (result) => {
      result = JSON.parse(result);
      this.loadingStates.accounts = true;
      if (result.status == "error")
        return console.error(result);
      IPC.send("selectAccount", result.uuid);
    });

    IPC.on("progress", (progress) => {
      if (progress.type == "update") {
        this.loadingStates.launcher = true;
        this.progress.state = progress.message;
      } else {
        if (progress.action == "ui") {
          !progress.state && location.reload();
          return this.loadingStates.launcher = progress.state;
        }
        this.progress.state = (progress instanceof Object)
          ? (((progress.type == "assets") && Math.round((progress.task / progress.total) * 100) == 0)) || (progress.type == "assets-copy")
            ? "Initializing assets"
            : (`Downloading ${progress.type} ${Math.round((progress.task / progress.total) * 100)}%`)
          : progress;
      }
    });

    document.addEventListener("click", async (e) => {
      if (e.target.classList.contains("profileAction")) {
        this.tooltip.visible = false;
        this.tooltip.visible = true;
        // ^ To play transition
      }
      this.tooltip.visible = false;
    });

    // Demo code of skin library
    /* (async () => {
      const skinViewer = new skinview3d.SkinViewer({
        width: 200,
        height: 300,
        renderPaused: true
      });
  
      skinViewer.camera.rotation.y = -0.4;
      skinViewer.camera.position.x = -18;
      skinViewer.fov = 30;
      skinViewer.nameTag = "kuzey_"

      console.time("skin");
      const skins = ["00001", "00002", "00003", "00004", "00005", "00006", "00007", "00008", "00009", "00010", "00011", "00012", "00013", "00014", "00015", "00016", "00017", "00018", "00019", "00020", "00021", "00022", "00023", "00024", "00025", "00026", "00027", "00028", "00029", "00030", "00031", "00032", "00033", "00034", "00035", "00036", "00037", "00038", "00039", "00040", "00041", "00042", "00043", "00044", "00045", "00046", "00047", "00048", "00049", "00050", "00051", "00052", "00053", "00054", "00055", "00056", "00057", "00058", "00059", "00060", "00061", "00062", "00063", "00064", "00065", "00066", "00067", "00068", "00069", "00070", "00071", "00072", "00073", "00074", "00075", "00076", "00077", "00078", "00079", "00080", "00081", "00082", "00083", "00084", "00085", "00086", "00087", "00088", "00089", "00090", "00091", "00092", "00093", "00094", "00095", "00096", "00097", "00098", "00099", "00100"];
      for (const skin of skins) {
        await skinViewer.loadSkin(`https://jcpopipvurwaefwngpnh.supabase.co/storage/v1/object/public/skins/general/${skin}.png`);
        await skinViewer.render();
        this.images += (skinViewer.canvas.toDataURL());
        console.log(`Loaded ${skin}`);
      }
      console.timeEnd("skin");
    })(); */

    IPC.send("ping");
  }
}).mount("#app");
