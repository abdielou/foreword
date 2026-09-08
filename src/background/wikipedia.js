// Wikipedia lookups: a photo and a one-line description when the author
// has an article. Free, no key, and Wikimedia thumbnails load anywhere.

const SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const ROLE_WORDS = /\b(journalist|reporter|columnist|writer|author|editor|correspondent|commentator|pundit|critic|essayist|blogger|broadcaster|professor|economist|historian|scientist|analyst|politician|activist|novelist|podcaster|anchor|presenter)\b/i;

function titleFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/wikipedia\.org$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/wiki\/([^#?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

async function fetchSummary(title) {
  const res = await fetch(SUMMARY + encodeURIComponent(title.replace(/ /g, "_")), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (j.type === "disambiguation") return null;
  return {
    title: j.title,
    description: j.description || null,
    extract: j.extract || null,
    url: j.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(j.title)}`,
    thumbnail: j.thumbnail?.source || null,
    image: j.originalimage?.source || null,
  };
}

/**
 * Tries, in order: a Wikipedia URL the model cited, then a direct title
 * lookup by name (accepted only if it reads like a writer's biography).
 * Returns null when nothing trustworthy is found.
 */
export async function lookupWikipedia({ name, profiles = [], sources = [], publication = "" }) {
  const cited = [...profiles, ...sources].map((p) => titleFromUrl(p.url)).filter(Boolean);
  for (const title of cited) {
    try {
      const s = await fetchSummary(title);
      if (s) return { ...s, verified: true };
    } catch {
      /* next */
    }
  }
  if (!name) return null;
  try {
    const s = await fetchSummary(name);
    if (!s) return null;
    const text = `${s.description || ""} ${s.extract || ""}`;
    const pubHit = publication && text.toLowerCase().includes(publication.toLowerCase());
    if (pubHit || ROLE_WORDS.test(text)) return { ...s, verified: Boolean(pubHit) };
  } catch {
    /* ignore */
  }
  return null;
}
