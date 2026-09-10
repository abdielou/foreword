// Finds and reads the author's other articles so their output, not their
// bio, is what gets judged. Service workers have no DOM, so extraction is
// regex based: strip scripts and styles, keep paragraph text, read the
// title and date from meta tags.

const TIMEOUT_MS = 10000;
const CONCURRENCY = 4;
const MAX_CHARS = 7000;

function withTimeout(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function sameSite(a, b) {
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (!ha || !hb) return false;
  const root = (h) => h.split(".").slice(-2).join(".");
  return root(ha) === root(hb);
}

// Paths that are article-shaped rather than section, tag or author pages.
const ARTICLE_PATH_RE = /\/(\d{4}\/\d{1,2}(\/\d{1,2})?\/|story\/|article\/|news\/|politics\/|opinion\/|[a-z0-9-]{20,})/i;
const NOT_ARTICLE_RE = /\/(author|authors|writer|writers|staff|people|profile|tag|tags|topic|topics|category|section|search|video|videos|live|newsletter|about|contact|privacy|terms|subscribe|login|signin)\b/i;

export function looksLikeArticle(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (NOT_ARTICLE_RE.test(u.pathname)) return false;
    if (u.pathname.length < 12) return false;
    return ARTICLE_PATH_RE.test(u.pathname + "/");
  } catch {
    return false;
  }
}

function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, "i");
    const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`, "i"));
    if (m) return decode(m[1]);
  }
  return null;
}

/** Plain text of an article page: title, date, author line, body paragraphs. */
export function extractArticle(html, url) {
  const head = html.slice(0, 300000);
  const title = meta(head, ["og:title", "twitter:title"]) || decode((head.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim() || null;
  const date = meta(head, ["article:published_time", "datePublished", "date", "pubdate", "parsely-pub-date"]) || null;
  const byline = meta(head, ["author", "article:author", "parsely-author", "byl"]) || null;

  // Prefer the <article> element when present; otherwise the whole document.
  const artMatch = html.match(/<article\b[\s\S]*?<\/article>/i);
  let scope = artMatch ? artMatch[0] : html;
  scope = scope
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|aside|header|form|figure|figcaption|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ");
  const paras = [];
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(scope))) {
    const t = decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (t.length >= 40 && !/^(advertisement|subscribe|sign up|read more|related:)/i.test(t)) paras.push(t);
  }
  let text = paras.join("\n\n");
  if (text.length < 400 && !artMatch) {
    // Fall back to the largest run of text in the document.
    const stripped = decode(scope.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    text = stripped.slice(0, MAX_CHARS);
  }
  return {
    url,
    title,
    date,
    byline,
    text: text.slice(0, MAX_CHARS),
    ok: text.length >= 400,
  };
}

async function fetchText(url) {
  const res = await fetch(url, { signal: withTimeout(TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type && !/html|xml|text/i.test(type)) throw new Error(`not html (${type.split(";")[0]})`);
  return res.text();
}

/** Links on an author page that look like articles on the same site. */
export function articleLinksFrom(html, pageUrl) {
  const out = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = decode(m[1]);
    try {
      href = new URL(href, pageUrl).href.replace(/[?#].*$/, "");
    } catch {
      continue;
    }
    if (sameSite(href, pageUrl) && looksLikeArticle(href) && href !== pageUrl.replace(/[?#].*$/, "")) out.add(href);
  }
  return [...out];
}

function surnameMatches(byline, author) {
  if (!byline || !author) return true; // no byline meta is common; do not exclude
  const sur = author.trim().split(/\s+/).pop().toLowerCase();
  return byline.toLowerCase().includes(sur);
}

/**
 * Collects the author's articles: candidates from the gathered sources on the
 * outlet's site, plus links scraped from the author page. Fetches up to `limit`,
 * keeps the ones that read as full articles and whose byline (when present)
 * matches the author.
 *
 * @returns {Promise<{ articles: object[], attempts: object[] }>}
 */
export async function collectArticles({ author, articleUrl, authorUrl, sourceUrls = [], limit = 8 }) {
  const attempts = [];
  const candidates = new Set();
  const own = (articleUrl || "").replace(/[?#].*$/, "");

  for (const u of sourceUrls) {
    if (articleUrl && sameSite(u, articleUrl) && looksLikeArticle(u) && u.replace(/[?#].*$/, "") !== own) candidates.add(u.replace(/[?#].*$/, ""));
  }
  if (authorUrl) {
    try {
      const html = await fetchText(authorUrl);
      const links = articleLinksFrom(html, authorUrl).filter((l) => l !== own);
      attempts.push({ source: "Author page", target: authorUrl, ok: true, count: links.length });
      for (const l of links) candidates.add(l);
    } catch (e) {
      attempts.push({ source: "Author page", target: authorUrl, ok: false, count: 0, error: (e?.message || String(e)).slice(0, 80) });
    }
  }

  const list = [...candidates].slice(0, Math.max(limit * 2, limit + 4));
  const articles = [];
  for (let i = 0; i < list.length && articles.length < limit; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (u) => extractArticle(await fetchText(u), u)));
    results.forEach((r, j) => {
      const u = batch[j];
      if (r.status !== "fulfilled") {
        attempts.push({ source: "Article", target: u, ok: false, count: 0, error: (r.reason?.message || String(r.reason)).slice(0, 80) });
        return;
      }
      const a = r.value;
      if (!a.ok) {
        attempts.push({ source: "Article", target: u, ok: false, count: 0, error: "no article text found" });
        return;
      }
      if (!surnameMatches(a.byline, author)) {
        attempts.push({ source: "Article", target: u, ok: false, count: 0, error: `byline is ${a.byline}` });
        return;
      }
      if (articles.length < limit) {
        articles.push(a);
        attempts.push({ source: "Article", target: u, ok: true, count: 1 });
      }
    });
  }
  articles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { articles: articles.map((a, i) => ({ id: `a${i + 1}`, ...a })), attempts };
}
