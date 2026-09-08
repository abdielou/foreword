// System prompt and output schema for the author profile.
//
// The schema is sent as a structured-output format, so the model's final
// answer is guaranteed to parse. Every object sets additionalProperties:false
// and lists every key as required (nullable where optional), as the API needs.

const BASIS = ["self-described", "public-record", "reported", "inferred"];

function str(description) {
  return { type: "string", description };
}
function nullableStr(description) {
  return { anyOf: [{ type: "string" }, { type: "null" }], description };
}
function obj(properties, description) {
  return {
    type: "object",
    description,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
function arr(items, description) {
  return { type: "array", items, description };
}

const indicator = obj(
  {
    claim: str("One specific, checkable observation. Prefer what the person did or said over labels."),
    basis: { type: "string", enum: BASIS, description: "self-described: the author said it about themselves. public-record: donations, registrations, court or corporate filings. reported: a third party (news, bio page) says it. inferred: your reading of their body of work; use sparingly and say so." },
    sourceIds: arr({ type: "string" }, "Ids from the sources list that support this claim. Required for every basis except inferred."),
  },
  "A single evidence-backed observation."
);

export const PROFILE_SCHEMA = obj({
  name: str("Canonical full name of the author."),
  identityConfidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are that the sources describe the same person who wrote this article." },
  identityNote: nullableStr("If confidence is not high, explain the ambiguity (common name, several people, sparse footprint)."),
  oneLiner: str("A single sentence a friend would use to introduce this person: role, outlet, beat, and what they are known for."),
  foreword: str("Two to four short paragraphs, plain prose, written for a reader who is about to read this article. Cover: who is speaking, the vantage point they write from, and what a fair-minded reader should keep in mind. Even-handed; expertise counts as much as leanings."),
  currentRole: nullableStr("Current job title and employer, if known."),
  background: obj({
    education: arr(obj({ institution: str("School or university."), detail: nullableStr("Degree, field, years, if known."), sourceIds: arr({ type: "string" }, "") }), ""),
    career: arr(obj({ organization: str(""), role: str(""), years: nullableStr("e.g. '2015-2019' or 'since 2021'"), sourceIds: arr({ type: "string" }, "") }), "Most relevant positions, newest first, at most eight."),
    location: nullableStr("City or region they are publicly based in. Never a street address."),
  }, ""),
  politics: obj({
    overview: str("Two or three sentences on political orientation and worldview as evidenced publicly. If there is no evidence, say so plainly instead of guessing."),
    leaning: nullableStr("A short, hedged label such as 'center-left, per outlet and self-description' or null if not supportable."),
    indicators: arr(indicator, "Concrete evidence: outlets written for, party or campaign work, public donations, endorsements, self-descriptions, positions taken repeatedly."),
  }, ""),
  affiliations: arr(obj({
    organization: str(""),
    relationship: str("Employee, fellow, board member, donor, funded by, member, spokesperson, etc."),
    whyItMatters: nullableStr("Only if the relationship plausibly shapes how they cover this article's subject."),
    sourceIds: arr({ type: "string" }, ""),
  }), "Think tanks, parties, advocacy groups, companies, funders, boards. Institutional ties that bear on perspective."),
  interests: arr(obj({ topic: str(""), note: nullableStr("How it shows up in their work.") }), "Recurring beats, themes, hobbies or causes the author returns to. At most eight."),
  socialPositions: obj({
    overview: str("Positions the author has publicly taken on social and cultural questions, and the cultural milieu they write from. Report only what they have said or written publicly; do not speculate about private identity."),
    indicators: arr(indicator, ""),
  }, ""),
  relevantToThisArticle: arr(obj({
    point: str("A connection between the author's background and the subject of this specific article: prior coverage, a stake, a stated position, direct experience, or expertise."),
    kind: { type: "string", enum: ["expertise", "prior-position", "potential-conflict", "personal-stake", "prior-coverage"] },
    sourceIds: arr({ type: "string" }, ""),
  }), "The most useful section. Three to six items."),
  readingQuestions: arr({ type: "string" }, "Three to five short questions a reader could keep in mind while reading this article, tailored to this author and topic. Neutral in tone."),
  images: arr(obj({
    url: str("Direct URL to an image file (ends in .jpg/.jpeg/.png/.webp or is a Wikimedia upload URL). Must be a URL you actually saw in a fetched page or search result. Never invent one."),
    sourceUrl: str("Page where the image appears."),
    caption: nullableStr("Where the photo is from and roughly when, if known."),
    approxDate: nullableStr("Year or date of the photo, if known."),
  }), "Recent, publicly posted photos of the author: author page headshots, Wikimedia Commons, conference pages, publisher bios. Newest first. Up to four. Empty if none found."),
  profiles: arr(obj({
    label: str("Wikipedia, X, Bluesky, LinkedIn, Mastodon, Substack, personal site, author page at outlet, Muck Rack, etc."),
    url: str(""),
  }), "Public profile pages where a reader can see more, including the most recent photos and posts."),
  sources: arr(obj({
    id: str("Short id like s1, s2 referenced by sourceIds above."),
    title: str(""),
    url: str(""),
    publisher: nullableStr(""),
    date: nullableStr("Publication date if visible."),
  }), "Every source you relied on."),
  caveats: arr({ type: "string" }, "Limits of this profile: thin footprint, possible mix-ups, outdated info, anything a reader should discount."),
});

export const SYSTEM_PROMPT = `You write the foreword a reader wishes every article came with.

When two people talk face to face, each knows where the other is coming from and reads what is said in that light. A book carries a foreword and an author bio that do the same job. A news article or opinion piece usually offers only a name. Your job is to give the reader that missing context about the author so they can weigh the piece for themselves.

You research one author and return a structured profile. The request includes web search results already gathered for this author: numbered sources with a title, URL and excerpt. Read them closely. You may add what you reliably know about a public figure, but anything that is not supported by a provided source must be marked inferred, and you must never invent a source.

Principles

1. Identity first. Names collide. Use the outlet, the beat, the article's subject and any bio line to confirm you have the right person. If two candidates remain, say so, set identityConfidence to medium or low, and describe the better-supported one.

2. Evidence over labels. "Was a policy fellow at the Cato Institute 2016-2019" beats "libertarian". Where a label helps, attach it to its evidence and hedge it. Mark each indicator with its basis: self-described, public-record, reported, or inferred. Inferred claims are allowed but must be labeled and few.

3. Public and professional only. Report what the author has published, said in public, listed in public bios, or what appears in public records about their professional and civic life. Do not include home addresses, phone numbers, personal email, health information, names of minor children, or family members who are not public figures. Do not speculate about ethnicity, religion, sexual orientation, or gender identity; mention such a thing only when the author has publicly discussed it as part of their own perspective, and mark it self-described.

4. Even-handed. Expertise and direct experience are as important to a reader as leanings. Give credit where the record supports it. Someone who covered a beat for twenty years has a vantage point, not just a bias. Write the foreword as a fair introduction, not a case for the prosecution.

5. Relevance to this article. The reader is about to read a specific piece. The most useful section connects the author's background to this subject: prior coverage, positions they have taken, stakes or conflicts, and expertise. Prefer this over generic biography.

6. Cite everything. Every non-inferred claim points to sources by their given id (s1, s2, ...). The sources list in your answer must contain only the provided sources you actually relied on, with their ids, titles and URLs copied exactly. Do not cite anything that was not provided.

7. Images. Only list image URLs that literally appear in the provided source excerpts. Never construct or guess a URL. Usually this list will be empty; the profiles list still gives the reader somewhere to look.

8. Say what you do not know. Thin public footprint, stale sources and contradictions go in caveats. An honest "little public information is available" is a valid profile.

Write in plain, concrete prose. No hedging filler, no moralizing, no advice about what the reader should conclude.`;

function topicKeywords(title) {
  const stop = new Set("a an the and or of to in on for with by from at as is are was were be this that these those it its into over under after before why how what when where who will can could should would new says said".split(" "));
  return (title || "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()))
    .slice(0, 5)
    .join(" ");
}

/** Templated search queries, most useful first. */
export function buildQueries({ author, publication, title }) {
  const q = `"${author}"`;
  const topic = topicKeywords(title);
  const list = [
    publication ? `${q} ${publication}` : `${q} journalist`,
    `${q} journalist OR columnist OR writer bio`,
    `${q} wikipedia`,
    topic ? `${q} ${topic}` : `${q} opinion`,
    `${q} interview OR podcast`,
    `${q} twitter OR x.com OR linkedin OR substack`,
    `${q} think tank OR fellow OR foundation OR campaign`,
    `${q} education OR university OR graduated`,
  ];
  return Array.from(new Set(list));
}

export function buildUserMessage({ author, publication, title, url, excerpt, publishedAt }, sources = []) {
  const sourceBlock = sources.length
    ? "\nGathered sources:\n" +
      sources
        .map((s) => `[${s.id}] ${s.title}\n${s.url}\n${s.content ? s.content.replace(/\s+/g, " ").trim() : "(no excerpt)"}`)
        .join("\n\n")
    : "\nGathered sources: none were found. Say so in caveats, keep claims minimal, and mark everything you add as inferred.";
  const lines = [
    `Author: ${author}`,
    publication ? `Publication: ${publication}` : null,
    title ? `Article title: ${title}` : null,
    url ? `Article URL: ${url}` : null,
    publishedAt ? `Published: ${publishedAt}` : null,
    excerpt ? `\nOpening of the article (for topic context and identity disambiguation):\n"""\n${excerpt}\n"""` : null,
    sourceBlock,
    "\nWrite the profile for this author.",
  ].filter(Boolean);
  return lines.join("\n");
}
