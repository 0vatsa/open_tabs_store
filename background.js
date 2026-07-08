const STORAGE_KEY = "latestBackup";
const DEBOUNCE_MS = 2000;
const PERIODIC_ALARM = "periodicBackup";

let saveTimeout = null;

function isRestorableUrl(url) {
  if (!url) return false;
  const blocked = ["chrome://", "chrome-extension://", "devtools://", "brave://", "edge://"];
  return !blocked.some((prefix) => url.startsWith(prefix));
}

async function captureSession() {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });

  return {
    savedAt: Date.now(),
    tabCount: windows.reduce((count, win) => count + win.tabs.length, 0),
    windows: windows.map((win) => ({
      focused: win.focused,
      state: win.state,
      tabs: win.tabs
        .sort((a, b) => a.index - b.index)
        .map((tab) => ({
          url: tab.url,
          title: tab.title,
          pinned: tab.pinned,
          active: tab.active,
          index: tab.index
        }))
    }))
  };
}

async function saveBackup() {
  const backup = await captureSession();
  await chrome.storage.local.set({ [STORAGE_KEY]: backup });
  return backup;
}

function scheduleSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveBackup().catch((error) => {
      console.error("Failed to save tab backup:", error);
    });
  }, DEBOUNCE_MS);
}

function countRestorableTabs(backup) {
  let restorable = 0;
  let skipped = 0;

  for (const win of backup.windows) {
    for (const tab of win.tabs) {
      if (isRestorableUrl(tab.url)) {
        restorable += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { restorable, skipped };
}

async function restoreSession(backup) {
  const counts = countRestorableTabs(backup);
  let restoredWindows = 0;

  for (const win of backup.windows) {
    const restorableTabs = win.tabs.filter((tab) => isRestorableUrl(tab.url));
    if (restorableTabs.length === 0) {
      continue;
    }

    const created = await chrome.windows.create({
      url: restorableTabs.map((tab) => tab.url),
      focused: win.focused,
      state: win.state
    });

    restoredWindows += 1;

    const openedTabs = await chrome.tabs.query({ windowId: created.id });
    const tabsByUrl = new Map();

    for (const tab of openedTabs) {
      if (!tabsByUrl.has(tab.url)) {
        tabsByUrl.set(tab.url, tab);
      }
    }

    for (const savedTab of restorableTabs) {
      const openedTab = tabsByUrl.get(savedTab.url);
      if (!openedTab) {
        continue;
      }

      if (savedTab.pinned) {
        await chrome.tabs.update(openedTab.id, { pinned: true });
      }
    }

    const activeTab = restorableTabs.find((tab) => tab.active);
    if (activeTab) {
      const openedTab = tabsByUrl.get(activeTab.url);
      if (openedTab) {
        await chrome.tabs.update(openedTab.id, { active: true });
      }
    }
  }

  return {
    ...counts,
    restoredWindows
  };
}

async function getStatus() {
  const [backupResult, windows] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
  ]);

  const backup = backupResult[STORAGE_KEY] || null;
  const currentTabCount = windows.reduce((count, win) => count + win.tabs.length, 0);

  return {
    savedAt: backup?.savedAt ?? null,
    tabCount: backup?.tabCount ?? null,
    windowCount: backup?.windows?.length ?? null,
    currentTabCount,
    currentWindowCount: windows.length,
    restorableTabCount: backup ? countRestorableTabs(backup).restorable : 0,
    skippedTabCount: backup ? countRestorableTabs(backup).skipped : 0
  };
}

function registerEventListeners() {
  const tabEvents = [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached
  ];

  for (const event of tabEvents) {
    event.addListener(() => scheduleSave());
  }

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.pinned) {
      scheduleSave();
    }
  });

  const windowEvents = [
    chrome.windows.onCreated,
    chrome.windows.onRemoved,
    chrome.windows.onFocusChanged
  ];

  for (const event of windowEvents) {
    event.addListener(() => scheduleSave());
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 5 });
  saveBackup().catch((error) => {
    console.error("Failed to create initial tab backup:", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM) {
    saveBackup().catch((error) => {
      console.error("Failed to run periodic tab backup:", error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handleMessage = async () => {
    switch (message.type) {
      case "BACKUP_NOW": {
        const backup = await saveBackup();
        return {
          ok: true,
          savedAt: backup.savedAt,
          tabCount: backup.tabCount,
          windowCount: backup.windows.length
        };
      }
      case "GET_STATUS":
        return { ok: true, ...(await getStatus()) };
      case "RESTORE": {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        const backup = result[STORAGE_KEY];

        if (!backup) {
          return { ok: false, error: "No backup found." };
        }

        const restoreResult = await restoreSession(backup);
        return { ok: true, ...restoreResult };
      }
      default:
        return { ok: false, error: "Unknown message type." };
    }
  };

  handleMessage()
    .then(sendResponse)
    .catch((error) => {
      console.error("Background message handler failed:", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

registerEventListeners();

saveBackup().catch((error) => {
  console.error("Failed to save startup tab backup:", error);
});
