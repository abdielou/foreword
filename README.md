# Foreword

A Chrome extension that gives every article the foreword it never had: a one-glance dashboard on the author.

When two people talk face to face, each knows where the other is coming from and reads what is said in that light. A book carries a foreword and an author bio that do the same job. A news article or opinion piece usually offers only a name. Foreword fills in that missing context from public sources, so you can weigh the piece for yourself before you read it.

## What you see

Open an article, click the "Who is …?" badge, and a side panel shows:

- **Bottom line.** One or two sentences on who this is and the angle they usually bring.
- **Leaning.** Political, social and economic position on five-step meters. Each carries a confidence tag, the single strongest reason in under twenty words, and links to its sources. When the record is thin the meter reads "Not enough evidence" instead of guessing.
- **Style.** Two more meters: how much of the author's output is reporting versus opinion, and whether they read events through one lens or engage many perspectives. Judged from previous pieces and posts.
- **Watch for.** Three short things to keep in mind for this specific article.
- **Evidence.** The strongest quotes from the author's own posts and interviews, plus one-line summaries of past articles and public records, each linked.
- **Previous pieces.** Recent work by the author, tagged reporting, analysis or opinion.
- **Photos.** A strip of recent images from social profiles, author pages, Wikimedia and image search, newest and most likely first.
- **More.** Career, education, affiliations, profile links and every source, folded away.

The scales:

| Meter | Left end | Right end |
| --- | --- | --- |
| Political | Left | Right (in the author's own country's terms) |
| Social | Progressive | Traditional (immigration, gender and sexuality, religion in public life, crime, identity) |
| Economic | Interventionist | Free market (taxes, regulation, redistribution, unions, trade) |
| Opinion | Reporting | Advocacy (share of output that argues rather than reports) |
| Lens | Many perspectives | Single lens (engages opposing views, or reads everything through one frame) |

Confidence is high, medium or low. The author's own social posts weigh most for leaning, and their past articles weigh most for style. Everything covers only public and professional information, and every judgment carries its evidence. Treat it as a lens on the author, not a verdict on the article.

## How it works

1. **Read the page.** A content script finds the byline (JSON-LD, then meta tags, then common byline markup), the publication, the headline, the opening paragraphs, and the byline's own link and photo when present.
2. **Search.** The background worker runs templated web searches through OpenRouter's web plugin on a cheap relay model: name plus outlet, the author's other pieces on the same site, social profiles, opinion columns, bio, the article's topic, Wikipedia, interviews, affiliations, education. Every result becomes a numbered source.
3. **Read their posts.** If the results include the author's X, Bluesky or Mastodon profile, the account bio and recent public posts are fetched directly, no key needed, and added as citable sources. The writing model is told to confirm each account belongs to the author before relying on it.
4. **Write the dashboard.** The writing model of your choice, through OpenRouter, reads the article context and every source and returns structured JSON: a position, confidence, reason and sources for each meter, three watch-fors, quoted evidence, and previous pieces. Only provided sources can be cited. Models without structured-output support get a prompt-only JSON request instead.
5. **Look up Wikipedia.** A photo and description when the author has an article.
6. **Collect photos.** In parallel: the byline photo and author page from the article itself, Bluesky and Mastodon public APIs (avatars and recent image posts with dates), X's public syndication timeline, Wikimedia Commons and Wikidata, DuckDuckGo and Bing image search for the author's name and publication, and a scrape of every page found in step 2. Page images are scored on filename, alt text and surrounding markup so headshots outrank logos, icons and stock art. Duplicates are collapsed across sizes.
7. **Cache.** Profiles are stored locally for 14 days by default, so reopening an article is free. Profiles built before the photo collector existed get photos added on open at no cost; profiles built before the dashboard show a "Rebuild it" notice, and rebuilding costs one run.

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
- **Keep cached profiles for**: days before a profile is rebuilt.
- **Badge**, **auto-build on every article** (spends credit on each page), and **panel side**.
- **Clear cached profiles**.

## Cost and privacy

- Your OpenRouter key lives in Chrome's extension storage and is sent only to `openrouter.ai`.
- A new profile is a handful of small search requests plus one writing request. OpenRouter's web plugin charges about $0.004 per search result, so the default eight searches of five results cost around $0.16, plus the writing model's tokens. Cached profiles cost nothing to reopen.
- What leaves the browser: the author's name, the publication, the article title and URL, the article's first paragraphs, the search results, and the author's recent public posts, all sent to OpenRouter. The photo and post collectors fetch public pages and APIs directly, with no key and nothing sent to a model. That is why the extension asks for access to all sites.
- Nothing runs until you click the badge or the popup, unless you turn on auto-build in options.

## Layout

```
manifest.json
src/background/service-worker.js   message routing, per-tab state, caching, photo enrichment, keepalive
src/background/openrouter.js       OpenRouter client: gather searches, fetch posts, structured synthesis
src/background/prompt.js           system prompt, dashboard JSON schema, search query templates
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
- Only social accounts that surface in the search results feed the writing step. If an author's account never appears in a search, their posts are not read.
- Byline detection is heuristic. Sites that render bylines late or use unusual markup may need the name typed in the popup.
- A model researching the open web can still confuse people who share a name. The panel flags identity confidence and lists caveats; follow the sources for anything that matters.
