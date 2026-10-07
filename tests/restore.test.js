import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planRestore, restoreWindows } from "../src/background/restore.js";
import { createFakeChrome } from "./fake-chrome.js";

const saved = [
  {
    state: "maximized",
    focused: false,
    groups: [{ id: 7, title: "Research", color: "blue", collapsed: true }],
    tabs: [
      { url: "https://pinned.example/", pinned: true },
      { url: "https://a.example/", groupId: 7 },
      { url: "https://b.example/", active: true, groupId: 7 },
      { url: "https://a.example/" },
      { url: "chrome://settings/" }
    ]
  },
  {
    state: "normal",
    focused: true,
    left: 10,
    top: 20,
    width: 800,
    height: 600,
    tabs: [{ url: "https://c.example/" }, { url: "https://d.example/", active: true }]
  },
  { state: "minimized", focused: true, tabs: [{ url: "https://e.example/", active: true }] }
];

describe("planRestore", () => {
  test("skips internal pages, already-open URLs and unselected tabs", () => {
    const { total, skippedInternal, skippedOpen, plan } = planRestore(saved, {
      openUrls: new Set(["https://c.example/"]),
      selection: ["0:0", "0:4", "1:0", "1:1"]
    });
    assert.equal(total, 2);
    assert.equal(skippedInternal, 1);
    assert.equal(skippedOpen, 1);
    assert.deepEqual(
      plan.map((p) => p.tabs.map((t) => t.url)),
      [["https://pinned.example/"], ["https://d.example/"]]
    );
  });
});

describe("restoreWindows", () => {
  test("recreates windows with order, pins, active tab, groups, state and focus", async () => {
    const api = createFakeChrome({
      windows: [{ focused: true, tabs: [{ url: "https://already.example/", active: true }] }]
    });
    const result = await restoreWindows(api, saved, { lazy: true, skipOpen: true });

    assert.deepEqual(
      {
        created: result.created,
        windows: result.windows,
        skippedInternal: result.skippedInternal,
        failed: result.failed
      },
      { created: 7, windows: 3, skippedInternal: 1, failed: 0 }
    );

    const [, w1, w2, w3] = api.state.windows;
    assert.deepEqual(
      w1.tabs.map((t) => [t.url, t.pinned]),
      [
        ["https://pinned.example/", true],
        ["https://a.example/", false],
        ["https://b.example/", false],
        ["https://a.example/", false]
      ]
    );
    assert.equal(w1.tabs.find((t) => t.active).url, "https://b.example/");
    assert.equal(w1.state, "maximized");
    assert.equal(w3.state, "minimized");

    // Duplicate URLs keep separate identities: only the first a.example joined the group.
    const group = api.state.groups[0];
    assert.equal(group.title, "Research");
    assert.equal(group.collapsed, true);
    assert.deepEqual(
      w1.tabs.filter((t) => t.groupId === group.id).map((t) => t.url),
      ["https://a.example/", "https://b.example/"]
    );

    assert.equal(w2.left, 10);
    assert.equal(w2.width, 800);
    assert.equal(w2.focused, true, "the saved focused, non-minimized window gets focus");

    // Lazy restore: only the active tab per window stays loaded.
    for (const win of [w1, w2, w3]) {
      for (const tab of win.tabs) assert.equal(tab.discarded, !tab.active, `${tab.url} discarded=${tab.discarded}`);
    }
  });

  test("minimized + focused never reaches windows.create together", async () => {
    const api = createFakeChrome();
    const result = await restoreWindows(api, [saved[2]], { lazy: false });
    assert.equal(result.created, 1);
    assert.equal(api.state.windows[0].state, "minimized");
  });

  test("skips URLs that are already open", async () => {
    const api = createFakeChrome({ windows: [{ tabs: [{ url: "https://c.example/", active: true }] }] });
    const result = await restoreWindows(api, [saved[1]], { lazy: false, skipOpen: true });
    assert.equal(result.skippedOpen, 1);
    assert.equal(result.created, 1);
  });

  test("restores into the current window", async () => {
    const api = createFakeChrome({ windows: [{ tabs: [{ url: "https://here.example/", active: true }] }] });
    const result = await restoreWindows(api, saved, {
      mode: "current",
      targetWindowId: 1,
      lazy: true,
      skipOpen: false
    });
    assert.equal(api.state.windows.length, 1);
    assert.equal(result.created, 7);
    assert.equal(api.state.windows[0].tabs.length, 8);
    assert.equal(api.state.windows[0].tabs.find((t) => t.active).url, "https://here.example/");
  });

  test("a failing tab does not abort the restore", async () => {
    const api = createFakeChrome();
    const result = await restoreWindows(
      api,
      [
        {
          state: "normal",
          tabs: [{ url: "https://ok.example/" }, { url: "blocked:x" }, { url: "https://ok2.example/" }]
        }
      ],
      { lazy: false }
    );
    assert.equal(result.created, 2);
    assert.equal(result.failed, 1);
  });
});
