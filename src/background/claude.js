// Minimal Claude Messages API client for the extension service worker.
//
// The extension has no build step, so this talks to the API over fetch
// rather than through the npm SDK. It streams the response so the worker
// stays alive during long research turns and can report progress
// (each web search) back to the panel.

import { PROFILE_SCHEMA, SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_CONTINUATIONS = 4;

// Models that accept the server-side refusal fallback parameter.
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1", "claude-fable-5"]);

export class ClaudeError extends Error {
  constructor(message, { status, type, retryable } = {}) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
    this.type = type;
    this.retryable = Boolean(retryable);
  }
}

function baseUrl(settings) {
  const b = (settings.apiBaseUrl || "").trim().replace(/\/+$/, "");
  return b || DEFAULT_BASE_URL;
}
function apiUrl(settings) {
  return `${baseUrl(settings)}/v1/messages`;
}

function headers(settings) {
  const h = {
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": API_VERSION,
    // Required for direct calls from a browser context.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (FALLBACK_MODELS.has(settings.model)) {
    h["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  return h;
}

function requestBody(settings, messages) {
  const body = {
    model: settings.model,
    max_tokens: 16000,
    stream: true,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: Math.max(1, Math.min(20, Number(settings.maxSearches) || 8)),
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: PROFILE_SCHEMA },
    },
    messages,
  };
  if (settings.effort && settings.effort !== "high") {
    body.output_config.effort = settings.effort;
  }
  if (FALLBACK_MODELS.has(settings.model)) {
    body.fallbacks = "default";
  }
  return body;
}

async function throwForStatus(res) {
  let detail = "";
  let type = "";
  try {
    const j = await res.json();
    detail = j?.error?.message || "";
    type = j?.error?.type || "";
  } catch {
    /* body was not JSON */
  }
  const s = res.status;
  const friendly =
    s === 401 ? "The API key was rejected. Check it in Author Lens options."
    : s === 403 ? "This API key is not allowed to make that request."
    : s === 429 ? "Rate limited by the API. Try again in a moment."
    : s === 529 || s >= 500 ? "The API is overloaded or unavailable. Try again shortly."
    : s === 400 ? `The API rejected the request: ${detail || "bad request"}`
    : `API error ${s}${detail ? `: ${detail}` : ""}`;
  throw new ClaudeError(friendly, { status: s, type, retryable: s === 429 || s >= 500 });
}

// Reads an SSE stream and rebuilds the assistant message content blocks.
// Calls onEvent for progress-worthy moments.
async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks = [];
  const partialJson = [];
  let stopReason = null;
  let stopDetails = null;
  let usage = null;
  let model = null;

  const handle = (evt) => {
    switch (evt.type) {
      case "message_start":
        model = evt.message?.model || null;
        usage = evt.message?.usage || null;
        break;
      case "content_block_start": {
        const block = { ...evt.content_block };
        blocks[evt.index] = block;
        if (block.type === "server_tool_use" || block.type === "tool_use") {
          partialJson[evt.index] = "";
        }
        if (block.type === "text") block.text = block.text || "";
        if (block.type === "web_search_tool_result") {
          const n = Array.isArray(block.content) ? block.content.length : 0;
          onEvent?.({ kind: "search-result", count: n });
        }
        break;
      }
      case "content_block_delta": {
        const block = blocks[evt.index];
        if (!block) break;
        const d = evt.delta;
        if (d.type === "text_delta") {
          block.text += d.text;
        } else if (d.type === "input_json_delta") {
          partialJson[evt.index] += d.partial_json;
        } else if (d.type === "citations_delta") {
          block.citations = block.citations || [];
          block.citations.push(d.citation);
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks[evt.index];
        if (!block) break;
        if (partialJson[evt.index] !== undefined) {
          try {
            block.input = partialJson[evt.index] ? JSON.parse(partialJson[evt.index]) : {};
          } catch {
            block.input = {};
          }
          if (block.type === "server_tool_use" && block.name === "web_search") {
            onEvent?.({ kind: "search", query: block.input?.query || "" });
          }
        }
        break;
      }
      case "message_delta":
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.delta?.stop_details) stopDetails = evt.delta.stop_details;
        if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
        break;
      case "error":
        throw new ClaudeError(evt.error?.message || "Stream error", { type: evt.error?.type, retryable: true });
      default:
        break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = chunk.split("\n").filter((l) => l.startsWith("data:"));
      if (!dataLines.length) continue;
      const json = dataLines.map((l) => l.slice(5).trim()).join("");
      if (!json) continue;
      let evt;
      try {
        evt = JSON.parse(json);
      } catch {
        continue;
      }
      handle(evt);
    }
  }

  return { content: blocks.filter(Boolean), stopReason, stopDetails, usage, model };
}

function extractJson(content) {
  const texts = content.filter((b) => b.type === "text" && b.text?.trim());
  if (!texts.length) return null;
  // With a structured-output format the final text block is the JSON document.
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i].text.trim();
    try {
      return JSON.parse(t);
    } catch {
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(t.slice(start, end + 1));
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

/**
 * Researches an author and returns { profile, meta }.
 * onProgress receives { kind, ... } events: "search", "search-result", "writing", "continue".
 */
export async function researchAuthor(settings, article, onProgress, signal) {
  if (!settings.apiKey) {
    throw new ClaudeError("No API key set. Open Author Lens options to add one.", { status: 0 });
  }

  const messages = [{ role: "user", content: buildUserMessage(article) }];
  let result = null;
  let searches = 0;
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let servedBy = null;

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    let res;
    try {
      res = await fetch(apiUrl(settings), {
        method: "POST",
        headers: headers(settings),
        body: JSON.stringify(requestBody(settings, messages)),
        signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new ClaudeError("Could not reach the Claude API. Check your network connection.", { retryable: true });
    }
    if (!res.ok) await throwForStatus(res);

    result = await readStream(res, (e) => {
      if (e.kind === "search") searches++;
      onProgress?.({ ...e, searches });
    });
    if (result.usage) {
      for (const k of Object.keys(totalUsage)) totalUsage[k] += result.usage[k] || 0;
    }
    servedBy = result.model || servedBy;

    if (result.stopReason === "pause_turn") {
      // Server-side tool loop hit its iteration limit; resend to resume.
      messages.push({ role: "assistant", content: result.content });
      onProgress?.({ kind: "continue", searches });
      continue;
    }
    break;
  }

  if (result.stopReason === "refusal") {
    const why = result.stopDetails?.explanation ? ` (${result.stopDetails.explanation})` : "";
    throw new ClaudeError(`The model declined to profile this author${why}.`, { type: "refusal" });
  }
  if (result.stopReason === "max_tokens") {
    throw new ClaudeError("The response was cut off before the profile was complete. Try again.", { retryable: true });
  }

  const profile = extractJson(result.content);
  if (!profile) {
    throw new ClaudeError("The model returned no profile. Try again.", { retryable: true });
  }

  return {
    profile,
    meta: {
      model: servedBy || settings.model,
      requestedModel: settings.model,
      searches,
      usage: totalUsage,
      generatedAt: Date.now(),
    },
  };
}

/** Cheap credential check: lists models. */
export async function testApiKey(apiKey, apiBaseUrl) {
  let res;
  try {
    res = await fetch(`${baseUrl({ apiBaseUrl })}/v1/models?limit=1`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    });
  } catch {
    return { ok: false, error: "could not reach the API (network error)" };
  }
  if (res.ok) return { ok: true };
  let msg = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    msg = j?.error?.message || msg;
  } catch {
    /* ignore */
  }
  return { ok: false, error: msg };
}
