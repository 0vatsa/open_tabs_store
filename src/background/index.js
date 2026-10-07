import { CHECKPOINT_ALARM } from "../shared/constants.js";
import { createService } from "./service.js";

const service = createService(chrome);

// Every listener is registered synchronously so events that wake the worker are never missed.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECKPOINT_ALARM) service.tick().catch(() => {});
});

const scheduleLive = () => service.scheduleLive();

chrome.tabs.onCreated.addListener(scheduleLive);
chrome.tabs.onMoved.addListener(scheduleLive);
chrome.tabs.onAttached.addListener(scheduleLive);
chrome.tabs.onDetached.addListener(scheduleLive);
chrome.tabs.onActivated.addListener(scheduleLive);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if ("url" in changeInfo || "title" in changeInfo || "pinned" in changeInfo || "groupId" in changeInfo) {
    scheduleLive();
  }
});
// Tabs closing because their window (or the whole browser) is closing are ignored: during shutdown
// they would shrink the live session right before it is frozen. The next checkpoint tick still
// picks up windows the user closed on purpose.
chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) scheduleLive();
});
chrome.windows.onCreated.addListener(scheduleLive);
chrome.tabGroups?.onUpdated.addListener(scheduleLive);

chrome.runtime.onStartup.addListener(() => {
  service.ready().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  service.ready().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  service
    .handleMessage(message)
    .then((value) => sendResponse({ ok: true, ...value }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

service.ready().catch(() => {});
