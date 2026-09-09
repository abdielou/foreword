// Foreword content script.
// 1. Detects the article's author, publication, title and opening text.
// 2. Reports the detection to the service worker.
// 3. Shows a small badge; clicking it opens the panel (an extension page in
//    an iframe, so page CSP and styles cannot interfere with it).
(() => {
  if (window.top !== window) return; // main frame only
  if (window.__forewordLoaded) return;
  window.__forewordLoaded = true;

  const MSG = {
    DETECTED: "al:detected",
    OPEN_PANEL: "al:open-panel",
    CLOSE_PANEL: "al:close-panel",
  };
  const EXT_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

  // ---------------------------------------------------------------- detection
  const NON_NAMES = /^(staff|admin|administrator|editor|editors|editorial|editorial board|guest|guest author|contributor|contributors|newsroom|news desk|news service|associated press|reuters|afp|ap|bloomberg|wire|wires|team|the editors|unknown|anonymous|author|by)$/i;
  // Any of these words anywhere in a candidate means it is a desk, not a person.
  const NON_NAME_WORDS = /\b(staff|newsroom|desk|editors?|team|wires?|bureau|news|service|correspondents?|reporters?|contributors?|admin|administrator|editorial|associated press|reuters|bloomberg|agencies|agency)\b/i;
  const ORG_WORDS = /\b(news|times|post|journal|staff|press|media|network|desk|bureau|team|magazine|gazette|tribune|herald|daily|weekly|review|inc|llc|ltd|corp|group|foundation|institute|university|college|department|committee|council|association|society|company|agency|service|wire)\b/i;

  function text(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function cleanName(raw) {
    if (!raw) return null;
    let s = String(raw)
      .replace(/\s+/g, " ")
      .replace(/^\s*(by|von|par|por|de|written by|story by|words by|opinion by|analysis by)\s*[:\-–—]?\s*/i, "")
      .replace(/\s*[|•·–—-]\s*.*$/, "") // trailing " | Senior Editor"
      .replace(/\s*\(.*?\)\s*/g, " ")
      .replace(/,\s*(ph\.?d\.?|md|jd|mba|cfa|esq\.?)\b.*$/i, "")
      .replace(/^(dr|prof|mr|mrs|ms|sir|hon)\.?\s+/i, "")
      .replace(/[.,;:]+$/, "")
      .trim();
    if (!s) return null;
    if (s.length < 3 || s.length > 60) return null;
    if (NON_NAMES.test(s)) return null;
    if (NON_NAME_WORDS.test(s)) return null;
    if (/https?:\/\//i.test(s) || /@/.test(s)) return null;
    const words = s.split(" ");
    if (words.length < 1 || words.length > 5) return null;
    if (words.length === 1 && s.length < 4) return null;
    if (ORG_WORDS.test(s) && words.length > 1 && !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(s)) return null;
    const letters = s.replace(/[^A-Za-zÀ-ÿ'’.-]/g, "");
    if (letters.length < s.replace(/\s/g, "").length * 0.8) return null;
    return s;
  }

  function splitAuthors(raw) {
    return String(raw)
      .split(/\s*(?:,|;|&|\band\b|\bwith\b|\/)\s*/i)
      .map(cleanName)
      .filter(Boolean);
  }

  function personFromLd(a) {
    if (!a) return [];
    if (Array.isArray(a)) return a.flatMap(personFromLd);
    if (typeof a === "string") return splitAuthors(a);
    if (typeof a === "object") {
      const t = String(a["@type"] || "").toLowerCase();
      if (t.includes("organization")) return [];
      if (a.name) return splitAuthors(a.name);
    }
    return [];
  }

  function fromJsonLd() {
    const out = { authors: [], publication: null, title: null, publishedAt: null, authorUrl: null, authorImage: null };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(s.textContent);
      } catch {
        continue;
      }
      const nodes = [];
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        nodes.push(n);
        if (n["@graph"]) walk(n["@graph"]);
        if (n.mainEntity) walk(n.mainEntity);
      };
      walk(data);
      for (const n of nodes) {
        const t = String(n["@type"] || "").toLowerCase();
        const articleish = /article|blogposting|report|review|opinion|newsarticle|analysisnewsarticle/.test(t);
        if (!articleish && !n.author) continue;
        const names = personFromLd(n.author);
        if (names.length && !out.authors.length) {
          out.authors = names;
          const first = Array.isArray(n.author) ? n.author[0] : n.author;
          if (first && typeof first === "object") {
            const u = first.url || first.sameAs;
            const url = Array.isArray(u) ? u[0] : u;
            if (typeof url === "string" && /^https?:/.test(url)) out.authorUrl = url;
            const im = first.image;
            const img = typeof im === "string" ? im : im?.url || im?.contentUrl;
            if (typeof img === "string" && /^https?:/.test(img)) out.authorImage = img;
          }
        }
        if (!out.publication && n.publisher?.name) out.publication = String(n.publisher.name);
        if (!out.title && n.headline) out.title = String(n.headline);
        if (!out.publishedAt && n.datePublished) out.publishedAt = String(n.datePublished);
      }
      if (out.authors.length) break;
    }
    return out;
  }

  function meta(sel) {
    const el = document.querySelector(sel);
    return el ? el.getAttribute("content") : null;
  }

  function fromMeta() {
    const candidates = [
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[name="parsely-author"]',
      'meta[name="sailthru.author"]',
      'meta[name="dc.creator"]',
      'meta[name="DC.creator"]',
      'meta[name="citation_author"]',
      'meta[name="byl"]',
      'meta[name="twitter:creator"]',
    ];
    const authors = [];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        const v = el.getAttribute("content");
        if (!v || /^https?:\/\//i.test(v)) continue;
        if (sel.includes("twitter:creator")) continue; // handles, not names
        for (const n of splitAuthors(v)) if (!authors.includes(n)) authors.push(n);
      }
      if (authors.length) break;
    }
    return authors;
  }

  function fromDom() {
    const sels = [
      'a[rel="author"]',
      '[itemprop="author"] [itemprop="name"]',
      '[itemprop="author"]',
      '[class*="byline" i] a',
      '[class*="byline" i]',
      '[class*="author-name" i]',
      '[class*="authorName" i]',
      '[class*="author__name" i]',
      '[data-testid*="author" i]',
      '[class*="contributor" i] a',
      '[class*="author" i] a',
      '.author',
    ];
    const authors = [];
    for (const sel of sels) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of Array.from(nodes).slice(0, 6)) {
        const t = text(el);
        if (!t || t.length > 120) continue;
        for (const n of splitAuthors(t)) if (!authors.includes(n)) authors.push(n);
      }
      if (authors.length) break;
    }
    return authors;
  }

  // The byline's own link is the most reliable path to an author page and headshot.
  function authorLinkAndImage(name) {
    const out = { url: null, image: null };
    const sels = ['a[rel="author"]', '[itemprop="author"] a[href]', '[class*="byline" i] a[href]', '[class*="author" i] a[href]'];
    for (const sel of sels) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const a of Array.from(nodes).slice(0, 8)) {
        const t = text(a);
        if (!t || (name && !t.toLowerCase().includes(name.split(" ")[0].toLowerCase()))) continue;
        try {
          const u = new URL(a.getAttribute("href"), location.href);
          if (/^https?:$/.test(u.protocol) && !/^(mailto|tel):/.test(a.getAttribute("href"))) {
            out.url = u.href;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (out.url) break;
    }
    // A small headshot next to the byline.
    const imgSel = '[class*="byline" i] img, [class*="author" i] img, [itemprop="author"] img, [rel="author"] img';
    for (const img of Array.from(document.querySelectorAll(imgSel)).slice(0, 6)) {
      const src = img.currentSrc || img.src;
      const w = img.naturalWidth || img.width || 0;
      if (src && /^https?:/.test(src) && w >= 32 && w <= 800 && !/logo|icon|sprite|badge/i.test(src)) {
        out.image = src;
        break;
      }
    }
    return out;
  }

  function publicationName() {
    return (
      meta('meta[property="og:site_name"]') ||
      meta('meta[name="application-name"]') ||
      meta('meta[name="publisher"]') ||
      location.hostname.replace(/^www\./, "")
    );
  }

  function articleTitle() {
    return (
      meta('meta[property="og:title"]') ||
      meta('meta[name="twitter:title"]') ||
      text(document.querySelector("article h1, main h1, h1")) ||
      document.title
    );
  }

  function excerpt() {
    const root =
      document.querySelector("article") ||
      document.querySelector('[itemprop="articleBody"]') ||
      document.querySelector("main") ||
      document.body;
    const paras = Array.from(root.querySelectorAll("p"))
      .map(text)
      .filter((t) => t.length > 60);
    let out = "";
    for (const p of paras) {
      if (out.length + p.length > 1500) break;
      out += (out ? "\n\n" : "") + p;
    }
    if (!out) out = (meta('meta[property="og:description"]') || meta('meta[name="description"]') || "").slice(0, 600);
    return out;
  }

  function looksLikeArticle() {
    const ogType = (meta('meta[property="og:type"]') || "").toLowerCase();
    if (ogType.includes("article")) return true;
    if (document.querySelector('script[type="application/ld+json"]')) return true;
    if (document.querySelector("article")) return true;
    return false;
  }

  function detect() {
    const ld = fromJsonLd();
    let authors = ld.authors;
    let source = "json-ld";
    if (!authors.length) {
      authors = fromMeta();
      source = "meta";
    }
    if (!authors.length) {
      authors = fromDom();
      source = "dom";
    }
    if (!authors.length) return null;
    const link = authorLinkAndImage(authors[0]);
    return {
      author: authors[0],
      coAuthors: authors.slice(1, 4),
      authorUrl: ld.authorUrl || link.url,
      authorImage: ld.authorImage || link.image,
      publication: ld.publication || publicationName(),
      title: ld.title || articleTitle(),
      publishedAt: ld.publishedAt || meta('meta[property="article:published_time"]') || null,
      url: location.href.split("#")[0],
      excerpt: excerpt(),
      source,
      isArticle: looksLikeArticle(),
    };
  }

  // ------------------------------------------------------------------- panel
  let host = null;
  let frame = null;
  let badge = null;
  let detection = null;
  let settings = { showBadge: true, autoAnalyze: false, panelSide: "right", hasApiKey: false };
  let badgeDismissed = false;

  function panelUrl(det, opts = {}) {
    const payload = { ...det, ...opts };
    return chrome.runtime.getURL("src/panel/panel.html") + "#" + encodeURIComponent(JSON.stringify(payload));
  }

  function openPanel(opts = {}) {
    const det = opts.author ? { ...(detection || baseDetection()), ...opts } : detection || baseDetection();
    if (!det.author) return false;
    if (!host) {
      host = document.createElement("div");
      host.id = "foreword-host";
      const shadow = host.attachShadow({ mode: "closed" });
      const side = settings.panelSide === "left" ? "left" : "right";
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        .wrap { position: fixed; top: 0; ${side}: 0; height: 100vh; width: min(420px, 100vw);
                z-index: 2147483646; box-shadow: ${side === "right" ? "-8px" : "8px"} 0 32px rgba(0,0,0,.18);
                background: #fff; transition: transform .22s ease; transform: translateX(${side === "right" ? "100%" : "-100%"}); }
        .wrap.open { transform: translateX(0); }
        iframe { border: 0; width: 100%; height: 100%; display: block; background: #fff; }
      `;
      const wrap = document.createElement("div");
      wrap.className = "wrap";
      frame = document.createElement("iframe");
      frame.setAttribute("title", "Foreword");
      frame.setAttribute("allow", "");
      wrap.appendChild(frame);
      shadow.append(style, wrap);
      document.documentElement.appendChild(host);
      requestAnimationFrame(() => wrap.classList.add("open"));
      host.__wrap = wrap;
    } else {
      host.__wrap.classList.add("open");
    }
    frame.src = panelUrl(det, { autoStart: true, side: settings.panelSide });
    hideBadge();
    return true;
  }

  function closePanel() {
    if (!host) return;
    host.__wrap.classList.remove("open");
    setTimeout(() => {
      if (host && !host.__wrap.classList.contains("open")) {
        host.remove();
        host = null;
        frame = null;
      }
    }, 250);
    if (!badgeDismissed) showBadge();
  }

  function baseDetection() {
    return {
      author: "",
      coAuthors: [],
      publication: publicationName(),
      title: articleTitle(),
      url: location.href.split("#")[0],
      excerpt: excerpt(),
      publishedAt: null,
    };
  }

  // ------------------------------------------------------------------- badge
  function showBadge() {
    if (!settings.showBadge || !detection?.author || badge || badgeDismissed) return;
    badge = document.createElement("div");
    badge.id = "foreword-badge";
    const shadow = badge.attachShadow({ mode: "closed" });
    const side = settings.panelSide === "left" ? "left" : "right";
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .b { position: fixed; bottom: 18px; ${side}: 18px; z-index: 2147483645; display: flex; align-items: center; gap: 8px;
           font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
           background: #1f2a37; color: #fff; border-radius: 999px; padding: 9px 10px 9px 12px;
           box-shadow: 0 6px 20px rgba(0,0,0,.25); cursor: pointer; opacity: 0; transform: translateY(8px);
           transition: opacity .2s, transform .2s; }
      .b.in { opacity: 1; transform: none; }
      .b:hover { background: #2a3a4c; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #7cc4ff; flex: none; }
      .name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .x { margin-left: 2px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
           color: #b9c4d0; font-size: 14px; }
      .x:hover { background: rgba(255,255,255,.12); color: #fff; }
    `;
    const b = document.createElement("div");
    b.className = "b";
    b.setAttribute("role", "button");
    b.setAttribute("title", "Open Foreword");
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `Who is ${detection.author}?`;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Hide on this page";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      badgeDismissed = true;
      hideBadge();
    });
    b.addEventListener("click", () => openPanel());
    b.append(dot, name, x);
    shadow.append(style, b);
    document.documentElement.appendChild(badge);
    requestAnimationFrame(() => b.classList.add("in"));
  }

  function hideBadge() {
    if (badge) {
      badge.remove();
      badge = null;
    }
  }

  // --------------------------------------------------------------- messaging
  window.addEventListener("message", (e) => {
    if (e.origin !== EXT_ORIGIN || !e.data || e.data.source !== "foreword") return;
    if (e.data.type === MSG.CLOSE_PANEL) closePanel();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === MSG.OPEN_PANEL) {
      const ok = openPanel(msg.author ? { author: msg.author } : {});
      sendResponse({ ok });
      return;
    }
    if (msg?.type === "al:get-page-detection") {
      sendResponse({ ok: true, detection: detection || baseDetection() });
      return;
    }
    if (msg?.type === MSG.CLOSE_PANEL) {
      closePanel();
      sendResponse({ ok: true });
    }
  });

  async function report() {
    detection = detect();
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.DETECTED, detection });
      if (res?.settings) settings = { ...settings, ...res.settings };
    } catch {
      /* worker unavailable (extension reloaded) */
    }
    if (detection?.author) {
      if (settings.autoAnalyze && settings.hasApiKey) openPanel();
      else showBadge();
    }
  }

  // Detect now, and again once more after late-rendering bylines settle.
  let reported = false;
  const run = () => {
    if (reported) return;
    reported = true;
    report();
  };
  if (document.readyState === "complete") setTimeout(run, 400);
  else window.addEventListener("load", () => setTimeout(run, 400), { once: true });

  // Retry once if nothing was found at first (SPAs render bylines late).
  setTimeout(() => {
    if (!detection?.author) {
      const again = detect();
      if (again?.author) {
        reported = false;
        run();
      }
    }
  }, 3000);

  // SPA navigation: re-detect when the URL changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      badgeDismissed = false;
      hideBadge();
      closePanel();
      setTimeout(() => {
        reported = false;
        run();
      }, 1200);
    }
  }, 1000);
})();
