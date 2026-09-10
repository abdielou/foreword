import { MSG, SUGGESTED_MODELS, SUGGESTED_SEARCH_MODELS, PIPELINE_VERSION } from "../shared/constants.js";
import { getSettings, saveSettings } from "../shared/storage.js";
import { getBuildInfo, formatBuildInfo } from "../shared/version.js";

const $ = (id) => document.getElementById(id);
let models = [];

function fillDatalist(list) {
  const dl = $("modelList");
  dl.replaceChildren();
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m.id;
    o.label = m.name && m.name !== m.id ? `${m.name} — $${m.prompt.toFixed(2)}/$${m.completion.toFixed(2)} per M` : "";
    dl.appendChild(o);
  }
}

function describeModel(id, node) {
  if (!id) return setStatus(node, "");
  if (!models.length) return setStatus(node, "");
  const m = models.find((x) => x.id === id);
  if (!m) return setStatus(node, "Not in OpenRouter's current model list. Check the id.", false);
  const bits = [`$${m.prompt.toFixed(2)} in / $${m.completion.toFixed(2)} out per million tokens`];
  if (m.context) bits.push(`${Math.round(m.context / 1000)}k context`);
  if (m.structured === false) bits.push("no structured output (falls back to prompt-only JSON)");
  setStatus(node, bits.join(" · "), true);
}

async function loadModels() {
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.LIST_MODELS });
    if (r?.ok && r.models?.length) {
      models = r.models.sort((a, b) => a.id.localeCompare(b.id));
      fillDatalist(models);
      fillProviders();
      describeModel($("model").value.trim(), $("modelStatus"));
      describeModel($("searchModel").value.trim(), $("searchModelStatus"));
      return;
    }
  } catch {
    /* fall through */
  }
  fillDatalist([...SUGGESTED_MODELS, ...SUGGESTED_SEARCH_MODELS].map((id) => ({ id, name: id, prompt: 0, completion: 0 })));
}

async function load() {
  const s = await getSettings();
  $("apiKey").value = s.apiKey;
  $("model").value = s.model || "";
  $("searchModel").value = s.searchModel || "";
  $("maxSearches").value = s.maxSearches;
  $("resultsPerSearch").value = s.resultsPerSearch;
  $("corpusSize").value = s.corpusSize;
  $("cacheDays").value = s.cacheDays;
  $("showBadge").checked = s.showBadge;
  $("autoAnalyze").checked = s.autoAnalyze;
  $("panelSide").value = s.panelSide;
  refreshCacheInfo();
  loadModels();
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
  const r = await chrome.runtime.sendMessage({ type: MSG.TEST_KEY, apiKey: key });
  setStatus($("keyStatus"), r?.ok ? `Key works${r.info ? ` (${r.info})` : ""}.` : `Key rejected: ${r?.error || "unknown error"}`, Boolean(r?.ok));
});

function newestFrom(provider) {
  return models
    .filter((m) => m.id.startsWith(`${provider}/`) && m.structured !== false && !/:free|:beta|:thinking|:extended|:online|nitro|preview|exp/i.test(m.id))
    .sort((a, b) => b.created - a.created)[0];
}

function fillProviders() {
  const sel = $("pickProvider");
  while (sel.options.length > 1) sel.remove(1);
  const counts = new Map();
  for (const m of models) {
    const p = m.id.split("/")[0];
    if (m.id.includes("/")) counts.set(p, (counts.get(p) || 0) + 1);
  }
  const providers = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  for (const p of providers) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    sel.appendChild(o);
  }
}

$("pickProvider").addEventListener("change", () => {
  const provider = $("pickProvider").value;
  $("pickProvider").value = "";
  if (!provider) return;
  const m = newestFrom(provider);
  if (!m) return setStatus($("modelStatus"), `No suitable model found for ${provider}.`, false);
  $("model").value = m.id;
  describeModel(m.id, $("modelStatus"));
});

$("model").addEventListener("change", () => describeModel($("model").value.trim(), $("modelStatus")));
$("searchModel").addEventListener("change", () => describeModel($("searchModel").value.trim(), $("searchModelStatus")));

$("save").addEventListener("click", async () => {
  await saveSettings({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    searchModel: $("searchModel").value.trim(),
    maxSearches: Math.max(1, Math.min(12, parseInt($("maxSearches").value, 10) || 6)),
    resultsPerSearch: Math.max(1, Math.min(10, parseInt($("resultsPerSearch").value, 10) || 5)),
    corpusSize: Math.max(0, Math.min(15, parseInt($("corpusSize").value, 10) ?? 8)),
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
getBuildInfo()
  .then(async (info) => {
    $("build").textContent = formatBuildInfo(info);
    if (info.hash) $("build").title = `commit ${info.hash}`;
    let running = 0;
    try {
      running = (await chrome.runtime.sendMessage({ type: MSG.VERSION }))?.pipeline || 0;
    } catch {
      running = 0;
    }
    if (running < PIPELINE_VERSION) {
      const w = document.createElement("p");
      w.className = "status bad";
      w.textContent = `Files on disk are pipeline v${PIPELINE_VERSION} but the background worker is running v${running || "?"}. Reload the extension on chrome://extensions.`;
      $("build").after(w);
    } else {
      $("build").textContent += ` · worker v${running}`;
    }
  })
  .catch(() => {
    $("build").textContent = `v${chrome.runtime.getManifest().version}`;
  });
