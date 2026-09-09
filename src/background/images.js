// Collects recent, public photos of the author from social profiles and
// open image sources. Everything here is best-effort: each source has a
// short timeout, failures are swallowed, and results are merged, deduped
// and sorted newest first.
//
// Sources, in rough order of freshness:
//   Bluesky   public API: avatar + recent posts with images (dated)
//   Mastodon  public instance API: avatar + recent media posts (dated)
//   X         public syndication timeline: profile image + recent tweet photos
//   Commons   Wikimedia Commons file search: several dated photos
//   Pages     og:image from author pages, personal sites, Substack, etc.
//
// Each image: { url, sourceUrl, source, date, kind, caption }
//   kind: "avatar" | "post" | "photo"

const TIMEOUT_MS = 8000;
const MAX_IMAGES = 48;
const MAX_PAGES = 14;      // source pages scraped for images
const PAGE_CONCURRENCY = 6;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

function withTimeout(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

// Short-lived memo so the post collector and the image collector share fetches.
const memo = new Map();
const MEMO_MS = 120000;
function memoized(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
  const promise = fn().catch((e) => {
    memo.delete(key);
    throw e;
  });
  memo.set(key, { at: Date.now(), promise });
  return promise;
}

function getJson(url) {
  return memoized(url, async () => {
    const res = await fetch(url, { signal: withTimeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

function getText(url) {
  return memoized(url, async () => {
    const res = await fetch(url, { signal: withTimeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ------------------------------------------------------------ url parsing
export function classifyProfileUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if ((host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") && parts.length >= 1) {
    const handle = parts[0].replace(/^@/, "");
    if (!/^(home|search|explore|i|intent|share|hashtag|settings|login)$/i.test(handle) && /^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      return { kind: "x", handle, url: `https://x.com/${handle}` };
    }
  }
  if (host === "bsky.app" && parts[0] === "profile" && parts[1]) {
    return { kind: "bluesky", handle: parts[1], url: `https://bsky.app/profile/${parts[1]}` };
  }
  // Other pages on social hosts (search, status pages without a handle) are not worth fetching.
  if (/^(x\.com|twitter\.com|mobile\.twitter\.com|bsky\.app)$/.test(host)) return { kind: "closed", url: raw };
  // Mastodon: https://instance/@user or https://instance/users/user
  if (parts.length >= 1 && /^@[A-Za-z0-9_.-]+$/.test(parts[0]) && !/^(threads\.net|instagram\.com|youtube\.com|tiktok\.com|x\.com|twitter\.com|medium\.com|substack\.com)$/.test(host)) {
    return { kind: "mastodon", instance: host, handle: parts[0].slice(1), url: `https://${host}/@${parts[0].slice(1)}` };
  }
  if (parts.length >= 2 && parts[0] === "users" && /^[A-Za-z0-9_.-]+$/.test(parts[1]) && !/github\.com|reddit\.com/.test(host)) {
    return { kind: "mastodon", instance: host, handle: parts[1], url: `https://${host}/@${parts[1]}` };
  }
  if (/(^|\.)wikipedia\.org$/.test(host)) return { kind: "wikipedia", url: raw };
  if (/(^|\.)(linkedin\.com|instagram\.com|threads\.net|facebook\.com|tiktok\.com|youtube\.com)$/.test(host)) {
    return { kind: "closed", url: raw };
  }
  if (u.protocol === "https:") return { kind: "page", url: raw };
  return null;
}

// --------------------------------------------------------------- bluesky
async function fromBluesky(handle) {
  const out = [];
  const base = "https://public.api.bsky.app/xrpc/";
  const profile = await getJson(`${base}app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  const sourceUrl = `https://bsky.app/profile/${profile.handle || handle}`;
  if (profile.avatar) {
    out.push({ url: profile.avatar, sourceUrl, source: "Bluesky", date: null, kind: "avatar", caption: "Bluesky profile photo" });
  }
  try {
    const feed = await getJson(`${base}app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&filter=posts_with_media&limit=25`);
    for (const item of feed.feed || []) {
      const post = item.post;
      if (!post || post.author?.handle !== (profile.handle || handle)) continue; // skip reposts
      const date = isoDate(post.record?.createdAt || post.indexedAt);
      const rkey = (post.uri || "").split("/").pop();
      const postUrl = rkey ? `${sourceUrl}/post/${rkey}` : sourceUrl;
      const images = [];
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.fullsize || n.thumb) images.push({ url: n.fullsize || n.thumb, alt: n.alt || "" });
        for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
      };
      walk(post.embed);
      for (const im of images.slice(0, 2)) {
        out.push({ url: im.url, sourceUrl: postUrl, source: "Bluesky", date, kind: "post", caption: im.alt ? im.alt.slice(0, 80) : "Bluesky post" });
      }
      if (out.length >= 10) break;
    }
  } catch {
    /* feed unavailable */
  }
  return out;
}

// -------------------------------------------------------------- mastodon
async function fromMastodon(instance, handle) {
  const out = [];
  const acct = await getJson(`https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`);
  const sourceUrl = acct.url || `https://${instance}/@${handle}`;
  if (acct.avatar || acct.avatar_static) {
    out.push({ url: acct.avatar || acct.avatar_static, sourceUrl, source: "Mastodon", date: null, kind: "avatar", caption: "Mastodon profile photo" });
  }
  try {
    const statuses = await getJson(`https://${instance}/api/v1/accounts/${acct.id}/statuses?only_media=true&exclude_reblogs=true&limit=20`);
    for (const st of statuses || []) {
      const date = isoDate(st.created_at);
      for (const m of (st.media_attachments || []).filter((m) => m.type === "image").slice(0, 2)) {
        out.push({ url: m.url || m.preview_url, sourceUrl: st.url || sourceUrl, source: "Mastodon", date, kind: "post", caption: (m.description || "Mastodon post").slice(0, 80) });
      }
      if (out.length >= 10) break;
    }
  } catch {
    /* statuses unavailable */
  }
  return out;
}

// --------------------------------------------------------------------- x
// The syndication endpoint backs embedded timelines and serves without
// login. It is not a documented API, so parse defensively.
async function loadX(handle) {
  const html = await getText(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  let user = null;
  const tweets = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || typeof n !== "object" || depth > 12) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    if (typeof n.profile_image_url_https === "string" && n.screen_name?.toLowerCase() === handle.toLowerCase()) {
      user = user || n;
    }
    if (n.created_at && (typeof n.full_text === "string" || typeof n.text === "string") && n.user?.screen_name?.toLowerCase() === handle.toLowerCase()) {
      const id = n.id_str || `${n.created_at}:${(n.full_text || n.text).slice(0, 20)}`;
      if (!seen.has(id)) {
        seen.add(id);
        tweets.push(n);
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(data, 0);
  return { user, tweets };
}

async function fromX(handle) {
  const out = [];
  const sourceUrl = `https://x.com/${handle}`;
  try {
    const loaded = await loadX(handle);
    if (loaded) {
      const { user, tweets } = loaded;
      if (user?.profile_image_url_https) {
        out.push({ url: user.profile_image_url_https.replace(/_normal(\.\w+)$/, "_400x400$1"), sourceUrl, source: "X", date: null, kind: "avatar", caption: "X profile photo" });
      }
      for (const t of tweets) {
        if (!Array.isArray(t.entities?.media)) continue;
        const date = isoDate(t.created_at);
        const tweetUrl = t.id_str ? `${sourceUrl}/status/${t.id_str}` : sourceUrl;
        for (const md of t.entities.media.filter((x) => x.type === "photo" && x.media_url_https).slice(0, 2)) {
          out.push({ url: md.media_url_https, sourceUrl: tweetUrl, source: "X", date, kind: "post", caption: "X post" });
        }
        if (out.length >= 10) break;
      }
    }
  } catch {
    /* endpoint unavailable */
  }
  if (!out.length) {
    // Avatar-only fallback through a public avatar resolver.
    out.push({ url: `https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`, sourceUrl, source: "X", date: null, kind: "avatar", caption: "X profile photo" });
  }
  return out;
}

// ---------------------------------------------------------------- commons
async function fromCommons(name) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: `"${name}"`,
    gsrnamespace: "6",
    gsrlimit: "12",
    prop: "imageinfo",
    iiprop: "url|timestamp|extmetadata|mime",
    iiurlwidth: "600",
  });
  const j = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = Object.values(j?.query?.pages || {});
  const surname = name.trim().split(/\s+/).pop().toLowerCase();
  const out = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime || "")) continue;
    const title = (p.title || "").toLowerCase();
    if (surname.length > 2 && !title.includes(surname)) continue;
    const meta = info.extmetadata || {};
    const date = isoDate(meta.DateTimeOriginal?.value) || isoDate(info.timestamp);
    out.push({
      url: info.thumburl || info.url,
      sourceUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      source: "Wikimedia Commons",
      date,
      kind: "photo",
      caption: (meta.ImageDescription?.value || p.title.replace(/^File:/, "")).replace(/<[^>]+>/g, "").slice(0, 80),
    });
  }
  return out;
}

// ------------------------------------------------------------------ pages
function absolute(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

async function fromPage(url, label) {
  const html = await getText(url);
  const head = html.slice(0, 200000);
  const pick = (re) => {
    const m = head.match(re);
    return m ? m[1] : null;
  };
  const og =
    pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i);
  if (!og) return [];
  const abs = absolute(url, og.replace(/&amp;/g, "&"));
  if (!abs) return [];
  // Skip obvious site-wide logos.
  if (/logo|favicon|default|placeholder|sprite|icon/i.test(abs) && !IMAGE_EXT.test(abs)) return [];
  const host = new URL(url).hostname.replace(/^www\./, "");
  return [{ url: abs, sourceUrl: url, source: label || host, date: null, kind: "photo", caption: `${label || host} page image` }];
}


// ---------------------------------------------------- generic page scraping
// Service workers have no DOMParser, so parse the markup with regexes.
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const JUNK_RE = /(sprite|icon|favicon|logo|placeholder|default[-_]?(avatar|user|profile)|blank|spacer|pixel|tracking|1x1|transparent|loading|lazy[-_]?load|advert|banner|share|social[-_]?icon|emoji|flag|badge|button|arrow|chevron|search|menu|close|play[-_]?button|paywall|subscribe|newsletter)/i;
const PHOTO_HINT_RE = /(author|byline|headshot|portrait|profile|avatar|staff|contributor|columnist|reporter|writer|mug|bio|people|person|face)/i;

function attrOf(tag, name) {
  const m =
    tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) ||
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i")) ||
    tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"));
  return m ? m[1].trim() : null;
}

// Largest candidate in a srcset.
function fromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  let bestW = -1;
  for (const part of srcset.split(",")) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const w = /(\d+)w/.exec(bits[1] || "") ? Number(RegExp.$1) : /(\d+(?:\.\d+)?)x/.test(bits[1] || "") ? Number(RegExp.$1) * 1000 : 0;
    if (w > bestW) {
      bestW = w;
      best = bits[0];
    }
  }
  return best;
}

function nameTokens(name) {
  const parts = (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return { parts, surname: parts[parts.length - 1] || "", slug: parts.join("[-_ .]?") };
}

// The hostname often carries the publication's name, which can collide with
// the author's, so name matching only ever looks at the path.
function urlPath(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname + u.search).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function fileName(url) {
  const path = urlPath(url);
  return path.split("/").filter(Boolean).pop() || path;
}

function scoreImage({ url, alt, tag, context }, name) {
  // A junk filename is disqualifying no matter what surrounds it.
  if (JUNK_RE.test(fileName(url))) return 0;
  const { parts, surname } = nameTokens(name);
  const path = urlPath(url);
  const hay = `${path} ${alt || ""} ${context || ""}`.toLowerCase();
  let score = 0;
  if (surname && new RegExp(`\\b${surname}\\b`).test((alt || "").toLowerCase())) score += 6;
  if (surname && new RegExp(surname).test(path)) score += 5;
  if (parts.length > 1 && parts.every((w) => hay.includes(w))) score += 4;
  if (PHOTO_HINT_RE.test(path) || PHOTO_HINT_RE.test(alt || "")) score += 3;
  else if (PHOTO_HINT_RE.test(context || "")) score += 2;
  if (tag === "meta") score += 2;
  if (JUNK_RE.test(path)) score -= 6;
  const declared = Number(attrOf(context || "", "width") || 0);
  if (declared && declared < 64) score -= 6;
  return score;
}

function usableImageUrl(base, raw) {
  if (!raw) return null;
  let u = raw.trim().replace(/&amp;/g, "&");
  if (!u || u.startsWith("data:") || /\.svg(\?|$)/i.test(u)) return null;
  if (u.startsWith("//")) u = `https:${u}`;
  const abs = absolute(base, u);
  if (!abs || !/^https?:\/\//.test(abs)) return null;
  return abs;
}

/** Every plausible photo on one page, scored for "is this the author". */
async function scrapePage(url, name, label) {
  const html = await getText(url);
  const head = html.slice(0, 400000);
  const found = [];

  const metaRe = /<meta[^>]+(?:property|name)\s*=\s*["'](og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi;
  let m;
  while ((m = metaRe.exec(head))) {
    const abs = usableImageUrl(url, attrOf(m[0], "content"));
    if (abs) found.push({ url: abs, alt: "", tag: "meta", context: m[0] });
  }
  // JSON-LD Person / ImageObject images
  const ldRe = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(head))) {
    const urls = m[1].match(/"(?:image|contentUrl|thumbnailUrl|logo)"\s*:\s*"([^"]+)"/g) || [];
    for (const raw of urls) {
      const abs = usableImageUrl(url, raw.split('"')[3]);
      if (abs) found.push({ url: abs, alt: "", tag: "meta", context: "json-ld" });
    }
  }
  IMG_TAG_RE.lastIndex = 0;
  while ((m = IMG_TAG_RE.exec(head))) {
    const tag = m[0];
    const src =
      attrOf(tag, "src") ||
      attrOf(tag, "data-src") ||
      attrOf(tag, "data-original") ||
      attrOf(tag, "data-lazy-src") ||
      fromSrcset(attrOf(tag, "srcset") || attrOf(tag, "data-srcset"));
    const abs = usableImageUrl(url, src);
    if (!abs) continue;
    // A little surrounding markup helps: class names, figcaption words.
    const around = head.slice(Math.max(0, m.index - 220), m.index + tag.length + 220);
    found.push({ url: abs, alt: attrOf(tag, "alt") || "", tag: "img", context: `${tag} ${around.replace(/<[^>]+>/g, " ")}` });
  }

  const host = new URL(url).hostname.replace(/^www\./, "");
  return found
    .map((f) => ({ ...f, score: scoreImage(f, name) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((f) => ({
      url: f.url,
      sourceUrl: url,
      source: label || host,
      date: null,
      kind: f.score >= 5 ? "photo" : "maybe",
      caption: (f.alt || `${label || host} page`).slice(0, 80),
      score: f.score,
    }));
}

// ------------------------------------------------------------ image search
// Open image search endpoints. Both are unofficial and may change or rate
// limit; each failure is recorded and the rest of the collector continues.
async function fromDuckDuckGoImages(query) {
  const q = encodeURIComponent(query);
  const shell = await getText(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`);
  const vqd = (shell.match(/vqd=["']?([\w-]{10,})["']?/) || [])[1];
  if (!vqd) throw new Error("no vqd token");
  const res = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,&p=1`, {
    signal: withTimeout(TIMEOUT_MS),
    headers: { accept: "application/json", referer: "https://duckduckgo.com/" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).slice(0, 12).map((r) => ({
    url: r.image,
    sourceUrl: r.url || r.image,
    source: hostOf(r.url) || "Image search",
    date: null,
    kind: "photo",
    caption: (r.title || "Image search result").slice(0, 80),
    score: 5,
  }));
}

async function fromBingImages(query) {
  const html = await getText(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`);
  const out = [];
  const re = /murl&quot;:&quot;(.*?)&quot;[\s\S]{0,400}?purl&quot;:&quot;(.*?)&quot;/g;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const img = m[1].replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
    const page = m[2].replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
    if (!/^https?:\/\//.test(img)) continue;
    out.push({ url: img, sourceUrl: page || img, source: hostOf(page) || "Image search", date: null, kind: "photo", caption: "Image search result", score: 5 });
  }
  if (!out.length) throw new Error("no results parsed");
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ wikidata
async function fromWikidata(name) {
  const search = await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&limit=3&search=${encodeURIComponent(name)}`);
  const hit = (search.search || [])[0];
  if (!hit) throw new Error("no entity");
  const ent = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*&property=P18&entity=${hit.id}`);
  const files = (ent.claims?.P18 || []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
  return files.slice(0, 3).map((file) => ({
    url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=600`,
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
    source: "Wikidata",
    date: null,
    kind: "photo",
    caption: `${hit.label || name}${hit.description ? ` — ${hit.description}` : ""}`.slice(0, 80),
    score: 6,
  }));
}

// ------------------------------------------------------------------ merge
function dedupeKey(url) {
  return url
    .replace(/[?#].*$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/(thumb|thumbs|resize|resized|crop)\//gi, "/")
    .replace(/[-_](\d{2,4})x(\d{2,4})(?=\.[a-z]{3,4}$)/i, "")
    .replace(/[-_](normal|bigger|mini|small|medium|large|thumb|thumbnail|\d{2,4}w)(?=\.[a-z]{3,4}$)/i, "")
    .replace(/^\d+px-/, "")
    .toLowerCase();
}

function dedupe(images) {
  const seen = new Map();
  for (const im of images) {
    if (!im?.url || !/^https?:\/\//.test(im.url)) continue;
    const key = dedupeKey(im.url);
    const prev = seen.get(key);
    // Keep the better-scored (or dated) copy of the same photo.
    if (!prev || (im.score || 0) > (prev.score || 0) || (!prev.date && im.date)) seen.set(key, prev ? { ...im, date: im.date || prev.date } : im);
  }
  return [...seen.values()];
}

function sortNewest(images) {
  const rank = { post: 0, avatar: 1, photo: 2, maybe: 4 };
  return images.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3);
  });
}

/**
 * Finds social handles in the model's profile links and in raw source URLs,
 * then queries each source in parallel.
 *
 * @param {{ name: string, profiles: {label:string,url:string}[], sourceUrls: string[], authorPageUrl?: string }} input
 * @returns {Promise<{ images: object[], handles: object[] }>}
 */
const AUTHOR_PAGE_RE = /\/(author|authors|writer|writers|columnist|columnists|contributor|contributors|staff|people|profile|profiles|journalist|journalists|reporter|reporters|byline|bylines|team|about|bio)s?\//i;
const AUTHOR_HOST_RE = /(^|\.)(muckrack\.com|substack\.com|medium\.com|linktr\.ee|about\.me)$/i;

function looksLikeAuthorPage(url) {
  try {
    const u = new URL(url);
    return AUTHOR_PAGE_RE.test(u.pathname) || AUTHOR_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {{ name, profiles, sourceUrls, authorUrl, authorImage, publication, queries }} input
 * @returns {Promise<{ images: object[], handles: object[], attempts: object[] }>}
 */
export async function collectImages({ name, profiles = [], sourceUrls = [], authorUrl = null, authorImage = null, publication = "" }) {
  const targets = new Map(); // key -> {kind, ...}
  const add = (raw, label) => {
    const c = classifyProfileUrl(raw);
    if (!c || c.kind === "closed" || c.kind === "wikipedia") return;
    const key = c.kind === "page" ? `page:${c.url.replace(/[?#].*$/, "")}` : `${c.kind}:${(c.instance || "") + (c.handle || "")}`.toLowerCase();
    if (!targets.has(key)) targets.set(key, { ...c, label });
  };
  if (authorUrl) add(authorUrl, "Author page");
  for (const p of profiles) add(p.url, p.label);
  for (const u of sourceUrls) {
    const c = classifyProfileUrl(u);
    if (c && c.kind !== "closed" && c.kind !== "wikipedia") add(u, null);
  }

  const attempts = [];
  const run = (label, target, fn) =>
    fn()
      .then((imgs) => {
        attempts.push({ source: label, target, ok: true, count: imgs.length });
        return imgs;
      })
      .catch((e) => {
        attempts.push({ source: label, target, ok: false, count: 0, error: (e?.message || String(e)).slice(0, 80) });
        return [];
      });

  // 1. Social accounts and structured sources run first; they are the most reliable.
  const tasks = [];
  const pageTargets = [];
  for (const t of targets.values()) {
    if (t.kind === "bluesky") tasks.push(run("Bluesky", `@${t.handle}`, () => fromBluesky(t.handle)));
    else if (t.kind === "mastodon") tasks.push(run("Mastodon", `@${t.handle}@${t.instance}`, () => fromMastodon(t.instance, t.handle)));
    else if (t.kind === "x") tasks.push(run("X", `@${t.handle}`, () => fromX(t.handle)));
    else if (t.kind === "page") pageTargets.push(t);
  }
  if (name) {
    tasks.push(run("Wikimedia Commons", name, () => fromCommons(name)));
    tasks.push(run("Wikidata", name, () => fromWikidata(name)));
  }

  // 2. Image search, the same thing you would type into a search engine.
  const searchQueries = [];
  if (name) {
    searchQueries.push(publication ? `${name} ${publication}` : name);
    searchQueries.push(`${name} journalist headshot`);
  }
  for (const q of searchQueries) {
    tasks.push(run("Image search (DuckDuckGo)", q, () => fromDuckDuckGoImages(q)));
    tasks.push(run("Image search (Bing)", q, () => fromBingImages(q)));
  }

  // 3. Every gathered page is scraped for photos of this person, author pages first.
  pageTargets.sort((a, b) => (looksLikeAuthorPage(b.url) ? 1 : 0) - (looksLikeAuthorPage(a.url) ? 1 : 0));
  const pages = pageTargets.slice(0, MAX_PAGES);
  const pageResults = [];
  for (let i = 0; i < pages.length; i += PAGE_CONCURRENCY) {
    const batch = pages.slice(i, i + PAGE_CONCURRENCY);
    pageResults.push(
      ...(await Promise.all(batch.map((t) => run(t.label || "Page", t.url, () => scrapePage(t.url, name, t.label)))))
    );
  }

  const settled = await Promise.allSettled(tasks);
  const images = [];
  if (authorImage && /^https?:\/\//.test(authorImage)) {
    images.push({ url: authorImage, sourceUrl: authorUrl || authorImage, source: "Article byline", date: null, kind: "avatar", caption: "Byline photo on the article", score: 9 });
    attempts.push({ source: "Article byline", target: authorImage, ok: true, count: 1 });
  }
  for (const s of settled) if (s.status === "fulfilled" && Array.isArray(s.value)) images.push(...s.value);
  for (const arr of pageResults) images.push(...arr);

  const handles = [...targets.values()].filter((t) => t.kind !== "page").map(({ kind, handle, instance, url }) => ({ kind, handle, instance, url }));
  return { images: sortNewest(dedupe(images)).slice(0, MAX_IMAGES), handles, attempts };
}

/** Best single headshot for the header: a profile photo or page image beats a post photo. */
export function pickHeadshot(images) {
  const rank = { avatar: 0, photo: 1, post: 2 };
  return [...(images || [])].sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3))[0] || null;
}

// ------------------------------------------------------------ recent posts
// Text of the author's recent public posts, used as evidence by the writing
// model. Each account carries its bio so the model can confirm identity.
const MAX_POSTS_PER_ACCOUNT = 30;
const MAX_POST_CHARS = 320;

async function postsFromBluesky(handle) {
  const base = "https://public.api.bsky.app/xrpc/";
  const profile = await getJson(`${base}app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  const h = profile.handle || handle;
  const url = `https://bsky.app/profile/${h}`;
  const account = { kind: "bluesky", handle: h, url, displayName: profile.displayName || null, bio: profile.description || null, followers: profile.followersCount ?? null };
  const posts = [];
  const feed = await getJson(`${base}app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&filter=posts_no_replies&limit=50`);
  for (const item of feed.feed || []) {
    const post = item.post;
    if (!post || item.reason || post.author?.handle !== h) continue; // skip reposts
    const text = (post.record?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const rkey = (post.uri || "").split("/").pop();
    posts.push({ url: rkey ? `${url}/post/${rkey}` : url, date: isoDate(post.record?.createdAt || post.indexedAt), text: text.slice(0, MAX_POST_CHARS) });
    if (posts.length >= MAX_POSTS_PER_ACCOUNT) break;
  }
  return { account, posts };
}

async function postsFromMastodon(instance, handle) {
  const acct = await getJson(`https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`);
  const url = acct.url || `https://${instance}/@${handle}`;
  const account = { kind: "mastodon", handle: `${handle}@${instance}`, url, displayName: acct.display_name || null, bio: stripHtml(acct.note) || null, followers: acct.followers_count ?? null };
  const posts = [];
  const statuses = await getJson(`https://${instance}/api/v1/accounts/${acct.id}/statuses?exclude_reblogs=true&exclude_replies=true&limit=40`);
  for (const st of statuses || []) {
    const text = stripHtml(st.content);
    if (!text) continue;
    posts.push({ url: st.url || url, date: isoDate(st.created_at), text: text.slice(0, MAX_POST_CHARS) });
    if (posts.length >= MAX_POSTS_PER_ACCOUNT) break;
  }
  return { account, posts };
}

async function postsFromX(handle) {
  const loaded = await loadX(handle);
  if (!loaded) throw new Error("no timeline");
  const { user, tweets } = loaded;
  const url = `https://x.com/${user?.screen_name || handle}`;
  const account = { kind: "x", handle: user?.screen_name || handle, url, displayName: user?.name || null, bio: user?.description || null, followers: user?.followers_count ?? null };
  const posts = [];
  for (const t of tweets) {
    const text = (t.full_text || t.text || "").replace(/\s+/g, " ").trim();
    if (!text || /^RT @/.test(text)) continue;
    posts.push({ url: t.id_str ? `${url}/status/${t.id_str}` : url, date: isoDate(t.created_at), text: text.slice(0, MAX_POST_CHARS) });
    if (posts.length >= MAX_POSTS_PER_ACCOUNT) break;
  }
  return { account, posts };
}

/**
 * Finds social handles among URLs and fetches each account's bio and recent posts.
 * @param {string[]} urls
 * @returns {Promise<{accounts: object[], posts: object[]}>} posts carry an `account` index
 */
export async function fetchSocialPosts(urls) {
  const targets = new Map();
  for (const u of urls) {
    const c = classifyProfileUrl(u);
    if (!c || !["x", "bluesky", "mastodon"].includes(c.kind)) continue;
    const key = `${c.kind}:${(c.instance || "") + (c.handle || "")}`.toLowerCase();
    if (!targets.has(key)) targets.set(key, c);
  }
  const tasks = [...targets.values()].slice(0, 6).map((t) => {
    if (t.kind === "bluesky") return postsFromBluesky(t.handle);
    if (t.kind === "mastodon") return postsFromMastodon(t.instance, t.handle);
    return postsFromX(t.handle);
  });
  const settled = await Promise.allSettled(tasks);
  const accounts = [];
  const posts = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value?.account) continue;
    const idx = accounts.push(s.value.account) - 1;
    for (const p of s.value.posts) posts.push({ ...p, account: idx });
  }
  posts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { accounts, posts };
}
