const STORAGE_KEY = "snapshots";
const LEGACY_STORAGE_KEY = "latestBackup";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const AUTO_BACKUP_ALARM = "autoBackup";

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

async function captureSession() {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });

  return {
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

function pruneExpiredSnapshots(snapshots) {
  const cutoff = Date.now() - RETENTION_MS;
  return snapshots.filter((snapshot) => snapshot.savedAt > cutoff);
}

function sortSnapshotsNewestFirst(snapshots) {
  return [...snapshots].sort((a, b) => b.savedAt - a.savedAt);
}

async function migrateLegacyBackup() {
  const result = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  const snapshots = result[STORAGE_KEY] || [];
  const legacyBackup = result[LEGACY_STORAGE_KEY];

  if (snapshots.length > 0 || !legacyBackup) {
    return snapshots;
  }

  const migratedSnapshot = {
    id: crypto.randomUUID(),
    savedAt: legacyBackup.savedAt || Date.now(),
    source: "auto",
    tabCount: legacyBackup.tabCount ?? 0,
    windows: legacyBackup.windows || []
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: [migratedSnapshot] });
  await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
  return [migratedSnapshot];
}

async function loadSnapshots() {
  const snapshots = await migrateLegacyBackup();
  const pruned = pruneExpiredSnapshots(snapshots);

  if (pruned.length !== snapshots.length) {
    await chrome.storage.local.set({ [STORAGE_KEY]: pruned });
  }

  return sortSnapshotsNewestFirst(pruned);
}

async function persistSnapshots(snapshots) {
  const pruned = pruneExpiredSnapshots(snapshots);
  await chrome.storage.local.set({ [STORAGE_KEY]: pruned });
  return pruned;
}

async function addSnapshot(source) {
  const session = await captureSession();
  const snapshot = {
    id: crypto.randomUUID(),
    savedAt: Date.now(),
    source,
    tabCount: session.tabCount,
    windows: session.windows
  };

  const snapshots = await loadSnapshots();
  snapshots.push(snapshot);
  const persisted = await persistSnapshots(snapshots);
  const saved = persisted.find((item) => item.id === snapshot.id) || snapshot;
  return saved;
}

async function getSnapshotById(id) {
  const snapshots = await loadSnapshots();
  return snapshots.find((snapshot) => snapshot.id === id) || null;
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

function summarizeSnapshot(snapshot) {
  const counts = countRestorableTabs(snapshot);
  return {
    id: snapshot.id,
    savedAt: snapshot.savedAt,
    source: snapshot.source,
    tabCount: snapshot.tabCount,
    windowCount: snapshot.windows.length,
    restorableTabCount: counts.restorable,
    skippedTabCount: counts.skipped
  };
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
  const [snapshots, windows] = await Promise.all([
    loadSnapshots(),
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })
  ]);

  const latest = snapshots[0] || null;
  const currentTabCount = windows.reduce((count, win) => count + win.tabs.length, 0);

  return {
    savedAt: latest?.savedAt ?? null,
    source: latest?.source ?? null,
    tabCount: latest?.tabCount ?? null,
    windowCount: latest?.windows?.length ?? null,
    currentTabCount,
    currentWindowCount: windows.length,
    restorableTabCount: latest ? countRestorableTabs(latest).restorable : 0,
    skippedTabCount: latest ? countRestorableTabs(latest).skipped : 0,
    snapshotCount: snapshots.length
  };
}

async function getSnapshots() {
  const snapshots = await loadSnapshots();
  return snapshots.map(summarizeSnapshot);
}

async function runAutoBackup() {
  await loadSnapshots();
  await addSnapshot("auto");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(AUTO_BACKUP_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_BACKUP_ALARM) {
    runAutoBackup().catch((error) => {
      console.error("Failed to run auto snapshot:", error);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handleMessage = async () => {
    switch (message.type) {
      case "BACKUP_NOW": {
        const snapshot = await addSnapshot("manual");
        return {
          ok: true,
          id: snapshot.id,
          savedAt: snapshot.savedAt,
          source: snapshot.source,
          tabCount: snapshot.tabCount,
          windowCount: snapshot.windows.length
        };
      }
      case "GET_STATUS":
        return { ok: true, ...(await getStatus()) };
      case "GET_SNAPSHOTS":
        return { ok: true, snapshots: await getSnapshots() };
      case "RESTORE": {
        if (!message.snapshotId) {
          return { ok: false, error: "No snapshot selected." };
        }

        const snapshot = await getSnapshotById(message.snapshotId);
        if (!snapshot) {
          return { ok: false, error: "Snapshot not found or expired." };
        }

        const restoreResult = await restoreSession(snapshot);
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
