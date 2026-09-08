import { MODELS, MSG } from "../shared/constants.js";
import { getSettings, saveSettings } from "../shared/storage.js";

const $ = (id) => document.getElementById(id);

for (const m of MODELS) {
  const o = document.createElement("option");
  o.value = m.id;
  o.textContent = m.label;
  $("model").appendChild(o);
}

async function load() {
  const s = await getSettings();
  $("apiKey").value = s.apiKey;
  $("apiBaseUrl").value = s.apiBaseUrl || "";
  $("model").value = s.model;
  $("effort").value = s.effort;
  $("maxSearches").value = s.maxSearches;
  $("cacheDays").value = s.cacheDays;
  $("showBadge").checked = s.showBadge;
  $("autoAnalyze").checked = s.autoAnalyze;
  $("panelSide").value = s.panelSide;
  refreshCacheInfo();
}

async function refreshCacheInfo() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "al:cache-stats" });
    $("cacheInfo").textContent = r?.count
      ? `${r.count} cached profile${r.count === 1 ? "" : "s"} (${(r.bytes / 1024).toFixed(0)} KB).`
      : "No cached profiles.";
  } catch {
    $("cacheInfo").textContent = "";
  }
}

function setStatus(node, text, ok) {
  node.textContent = text;
  node.className = `status ${ok == null ? "" : ok ? "ok" : "bad"}`;
}

$("toggleKey").addEventListener("click", () => {
  const i = $("apiKey");
  i.type = i.type === "password" ? "text" : "password";
  $("toggleKey").textContent = i.type === "password" ? "Show" : "Hide";
});

$("testKey").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) return setStatus($("keyStatus"), "Enter a key first.", false);
  setStatus($("keyStatus"), "Testing…");
  const r = await chrome.runtime.sendMessage({ type: MSG.TEST_KEY, apiKey: key, apiBaseUrl: $("apiBaseUrl").value.trim() });
  setStatus($("keyStatus"), r?.ok ? "Key works." : `Key rejected: ${r?.error || "unknown error"}`, Boolean(r?.ok));
});

$("save").addEventListener("click", async () => {
  await saveSettings({
    apiKey: $("apiKey").value.trim(),
    apiBaseUrl: $("apiBaseUrl").value.trim(),
    model: $("model").value,
    effort: $("effort").value,
    maxSearches: Math.max(1, Math.min(20, parseInt($("maxSearches").value, 10) || 8)),
    cacheDays: Math.max(0, Math.min(365, parseInt($("cacheDays").value, 10) || 0)),
    showBadge: $("showBadge").checked,
    autoAnalyze: $("autoAnalyze").checked,
    panelSide: $("panelSide").value,
  });
  setStatus($("saveStatus"), "Saved.", true);
  setTimeout(() => setStatus($("saveStatus"), ""), 2000);
});

$("clearCache").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE });
  $("cacheInfo").textContent = `Cleared ${r?.cleared ?? 0} cached profile${r?.cleared === 1 ? "" : "s"}.`;
});

load();
