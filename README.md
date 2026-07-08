# Open Tabs Store

A lightweight Chrome/Brave extension that automatically backs up your open tab metadata to local browser storage and lets you restore your session after a crash.

## Features

- Auto-saves tab URLs, titles, window layout, pinned tabs, and active tab per window
- Stores the latest backup in `chrome.storage.local`
- Manual **Backup now** and **Restore all tabs** actions from the popup
- Works in Chromium browsers including Chrome and Brave

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

## Usage

1. Keep the extension installed while you browse normally.
2. The extension auto-backs up your tabs whenever they change, and also every 5 minutes.
3. Click the extension icon to see:
   - current tab/window counts
   - last backup time
   - backed up tab/window counts
4. Use **Backup now** before risky changes if you want an immediate snapshot.
5. After a crash, click **Restore all tabs** to reopen the last saved session in new windows.

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

## Limitations

- Incognito tabs are not backed up unless you explicitly allow the extension in incognito mode.
- Internal browser URLs such as `chrome://`, `brave://`, `edge://`, `devtools://`, and `chrome-extension://` cannot be restored and are skipped.
- Only the latest backup is kept in v1.

## Development

No build step is required. Edit the files and click **Reload** on the extension card in `chrome://extensions` or `brave://extensions`.

## File overview

- `manifest.json` — extension configuration
- `background.js` — auto-backup, restore logic, and message handlers
- `popup.html`, `popup.js`, `popup.css` — popup UI
- `icons/` — extension icons
