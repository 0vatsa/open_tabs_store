/**
 * End-to-end smoke test in a real Chromium with the unpacked extension.
 *
 *   node tests/e2e/smoke.mjs [screenshotDir]
 *
 * Requires Playwright (`npm i -g playwright` or a local install) and a Chromium build.
 * Flow: open tabs → browser shuts down → relaunch → popup offers the previous session → restore.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(path.join(process.env.NODE_PATH || "/opt/node22/lib/node_modules", "playwright"));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const userDataDir = mkdtempSync(path.join(tmpdir(), "ots-e2e-"));

const TITLES = [
  "Quarterly planning doc",
  "Design review notes",
  "Flight search",
  "Recipe: miso ramen",
  "Issue tracker",
  "Team wiki",
  "Weather radar"
];
const server = http.createServer((req, res) => {
  const n = Number(req.url.split("/").pop()) || 0;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${TITLES[n % TITLES.length]}</title><h1>Page ${n}</h1>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const storage = (worker, keys) => worker.evaluate((k) => chrome.storage.local.get(k), keys);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  // On relaunch the worker can be reported before extension APIs are bound.
  for (
    let i = 0;
    i < 50 && !(await worker.evaluate(() => Boolean(globalThis.chrome?.storage)).catch(() => false));
    i += 1
  ) {
    await wait(100);
  }
  return { context, worker, extensionId };
}

async function waitFor(fn, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------- session 1
{
  const { context, worker } = await launch();
  const first = context.pages()[0] ?? (await context.newPage());
  await first.goto(`${base}/page/0`);
  for (let i = 1; i < 5; i += 1) await (await context.newPage()).goto(`${base}/page/${i}`);

  // A second window, created through the extension API.
  await worker.evaluate((b) => chrome.windows.create({ url: [`${b}/page/5`, `${b}/page/6`] }), base);
  await worker.evaluate(() => chrome.tabs.query({}).then((tabs) => chrome.tabs.update(tabs[0].id, { pinned: true })));

  const live = await waitFor(async () => {
    const { live } = await storage(worker, "live");
    const count = live?.windows.reduce((n, w) => n + w.tabs.filter((t) => t.url.startsWith(base)).length, 0);
    return count === 7 ? live : null;
  }, "live session with 7 tabs");
  console.log(`✓ live session captured: ${live.windows.length} windows`);

  await context.close();
}

// ---------------------------------------------------------------- session 2 (after "crash")
{
  const { context, worker, extensionId } = await launch();
  const index = await waitFor(async () => {
    const { index } = await storage(worker, "index");
    return index?.some((e) => e.kind === "session-end") ? index : null;
  }, "session-end checkpoint");
  const sessionEnd = index.find((e) => e.kind === "session-end");
  assert.equal(sessionEnd.restorableCount, 7);
  console.log("✓ previous session frozen as protected session-end checkpoint");

  const errors = [];
  const popup = await context.newPage();
  popup.on("pageerror", (e) => errors.push(`popup: ${e.message}`));
  await popup.setViewportSize({ width: 392, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
  await popup.getByText("Restore your previous session").waitFor();
  await wait(400);
  if (shots) await popup.screenshot({ path: path.join(shots, "popup-light.png") });
  console.log("✓ popup offers the previous session");

  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.locator(".entry-main").first().click();
  await popup.locator(".entry-body .tab-tree").waitFor();
  await wait(300);
  if (shots) await popup.screenshot({ path: path.join(shots, "popup-dark-expanded.png") });
  await popup.emulateMedia({ colorScheme: "light" });

  // chrome.tabs.discard segfaults Chromium while a DevTools session (Playwright) is attached to
  // the tab. Without DevTools it works normally, so lazy loading is turned off for this run only;
  // it's covered by the unit tests instead.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: { lazyRestore: false } }));
  await popup.getByRole("button", { name: "Restore session" }).click();
  const confirm = popup.getByRole("button", { name: /Open \d+ tabs?\?/ });
  const expected = Number((await confirm.innerText()).match(/\d+/)[0]);
  await confirm.click();

  const wanted = Array.from({ length: 7 }, (_, i) => `${base}/page/${i}`);
  const restored = await waitFor(async () => {
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const urls = new Set(tabs.map((t) => t.url || t.pendingUrl));
    return wanted.every((url) => urls.has(url)) ? tabs : null;
  }, "all 7 saved URLs open");
  const ours = restored.filter((t) => (t.url || t.pendingUrl || "").startsWith(base));
  assert.equal(ours.length, 7, "no duplicates: tabs that were already open are skipped");
  assert.ok(
    restored.some((t) => t.pinned && (t.url || t.pendingUrl).endsWith("/page/0")),
    "pinned tab restored"
  );
  console.log(`✓ restored ${expected} missing tabs into the saved windows, no duplicates, pin kept`);

  const status = await waitFor(async () => {
    const { restoreStatus } = await storage(worker, "restoreStatus");
    return restoreStatus?.state === "done" ? restoreStatus : null;
  }, "restore status");
  assert.equal(status.created, expected);

  // Manager page
  await worker.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  const manager = await context.newPage();
  manager.on("pageerror", (e) => errors.push(`manager: ${e.message}`));
  await manager.setViewportSize({ width: 1280, height: 800 });
  await manager.goto(`chrome-extension://${extensionId}/src/ui/manager.html#${sessionEnd.id}`);
  await manager.locator(".tab-tree").waitFor();
  await wait(400);
  if (shots) await manager.screenshot({ path: path.join(shots, "manager-light.png") });

  await manager.locator("#search").fill("ramen");
  await manager.getByText("“ramen”").waitFor();
  await wait(300);
  if (shots) {
    await manager.emulateMedia({ colorScheme: "dark" });
    await manager.screenshot({ path: path.join(shots, "manager-search-dark.png") });
    await manager.emulateMedia({ colorScheme: "light" });
  }
  console.log("✓ manager search finds tabs across snapshots");

  await manager.locator("#search").fill("");
  await manager.locator("#open-settings").click();
  await wait(300);
  if (shots) await manager.screenshot({ path: path.join(shots, "manager-settings.png") });

  assert.deepEqual(errors, [], "no uncaught errors in extension pages");
  await context.close();
}

server.close();
console.log("All end-to-end checks passed.");
