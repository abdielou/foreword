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
  window.parent.postMessage({ source: "author-lens", type: MSG.CLOSE_PANEL }, "*");
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
  return (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");
}

function sourceLinks(ids, sourceMap) {
  if (!ids?.length) return null;
  const links = ids
    .map((id) => sourceMap.get(id))
    .filter(Boolean)
    .map((s, i) => el("a", { href: s.url, target: "_blank", rel: "noopener", title: s.title, text: `[${s.id.replace(/^s/, "")}]` }));
  if (!links.length) return null;
  return el("span", { class: "src" }, " ", ...links.flatMap((a, i) => (i ? [" ", a] : [a])));
}

function basisTag(basis) {
  if (!basis) return null;
  return el("span", { class: `basis ${basis}`, text: basis.replace("-", " ") });
}

function section(title, count, bodyChildren, open = true) {
  if (!bodyChildren || (Array.isArray(bodyChildren) && !bodyChildren.filter(Boolean).length)) return null;
  const d = el(
    "details",
    { class: "sec", open: open ? "" : null },
    el("summary", {}, el("span", { class: "title" }, title, count ? el("span", { class: "count", text: `${count}` }) : null)),
    el("div", { class: "body" }, ...[bodyChildren].flat())
  );
  return d;
}

function indicatorList(items, sourceMap) {
  if (!items?.length) return null;
  return el(
    "ul",
    {},
    ...items.map((it) => el("li", {}, it.claim, basisTag(it.basis), sourceLinks(it.sourceIds, sourceMap)))
  );
}

function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

function render(entry, fromCache) {
  const p = entry.profile || {};
  const meta = entry.meta || {};
  const wiki = meta.wikipedia || null;
  const sourceMap = new Map((p.sources || []).map((s) => [s.id, s]));
  const root = $("profile");
  root.replaceChildren();

  // hero
  const photo = wiki?.thumbnail || (p.images || []).map((i) => safeUrl(i.url)).find(Boolean) || null;
  const img = photo
    ? el("img", { src: photo, alt: "", referrerpolicy: "no-referrer" })
    : el("div", { class: "ph", text: initials(p.name || ctx.author) });
  if (photo) {
    img.addEventListener("error", () => img.replaceWith(el("div", { class: "ph", text: initials(p.name || ctx.author) })));
  }
  root.append(
    el(
      "div",
      { class: "hero" },
      img,
      el(
        "div",
        {},
        el("h1", { text: p.name || ctx.author }),
        p.currentRole ? el("div", { class: "role", text: p.currentRole }) : null,
        p.oneLiner ? el("div", { class: "oneliner", text: p.oneLiner }) : null
      )
    )
  );

  // chips
  const chips = [];
  if (p.identityConfidence && p.identityConfidence !== "high") {
    chips.push(el("span", { class: "chip warn", title: p.identityNote || "", text: `identity: ${p.identityConfidence} confidence` }));
  }
  if (p.politics?.leaning) chips.push(el("span", { class: "chip lean", text: p.politics.leaning }));
  if (p.background?.location) chips.push(el("span", { class: "chip", text: p.background.location }));
  if (wiki) chips.push(el("span", { class: "chip", text: wiki.verified ? "on Wikipedia" : "Wikipedia match (unverified)" }));
  if (chips.length) root.append(el("div", { class: "chips" }, ...chips));
  if (p.identityConfidence && p.identityConfidence !== "high" && p.identityNote) {
    root.append(el("p", { class: "muted small", text: p.identityNote }));
  }

  // foreword
  if (p.foreword) {
    root.append(el("div", { class: "foreword" }, ...p.foreword.split(/\n\s*\n/).map((para) => el("p", { text: para.trim() }))));
  }

  // relevant to this article
  const rel = p.relevantToThisArticle || [];
  root.append(
    section(
      "Relevant to this article",
      rel.length,
      rel.length
        ? el("ul", {}, ...rel.map((r) => el("li", {}, el("span", { class: "kind", text: (r.kind || "").replace("-", " ") }), r.point, sourceLinks(r.sourceIds, sourceMap))))
        : el("p", { class: "muted", text: "No specific connection found between the author's record and this subject." })
    )
  );

  // politics
  const pol = p.politics || {};
  root.append(
    section("Politics & worldview", pol.indicators?.length ?? null, [
      pol.overview ? el("p", { text: pol.overview }) : null,
      indicatorList(pol.indicators, sourceMap),
    ])
  );

  // affiliations
  const aff = p.affiliations || [];
  root.append(
    section(
      "Affiliations & funding",
      aff.length,
      aff.length
        ? el("ul", {}, ...aff.map((a) => el("li", {}, el("strong", { text: a.organization }), ` — ${a.relationship}`, a.whyItMatters ? el("div", { class: "muted small", text: a.whyItMatters }) : null, sourceLinks(a.sourceIds, sourceMap))))
        : null,
      aff.length > 0
    )
  );

  // background
  const bg = p.background || {};
  const bgChildren = [];
  if (bg.career?.length) {
    bgChildren.push(el("h3", { class: "small muted", text: "Career" }));
    bgChildren.push(el("ul", {}, ...bg.career.map((c) => el("li", {}, el("strong", { text: c.role }), `, ${c.organization}`, c.years ? el("span", { class: "muted", text: ` (${c.years})` }) : null, sourceLinks(c.sourceIds, sourceMap)))));
  }
  if (bg.education?.length) {
    bgChildren.push(el("h3", { class: "small muted", text: "Education" }));
    bgChildren.push(el("ul", {}, ...bg.education.map((e) => el("li", {}, el("strong", { text: e.institution }), e.detail ? ` — ${e.detail}` : "", sourceLinks(e.sourceIds, sourceMap)))));
  }
  root.append(section("Background", null, bgChildren, true));

  // social positions
  const soc = p.socialPositions || {};
  root.append(
    section("Social & cultural positions", soc.indicators?.length ?? null, [
      soc.overview ? el("p", { text: soc.overview }) : null,
      indicatorList(soc.indicators, sourceMap),
    ], false)
  );

  // interests
  const ints = p.interests || [];
  root.append(
    section(
      "Interests & recurring themes",
      ints.length,
      ints.length ? el("ul", {}, ...ints.map((i) => el("li", {}, el("strong", { text: i.topic }), i.note ? ` — ${i.note}` : ""))) : null,
      false
    )
  );

  // reading questions
  const qs = p.readingQuestions || [];
  root.append(section("Questions to keep in mind", qs.length, qs.length ? el("ol", { class: "questions" }, ...qs.map((q) => el("li", { text: q }))) : null, true));

  // photos
  const photos = [];
  if (wiki?.image || wiki?.thumbnail) {
    photos.push({ url: wiki.image || wiki.thumbnail, sourceUrl: wiki.url, caption: "Wikipedia" });
  }
  for (const im of p.images || []) {
    const u = safeUrl(im.url);
    if (u && !photos.some((x) => x.url === u)) photos.push({ ...im, url: u });
  }
  if (photos.length) {
    const grid = el(
      "div",
      { class: "photos" },
      ...photos.slice(0, 6).map((ph) => {
        const im = el("img", { src: ph.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        const a = el("a", { href: safeUrl(ph.sourceUrl) || ph.url, target: "_blank", rel: "noopener" }, im, el("div", { class: "cap", text: [ph.caption, ph.approxDate].filter(Boolean).join(" · ") }));
        im.addEventListener("error", () => a.remove());
        return a;
      })
    );
    root.append(section("Recent photos", photos.length, [grid, el("p", { class: "muted small", text: "Photos come from public pages found during research. Follow a profile link below for the newest ones." })], true));
  }

  // profiles
  const profs = (p.profiles || []).filter((x) => safeUrl(x.url));
  if (wiki && !profs.some((x) => /wikipedia\.org/.test(x.url))) profs.unshift({ label: "Wikipedia", url: wiki.url });
  if (profs.length) {
    root.append(section("Profiles", profs.length, el("div", { class: "profiles" }, ...profs.map((x) => el("a", { href: safeUrl(x.url), target: "_blank", rel: "noopener", text: x.label }))), true));
  }

  // sources
  const srcs = p.sources || [];
  if (srcs.length) {
    root.append(
      section(
        "Sources",
        srcs.length,
        el("ol", { class: "sources" }, ...srcs.map((s) => el("li", { value: String(s.id).replace(/^s/, "") }, el("span", { class: "id", text: s.id }), el("a", { href: safeUrl(s.url) || "#", target: "_blank", rel: "noopener", text: s.title || s.url }), s.publisher || s.date ? el("span", { class: "muted", text: ` — ${[s.publisher, s.date].filter(Boolean).join(", ")}` }) : null))),
        false
      )
    );
  }

  // caveats + disclaimer
  if (p.caveats?.length) {
    root.append(el("div", { class: "caveats" }, el("strong", { text: "Caveats" }), el("ul", {}, ...p.caveats.map((c) => el("li", { text: c })))));
  }
  root.append(
    el("p", { class: "disclaimer", text: "Generated by an AI model from public web sources and may contain errors or mix up people with the same name. Verify anything that matters through the linked sources. Context about an author is a lens, not a verdict on their work." })
  );

  // footer
  const when = meta.generatedAt ? new Date(meta.generatedAt).toLocaleDateString() : "";
  const parts = [];
  if (fromCache) parts.push(`cached ${when}`);
  else if (when) parts.push(`generated ${when}`);
  if (meta.model) parts.push(meta.model);
  if (meta.searches != null) parts.push(`${meta.searches} searches`);
  $("foot-meta").textContent = parts.join(" · ");

  show("profile");
  $("main").scrollTop = 0;
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
