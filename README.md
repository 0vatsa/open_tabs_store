# Open Tabs Store

A Chrome / Brave extension that continuously backs up your open tabs and windows to local storage, so you can bring
them back after a crash, even if the browser stays closed for days.

## What it does

- **Saves continuously.** Every tab change is written to a "live session" within a few seconds. A checkpoint is added
  to the history on an interval (default 5 minutes), but only when something actually changed.
- **Survives crashes.** When the browser starts, the last state of the previous session is frozen as a protected
  **Previous session** snapshot. The popup offers to restore it with one click.
- **Never expires while closed.** History is kept by browser-open time, not wall-clock time, so a crash before a
  long weekend loses nothing.
- **Restores properly.** Window order, pinned tabs, the active tab, tab groups (name, colour, collapsed), window
  size and state all come back. Tabs load only when clicked, and tabs that are already open are skipped.
- **Lets you pick.** Preview any snapshot, restore only selected tabs, or add them to the current window.
- **Full-page manager.** A timeline of every snapshot grouped by browser session, search across all of history,
  "+7 / −3 since last checkpoint" diffs, naming and starring snapshots, and export/import.
- **Reports failures.** If saving ever fails, the popup shows a red banner and the toolbar icon gets a `!` badge.
- **Local only.** Nothing leaves your machine. Export to JSON (re-importable), HTML or Markdown at any time.

## Install

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

Pin the extension so its icon is always visible.

## Using it

- **After a crash:** click the extension icon, then **Restore session** → confirm.
- **Browse history:** click any snapshot in the popup to preview its tabs; tick tabs to restore just those.
- **Full view:** the ↗ icon in the popup (or right-click the icon → *Options*) opens the manager. Press `/` to
  search; use ↑/↓ to move through the timeline.
- **Keep something forever:** star a snapshot, or use **Save now** (manual snapshots are never pruned).
- **Back up off-browser:** Manager → settings (⚙) → **Export all (JSON)**. Import the same file later.

### Retention

| What | Kept |
|---|---|
| Checkpoints from the last 2 h of browsing | all |
| … up to 24 h of browsing | one per 30 min |
| … up to 7 days of browsing | one per hour |
| End-of-session snapshots | last 10 browser sessions |
| Manual, starred, imported | until you delete them |

Total history is soft-capped at 25 MB. The oldest automatic checkpoints are dropped first.

### Limitations

- Browser pages (`chrome://`, `brave://`, extension pages) can't be reopened by extensions and are skipped on restore.
- Incognito windows are never saved.

## Development

No build step. The extension runs straight from `src/` as native ES modules.

```bash
npm test                      # unit tests (node --test, in-memory fake of the chrome.* APIs)
npm run validate              # manifest / file-reference / import checks
node tests/e2e/smoke.mjs out/ # real-Chromium crash→restore run via Playwright, screenshots into out/
```

After editing, click **Reload** on the extension card in `chrome://extensions`.

### Layout

```
manifest.json
src/background/   service worker: capture, checkpoints, retention, restore engine
src/shared/       storage layer, snapshot schema/hashing, URL rules, export formats
src/ui/           popup, full-page manager, shared components and design tokens
tests/            unit tests + e2e smoke test
docs/SPEC.md      design spec and audit of v1
```

### Storage layout (`chrome.storage.local`)

| Key | Contents |
|---|---|
| `meta` | settings, health, browser-open-time clock |
| `live` | current session, rewritten a few seconds after each tab change |
| `index` | small summaries of every checkpoint (newest first) |
| `snap:<id>` | full windows/tabs of one checkpoint |
| `restoreStatus` | progress of the last restore |

The current browser-session id lives in `chrome.storage.session`. That storage is cleared when the browser restarts,
which is how a new session is detected.
