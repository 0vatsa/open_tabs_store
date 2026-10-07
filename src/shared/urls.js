const BLOCKED_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "chrome-untrusted://",
  "chrome-search://",
  "devtools://",
  "brave://",
  "edge://",
  "view-source:",
  "javascript:",
  "data:"
];

export function isRestorableUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  if (BLOCKED_PREFIXES.some((prefix) => url.startsWith(prefix))) return false;
  if (url.startsWith("about:")) {
    return url === "about:blank" || url.startsWith("about:blank#");
  }
  return true;
}

export function domainOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "Local file";
    return parsed.hostname.replace(/^www\./, "") || url;
  } catch {
    return url || "";
  }
}
