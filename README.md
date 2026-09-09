# Author Lens

A Chrome extension that gives every article a foreword.

When two people talk face to face, each knows where the other is coming from and reads what is said in that light. A book carries a foreword and an author bio that do the same job. A news article or opinion piece usually offers only a name. Author Lens fills in that missing context, from public sources, so you can weigh the piece for yourself.

Open an article, click the "Who is …?" badge, and a side panel shows:

- **A foreword**: a few plain paragraphs on who is speaking, the vantage point they write from, and what a fair-minded reader should keep in mind.
- **Relevant to this article**: prior coverage, positions taken, stakes or conflicts, and expertise that bear on this specific piece.
- **Politics & worldview**, **affiliations & funding**, **social & cultural positions**, **background** (career, education), and **interests**.
- **Questions to keep in mind** while reading, tailored to the author and topic.
- **Recent photos** and links to public profiles, plus every source used.

Every observation is labeled by its basis (self-described, public record, reported, or inferred) and linked to a source. The profile covers only public and professional information. It does not speculate about private identity, and it is written as a fair introduction rather than a case for the prosecution. Treat it as a lens, not a verdict.

## How it works

1. A content script reads the page's byline (JSON-LD, meta tags, then common byline markup), the publication, the headline, and the opening paragraphs.
2. The background service worker runs several templated web searches through OpenRouter's web plugin (name plus outlet, bio, Wikipedia, the article's topic, interviews, social profiles, affiliations, education) on a cheap relay model, collecting every result as a numbered source.
3. If those results include the author's X, Bluesky or Mastodon profile, their bio and recent public posts are fetched directly (no key) and added as citable sources. Posts are the most candid evidence of social, cultural and economic positions; the writing model is told to confirm each account really belongs to the author before relying on it.
4. It then asks the writing model of your choice, through OpenRouter, to read the article context and those sources and return a structured profile. The article's opening text is included so the model can disambiguate common names and connect the author's record to the topic. Only provided sources can be cited.
5. Wikipedia is checked for a photo and description when the author has an article.
6. Photos are collected from every angle at once: the byline photo and author-page link on the article itself, Bluesky and Mastodon public APIs (avatars and recent image posts with dates), X's public syndication timeline, Wikimedia Commons and Wikidata, image search on DuckDuckGo and Bing for the author's name and publication, and a scrape of every page found during research. Page images are scored on filename, alt text and surrounding markup so headshots rank above logos, icons and stock art. Results are deduplicated across sizes and shown newest and most likely first.
7. Profiles are cached locally (14 days by default), so reopening an article is free.

The panel is an extension page rendered in an iframe, so site styles and content security policies cannot interfere with it.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the repository folder.
3. The options page opens on first install. Paste an OpenRouter key from [openrouter.ai/keys](https://openrouter.ai/keys), pick a writing model (any OpenRouter model id; the page loads the live list and the "Newest from…" menu fills in the latest model from any provider), click **Test**, then **Save**.

To update later, run `scripts\pull.ps1` (or `scripts\pull.bat`) from the checkout, then click the reload icon on the extension's card in `chrome://extensions`. The script prints the commit hash to compare against the options page.

No build step is needed. The extension is plain HTML, CSS, and JavaScript. The options page header shows the loaded build: version, commit hash, branch, and commit date, read from the checkout's `.git` folder. After a `git pull`, click the reload icon on the extension's card in `chrome://extensions` and check that the hash matches `git rev-parse --short HEAD`.

## Use

- On an article with a byline, a small badge appears at the bottom of the page. Click it to open the panel. Close the badge with × to hide it for that page.
- Click the toolbar icon to see the detected author, correct the name if detection got it wrong, and open the panel.
- In the panel, ↻ researches again and ignores the cache.
- Options let you pick the model and effort level, cap web searches per profile, change the cache lifetime, turn the badge off, or have profiles build automatically on every article (this spends API credit on each page).

## Cost and privacy

- Your OpenRouter key lives in Chrome's extension storage and is sent only to `openrouter.ai`. The photo collector fetches public profile pages and APIs directly, without any key.
- Each new profile is a handful of small search requests plus one writing request. OpenRouter's web plugin charges about $0.004 per search result, so the default six searches of five results cost around $0.12, plus the writing model's tokens. Cached profiles cost nothing to reopen.
- The extension sends the author's name, the publication, the article title and URL, the article's first paragraphs, the search results, and the author's recent public posts to OpenRouter. Nothing else leaves the browser.

## Layout

```
manifest.json
src/background/service-worker.js   message routing, per-tab state, caching, keepalive
src/background/openrouter.js       OpenRouter client: gather searches, then structured synthesis
src/background/prompt.js           system prompt and profile JSON schema
src/background/wikipedia.js        photo and description lookup
src/background/images.js           recent posts and photos from Bluesky, Mastodon, X, Commons, author pages
src/content/content.js             byline detection, badge, panel iframe
src/panel/                         the profile panel (extension page)
src/popup/                         toolbar popup
src/options/                       settings page
src/shared/                        constants and storage helpers
scripts/make-icons.mjs             regenerates icons/ (node scripts/make-icons.mjs)
scripts/pull.ps1, pull.bat         pull the latest commit into a local checkout
```

## Known limits

- Instagram, Threads, LinkedIn and Facebook are closed without login, so those appear only as links. The X syndication and image search endpoints are unofficial and may rate limit or change; every source that fails is listed under "Photo sources tried", and the panel links out to Google, DuckDuckGo and Bing image search so there is always a manual route.
- Photo matching is heuristic. A photo of someone else can slip in, especially for common names, which is why each image links to the page it came from.
- Models that lack structured-output support on OpenRouter get a prompt-only JSON request instead; most current models handle it, smaller ones may not.
- Byline detection is heuristic. Sites that render bylines late or use unusual markup may need the name typed in the popup.
- A model researching the open web can still confuse people who share a name. The panel flags identity confidence and lists caveats; follow the sources for anything that matters.
