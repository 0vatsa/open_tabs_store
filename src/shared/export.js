import { EXPORT_FORMAT, SCHEMA_VERSION } from "./constants.js";

/** items: [{ entry, windows }] */
export function buildJsonExport(items, exportedAt = Date.now()) {
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt,
      snapshots: items.map(({ entry, windows }) => ({
        createdAt: entry.createdAt,
        kind: entry.kind,
        label: entry.label || "",
        windows
      }))
    },
    null,
    2
  );
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

export function buildHtmlExport(items, title = "Open Tabs Store export") {
  const sections = items
    .map(({ entry, windows }) => {
      const heading = `${new Date(entry.createdAt).toLocaleString()}${entry.label ? ` — ${entry.label}` : ""}`;
      const wins = windows
        .map(
          (win, i) =>
            `<h3>Window ${i + 1}</h3>\n<ul>\n${win.tabs
              .map((tab) => `  <li><a href="${escapeHtml(tab.url)}">${escapeHtml(tab.title || tab.url)}</a></li>`)
              .join("\n")}\n</ul>`
        )
        .join("\n");
      return `<section>\n<h2>${escapeHtml(heading)}</h2>\n${wins}\n</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#0f172a}a{color:#4f46e5}h2{border-bottom:1px solid #e2e8f0;padding-bottom:.25rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sections}
</body>
</html>
`;
}

export function buildTextExport(items) {
  return items
    .map(({ entry, windows }) => {
      const heading = `# ${new Date(entry.createdAt).toLocaleString()}${entry.label ? ` — ${entry.label}` : ""}`;
      const wins = windows
        .map(
          (win, i) =>
            `## Window ${i + 1}\n${win.tabs.map((tab) => `- [${tab.title || tab.url}](${tab.url})`).join("\n")}`
        )
        .join("\n\n");
      return `${heading}\n\n${wins}`;
    })
    .join("\n\n");
}
