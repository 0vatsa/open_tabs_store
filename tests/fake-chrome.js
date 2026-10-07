/** Minimal in-memory stand-in for the chrome.* APIs the extension uses. */

export function createStorageArea({ failWrites = () => false } = {}) {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const list = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (data.has(key)) out[key] = structuredClone(data.get(key));
      return out;
    },
    async set(items) {
      if (failWrites()) throw new Error("QUOTA_BYTES quota exceeded");
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    async clear() {
      data.clear();
    }
  };
}

export function createFakeChrome({ local = createStorageArea(), windows = [] } = {}) {
  let nextWindowId = 1;
  let nextTabId = 1;
  let nextGroupId = 100;
  const state = { windows: [], groups: [], alarms: new Map(), badge: "", calls: [] };

  function addWindow({ state: winState = "normal", focused = false, tabs = [], ...bounds } = {}) {
    const win = { id: nextWindowId++, type: "normal", incognito: false, state: winState, focused, ...bounds, tabs: [] };
    state.windows.push(win);
    for (const tab of tabs) addTab(win, tab);
    return win;
  }

  function addTab(win, { url, title = "", pinned = false, active = false, groupId = -1 }) {
    const tab = { id: nextTabId++, windowId: win.id, url, title, pinned, active, groupId, discarded: false };
    if (pinned) {
      const firstUnpinned = win.tabs.findIndex((t) => !t.pinned);
      win.tabs.splice(firstUnpinned === -1 ? win.tabs.length : firstUnpinned, 0, tab);
    } else {
      win.tabs.push(tab);
    }
    reindex(win);
    if (active) setActive(tab);
    return tab;
  }

  function reindex(win) {
    win.tabs.forEach((tab, i) => (tab.index = i));
  }

  function setActive(tab) {
    const win = findWindow(tab.windowId);
    for (const t of win.tabs) t.active = t === tab;
  }

  function findWindow(id) {
    const win = state.windows.find((w) => w.id === id);
    if (!win) throw new Error(`No window with id: ${id}`);
    return win;
  }

  function findTab(id) {
    for (const win of state.windows) {
      const tab = win.tabs.find((t) => t.id === id);
      if (tab) return tab;
    }
    throw new Error(`No tab with id: ${id}`);
  }

  for (const win of windows) addWindow(win);

  const api = {
    state,
    addWindow,
    storage: { local, session: createStorageArea() },
    alarms: {
      async get(name) {
        return state.alarms.get(name);
      },
      async create(name, info) {
        state.alarms.set(name, { name, ...info });
      }
    },
    action: {
      async setBadgeText({ text }) {
        state.badge = text;
      },
      async setBadgeBackgroundColor() {}
    },
    windows: {
      async getAll() {
        return structuredClone(state.windows);
      },
      async create({ url, focused = true, ...props }) {
        if (props.state === "minimized" && focused) throw new Error("Invalid value for state");
        const win = addWindow({ focused, ...props });
        addTab(win, { url, active: true });
        if (focused) for (const w of state.windows) w.focused = w === win;
        return structuredClone(win);
      },
      async update(id, props) {
        const win = findWindow(id);
        if (props.state) win.state = props.state;
        if (props.focused) for (const w of state.windows) w.focused = w === win;
        return structuredClone(win);
      }
    },
    tabs: {
      async query() {
        return structuredClone(state.windows.flatMap((w) => w.tabs));
      },
      async get(id) {
        return structuredClone(findTab(id));
      },
      async create({ windowId, url, pinned = false, active = true }) {
        if (url.startsWith("blocked:")) throw new Error("Blocked by policy");
        const tab = addTab(findWindow(windowId), { url, pinned, active });
        return structuredClone(tab);
      },
      async update(id, props) {
        const tab = findTab(id);
        if (props.pinned != null && props.pinned !== tab.pinned) {
          const win = findWindow(tab.windowId);
          win.tabs.splice(win.tabs.indexOf(tab), 1);
          tab.pinned = props.pinned;
          const firstUnpinned = win.tabs.findIndex((t) => !t.pinned);
          win.tabs.splice(
            props.pinned ? (firstUnpinned === -1 ? win.tabs.length : firstUnpinned) : win.tabs.length,
            0,
            tab
          );
          reindex(win);
        }
        if (props.active) setActive(tab);
        return structuredClone(tab);
      },
      async discard(id) {
        const tab = findTab(id);
        if (tab.active) throw new Error("Cannot discard active tab");
        tab.discarded = true;
        return structuredClone(tab);
      },
      async group({ tabIds, createProperties }) {
        const id = nextGroupId++;
        state.groups.push({ id, windowId: createProperties.windowId, title: "", color: "grey", collapsed: false });
        for (const tabId of tabIds) findTab(tabId).groupId = id;
        return id;
      }
    },
    tabGroups: {
      async query() {
        return structuredClone(state.groups);
      },
      async update(id, props) {
        Object.assign(
          state.groups.find((g) => g.id === id),
          props
        );
      }
    }
  };
  return api;
}
