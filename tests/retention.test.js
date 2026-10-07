import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planRetention, RETENTION } from "../src/background/retention.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function entry(id, activeAt, extra = {}) {
  return { id, kind: "auto", createdAt: activeAt, activeAt, bytes: 1000, ...extra };
}

describe("planRetention", () => {
  test("nothing expires while the browser is closed (active clock unchanged)", () => {
    const index = Array.from({ length: 24 }, (_, i) => entry(`a${i}`, 10 * HOUR - i * 5 * MINUTE));
    assert.deepEqual(planRetention(index, 10 * HOUR), []);
  });

  test("thins older auto checkpoints: half-hourly up to a day, hourly up to a week", () => {
    const activeMs = 3 * 24 * HOUR;
    const index = [];
    for (let t = activeMs; t > 0; t -= 5 * MINUTE) index.push(entry(`a${t}`, t));
    const dropped = new Set(planRetention(index, activeMs));
    const kept = index.filter((e) => !dropped.has(e.id));

    const recent = kept.filter((e) => activeMs - e.activeAt <= 2 * HOUR);
    assert.equal(recent.length, 25);
    const halfHourly = kept.filter((e) => {
      const age = activeMs - e.activeAt;
      return age > 2 * HOUR && age <= 24 * HOUR;
    });
    assert.ok(halfHourly.length >= 43 && halfHourly.length <= 46, `half-hourly kept ${halfHourly.length}`);
    const hourly = kept.filter((e) => activeMs - e.activeAt > 24 * HOUR);
    assert.ok(hourly.length >= 47 && hourly.length <= 49, `hourly kept ${hourly.length}`);
  });

  test("drops auto checkpoints older than the max active age", () => {
    const activeMs = RETENTION.maxAutoAgeMs + 10 * HOUR;
    assert.deepEqual(planRetention([entry("old", 1 * HOUR)], activeMs), ["old"]);
  });

  test("protects manual, starred, imported and the last 10 session ends", () => {
    const activeMs = 100 * 24 * HOUR;
    const index = [
      entry("manual", 0, { kind: "manual" }),
      entry("starred", 0, { starred: true }),
      entry("imported", 0, { kind: "imported" }),
      ...Array.from({ length: 12 }, (_, i) => entry(`end${i}`, i * HOUR, { kind: "session-end", createdAt: i }))
    ];
    const dropped = planRetention(index, activeMs).sort();
    assert.deepEqual(dropped, ["end0", "end1"]);
  });

  test("soft size cap sheds the oldest unprotected checkpoints first, keeping the newest session end", () => {
    const rules = { ...RETENTION, softCapBytes: 3500 };
    const activeMs = HOUR;
    const index = [
      entry("end", 0, { kind: "session-end", createdAt: 0 }),
      entry("a1", 10 * MINUTE),
      entry("a2", 20 * MINUTE),
      entry("a3", 30 * MINUTE),
      entry("m", 5 * MINUTE, { kind: "manual" })
    ];
    assert.deepEqual(planRetention(index, activeMs, rules).sort(), ["a1", "a2"]);
  });
});
