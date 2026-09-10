# Foreword

A Chrome extension that gives every article the foreword it never had: a one-glance dashboard on the author.

When two people talk face to face, each knows where the other is coming from and reads what is said in that light. A book carries a foreword and an author bio that do the same job. A news article or opinion piece usually offers only a name. Foreword fills in that missing context from public sources, so you can weigh the piece for yourself before you read it.

## What you see

Open an article, click the "Who is …?" badge, and a side panel shows:

- **Bottom line.** At most 40 words on what this author's output shows and what it means for this piece. Under it, the **self-portrait**: how the author or employer describes them, shown only so you can see the gap.
- **This article.** An audit of the piece you are about to read: the net slant and who it favors or disfavors, three to eight findings each anchored to a quote (agent framing, salience, loaded language, sourcing, omission, insinuation, juxtaposition, headline-body gap), each tagged with its locus so you can tell an editor's headline from the author's body text, the voices the article relies on, and what a fair treatment would include. Then the **headline comparison**: how other outlets headlined the same event, with this article highlighted and a verdict of outlier, leans one way, or in line.
- **Symmetry test.** Would this framing appear with the actor's politics or affiliation flipped? Answered from evidence only: how the same author or outlet framed comparable actors in the articles read, or how the field framed this one. With no comparable case it says undetermined rather than guessing.
- **Leaning, from output.** Political, social and economic position on five-step meters, each with a confidence tag, its basis (articles, posts, both, or self-description only), the strongest reason, and source links. Below the meters, the **treatment ledger**: how the author treats each subject that recurs across their articles, from favorable to hostile, with evidence.
- **Style, from articles.** Reporting versus advocacy, and one lens versus many perspectives, followed by the recurring **patterns** found in the body of work, each with quoted examples.
- **Watch for.** Three short things to keep in mind for this specific article.
- **Evidence.** The strongest quotes from the author's own posts, articles and interviews, each linked.
- **Previous pieces.** Recent work, tagged reporting, analysis or opinion, with the ones read in full marked.
- **Photos.** A strip of recent images from social profiles, author pages, Wikimedia and image search.
- **More.** Career, education, affiliations, profile links, every source, and which articles were fetched.

The scales:

| Meter | Left end | Right end |
| --- | --- | --- |
| Political | Left | Right (in the author's own country's terms) |
| Social | Progressive | Traditional (immigration, gender and sexuality, religion in public life, crime, identity) |
| Economic | Interventionist | Free market (taxes, regulation, redistribution, unions, trade) |
| Opinion | Reporting | Advocacy (share of output that argues rather than reports) |
| Lens | Many perspectives | Single lens (engages opposing views, or reads everything through one frame) |

### The stance

Every prompt shares one posture, written for an auditor rather than a summarizer: every choice in a text is a choice someone made, and the author answers for its effect on the reader whatever the motive. A benign explanation (house style, deadline, click optimization) never cancels a finding; it sits beside it. Absence of evidence is not neutrality, so thin material reads "insufficient", never "balanced". Conformity is not mitigation: if every outlet framed the event the same way, that is reported, and it never lowers a severity. Self-description carries no weight: bios, author pages and employer blurbs describe how the author wants to be seen, so leaning and style come only from output, the author's articles and posts. A meter can show a position only when it rests on articles or posts; with nothing but a bio it reads "Only self-description found". And every finding must rest on an exact quote, because suspicion is not sloppiness.

Everything covers only public and professional information. Treat it as a lens on the author, not a verdict on the article.

## How it works

1. **Read the page.** A content script captures the byline (JSON-LD, then meta tags, then byline markup), the publication, the headline and subhead, the full body text, the text of related links and sidebars shown inside the article, and the byline's own link and photo when present.
2. **Search.** The background worker runs templated web searches through OpenRouter's web plugin on a cheap relay model: the author's other pieces on the same site, name plus outlet, social profiles, opinion columns, bio, the article's topic, Wikipedia, interviews, affiliations, education. Every result becomes a numbered source.
3. **Read the author, in parallel.** Three things happen at once, none needing a key: the author's other articles are fetched in full (from the author page and the same-site search results, up to eight by default, byline checked), their X, Bluesky or Mastodon bio and recent posts are fetched when a profile surfaced, and other outlets' coverage of the same event is searched.
4. **Analyze, in parallel.** The writing model runs three structured calls: an audit of this article's text, a comparison of its headline against the field, and an analysis of the body of work that yields patterns with quotes, the treatment ledger, and the leaning and style the output reveals.
5. **Build the dashboard.** A final call weighs the three analyses and the posts first, interviews and records second, and bios last, and returns the placements, watch-fors, evidence and previous pieces as structured JSON. Only provided sources can be cited. Models without structured-output support get a prompt-only JSON request instead.
6. **Photos.** The byline photo and author page from the article itself, Bluesky and Mastodon public APIs, X's public syndication timeline, Wikimedia Commons and Wikidata, DuckDuckGo and Bing image search, and a scrape of every page found in step 2, scored so headshots outrank logos and stock art.
7. **Cache.** Profiles are stored locally for 14 days by default. Profiles built by an earlier pipeline show a "Rebuild it" notice.

The panel is an extension page rendered in an iframe, so site styles and content security policies cannot interfere with it.

## Install

1. Clone the repository:
   ```
   git clone https://github.com/abdielou/foreword.git
   ```
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the repository folder.
3. The options page opens on first install. Paste an OpenRouter key from [openrouter.ai/keys](https://openrouter.ai/keys), pick a writing model, click **Test**, then **Save**.

There is no build step; the extension is plain HTML, CSS and JavaScript.

### Updating

Run `scripts\pull.ps1` (or `scripts\pull.bat`) from the checkout, or `git pull` on `main`. Then click the reload icon on the extension's card in `chrome://extensions`. The options page header shows the loaded build (version, commit hash, branch, commit date, read from the checkout's `.git` folder); compare the hash with what the script prints or with `git rev-parse --short HEAD`. If you rename or move the folder, remove the extension and Load unpacked again from the new path.

## Use

- On an article with a byline, a small "Who is …?" badge appears at the bottom of the page. Click it to open the panel. Close the badge with × to hide it for that page.
- Click the toolbar icon to see the detected author, correct the name if detection got it wrong, and open the panel.
- In the panel, ↻ researches again and ignores the cache. Esc closes it.
- Each meter's reason and each evidence item link to the source they came from. "Photo sources tried" under the photos lists every source attempted and why any failed.

### Options

- **API key**: your OpenRouter key. **Test** checks it and shows the key's usage.
- **Writing model**: any OpenRouter model id. The field suggests the live model list with pricing, and the "Newest from…" menu fills in the latest structured-output-capable model from any provider.
- **Search relay model**: a cheap model that only carries web search results.
- **Web searches per profile** and **results per search**: the cost and depth of research.
- **Author's articles to read in full**: how many previous pieces feed the body-of-work analysis (default 8, 0 to skip).
- **Keep cached profiles for**: days before a profile is rebuilt.
- **Badge**, **auto-build on every article** (spends credit on each page), and **panel side**.
- **Clear cached profiles**.

## Cost and privacy

- Your OpenRouter key lives in Chrome's extension storage and is sent only to `openrouter.ai`.
- A new profile is nine small search requests (eight for the author, one for the event) plus four writing-model calls: the article audit, the headline comparison, the body-of-work analysis, and the dashboard. OpenRouter's web plugin charges about $0.004 per search result, so searches cost around $0.18; the writing calls depend on the model and on how many articles are read, roughly 2,000 input tokens per article. Cached profiles cost nothing to reopen.
- What leaves the browser: the author's name, the publication, the article's headline, subhead, body text and related-link text, the search results, the full text of the author's other articles, and the author's recent public posts, all sent to OpenRouter. The photo and post collectors fetch public pages and APIs directly, with no key and nothing sent to a model. That is why the extension asks for access to all sites.
- Nothing runs until you click the badge or the popup, unless you turn on auto-build in options.

## Layout

```
manifest.json
src/background/service-worker.js   message routing, per-tab state, caching, photo enrichment, keepalive
src/background/openrouter.js       OpenRouter client and the pipeline: search, read, three analyses, dashboard
src/background/prompt.js           auditor stance, the four schemas and prompts, search query templates
src/background/articles.js         finds and extracts the author's other articles
src/background/images.js           recent posts and photos: Bluesky, Mastodon, X, Commons, Wikidata, image search, page scraping
src/background/wikipedia.js        photo and description lookup
src/content/content.js             byline detection, badge, panel iframe
src/panel/                         the dashboard panel (extension page)
src/popup/                         toolbar popup
src/options/                       settings page with build stamp
src/shared/                        constants, storage helpers, build info
scripts/make-icons.mjs             regenerates icons/ (node scripts/make-icons.mjs)
scripts/pull.ps1, pull.bat         pull the latest commit into a local checkout
```

## Known limits

- Instagram, Threads, LinkedIn and Facebook are closed without login, so those appear only as links. The X syndication and image search endpoints are unofficial and may rate limit or change; failures show under "Photo sources tried", and the panel links out to Google, DuckDuckGo and Bing image search as a manual route.
- Photo matching is heuristic. A photo of someone else can slip in, especially for common names, which is why each image links to the page it came from.
- Only social accounts that surface in the search results feed the analysis. If an author's account never appears in a search, their posts are not read. Pseudonymous accounts cannot be found at all.
- The body-of-work analysis depends on fetching the author's articles. Paywalled or bot-blocked sites yield few or none, and the dashboard says so; the ledger and patterns then rest on whatever was readable.
- The headline comparison depends on the event search finding other outlets' coverage. Very local or very fresh stories may have none yet.
- Byline detection is heuristic. Sites that render bylines late or use unusual markup may need the name typed in the popup.
- A model researching the open web can still confuse people who share a name. The panel flags identity confidence and lists caveats; follow the sources for anything that matters.
