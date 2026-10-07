import { INTERVAL_CHOICES, SESSION_ID_KEY } from "../shared/constants.js";
import { buildHtmlExport, buildJsonExport, buildTextExport } from "../shared/export.js";
import { diffWindows } from "../shared/snapshot.js";
import { domainOf, isRestorableUrl } from "../shared/urls.js";
import {
  KEYS,
  KIND,
  confirmButton,
  downloadFile,
  fill,
  entryTitle,
  favicon,
  faviconStack,
  fileStamp,
  formatAgo,
  formatBytes,
  formatDay,
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

const LIVE_ID = "live";
const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  live: null,
  index: [],
  sessionId: null,
  restoreStatus: null,
  selectedId: null,
  query: "",
  filter: "",
  showDiff: false,
  windowsCache: new Map()
};

async function getWindows(id) {
  if (id === LIVE_ID) return state.live?.windows || [];
  if (!state.windowsCache.has(id)) {
    const snapshot = await store.getSnapshot(id);
    state.windowsCache.set(id, snapshot?.windows || []);
  }
  return state.windowsCache.get(id);
}

async function loadAllWindows() {
  const missing = state.index.filter((entry) => !state.windowsCache.has(entry.id)).map((entry) => entry.id);
  const snapshots = await store.getSnapshots(missing);
  missing.forEach((id, i) => state.windowsCache.set(id, snapshots[i]?.windows || []));
}

function selectedEntry() {
  return state.index.find((entry) => entry.id === state.selectedId) || null;
}

function select(id, { focusDetail = false } = {}) {
  state.selectedId = id;
  state.filter = "";
  state.showDiff = false;
  history.replaceState(null, "", id ? `#${id}` : location.pathname);
  renderTimeline();
  renderDetail().then(() => focusDetail && $("detail").focus());
}

async function restore(entry, { mode = "new", selection = null } = {}) {
  const targetWindowId = mode === "current" ? (await chrome.windows.getCurrent()).id : null;
  const { result } = await send("RESTORE", { id: entry.id, mode, targetWindowId, selection });
  toast(result.created === 0 ? "Nothing to restore — those tabs are already open." : restoreSummary(result));
}

function exportItems(items, kind) {
  const stamp = fileStamp();
  if (kind === "json") downloadFile(`open-tabs-${stamp}.json`, buildJsonExport(items), "application/json");
  if (kind === "html") downloadFile(`open-tabs-${stamp}.html`, buildHtmlExport(items), "text/html");
  if (kind === "md") downloadFile(`open-tabs-${stamp}.md`, buildTextExport(items), "text/markdown");
}

// ------------------------------------------------------------------ sidebar

function renderStatus() {
  const el = $("status");
  const { tone, title, detail } = protectionState(state.live, state.meta);
  el.className = `side-status tone-${tone}`;
  el.title = detail || "";
  fill(
    el,
    tone === "danger" ? icon("alert", 15) : h("span", { class: "dot" }),
    h("span", {}, title),
    state.live && tone !== "danger" ? h("span", { class: "when" }, formatAgo(state.live.updatedAt)) : null
  );
}

function timelineItem(entry) {
  const isLive = entry.id === LIVE_ID;
  const extra = (entry.restorableCount ?? 0) - Math.min(3, entry.preview?.length || 0);
  return h(
    "button",
    {
      class: `tl-item${isLive ? " tl-live" : ""}`,
      type: "button",
      dataset: { id: entry.id },
      "aria-current": String(state.selectedId === entry.id),
      onclick: () => select(entry.id)
    },
    h(
      "span",
      { class: "tl-time" },
      isLive ? h("span", { class: "dot" }) : null,
      isLive ? "Open now" : formatTime(entry.createdAt),
      entry.starred ? h("span", { class: "tl-star" }, icon("star", 12)) : null,
      !isLive && entry.kind !== KIND.AUTO ? kindBadge(entry) : null
    ),
    h("span", { class: "tl-name" }, isLive ? "Current session" : entryTitle(entry)),
    h("span", { class: "tl-meta" }, `${plural(entry.tabCount, "tab")} · ${plural(entry.windowCount, "window")}`),
    faviconStack(entry.preview, extra)
  );
}

function liveEntry() {
  if (!state.live) return null;
  const counts = liveCounts(state.live);
  const preview = [];
  const hosts = new Set();
  for (const win of state.live.windows) {
    for (const tab of win.tabs) {
      if (preview.length >= 3 || !isRestorableUrl(tab.url)) continue;
      const host = domainOf(tab.url);
      if (!hosts.has(host)) {
        hosts.add(host);
        preview.push(tab);
      }
    }
  }
  const restorableCount = state.live.windows.reduce(
    (n, w) => n + w.tabs.filter((t) => isRestorableUrl(t.url)).length,
    0
  );
  return { id: LIVE_ID, tabCount: counts.tabs, windowCount: counts.windows, restorableCount, preview };
}

function renderTimeline() {
  const el = $("timeline");
  const nodes = [];
  const live = liveEntry();
  if (live) nodes.push(timelineItem(live));

  for (const group of groupBySession(state.index, state.sessionId)) {
    const byDay = [];
    for (const entry of group.entries) {
      const day = formatDay(entry.createdAt);
      if (byDay.at(-1)?.day !== day) byDay.push({ day, entries: [] });
      byDay.at(-1).entries.push(entry);
    }
    nodes.push(
      h(
        "section",
        { class: "tl-group" },
        h(
          "div",
          { class: "tl-group-head" },
          group.title,
          group.subtitle ? h("span", { class: "muted" }, `· ${group.subtitle}`) : null
        ),
        byDay.map(({ day, entries }) => [
          byDay.length > 1 || day !== "Today" ? h("div", { class: "tl-group-head muted" }, day) : null,
          entries.map(timelineItem)
        ])
      )
    );
  }

  if (state.index.length === 0) {
    nodes.push(h("p", { class: "empty-inline" }, "No snapshots yet. Checkpoints appear here automatically."));
  }
  fill(el, ...nodes);
}

// ------------------------------------------------------------------ detail

function restoreBanner() {
  const status = state.restoreStatus;
  if (!status || (status.state !== "running" && Date.now() - (status.finishedAt || 0) > 60_000)) return null;
  if (status.state === "running") {
    const pct = status.total ? Math.round((status.created / status.total) * 100) : 0;
    return h(
      "div",
      { class: "banner" },
      `Restoring… ${status.created} of ${status.total} tabs`,
      h("div", { class: "progress" }, h("span", { style: `width:${pct}%` }))
    );
  }
  if (status.state === "error") return h("div", { class: "banner tone-danger" }, `Restore failed: ${status.error}`);
  return h("div", { class: "banner" }, restoreSummary(status));
}

function diffPanel(diff) {
  const column = (title, urls, cls, sign) =>
    h(
      "div",
      { class: "diff-col" },
      h("h3", { class: cls }, `${sign}${urls.length} ${title}`),
      urls.length
        ? h(
            "ul",
            {},
            urls.slice(0, 50).map((url) => h("li", {}, favicon(url), h("span", { title: url }, url)))
          )
        : h("p", { class: "muted" }, "None")
    );
  return h(
    "div",
    { class: "diff-panel" },
    column("opened", diff.added, "plus", "+"),
    column("closed", diff.removed, "minus", "−")
  );
}

async function renderEntryDetail(entry) {
  const isLive = entry.id === LIVE_ID;
  const windows = await getWindows(entry.id);
  const position = state.index.findIndex((item) => item.id === entry.id);
  const previous = isLive ? state.index[0] : state.index[position + 1];
  const diff = previous ? diffWindows(await getWindows(previous.id), windows) : null;
  const internal = entry.tabCount - entry.restorableCount;
  const group = isLive ? null : groupBySession(state.index, state.sessionId).find((g) => g.entries.includes(entry));

  const head = h(
    "div",
    { class: "detail-head" },
    h(
      "div",
      { class: "grow" },
      h(
        "div",
        { class: "eyebrow" },
        isLive ? h("span", { class: "badge badge-imported" }, "Live") : kindBadge(entry),
        isLive ? "Saved continuously as you browse" : group?.title
      ),
      h("h1", {}, isLive ? "Current session" : `${formatDay(entry.createdAt, true)}, ${formatTime(entry.createdAt)}`),
      isLive
        ? null
        : h("input", {
            class: "title-input",
            value: entry.label || "",
            placeholder: `${entryTitle(entry)} — add a name…`,
            "aria-label": "Snapshot name",
            maxlength: "120",
            onkeydown: (event) => event.key === "Enter" && event.target.blur(),
            onchange: (event) =>
              send("UPDATE_ENTRY", { id: entry.id, patch: { label: event.target.value.trim() } })
                .then(() => toast("Name saved."))
                .catch(reportError)
          }),
      h(
        "div",
        { class: "meta-row" },
        h("span", { class: "meta-item" }, icon("layers", 14), plural(entry.tabCount, "tab")),
        h("span", { class: "meta-item" }, icon("window", 14), plural(entry.windowCount, "window")),
        internal > 0
          ? h(
              "span",
              { class: "meta-item muted", title: "Browser pages like settings can't be reopened by extensions" },
              `${internal} browser ${internal === 1 ? "page" : "pages"} skipped`
            )
          : null,
        entry.bytes ? h("span", { class: "meta-item muted" }, formatBytes(entry.bytes)) : null,
        diff && (diff.added.length || diff.removed.length)
          ? h(
              "button",
              {
                class: "diff-btn",
                type: "button",
                "aria-expanded": String(state.showDiff),
                onclick: () => {
                  state.showDiff = !state.showDiff;
                  renderDetail();
                }
              },
              h("span", { class: "plus" }, `+${diff.added.length}`),
              h("span", { class: "minus" }, `−${diff.removed.length}`),
              `vs ${formatWhen(previous.createdAt)}`
            )
          : null
      )
    ),
    isLive
      ? null
      : h(
          "div",
          { class: "head-actions" },
          h(
            "button",
            {
              class: `icon-btn${entry.starred ? " active" : ""}`,
              type: "button",
              title: entry.starred ? "Unstar" : "Star — never delete automatically",
              "aria-label": entry.starred ? "Unstar" : "Star",
              "aria-pressed": String(Boolean(entry.starred)),
              onclick: () =>
                send("UPDATE_ENTRY", { id: entry.id, patch: { starred: !entry.starred } }).catch(reportError)
            },
            icon("star", 17)
          ),
          menuButton(
            [
              {
                label: "Download JSON (re-importable)",
                icon: "download",
                onSelect: () => exportItems([{ entry, windows }], "json")
              },
              {
                label: "Download HTML page",
                icon: "download",
                onSelect: () => exportItems([{ entry, windows }], "html")
              },
              {
                label: "Download Markdown list",
                icon: "download",
                onSelect: () => exportItems([{ entry, windows }], "md")
              },
              {
                label: "Copy links",
                icon: "layers",
                onSelect: async () => {
                  await navigator.clipboard.writeText(windows.flatMap((w) => w.tabs.map((t) => t.url)).join("\n"));
                  toast("Links copied to clipboard.");
                }
              },
              {
                label: "Delete snapshot",
                icon: "trash",
                danger: true,
                onSelect: async () => {
                  const { deleted } = await send("DELETE_ENTRY", { id: entry.id });
                  if (!deleted) return;
                  toast("Snapshot deleted.", {
                    action: {
                      label: "Undo",
                      run: () =>
                        send("UNDO_DELETE", { deleted })
                          .then(() => select(entry.id))
                          .catch(reportError)
                    }
                  });
                }
              }
            ],
            { label: "Export and more" }
          )
        )
  );

  const toolbar = h("div", { class: "toolbar" });
  const treeHost = h("div", {});
  const selection = new Set();
  let tree;

  const renderToolbar = () => {
    const selected = [...selection];
    const count =
      selected.length ||
      (state.meta.settings.skipOpenTabs ? missingFromLive(windows, state.live) : entry.restorableCount);
    const filterInput = h("input", {
      class: "input",
      type: "search",
      placeholder: "Filter tabs",
      value: state.filter,
      "aria-label": "Filter tabs in this snapshot",
      oninput: (event) => {
        state.filter = event.target.value;
        renderTree();
      }
    });
    fill(
      toolbar,
      isLive
        ? h(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onclick: () =>
                send("SAVE_NOW")
                  .then(({ entry: saved }) => (toast("Snapshot saved."), select(saved.id)))
                  .catch(reportError)
            },
            icon("bookmark", 15),
            "Save as snapshot"
          )
        : confirmButton({
            label: selected.length ? `Restore ${selected.length} selected` : "Restore all",
            confirmLabel: count ? `Open ${plural(count, "tab")}?` : "Restore anyway?",
            iconName: "restore",
            className: "btn btn-primary",
            onConfirm: () => restore(entry, { selection: selected.length ? selected : null })
          }),
      isLive
        ? null
        : h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () =>
                restore(entry, { mode: "current", selection: selected.length ? selected : null }).catch(reportError)
            },
            icon("window", 15),
            "Into this window"
          ),
      selected.length
        ? h("button", { class: "btn btn-ghost", type: "button", onclick: () => tree.clear() }, "Clear selection")
        : null,
      h("span", { class: "grow" }),
      h("label", { class: "search" }, icon("search", 14), filterInput)
    );
  };

  const renderTree = () => {
    tree = tabTree(windows, { selectable: !isLive, filter: state.filter, selection, onSelectionChange: renderToolbar });
    tree.el.classList.add("wide");
    fill(treeHost, tree.el);
  };

  renderTree();
  renderToolbar();

  return h(
    "div",
    { class: "detail-inner" },
    head,
    toolbar,
    restoreBanner(),
    state.showDiff && diff ? diffPanel(diff) : null,
    treeHost
  );
}

function highlight(text, terms) {
  if (!terms.length) return text;
  const lower = text.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    let i = lower.indexOf(term);
    while (i !== -1) {
      ranges.push([i, i + term.length]);
      i = lower.indexOf(term, i + term.length);
    }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start < pos) continue;
    out.push(text.slice(pos, start), h("mark", {}, text.slice(start, end)));
    pos = end;
  }
  out.push(text.slice(pos));
  return out;
}

async function renderSearch() {
  await loadAllWindows();
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const byUrl = new Map();
  const sources = [
    ...(state.live ? [{ entry: { id: LIVE_ID, createdAt: state.live.updatedAt }, windows: state.live.windows }] : [])
  ];
  for (const entry of state.index) sources.push({ entry, windows: state.windowsCache.get(entry.id) || [] });

  for (const { entry, windows } of sources) {
    for (const win of windows) {
      for (const tab of win.tabs) {
        const hay = `${tab.title} ${tab.url}`.toLowerCase();
        if (!terms.every((term) => hay.includes(term))) continue;
        const hit = byUrl.get(tab.url);
        if (!hit) {
          byUrl.set(tab.url, { tab, latest: entry, count: 1, open: entry.id === LIVE_ID, ids: new Set([entry.id]) });
        } else if (!hit.ids.has(entry.id)) {
          hit.ids.add(entry.id);
          hit.count += 1;
          if (entry.id === LIVE_ID) hit.open = true;
        }
      }
    }
  }

  const results = [...byUrl.values()].sort((a, b) => b.latest.createdAt - a.latest.createdAt).slice(0, 300);
  const snapshotsHit = new Set(results.flatMap((r) => [...r.ids])).size;

  return h(
    "div",
    { class: "detail-inner" },
    h("div", { class: "eyebrow" }, icon("search", 14), "Search"),
    h("h1", {}, `“${state.query}”`),
    h(
      "div",
      { class: "meta-row" },
      results.length
        ? `${plural(results.length, "tab")} across ${plural(snapshotsHit, "snapshot")}`
        : "No tabs found in any snapshot."
    ),
    results.length
      ? h(
          "div",
          { class: "results" },
          results.map(({ tab, latest, count, open }) =>
            h(
              "div",
              { class: "result" },
              favicon(tab.url),
              h(
                "div",
                { class: "result-text" },
                isRestorableUrl(tab.url)
                  ? h(
                      "a",
                      { class: "tab-title", href: tab.url, target: "_blank", rel: "noreferrer" },
                      highlight(tab.title || tab.url, terms)
                    )
                  : h("span", { class: "tab-title" }, highlight(tab.title || tab.url, terms)),
                h("span", { class: "tab-domain" }, highlight(tab.url, terms)),
                h(
                  "span",
                  { class: "result-meta" },
                  open ? "Open now · " : `Last seen ${formatWhen(latest.createdAt)} · `,
                  `in ${plural(count, "snapshot")}`
                )
              ),
              latest.id !== LIVE_ID
                ? h(
                    "button",
                    {
                      class: "btn btn-sm",
                      type: "button",
                      onclick: () => {
                        state.query = "";
                        $("search").value = "";
                        select(latest.id, { focusDetail: true });
                      }
                    },
                    "View snapshot"
                  )
                : null
            )
          )
        )
      : null
  );
}

let renderToken = 0;
async function renderDetail() {
  const token = ++renderToken;
  let node;
  if (state.query.trim()) {
    node = await renderSearch();
  } else {
    const entry = state.selectedId === LIVE_ID ? liveEntry() : selectedEntry();
    node = entry
      ? await renderEntryDetail(entry)
      : h(
          "div",
          { class: "placeholder" },
          icon("history", 28),
          h("strong", {}, state.index.length ? "Pick a snapshot" : "No snapshots yet"),
          h(
            "span",
            {},
            state.index.length
              ? "Choose one from the timeline to see its tabs."
              : "Checkpoints are created automatically while you browse."
          )
        );
  }
  if (token === renderToken) fill($("detail"), node);
}

// ------------------------------------------------------------------ settings dialog

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
  const kept = state.index.filter((e) => e.starred || e.kind === KIND.MANUAL || e.kind === KIND.IMPORTED).length;
  const stat = (value, label) =>
    h("div", { class: "stat" }, h("div", { class: "stat-value" }, value), h("div", { class: "stat-label" }, label));
  fill(
    $("storage-stats"),
    stat(formatBytes(bytes), "Used on disk"),
    stat(state.index.length.toLocaleString(), "Snapshots"),
    stat(kept.toLocaleString(), "Kept forever")
  );
}

async function exportAll(kind) {
  await loadAllWindows();
  if (!state.index.length) {
    toast("There is nothing to export yet.", { tone: "error" });
    return;
  }
  exportItems(
    state.index.map((entry) => ({ entry, windows: state.windowsCache.get(entry.id) || [] })),
    kind
  );
}

async function importFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const { imported } = await send("IMPORT", { data });
  toast(`Imported ${plural(imported, "snapshot")}.`);
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

function defaultSelection() {
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && fromHash !== "settings" && (fromHash === LIVE_ID || state.index.some((e) => e.id === fromHash)))
    return fromHash;
  const previous = state.index.find((e) => e.kind === KIND.SESSION_END && e.sessionId !== state.sessionId);
  if (previous && !previous.restoredAt && !previous.dismissed) return previous.id;
  return state.index[0]?.id ?? (state.live ? LIVE_ID : null);
}

function wireStatic() {
  $("brand").prepend(logo(26));
  document.querySelector(".appbar-search").prepend(icon("search", 15));
  $("save-now").append(icon("plus", 15), "Save now");
  $("open-settings").append(icon("settings", 17));
  $("close-settings").append(icon("x", 16));
  $("export-all-json").append(icon("download", 15), "Export all (JSON)");
  $("export-all-html").append(icon("download", 15), "Export all (HTML)");
  $("import").append(icon("upload", 15), "Import JSON…");

  $("save-now").addEventListener("click", async () => {
    try {
      const { entry } = await send("SAVE_NOW");
      toast(`Saved ${plural(entry.tabCount, "tab")}.`);
      select(entry.id);
    } catch (error) {
      reportError(error);
    }
  });
  $("open-settings").addEventListener("click", () => $("settings-dialog").showModal());
  $("settings-dialog").addEventListener("close", () => {
    if (location.hash === "#settings")
      history.replaceState(null, "", state.selectedId ? `#${state.selectedId}` : location.pathname);
  });

  const saveSetting = (patch) => send("SET_SETTINGS", { patch }).catch(reportError);
  $("interval").addEventListener("change", (e) => saveSetting({ intervalMinutes: Number(e.target.value) }));
  $("lazy").addEventListener("change", (e) => saveSetting({ lazyRestore: e.target.checked }));
  $("skip-open").addEventListener("change", (e) => saveSetting({ skipOpenTabs: e.target.checked }));
  $("export-all-json").addEventListener("click", () => exportAll("json").catch(reportError));
  $("export-all-html").addEventListener("click", () => exportAll("html").catch(reportError));
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) importFile(file).catch(reportError);
  });

  let searchTimer;
  $("search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      renderDetail().catch(reportError);
    }, 150);
  });
  $("search").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.target.value = "";
      state.query = "";
      renderDetail().catch(reportError);
    }
  });

  document.addEventListener("keydown", (event) => {
    const typing = event.target.matches("input, textarea, select");
    if (event.key === "/" && !typing) {
      event.preventDefault();
      $("search").focus();
      return;
    }
    if (typing || $("settings-dialog").open || !["ArrowDown", "ArrowUp", "j", "k"].includes(event.key)) return;
    if (!event.target.closest?.(".timeline") && event.target !== document.body) return;
    const items = [...document.querySelectorAll(".tl-item")];
    const i = items.findIndex((item) => item.dataset.id === state.selectedId);
    const next =
      items[event.key === "ArrowDown" || event.key === "j" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) {
      event.preventDefault();
      select(next.dataset.id);
      document.querySelector(`.tl-item[data-id="${next.dataset.id}"]`)?.focus();
    }
  });
}

async function main() {
  wireStatic();
  await load();
  state.selectedId = defaultSelection();
  renderStatus();
  renderTimeline();
  await Promise.all([renderDetail(), renderSettings()]);
  document.querySelector('.tl-item[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  if (location.hash === "#settings") $("settings-dialog").showModal();

  send("FLUSH_LIVE").catch(() => {});
  setInterval(renderStatus, 5000);

  onStorageChange([KEYS.META, KEYS.LIVE, KEYS.INDEX, KEYS.RESTORE_STATUS], async (changes) => {
    await load();
    if (changes[KEYS.INDEX]) {
      for (const id of state.windowsCache.keys()) {
        if (!state.index.some((entry) => entry.id === id)) state.windowsCache.delete(id);
      }
      if (state.selectedId !== LIVE_ID && !selectedEntry()) state.selectedId = state.index[0]?.id ?? null;
    }
    renderStatus();
    if (changes[KEYS.INDEX] || changes[KEYS.LIVE]) renderTimeline();
    const detailNeedsUpdate =
      changes[KEYS.INDEX] || changes[KEYS.RESTORE_STATUS] || (changes[KEYS.LIVE] && state.selectedId === LIVE_ID);
    // Don't re-render while the user is typing a name or filter; it would steal focus.
    if (detailNeedsUpdate && !document.activeElement?.matches?.(".detail input")) {
      await renderDetail();
    }
    if (changes[KEYS.META] || changes[KEYS.INDEX]) await renderSettings();
  });
}

main().catch(reportError);
