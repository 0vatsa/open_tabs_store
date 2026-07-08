#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert(manifest.manifest_version === 3, "manifest_version must be 3");
assert(manifest.permissions.includes("tabs"), "tabs permission required");
assert(manifest.permissions.includes("storage"), "storage permission required");
assert(manifest.permissions.includes("alarms"), "alarms permission required");
assert(manifest.background?.service_worker === "background.js", "background service worker missing");
assert(
  manifest.background?.scripts?.includes("background.js"),
  "background scripts must include background.js for Firefox"
);
assert(
  manifest.browser_specific_settings?.gecko?.id,
  "browser_specific_settings.gecko.id required for Firefox"
);

for (const icon of ["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]) {
  assert(fs.existsSync(path.join(root, icon)), `Missing icon: ${icon}`);
}

const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
assert(background.includes('STORAGE_KEY = "snapshots"'), "background must use snapshots storage key");
assert(background.includes("captureSession"), "captureSession missing");
assert(background.includes("restoreSession"), "restoreSession missing");
assert(background.includes("addSnapshot"), "addSnapshot missing");
assert(background.includes("pruneExpiredSnapshots"), "pruneExpiredSnapshots missing");
assert(background.includes('periodInMinutes: 1'), "auto backup alarm must run every minute");
assert(background.includes("BACKUP_NOW"), "BACKUP_NOW handler missing");
assert(background.includes("GET_STATUS"), "GET_STATUS handler missing");
assert(background.includes("GET_SNAPSHOTS"), "GET_SNAPSHOTS handler missing");
assert(background.includes("RESTORE"), "RESTORE handler missing");
assert(!background.includes("scheduleSave"), "event-driven scheduleSave should be removed");

const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
assert(popupHtml.includes('id="backup-now"'), "backup button missing");
assert(popupHtml.includes('id="snapshot-list"'), "snapshot list missing");

const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
assert(popupJs.includes("window.confirm"), "restore confirmation missing");
assert(popupJs.includes("GET_SNAPSHOTS"), "popup must request snapshot list");
assert(popupJs.includes("snapshotId"), "popup must send snapshotId on restore");

function isRestorableUrl(url) {
  if (!url) return false;
  const blocked = [
    "chrome://",
    "chrome-extension://",
    "devtools://",
    "brave://",
    "edge://",
    "moz-extension://",
    "resource://",
    "jar:"
  ];
  if (blocked.some((prefix) => url.startsWith(prefix))) {
    return false;
  }
  if (url.startsWith("about:")) {
    return url === "about:blank" || url.startsWith("about:blank#");
  }
  return true;
}

const sampleBackup = {
  windows: [
    {
      focused: true,
      state: "normal",
      tabs: [
        { url: "https://example.com", pinned: true, active: true },
        { url: "chrome://settings", pinned: false, active: false },
        { url: "about:preferences", pinned: false, active: false },
        { url: "about:blank", pinned: false, active: false }
      ]
    }
  ]
};

let restorable = 0;
let skipped = 0;
for (const win of sampleBackup.windows) {
  for (const tab of win.tabs) {
    if (isRestorableUrl(tab.url)) restorable += 1;
    else skipped += 1;
  }
}

assert(restorable === 2, "expected two restorable tabs in sample backup");
assert(skipped === 2, "expected two skipped tabs in sample backup");

console.log("Extension validation checks passed.");
