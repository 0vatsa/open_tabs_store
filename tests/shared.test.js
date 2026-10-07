import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildHtmlExport, buildJsonExport, buildTextExport } from "../src/shared/export.js";
import { diffWindows, hashWindows, serializeWindows, summarizeWindows } from "../src/shared/snapshot.js";
import { domainOf, isRestorableUrl } from "../src/shared/urls.js";

describe("urls", () => {
  test("isRestorableUrl", () => {
    for (const url of ["https://x.com", "http://x", "file:///tmp/a.html", "about:blank"]) {
      assert.equal(isRestorableUrl(url), true, url);
    }
    for (const url of [
      "",
      null,
      "chrome://newtab/",
      "brave://settings",
      "chrome-extension://x/p.html",
      "about:config",
      "javascript:alert(1)"
    ]) {
      assert.equal(isRestorableUrl(url), false, String(url));
    }
  });

  test("domainOf", () => {
    assert.equal(domainOf("https://www.example.com/a"), "example.com");
    assert.equal(domainOf("file:///x"), "Local file");
    assert.equal(domainOf("not a url"), "not a url");
  });
});

describe("snapshot helpers", () => {
  const raw = [
    {
      id: 1,
      type: "normal",
      state: "normal",
      focused: true,
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      tabs: [
        { index: 1, url: "", pendingUrl: "https://pending.example/", title: "P" },
        { index: 0, url: "https://a.example/", title: "A", pinned: true, active: true, groupId: 5 }
      ]
    },
    { id: 2, type: "normal", incognito: true, tabs: [{ index: 0, url: "https://secret.example/" }] },
    { id: 3, type: "normal", tabs: [] }
  ];

  test("serializeWindows orders tabs, uses pendingUrl, keeps groups and drops incognito/empty windows", () => {
    const windows = serializeWindows(raw, [{ id: 5, windowId: 1, title: "G", color: "red", collapsed: false }]);
    assert.equal(windows.length, 1);
    assert.deepEqual(
      windows[0].tabs.map((t) => t.url),
      ["https://a.example/", "https://pending.example/"]
    );
    assert.equal(windows[0].tabs[0].groupId, 5);
    assert.equal(windows[0].tabs[1].groupId, undefined);
    assert.deepEqual(windows[0].groups, [{ id: 5, title: "G", color: "red", collapsed: false }]);
    assert.equal(windows[0].width, 100);
  });

  test("hash ignores titles but not order or pins", () => {
    const a = [{ tabs: [{ url: "x", title: "1" }, { url: "y" }] }];
    const b = [{ tabs: [{ url: "x", title: "2" }, { url: "y" }] }];
    const c = [{ tabs: [{ url: "y" }, { url: "x" }] }];
    const d = [{ tabs: [{ url: "x", pinned: true }, { url: "y" }] }];
    assert.equal(hashWindows(a), hashWindows(b));
    assert.notEqual(hashWindows(a), hashWindows(c));
    assert.notEqual(hashWindows(a), hashWindows(d));
  });

  test("summarizeWindows", () => {
    const summary = summarizeWindows([
      {
        tabs: [{ url: "https://a.com/1" }, { url: "https://a.com/2" }, { url: "chrome://x" }, { url: "https://b.com" }]
      }
    ]);
    assert.equal(summary.tabCount, 4);
    assert.equal(summary.restorableCount, 3);
    assert.deepEqual(
      summary.preview.map((p) => p.url),
      ["https://a.com/1", "https://b.com"]
    );
  });

  test("diffWindows handles duplicates", () => {
    const before = [{ tabs: [{ url: "a" }, { url: "a" }, { url: "b" }] }];
    const after = [{ tabs: [{ url: "a" }, { url: "c" }] }];
    assert.deepEqual(diffWindows(before, after), { added: ["c"], removed: ["a", "b"] });
  });
});

describe("exports", () => {
  const items = [
    {
      entry: { createdAt: 0, kind: "manual", label: "<x>" },
      windows: [{ tabs: [{ url: 'https://a.com/?q="1"', title: "A & B" }] }]
    }
  ];

  test("json round-trips the import format", () => {
    const parsed = JSON.parse(buildJsonExport(items, 5));
    assert.equal(parsed.format, "open-tabs-store");
    assert.equal(parsed.snapshots[0].label, "<x>");
    assert.equal(parsed.snapshots[0].windows[0].tabs[0].title, "A & B");
  });

  test("html escapes content", () => {
    const html = buildHtmlExport(items);
    assert.ok(html.includes("A &amp; B"));
    assert.ok(html.includes("&lt;x&gt;"));
    assert.ok(html.includes('href="https://a.com/?q=&quot;1&quot;"'));
  });

  test("text export lists links", () => {
    assert.ok(buildTextExport(items).includes('- [A & B](https://a.com/?q="1")'));
  });
});
