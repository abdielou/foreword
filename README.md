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
2. The background service worker asks Claude, with the web search tool, to research the author and return a structured profile. The article's opening text is included so the model can disambiguate common names and connect the author's record to the topic.
3. Wikipedia is checked for a photo and description when the author has an article.
4. Profiles are cached locally (14 days by default), so reopening an article is free.

The panel is an extension page rendered in an iframe, so site styles and content security policies cannot interfere with it.

## Install

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the repository folder.
3. The options page opens on first install. Paste an Anthropic API key from [platform.claude.com](https://platform.claude.com/) and click **Test**, then **Save**.

No build step is needed. The extension is plain HTML, CSS, and JavaScript.

## Use

- On an article with a byline, a small badge appears at the bottom of the page. Click it to open the panel. Close the badge with × to hide it for that page.
- Click the toolbar icon to see the detected author, correct the name if detection got it wrong, and open the panel.
- In the panel, ↻ researches again and ignores the cache.
- Options let you pick the model and effort level, cap web searches per profile, change the cache lifetime, turn the badge off, or have profiles build automatically on every article (this spends API credit on each page).

## Cost and privacy

- Your API key lives in Chrome's extension storage and is sent only to `api.anthropic.com` (or the base URL you set in options).
- Each new profile is one Claude request with several web searches. Expect a few cents to a few tens of cents per author depending on model, effort and search count. Cached profiles cost nothing to reopen.
- The extension sends the author's name, the publication, the article title and URL, and the article's first paragraphs to the API. Nothing else leaves the browser.

## Layout

```
manifest.json
src/background/service-worker.js   message routing, per-tab state, caching, keepalive
src/background/claude.js           streaming Messages API client (web search, structured output)
src/background/prompt.js           system prompt and profile JSON schema
src/background/wikipedia.js        photo and description lookup
src/content/content.js             byline detection, badge, panel iframe
src/panel/                         the profile panel (extension page)
src/popup/                         toolbar popup
src/options/                       settings page
src/shared/                        constants and storage helpers
scripts/make-icons.mjs             regenerates icons/ (node scripts/make-icons.mjs)
```

## Known limits

- "Most recent photos" depends on what public pages the model finds during research and on Wikipedia. There is no image search API behind it. The profile links (author page, X, LinkedIn, Wikipedia) are the reliable place for the newest pictures.
- Byline detection is heuristic. Sites that render bylines late or use unusual markup may need the name typed in the popup.
- A model researching the open web can still confuse people who share a name. The panel flags identity confidence and lists caveats; follow the sources for anything that matters.
