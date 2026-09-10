import { MSG, PIPELINE_VERSION } from "../shared/constants.js";
import {
  getSettings,
  getCachedProfile,
  setCachedProfile,
  clearProfileCache,
  cacheStats,
} from "../shared/storage.js";
import { researchAuthor, testApiKey, listModels, ApiError } from "./openrouter.js";
import { lookupWikipedia } from "./wikipedia.js";
import { collectImages, fetchSocialPosts } from "./images.js";
import { collectArticles } from "./articles.js";

// ---------- per-tab detection state ----------
// Kept in session storage so it survives worker restarts.
const DETECTION_KEY = "detections";

async function getDetections() {
  const s = await chrome.storage.session.get(DETECTION_KEY);
  return s[DETECTION_KEY] || {};
}

async function setDetection(tabId, detection) {
  const all = await getDetections();
  if (detection) all[tabId] = detection;
  else delete all[tabId];
  await chrome.storage.session.set({ [DETECTION_KEY]: all });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  setDetection(tabId, null).catch(() => {});
});

async function updateBadge(tabId, detection) {
  try {
    await chrome.action.setBadgeText({ tabId, text: detection?.author ? "•" : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#3b6ea5" });
    await chrome.action.setTitle({
      tabId,
      title: detection?.author ? `Foreword: ${detection.author}` : "Foreword",
    });
  } catch {
    /* tab may be gone */
  }
}

// ---------- keepalive while a long request is in flight ----------
let activeJobs = 0;
let keepAliveTimer = null;
function jobStarted() {
  activeJobs++;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  }
}
function jobFinished() {
  activeJobs = Math.max(0, activeJobs - 1);
  if (activeJobs === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---------- one-shot messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case MSG.DETECTED: {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: false };
        await setDetection(tabId, { ...msg.detection, tabId });
        await updateBadge(tabId, msg.detection);
        const settings = await getSettings();
        return { ok: true, settings: publicSettings(settings) };
      }
      case MSG.GET_DETECTION: {
        const tabId = msg.tabId ?? sender.tab?.id;
        const all = await getDetections();
        const settings = await getSettings();
        return { ok: true, detection: all[tabId] || null, settings: publicSettings(settings) };
      }
      case MSG.CACHE_LOOKUP: {
        const settings = await getSettings();
        const entry = await getCachedProfile(msg.author, msg.publication, settings.cacheDays);
        return { ok: true, entry };
      }
      case MSG.CLEAR_CACHE: {
        const n = await clearProfileCache();
        return { ok: true, cleared: n };
      }
      case "al:cache-stats":
        return { ok: true, ...(await cacheStats()) };
      case MSG.TEST_KEY:
        return await testApiKey(msg.apiKey);
      case MSG.LIST_MODELS:
        return { ok: true, models: await listModels() };
      case MSG.VERSION:
        return { ok: true, pipeline: PIPELINE_VERSION };
      default:
        return { ok: false, error: "unknown message" };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true; // async response
});

function publicSettings(s) {
  return {
    hasApiKey: Boolean(s.apiKey),
    model: s.model,
    autoAnalyze: s.autoAnalyze,
    showBadge: s.showBadge,
    panelSide: s.panelSide,
    cacheDays: s.cacheDays,
  };
}

// ---------- analysis over a long-lived port ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MSG.PORT_NAME) return;
  let controller = null;

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== MSG.ANALYZE) return;
    controller = new AbortController();
    const send = (m) => {
      try {
        port.postMessage(m);
      } catch {
        /* port closed */
      }
    };
    jobStarted();
    try {
      const settings = await getSettings();
      const { author, publication } = msg.article;

      if (!msg.force) {
        const cached = await getCachedProfile(author, publication, settings.cacheDays);
        if (cached) {
          if (!Array.isArray(cached.meta?.images)) {
            // Profile predates the photo collector: add photos without re-running the model.
            send({ type: "status", stage: "enriching", text: "Collecting recent photos…" });
            const enriched = await enrichWithImages(cached, msg.article);
            send({ type: "result", entry: enriched, fromCache: true });
            return;
          }
          send({ type: "result", entry: cached, fromCache: true });
          return;
        }
      }

      send({ type: "status", stage: "starting", text: `Researching ${author}…` });
      const { profile, meta } = await researchAuthor(
        settings,
        msg.article,
        (e) => {
          if (e.kind === "search") {
            send({ type: "status", stage: "searching", text: `Searching: ${e.query}`, searches: e.searches });
          } else if (e.kind === "gathered") {
            send({ type: "status", stage: "searching", text: `${e.count} sources found.` });
          } else if (e.kind === "reading") {
            send({ type: "status", stage: "reading", text: "Reading the author's articles, posts, and other outlets' headlines…" });
          } else if (e.kind === "read") {
            const bits = [];
            bits.push(`${e.articles} article${e.articles === 1 ? "" : "s"} read`);
            if (e.posts) bits.push(`${e.posts} posts from ${e.accounts} account${e.accounts === 1 ? "" : "s"}`);
            if (e.coverage) bits.push(`${e.coverage} other headlines`);
            send({ type: "status", stage: "reading", text: bits.join(", ") + "." });
          } else if (e.kind === "analyzing") {
            send({ type: "status", stage: "analyzing", text: "Auditing this article, comparing headlines, reading the body of work…" });
          } else if (e.kind === "analyzed") {
            const done = [e.framing && "article audit", e.comparison && "headline comparison", e.corpus && "corpus analysis"].filter(Boolean);
            send({ type: "status", stage: "analyzing", text: done.length ? `Done: ${done.join(", ")}. Building the dashboard…` : "Analyses skipped for lack of material. Building the dashboard…" });
          } else if (e.kind === "writing" && e.chars) {
            send({ type: "status", stage: "writing", text: `Writing the profile… (${Math.round(e.chars / 100) / 10}k characters)` });
          }
        },
        controller.signal,
        { fetchSocial: fetchSocialPosts, collectArticles }
      );

      send({ type: "status", stage: "enriching", text: "Looking up Wikipedia…" });
      let wikipedia = null;
      try {
        wikipedia = await lookupWikipedia({
          name: profile.name || author,
          profiles: profile.profiles || [],
          sources: profile.sources || [],
          publication,
        });
      } catch {
        wikipedia = null;
      }

      send({ type: "status", stage: "enriching", text: "Collecting recent photos…" });
      const photos = await gatherPhotos(profile, meta, wikipedia, msg.article, author);

      const entry = await setCachedProfile(author, publication, profile, { ...meta, wikipedia, ...photos, article: msg.article });
      send({ type: "result", entry, fromCache: false });
    } catch (e) {
      if (e?.name === "AbortError") {
        send({ type: "error", error: "Cancelled.", cancelled: true });
      } else {
        send({
          type: "error",
          error: e instanceof ApiError ? e.message : `Unexpected error: ${e?.message || e}`,
          retryable: e instanceof ApiError ? e.retryable : true,
          noKey: e instanceof ApiError && e.status === 0,
        });
      }
    } finally {
      jobFinished();
    }
  });

  port.onDisconnect.addListener(() => {
    controller?.abort();
  });
});

async function gatherPhotos(profile, meta, wikipedia, article, author) {
  try {
    const profiles = [...(profile.profiles || [])];
    for (const a of meta?.accounts || []) profiles.push({ label: a.kind, url: a.url });
    if (wikipedia?.url) profiles.push({ label: "Wikipedia", url: wikipedia.url });
    const r = await collectImages({
      name: profile.name || author,
      profiles,
      sourceUrls: (profile.sources || []).map((s) => s.url),
      authorUrl: article?.authorUrl || null,
      authorImage: article?.authorImage || null,
      publication: article?.publication || "",
    });
    return { images: r.images, handles: r.handles, photoAttempts: r.attempts, photosAt: Date.now() };
  } catch (e) {
    return { images: [], handles: [], photoAttempts: [{ source: "collector", target: "", ok: false, count: 0, error: e?.message || String(e) }], photosAt: Date.now() };
  }
}

async function enrichWithImages(cached, article) {
  const { profile, meta } = cached;
  const photos = await gatherPhotos(profile, meta, meta?.wikipedia, article, article?.author);
  return setCachedProfile(article.author, article.publication, profile, { ...meta, ...photos, article: meta?.article || article });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const settings = await getSettings();
    if (!settings.apiKey) chrome.runtime.openOptionsPage();
  }
});
