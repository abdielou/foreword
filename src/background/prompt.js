// Prompts and output schemas for Foreword.
//
// Four model calls build a dashboard:
//   framing     - audit of the article being read (its own text)
//   comparison  - how other outlets headlined the same event
//   corpus      - patterns and a treatment ledger across the author's own articles
//   dashboard   - the final placements, built from the three above plus posts
//
// Every schema sets additionalProperties:false and lists every key as
// required (nullable where optional), as structured output needs.

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

// ------------------------------------------------------------------ stance
// Shared by every prompt. This is the posture the reader asked for: an auditor,
// not a summarizer.
export const AUDITOR_STANCE = `Posture

You are auditing for bias on behalf of a reader who is about to read the article. Work like an auditor, not a summarizer.

- Every choice in a text is a choice someone made: the verb's subject, which name is made prominent, the adjective, who is quoted first, who is not quoted, what is left out, what sits next to what. The author answers for the effect of those choices on the reader, whatever the motive.
- A benign explanation never cancels a finding. House style, deadline pressure, wire copy, click optimization and bias coexist all the time. Report the effect on the reader first. Motives, if you mention them at all, are a secondary note and never lower a severity.
- Absence of evidence is not neutrality. When the material is thin, say "insufficient material", never "neutral" or "balanced".
- Self-description carries no weight. Bios, author pages, employer blurbs, awards and "about" text describe how the author wants to be seen. Leaning and style come from output: articles and posts. If output is missing, the honest answer is "unclear", not "center".
- Conformity is not mitigation. If every outlet frames an event the same way, that is a fact to report, and it never lowers a finding's severity or a slant's strength.
- The symmetry test asks: would this framing have appeared if the actor's politics, party, affiliation or identity were flipped? Answer it only from evidence: the same author's or outlet's treatment of other actors, or other outlets' treatment of this one. Where no such evidence is in front of you, the answer is "undetermined", never a guess dressed as likelihood.
- Suspicion is not sloppiness. Quote exact words. Name the effect precisely. Never invent a source, a quote or a fact. If you cannot support a finding with a quote, do not make it.

What to look for: who does the verb (agent framing); which names and brands are made salient and which are hidden; adjective and verb valence toward each actor; sourcing monoculture (one institution's account presented as the account); who is quoted, at what length, and who is characterized instead of quoted; euphemism and loaded terms; "critics say" asymmetries; passive voice for some actors and active for others; insinuation by omission (a fact left hanging next to a suggestive detail); insinuation by juxtaposition (related links, photos, sidebars that imply a connection the text does not claim); headline that says more than the body supports; story selection and what beats the author returns to; corrections that quietly reframe.`;

// ---------------------------------------------------------------- framing
const SEVERITY = ["high", "medium", "low"];

export const FRAMING_SCHEMA = obj({
  slant: obj({
    favors: arr(str("An actor, group, company, party or position this article's framing works in favor of. Empty if none."), ""),
    disfavors: arr(str("An actor, group, company, party or position this article's framing works against. Empty if none."), ""),
    summary: str("At most 30 words. The net effect of the framing on a reader, stated plainly."),
    strength: en(["strong", "moderate", "slight", "none-detected"], "How hard the framing pushes."),
  }, ""),
  findings: arr(obj({
    type: en(["agent-framing", "salience", "loaded-language", "sourcing", "quote-selection", "omission", "insinuation", "juxtaposition", "headline-body-gap", "asymmetry", "other"], ""),
    locus: en(["headline", "subhead", "body", "related-module", "photo-or-caption", "other"], "Where in the piece the choice sits. Headlines, subheads and related modules are usually written or placed by editors or automated systems, not the bylined author; the body is the author's."),
    severity: en(SEVERITY, ""),
    quote: str("The exact words from the article (or the related-link text) that carry the effect. Under 160 characters."),
    effect: str("At most 25 words. What this does to the reader's understanding, and who it favors or disfavors."),
  }), "Three to eight findings, most consequential first. Each must rest on a quote."),
  symmetryTest: str("At most 40 words. State the counterfactual (the same event with the actor's politics, party, affiliation or identity flipped) and what this text alone can say about it. This article by itself usually cannot settle it; say 'undetermined from this text' when so. The body-of-work analysis answers it."),
  authorVsOutlet: str("At most 30 words. Which findings belong to the bylined author (body text, quotes chosen, facts included) and which to the outlet (headline, subhead, modules, photos). Both count; the reader should know whose choice each was."),
  sourcing: obj({
    voices: arr(str("Each distinct source or voice the article relies on, named by role, not by what you expect to find."), ""),
    monoculture: en(["yes", "partly", "no"], "Whether one institution's account is presented as the account."),
  }, ""),
  missing: arr(str("At most 15 words each. A perspective, fact or question a fair treatment would include and this article does not."), "Up to four."),
  genre: en(["breaking-news", "news-report", "analysis", "opinion", "feature", "other"], "What kind of piece this is, judged from the text."),
});

export function framingSystemPrompt() {
  return `${AUDITOR_STANCE}

Task

Audit one article for framing. You get its headline, subhead, body text, and the text of any related links or sidebars shown inside it. Produce the slant, the findings with quotes, the symmetry test, the split between author and outlet, the sourcing picture, what is missing, and the genre. Be concrete and brief; the reader sees this before reading the piece.

Attribute each finding to its locus. Headlines, subheads, photo captions and related modules are usually an editor's or a system's choice; the body is the author's. Attribution changes whose bias it is, not whether it is bias.`;
}

export function framingUserMessage({ author, publication, title, subhead, url, fullText, relatedLinks, publishedAt }) {
  const related = relatedLinks?.length ? `\nRelated links and sidebar text shown inside the article:\n${relatedLinks.map((r) => `- ${r.text}${r.href ? ` (${r.href})` : ""}`).join("\n")}` : "";
  return [
    `Author: ${author}`,
    publication ? `Publication: ${publication}` : null,
    url ? `URL: ${url}` : null,
    publishedAt ? `Published: ${publishedAt}` : null,
    `\nHeadline: ${title || "(none captured)"}`,
    subhead ? `Subhead: ${subhead}` : null,
    `\nBody:\n"""\n${fullText || "(no body captured)"}\n"""`,
    related,
    "\nAudit this article.",
  ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------- comparison
export const COMPARISON_SCHEMA = obj({
  event: str("At most 20 words. What the article is about, stated neutrally, so the reader can see what is being compared."),
  coverage: arr(obj({
    outlet: str(""),
    headline: str("Verbatim as given."),
    url: str("Exactly as given."),
    agent: nullableStr("Who or what the headline makes the actor: the grammatical subject of its main verb, in the headline's own words. Null if unclear."),
    namesBrand: en(["yes", "no", "n/a"], "Whether the headline names the company, party or person that this article's headline makes salient."),
  }), "Every other outlet's item you were given, in the order given."),
  verdict: en(["outlier", "leans-one-way", "in-line", "insufficient-comparison"], "Whether this article's headline framing deviates from the field."),
  note: str("At most 40 words. How this article's headline compares with the field, with the specific difference named. If most outlets did the same thing, say so and say what that implies."),
});

export function comparisonSystemPrompt() {
  return `${AUDITOR_STANCE}

Task

Compare how this article's headline frames an event against how other outlets headlined the same event. Read each headline for its agent, its salient names and brands, and its valence. Then say whether this article is an outlier, leans one way, or is in line with the field. A field that all frames the same way is a finding too: it tells the reader the framing is an industry habit, which does not make it fair.`;
}

export function comparisonUserMessage({ title, publication, url }, items) {
  return [
    `This article's headline (${publication || "unknown outlet"}): ${title}`,
    url ? `URL: ${url}` : null,
    "\nOther coverage of what appears to be the same event (title, outlet, URL, excerpt):",
    ...items.map((it, i) => `[${i + 1}] ${it.title}\n    ${it.outlet} — ${it.url}\n    ${it.content ? it.content.replace(/\s+/g, " ").slice(0, 240) : "(no excerpt)"}`),
    "\nDrop any item that is clearly a different event. Compare the rest.",
  ].filter(Boolean).join("\n");
}

// ----------------------------------------------------------------- corpus
const TREATMENT = ["favorable", "sympathetic", "neutral", "skeptical", "hostile", "mixed"];

export const CORPUS_SCHEMA = obj({
  articlesRead: { type: "integer", description: "How many of the provided articles had usable text." },
  patterns: arr(obj({
    pattern: str("At most 25 words. A recurring framing or sourcing habit, stated concretely enough that another reader could check it against the articles."),
    examples: arr(obj({ articleId: str("The article id (a1, a2, ...)."), quote: str("Exact words, under 160 characters.") }), "One to three examples from different articles where possible."),
    effect: str("At most 20 words. Who the habit favors or disfavors."),
  }), "Three to six patterns, strongest first. A pattern needs at least two articles unless it is stark."),
  ledger: arr(obj({
    subject: str("A recurring politicized subject: a company, person, party, institution, group, policy."),
    treatment: en(TREATMENT, ""),
    evidence: str("At most 30 words summarizing the treatment, with one quoted phrase."),
    articleIds: arr({ type: "string" }, ""),
  }), "How the author treats subjects that recur across the articles. Only subjects that appear in two or more articles, or that get pointed treatment in one. Up to ten."),
  storySelection: str("At most 40 words. What the author chooses to cover and from what angle, judged from the set of articles."),
  revealedLeaning: obj({
    political: en(["left", "center-left", "center", "center-right", "right", "unclear"], ""),
    social: en(["progressive", "leans-progressive", "mixed", "leans-traditional", "traditional", "unclear"], ""),
    economic: en(["interventionist", "leans-interventionist", "mixed", "leans-market", "free-market", "unclear"], ""),
    confidence: en(["high", "medium", "low", "none"], ""),
    why: str("At most 40 words. What in the output supports this, referencing article ids. 'unclear' with none when the articles are too few or too apolitical."),
  }, "Leaning as revealed by the author's output alone. Ignore anything the author or employer says about themselves."),
  styleFromOutput: obj({
    opinion: en(["reporting", "mostly-reporting", "mixed", "mostly-opinion", "advocacy", "unclear"], ""),
    lens: en(["many-perspectives", "mostly-balanced", "mixed", "mostly-one-lens", "single-lens", "unclear"], ""),
    why: str("At most 30 words, with article ids."),
  }, ""),
});

export function corpusSystemPrompt() {
  return `${AUDITOR_STANCE}

Task

You get several full articles by one author. Read them as a body of work and report the recurring habits with quoted examples, a treatment ledger for the subjects that recur, what the author chooses to cover, and the leaning and style the output reveals. Patterns across articles are the evidence; a single sentence is not a pattern unless it is stark. Reference articles by their ids.`;
}

export function corpusUserMessage({ author, publication }, articles) {
  return [
    `Author: ${author}`,
    publication ? `Publication: ${publication}` : null,
    `\n${articles.length} articles by this author follow.`,
    ...articles.map((a) => `\n[${a.id}] ${a.title || "(untitled)"}${a.date ? ` — ${a.date}` : ""}\n${a.url}\n"""\n${a.text}\n"""`),
    "\nAnalyze the body of work.",
  ].filter(Boolean).join("\n");
}

// -------------------------------------------------------------- dashboard
const CONFIDENCE = ["high", "medium", "low", "none"];
const ids = arr({ type: "string" }, "Ids of sources (s1, s2, ...) or articles (a1, a2, ...) that support this. Empty only when confidence is none.");
const BASIS = ["articles", "posts", "articles-and-posts", "self-description-only", "none"];

function axis(values, description) {
  return obj(
    {
      position: en(values, description),
      confidence: en(CONFIDENCE, "none means the output is too thin to place them; then position must be 'unclear'."),
      basis: en(BASIS, "What the placement rests on. self-description-only is not a valid basis for a position other than 'unclear'."),
      why: str("At most 20 words. The single strongest reason, concrete: a quoted phrase, a ledger entry, a pattern."),
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
  currentRole: nullableStr("Job title and outlet, as the sources state it."),
  bottomLine: str("At most 40 words. What a sharp friend would say before handing you this article: what this author's output shows about where they stand and how they frame, and what that means for this piece."),
  selfPortrait: nullableStr("At most 25 words. How the author or employer describes them, from bios and author pages, so the reader can see the gap between portrait and output. Null if none found."),

  leanings: obj({
    political: axis(POLITICAL, "Overall political orientation as revealed by output, in the terms of the author's own country."),
    social: axis(SOCIAL, "Cultural and social questions: immigration, gender and sexuality, religion in public life, crime and policing, identity, tradition."),
    economic: axis(ECONOMIC, "Role of the state in the economy: taxes, regulation, redistribution, unions, trade, markets."),
  }, "Where the output places the author. The corpus analysis and the author's own posts are the evidence; bios are not."),

  style: obj({
    opinion: axis(OPINION, "How much of their output argues rather than reports, and whether opinion is presented as settled fact."),
    lens: axis(LENS, "Whether they read events through one consistent frame, or engage and fairly state views they disagree with."),
  }, "How they work, judged from articles."),

  symmetry: obj({
    verdict: en(["asymmetric", "symmetric", "undetermined"], "asymmetric: the author or outlet treats comparable actors differently. symmetric: comparable actors get the same treatment. undetermined: no comparable case in the evidence."),
    why: str("At most 40 words. The comparable cases you used: how this author or outlet framed other actors in the same situation (from the articles read), or how the field framed this actor. Cite ids."),
    sourceIds: ids,
  }, "The symmetry test for this article's framing, answered from the body of work and the field, not from the article alone."),
  watchFor: arr(str("At most 18 words. One concrete thing to keep in mind while reading this specific article, tied to this author's habits, this article's framing, or the field comparison."), "Exactly three when evidence allows; fewer if not."),

  evidence: arr(obj({
    kind: en(["post", "article", "pattern", "ledger", "interview", "record", "other"], ""),
    axis: en(["political", "social", "economic", "opinion", "lens", "identity", "other"], "Which judgment this supports."),
    text: str("A verbatim quote under 200 characters for posts, articles and interviews; a one-line statement for patterns and ledger entries."),
    date: nullableStr("ISO date or year if known."),
    sourceId: str("The source or article id this comes from."),
  }), "Six to ten strongest items, most telling first. The author's own words first."),

  recentWork: arr(obj({
    title: str(""),
    url: str("Exactly as given."),
    date: nullableStr(""),
    kind: en(["reporting", "analysis", "opinion", "unclear"], ""),
    note: nullableStr("At most 15 words: the framing or take, if any."),
  }), "Up to eight previous pieces, newest first, from the articles read and the sources."),

  background: obj({
    career: arr(obj({ organization: str(""), role: str(""), years: nullableStr(""), sourceIds: ids }), "At most five, newest first."),
    education: arr(obj({ institution: str(""), detail: nullableStr(""), sourceIds: ids }), "At most three."),
    location: nullableStr("City or region only. Never a street address."),
  }, "Context only; carries no weight for leaning."),
  affiliations: arr(obj({
    organization: str(""),
    relationship: str("employee, fellow, board member, donor, funded by, member, spokesperson, etc."),
    sourceIds: ids,
  }), "Institutional ties that bear on perspective. At most six."),
  interests: arr(str("Two to five words each."), "Recurring beats and causes. At most six."),
  profiles: arr(obj({
    label: en(["Author page", "Personal site", "Wikipedia", "X", "Bluesky", "Mastodon", "Threads", "Instagram", "LinkedIn", "Substack", "YouTube", "Muck Rack", "Other"], ""),
    url: str("Full URL exactly as it appeared in a source. Never guess a handle."),
  }), "Every public profile URL that appeared in the sources."),
  sources: arr(obj({
    id: str("Id as given (s1, s2, ... or a1, a2, ...)."),
    title: str(""),
    url: str(""),
    publisher: nullableStr(""),
    date: nullableStr(""),
  }), "Only the provided sources and articles you relied on, copied exactly."),
  caveats: arr(str("One sentence each."), "Limits: thin output, possible mix-ups, unverified accounts, stale sources. At most four."),
});

export function dashboardSystemPrompt() {
  return `${AUDITOR_STANCE}

Task

Build the final one-glance dashboard for one author. You get: the article's context; an audit of this article's framing; a comparison of its headline with other outlets; an analysis of the author's other articles with a treatment ledger and a revealed leaning; the author's social accounts and recent posts when found; and web sources (bios, profiles, interviews, records).

Weigh them in this order: the author's own posts and the corpus analysis first, the article audit second, interviews and public records third, bios and author pages last and only for role, career and the self-portrait line.

Answer the symmetry test here, from evidence: look in the articles read for the same kind of event with a different actor and compare the framing; look in the field comparison for how others framed this actor. If neither offers a comparable case, the verdict is undetermined and says what evidence would settle it. A position other than 'unclear' must rest on articles or posts; if all you have is self-description, the axis is 'unclear' with basis 'self-description-only'.

Identity first: names collide. Confirm the person from the outlet, beat and subject. For each social account, check the display name, bio and subject matter against the author; an unconfirmed account can support at most low confidence and goes in caveats.

Public and professional only. No home addresses, phone numbers, personal email, health information, or family members who are not public figures. Do not speculate about ethnicity, religion, sexual orientation or gender identity; mention such a thing only when the author has publicly discussed it as part of their own perspective.

Cite everything by id. Copy titles and URLs exactly. Word limits in the schema are hard limits. Short, concrete, plain.`;
}

export function buildQueries({ author, publication, title, url }) {
  const q = `"${author}"`;
  const topic = topicKeywords(title);
  const domain = domainOf(url);
  const list = [
    domain ? `${q} site:${domain}` : `${q} articles`,
    publication ? `${q} ${publication}` : `${q} journalist`,
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

/** Query for other outlets' coverage of the same event: the headline's keywords, no author. */
export function eventQuery({ title, subhead }) {
  const words = topicKeywords(title, 8);
  return words || (subhead ? topicKeywords(subhead, 8) : "");
}

function topicKeywords(title, n = 5) {
  const stop = new Set("a an the and or of to in on for with by from at as is are was were be this that these those it its into over under after before why how what when where who will can could should would new says said say".split(" "));
  return (title || "")
    .replace(/[:|—–-].*$/, (m) => (m.length > 30 ? "" : m)) // keep short trailing attribution suffixes, drop long subtitles
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()))
    .slice(0, n)
    .join(" ");
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
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

function block(title, value) {
  if (!value) return null;
  return `\n${title}:\n${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`;
}

export function buildUserMessage({ author, publication, title, url, excerpt, publishedAt }, sources = [], accounts = [], analyses = {}) {
  const sourceBlock = sources.length
    ? "\nGathered sources:\n" +
      sources
        .map((s) => `[${s.id}] ${s.title}\n${s.url}\n${s.content ? s.content.replace(/\s+/g, " ").trim() : "(no excerpt)"}`)
        .join("\n\n")
    : "\nGathered sources: none were found.";
  const articleList = analyses.articles?.length
    ? "\nArticles by the author that were read in full (ids usable as sources):\n" +
      analyses.articles.map((a) => `[${a.id}] ${a.title || "(untitled)"}${a.date ? ` — ${a.date}` : ""}\n${a.url}`).join("\n")
    : "\nArticles by the author read in full: none could be fetched.";
  const lines = [
    `Author: ${author}`,
    publication ? `Publication: ${publication}` : null,
    title ? `Article title: ${title}` : null,
    url ? `Article URL: ${url}` : null,
    publishedAt ? `Published: ${publishedAt}` : null,
    excerpt ? `\nOpening of the article:\n"""\n${excerpt}\n"""` : null,
    block("Audit of this article's framing", analyses.framing),
    block("Headline comparison with other outlets", analyses.comparison),
    block("Analysis of the author's other articles", analyses.corpus),
    articleList,
    sourceBlock,
    accountBlock(accounts),
    "\nBuild the dashboard for this author.",
  ].filter(Boolean);
  return lines.join("\n");
}
