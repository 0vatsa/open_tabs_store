# Open Tabs Store v2 — Revamp Spec

Status: **Implemented in 2.0.0** (see §10 for decisions and deviations) · Supersedes: v1.2.0

This document covers three things:

1. **Audit:** what is wrong with v1.2.0 today, including the root cause of the "not found" error when restoring after a crash.
2. **Reliability redesign:** the storage, capture, retention and restore changes that make crash recovery dependable.
3. **UI revamp:** a new popup, a full-page manager, and a visual system.

Nothing here is implemented yet. Section 9 lists the open questions that need an answer before implementation starts.

---

## 1. How v1.2.0 works (summary)

| Piece | Behavior |
|---|---|
| `background.js` | A `chrome.alarms` alarm fires every N minutes (default 5). Each time it captures **all** normal windows and tabs and appends a full snapshot to one array stored under the single key `snapshots` in `chrome.storage.local`. |
| Retention | Every read and write prunes snapshots whose `savedAt` is older than 24 h (by wall clock). |
| Restore | `RESTORE {snapshotId}` → looks up the ID (after pruning) → `windows.create({url: [...]})` per saved window → re-pins tabs and re-activates the active tab by matching URLs. |
| Popup | Status table, snapshot list with a "Restore" button per row (`window.confirm` dialog), an interval input, and a "Backup now" button. |
| Tests | `scripts/validate-extension.js` checks that certain strings appear in the source, plus a few copied helper functions. It never runs the real code. |

---

## 2. Audit: bugs and risks

Severity: **P0** = loses user data / blocks crash recovery · **P1** = broken behavior · **P2** = quality / edge case.

### 2.1 The "Snapshot not found or expired" bug: root causes

The error string is in `background.js` (`RESTORE` handler). It appears when the snapshot ID the popup sent is no longer in storage. Several defects lead there, and they compound after a crash:

#### P0-1. Wall-clock retention deletes everything while the browser is closed
`pruneExpiredSnapshots` removes anything older than 24 h by `Date.now()`. If the browser crashes in the evening and you reopen it the next morning, or the machine is off for a day, **the first read after startup deletes every pre-crash snapshot**. The popup either shows nothing or shows rows that disappear before you click Restore. Retention counts time that passed while the browser was closed, which is exactly the time you need the backups.

#### P0-2. Post-crash auto-backups bury the pre-crash session
On startup Chrome fires any overdue alarm immediately, so the extension saves a snapshot of the **fresh, almost-empty post-crash session** (one new tab, or whatever the browser half-restored). It then adds another every 5 minutes. The newest entries, at the top of the list, are now the wrong ones. Nothing marks which snapshot was the "last state before the crash", and the useful ones keep moving toward the 24 h cutoff.

#### P0-3. Storage quota is silently exceeded, so backups stop
`chrome.storage.local` is capped at **10 MB** without the `unlimitedStorage` permission. v1 stores a full copy of every tab in every snapshot:

- 150 tabs × ~250 bytes (URL + title + flags) ≈ 37 KB per snapshot
- every 5 min × 24 h = 288 snapshots ≈ **10.8 MB**, over quota
- at a 1-minute interval: 1,440 snapshots ≈ 54 MB

When the quota is hit, `storage.local.set` rejects, and the only handling is `console.error` in the service worker, which nobody sees. **No new backups are written from then on.** The existing ones age out after 24 h until none are left. The popup still says "Auto snapshots every 5 minutes".

The whole array is also rewritten on every save (a multi-MB read-modify-write every few minutes), which is slow and makes the next item worse.

#### P1-4. Read-modify-write races
`addSnapshot` does `load → push → set` without a lock. A manual "Backup now" that overlaps an alarm, or two quick alarms after wake, can each read the same array, and the last write wins. Snapshots get lost. When combined with pruning in another call, the list the popup shows can differ from what is in storage.

#### P1-5. Stale popup list
The popup renders snapshot IDs once, then re-renders only on `storage.onChanged`. Pruning that happens inside `loadSnapshots` during the click can remove the row the user is about to restore. The user gets "not found" with no explanation.

#### P1-6. Up to N minutes of tabs are never captured
Capture is alarm-only. Anything opened since the last tick (up to 5 min, or longer if the alarm was throttled or the service worker was asleep) is lost. v1 removed event-driven saving (the validator even asserts `scheduleSave` is gone). That was reasonable for the old storage design, which rewrote everything on every save, but it costs recovery fidelity.

#### P1-7. Firefox/LibreWolf: temporary add-on
The README tells Firefox users to load the extension as a **temporary add-on**, which is uninstalled when the browser restarts, and a crash is a restart. After a crash the extension is not running. Depending on Firefox's storage-on-uninstall behavior, its data may also be gone. On Firefox it cannot do its one job as distributed today. A signed build (AMO listing or self-distributed signed XPI) is required.

### 2.2 Restore correctness

| ID | Sev | Issue |
|---|---|---|
| R-1 | P1 | **`window.confirm()` in the popup.** It is unreliable in Firefox extension popups (see Mozilla bug 1375490), so restore may never be confirmed there. Replace with in-UI confirmation. |
| R-2 | P1 | **`windows.create` errors on invalid state combinations.** Chrome rejects `focused: true` with `state: "minimized"`. A failure part-way through leaves a half-restored session and a generic error. Normalize the state and restore minimized windows unfocused, then minimize them. |
| R-3 | P1 | **Pinned and active tabs are matched by URL.** Right after `windows.create`, tabs are still loading: `tab.url` may be empty or `pendingUrl`, redirects change URLs, and duplicate URLs collapse in the `Map`. Pinning and activation silently fail. Restore must create tabs explicitly, one at a time, and keep the returned IDs. |
| R-4 | P1 | **All tabs load at once.** Restoring 200 tabs fires 200 page loads, which can hang or crash the browser again. Lazy-load: Firefox supports `tabs.create({discarded: true})`. On Chrome, create then `tabs.discard()` everything except the active tab of each window. |
| R-5 | P2 | **Duplicates.** If the browser's own session restore already reopened some tabs, v1 opens them again. Offer "skip tabs that are already open". |
| R-6 | P2 | Window size/position and Chrome **tab groups** (title, color, collapsed) are not saved or restored. |
| R-7 | P2 | **Incognito leak.** If the extension is allowed in incognito, `windows.getAll` includes private windows. They are stored on disk and restored as *normal* windows. Exclude incognito by default. |
| R-8 | P2 | `tabCount` includes non-restorable tabs, so the counts in the list and the confirm dialog disagree. |
| R-9 | P2 | The popup closes when restore focuses a new window, so the success/failure message is never seen. |

### 2.3 Other issues

| ID | Sev | Issue |
|---|---|---|
| O-1 | P1 | **Failures are invisible.** Backup errors exist only in the service-worker console. The UI has no "health" state. |
| O-2 | P1 | **No export or import.** All recovery depends on `storage.local` surviving. A profile reset or uninstall loses everything. |
| O-3 | P2 | The interval input has no upper bound (e.g. `999999`) and is applied on every `change` with no validation feedback. |
| O-4 | P2 | Identical snapshots are stored again every tick when nothing changed, which wastes space and clutters the list. |
| O-5 | P2 | `ensureAutoBackupScheduled()` runs at top level on every service-worker wake. It is harmless but noisy. There is no `runtime.onStartup` handling, which v2 needs (see §3.4). |
| O-6 | P2 | The validator checks for string presence, not behavior. There are no real tests for capture, prune, migration or restore. |
| O-7 | P2 | The icons are 110–400-byte placeholder PNGs. |
| O-8 | P2 | The popup uses the deprecated `unload` event. |

---

## 3. Reliability redesign

### 3.1 Goals
- **G1:** After any crash, the last state before the crash can be restored, **no matter how long the browser stayed closed**.
- **G2:** At most ~10 seconds of tab changes are lost.
- **G3:** Storage stays bounded and well under quota. Running out of space is detected and shown in the UI, never silent.
- **G4:** Restore is correct (order, pins, active tab, groups) and safe for large sessions (lazy loading).
- **G5:** Behavior matches across Chrome, Brave, Edge, Firefox and LibreWolf.

### 3.2 Capture model: event-driven "live session" plus checkpoints

**Live session (crash buffer)**
- Listen to `tabs.onCreated/onRemoved/onUpdated(url|title|pinned)/onMoved/onAttached/onDetached/onActivated`, `windows.onCreated/onRemoved`, and on Chrome `tabGroups.onUpdated`.
- Debounce for **3 s** (max wait 10 s), then write the current state to the key `live`. It is overwritten in place, so its size stays the same.
- `live` carries a `sessionId` (a UUID generated in `runtime.onStartup` / first run) and `updatedAt`.
- Ignore `onUpdated` events with only `status`/`favIconUrl`/`audible` changes to avoid write storms.

**Checkpoints (history)**
- An alarm fires every N minutes (default 5, range 1–120). It promotes `live` to a checkpoint **only if its content hash differs** from the latest checkpoint (fixes O-4). Otherwise it only updates `lastConfirmedAt` on the latest checkpoint.
- "Save now" creates a checkpoint flagged `manual` and lets the user name it (optional label).

**Session-end checkpoint** (the key fix for P0-2)
- In `runtime.onStartup` (the browser started, which means the previous session ended, cleanly or by crash):
  1. If a `live` record exists whose `sessionId` ≠ the new session ID, freeze it into a checkpoint with `kind: "session-end"` and `crashed: <bool>`.
  2. Detecting a crash: the extension keeps `cleanShutdown: false` while running. Browsers give extensions no reliable shutdown event, so in practice this flag will usually read "unknown". The UI therefore treats every session-end checkpoint as "Previous session" and does not depend on crash detection.
  3. Wait ~15 s, so the browser's own session restore can finish, before the new session's first checkpoint.
- Session-end checkpoints are **protected** from routine pruning (§3.4).

### 3.3 Storage layout

Move from one big array to per-record keys. Add the `unlimitedStorage` permission. It is a normal permission with no extra warning on Chrome and no warning on Firefox.

```
meta            { schemaVersion: 2, settings: {...}, health: {...} }
live            { sessionId, updatedAt, windows: [...] }
index           [ { id, kind, createdAt, lastConfirmedAt, sessionId, label,
                    tabCount, windowCount, hash, bytes, pinned } ]   // small, newest first
snap:<id>       { id, windows: [...] }                               // one key per checkpoint
```

- Each write touches **one** `snap:*` key plus the small `index`, never the whole history (fixes P0-3 write cost).
- All mutations go through a **single in-worker async queue** (a promise-chain mutex) so writes never interleave (fixes P1-4). Popup actions are messages handled by that same queue.
- Snapshot schema (per tab): `url, title, pinned, active, index, groupId?, discarded?, lastAccessed?`. Per window: `state, focused, left, top, width, height, incognito, groups: [{id, title, color, collapsed}]`.
- Favicons are **not** stored, to save space. The UI derives them at render time (§5.6).

### 3.4 Retention policy (replaces wall-clock 24 h)

Retention uses counts and browser sessions, and never counts time while the browser was closed (fixes P0-1):

| Bucket | Rule |
|---|---|
| Session-end checkpoints | Keep the last **10 browser sessions**, regardless of age. |
| Manual / pinned (starred) checkpoints | Kept until the user deletes them. |
| Auto checkpoints, current session | Keep all from the last 2 h, then thin to 1 per 30 min. |
| Auto checkpoints, previous sessions | Thin to 1 per hour, drop after 7 days of **browser-open time** (or the soft cap below). |
| Global soft cap | 25 MB total (tracked via `index[].bytes`). Drop the oldest unprotected auto checkpoints first. |

Pruning runs only inside the write queue, **never on read**, so the list the popup shows stays valid while the user is clicking (fixes P1-5). If the ID the user clicked really is gone, the error says why ("This snapshot was removed by retention at 14:02") instead of "not found".

### 3.5 Health and error surfacing
- `meta.health = { lastSuccessAt, lastErrorAt, lastError, bytesUsed, quotaBytes }`.
- Every capture or restore failure is recorded there. The popup shows a red "Backups failing" banner with the reason and a "Retry" button.
- The toolbar badge shows a small `!` on errors (optional, see open question Q4).

### 3.6 Restore engine (rewrite)
For each saved window:
1. Normalize `state`: never pass `focused: true` with `minimized`; never pass bounds with `maximized`/`fullscreen`.
2. `windows.create({ url: firstTab.url, focused: false, ...bounds })`.
3. For the remaining tabs, `tabs.create({ windowId, url, index, pinned, active: false })`. On Firefox pass `discarded: true, title`. On Chrome, call `tabs.discard(id)` after creation for any tab that isn't active (lazy load is a setting, default **on**).
4. Recreate Chrome tab groups (`tabs.group` + `tabGroups.update`).
5. Activate the saved active tab by its **created tab ID** (fixes R-3), then apply the final window state, and focus the window that was focused.
6. Per-tab failures (blocked URL, policy) are collected rather than aborting the whole restore.

Restore modes:
- **Restore all** (new windows; default)
- **Restore into current window** (append)
- **Restore selected tabs/windows** (from the preview)
- Option: **Skip tabs already open** (default on, fixes R-5)

Restore runs in the background worker. Progress and results are stored in `meta.lastRestore` so that the popup or manager page can show them even after the popup was closed (fixes R-9).

### 3.7 Export / import (fixes O-2)
- Export any checkpoint, or all of history, as **JSON** (lossless, re-importable), **HTML** (a clickable list of links, readable without the extension), or **plain URL list** (Markdown/text).
- Import JSON. It is validated against the schema and added as `kind: "imported"` checkpoints.
- Optional "auto-export a daily file to Downloads" (needs the `downloads` permission, so off by default; see Q3).

### 3.8 Migration from v1
On `runtime.onInstalled({reason: "update"})`:
1. Read the v1 `snapshots` array (and the legacy `latestBackup`). **Do not prune by age during migration.**
2. Write each item as a `snap:<id>` key + `index` entry with `kind: "auto" | "manual"`.
3. Mark the newest migrated snapshot as `session-end` so it is protected and shown first.
4. Remove the old keys only after the new keys have been written and verified.

### 3.9 Cross-browser
- **Firefox/LibreWolf:** ship a signed XPI (AMO, unlisted or listed). Update the README to stop recommending temporary add-ons for real use.
- Feature-detect `tabGroups`, `tabs.discard`, and `discarded` in `tabs.create`. Skip features that are missing instead of failing.
- Use the `browser.*` namespace where available (`globalThis.browser ?? globalThis.chrome`).

---

## 4. Architecture and code layout

Still **no build step required**. Use native ES modules (`"type": "module"` for the background service worker; Firefox MV3 event pages support module scripts via `background.scripts` + `"type": "module"`).

```
manifest.json
src/
  background/
    index.js          // listeners, wiring
    capture.js        // live session + debounce
    store.js          // keyed storage, write queue, index
    retention.js      // pure pruning logic
    restore.js        // restore engine
    migrate.js        // v1 -> v2
    messages.js       // typed message router
  shared/
    schema.js         // types/validators, constants
    urls.js           // isRestorableUrl etc.
    format.js         // relative time, pluralization
    browser.js        // api shim + feature detection
  ui/
    tokens.css        // design tokens (light/dark)
    components.css
    popup.html / popup.js
    manager.html / manager.js   // full-page view
    icons.svg         // inline SVG sprite
icons/                // new PNG icon set (16/32/48/128) + source SVG
tests/
  *.test.js           // node --test with an in-memory chrome.* fake
docs/SPEC.md
```

Testing:
- `node --test` with a small fake of `chrome.storage/tabs/windows/alarms/runtime`. No dependencies required.
- Required tests: retention rules (including "browser closed 3 days" → session-end kept), write-queue concurrency, migration from v1 fixtures, dedupe hashing, restore ordering/pinning/active/minimized normalization, and import validation.
- Keep `scripts/validate-extension.js` only for manifest/icon checks. Remove its string-presence assertions.
- Optional (Q5): a Playwright smoke test loading the unpacked extension in the pre-installed Chromium.

---

## 5. UI revamp

### 5.1 What makes v1 feel amateur
- Six-row key/value status table: it reports data instead of answering "am I safe?" and "how do I get my tabs back?".
- Absolute `toLocaleString()` timestamps ("10/7/2026, 2:14:03 PM") on every row.
- A flat list of near-identical "AUTO · 42 tabs · 2 windows" rows with no way to see *which* tabs are inside.
- Mixed button colors (blue primary, near-black "secondary"), a native `confirm()` dialog, settings inline in the main view.
- No dark mode, no icons, placeholder app icon, cramped 320 px width.

### 5.2 Design principles
1. **Answer the anxious question first:** "Am I protected?" and "Get my tabs back".
2. **Show content, not counts:** favicons, titles, and domains make snapshots recognizable.
3. **Calm by default, loud when it matters:** neutral palette with a single accent. Color is used for status only.
4. **Progressive detail:** popup for the 90% case, full-page manager for browsing and search.

### 5.3 Visual system
- **Tokens** (`tokens.css`) defined on `:root` with a dark-mode override via `prefers-color-scheme`:
  - Neutrals: a 9-step slate scale for bg / surface / border / text-muted / text.
  - One accent (indigo-600 / indigo-400 dark) for primary actions.
  - Status: green (protected), amber (stale > 2× interval), red (failing).
- **Type:** system UI stack. 13 px base, 15 px titles, 12 px meta. `font-variant-numeric: tabular-nums` for times and counts.
- **Spacing:** 4 px grid. Radius 10 px (cards) / 8 px (controls). One subtle shadow level.
- **Icons:** inline SVG (Lucide-style, MIT): shield-check, history, rotate-ccw, star, download, search, settings, chevron.
- **Motion:** 120–160 ms ease-out on expand/collapse and toasts. Respect `prefers-reduced-motion`.
- **New app icon:** a stack of tab shapes with a restore arrow, at 16/32/48/128. The SVG source is committed.

### 5.4 Popup (380 × ≤ 560 px)

```
┌──────────────────────────────────────────┐
│ ◧ Open Tabs Store                    ⚙  │
├──────────────────────────────────────────┤
│ ● Protected · saved 12s ago              │  ← status pill (green/amber/red)
│   38 tabs in 3 windows                   │
│                                          │
│ ┌──────────────────────────────────────┐ │  ← shown only when a previous
│ │ ⟲ Previous session                   │ │    session exists and isn't
│ │ Ended yesterday 23:41 · 112 tabs · 4w│ │    already restored
│ │ [ Restore session ]   Preview ›      │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ History                  🔍  Save now ＋ │
│ ── Today ─────────────────────────────── │
│ 14:05  ⓖⓨⓦ+35   38 tabs · 3 win     ⋯   │  ← favicon stack + overflow menu
│ 13:40  ⓖⓨ+20    24 tabs · 2 win  ★  ⋯   │
│ ── Yesterday · previous session ──────── │
│ 23:41  ⓖⓜⓢ+109 112 tabs · 4 win ⚑   ⋯   │
│ …                                        │
├──────────────────────────────────────────┤
│ Open manager ↗                           │
└──────────────────────────────────────────┘
```

Behavior:
- **Status pill:** green "Protected · saved Xs ago". Amber "Last save 18 min ago" (stale). Red "Backups failing: storage full" with **Fix** (opens the manager's storage panel).
- **Previous-session card:** the single most important CTA after a crash. One click restores using defaults (lazy load, skip already open). "Preview" expands it inline.
- **History rows:** relative time ("14:05", "Yesterday 23:41"), a stack of 3 favicons, counts, and badges (★ starred, ✎ manual label, ⚑ session end). Clicking a row expands a **preview**: windows as collapsible groups, tabs with favicon + title + domain, checkboxes for partial restore, and buttons **Restore**, **Restore selected**, **Open in manager**.
- **Overflow menu (⋯):** Restore into this window · Star · Rename · Export · Delete.
- **Confirm inline**, not `window.confirm`: the Restore button turns into "Open 112 tabs in 4 windows? [Confirm] [Cancel]" (fixes R-1).
- **Toasts** at the bottom for results ("Restored 110 tabs · 2 skipped (internal pages)") with **Undo** for delete.
- **Settings (⚙):** a slide-over panel with the backup interval (select: 1, 2, 5, 10, 15, 30, 60 min), lazy-load restored tabs, skip already open tabs, include pinned-only windows, storage usage bar, export/import, and the history retention summary.
- **Empty state:** an illustration + "Your tabs are being watched. The first snapshot will appear in a few seconds."
- **Keyboard:** full tab order, `/` focuses search, ↑/↓ moves through rows, Enter expands, visible focus rings. ARIA: list/listitem, `aria-expanded`, a live region for toasts.

### 5.5 Manager page (`manager.html`, opens in a tab)
- Two-pane layout: a **timeline** on the left (grouped by browser session → day → checkpoint), and the **snapshot detail** on the right (windows → tabs, select, restore, export).
- **Global search** across all checkpoints by title/URL ("which snapshot had that article?") with per-result "Open tab" and "Restore snapshot".
- **Diff view:** "+7 / −3 tabs vs previous checkpoint", to find the one before you closed something by accident.
- **Storage panel:** usage bar, per-bucket counts, "Free up space", export/import.
- Restore progress and results, which stay visible even if the popup closed (fixes R-9).

### 5.6 Favicons
- Chrome/Edge/Brave: `chrome-extension://<id>/_favicon/?pageUrl=<url>&size=32` (needs the `favicon` permission, no user warning).
- Firefox: no equivalent. Use a cached `favIconUrl` from the live tab when the same origin is currently open; otherwise a **monogram** (first letter of the domain on a color derived from the hash).

---

## 6. Permissions (v2)

| Permission | Why | New? |
|---|---|---|
| `tabs` | read URLs/titles | existing |
| `storage` | persistence | existing |
| `alarms` | checkpoints | existing |
| `unlimitedStorage` | avoid the 10 MB quota cliff (P0-3) | **new** |
| `favicon` (Chromium only) | favicons in UI | **new** |
| `tabGroups` (Chromium only) | save and restore groups | **new** |
| `downloads` (optional permission) | export files / daily auto-export | **new, optional** |

None of these add an install-time warning beyond what `tabs` already shows ("Read your browsing history").

---

## 7. Rollout plan (suggested PR breakdown)

1. **PR 1: Reliability core.** Keyed store + write queue, live session capture, session-end checkpoints, new retention, health surfacing, v1 migration, tests. *(Fixes P0-1/2/3, P1-4/5/6, O-1/4.)* The existing UI is minimally adapted so it keeps working.
2. **PR 2: Restore engine.** Explicit tab creation, state normalization, lazy load, groups, skip-duplicates, background progress. *(R-1…R-9.)*
3. **PR 3: UI revamp, popup.** Tokens, components, new popup, inline confirm, settings panel, new icons.
4. **PR 4: Manager page + export/import.** Search, diff, storage panel.
5. **PR 5: Packaging.** Signed Firefox build, README rewrite, version 2.0.0.

PR 1 alone fixes the crash-restore failure, so it can ship first.

---

## 8. Acceptance criteria

- [ ] Open 50 tabs in 3 windows, kill the browser process, keep it closed for > 24 h (simulated with a fake clock in tests), restart → popup shows a **Previous session** card with all 50 tabs, and restoring it recreates 3 windows with the correct order, pins, and active tabs.
- [ ] Opening a tab and killing the browser 10 s later → that tab is in the previous-session checkpoint.
- [ ] 300 tabs at a 1-min interval for 8 simulated hours → storage < 25 MB, no write failures, and unchanged state produces no new checkpoints.
- [ ] Forcing a storage failure (fake) → the popup shows a red health banner within one refresh.
- [ ] Concurrent "Save now" + alarm → both checkpoints present, index consistent.
- [ ] Restoring 200 tabs with lazy load on → only one tab per window loads.
- [ ] Restore and confirmation work in Firefox (no `window.confirm`).
- [ ] Upgrading from v1.2.0 with existing data → all v1 snapshots are visible, none pruned, and the newest is marked as previous session.
- [ ] Popup passes keyboard-only navigation and the axe-core basic checks; renders correctly in light and dark mode.
- [ ] `node --test` passes; `node scripts/validate-extension.js` passes.

---

## 9. Open questions (need your input)

1. **Q1: Target browsers.** Which do you actually use day to day? If it's Chromium-only, Firefox signing (PR 5) can wait.
2. **Q2: Retention defaults.** Are "last 10 browser sessions + 7 days of thinned auto checkpoints + manual kept forever" right for you?
3. **Q3: Daily auto-export to Downloads.** Do you want an off-profile safety copy (needs the optional `downloads` permission)?
4. **Q4: Toolbar badge.** Show `!` on backup failure only, or also the tab count?
5. **Q5: Browser smoke test.** Should CI run an end-to-end Playwright test (Chromium) in addition to unit tests? It needs a GitHub Actions workflow, which the repo doesn't have yet.
6. **Q6: Visual direction.** The spec proposes a neutral slate UI with an indigo accent. Do you have a brand color or a reference extension whose look you like (e.g. OneTab, Session Buddy, Arc)?
7. **Q7: Scope of manager page.** Is the full-page manager (search, diff) in scope for v2.0, or should v2.0 ship the popup only?

---

## 10. Decisions and implementation notes (2.0.0)

Answers to §9:

| Question | Decision |
|---|---|
| Q1 Target browsers | **Chrome and Brave only.** Firefox/LibreWolf support removed, so §3.9 and PR 5 are dropped. |
| Q2 Retention / compatibility | Full revamp, **no v1 data migration** (§3.8 dropped). Retention as proposed in §3.4. |
| Q3 Daily auto-export | No. Export is manual only, with no `downloads` permission. |
| Q4 Toolbar badge | Red `!` only while backups are failing. No tab count. |
| Q5/Q7 Scope | Full-page manager included. |
| Q6 Visual direction | Neutral slate with an indigo accent, light and dark. |

Where the build differs from the draft:

- **New-session detection** uses `chrome.storage.session`, which the browser clears on restart, instead of
  `runtime.onStartup`. It works no matter which event wakes the worker first and is idempotent if the worker is
  killed mid-way. Reloading or updating the extension also counts as a new session. That is harmless: the popup only
  offers "Restore previous session" when some of its tabs are *not* currently open.
- **Shutdown guard:** `tabs.onRemoved` with `isWindowClosing` doesn't update the live session, so closing the browser
  doesn't shrink the snapshot right before it is frozen. An empty capture never overwrites a non-empty live session.
- **Browser-open time** advances only on checkpoint ticks, by at most 2× the interval per tick. Sleep and closed time
  are not counted.
- **Lazy restore** creates each tab, waits for its URL to commit, then calls `tabs.discard`. Verified in plain
  Chromium. Note: `tabs.discard` segfaults Chromium while a DevTools/CDP client is attached to the tab, so the
  Playwright e2e test turns lazy restore off. Unit tests cover the lazy path.
- **Restore progress** lives in the `restoreStatus` storage key, so the popup and manager both show it, and it
  survives the popup closing.
- **Testing:** `npm test` (32 unit tests against an in-memory chrome.* fake), `npm run validate`, and
  `tests/e2e/smoke.mjs` (real Chromium: open tabs → shut down → relaunch → popup offers previous session → restore
  → manager search).
