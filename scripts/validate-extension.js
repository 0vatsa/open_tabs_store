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

for (const icon of ["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]) {
  assert(fs.existsSync(path.join(root, icon)), `Missing icon: ${icon}`);
}

const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
assert(background.includes("latestBackup"), "background must use latestBackup storage key");
assert(background.includes("captureSession"), "captureSession missing");
assert(background.includes("restoreSession"), "restoreSession missing");
assert(background.includes("BACKUP_NOW"), "BACKUP_NOW handler missing");
assert(background.includes("GET_STATUS"), "GET_STATUS handler missing");
assert(background.includes("RESTORE"), "RESTORE handler missing");

const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
assert(popupHtml.includes('id="backup-now"'), "backup button missing");
assert(popupHtml.includes('id="restore-tabs"'), "restore button missing");

const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
assert(popupJs.includes("window.confirm"), "restore confirmation missing");

function isRestorableUrl(url) {
  if (!url) return false;
  const blocked = ["chrome://", "chrome-extension://", "devtools://", "brave://", "edge://"];
  return !blocked.some((prefix) => url.startsWith(prefix));
}

const sampleBackup = {
  windows: [
    {
      focused: true,
      state: "normal",
      tabs: [
        { url: "https://example.com", pinned: true, active: true },
        { url: "chrome://settings", pinned: false, active: false }
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

assert(restorable === 1, "expected one restorable tab in sample backup");
assert(skipped === 1, "expected one skipped tab in sample backup");

console.log("Extension validation checks passed.");
