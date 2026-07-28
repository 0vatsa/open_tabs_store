#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert(manifest.manifest_version === 3, "manifest_version must be 3");
assert(manifest.permissions.includes("tabs"), "tabs permission required");
assert(manifest.permissions.includes("storage"), "storage permission required");
assert(manifest.permissions.includes("alarms"), "alarms permission required");
assert(manifest.background?.service_worker === "background.js", "background service worker missing");
assert(
  manifest.background?.scripts?.includes("background.js"),
  "background scripts must include background.js for Firefox"
);
assert(
  manifest.browser_specific_settings?.gecko?.id,
  "browser_specific_settings.gecko.id required for Firefox"
);

for (const icon of ["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]) {
  assert(fs.existsSync(path.join(root, icon)), `Missing icon: ${icon}`);
}

const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
assert(background.includes('STORAGE_KEY = "snapshots"'), "background must use snapshots storage key");
assert(background.includes("DEFAULT_BACKUP_INTERVAL_MINUTES = 5"), "default backup interval must be 5 minutes");
assert(background.includes("normalizeIntervalMinutes"), "normalizeIntervalMinutes missing");
assert(background.includes("getBackupIntervalMinutes"), "getBackupIntervalMinutes missing");
assert(background.includes("setBackupIntervalMinutes"), "setBackupIntervalMinutes missing");
assert(background.includes("scheduleAutoBackup"), "scheduleAutoBackup missing");
assert(background.includes("captureSession"), "captureSession missing");
assert(background.includes("restoreSession"), "restoreSession missing");
assert(background.includes("addSnapshot"), "addSnapshot missing");
assert(background.includes("pruneExpiredSnapshots"), "pruneExpiredSnapshots missing");
assert(background.includes("BACKUP_NOW"), "BACKUP_NOW handler missing");
assert(background.includes("GET_STATUS"), "GET_STATUS handler missing");
assert(background.includes("GET_SNAPSHOTS"), "GET_SNAPSHOTS handler missing");
assert(background.includes("SET_BACKUP_INTERVAL"), "SET_BACKUP_INTERVAL handler missing");
assert(background.includes("RESTORE"), "RESTORE handler missing");
assert(!background.includes("scheduleSave"), "event-driven scheduleSave should be removed");

const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
assert(popupHtml.includes('id="backup-now"'), "backup button missing");
assert(popupHtml.includes('id="snapshot-list"'), "snapshot list missing");
assert(popupHtml.includes('id="backup-interval"'), "backup interval input missing");

const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
assert(popupJs.includes("window.confirm"), "restore confirmation missing");
assert(popupJs.includes("GET_SNAPSHOTS"), "popup must request snapshot list");
assert(popupJs.includes("SET_BACKUP_INTERVAL"), "popup must set backup interval");
assert(popupJs.includes("snapshotId"), "popup must send snapshotId on restore");

function isRestorableUrl(url) {
  if (!url) return false;
  const blocked = [
    "chrome://",
    "chrome-extension://",
    "devtools://",
    "brave://",
    "edge://",
    "moz-extension://",
    "resource://",
    "jar:"
  ];
  if (blocked.some((prefix) => url.startsWith(prefix))) {
    return false;
  }
  if (url.startsWith("about:")) {
    return url === "about:blank" || url.startsWith("about:blank#");
  }
  return true;
}

const sampleBackup = {
  windows: [
    {
      focused: true,
      state: "normal",
      tabs: [
        { url: "https://example.com", pinned: true, active: true },
        { url: "chrome://settings", pinned: false, active: false },
        { url: "about:preferences", pinned: false, active: false },
        { url: "about:blank", pinned: false, active: false }
      ]
    }
  ]
};

let restorable = 0;
let skipped = 0;
for (const win of sampleBackup.windows) {
  for (const tab of win.tabs) {
    if (isRestorableUrl(tab.url)) restorable += 1;
    else skipped += 1;
  }
}

assert(restorable === 2, "expected two restorable tabs in sample backup");
assert(skipped === 2, "expected two skipped tabs in sample backup");

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function validateAlarmScheduling() {
  const originalScheduledTime = 123456789;
  const storageData = {
    backupIntervalMinutes: 5,
    snapshots: []
  };
  const createCalls = [];
  let activeAlarm = {
    name: "autoBackup",
    periodInMinutes: 5,
    scheduledTime: originalScheduledTime
  };
  let messageListener;

  const chromeMock = {
    storage: {
      local: {
        async get(keys) {
          const requestedKeys = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requestedKeys
              .filter((key) => storageData[key] !== undefined)
              .map((key) => [key, storageData[key]])
          );
        },
        async set(values) {
          Object.assign(storageData, values);
        },
        async remove(key) {
          delete storageData[key];
        }
      }
    },
    alarms: {
      async get(name) {
        return activeAlarm?.name === name ? { ...activeAlarm } : undefined;
      },
      async create(name, options) {
        createCalls.push({ name, options });
        activeAlarm = {
          name,
          periodInMinutes: options.periodInMinutes,
          scheduledTime: Date.now() + options.periodInMinutes * 60 * 1000
        };
      },
      onAlarm: {
        addListener() {}
      }
    },
    runtime: {
      onInstalled: {
        addListener() {}
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    windows: {
      async getAll() {
        return [];
      },
      async create() {
        return { id: 1 };
      }
    },
    tabs: {
      async query() {
        return [];
      },
      async update() {}
    }
  };

  function startServiceWorker() {
    vm.runInNewContext(background, {
      chrome: chromeMock,
      console,
      crypto: { randomUUID: () => "test-id" }
    });
  }

  startServiceWorker();
  await flushAsyncWork();
  startServiceWorker();
  await flushAsyncWork();

  assert(createCalls.length === 0, "matching alarm must not be recreated on service-worker restart");
  assert(
    activeAlarm.scheduledTime === originalScheduledTime,
    "service-worker restart must preserve the alarm's scheduled time"
  );

  const intervalResponse = await new Promise((resolve) => {
    const keepsChannelOpen = messageListener(
      { type: "SET_BACKUP_INTERVAL", minutes: 10 },
      {},
      resolve
    );
    assert(keepsChannelOpen === true, "message handler must keep the response channel open");
  });

  assert(intervalResponse.ok, "interval update must succeed");
  assert(createCalls.length === 1, "changing the interval must replace the alarm once");
  assert(createCalls[0].options.periodInMinutes === 10, "replacement alarm must use the new interval");

  startServiceWorker();
  await flushAsyncWork();
  assert(createCalls.length === 1, "matching replacement alarm must survive later restarts");
}

function createMockElement() {
  return {
    hidden: false,
    textContent: "",
    value: "",
    disabled: false,
    className: "",
    classList: {
      toggle() {},
      remove() {}
    },
    addEventListener() {},
    replaceChildren() {},
    appendChild() {}
  };
}

async function validatePopupStorageRefresh() {
  const elements = new Map();
  const messages = [];
  let storageChangeListener;
  let removedStorageListener;
  let unloadListener;

  const documentMock = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createMockElement());
      }
      return elements.get(id);
    },
    createElement() {
      return createMockElement();
    }
  };

  const chromeMock = {
    runtime: {
      async sendMessage(message) {
        messages.push(message.type);
        if (message.type === "GET_STATUS") {
          return {
            ok: true,
            currentTabCount: 0,
            currentWindowCount: 0,
            savedAt: null,
            tabCount: null,
            windowCount: null,
            snapshotCount: 0,
            backupIntervalMinutes: 5
          };
        }
        if (message.type === "GET_SNAPSHOTS") {
          return { ok: true, snapshots: [] };
        }
        return { ok: true };
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageChangeListener = listener;
        },
        removeListener(listener) {
          removedStorageListener = listener;
        }
      }
    }
  };

  vm.runInNewContext(popupJs, {
    chrome: chromeMock,
    console,
    document: documentMock,
    window: {
      addEventListener(eventName, listener) {
        if (eventName === "unload") {
          unloadListener = listener;
        }
      },
      confirm() {
        return false;
      }
    }
  });
  await flushAsyncWork();

  assert(messages.filter((type) => type === "GET_STATUS").length === 1, "popup must load status initially");
  assert(
    messages.filter((type) => type === "GET_SNAPSHOTS").length === 1,
    "popup must load snapshots initially"
  );

  storageChangeListener({ snapshots: { newValue: [] } }, "local");
  await flushAsyncWork();

  assert(
    messages.filter((type) => type === "GET_STATUS").length === 2,
    "snapshot storage changes must refresh popup status"
  );
  assert(
    messages.filter((type) => type === "GET_SNAPSHOTS").length === 2,
    "snapshot storage changes must refresh popup history"
  );

  unloadListener();
  assert(
    removedStorageListener === storageChangeListener,
    "popup must remove its storage listener on unload"
  );
}

(async () => {
  await validateAlarmScheduling();
  await validatePopupStorageRefresh();
  console.log("Extension validation checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
