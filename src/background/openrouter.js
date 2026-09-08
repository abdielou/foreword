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

import { PROFILE_SCHEMA, SYSTEM_PROMPT, buildUserMessage, buildQueries } from "./prompt.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/abdielou/author-lens",
  "X-Title": "Author Lens",
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
  if (status === 401) return "The OpenRouter API key was rejected. Check it in Author Lens options.";
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

// --------------------------------------------------------------- synthesize
function responseFormat() {
  return {
    type: "json_schema",
    json_schema: { name: "author_profile", strict: true, schema: PROFILE_SCHEMA },
  };
}

async function synthesize(settings, article, sources, onProgress, signal) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(article, sources) },
  ];
  const base = {
    model: settings.model,
    messages,
    stream: true,
    max_tokens: 8000,
    temperature: 0.2,
  };

  let res;
  let structured = true;
  try {
    res = await post("/chat/completions", { ...base, response_format: responseFormat() }, settings.apiKey, signal);
  } catch (e) {
    // Models without structured-output support reject response_format; fall back to a prompt-only JSON request.
    if (e instanceof ApiError && e.status === 400) {
      structured = false;
      const fallbackMessages = [
        messages[0],
        {
          role: "user",
          content:
            messages[1].content +
            "\n\nRespond with a single JSON object and nothing else. It must match this JSON schema exactly:\n" +
            JSON.stringify(PROFILE_SCHEMA),
        },
      ];
      res = await post("/chat/completions", { ...base, messages: fallbackMessages }, settings.apiKey, signal);
    } else {
      throw e;
    }
  }

  onProgress?.({ kind: "writing" });
  let chars = 0;
  const out = await readStream(res, (chunk) => {
    chars += chunk.length;
    if (chars % 400 < chunk.length) onProgress?.({ kind: "writing", chars });
  });

  if (out.finishReason === "length") {
    throw new ApiError("The response was cut off before the profile was complete. Try again or pick a model with a larger output limit.", { retryable: true });
  }
  if (out.finishReason === "content_filter") {
    throw new ApiError("The model declined to profile this author.");
  }
  const profile = extractJson(out.text);
  if (!profile) {
    throw new ApiError("The model returned no usable profile. Try again or pick a different model.", { retryable: true });
  }
  return { profile, usage: out.usage, model: out.model || settings.model, structured };
}

// ------------------------------------------------------------------ public
export async function researchAuthor(settings, article, onProgress, signal) {
  if (!settings.apiKey) {
    throw new ApiError("No OpenRouter API key set. Open Author Lens options to add one.", { status: 0 });
  }
  if (!settings.model) {
    throw new ApiError("No model selected. Open Author Lens options to choose one.", { status: 0 });
  }

  const { sources, queries, failures } = await gatherSources(settings, article, onProgress, signal);
  onProgress?.({ kind: "gathered", count: sources.length, searches: queries.length });

  const { profile, usage, model, structured } = await synthesize(settings, article, sources, onProgress, signal);

  // Keep the model honest: only sources we actually provided can be cited.
  const known = new Map(sources.map((s) => [s.id, s]));
  profile.sources = (profile.sources || []).filter((s) => known.has(s.id) || /^https?:\/\//.test(s.url || ""));

  return {
    profile,
    meta: {
      model,
      requestedModel: settings.model,
      searchModel: settings.searchModel || settings.model,
      searches: queries.length,
      searchFailures: failures,
      sourceCount: sources.length,
      structuredOutput: structured,
      usage: usage || null,
      generatedAt: Date.now(),
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
