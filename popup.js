const currentTabCountEl = document.getElementById("current-tab-count");
const currentWindowCountEl = document.getElementById("current-window-count");
const lastBackupTimeEl = document.getElementById("last-backup-time");
const backupTabCountEl = document.getElementById("backup-tab-count");
const backupWindowCountEl = document.getElementById("backup-window-count");
const feedbackEl = document.getElementById("feedback");
const backupNowButton = document.getElementById("backup-now");
const restoreTabsButton = document.getElementById("restore-tabs");

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "Never";
  }

  return new Date(timestamp).toLocaleString();
}

function showFeedback(message, isError = false) {
  feedbackEl.hidden = false;
  feedbackEl.textContent = message;
  feedbackEl.classList.toggle("error", isError);
}

function clearFeedback() {
  feedbackEl.hidden = true;
  feedbackEl.textContent = "";
  feedbackEl.classList.remove("error");
}

function sendMessage(type) {
  return chrome.runtime.sendMessage({ type });
}

function updateStatus(status) {
  currentTabCountEl.textContent = String(status.currentTabCount ?? 0);
  currentWindowCountEl.textContent = String(status.currentWindowCount ?? 0);
  lastBackupTimeEl.textContent = formatTimestamp(status.savedAt);
  backupTabCountEl.textContent = status.tabCount == null ? "-" : String(status.tabCount);
  backupWindowCountEl.textContent = status.windowCount == null ? "-" : String(status.windowCount);

  restoreTabsButton.disabled = !status.savedAt;
}

async function refreshStatus() {
  const response = await sendMessage("GET_STATUS");

  if (!response?.ok) {
    showFeedback(response?.error || "Failed to load backup status.", true);
    return;
  }

  updateStatus(response);
}

backupNowButton.addEventListener("click", async () => {
  clearFeedback();
  backupNowButton.disabled = true;

  try {
    const response = await sendMessage("BACKUP_NOW");

    if (!response?.ok) {
      showFeedback(response?.error || "Backup failed.", true);
      return;
    }

    showFeedback(
      `Saved ${response.tabCount} tabs across ${response.windowCount} windows.`
    );
    await refreshStatus();
  } finally {
    backupNowButton.disabled = false;
  }
});

restoreTabsButton.addEventListener("click", async () => {
  clearFeedback();

  const status = await sendMessage("GET_STATUS");
  if (!status?.ok || !status.savedAt) {
    showFeedback("No backup available to restore.", true);
    return;
  }

  const skippedNote =
    status.skippedTabCount > 0
      ? ` ${status.skippedTabCount} internal tab(s) will be skipped.`
      : "";

  const confirmed = window.confirm(
    `Restore ${status.restorableTabCount} tabs across ${status.windowCount} windows? This opens new windows and does not close your current tabs.${skippedNote}`
  );

  if (!confirmed) {
    return;
  }

  restoreTabsButton.disabled = true;

  try {
    const response = await sendMessage("RESTORE");

    if (!response?.ok) {
      showFeedback(response?.error || "Restore failed.", true);
      return;
    }

    showFeedback(
      `Restored ${response.restorable} tabs across ${response.restoredWindows} windows.${response.skipped > 0 ? ` Skipped ${response.skipped} internal tab(s).` : ""}`
    );
  } finally {
    restoreTabsButton.disabled = false;
    await refreshStatus();
  }
});

refreshStatus().catch((error) => {
  showFeedback(error.message || "Failed to load backup status.", true);
});
