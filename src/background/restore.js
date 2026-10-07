import { isRestorableUrl } from "../shared/urls.js";

const URL_COMMIT_TIMEOUT_MS = 5_000;
const URL_POLL_MS = 150;
const NON_NORMAL_STATES = new Set(["minimized", "maximized", "fullscreen"]);

function tabKey(windowIndex, tabIndex) {
  return `${windowIndex}:${tabIndex}`;
}

/** Decides which saved tabs to open and why the rest are skipped. Pure. */
export function planRestore(windows, { selection = null, openUrls = new Set() } = {}) {
  const selected = selection ? new Set(selection) : null;
  const plan = [];
  let skippedInternal = 0;
  let skippedOpen = 0;

  windows.forEach((win, windowIndex) => {
    const tabs = [];
    win.tabs.forEach((tab, tabIndex) => {
      if (selected && !selected.has(tabKey(windowIndex, tabIndex))) return;
      if (!isRestorableUrl(tab.url)) {
        skippedInternal += 1;
        return;
      }
      if (openUrls.has(tab.url)) {
        skippedOpen += 1;
        return;
      }
      tabs.push(tab);
    });
    if (tabs.length) plan.push({ window: win, tabs });
  });

  const total = plan.reduce((sum, item) => sum + item.tabs.length, 0);
  return { plan, total, skippedInternal, skippedOpen };
}

async function waitForCommittedUrl(api, tabId) {
  const deadline = Date.now() + URL_COMMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tab = await api.tabs.get(tabId);
      if (tab.url && tab.url !== "about:blank") return true;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, URL_POLL_MS));
  }
  return false;
}

/** Unloads a background tab once its URL has committed, so it keeps its address but stops using memory. */
async function discardWhenReady(api, tabId) {
  if (!api.tabs.discard) return;
  if (!(await waitForCommittedUrl(api, tabId))) return;
  try {
    await api.tabs.discard(tabId);
  } catch {
    // Tab may have been activated or closed meanwhile; leaving it loaded is fine.
  }
}

async function recreateGroups(api, savedGroups, tabIdsByGroup, windowId) {
  if (!api.tabs.group || !savedGroups?.length) return;
  for (const group of savedGroups) {
    const tabIds = tabIdsByGroup.get(group.id);
    if (!tabIds?.length) continue;
    try {
      const groupId = await api.tabs.group({ tabIds, createProperties: { windowId } });
      await api.tabGroups?.update(groupId, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed
      });
    } catch {
      // Grouping is cosmetic; never fail a restore over it.
    }
  }
}

/**
 * Restores `windows` either as new windows (`mode: "new"`) or appended to `targetWindowId`
 * (`mode: "current"`). Tabs are created one by one so each saved tab maps to a real tab id.
 */
export async function restoreWindows(api, windows, options = {}, onProgress = () => {}) {
  const { mode = "new", targetWindowId = null, selection = null, lazy = true, skipOpen = true } = options;

  let openUrls = new Set();
  if (skipOpen) {
    const openTabs = await api.tabs.query({});
    openUrls = new Set(openTabs.map((tab) => tab.url || tab.pendingUrl).filter(Boolean));
  }

  const { plan, total, skippedInternal, skippedOpen } = planRestore(windows, { selection, openUrls });
  const result = { total, created: 0, failed: 0, skippedInternal, skippedOpen, windows: 0 };
  onProgress({ ...result });
  if (total === 0) return result;

  const targets =
    mode === "current"
      ? [
          {
            window: { state: "normal", focused: true, groups: plan.flatMap((p) => p.window.groups || []) },
            tabs: plan.flatMap((p) => p.tabs)
          }
        ]
      : plan;

  const toDiscard = [];
  let focusWindowId = null;
  let fallbackFocusId = null;

  for (const { window: savedWindow, tabs } of targets) {
    const createdIds = [];
    const tabIdsByGroup = new Map();
    let activeTabId = null;
    let windowId;
    let firstIndex = 0;

    const track = (savedTab, tabId) => {
      createdIds.push(tabId);
      if (savedTab.active && activeTabId == null) activeTabId = tabId;
      if (savedTab.groupId != null) {
        if (!tabIdsByGroup.has(savedTab.groupId)) tabIdsByGroup.set(savedTab.groupId, []);
        tabIdsByGroup.get(savedTab.groupId).push(tabId);
      }
      result.created += 1;
      onProgress({ ...result });
    };

    if (mode === "current" && targetWindowId != null) {
      windowId = targetWindowId;
    } else {
      const createProps = { url: tabs[0].url, focused: false };
      if (!NON_NORMAL_STATES.has(savedWindow.state)) {
        for (const key of ["left", "top", "width", "height"]) {
          if (Number.isFinite(savedWindow[key])) createProps[key] = savedWindow[key];
        }
      }
      let created;
      try {
        created = await api.windows.create(createProps);
      } catch {
        // Bounds can be invalid if a monitor was removed; retry with defaults.
        created = await api.windows.create({ url: tabs[0].url, focused: false });
      }
      windowId = created.id;
      result.windows += 1;
      const firstTab = created.tabs?.[0];
      if (firstTab) {
        if (tabs[0].pinned) await api.tabs.update(firstTab.id, { pinned: true });
        track(tabs[0], firstTab.id);
      }
      firstIndex = 1;
    }

    for (const savedTab of tabs.slice(firstIndex)) {
      try {
        const tab = await api.tabs.create({ windowId, url: savedTab.url, pinned: savedTab.pinned, active: false });
        track(savedTab, tab.id);
      } catch {
        result.failed += 1;
        onProgress({ ...result });
      }
    }

    await recreateGroups(api, savedWindow.groups, tabIdsByGroup, windowId);

    if (mode !== "current") {
      const keepLoaded = activeTabId ?? createdIds[0];
      if (keepLoaded != null) await api.tabs.update(keepLoaded, { active: true });
      if (lazy) toDiscard.push(...createdIds.filter((id) => id !== keepLoaded));
      if (NON_NORMAL_STATES.has(savedWindow.state)) {
        try {
          await api.windows.update(windowId, { state: savedWindow.state });
        } catch {
          // Unsupported state on this platform; window stays normal.
        }
      }
      if (savedWindow.state !== "minimized") {
        if (savedWindow.focused) focusWindowId = windowId;
        else fallbackFocusId ??= windowId;
      }
    } else if (lazy) {
      toDiscard.push(...createdIds);
    }
  }

  focusWindowId ??= fallbackFocusId;
  if (focusWindowId != null) {
    await api.windows.update(focusWindowId, { focused: true }).catch(() => {});
  }

  await Promise.all(toDiscard.map((id) => discardWhenReady(api, id)));
  return result;
}
