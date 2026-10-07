import { DEFAULT_SETTINGS, KEYS, SCHEMA_VERSION, SNAP_PREFIX } from "./constants.js";

/**
 * Storage layout (chrome.storage.local):
 *   meta            settings, health, active-time clock
 *   live            the current session, rewritten a few seconds after every tab change
 *   index           small list of checkpoint summaries, newest first
 *   snap:<id>       the full windows/tabs of one checkpoint
 *   restoreStatus   progress of the last restore, so any open UI can show it
 */
export function createStore(area) {
  return {
    async getMeta() {
      const { [KEYS.META]: meta } = await area.get(KEYS.META);
      return {
        schemaVersion: SCHEMA_VERSION,
        activeMs: 0,
        lastTickAt: null,
        health: {},
        ...meta,
        settings: { ...DEFAULT_SETTINGS, ...meta?.settings }
      };
    },

    async setMeta(meta) {
      await area.set({ [KEYS.META]: meta });
    },

    async getLive() {
      const { [KEYS.LIVE]: live } = await area.get(KEYS.LIVE);
      return live || null;
    },

    async setLive(live) {
      await area.set({ [KEYS.LIVE]: live });
    },

    async getIndex() {
      const { [KEYS.INDEX]: index } = await area.get(KEYS.INDEX);
      return Array.isArray(index) ? index : [];
    },

    async setIndex(index) {
      const sorted = [...index].sort((a, b) => b.createdAt - a.createdAt);
      await area.set({ [KEYS.INDEX]: sorted });
      return sorted;
    },

    async getSnapshot(id) {
      const key = SNAP_PREFIX + id;
      const { [key]: snapshot } = await area.get(key);
      return snapshot || null;
    },

    async getSnapshots(ids) {
      if (ids.length === 0) return [];
      const result = await area.get(ids.map((id) => SNAP_PREFIX + id));
      return ids.map((id) => result[SNAP_PREFIX + id] || null);
    },

    async putSnapshot(id, windows) {
      await area.set({ [SNAP_PREFIX + id]: { id, windows } });
    },

    async removeSnapshots(ids) {
      if (ids.length) await area.remove(ids.map((id) => SNAP_PREFIX + id));
    },

    async getRestoreStatus() {
      const { [KEYS.RESTORE_STATUS]: status } = await area.get(KEYS.RESTORE_STATUS);
      return status || null;
    },

    async setRestoreStatus(status) {
      await area.set({ [KEYS.RESTORE_STATUS]: status });
    }
  };
}

/** Serializes async work so read-modify-write sequences never interleave. */
export function createQueue() {
  let tail = Promise.resolve();
  return function exclusive(task) {
    const result = tail.then(() => task());
    tail = result.catch(() => {});
    return result;
  };
}
