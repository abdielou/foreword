import { MSG } from "../shared/constants.js";

const $ = (id) => document.getElementById(id);
let tab = null;
let detection = null;

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}
$("options").addEventListener("click", openOptions);
$("nokey-link").addEventListener("click", (e) => {
  e.preventDefault();
  openOptions();
});

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("detail").textContent = "Open a web article to use Foreword.";
    $("go").disabled = true;
    return;
  }
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: MSG.GET_DETECTION, tabId: tab.id });
  } catch {
    /* ignore */
  }
  detection = res?.detection || null;
  if (res?.settings && !res.settings.hasApiKey) $("nokey").hidden = false;

  if (!detection) {
    // Content script may not have run (e.g. page loaded before install). Ask it directly.
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "al:get-page-detection" });
      detection = r?.detection || null;
    } catch {
      $("detail").textContent = "Reload the page to let Foreword read it.";
    }
  }
  if (detection?.author) {
    $("author").value = detection.author;
    const bits = [];
    if (detection.publication) bits.push(detection.publication);
    if (detection.coAuthors?.length) bits.push(`with ${detection.coAuthors.join(", ")}`);
    if (detection.title) bits.push(`“${detection.title.slice(0, 80)}${detection.title.length > 80 ? "…" : ""}”`);
    $("detail").textContent = bits.join(" · ");
    $("author").addEventListener("input", () => {
      if ($("author").value.trim() !== detection.author) $("detail").textContent = "Custom name: the page's publication and topic are still used for context.";
    });
    if (res?.settings) {
      const c = await chrome.runtime.sendMessage({ type: MSG.CACHE_LOOKUP, author: detection.author, publication: detection.publication });
      if (c?.entry) $("status").textContent = `Profile cached ${new Date(c.entry.savedAt).toLocaleDateString()}.`;
    }
  } else if (!$("detail").textContent) {
    $("detail").textContent = "No byline found. Type the author's name.";
  }
}

$("go").addEventListener("click", async () => {
  const name = $("author").value.trim();
  if (!name || !tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG.OPEN_PANEL, author: name });
    window.close();
  } catch {
    $("status").textContent = "Couldn't reach the page. Reload it and try again.";
  }
});

$("author").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("go").click();
});

init();
