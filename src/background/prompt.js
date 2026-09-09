// System prompt and output schema for the author dashboard.
//
// The schema is sent as a structured-output format, so the model's final
// answer is guaranteed to parse. Every object sets additionalProperties:false
// and lists every key as required (nullable where optional), as the API needs.

function str(description) {
  return { type: "string", description };
}
function nullableStr(description) {
  return { anyOf: [{ type: "string" }, { type: "null" }], description };
}
function en(values, description) {
  return { type: "string", enum: values, description };
}
function obj(properties, description) {
  return { type: "object", description, properties, required: Object.keys(properties), additionalProperties: false };
}
function arr(items, description) {
  return { type: "array", items, description };
}

const CONFIDENCE = ["high", "medium", "low", "none"];
const ids = arr({ type: "string" }, "Ids of sources (s1, s2, ...) that support this. Empty only when confidence is none.");

function axis(values, description) {
  return obj(
    {
      position: en(values, description),
      confidence: en(CONFIDENCE, "none means there is not enough public evidence to place them; then position must be 'unclear'."),
      why: str("At most 20 words. The single strongest reason for this placement, concrete (a post, an affiliation, a pattern across articles)."),
      sourceIds: ids,
    },
    ""
  );
}

export const POLITICAL = ["left", "center-left", "center", "center-right", "right", "unclear"];
export const SOCIAL = ["progressive", "leans-progressive", "mixed", "leans-traditional", "traditional", "unclear"];
export const ECONOMIC = ["interventionist", "leans-interventionist", "mixed", "leans-market", "free-market", "unclear"];
export const OPINION = ["reporting", "mostly-reporting", "mixed", "mostly-opinion", "advocacy", "unclear"];
export const LENS = ["many-perspectives", "mostly-balanced", "mixed", "mostly-one-lens", "single-lens", "unclear"];

export const PROFILE_SCHEMA = obj({
  name: str("Canonical full name of the author."),
  identityConfidence: en(["high", "medium", "low"], "How sure you are that the sources describe the person who wrote this article."),
  identityNote: nullableStr("Only when identity confidence is not high: the ambiguity in one sentence."),
  currentRole: nullableStr("Job title and outlet, e.g. 'Opinion columnist, The Example Times'."),
  bottomLine: str("One or two sentences, at most 40 words, that a friend would say before handing you this article: who this is and the angle they usually bring. Plain and specific."),

  leanings: obj({
    political: axis(POLITICAL, "Overall political orientation as expressed publicly, in the terms of the author's own country."),
    social: axis(SOCIAL, "Cultural and social questions: immigration, gender and sexuality, religion in public life, crime and policing, identity, tradition."),
    economic: axis(ECONOMIC, "Role of the state in the economy: taxes, regulation, redistribution, unions, trade, markets."),
  }, "Where the author sits. Weigh their own posts and their body of work above labels others give them."),

  style: obj({
    opinion: axis(OPINION, "How much of their output is opinion or advocacy rather than reporting, and whether they present opinions as settled fact."),
    lens: axis(LENS, "Whether they read events through one consistent ideological frame, or engage and fairly state views they disagree with."),
  }, "How they work, judged from previous articles and posts."),

  watchFor: arr(str("At most 18 words. One concrete thing to keep in mind while reading this specific article, tied to this author's record or stakes."), "Exactly three items when evidence allows; fewer if not. Neutral wording."),

  evidence: arr(obj({
    kind: en(["post", "article", "bio", "record", "interview", "other"], ""),
    axis: en(["political", "social", "economic", "opinion", "lens", "identity", "other"], "Which judgment this supports."),
    text: str("A short verbatim quote (under 200 characters) for posts and interviews; a one-line summary for articles and records."),
    date: nullableStr("ISO date or year if known."),
    sourceId: str("The source id this comes from."),
  }), "The six to ten strongest pieces of evidence behind the placements above, most telling first. Prefer the author's own words."),

  recentWork: arr(obj({
    title: str(""),
    url: str("Exactly as given in a source."),
    date: nullableStr(""),
    kind: en(["reporting", "analysis", "opinion", "unclear"], ""),
    note: nullableStr("At most 15 words: the take or framing, if any."),
  }), "Up to six previous pieces by this author found in the sources, newest first."),

  background: obj({
    career: arr(obj({ organization: str(""), role: str(""), years: nullableStr(""), sourceIds: ids }), "At most five, newest first."),
    education: arr(obj({ institution: str(""), detail: nullableStr(""), sourceIds: ids }), "At most three."),
    location: nullableStr("City or region only. Never a street address."),
  }, ""),
  affiliations: arr(obj({
    organization: str(""),
    relationship: str("employee, fellow, board member, donor, funded by, member, spokesperson, etc."),
    sourceIds: ids,
  }), "Institutional ties that bear on perspective: parties, think tanks, advocacy groups, funders, boards. At most six."),
  interests: arr(str("Two to five words each."), "Recurring beats and causes. At most six."),
  profiles: arr(obj({
    label: en(["Author page", "Personal site", "Wikipedia", "X", "Bluesky", "Mastodon", "Threads", "Instagram", "LinkedIn", "Substack", "YouTube", "Muck Rack", "Other"], ""),
    url: str("Full URL exactly as it appeared in a source. Never guess a handle."),
  }), "Every public profile URL that appeared in the sources."),
  sources: arr(obj({
    id: str("Id as given (s1, s2, ...)."),
    title: str(""),
    url: str(""),
    publisher: nullableStr(""),
    date: nullableStr(""),
  }), "Only the provided sources you relied on, copied exactly."),
  caveats: arr(str("One sentence each."), "Limits: thin footprint, possible mix-ups, unverified accounts, stale sources. At most four."),
});

export const SYSTEM_PROMPT = `You build a one-glance dashboard about the author of an article, so a reader can weigh the piece before reading it.

The reader does not want an essay. They want to know where the author stands politically, socially and economically, how they work (opinion or reporting, one lens or many), and what to watch for in this particular article. Every judgment must carry its evidence and an honest confidence.

You get: the article's context, web search results gathered for this author (numbered sources with a title, URL and excerpt), and, when found, the author's social accounts with their bios and recent posts. Read all of it. You may add what you reliably know about a public figure, but anything not supported by a provided source counts as low confidence, and you must never invent a source.

Principles

1. Identity first. Names collide. Use the outlet, the beat and the article's subject to confirm you have the right person. For each social account, check the display name, bio and subject matter against the author before using its posts; an unconfirmed account can at most support low confidence, and goes in caveats.

2. Their own words beat labels. Social posts are usually more candid than a bio and are the best evidence for leanings. Previous articles are the best evidence for style: do they report, analyze or argue; do they state opinion as fact; do they engage views they disagree with or read everything through one frame. Characterize patterns across many posts and pieces, not one offhand remark. Keep jokes, sarcasm and shared links distinct from stated positions.

3. Place, do not preach. Each axis gets one position from its list, a confidence, a reason of at most 20 words, and source ids. When the evidence is thin, say 'unclear' with confidence 'none' rather than guessing. Center and mixed are real positions when the record supports them.

4. Expertise is context too. Twenty years on a beat is a vantage point, not just a bias. The bottom line and watch-fors should be fair introductions, not a case for the prosecution.

5. Public and professional only. Report what the author has published, posted publicly, listed in public bios, or what appears in public records about their professional and civic life. No home addresses, phone numbers, personal email, health information, or family members who are not public figures. Do not speculate about ethnicity, religion, sexual orientation or gender identity; mention such a thing only when the author has publicly discussed it as part of their own perspective.

6. Cite everything. Source ids only from the provided list; copy titles and URLs exactly. Evidence items should quote the author's own words where possible, briefly.

7. Be brief everywhere. Word limits in the schema are hard limits. Short, concrete, plain.`;

function topicKeywords(title) {
  const stop = new Set("a an the and or of to in on for with by from at as is are was were be this that these those it its into over under after before why how what when where who will can could should would new says said".split(" "));
  return (title || "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()))
    .slice(0, 5)
    .join(" ");
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Templated search queries, most useful first; the search cap slices this list. */
export function buildQueries({ author, publication, title, url }) {
  const q = `"${author}"`;
  const topic = topicKeywords(title);
  const domain = domainOf(url);
  const list = [
    publication ? `${q} ${publication}` : `${q} journalist`,
    domain ? `${q} site:${domain}` : `${q} articles`,
    `${q} x.com OR twitter`,
    `${q} bsky.app OR mastodon OR threads.net`,
    `${q} columnist OR opinion OR column`,
    `${q} journalist OR writer bio`,
    topic ? `${q} ${topic}` : `${q} interview`,
    `${q} wikipedia`,
    `${q} interview OR podcast`,
    `${q} linkedin OR substack OR muckrack`,
    `${q} think tank OR fellow OR foundation OR campaign OR donation`,
    `${q} education OR university OR graduated`,
  ];
  return Array.from(new Set(list));
}

function accountBlock(accounts) {
  if (!accounts?.length) return null;
  const label = { x: "X", bluesky: "Bluesky", mastodon: "Mastodon" };
  return (
    "\nSocial accounts found (confirm each belongs to this author before relying on it):\n" +
    accounts
      .map((a, i) => {
        const bits = [`[account ${i + 1}] ${label[a.kind] || a.kind} @${a.handle} — ${a.url}`];
        if (a.displayName) bits.push(`name: ${a.displayName}`);
        if (a.bio) bits.push(`bio: ${a.bio.replace(/\s+/g, " ").trim()}`);
        if (a.followers != null) bits.push(`followers: ${a.followers}`);
        return bits.join("\n  ");
      })
      .join("\n")
  );
}

export function buildUserMessage({ author, publication, title, url, excerpt, publishedAt }, sources = [], accounts = []) {
  const sourceBlock = sources.length
    ? "\nGathered sources:\n" +
      sources
        .map((s) => `[${s.id}] ${s.title}\n${s.url}\n${s.content ? s.content.replace(/\s+/g, " ").trim() : "(no excerpt)"}`)
        .join("\n\n")
    : "\nGathered sources: none were found. Say so in caveats, set every axis to unclear with confidence none, and keep everything else minimal.";
  const lines = [
    `Author: ${author}`,
    publication ? `Publication: ${publication}` : null,
    title ? `Article title: ${title}` : null,
    url ? `Article URL: ${url}` : null,
    publishedAt ? `Published: ${publishedAt}` : null,
    excerpt ? `\nOpening of the article (for topic context and identity disambiguation):\n"""\n${excerpt}\n"""` : null,
    sourceBlock,
    accountBlock(accounts),
    "\nBuild the dashboard for this author.",
  ].filter(Boolean);
  return lines.join("\n");
}
