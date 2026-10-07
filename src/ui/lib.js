import { KIND, KEYS, SNAP_PREFIX } from "../shared/constants.js";
import { createStore } from "../shared/store.js";
import { domainOf, isRestorableUrl } from "../shared/urls.js";

export const store = createStore(chrome.storage.local);

// ------------------------------------------------------------------ DOM

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function")
      el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "html") el.innerHTML = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** replaceChildren() that skips null/false (the native one renders them as text). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return el;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  star: '<path d="M11.52 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.13a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.9l5.17-.76a2.12 2.12 0 0 0 1.6-1.16z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><path d="M6 4v4"/><path d="M10 4v4"/>',
  pencil:
    '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'
};

export function icon(name, size = 16) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export function logo(size = 22) {
  const span = document.createElement("span");
  span.className = "logo";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7.2" fill="#4f46e5"/><rect x="10.5" y="7.8" width="15" height="9.2" rx="2.2" fill="#fff" fill-opacity=".35"/><rect x="8.2" y="10.6" width="15.6" height="9.9" rx="2.2" fill="#fff" fill-opacity=".65"/><rect x="6" y="11.6" width="8" height="4.6" rx="1.5" fill="#fff"/><rect x="6" y="14.2" width="16" height="11" rx="2.2" fill="#fff"/><rect x="8.6" y="17" width="10.8" height="1.9" rx=".95" fill="#4f46e5" fill-opacity=".28"/></svg>`;
  return span;
}

// ------------------------------------------------------------------ messaging & storage

export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "The extension did not respond. Try reopening this page.");
  return response;
}

export function onStorageChange(keys, callback) {
  const listener = (changes, area) => {
    if (area !== "local") return;
    if (
      Object.keys(changes).some(
        (key) => keys.includes(key) || (keys.includes(SNAP_PREFIX) && key.startsWith(SNAP_PREFIX))
      )
    ) {
      callback(changes);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export { KEYS, KIND };

// ------------------------------------------------------------------ formatting

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const longDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatTime(t) {
  return timeFmt.format(t);
}

export function formatDay(t, long = false) {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return (long ? longDayFmt : dayFmt).format(t);
}

export function formatWhen(t) {
  const day = formatDay(t);
  return day === "Today" ? formatTime(t) : `${day}, ${formatTime(t)}`;
}

export function formatAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatWhen(t);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const KIND_LABEL = {
  [KIND.AUTO]: "Auto",
  [KIND.MANUAL]: "Saved",
  [KIND.SESSION_END]: "Session end",
  [KIND.IMPORTED]: "Imported"
};

export function entryTitle(entry) {
  if (entry.label) return entry.label;
  if (entry.kind === KIND.SESSION_END) return "End of browser session";
  if (entry.kind === KIND.MANUAL) return "Saved manually";
  if (entry.kind === KIND.IMPORTED) return "Imported snapshot";
  return "Automatic checkpoint";
}

export function kindBadge(entry) {
  return h("span", { class: `badge badge-${entry.kind}` }, KIND_LABEL[entry.kind] || entry.kind);
}

/** Groups index entries by browser session, newest first. */
export function groupBySession(index, currentSessionId) {
  const groups = new Map();
  for (const entry of index) {
    const key = entry.kind === KIND.IMPORTED ? "imported" : entry.sessionId || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  let previousSeen = false;
  return [...groups.entries()]
    .map(([key, entries]) => ({ key, entries }))
    .sort((a, b) => {
      if (a.key === "imported") return 1;
      if (b.key === "imported") return -1;
      return b.entries[0].createdAt - a.entries[0].createdAt;
    })
    .map((group) => {
      const newest = group.entries[0];
      const oldest = group.entries[group.entries.length - 1];
      let title;
      if (group.key === "imported") title = "Imported";
      else if (group.key === currentSessionId) title = "This session";
      else {
        title = previousSeen ? `Session · ${formatDay(oldest.createdAt)}` : "Previous session";
        previousSeen = true;
      }
      const subtitle =
        group.key === "imported" || group.key === currentSessionId
          ? null
          : `ended ${formatWhen(newest.updatedAt ?? newest.createdAt)}`;
      return { ...group, title, subtitle };
    });
}

// ------------------------------------------------------------------ favicons

const MONO_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#a855f7",
  "#64748b"
];

function monogram(url) {
  const domain = domainOf(url) || "?";
  let hash = 0;
  for (const ch of domain) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return h(
    "span",
    { class: "favicon monogram", style: `--mono:${MONO_COLORS[hash % MONO_COLORS.length]}` },
    domain[0].toUpperCase()
  );
}

export function favicon(url) {
  if (!isRestorableUrl(url) || url.startsWith("about:")) {
    return h("span", { class: "favicon internal" }, icon("window", 12));
  }
  const src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
  const img = h("img", { class: "favicon", src, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(monogram(url)), { once: true });
  return img;
}

export function faviconStack(preview = [], extra = 0) {
  return h(
    "span",
    { class: "favstack" },
    preview.slice(0, 3).map((tab) => favicon(tab.url)),
    extra > 0 ? h("span", { class: "favstack-more" }, `+${extra > 99 ? "99" : extra}`) : null
  );
}

// ------------------------------------------------------------------ feedback

export function toast(message, { tone = "info", action = null, timeout = 5000 } = {}) {
  let region = document.getElementById("toasts");
  if (!region) {
    region = h("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(region);
  }
  const close = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 160);
  };
  const el = h(
    "div",
    { class: `toast toast-${tone}` },
    icon(tone === "error" ? "alert" : "check", 16),
    h("span", { class: "toast-text" }, message),
    action
      ? h(
          "button",
          {
            class: "toast-action",
            type: "button",
            onclick: () => {
              action.run();
              close();
            }
          },
          action.label
        )
      : null,
    h(
      "button",
      { class: "toast-close icon-btn", type: "button", "aria-label": "Dismiss", onclick: close },
      icon("x", 14)
    )
  );
  region.append(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

export function reportError(error) {
  console.error(error);
  toast(error?.message || String(error), { tone: "error", timeout: 8000 });
}

/**
 * A button that asks for confirmation inline: the first click turns it into "Confirm?",
 * the second runs the action. Reverts after a few seconds or on blur.
 */
export function confirmButton({ label, confirmLabel, iconName, className = "btn btn-primary", onConfirm, title }) {
  let armed = false;
  let timer = null;
  const content = (text, ic) => [ic ? icon(ic, 15) : null, h("span", {}, text)];
  const button = h("button", { type: "button", class: className, title }, content(label, iconName));

  const disarm = () => {
    armed = false;
    clearTimeout(timer);
    button.classList.remove("armed");
    fill(button, content(label, iconName));
  };

  button.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      button.classList.add("armed");
      fill(button, content(typeof confirmLabel === "function" ? confirmLabel() : confirmLabel, "check"));
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    button.disabled = true;
    try {
      await onConfirm();
    } catch (error) {
      reportError(error);
    } finally {
      button.disabled = false;
    }
  });
  button.addEventListener("blur", () => setTimeout(() => armed && !button.matches(":focus") && disarm(), 150));
  return button;
}

/** Small popover menu anchored to a trigger button. items: [{label, icon, onSelect, danger}] */
export function menuButton(items, { label = "More actions", iconName = "more" } = {}) {
  const wrap = h("div", { class: "menu-wrap" });
  const trigger = h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      "aria-label": label,
      title: label,
      "aria-haspopup": "menu",
      "aria-expanded": "false"
    },
    icon(iconName, 16)
  );
  const menu = h("div", { class: "menu", role: "menu", hidden: true });
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
  };
  const outside = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  for (const item of items.filter(Boolean)) {
    menu.append(
      h(
        "button",
        {
          type: "button",
          role: "menuitem",
          class: `menu-item${item.danger ? " danger" : ""}`,
          onclick: async (event) => {
            event.stopPropagation();
            close();
            try {
              await item.onSelect();
            } catch (error) {
              reportError(error);
            }
          }
        },
        item.icon ? icon(item.icon, 15) : null,
        item.label
      )
    );
  }
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("click", outside, true);
      menu.querySelector("button")?.focus();
    } else {
      close();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const buttons = [...menu.querySelectorAll("button")];
    const i = buttons.indexOf(document.activeElement);
    if (event.key === "Escape") {
      close();
      trigger.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(i + 1) % buttons.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length].focus();
    }
  });
  wrap.append(trigger, menu);
  return wrap;
}

// ------------------------------------------------------------------ tab tree

const GROUP_COLORS = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e"
};

/**
 * Renders windows → tabs, optionally with checkboxes. Selection keys are "windowIndex:tabIndex",
 * matching what the restore engine expects.
 */
export function tabTree(
  windows,
  { selectable = false, filter = "", compact = false, selection = new Set(), onSelectionChange = () => {} } = {}
) {
  const root = h("div", { class: `tab-tree${compact ? " compact" : ""}` });
  const needle = filter.trim().toLowerCase();
  const allBoxes = [];

  windows.forEach((win, wi) => {
    const groups = new Map((win.groups || []).map((g) => [g.id, g]));
    const tabs = win.tabs
      .map((tab, ti) => ({ tab, ti }))
      .filter(
        ({ tab }) => !needle || tab.title?.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
      );
    if (tabs.length === 0) return;

    const winBoxes = [];
    const headerBox = selectable
      ? h("input", { type: "checkbox", class: "check", "aria-label": `Select all tabs in window ${wi + 1}` })
      : null;
    const stateNote = win.state && win.state !== "normal" ? ` · ${win.state}` : "";
    const header = h(
      "div",
      { class: "win-head" },
      headerBox,
      icon("window", 14),
      h("span", { class: "win-title" }, `Window ${wi + 1}`),
      h("span", { class: "win-meta" }, `${plural(win.tabs.length, "tab")}${stateNote}`)
    );
    const list = h("ul", { class: "tab-list" });

    for (const { tab, ti } of tabs) {
      const key = `${wi}:${ti}`;
      const restorable = isRestorableUrl(tab.url);
      const group = tab.groupId != null ? groups.get(tab.groupId) : null;
      const box = selectable
        ? h("input", {
            type: "checkbox",
            class: "check",
            disabled: !restorable,
            "aria-label": `Select ${tab.title || tab.url}`
          })
        : null;
      if (box && restorable) {
        box.checked = selection.has(key);
        winBoxes.push([box, key]);
        allBoxes.push([box, key]);
        box.addEventListener("change", () => {
          box.checked ? selection.add(key) : selection.delete(key);
          syncHeader();
          onSelectionChange(selection);
        });
      }
      const titleEl = restorable
        ? h(
            "a",
            { class: "tab-title", href: tab.url, target: "_blank", rel: "noreferrer", title: tab.url },
            tab.title || tab.url
          )
        : h(
            "span",
            { class: "tab-title muted", title: `${tab.url} — browser pages can't be restored` },
            tab.title || tab.url
          );
      list.append(
        h(
          "li",
          { class: `tab-row${restorable ? "" : " disabled"}` },
          box,
          favicon(tab.url),
          h(
            "div",
            { class: "tab-text" },
            titleEl,
            compact ? null : h("span", { class: "tab-domain" }, domainOf(tab.url))
          ),
          group
            ? h(
                "span",
                { class: "group-chip", style: `--group:${GROUP_COLORS[group.color] || GROUP_COLORS.grey}` },
                group.title || "Group"
              )
            : null,
          tab.pinned ? h("span", { class: "tab-flag", title: "Pinned" }, icon("pin", 13)) : null
        )
      );
    }

    function syncHeader() {
      if (!headerBox) return;
      const checked = winBoxes.filter(([b]) => b.checked).length;
      headerBox.checked = checked > 0 && checked === winBoxes.length;
      headerBox.indeterminate = checked > 0 && checked < winBoxes.length;
    }
    headerBox?.addEventListener("change", () => {
      for (const [b, key] of winBoxes) {
        b.checked = headerBox.checked;
        headerBox.checked ? selection.add(key) : selection.delete(key);
      }
      onSelectionChange(selection);
    });

    syncHeader();
    root.append(h("section", { class: "win" }, header, list));
  });

  if (!root.childElementCount) {
    root.append(
      h("p", { class: "empty-inline" }, needle ? "No tabs match this filter." : "This snapshot has no tabs.")
    );
  }

  return {
    el: root,
    selection,
    clear() {
      for (const [box] of allBoxes) box.checked = false;
      root.querySelectorAll(".win-head .check").forEach((b) => {
        b.checked = false;
        b.indeterminate = false;
      });
      selection.clear();
      onSelectionChange(selection);
    }
  };
}

// ------------------------------------------------------------------ files

export function downloadFile(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileStamp(t = Date.now()) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Status of the live session for the "Protected" pill. */
export function protectionState(live, meta) {
  if (meta?.health?.failing) {
    return { tone: "danger", title: "Backups are failing", detail: meta.health.lastError || "Unknown error" };
  }
  if (!live)
    return { tone: "warn", title: "Waiting for first save", detail: "Your tabs will be saved in a few seconds." };
  const staleAfter = (2 * (meta?.settings?.intervalMinutes ?? 5) + 1) * 60_000;
  const tone = Date.now() - live.updatedAt > staleAfter ? "warn" : "ok";
  return { tone, title: tone === "ok" ? "Protected" : "Last save was a while ago", detail: null };
}

export function liveCounts(live) {
  const windows = live?.windows || [];
  return { tabs: windows.reduce((n, w) => n + w.tabs.length, 0), windows: windows.length };
}

export function missingFromLive(snapshotWindows, live) {
  const open = new Set((live?.windows || []).flatMap((w) => w.tabs.map((t) => t.url)));
  let missing = 0;
  for (const win of snapshotWindows)
    for (const tab of win.tabs) if (isRestorableUrl(tab.url) && !open.has(tab.url)) missing += 1;
  return missing;
}

export function restoreSummary(result) {
  const parts = [`Restored ${plural(result.created, "tab")}`];
  if (result.windows) parts[0] += ` in ${plural(result.windows, "window")}`;
  const skipped = [];
  if (result.skippedOpen) skipped.push(`${result.skippedOpen} already open`);
  if (result.skippedInternal) skipped.push(`${result.skippedInternal} browser pages`);
  if (result.failed) skipped.push(`${result.failed} failed`);
  if (skipped.length) parts.push(`skipped ${skipped.join(", ")}`);
  return parts.join(" · ");
}
