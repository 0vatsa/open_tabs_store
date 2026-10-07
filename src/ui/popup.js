import { INTERVAL_CHOICES, SESSION_ID_KEY } from "../shared/constants.js";
import { buildJsonExport } from "../shared/export.js";
import {
  KEYS,
  KIND,
  confirmButton,
  downloadFile,
  fill,
  entryTitle,
  faviconStack,
  fileStamp,
  formatAgo,
  formatBytes,
  formatTime,
  formatWhen,
  groupBySession,
  h,
  icon,
  kindBadge,
  liveCounts,
  logo,
  menuButton,
  missingFromLive,
  onStorageChange,
  plural,
  protectionState,
  reportError,
  restoreSummary,
  send,
  store,
  tabTree,
  toast
} from "./lib.js";

const MAX_ENTRIES = 25;

const $ = (id) => document.getElementById(id);
const state = {
  meta: null,
  live: null,
  index: [],
  sessionId: null,
  restoreStatus: null,
  expandedId: null,
  snapshotCache: new Map()
};

async function getWindows(id) {
  if (!state.snapshotCache.has(id)) {
    const snapshot = await store.getSnapshot(id);
    state.snapshotCache.set(id, snapshot?.windows || []);
  }
  return state.snapshotCache.get(id);
}

function openManager(hash = "") {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/ui/manager.html${hash}`) });
  window.close();
}

async function restore(entry, { mode = "new", selection = null } = {}) {
  const targetWindowId = mode === "current" ? (await chrome.windows.getCurrent()).id : null;
  const { result } = await send("RESTORE", { id: entry.id, mode, targetWindowId, selection });
  toast(result.created === 0 ? "Nothing to restore — those tabs are already open." : restoreSummary(result));
}

// ------------------------------------------------------------------ status

function renderStatus() {
  const el = $("status");
  const { tone, title, detail } = protectionState(state.live, state.meta);
  const counts = liveCounts(state.live);
  const interval = state.meta?.settings.intervalMinutes ?? 5;
  el.className = `status tone-${tone}`;

  const sub =
    detail ?? `${plural(counts.tabs, "tab")} in ${plural(counts.windows, "window")} · checkpoint every ${interval} min`;

  fill(
    el,
    h("span", { class: "status-icon" }, icon(tone === "danger" ? "alert" : "shield", 18)),
    h(
      "div",
      { class: "status-text" },
      h(
        "div",
        { class: "status-title" },
        tone === "ok" ? h("span", { class: "dot" }) : null,
        title,
        state.live && tone !== "danger"
          ? h("span", { class: "when" }, `· saved ${formatAgo(state.live.updatedAt)}`)
          : null
      ),
      h("div", { class: "status-sub" }, sub)
    ),
    tone === "danger"
      ? h(
          "button",
          {
            class: "btn btn-sm",
            type: "button",
            onclick: () =>
              send("FLUSH_LIVE")
                .then(() => toast("Saved successfully."))
                .catch(reportError)
          },
          "Retry"
        )
      : null
  );
}

function renderRestoreStatus() {
  const el = $("restore-status");
  const status = state.restoreStatus;
  const recent = status && (status.state === "running" || Date.now() - (status.finishedAt || 0) < 60_000);
  if (!recent) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = "restore-status";
  if (status.state === "running") {
    const pct = status.total ? Math.round((status.created / status.total) * 100) : 0;
    fill(
      el,
      h("div", {}, `Restoring… ${status.created} of ${status.total} tabs`),
      h("div", { class: "progress" }, h("span", { style: `width:${pct}%` }))
    );
  } else if (status.state === "error") {
    fill(el, h("div", { class: "tone-danger" }, `Restore failed: ${status.error}`));
  } else {
    fill(el, h("div", {}, restoreSummary(status)));
  }
}

// ------------------------------------------------------------------ hero

let heroSignature = null;

async function renderHero() {
  const el = $("hero");
  const previous = state.index.find((entry) => entry.kind === KIND.SESSION_END && entry.sessionId !== state.sessionId);
  const windows = previous ? await getWindows(previous.id) : [];
  const missing = previous ? missingFromLive(windows, state.live) : 0;
  if (!previous || previous.dismissed || previous.restoredAt || missing === 0) {
    heroSignature = null;
    el.hidden = true;
    return;
  }
  const willOpen = state.meta.settings.skipOpenTabs ? missing : previous.restorableCount;
  // Live-session updates arrive every few seconds; only rebuild when what we show changed,
  // otherwise a half-confirmed "Restore" button would reset under the user's cursor.
  const signature = `${previous.id}|${missing}|${willOpen}`;
  if (signature === heroSignature) return;
  heroSignature = signature;

  el.hidden = false;
  el.className = "hero";
  fill(
    el,
    h(
      "div",
      { class: "hero-top" },
      h("span", { class: "hero-icon" }, icon("restore", 18)),
      h(
        "div",
        {},
        h("div", { class: "hero-title" }, "Restore your previous session"),
        h(
          "div",
          { class: "hero-sub" },
          `Ended ${formatWhen(previous.createdAt)} · ${plural(previous.restorableCount, "tab")} in ${plural(previous.windowCount, "window")}`
        ),
        missing < previous.restorableCount
          ? h(
              "div",
              { class: "hero-sub" },
              `${plural(missing, "tab")} ${missing === 1 ? "isn't" : "aren't"} open right now`
            )
          : null
      )
    ),
    h(
      "div",
      { class: "hero-actions" },
      confirmButton({
        label: "Restore session",
        confirmLabel: `Open ${plural(willOpen, "tab")}?`,
        iconName: "restore",
        className: "btn btn-primary",
        onConfirm: () => restore(previous)
      }),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            state.expandedId = previous.id;
            renderHistory().then(() =>
              document.querySelector(`[data-id="${previous.id}"]`)?.scrollIntoView({ block: "nearest" })
            );
          }
        },
        "Preview"
      )
    ),
    h(
      "button",
      {
        class: "icon-btn hero-dismiss",
        type: "button",
        title: "Dismiss",
        "aria-label": "Dismiss",
        onclick: () => send("UPDATE_ENTRY", { id: previous.id, patch: { dismissed: true } }).catch(reportError)
      },
      icon("x", 14)
    )
  );
}

// ------------------------------------------------------------------ history

async function deleteEntry(entry) {
  const { deleted } = await send("DELETE_ENTRY", { id: entry.id });
  if (!deleted) return;
  toast("Snapshot deleted.", {
    action: { label: "Undo", run: () => send("UNDO_DELETE", { deleted }).catch(reportError) }
  });
}

function entryBody(entry, windows) {
  const body = h("div", { class: "entry-body" });
  const actions = h("div", { class: "entry-actions" });
  let tree;

  const renderActions = () => {
    const selected = [...tree.selection];
    const count =
      selected.length ||
      (state.meta.settings.skipOpenTabs ? missingFromLive(windows, state.live) : entry.restorableCount);
    fill(
      actions,
      confirmButton({
        label: selected.length ? `Restore ${selected.length} selected` : "Restore",
        confirmLabel: count ? `Open ${plural(count, "tab")}?` : "Restore anyway?",
        iconName: "restore",
        className: "btn btn-primary btn-sm",
        onConfirm: () => restore(entry, { selection: selected.length ? selected : null })
      }),
      selected.length
        ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => tree.clear() }, "Clear")
        : null,
      h("span", { class: "grow" }),
      menuButton([
        {
          label: "Restore into this window",
          icon: "window",
          onSelect: () => restore(entry, { mode: "current", selection: selected.length ? selected : null })
        },
        {
          label: entry.starred ? "Unstar" : "Star (keep forever)",
          icon: "star",
          onSelect: () => send("UPDATE_ENTRY", { id: entry.id, patch: { starred: !entry.starred } })
        },
        { label: "Open in full view", icon: "external", onSelect: () => openManager(`#${entry.id}`) },
        {
          label: "Download as JSON",
          icon: "download",
          onSelect: () =>
            downloadFile(
              `open-tabs-${fileStamp(entry.createdAt)}.json`,
              buildJsonExport([{ entry, windows }]),
              "application/json"
            )
        },
        { label: "Delete", icon: "trash", danger: true, onSelect: () => deleteEntry(entry) }
      ])
    );
  };

  tree = tabTree(windows, { selectable: true, compact: true, onSelectionChange: renderActions });
  renderActions();
  body.append(tree.el, actions);
  return body;
}

function entryRow(entry) {
  const open = state.expandedId === entry.id;
  const row = h("div", { class: `entry${open ? " open" : ""}`, dataset: { id: entry.id } });
  const extra = entry.restorableCount - Math.min(3, entry.preview?.length || 0);

  const main = h(
    "button",
    {
      class: "entry-main",
      type: "button",
      "aria-expanded": String(open),
      onclick: () => {
        state.expandedId = open ? null : entry.id;
        renderHistory().catch(reportError);
      }
    },
    faviconStack(entry.preview, extra),
    h(
      "span",
      { class: "entry-text" },
      h(
        "span",
        { class: "entry-title" },
        h("span", { class: "num" }, formatTime(entry.createdAt)),
        h("span", { class: "name" }, entryTitle(entry))
      ),
      h(
        "span",
        { class: "entry-meta num" },
        `${plural(entry.tabCount, "tab")} · ${plural(entry.windowCount, "window")}`
      )
    ),
    entry.starred ? h("span", { class: "entry-star", title: "Starred" }, icon("star", 14)) : null,
    entry.kind === KIND.MANUAL || entry.kind === KIND.IMPORTED ? kindBadge(entry) : null,
    h("span", { class: "chev" }, icon("chevronDown", 16))
  );
  row.append(main);

  if (open) {
    const placeholder = h("div", { class: "entry-body" }, h("p", { class: "empty-inline" }, "Loading…"));
    row.append(placeholder);
    getWindows(entry.id)
      .then((windows) => placeholder.replaceWith(entryBody(entry, windows)))
      .catch(reportError);
  }
  return row;
}

async function renderHistory() {
  const el = $("history");
  if (state.index.length === 0) {
    fill(
      el,
      h(
        "div",
        { class: "empty" },
        icon("shield", 22),
        h("strong", {}, "Your tabs are being watched"),
        h(
          "span",
          {},
          `The first checkpoint is created within ${state.meta?.settings.intervalMinutes ?? 5} minutes, or click “Save now”.`
        )
      )
    );
    return;
  }

  const shown = state.index.slice(0, MAX_ENTRIES);
  const groups = groupBySession(shown, state.sessionId);
  const nodes = groups.map((group) =>
    h(
      "section",
      { class: "session-group" },
      h(
        "div",
        { class: "session-head" },
        group.title,
        group.subtitle ? h("span", { class: "muted" }, `· ${group.subtitle}`) : null
      ),
      group.entries.map(entryRow)
    )
  );
  if (state.index.length > MAX_ENTRIES) {
    nodes.push(
      h(
        "button",
        { class: "more-link session-group", type: "button", onclick: () => openManager() },
        `View all ${state.index.length} snapshots`
      )
    );
  }
  fill(el, ...nodes);
}

// ------------------------------------------------------------------ settings

async function renderSettings() {
  const { settings } = state.meta;
  const select = $("interval");
  if (!select.options.length) {
    for (const minutes of INTERVAL_CHOICES) {
      select.append(h("option", { value: minutes }, minutes === 60 ? "1 hour" : plural(minutes, "minute")));
    }
  }
  select.value = String(settings.intervalMinutes);
  $("lazy").checked = settings.lazyRestore;
  $("skip-open").checked = settings.skipOpenTabs;

  const bytes = await chrome.storage.local.getBytesInUse(null);
  const text = `${formatBytes(bytes)} · ${plural(state.index.length, "snapshot")}`;
  $("storage-detail").textContent = text;
  $("storage-note").textContent = text;
}

async function saveSetting(patch) {
  try {
    await send("SET_SETTINGS", { patch });
  } catch (error) {
    reportError(error);
  }
}

// ------------------------------------------------------------------ boot

async function load() {
  const [meta, live, index, restoreStatus, session] = await Promise.all([
    store.getMeta(),
    store.getLive(),
    store.getIndex(),
    store.getRestoreStatus(),
    chrome.storage.session.get(SESSION_ID_KEY)
  ]);
  Object.assign(state, { meta, live, index, restoreStatus, sessionId: session[SESSION_ID_KEY] || null });
}

function wireStatic() {
  $("brand").prepend(logo(22));
  $("open-manager").append(icon("external", 16));
  $("open-settings").append(icon("settings", 16));
  $("close-settings").append(icon("x", 16));
  $("save-now").append(icon("plus", 14), "Save now");
  $("footer-manager").append(icon("history", 14), "Full history & search");

  $("open-manager").addEventListener("click", () => openManager());
  $("footer-manager").addEventListener("click", () => openManager());
  $("manage-data").addEventListener("click", () => openManager("#settings"));
  $("open-settings").addEventListener("click", () => {
    $("settings").hidden = false;
    $("interval").focus();
  });
  $("close-settings").addEventListener("click", () => {
    $("settings").hidden = true;
    $("open-settings").focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("settings").hidden) {
      event.preventDefault();
      $("settings").hidden = true;
    }
  });
  $("interval").addEventListener("change", (event) => saveSetting({ intervalMinutes: Number(event.target.value) }));
  $("lazy").addEventListener("change", (event) => saveSetting({ lazyRestore: event.target.checked }));
  $("skip-open").addEventListener("change", (event) => saveSetting({ skipOpenTabs: event.target.checked }));

  $("save-now").addEventListener("click", async () => {
    $("save-now").disabled = true;
    try {
      const { entry } = await send("SAVE_NOW");
      state.expandedId = null;
      toast(`Saved ${plural(entry.tabCount, "tab")} in ${plural(entry.windowCount, "window")}.`);
    } catch (error) {
      reportError(error);
    } finally {
      $("save-now").disabled = false;
    }
  });
}

async function main() {
  wireStatic();
  await load();
  renderStatus();
  renderRestoreStatus();
  await Promise.all([renderHero(), renderHistory(), renderSettings()]);

  send("FLUSH_LIVE").catch(() => {});
  setInterval(renderStatus, 5000);

  onStorageChange([KEYS.META, KEYS.LIVE, KEYS.INDEX, KEYS.RESTORE_STATUS], async (changes) => {
    await load();
    if (changes[KEYS.LIVE] || changes[KEYS.META]) renderStatus();
    if (changes[KEYS.RESTORE_STATUS]) renderRestoreStatus();
    if (changes[KEYS.INDEX]) {
      for (const id of state.snapshotCache.keys()) {
        if (!state.index.some((entry) => entry.id === id)) state.snapshotCache.delete(id);
      }
      await renderHistory();
    }
    if (changes[KEYS.INDEX] || changes[KEYS.LIVE]) await renderHero();
    if (changes[KEYS.META] || changes[KEYS.INDEX]) await renderSettings();
  });
}

main().catch(reportError);
