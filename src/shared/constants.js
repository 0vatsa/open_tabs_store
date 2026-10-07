export const KEYS = Object.freeze({
  META: "meta",
  LIVE: "live",
  INDEX: "index",
  RESTORE_STATUS: "restoreStatus"
});

export const SNAP_PREFIX = "snap:";
export const SESSION_ID_KEY = "sessionId";
export const CHECKPOINT_ALARM = "checkpoint";
export const SCHEMA_VERSION = 2;
export const EXPORT_FORMAT = "open-tabs-store";

export const INTERVAL_CHOICES = Object.freeze([1, 2, 5, 10, 15, 30, 60]);

export const DEFAULT_SETTINGS = Object.freeze({
  intervalMinutes: 5,
  lazyRestore: true,
  skipOpenTabs: true
});

// Live-session capture after tab events: wait for a quiet period, but never longer than the max.
export const LIVE_DEBOUNCE_MS = 3_000;
export const LIVE_MAX_WAIT_MS = 10_000;

export const KIND = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual",
  SESSION_END: "session-end",
  IMPORTED: "imported"
});

export const PREVIEW_TAB_COUNT = 4;
