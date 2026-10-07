import { PREVIEW_TAB_COUNT } from "./constants.js";
import { isRestorableUrl } from "./urls.js";

/** Converts `chrome.windows.getAll({populate: true})` output into the stored window schema. */
export function serializeWindows(windows, groups = []) {
  const groupsByWindow = new Map();
  for (const group of groups) {
    if (!groupsByWindow.has(group.windowId)) groupsByWindow.set(group.windowId, []);
    groupsByWindow.get(group.windowId).push({
      id: group.id,
      title: group.title || "",
      color: group.color || "grey",
      collapsed: Boolean(group.collapsed)
    });
  }

  return windows
    .filter((win) => !win.incognito && (win.type == null || win.type === "normal"))
    .map((win) => {
      const tabs = [...(win.tabs || [])]
        .sort((a, b) => a.index - b.index)
        .map((tab) => {
          const saved = {
            url: tab.url || tab.pendingUrl || "",
            title: tab.title || "",
            pinned: Boolean(tab.pinned),
            active: Boolean(tab.active)
          };
          if (tab.groupId != null && tab.groupId !== -1) saved.groupId = tab.groupId;
          return saved;
        });

      const saved = {
        state: win.state || "normal",
        focused: Boolean(win.focused),
        tabs
      };
      for (const key of ["left", "top", "width", "height"]) {
        if (Number.isFinite(win[key])) saved[key] = win[key];
      }
      const winGroups = groupsByWindow.get(win.id);
      if (winGroups?.length) saved.groups = winGroups;
      return saved;
    })
    .filter((win) => win.tabs.length > 0);
}

/**
 * Content hash used to skip duplicate checkpoints. Titles are excluded on purpose: they change
 * constantly ("(3) Inbox") without the session meaningfully changing.
 */
export function hashWindows(windows) {
  const text = windows
    .map((win) => win.tabs.map((tab) => `${tab.pinned ? "P" : ""}${tab.groupId ?? ""}|${tab.url}`).join("\n"))
    .join("\n--\n");

  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + code) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function summarizeWindows(windows) {
  let tabCount = 0;
  let restorableCount = 0;
  const preview = [];
  const seenDomains = new Set();

  for (const win of windows) {
    for (const tab of win.tabs) {
      tabCount += 1;
      if (!isRestorableUrl(tab.url)) continue;
      restorableCount += 1;
      if (preview.length < PREVIEW_TAB_COUNT) {
        let host = tab.url;
        try {
          host = new URL(tab.url).host;
        } catch {
          // keep raw url as the dedupe key
        }
        if (!seenDomains.has(host)) {
          seenDomains.add(host);
          preview.push({ url: tab.url, title: tab.title });
        }
      }
    }
  }

  return { tabCount, windowCount: windows.length, restorableCount, preview };
}

export function snapshotBytes(windows) {
  return JSON.stringify(windows).length;
}

/** URL-level difference between two snapshots (multiset aware). */
export function diffWindows(before, after) {
  const count = (windows) => {
    const map = new Map();
    for (const win of windows) {
      for (const tab of win.tabs) map.set(tab.url, (map.get(tab.url) || 0) + 1);
    }
    return map;
  };
  const a = count(before);
  const b = count(after);
  const added = [];
  const removed = [];
  for (const [url, n] of b) {
    for (let i = 0; i < n - (a.get(url) || 0); i += 1) added.push(url);
  }
  for (const [url, n] of a) {
    for (let i = 0; i < n - (b.get(url) || 0); i += 1) removed.push(url);
  }
  return { added, removed };
}

/** Validates and normalizes windows coming from an import file. Throws on invalid input. */
export function validateImportedWindows(windows) {
  if (!Array.isArray(windows)) throw new Error("Snapshot is missing a windows list.");
  const result = windows
    .map((win) => {
      if (!win || !Array.isArray(win.tabs)) throw new Error("Window is missing a tabs list.");
      const tabs = win.tabs
        .filter((tab) => tab && typeof tab.url === "string" && tab.url !== "")
        .map((tab) => ({
          url: tab.url,
          title: typeof tab.title === "string" ? tab.title : "",
          pinned: Boolean(tab.pinned),
          active: Boolean(tab.active),
          ...(Number.isInteger(tab.groupId) ? { groupId: tab.groupId } : {})
        }));
      const saved = {
        state: ["normal", "maximized", "minimized", "fullscreen"].includes(win.state) ? win.state : "normal",
        focused: Boolean(win.focused),
        tabs
      };
      if (Array.isArray(win.groups)) {
        saved.groups = win.groups
          .filter((group) => group && Number.isInteger(group.id))
          .map((group) => ({
            id: group.id,
            title: String(group.title || ""),
            color: String(group.color || "grey"),
            collapsed: Boolean(group.collapsed)
          }));
      }
      return saved;
    })
    .filter((win) => win.tabs.length > 0);

  if (result.length === 0) throw new Error("Snapshot has no tabs.");
  return result;
}
