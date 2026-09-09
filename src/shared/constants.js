// Shared constants for Author Lens. Imported by the service worker,
// panel, popup and options pages (all ES modules).

export const STORAGE_KEYS = {
  settings: "settings",
  cachePrefix: "profile:",
};

// Suggested OpenRouter model ids. The options page also loads the live list.
export const SUGGESTED_MODELS = [
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.1",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
];
export const SUGGESTED_SEARCH_MODELS = ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-3.5-haiku"];

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "anthropic/claude-sonnet-4.5",
  searchModel: "openai/gpt-4o-mini",
  maxSearches: 8,
  resultsPerSearch: 5,
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
  LIST_MODELS: "al:list-models",     // options -> worker
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
