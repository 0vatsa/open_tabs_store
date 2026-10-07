import {
  CHECKPOINT_ALARM,
  DEFAULT_SETTINGS,
  EXPORT_FORMAT,
  INTERVAL_CHOICES,
  KIND,
  LIVE_DEBOUNCE_MS,
  LIVE_MAX_WAIT_MS,
  SESSION_ID_KEY
} from "../shared/constants.js";
import {
  hashWindows,
  serializeWindows,
  snapshotBytes,
  summarizeWindows,
  validateImportedWindows
} from "../shared/snapshot.js";
import { createQueue, createStore } from "../shared/store.js";
import { restoreWindows } from "./restore.js";
import { planRetention } from "./retention.js";

const PROGRESS_WRITE_EVERY = 5;

export function normalizeInterval(value) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.intervalMinutes;
  return INTERVAL_CHOICES.reduce((best, choice) =>
    Math.abs(choice - minutes) < Math.abs(best - minutes) ? choice : best
  );
}

export function createService(api, { now = () => Date.now(), uuid = () => crypto.randomUUID() } = {}) {
  const store = createStore(api.storage.local);
  const exclusive = createQueue();
  let sessionId = null;
  let readyPromise = null;
  let debounceTimer = null;
  let maxWaitTimer = null;
  let lastBadgeError = null;

  // ---------------------------------------------------------------- health

  async function updateBadge(health) {
    const failing = Boolean(health.failing);
    if (failing === lastBadgeError) return;
    lastBadgeError = failing;
    try {
      await api.action?.setBadgeText({ text: failing ? "!" : "" });
      if (failing) await api.action?.setBadgeBackgroundColor({ color: "#dc2626" });
    } catch {
      // Badge is best-effort.
    }
  }

  // Health is mirrored in memory so a failure is still reported (badge) when storage itself is
  // what's failing, and gets persisted with the next successful write.
  let health = null;

  async function recordHealth(error) {
    if (health == null) {
      try {
        health = (await store.getMeta()).health;
      } catch {
        health = {};
      }
    }
    // Successful saves happen every few seconds; only persist that when it changes something visible.
    if (!error && !health.failing && now() - (health.lastSuccessAt || 0) < 60_000) return;
    health = error
      ? { ...health, failing: true, lastErrorAt: now(), lastError: String(error?.message || error) }
      : { ...health, failing: false, lastSuccessAt: now() };
    await updateBadge(health);
    const meta = await store.getMeta();
    meta.health = health;
    await store.setMeta(meta);
  }

  /** Runs a storage-mutating task in the queue and records success/failure in meta.health. */
  function guarded(task) {
    return exclusive(async () => {
      try {
        const value = await task();
        await recordHealth(null);
        return value;
      } catch (error) {
        console.error("Open Tabs Store:", error);
        await recordHealth(error).catch(() => {});
        throw error;
      }
    });
  }

  // ---------------------------------------------------------------- capture

  async function captureWindows() {
    const windows = await api.windows.getAll({ populate: true, windowTypes: ["normal"] });
    let groups = [];
    if (api.tabGroups?.query) {
      try {
        groups = await api.tabGroups.query({});
      } catch {
        groups = [];
      }
    }
    return serializeWindows(windows, groups);
  }

  /** Overwrites the live session. An empty capture never replaces a non-empty one. */
  async function writeLive(windows) {
    if (windows.length === 0) return null;
    const live = { sessionId, updatedAt: now(), hash: hashWindows(windows), windows };
    await store.setLive(live);
    return live;
  }

  async function addCheckpoint(windows, kind, extra = {}) {
    const meta = await store.getMeta();
    const id = uuid();
    const createdAt = extra.createdAt ?? now();
    const entry = {
      id,
      kind,
      createdAt,
      updatedAt: createdAt,
      sessionId: extra.sessionId ?? sessionId,
      activeAt: meta.activeMs,
      label: extra.label || "",
      starred: false,
      hash: hashWindows(windows),
      bytes: snapshotBytes(windows),
      ...summarizeWindows(windows)
    };
    await store.putSnapshot(id, windows);
    const index = await store.getIndex();
    index.push(entry);
    await store.setIndex(index);
    return entry;
  }

  async function prune() {
    const [index, meta] = await Promise.all([store.getIndex(), store.getMeta()]);
    const drop = new Set(planRetention(index, meta.activeMs));
    if (drop.size === 0) return 0;
    await store.setIndex(index.filter((entry) => !drop.has(entry.id)));
    await store.removeSnapshots([...drop]);
    return drop.size;
  }

  /** Turns the previous browser session's last live state into a protected checkpoint. */
  async function freezeSessionEnd(live) {
    const index = await store.getIndex();
    if (index.some((entry) => entry.kind === KIND.SESSION_END && entry.sessionId === live.sessionId)) return null;

    const hash = live.hash ?? hashWindows(live.windows);
    const latest = index.find((entry) => entry.sessionId === live.sessionId);
    if (latest && latest.kind === KIND.AUTO && latest.hash === hash) {
      latest.kind = KIND.SESSION_END;
      latest.updatedAt = live.updatedAt;
      latest.createdAt = live.updatedAt;
      await store.setIndex(index);
      return latest;
    }
    return addCheckpoint(live.windows, KIND.SESSION_END, {
      sessionId: live.sessionId,
      createdAt: live.updatedAt
    });
  }

  async function ensureSession() {
    const stored = await api.storage.session.get(SESSION_ID_KEY);
    if (stored?.[SESSION_ID_KEY]) {
      sessionId = stored[SESSION_ID_KEY];
      return false;
    }

    // storage.session is empty: the browser (or the extension) just started.
    const newSessionId = uuid();
    const live = await store.getLive();
    if (live?.windows?.length && live.sessionId !== newSessionId) {
      await freezeSessionEnd(live);
    }
    const meta = await store.getMeta();
    meta.lastTickAt = now(); // time spent closed never counts toward retention
    await store.setMeta(meta);
    sessionId = newSessionId;
    await api.storage.session.set({ [SESSION_ID_KEY]: newSessionId });
    await prune();
    return true;
  }

  async function ensureAlarm() {
    const { settings } = await store.getMeta();
    const existing = await api.alarms.get(CHECKPOINT_ALARM);
    if (existing?.periodInMinutes !== settings.intervalMinutes) {
      await api.alarms.create(CHECKPOINT_ALARM, {
        periodInMinutes: settings.intervalMinutes,
        delayInMinutes: settings.intervalMinutes
      });
    }
  }

  async function init() {
    const isNewSession = await guarded(ensureSession);
    await ensureAlarm();
    if (isNewSession) scheduleLive();
    const meta = await store.getMeta();
    await updateBadge(meta.health);
  }

  function ready() {
    readyPromise ??= init().catch((error) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  }

  // ---------------------------------------------------------------- operations

  async function flushLive() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = maxWaitTimer = null;
    await ready();
    return guarded(async () => writeLive(await captureWindows()));
  }

  function scheduleLive() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => flushLive().catch(() => {}), LIVE_DEBOUNCE_MS);
    maxWaitTimer ??= setTimeout(() => flushLive().catch(() => {}), LIVE_MAX_WAIT_MS);
  }

  async function tick() {
    await ready();
    return guarded(async () => {
      const meta = await store.getMeta();
      const t = now();
      if (meta.lastTickAt != null) {
        const cap = 2 * meta.settings.intervalMinutes * 60_000;
        meta.activeMs += Math.min(Math.max(0, t - meta.lastTickAt), cap);
      }
      meta.lastTickAt = t;
      await store.setMeta(meta);

      const windows = await captureWindows();
      const live = await writeLive(windows);
      if (!live) return null;

      const index = await store.getIndex();
      const latest = index.find((entry) => entry.kind !== KIND.IMPORTED);
      if (latest && latest.hash === live.hash) {
        latest.updatedAt = t;
        await store.setIndex(index);
        return null;
      }
      const entry = await addCheckpoint(windows, KIND.AUTO);
      await prune();
      return entry;
    });
  }

  async function saveNow(label = "") {
    await ready();
    return guarded(async () => {
      const windows = await captureWindows();
      if (windows.length === 0) throw new Error("There are no open tabs to save.");
      await writeLive(windows);
      const entry = await addCheckpoint(windows, KIND.MANUAL, { label: String(label).slice(0, 120) });
      await prune();
      return entry;
    });
  }

  async function restore({ id, mode = "new", targetWindowId = null, selection = null }) {
    await ready();
    const [index, snapshot, meta] = await Promise.all([store.getIndex(), store.getSnapshot(id), store.getMeta()]);
    const entry = index.find((item) => item.id === id);
    if (!entry || !snapshot) {
      throw new Error("This snapshot no longer exists. It may have been deleted. Refresh the list and try again.");
    }

    const status = { snapshotId: id, state: "running", startedAt: now(), total: 0, created: 0, failed: 0 };
    await store.setRestoreStatus(status);

    let lastWritten = 0;
    const onProgress = (progress) => {
      Object.assign(status, progress);
      if (progress.created - lastWritten >= PROGRESS_WRITE_EVERY) {
        lastWritten = progress.created;
        store.setRestoreStatus({ ...status }).catch(() => {});
      }
    };

    try {
      const result = await restoreWindows(
        api,
        snapshot.windows,
        {
          mode,
          targetWindowId,
          selection,
          lazy: meta.settings.lazyRestore,
          skipOpen: meta.settings.skipOpenTabs
        },
        onProgress
      );
      Object.assign(status, result, { state: "done", finishedAt: now() });
      await store.setRestoreStatus({ ...status });
      await exclusive(async () => {
        const fresh = await store.getIndex();
        const target = fresh.find((item) => item.id === id);
        if (target) {
          target.restoredAt = now();
          await store.setIndex(fresh);
        }
      });
      return result;
    } catch (error) {
      Object.assign(status, { state: "error", error: String(error?.message || error), finishedAt: now() });
      await store.setRestoreStatus({ ...status });
      throw error;
    }
  }

  async function updateEntry(id, patch) {
    return exclusive(async () => {
      const index = await store.getIndex();
      const entry = index.find((item) => item.id === id);
      if (!entry) throw new Error("Snapshot not found.");
      if ("label" in patch) entry.label = String(patch.label || "").slice(0, 120);
      if ("starred" in patch) entry.starred = Boolean(patch.starred);
      if ("dismissed" in patch) entry.dismissed = Boolean(patch.dismissed);
      await store.setIndex(index);
      return entry;
    });
  }

  async function deleteEntry(id) {
    return exclusive(async () => {
      const index = await store.getIndex();
      const entry = index.find((item) => item.id === id);
      if (!entry) return null;
      const snapshot = await store.getSnapshot(id);
      await store.setIndex(index.filter((item) => item.id !== id));
      await store.removeSnapshots([id]);
      return { entry, windows: snapshot?.windows || [] };
    });
  }

  async function undoDelete({ entry, windows }) {
    return exclusive(async () => {
      const index = await store.getIndex();
      if (index.some((item) => item.id === entry.id)) return entry;
      await store.putSnapshot(entry.id, windows);
      index.push(entry);
      await store.setIndex(index);
      return entry;
    });
  }

  async function importData(data) {
    await ready();
    if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.snapshots)) {
      throw new Error("This file is not an Open Tabs Store export.");
    }
    const prepared = data.snapshots.map((item, i) => {
      try {
        return { item, windows: validateImportedWindows(item?.windows) };
      } catch (error) {
        throw new Error(`Snapshot ${i + 1}: ${error.message}`);
      }
    });
    return guarded(async () => {
      const added = [];
      for (const { item, windows } of prepared) {
        const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : now();
        added.push(
          await addCheckpoint(windows, KIND.IMPORTED, { createdAt, label: item.label || "", sessionId: null })
        );
      }
      return added.length;
    });
  }

  async function setSettings(patch) {
    const settings = await exclusive(async () => {
      const meta = await store.getMeta();
      if ("intervalMinutes" in patch) meta.settings.intervalMinutes = normalizeInterval(patch.intervalMinutes);
      if ("lazyRestore" in patch) meta.settings.lazyRestore = Boolean(patch.lazyRestore);
      if ("skipOpenTabs" in patch) meta.settings.skipOpenTabs = Boolean(patch.skipOpenTabs);
      await store.setMeta(meta);
      return meta.settings;
    });
    await ensureAlarm();
    return settings;
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "FLUSH_LIVE":
        await flushLive();
        return {};
      case "SAVE_NOW":
        return { entry: await saveNow(message.label) };
      case "RESTORE":
        return { result: await restore(message) };
      case "UPDATE_ENTRY":
        return { entry: await updateEntry(message.id, message.patch || {}) };
      case "DELETE_ENTRY":
        return { deleted: await deleteEntry(message.id) };
      case "UNDO_DELETE":
        return { entry: await undoDelete(message.deleted) };
      case "IMPORT":
        return { imported: await importData(message.data) };
      case "SET_SETTINGS":
        return { settings: await setSettings(message.patch || {}) };
      default:
        throw new Error(`Unknown message type: ${message?.type}`);
    }
  }

  return {
    ready,
    tick,
    flushLive,
    scheduleLive,
    saveNow,
    restore,
    updateEntry,
    deleteEntry,
    undoDelete,
    importData,
    setSettings,
    handleMessage,
    store,
    get sessionId() {
      return sessionId;
    }
  };
}
