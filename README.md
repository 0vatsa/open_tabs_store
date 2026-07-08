# Open Tabs Store

A lightweight browser extension that automatically backs up your open tab metadata to local browser storage and lets you restore your session after a crash.

## Features

- Auto-saves tab URLs, titles, window layout, pinned tabs, and active tab per window every minute
- Keeps a rolling 24-hour snapshot history in `chrome.storage.local`
- Manual **Backup now** snapshots are saved immediately and labeled separately from auto backups
- Restore any stored snapshot from the popup history list
- Works in Chromium browsers (Chrome, Brave) and Firefox-based browsers (Firefox, LibreWolf)

## Install

### Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder

### Brave

1. Open `brave://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder

### Firefox

1. Open `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` from this repository folder

### LibreWolf

1. Open `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` from this repository folder

Temporary add-ons in Firefox and LibreWolf expire when the browser restarts. Reload the extension from `about:debugging` after restarting.

## Usage

1. Keep the extension installed while you browse normally.
2. The extension auto-saves a snapshot every minute.
3. Click the extension icon to see:
   - current tab/window counts
   - last backup time
   - backed up tab/window counts
   - snapshot history with **Manual** and **Auto** labels
4. Use **Backup now** before risky changes if you want an immediate manual snapshot.
5. After a crash, pick the snapshot you want from the history list and click **Restore**.

Restore opens new windows and does not close your current tabs.

## What gets saved

Per tab:

- URL
- Title
- Pinned state
- Active state
- Tab index

Per window:

- Focused state
- Window state (`normal`, `maximized`, `minimized`)
- Ordered tab list

Per snapshot:

- Unique ID
- Save timestamp
- Source (`auto` or `manual`)
- Full session data

## Snapshot retention

- Auto snapshots are created every 1 minute.
- Snapshots are kept for 24 hours from their save time.
- Example: a snapshot saved at 13:14 on Aug 21 is removed at/after 13:14 on Aug 22.
- Manual snapshots follow the same 24-hour retention rule.

## Limitations

- Incognito tabs are not backed up unless you explicitly allow the extension in incognito mode.
- Internal browser URLs cannot be restored and are skipped, including:
  - Chromium: `chrome://`, `brave://`, `edge://`, `devtools://`, and `chrome-extension://`
  - Firefox/LibreWolf: `about:` (except `about:blank`), `moz-extension://`, `resource://`, and `jar:`
- Upgrading from v1 migrates the previous single `latestBackup` entry into the new snapshot history.
- Heavy browsing sessions may approach browser local storage limits over a full 24-hour window.

## Development

No build step is required. Edit the files and reload the extension:

- Chrome/Brave: click **Reload** on the extension card in `chrome://extensions` or `brave://extensions`
- Firefox/LibreWolf: reload from `about:debugging` (temporary add-ons must be reloaded after a browser restart)

Run validation checks with:

```bash
node scripts/validate-extension.js
```

## File overview

- `manifest.json` — extension configuration
- `background.js` — snapshot storage, auto-backup alarm, restore logic, and message handlers
- `popup.html`, `popup.js`, `popup.css` — popup UI
- `icons/` — extension icons
