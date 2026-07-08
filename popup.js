const currentTabCountEl = document.getElementById("current-tab-count");
const currentWindowCountEl = document.getElementById("current-window-count");
const lastBackupTimeEl = document.getElementById("last-backup-time");
const backupTabCountEl = document.getElementById("backup-tab-count");
const backupWindowCountEl = document.getElementById("backup-window-count");
const snapshotCountEl = document.getElementById("snapshot-count");
const snapshotListEl = document.getElementById("snapshot-list");
const feedbackEl = document.getElementById("feedback");
const backupNowButton = document.getElementById("backup-now");

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "Never";
  }

  return new Date(timestamp).toLocaleString();
}

function formatSource(source) {
  return source === "manual" ? "Manual" : "Auto";
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

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function updateStatus(status) {
  currentTabCountEl.textContent = String(status.currentTabCount ?? 0);
  currentWindowCountEl.textContent = String(status.currentWindowCount ?? 0);
  lastBackupTimeEl.textContent = formatTimestamp(status.savedAt);
  backupTabCountEl.textContent = status.tabCount == null ? "-" : String(status.tabCount);
  backupWindowCountEl.textContent = status.windowCount == null ? "-" : String(status.windowCount);
  snapshotCountEl.textContent = String(status.snapshotCount ?? 0);
}

function renderSnapshots(snapshots) {
  snapshotListEl.replaceChildren();

  if (!snapshots.length) {
    const empty = document.createElement("p");
    empty.className = "snapshot-empty";
    empty.textContent = "No snapshots yet. Auto backups run every minute.";
    snapshotListEl.appendChild(empty);
    return;
  }

  for (const snapshot of snapshots) {
    const row = document.createElement("article");
    row.className = "snapshot-row";

    const badge = document.createElement("span");
    badge.className = `badge badge-${snapshot.source}`;
    badge.textContent = formatSource(snapshot.source);

    const details = document.createElement("div");
    details.className = "snapshot-details";

    const time = document.createElement("div");
    time.className = "snapshot-time";
    time.textContent = formatTimestamp(snapshot.savedAt);

    const meta = document.createElement("div");
    meta.className = "snapshot-meta";
    meta.textContent = `${snapshot.tabCount} tabs · ${snapshot.windowCount} windows`;

    details.append(time, meta);

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "restore-button secondary";
    restoreButton.textContent = "Restore";
    restoreButton.addEventListener("click", () => restoreSnapshot(snapshot));

    row.append(badge, details, restoreButton);
    snapshotListEl.appendChild(row);
  }
}

async function refreshSnapshots() {
  const response = await sendMessage({ type: "GET_SNAPSHOTS" });

  if (!response?.ok) {
    showFeedback(response?.error || "Failed to load snapshots.", true);
    return;
  }

  renderSnapshots(response.snapshots || []);
}

async function refreshStatus() {
  const response = await sendMessage({ type: "GET_STATUS" });

  if (!response?.ok) {
    showFeedback(response?.error || "Failed to load backup status.", true);
    return;
  }

  updateStatus(response);
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshSnapshots()]);
}

async function restoreSnapshot(snapshot) {
  clearFeedback();

  const skippedNote =
    snapshot.skippedTabCount > 0
      ? ` ${snapshot.skippedTabCount} internal tab(s) will be skipped.`
      : "";

  const confirmed = window.confirm(
    `Restore ${snapshot.restorableTabCount} tabs across ${snapshot.windowCount} windows from the ${formatSource(snapshot.source).toLowerCase()} backup at ${formatTimestamp(snapshot.savedAt)}? This opens new windows and does not close your current tabs.${skippedNote}`
  );

  if (!confirmed) {
    return;
  }

  const response = await sendMessage({
    type: "RESTORE",
    snapshotId: snapshot.id
  });

  if (!response?.ok) {
    showFeedback(response?.error || "Restore failed.", true);
    return;
  }

  showFeedback(
    `Restored ${response.restorable} tabs across ${response.restoredWindows} windows.${response.skipped > 0 ? ` Skipped ${response.skipped} internal tab(s).` : ""}`
  );
  await refreshAll();
}

backupNowButton.addEventListener("click", async () => {
  clearFeedback();
  backupNowButton.disabled = true;

  try {
    const response = await sendMessage({ type: "BACKUP_NOW" });

    if (!response?.ok) {
      showFeedback(response?.error || "Backup failed.", true);
      return;
    }

    showFeedback(
      `Saved manual backup with ${response.tabCount} tabs across ${response.windowCount} windows.`
    );
    await refreshAll();
  } finally {
    backupNowButton.disabled = false;
  }
});

refreshAll().catch((error) => {
  showFeedback(error.message || "Failed to load backup status.", true);
});
