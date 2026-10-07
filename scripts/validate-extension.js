#!/usr/bin/env node
// Structural checks for the unpacked extension: manifest, referenced files, and module imports.
// Behaviour is covered by `npm test` (unit) and `tests/e2e/smoke.mjs` (real browser).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const check = (condition, message) => condition || problems.push(message);
const exists = (rel) => fs.existsSync(path.join(root, rel));

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

check(manifest.manifest_version === 3, "manifest_version must be 3");
for (const permission of ["tabs", "tabGroups", "storage", "unlimitedStorage", "alarms", "favicon"]) {
  check(manifest.permissions?.includes(permission), `missing permission: ${permission}`);
}
check(manifest.background?.type === "module", "background must be an ES module service worker");

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {})
].filter(Boolean);
for (const file of referenced) check(exists(file), `manifest references a missing file: ${file}`);

// Every relative import, <script src> and stylesheet must resolve; no remote code.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

for (const file of walk(path.join(root, "src"))) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  const refs = [];
  if (file.endsWith(".js")) {
    for (const match of text.matchAll(/(?:import|export)[^"'`]*?from\s*["']([^"']+)["']/g)) refs.push(match[1]);
  }
  if (file.endsWith(".html")) {
    for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) refs.push(match[1]);
  }
  for (const ref of refs) {
    check(!/^https?:/.test(ref), `${rel} loads remote code: ${ref}`);
    if (ref.startsWith(".")) {
      check(fs.existsSync(path.resolve(path.dirname(file), ref)), `${rel} references a missing file: ${ref}`);
    }
  }
  check(!/\beval\(|new Function\(/.test(text), `${rel} uses eval/new Function (blocked by extension CSP)`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ manifest and ${referenced.length} referenced files OK; all module imports resolve`);
