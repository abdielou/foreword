// Shared constants for Author Lens. Imported by the service worker,
// panel, popup and options pages (all ES modules).

export const STORAGE_KEYS = {
  settings: "settings",
  cachePrefix: "profile:",
};

export const MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 (recommended)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (faster, cheaper)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable, most expensive)" },
];

export const EFFORTS = ["low", "medium", "high", "xhigh"];

export const DEFAULT_SETTINGS = {
  apiKey: "",
  apiBaseUrl: "",
  model: "claude-opus-5",
  effort: "high",
  maxSearches: 8,
  cacheDays: 14,
  autoAnalyze: false,
  showBadge: true,
  panelSide: "right",
};

// Message types exchanged between content script, panel, popup and worker.
export const MSG = {
  DETECTED: "al:detected",          // content -> worker: article/author detected on a tab
  GET_DETECTION: "al:get-detection", // popup -> worker
  OPEN_PANEL: "al:open-panel",       // popup -> content
  CLOSE_PANEL: "al:close-panel",     // panel -> content (via window.postMessage)
  ANALYZE: "al:analyze",             // panel -> worker (port)
  CACHE_LOOKUP: "al:cache-lookup",   // panel/popup -> worker
  CLEAR_CACHE: "al:clear-cache",     // options -> worker
  TEST_KEY: "al:test-key",           // options -> worker
  PORT_NAME: "al:analysis",
};

export function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cacheKey(author, publication) {
  const pub = (publication || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${STORAGE_KEYS.cachePrefix}${normalizeName(author)}|${pub}`;
}
