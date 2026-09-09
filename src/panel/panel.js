import { MSG } from "../shared/constants.js";

// ---------- read article context from the URL hash ----------
function readContext() {
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return {};
  }
}
let ctx = readContext();

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v; // only used with escaped content
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
};

const states = ["setup", "loading", "error", "profile"];
function show(state) {
  for (const s of states) $(s).hidden = s !== state;
  $("refresh").hidden = state !== "profile";
}

function closePanel() {
  window.parent.postMessage({ source: "foreword", type: MSG.CLOSE_PANEL }, "*");
}
$("close").addEventListener("click", closePanel);
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("error-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePanel();
});

// ---------- analysis over a port ----------
let port = null;
let searchCount = 0;

function analyze(force = false) {
  if (!ctx.author) {
    show("setup");
    return;
  }
  if (port) {
    try { port.disconnect(); } catch { /* ignore */ }
  }
  searchCount = 0;
  $("search-log").replaceChildren();
  $("loading-title").textContent = `Researching ${ctx.author}…`;
  $("loading-text").textContent = ctx.publication ? `for ${ctx.publication}` : "";
  show("loading");

  port = chrome.runtime.connect({ name: MSG.PORT_NAME });
  port.onMessage.addListener((m) => {
    if (m.type === "status") {
      $("loading-text").textContent = m.text || "";
      if (m.stage === "searching" && m.text?.startsWith("Searching:")) {
        searchCount = m.searches || searchCount + 1;
        const li = el("li", { text: m.text.replace(/^Searching:\s*/, "") });
        $("search-log").appendChild(li);
        while ($("search-log").children.length > 6) $("search-log").firstChild.remove();
      }
    } else if (m.type === "result") {
      render(m.entry, m.fromCache);
    } else if (m.type === "error") {
      if (m.cancelled) {
        show("setup");
        return;
      }
      $("error-text").textContent = m.error;
      $("error-options").hidden = !m.noKey;
      show("error");
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.postMessage({ type: MSG.ANALYZE, article: articleFromCtx(), force });
}

function articleFromCtx() {
  return {
    author: ctx.author,
    coAuthors: ctx.coAuthors || [],
    publication: ctx.publication || "",
    title: ctx.title || "",
    url: ctx.url || "",
    excerpt: ctx.excerpt || "",
    publishedAt: ctx.publishedAt || null,
    authorUrl: ctx.authorUrl || null,
    authorImage: ctx.authorImage || null,
  };
}

$("cancel").addEventListener("click", () => {
  if (port) port.disconnect();
  port = null;
  show("setup");
});
$("retry").addEventListener("click", () => analyze(true));
$("refresh").addEventListener("click", () => analyze(true));

$("name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  if (!name) return;
  ctx = { ...ctx, author: name };
  analyze(false);
});

// ---------- rendering ----------
function initials(name) {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
}

function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

function fmtDate(d, opts = { year: "numeric", month: "short" }) {
  if (!d) return null;
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return String(d);
  return t.toLocaleDateString(undefined, opts);
}

function srcLinks(ids, sourceMap) {
  const links = (ids || []).map((id) => sourceMap.get(id)).filter(Boolean);
  if (!links.length) return null;
  return el("span", { class: "src" }, ...links.flatMap((s, i) => [i ? " " : "", el("a", { href: safeUrl(s.url) || "#", target: "_blank", rel: "noopener", title: s.title, text: `[${String(s.id).replace(/^s/, "")}]` })]));
}

// ----- meters
// Each axis: five positions from left to right, plus "unclear".
const AXES = {
  political: { title: "Political", left: "Left", right: "Right", scale: ["left", "center-left", "center", "center-right", "right"], labels: { left: "Left", "center-left": "Center-left", center: "Center", "center-right": "Center-right", right: "Right" } },
  social: { title: "Social", left: "Progressive", right: "Traditional", scale: ["progressive", "leans-progressive", "mixed", "leans-traditional", "traditional"], labels: { progressive: "Progressive", "leans-progressive": "Leans progressive", mixed: "Mixed", "leans-traditional": "Leans traditional", traditional: "Traditional" } },
  economic: { title: "Economic", left: "Interventionist", right: "Free market", scale: ["interventionist", "leans-interventionist", "mixed", "leans-market", "free-market"], labels: { interventionist: "Interventionist", "leans-interventionist": "Leans interventionist", mixed: "Mixed", "leans-market": "Leans market", "free-market": "Free market" } },
  opinion: { title: "Opinion", left: "Reporting", right: "Advocacy", scale: ["reporting", "mostly-reporting", "mixed", "mostly-opinion", "advocacy"], labels: { reporting: "Reporting", "mostly-reporting": "Mostly reporting", mixed: "Mixed", "mostly-opinion": "Mostly opinion", advocacy: "Advocacy" } },
  lens: { title: "Lens", left: "Many views", right: "One lens", scale: ["many-perspectives", "mostly-balanced", "mixed", "mostly-one-lens", "single-lens"], labels: { "many-perspectives": "Many perspectives", "mostly-balanced": "Mostly balanced", mixed: "Mixed", "mostly-one-lens": "Mostly one lens", "single-lens": "Single lens" } },
};

function meter(key, data, sourceMap) {
  const ax = AXES[key];
  const pos = data?.position && ax.scale.indexOf(data.position);
  const known = pos != null && pos >= 0 && data.confidence !== "none";
  const conf = data?.confidence || "none";
  const track = el("div", { class: `track${known ? "" : " unknown"}` }, ...ax.scale.map((_, i) => el("span", { class: `seg${known && i === pos ? " on" : ""}` })));
  const value = known ? ax.labels[data.position] : "Not enough evidence";
  return el(
    "div",
    { class: `meter conf-${conf}` },
    el("div", { class: "meter-head" }, el("span", { class: "meter-title", text: ax.title }), el("span", { class: "meter-value", text: value }), known ? el("span", { class: `conf ${conf}`, text: conf, title: `${conf} confidence` }) : null),
    el("div", { class: "meter-row" }, el("span", { class: "end", text: ax.left }), track, el("span", { class: "end r", text: ax.right })),
    known && data.why ? el("div", { class: "why" }, data.why, srcLinks(data.sourceIds, sourceMap)) : null
  );
}

function tile(title, ...children) {
  return el("section", { class: "tile" }, el("h2", { text: title }), ...children);
}

function evidenceItem(e, sourceMap) {
  const s = sourceMap.get(e.sourceId);
  const kindLabel = { post: "post", article: "article", bio: "bio", record: "record", interview: "interview", other: "" }[e.kind] || "";
  const where = [s?.publisher || (s?.url ? new URL(s.url).hostname.replace(/^www\./, "") : null), fmtDate(e.date) || fmtDate(s?.date)].filter(Boolean).join(", ");
  const body = e.kind === "post" || e.kind === "interview" ? el("q", { text: e.text }) : el("span", { text: e.text });
  return el(
    "li",
    { class: `ev ev-${e.kind}` },
    el("span", { class: "tag", text: kindLabel }),
    body,
    el("span", { class: "ev-meta" }, where ? ` — ${where}` : "", s?.url ? [" ", el("a", { href: safeUrl(s.url) || "#", target: "_blank", rel: "noopener", text: "↗", title: s.title })] : null)
  );
}

function render(entry, fromCache) {
  const p = entry.profile || {};
  const meta = entry.meta || {};
  const wiki = meta.wikipedia || null;
  const sourceMap = new Map((p.sources || []).map((s) => [s.id, s]));
  const root = $("profile");
  root.replaceChildren();
  const legacy = !p.leanings; // built by an older version of the prompt

  // ----- header
  const rank = { avatar: 0, photo: 1, post: 2, maybe: 4 };
  const headshot = [...(meta.images || [])].sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3)).map((i) => safeUrl(i.url)).find(Boolean);
  const photo = headshot || wiki?.thumbnail || null;
  const img = photo ? el("img", { src: photo, alt: "", referrerpolicy: "no-referrer" }) : el("div", { class: "ph", text: initials(p.name || ctx.author) });
  if (photo) img.addEventListener("error", () => img.replaceWith(el("div", { class: "ph", text: initials(p.name || ctx.author) })));
  root.append(
    el("div", { class: "hero" }, img,
      el("div", {},
        el("h1", { text: p.name || ctx.author }),
        p.currentRole ? el("div", { class: "role", text: p.currentRole }) : null,
        p.bottomLine ? el("p", { class: "bottom", text: p.bottomLine }) : p.oneLiner ? el("p", { class: "bottom", text: p.oneLiner }) : null,
        p.identityConfidence && p.identityConfidence !== "high" ? el("div", { class: "chip warn", title: p.identityNote || "", text: `identity: ${p.identityConfidence} confidence` }) : null
      ))
  );

  if (legacy) {
    root.append(el("div", { class: "notice" }, "This profile was built by an earlier version without the dashboard. ", el("button", { class: "link", text: "Rebuild it" })));
    root.querySelector(".notice button").addEventListener("click", () => analyze(true));
  }

  // ----- leaning + style
  const L = p.leanings || {};
  const S = p.style || {};
  const evidenceCounts = countEvidence(p, meta);
  root.append(
    tile("Leaning",
      meter("political", L.political, sourceMap),
      meter("social", L.social, sourceMap),
      meter("economic", L.economic, sourceMap),
      evidenceCounts ? el("p", { class: "muted small basis", text: evidenceCounts }) : null
    ),
    tile("Style", meter("opinion", S.opinion, sourceMap), meter("lens", S.lens, sourceMap))
  );

  // ----- watch for
  const wf = p.watchFor || [];
  if (wf.length) root.append(tile("Watch for in this article", el("ul", { class: "watch" }, ...wf.map((w) => el("li", { text: w })))));

  // ----- evidence
  const ev = p.evidence || [];
  if (ev.length) {
    const list = el("ul", { class: "evidence" }, ...ev.map((e) => evidenceItem(e, sourceMap)));
    const items = [...list.children];
    items.slice(5).forEach((li) => (li.hidden = true));
    const more = items.length > 5 ? el("button", { class: "small-btn", text: `Show ${items.length - 5} more` }) : null;
    more?.addEventListener("click", () => { items.forEach((li) => (li.hidden = false)); more.remove(); });
    root.append(tile("Evidence", list, more));
  }

  // ----- recent work
  const rw = (p.recentWork || []).filter((w) => safeUrl(w.url));
  if (rw.length) {
    root.append(tile("Previous pieces",
      el("ul", { class: "work" }, ...rw.map((w) => el("li", {},
        el("span", { class: `tag kind-${w.kind}`, text: w.kind === "unclear" ? "" : w.kind }),
        el("a", { href: safeUrl(w.url), target: "_blank", rel: "noopener", text: w.title }),
        w.date ? el("span", { class: "muted", text: ` · ${fmtDate(w.date) || w.date}` }) : null,
        w.note ? el("div", { class: "muted small", text: w.note }) : null
      )))));
  }

  // ----- photos (compact strip)
  const photos = [];
  for (const im of meta.images || []) { const u = safeUrl(im.url); if (u && !photos.some((x) => x.url === u)) photos.push({ ...im, url: u }); }
  if (wiki?.image || wiki?.thumbnail) { const u = wiki.image || wiki.thumbnail; if (!photos.some((x) => x.url === u)) photos.push({ url: u, sourceUrl: wiki.url, source: "Wikipedia", date: null, kind: "photo" }); }
  if (photos.length || Array.isArray(meta.images)) {
    const strip = el("div", { class: "strip" });
    const tiles = photos.map((ph, i) => {
      const im = el("img", { src: ph.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      const a = el("a", { href: safeUrl(ph.sourceUrl) || ph.url, target: "_blank", rel: "noopener", title: [ph.source, fmtDate(ph.date)].filter(Boolean).join(" · ") }, im);
      if (i >= 8) a.hidden = true;
      im.addEventListener("error", () => a.remove());
      im.addEventListener("load", () => { if (im.naturalWidth < 90 || im.naturalHeight < 90) a.remove(); });
      return a;
    });
    strip.append(...tiles);
    const more = tiles.length > 8 ? el("button", { class: "small-btn", text: `All ${tiles.length}` }) : null;
    more?.addEventListener("click", () => { tiles.forEach((t) => (t.hidden = false)); more.remove(); });
    const handles = (meta.handles || []).map((h) => (h.kind === "mastodon" ? `@${h.handle}@${h.instance}` : `@${h.handle}`)).join(", ");
    root.append(tile("Photos",
      photos.length ? strip : el("p", { class: "muted small", text: "None found." }),
      el("div", { class: "row-left" }, more, searchLinks(p.name || ctx.author, ctx.publication)),
      handles ? el("p", { class: "muted small", text: `Accounts: ${handles}` }) : null,
      attemptsNote(meta.photoAttempts, !photos.length)
    ));
  }

  // ----- more (everything else, collapsed)
  const bg = p.background || {};
  const moreKids = [];
  if (bg.career?.length) moreKids.push(el("h3", { text: "Career" }), el("ul", {}, ...bg.career.map((c) => el("li", {}, el("strong", { text: c.role }), `, ${c.organization}`, c.years ? el("span", { class: "muted", text: ` (${c.years})` }) : null, srcLinks(c.sourceIds, sourceMap)))));
  if (bg.education?.length) moreKids.push(el("h3", { text: "Education" }), el("ul", {}, ...bg.education.map((e) => el("li", {}, el("strong", { text: e.institution }), e.detail ? ` — ${e.detail}` : "", srcLinks(e.sourceIds, sourceMap)))));
  if (p.affiliations?.length) moreKids.push(el("h3", { text: "Affiliations" }), el("ul", {}, ...p.affiliations.map((a) => el("li", {}, el("strong", { text: a.organization }), ` — ${a.relationship}`, srcLinks(a.sourceIds, sourceMap)))));
  if (p.interests?.length) moreKids.push(el("h3", { text: "Beats and causes" }), el("p", { text: p.interests.map((i) => (typeof i === "string" ? i : i.topic)).join(" · ") }));
  if (bg.location) moreKids.push(el("p", { class: "muted small", text: `Based in ${bg.location}` }));
  const profs = (p.profiles || []).filter((x) => safeUrl(x.url));
  if (wiki && !profs.some((x) => /wikipedia\.org/.test(x.url))) profs.unshift({ label: "Wikipedia", url: wiki.url });
  if (profs.length) moreKids.push(el("h3", { text: "Profiles" }), el("div", { class: "profiles" }, ...profs.map((x) => el("a", { href: safeUrl(x.url), target: "_blank", rel: "noopener", text: x.label }))));
  if (p.sources?.length) moreKids.push(el("h3", { text: "Sources" }), el("ol", { class: "sources" }, ...p.sources.map((s) => el("li", { value: String(s.id).replace(/^s/, "") }, el("a", { href: safeUrl(s.url) || "#", target: "_blank", rel: "noopener", text: s.title || s.url }), s.publisher || s.date ? el("span", { class: "muted", text: ` — ${[s.publisher, s.date].filter(Boolean).join(", ")}` }) : null))));
  if (moreKids.length) root.append(el("details", { class: "more" }, el("summary", { text: "More: background, affiliations, sources" }), el("div", { class: "body" }, ...moreKids)));

  if (p.caveats?.length) root.append(el("div", { class: "caveats" }, el("strong", { text: "Caveats" }), el("ul", {}, ...p.caveats.map((c) => el("li", { text: c })))));
  root.append(el("p", { class: "disclaimer", text: "Built by an AI model from public sources. It can misjudge or mix up people with the same name; each claim links to where it came from. A lens on the author, not a verdict on the article." }));

  const when = meta.generatedAt ? new Date(meta.generatedAt).toLocaleDateString() : "";
  const parts = [];
  if (fromCache) parts.push(`cached ${when}`); else if (when) parts.push(`generated ${when}`);
  if (meta.model) parts.push(meta.model);
  if (meta.searches != null) parts.push(`${meta.searches} searches`);
  $("foot-meta").textContent = parts.join(" · ");

  show("profile");
  $("main").scrollTop = 0;
}

function countEvidence(p, meta) {
  const posts = (p.sources || []).filter((s) => /^(X|Bluesky|Mastodon) post by/.test(s.title || "")).length;
  const articles = (p.recentWork || []).length;
  const accounts = (meta.accounts || []).length;
  const bits = [];
  if (posts) bits.push(`${posts} post${posts === 1 ? "" : "s"}${accounts ? ` from ${accounts} account${accounts === 1 ? "" : "s"}` : ""}`);
  if (articles) bits.push(`${articles} previous piece${articles === 1 ? "" : "s"}`);
  const web = (p.sources || []).length - posts;
  if (web > 0) bits.push(`${web} web source${web === 1 ? "" : "s"}`);
  return bits.length ? `Based on ${bits.join(", ")}.` : "";
}

function searchLinks(name, publication) {
  if (!name) return null;
  const q = encodeURIComponent(publication ? `${name} ${publication}` : name);
  return el("span", { class: "muted small" }, "Search: ",
    el("a", { href: `https://www.google.com/search?tbm=isch&q=${q}`, target: "_blank", rel: "noopener", text: "Google" }), " · ",
    el("a", { href: `https://duckduckgo.com/?iax=images&ia=images&q=${q}`, target: "_blank", rel: "noopener", text: "DuckDuckGo" }), " · ",
    el("a", { href: `https://www.bing.com/images/search?q=${q}`, target: "_blank", rel: "noopener", text: "Bing" }));
}

function attemptsNote(attempts, open = false) {
  if (!attempts?.length) return null;
  const lines = attempts.map((a) => {
    const what = a.target && a.target !== a.source ? `${a.source} (${a.target.length > 48 ? a.target.slice(0, 45) + "…" : a.target})` : a.source;
    return `${what}: ${a.ok ? (a.count ? `${a.count} image${a.count === 1 ? "" : "s"}` : "no image") : `failed, ${a.error || "unknown error"}`}`;
  });
  return el("details", { class: "attempts", open: open ? "" : null },
    el("summary", { class: "muted small", text: `Photo sources tried (${attempts.length})` }),
    el("ul", { class: "muted small" }, ...lines.map((l) => el("li", { text: l }))));
}

// ---------- boot ----------
$("name-input").value = ctx.author || "";
$("setup-hint").textContent = ctx.title ? `Article: ${ctx.title}` : "";
if (ctx.author && ctx.autoStart !== false) analyze(false);
else show("setup");

// A new hash means the content script re-pointed the panel at another article.
window.addEventListener("hashchange", () => {
  ctx = readContext();
  $("name-input").value = ctx.author || "";
  if (ctx.author) analyze(false);
  else show("setup");
});
