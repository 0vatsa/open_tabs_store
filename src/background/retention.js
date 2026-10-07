import { KIND } from "../shared/constants.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Ages are measured in *browser-open time* (`activeMs`), never wall-clock time, so nothing expires
 * while the browser is closed or the machine is off — which is exactly when backups matter.
 */
export const RETENTION = Object.freeze({
  keepSessionEnds: 10,
  fullResolutionMs: 2 * HOUR,
  halfHourlyUntilMs: 24 * HOUR,
  maxAutoAgeMs: 7 * 24 * HOUR,
  softCapBytes: 25 * 1024 * 1024
});

export function isProtected(entry) {
  return entry.kind === KIND.MANUAL || entry.kind === KIND.IMPORTED || Boolean(entry.starred);
}

/** Returns the ids of index entries that should be deleted. Pure. */
export function planRetention(index, activeMs, rules = RETENTION) {
  const newestFirst = [...index].sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set();
  const drop = new Set();

  const sessionEnds = newestFirst.filter((entry) => entry.kind === KIND.SESSION_END && !isProtected(entry));
  const keptSessionEnds = new Set(sessionEnds.slice(0, rules.keepSessionEnds).map((entry) => entry.id));

  const seenBuckets = new Set();
  for (const entry of newestFirst) {
    if (isProtected(entry) || keptSessionEnds.has(entry.id)) {
      keep.add(entry.id);
      continue;
    }

    const age = Math.max(0, activeMs - (entry.activeAt ?? activeMs));
    if (age <= rules.fullResolutionMs) {
      keep.add(entry.id);
      continue;
    }
    if (age > rules.maxAutoAgeMs) {
      drop.add(entry.id);
      continue;
    }

    const bucketSize = age <= rules.halfHourlyUntilMs ? 30 * MINUTE : HOUR;
    const bucket = `${bucketSize}:${Math.floor((entry.activeAt ?? 0) / bucketSize)}`;
    if (seenBuckets.has(bucket)) {
      drop.add(entry.id);
    } else {
      seenBuckets.add(bucket);
      keep.add(entry.id);
    }
  }

  // Soft size cap: shed the oldest unprotected checkpoints, but always keep the newest session end.
  let total = newestFirst.filter((entry) => keep.has(entry.id)).reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  if (total > rules.softCapBytes) {
    const newestSessionEnd = sessionEnds[0]?.id;
    const candidates = [...newestFirst]
      .reverse()
      .filter((entry) => keep.has(entry.id) && !isProtected(entry) && entry.id !== newestSessionEnd)
      .sort((a, b) => Number(a.kind === KIND.SESSION_END) - Number(b.kind === KIND.SESSION_END));
    for (const entry of candidates) {
      if (total <= rules.softCapBytes) break;
      keep.delete(entry.id);
      drop.add(entry.id);
      total -= entry.bytes || 0;
    }
  }

  return [...drop];
}
