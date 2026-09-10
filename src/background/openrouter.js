// OpenRouter client for the extension service worker.
//
// OpenRouter exposes an OpenAI-compatible chat completions API in front of
// many models, plus a "web" plugin that attaches search results to a request
// and returns them as url_citation annotations. The plugin runs one search
// per request, so research happens in two stages:
//
//   1. gather   - several templated queries run in parallel on a cheap model
//                 with the web plugin; we keep the annotations (sources).
//   2. synthesize - the main model reads the article context plus every
//                 gathered source and writes the structured profile.

import {
  PROFILE_SCHEMA,
  FRAMING_SCHEMA,
  COMPARISON_SCHEMA,
  CORPUS_SCHEMA,
  buildUserMessage,
  buildQueries,
  eventQuery,
  domainOf,
  framingSystemPrompt,
  framingUserMessage,
  comparisonSystemPrompt,
  comparisonUserMessage,
  corpusSystemPrompt,
  corpusUserMessage,
  dashboardSystemPrompt,
} from "./prompt.js";
import { PIPELINE_VERSION } from "../shared/constants.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/abdielou/foreword",
  "X-Title": "Foreword",
};

export class ApiError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryable = Boolean(retryable);
  }
}

function headers(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...APP_HEADERS,
  };
}

async function readErrorBody(res) {
  try {
    const j = await res.json();
    return j?.error?.message || j?.message || "";
  } catch {
    return "";
  }
}

function friendlyStatus(status, detail) {
  if (status === 401) return "The OpenRouter API key was rejected. Check it in Foreword options.";
  if (status === 402) return "OpenRouter reports insufficient credits on this key.";
  if (status === 403) return `OpenRouter refused the request${detail ? `: ${detail}` : ""}.`;
  if (status === 404) return `Model not found on OpenRouter${detail ? `: ${detail}` : ""}. Check the model id in options.`;
  if (status === 408 || status === 504) return "The model timed out. Try again.";
  if (status === 429) return "Rate limited by OpenRouter. Try again in a moment.";
  if (status >= 500) return "OpenRouter or the model provider is unavailable. Try again shortly.";
  if (status === 400) return `OpenRouter rejected the request${detail ? `: ${detail}` : ""}.`;
  return `OpenRouter error ${status}${detail ? `: ${detail}` : ""}`;
}

async function post(path, body, apiKey, signal) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError("Could not reach OpenRouter. Check your network connection.", { retryable: true });
  }
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new ApiError(friendlyStatus(res.status, detail), {
      status: res.status,
      retryable: res.status === 429 || res.status === 408 || res.status >= 500,
    });
  }
  return res;
}

// ---------------------------------------------------------------- streaming
// Reads an OpenAI-style SSE stream. Returns { text, annotations, finishReason, usage, model }.
async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const annotations = [];
  let finishReason = null;
  let usage = null;
  let model = null;

  const handle = (evt) => {
    if (evt.error) {
      throw new ApiError(evt.error.message || "Stream error", { retryable: true });
    }
    if (evt.model) model = evt.model;
    if (evt.usage) usage = evt.usage;
    const choice = evt.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onDelta?.(delta.content);
    }
    if (Array.isArray(delta.annotations)) annotations.push(...delta.annotations);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue; // comments like ": OPENROUTER PROCESSING"
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      handle(evt);
    }
  }
  return { text, annotations, finishReason, usage, model };
}

function extractJson(text) {
  const t = (text || "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

// ------------------------------------------------------------------ gather
function normalizeCitation(a) {
  const c = a?.url_citation || a;
  if (!c?.url) return null;
  return {
    url: c.url,
    title: c.title || c.url,
    content: (c.content || "").slice(0, 1200),
  };
}

async function runSearch(settings, query, signal) {
  const body = {
    model: settings.searchModel || settings.model,
    plugins: [
      {
        id: "web",
        engine: "exa",
        max_results: Math.max(1, Math.min(10, Number(settings.resultsPerSearch) || 5)),
      },
    ],
    messages: [
      {
        role: "system",
        content: "You are a search relay. Reply with the single word OK. Do not summarize.",
      },
      { role: "user", content: query },
    ],
    max_tokens: 8,
    stream: false,
  };
  const res = await post("/chat/completions", body, settings.apiKey, signal);
  const j = await res.json();
  const msg = j?.choices?.[0]?.message || {};
  const anns = Array.isArray(msg.annotations) ? msg.annotations : [];
  return { results: anns.map(normalizeCitation).filter(Boolean), usage: j?.usage || null };
}

async function gatherSources(settings, article, onProgress, signal) {
  const queries = buildQueries(article).slice(0, Math.max(1, Math.min(12, Number(settings.maxSearches) || 6)));
  const byUrl = new Map();
  let done = 0;
  let failures = 0;
  let lastError = null;

  await Promise.all(
    queries.map(async (q) => {
      onProgress?.({ kind: "search", query: q, searches: done + 1 });
      try {
        const { results } = await runSearch(settings, q, signal);
        for (const r of results) {
          if (!byUrl.has(r.url)) byUrl.set(r.url, { ...r, queries: [q] });
          else byUrl.get(r.url).queries.push(q);
        }
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        failures++;
        lastError = e;
      } finally {
        done++;
      }
    })
  );

  // A key problem (401/402) on every search should surface as such, not as "no sources".
  if (failures === queries.length && lastError) throw lastError;

  const sources = Array.from(byUrl.values()).map((s, i) => ({ id: `s${i + 1}`, ...s }));
  return { sources, queries, failures };
}

// ------------------------------------------------------- structured calls
function responseFormat(name, schema) {
  return { type: "json_schema", json_schema: { name, strict: true, schema } };
}

/**
 * One structured call on the writing model. Tries response_format first; a
 * model that rejects it gets the schema in the prompt instead.
 */
async function complete(settings, { name, schema, system, user, maxTokens = 6000, onProgress, signal }) {
  const base = {
    model: settings.model,
    stream: true,
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  let res;
  let structured = true;
  try {
    res = await post("/chat/completions", { ...base, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: responseFormat(name, schema) }, settings.apiKey, signal);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      structured = false;
      const fallback = user + "\n\nRespond with a single JSON object and nothing else. It must match this JSON schema exactly:\n" + JSON.stringify(schema);
      res = await post("/chat/completions", { ...base, messages: [{ role: "system", content: system }, { role: "user", content: fallback }] }, settings.apiKey, signal);
    } else {
      throw e;
    }
  }
  const out = await readStream(res, (chunk) => onProgress?.(chunk.length));
  if (out.finishReason === "length") throw new ApiError(`The ${name} response was cut off. Try again or pick a model with a larger output limit.`, { retryable: true });
  if (out.finishReason === "content_filter") throw new ApiError(`The model declined the ${name} step.`);
  const json = extractJson(out.text);
  if (!json) throw new ApiError(`The model returned no usable ${name} result. Try again or pick a different model.`, { retryable: true });
  return { json, usage: out.usage, model: out.model || settings.model, structured };
}

// ------------------------------------------------------------- comparison
async function searchEvent(settings, article, signal) {
  const q = eventQuery(article);
  if (!q) return { query: "", items: [] };
  const own = domainOf(article.url);
  const { results } = await runSearch({ ...settings, resultsPerSearch: Math.max(6, Number(settings.resultsPerSearch) || 5) }, q, signal);
  const items = results
    .filter((r) => domainOf(r.url) && domainOf(r.url) !== own)
    .map((r) => ({ title: r.title, url: r.url, outlet: domainOf(r.url), content: r.content }))
    .slice(0, 10);
  return { query: q, items };
}

// ------------------------------------------------------------------ public
/**
 * @param {object} hooks
 * @param {(urls: string[]) => Promise<{accounts, posts}>} [hooks.fetchSocial]
 * @param {(input: {author, articleUrl, authorUrl, sourceUrls, limit}) => Promise<{articles, attempts}>} [hooks.collectArticles]
 */
export async function researchAuthor(settings, article, onProgress, signal, hooks = {}) {
  if (!settings.apiKey) throw new ApiError("No OpenRouter API key set. Open Foreword options to add one.", { status: 0 });
  if (!settings.model) throw new ApiError("No model selected. Open Foreword options to choose one.", { status: 0 });

  const usage = { calls: 0, tokens: 0 };
  const track = (r) => {
    usage.calls++;
    usage.tokens += r?.usage?.total_tokens || 0;
    return r;
  };
  const label = { x: "X", bluesky: "Bluesky", mastodon: "Mastodon" };

  // 1. Web search for sources.
  const { sources, queries, failures } = await gatherSources(settings, article, onProgress, signal);
  onProgress?.({ kind: "gathered", count: sources.length, searches: queries.length });
  const sourceUrls = sources.map((s) => s.url);

  // 2. In parallel: the author's posts, the author's other articles, other outlets' headlines.
  onProgress?.({ kind: "reading" });
  const [socialR, articlesR, eventR] = await Promise.allSettled([
    hooks.fetchSocial ? hooks.fetchSocial(sourceUrls) : Promise.resolve({ accounts: [], posts: [] }),
    hooks.collectArticles
      ? hooks.collectArticles({ author: article.author, articleUrl: article.url, authorUrl: article.authorUrl, sourceUrls, limit: Math.max(0, Math.min(15, Number(settings.corpusSize) || 8)) })
      : Promise.resolve({ articles: [], attempts: [] }),
    article.title ? searchEvent(settings, article, signal) : Promise.resolve({ query: "", items: [] }),
  ]);
  const social = socialR.status === "fulfilled" ? socialR.value : { accounts: [], posts: [] };
  const corpus = articlesR.status === "fulfilled" ? articlesR.value : { articles: [], attempts: [{ source: "Articles", target: "", ok: false, count: 0, error: articlesR.reason?.message || "failed" }] };
  const event = eventR.status === "fulfilled" ? eventR.value : { query: "", items: [] };
  const accounts = social.accounts || [];
  for (const post of (social.posts || []).slice(0, 80)) {
    const a = accounts[post.account] || {};
    sources.push({ id: `s${sources.length + 1}`, title: `${label[a.kind] || "Post"} post by @${a.handle || "?"}${post.date ? ` (${post.date.slice(0, 10)})` : ""}`, url: post.url, content: post.text, queries: [] });
  }
  onProgress?.({ kind: "read", accounts: accounts.length, posts: (social.posts || []).length, articles: corpus.articles.length, coverage: event.items.length });

  // 3. In parallel: audit this article, compare its headline, analyze the corpus.
  onProgress?.({ kind: "analyzing" });
  const [framingR, comparisonR, corpusR] = await Promise.allSettled([
    article.fullText && article.fullText.length > 300
      ? complete(settings, { name: "framing_audit", schema: FRAMING_SCHEMA, system: framingSystemPrompt(), user: framingUserMessage(article), maxTokens: 3000, signal }).then(track)
      : Promise.reject(new Error("article text not captured")),
    event.items.length >= 2
      ? complete(settings, { name: "headline_comparison", schema: COMPARISON_SCHEMA, system: comparisonSystemPrompt(), user: comparisonUserMessage(article, event.items), maxTokens: 2500, signal }).then(track)
      : Promise.reject(new Error(event.query ? `only ${event.items.length} other items found` : "no headline to compare")),
    corpus.articles.length >= 2
      ? complete(settings, { name: "corpus_analysis", schema: CORPUS_SCHEMA, system: corpusSystemPrompt(), user: corpusUserMessage(article, corpus.articles), maxTokens: 5000, signal }).then(track)
      : Promise.reject(new Error(corpus.articles.length ? "only one article could be read" : "no articles could be read")),
  ]);
  const pick = (r) => (r.status === "fulfilled" ? r.value.json : null);
  const why = (r) => (r.status === "rejected" ? (r.reason?.message || String(r.reason)).slice(0, 120) : null);
  const analyses = {
    framing: pick(framingR),
    comparison: pick(comparisonR),
    corpus: pick(corpusR),
    articles: corpus.articles.map(({ id, title, url, date }) => ({ id, title, url, date })),
  };
  onProgress?.({ kind: "analyzed", framing: Boolean(analyses.framing), comparison: Boolean(analyses.comparison), corpus: Boolean(analyses.corpus) });

  // 4. The dashboard.
  onProgress?.({ kind: "writing" });
  let chars = 0;
  const dash = track(
    await complete(settings, {
      name: "author_dashboard",
      schema: PROFILE_SCHEMA,
      system: dashboardSystemPrompt(),
      user: buildUserMessage(article, sources, accounts, analyses),
      maxTokens: 8000,
      signal,
      onProgress: (n) => {
        chars += n;
        if (chars % 400 < n) onProgress?.({ kind: "writing", chars });
      },
    })
  );
  const profile = dash.json;

  // Only sources we actually provided can be cited.
  const known = new Set([...sources.map((s) => s.id), ...corpus.articles.map((a) => a.id)]);
  profile.sources = (profile.sources || []).filter((s) => known.has(s.id) || /^https?:\/\//.test(s.url || ""));
  // Articles read in full are citable even if the model forgot to list them.
  for (const a of corpus.articles) {
    if (!profile.sources.some((s) => s.id === a.id)) profile.sources.push({ id: a.id, title: a.title || a.url, url: a.url, publisher: article.publication || null, date: a.date || null });
  }

  return {
    profile,
    meta: {
      model: dash.model,
      requestedModel: settings.model,
      searchModel: settings.searchModel || settings.model,
      searches: queries.length,
      searchFailures: failures,
      sourceCount: sources.length,
      structuredOutput: dash.structured,
      usage,
      accounts,
      analyses: {
        framing: analyses.framing,
        comparison: analyses.comparison ? { ...analyses.comparison, query: event.query } : null,
        corpus: analyses.corpus,
        skipped: { framing: why(framingR), comparison: why(comparisonR), corpus: why(corpusR) },
      },
      articles: analyses.articles,
      articleAttempts: corpus.attempts || [],
      generatedAt: Date.now(),
      schemaVersion: PIPELINE_VERSION,
    },
  };
}

/** Validates a key by reading its metadata. */
export async function testApiKey(apiKey) {
  for (const path of ["/key", "/auth/key"]) {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, { headers: headers(apiKey) });
    } catch {
      return { ok: false, error: "could not reach OpenRouter (network error)" };
    }
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      const d = j?.data || {};
      const bits = [];
      if (d.label) bits.push(d.label);
      if (typeof d.usage === "number") bits.push(`used $${d.usage.toFixed(2)}`);
      if (typeof d.limit === "number") bits.push(`limit $${d.limit.toFixed(2)}`);
      if (d.limit_remaining != null) bits.push(`remaining $${Number(d.limit_remaining).toFixed(2)}`);
      return { ok: true, info: bits.join(" · ") };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: "key rejected" };
    // 404: try the other path
  }
  return { ok: false, error: "could not validate the key" };
}

/** Public model list (no key required). Returns [{id, name, prompt, completion, structured}]. */
export async function listModels() {
  const res = await fetch(`${BASE_URL}/models`, { headers: APP_HEADERS });
  if (!res.ok) throw new ApiError(`Could not load the model list (HTTP ${res.status}).`);
  const j = await res.json();
  return (j?.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    created: m.created || 0,
    prompt: Number(m.pricing?.prompt || 0) * 1e6,
    completion: Number(m.pricing?.completion || 0) * 1e6,
    context: m.context_length || null,
    structured: Array.isArray(m.supported_parameters)
      ? m.supported_parameters.includes("structured_outputs") || m.supported_parameters.includes("response_format")
      : null,
  }));
}
