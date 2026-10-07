import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { KIND, SNAP_PREFIX } from "../src/shared/constants.js";
import { createService, normalizeInterval } from "../src/background/service.js";
import { createFakeChrome, createStorageArea } from "./fake-chrome.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function clock(start = Date.UTC(2026, 9, 7, 12)) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function threeWindows() {
  return [
    {
      focused: true,
      tabs: [
        { url: "https://mail.example.com/", title: "Mail", pinned: true },
        { url: "https://news.example.com/a", title: "News", active: true },
        { url: "chrome://settings/", title: "Settings" }
      ]
    },
    { tabs: [{ url: "https://docs.example.com/1", active: true }, { url: "https://docs.example.com/2" }] },
    { state: "minimized", tabs: [{ url: "https://music.example.com/", active: true }] }
  ];
}

const services = [];
let idCounter = 0;
function makeService(api, c) {
  const service = createService(api, { now: c.now, uuid: () => `id-${idCounter++}` });
  services.push(service);
  return service;
}

afterEach(() => {
  // Cancel pending debounce timers so the test process can exit.
  for (const service of services.splice(0)) service.flushLive().catch(() => {});
});

describe("crash recovery", () => {
  test("pre-crash session survives a multi-day gap and is frozen as a protected session end", async () => {
    const c = clock();
    const local = createStorageArea();
    const before = createFakeChrome({ local, windows: threeWindows() });
    const first = makeService(before, c);

    await first.tick();
    c.advance(5 * MINUTE);
    await first.flushLive();

    // Crash, browser stays closed for three days, comes back with one blank tab.
    c.advance(3 * DAY);
    const after = createFakeChrome({
      local,
      windows: [{ focused: true, tabs: [{ url: "chrome://newtab/", active: true }] }]
    });
    const second = makeService(after, c);
    await second.ready();

    for (let i = 0; i < 20; i += 1) {
      c.advance(5 * MINUTE);
      await second.tick();
    }

    const index = await second.store.getIndex();
    const sessionEnds = index.filter((entry) => entry.kind === KIND.SESSION_END);
    assert.equal(sessionEnds.length, 1);
    assert.equal(sessionEnds[0].tabCount, 6);
    assert.equal(sessionEnds[0].restorableCount, 5);
    assert.equal(sessionEnds[0].windowCount, 3);
    assert.ok(await second.store.getSnapshot(sessionEnds[0].id));
  });

  test("restarting with the same tabs reuses the matching checkpoint instead of duplicating it", async () => {
    const c = clock();
    const local = createStorageArea();
    const first = makeService(createFakeChrome({ local, windows: threeWindows() }), c);
    await first.tick();

    c.advance(DAY);
    const second = makeService(createFakeChrome({ local, windows: threeWindows() }), c);
    await second.ready();
    c.advance(5 * MINUTE);
    await second.tick();

    const index = await second.store.getIndex();
    assert.equal(index.length, 1);
    assert.equal(index[0].kind, KIND.SESSION_END);
  });

  test("an empty capture never overwrites the live session", async () => {
    const c = clock();
    const api = createFakeChrome({ windows: threeWindows() });
    const service = makeService(api, c);
    await service.flushLive();
    api.state.windows.length = 0;
    await service.flushLive();
    const live = await service.store.getLive();
    assert.equal(live.windows.length, 3);
  });

  test("session end is created only once even if startup runs twice", async () => {
    const c = clock();
    const local = createStorageArea();
    await makeService(createFakeChrome({ local, windows: threeWindows() }), c).flushLive();

    const api = createFakeChrome({ local, windows: [{ tabs: [{ url: "https://other.example.com/" }] }] });
    await makeService(api, c).ready();
    // The worker is killed after freezing but before the new live session was written.
    await api.storage.session.clear();
    await makeService(api, c).ready();

    const index = (await local.get("index")).index;
    assert.equal(index.filter((entry) => entry.kind === KIND.SESSION_END).length, 1);
  });
});

describe("checkpoints", () => {
  test("unchanged tabs do not create new checkpoints", async () => {
    const c = clock();
    const service = makeService(createFakeChrome({ windows: threeWindows() }), c);
    for (let i = 0; i < 10; i += 1) {
      c.advance(5 * MINUTE);
      await service.tick();
    }
    assert.equal((await service.store.getIndex()).length, 1);
  });

  test("title-only changes are not a new checkpoint", async () => {
    const c = clock();
    const api = createFakeChrome({ windows: threeWindows() });
    const service = makeService(api, c);
    await service.tick();
    api.state.windows[0].tabs[1].title = "(3) News";
    c.advance(5 * MINUTE);
    await service.tick();
    assert.equal((await service.store.getIndex()).length, 1);
  });

  test("concurrent saves are all kept and the index stays consistent", async () => {
    const c = clock();
    const api = createFakeChrome({ windows: threeWindows() });
    const service = makeService(api, c);
    await service.ready();
    let n = 0;
    api.state.windows[0].tabs[1].url = "https://changed.example.com/";
    await Promise.all(
      [service.saveNow("a"), service.tick(), service.saveNow("b"), service.saveNow("c")].map((p) => p.then(() => n++))
    );
    const index = await service.store.getIndex();
    assert.equal(index.filter((e) => e.kind === KIND.MANUAL).length, 3);
    for (const entry of index) assert.ok(api.storage.local.data.has(SNAP_PREFIX + entry.id));
    assert.equal(n, 4);
  });

  test("storage failures are recorded in health and shown on the badge", async () => {
    const c = clock();
    let fail = false;
    const local = createStorageArea({ failWrites: () => fail });
    const api = createFakeChrome({ local, windows: threeWindows() });
    const service = makeService(api, c);
    await service.ready();

    fail = true;
    await assert.rejects(service.saveNow(), /QUOTA/);
    assert.equal(api.state.badge, "!");

    fail = false;
    await service.saveNow();
    assert.equal(api.state.badge, "");
    const { health } = await service.store.getMeta();
    assert.match(health.lastError, /QUOTA/);
    assert.equal(health.failing, false);
  });

  test("settings normalize the interval and reschedule the alarm", async () => {
    const c = clock();
    const api = createFakeChrome({ windows: threeWindows() });
    const service = makeService(api, c);
    await service.ready();
    const settings = await service.setSettings({ intervalMinutes: "7", lazyRestore: false });
    assert.equal(settings.intervalMinutes, 5);
    assert.equal(settings.lazyRestore, false);
    await service.setSettings({ intervalMinutes: 15 });
    assert.equal(api.state.alarms.get("checkpoint").periodInMinutes, 15);
    assert.equal(normalizeInterval("abc"), 5);
    assert.equal(normalizeInterval(1000), 60);
  });

  test("delete and undo", async () => {
    const c = clock();
    const service = makeService(createFakeChrome({ windows: threeWindows() }), c);
    const entry = await service.saveNow("keep me");
    const { deleted } = await service.handleMessage({ type: "DELETE_ENTRY", id: entry.id });
    assert.equal((await service.store.getIndex()).length, 0);
    await service.handleMessage({ type: "UNDO_DELETE", deleted });
    assert.equal((await service.store.getIndex())[0].label, "keep me");
    assert.equal((await service.store.getSnapshot(entry.id)).windows.length, 3);
  });

  test("restoring a missing snapshot explains why", async () => {
    const service = makeService(createFakeChrome({ windows: threeWindows() }), clock());
    await assert.rejects(service.restore({ id: "nope" }), /no longer exists/);
  });
});

describe("import", () => {
  test("accepts a valid export and rejects junk", async () => {
    const c = clock();
    const service = makeService(createFakeChrome({ windows: threeWindows() }), c);
    const count = await service.importData({
      format: "open-tabs-store",
      version: 2,
      snapshots: [{ createdAt: 1, label: "old", windows: [{ tabs: [{ url: "https://a.example/" }, { nope: 1 }] }] }]
    });
    assert.equal(count, 1);
    const [entry] = await service.store.getIndex();
    assert.equal(entry.kind, KIND.IMPORTED);
    assert.equal(entry.tabCount, 1);

    await assert.rejects(service.importData({ hello: "world" }), /not an Open Tabs Store export/);
    await assert.rejects(
      service.importData({ format: "open-tabs-store", snapshots: [{ windows: [] }] }),
      /Snapshot 1: Snapshot has no tabs/
    );
  });
});
