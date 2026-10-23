# Markdown Preview Implementation

This document describes how px0 renders Markdown: the server-side conversion, the browser-side sanitizer, and the preview tab. The code lives in [`internal/render/render.go`](../../internal/render/render.go) on the server and [`web/src/previews.js`](../../web/src/previews.js) and [`web/src/mermaid.js`](../../web/src/mermaid.js) in the browser. Styles are in [`web/src/css/markdown.css`](../../web/src/css/markdown.css).

## 1. Request Flow

```text
markdown.showPreview / showPreviewToSide
  |
  v
openView('markdown', path)           -- editors.js: a "view" tab, title "Preview <name>"
  |
  |  GET /api/markdown?path=        -> { path, html }   (goldmark, raw HTML kept)
  v
mdSanitize(html, path)               -- inert DOMParser document, allowlist
  |
  v
mdEnhance()                          -- alerts, code block wrappers, copy buttons
  |
  v
renderMermaidBlocks()                -- lazy, same-origin Mermaid for ```mermaid fences
```

## 2. Opening a Preview

The preview is a separate editor tab, as in VS Code, not an overlay on the source. `openMarkdownPreview(path, opts)` opens a `view` tab of kind `markdown` (`key` `view:markdown:<path>`) through `openView` in [`web/src/editors.js`](../../web/src/editors.js); `sideBySide` puts it in the next editor group, creating one if needed. The commands are `markdown.showPreview` (`Ctrl/Cmd+Shift+V`) and `markdown.showPreviewToSide` (`Ctrl/Cmd+K V`, also an editor title action on Markdown files); the explorer and tab context menus have **Open Preview**. Preview tabs are saved with the session like any `view` tab with a path.

`renderMarkdown(t, root)` fetches `/api/markdown`, sanitizes, enhances and renders Mermaid. A per-tab sequence number (`t.renderSeq`) drops a response that arrives after a newer render started. `initPreviews` re-renders a file's preview on `doc:saved` for that path, and every preview on `theme:changed` so Mermaid picks up the new colours. A fetch error (for example a file over 4 MB) is shown inside the tab.

## 3. Server Rendering
### Converter Configuration

`mdConverter` is a single goldmark instance built at package init:

```go
var mdConverter = goldmark.New(
	goldmark.WithExtensions(extension.GFM, extension.Footnote),
	goldmark.WithParserOptions(
		parser.WithAutoHeadingID(),
		parser.WithASTTransformers(util.Prioritized(lineMarker{}, 100)),
	),
	goldmark.WithRendererOptions(
		html.WithUnsafe(),
		renderer.WithNodeRenderers(util.Prioritized(fenceRenderer{}, 100)),
	),
)
```

- `extension.GFM` adds tables, task lists, strikethrough and autolinks. `extension.Footnote` adds footnotes.
- `html.WithUnsafe()` passes raw HTML through. READMEs depend on it for centred logos and `<details>`. Section 4 explains why this is safe.
- goldmark sorts node renderers by ascending priority and registers them in reverse, so the lowest number wins. `fenceRenderer` at 100 replaces the default HTML renderer's code block functions, which sit at 1000.

`renderMarkdown` normalizes CRLF to LF, then converts with a fresh `headingIDs` table in the parser context. The table must be per-request because it tracks which ids are already taken.

### Source Line Anchors

`lineMarker` is an AST transformer. It builds a sorted slice of newline byte offsets once, then walks the document and sets `data-line` on these node kinds: `Heading`, `Paragraph`, `List`, `ListItem`, `Blockquote`, `FencedCodeBlock`, `CodeBlock` and `Table`.

Container nodes such as lists and blockquotes own no source lines. `blockStart` descends through first children until it finds a block with lines and returns that segment's start offset. The line number is the count of newlines before that offset, plus one:

$$
\text{line} = \left|\{\, i : \text{nl}_i < \text{off} \,\}\right| + 1
$$

`sort.SearchInts(newlines, off)` returns that count in $O(\log n)$.

goldmark's HTML renderer writes node attributes for headings, paragraphs, lists, list items, blockquotes and tables, and `RenderAttributes` lets any `data-` attribute through its filters. `fenceRenderer` writes `data-line` on `<pre>` itself. A fenced block's line is its first content line, one below the opening fence.

The sanitizer keeps `data-line`, but the current preview tab does not use it: there is no scroll sync between the source editor and the preview.

### Heading IDs

goldmark's default id generator drops every non-ASCII character and turns `_` into `-`, which breaks tables of contents written for GitHub. `headingIDs` implements `parser.IDs` with GitHub's rules: lowercase, keep Unicode letters and digits, keep `-` and `_`, turn spaces into `-`, drop everything else, and suffix repeats with `-1`, `-2`.

| Heading text        | Id                   |
| ------------------- | -------------------- |
| `Getting Started!`  | `getting-started`    |
| `snake_case API`    | `snake_case-api`     |
| `Überblick`         | `überblick`          |
| `Getting Started`   | `getting-started-1`  |
| `???`               | `section`            |

### Fenced Code Highlighting

`renderFence` emits:

```html
<pre class="md-code" data-line="8" data-lang="go"><code><i class=k>func</i> <i class=nf>main</i>...</code></pre>
```

`highlightFence` looks up the fence's language with `lexers.Get` and calls `highlightLines` in [`internal/render/render.go`](../../internal/render/render.go), the same function `/api/file` uses (`Doc.tokenise` is a thin wrapper around it). Both share lexers, the `classFor` token mapping, and the panic recovery that falls back to plain text. The preview colours the token classes from the theme's syntax tokens (`.md-code .k { color: var(--k) }` and so on in `web/src/css/markdown.css`), the same tokens `theme.js` maps onto Monaco.

Two cases stay plain and HTML-escaped:

- Fences with no language. Guessing a language from content with `lexers.Analyse` is slow and often wrong.
- Fences over `maxFenceBytes` (256 KB).

### Endpoint

`GET /api/markdown?path=<path>` resolves the path with `resolvePath`, the same rule `/api/file/text` uses: inside the workspace, or an absolute path a language server has named. It reads the whole file and returns `{ "path": ..., "html": ... }`. It holds no cache. Every error comes back as JSON through `fail`:

| Status | Cause                                        |
| ------ | -------------------------------------------- |
| 400    | Path escapes the workspace                   |
| 415    | Not `.md` or `.markdown`, or a directory     |
| 404    | File missing or unreadable                   |
| 413    | Larger than `maxMarkdownBytes` (4 MB)        |
| 500    | goldmark returned an error                   |

## 4. Sanitization
### Why the Browser Treats the HTML as Untrusted

The preview renders on px0's own origin. That origin also serves `/api/lsp/install` and `/api/lsp/start`, which accept a POST whose `Origin` matches the host. Script injected into the preview would pass that check. A Markdown file in any repository the reader opens is attacker-controlled input, so every byte from `/api/markdown` goes through `mdSanitize` before it touches the page.

### Pipeline

`mdSanitize(html, docPath)` in [`web/src/previews.js`](../../web/src/previews.js) works in five steps:

1. Parse the HTML with `new DOMParser().parseFromString(html, 'text/html')`. A DOMParser document has no browsing context: it runs no script and loads no images.
1. Walk a static snapshot of `body.querySelectorAll('*')`, skipping elements already detached with a removed ancestor.
1. Remove, with all content, any element outside the HTML namespace or in `MD_DROP`: `script style iframe frame frameset object embed applet template noscript noembed svg math form textarea select option button link meta base title audio video source track canvas dialog`.
1. Unwrap any element not in `MD_KEEP`, keeping its children in place. An `<input>` survives only as `type="checkbox"` and is forced `disabled`.
1. Strip every attribute from kept elements, then restore only those that follow these rules:
  - Attributes in `MD_ATTRS`: `align valign alt title lang dir width height colspan rowspan start reversed open checked disabled type data-line data-lang`.
  - `id`, and `name` on `<a>`, rewritten as `id="md-<value>"`. A heading called "Status" becomes `md-status` and cannot shadow an element of the workbench.
  - Class tokens only when they are `md-code`, start with `footnote`, or are highlighter tokens on `<i>`. Content cannot borrow px0's layout classes.
  - `src` and `href` through the URL rules below.

The cleaned children move into a `DocumentFragment` with `document.adoptNode`. The cleaned tree is never serialized and re-parsed, which rules out mutation XSS from parser round trips. `style` attributes never survive, so content cannot position an overlay over the UI.

### URL Rules

`mdURL` first removes tabs and newlines anywhere and control characters at either end, because the URL parser ignores them. Without this, `java&#9;script:` would slip past a scheme check.

| Reference                                   | `<a href>`                                                      | `<img src>`                        |
| ------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `#section`                                  | Kept, `data-anchor="section"`                                   | n/a                                |
| `http:`, `https:`, `//host`                 | Kept, `target="_blank" rel="noopener noreferrer"`               | Kept                               |
| `mailto:`                                   | Kept, new tab                                                   | Dropped                            |
| `data:image/...`                            | Dropped                                                         | Kept                               |
| Any other scheme (`javascript:`, `file:`)   | Dropped                                                         | Dropped                            |
| No scheme (`docs/a.md#x`, `../img.png`)     | `api/raw?path=<resolved>` plus `data-path` and `data-anchor`   | `api/raw?path=<resolved>`          |

`mdLocal` resolves a scheme-less reference with `new URL(ref, base)`, where `base` is the stand-in origin `http://px0.invalid/` plus the Markdown file's directory, each segment percent-encoded. A leading `/` resolves to the workspace root, as on GitHub. If the result lands on any other origin, the reference was not relative after all and gets no URL.

### Hostile Input Examples

These cases come from browser checks run against the sanitizer (it was carried over unchanged from px0's previous preview):

| Input                                              | Result                                        |
| -------------------------------------------------- | --------------------------------------------- |
| `<script>window.__xss = 1</script>`                | Removed with its content                      |
| `<img src="x" onerror="...">`                      | `onerror` stripped, `src` becomes a raw path  |
| `<a href="javascript:...">`                        | Text kept, no `href`                          |
| `<a href="java&#x09;script:...">`                  | Text kept, no `href`                          |
| `<svg onload="...">`                               | Removed                                       |
| `<style>body { display: none }</style>`            | Removed                                       |
| `<div style="position:fixed;inset:0" class="row">` | Plain `<div>` with no style and no class      |
| `## Status`                                        | `<h2 id="md-status">`                         |

## 5. Presentation

`mdEnhance` runs after sanitization and adds markup that px0 itself creates:

- GitHub alerts. A blockquote whose first paragraph opens with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` loses the marker, gains a `.md-alert-title` paragraph, and gets `.md-alert .md-alert-<kind>`.
- Code block wrappers. Each `<pre>` moves into `.md-pre`, which carries `data-lang` for a corner label and a copy button. The button holds an SVG icon rather than a text label, so text search in the page does not match the word "Copy".
- Images. `mdSetImage` gives every kept `<img>` `loading="lazy"` and `decoding="async"`, and points relative images at `api/raw`.

Styles read only theme tokens, so every theme works without changes. [`styling-and-themes.md`](styling-and-themes.md) describes the tokens.

### Mermaid Diagrams

Mermaid is a presentation-stage enhancement, not a server renderer. `renderFence` emits the same escaped `<pre><code>` and `data-line` metadata as every other fence. After `mdSanitize` has rejected repository-supplied SVG, `renderMermaidBlocks` lazy-loads the pinned, same-origin `static/vendor/mermaid-12.0.0.min.js` and inserts Mermaid's generated SVG. The runtime is not embedded in the binary: the server fetches it from the pinned CDN release on first use and caches it under the user cache directory (`~/.px0/cache/vendor/` or `$XDG_CACHE_HOME/px0/vendor/`), so diagrams work offline afterwards and under `-base-path`.

The adapter initializes Mermaid with `startOnLoad: false`, `securityLevel: strict`, disabled error rendering, and Mermaid's secure configuration keys. Diagram directives therefore cannot enable HTML labels, click callbacks, or a weaker security level. The returned `bindFunctions` hook is intentionally ignored.

Rendering uses an LRU cache of rendered SVG and yields to the event loop between diagrams. Every asynchronous continuation checks that the render is still current and the article still attached before changing the DOM. A syntax error affects only its fence: the original source remains visible and neighbouring diagrams continue. The original `<pre>` stays in the DOM after a successful render, hidden, so the copy button still copies the Mermaid source. Each diagram has a toolbar for zoom (25% to 400%, with fit), drag-to-pan, and full screen; `Esc` leaves full screen.

## 6. Links

A click handler on the article routes plain left clicks; modified clicks fall through to the browser, which opens the `api/raw` href in a new tab.

- The copy button copies the code block's text.
- `data-path` on a Markdown file opens its preview (`openMarkdownPreview`); on any other file it opens the file in the editor (`openFile`).
- `data-anchor` without `data-path` scrolls to `md-<anchor>` in the same article.
- Web links already carry `target="_blank" rel="noopener noreferrer"` from the sanitizer.

## 7. Limits and Known Gaps

- Markdown files over 4 MB are not previewed.
- Fences over 256 KB and fences without a language are not highlighted.
- Math fences render as code blocks.
- The preview renders the file on disk: it follows saves, not unsaved edits, and has no scroll sync with the source editor.
- A link to another file's heading opens that file's preview at the top.
- The preview commands are offered for `.mdx` files, but `/api/markdown` accepts only `.md` and `.markdown` and answers 415.
- Relative images in a Markdown file outside the workspace (opened through a language server) do not load, because `/api/raw` resolves them as workspace paths.

## 8. Tests

- `TestMarkdownPreview` in [`px0_test.go`](../../px0_test.go) checks heading IDs and `data-line`, highlighted fenced code, preserved relative links, task list checkboxes, the `markdown` flag on `/api/file`, and the 415 and 400 responses.
- `TestHeadingIDsFollowGitHub` in [`internal/render/render_test.go`](../../internal/render/render_test.go) checks the ID rules and deduplication.

The sanitizer, Mermaid rendering and link routing run only in a browser and have no automated test in the repository.

## 9. Table Preview (CSV / TSV)

CSV and TSV files open in the text editor. `px0.openTablePreview` (**View: Open Table Preview**, an editor title action on `.csv` / `.tsv` files) opens a `view` tab of kind `table`, titled `Table <name>`, rendered by `renderTable` in [`web/src/previews.js`](../../web/src/previews.js).

### Endpoint

`GET /api/table?path=<path>` ([`internal/table/table.go`](../../internal/table/table.go)) resolves the path like `/api/markdown`, answers 415 for other extensions, and parses with `encoding/csv` (`LazyQuotes`, `FieldsPerRecord = -1`). `Comma` comes from `sniffDelim`: it peeks at the first 64 KB, takes the first non-blank line, and counts comma, tab, semicolon and pipe outside double quotes. The most frequent wins, and the extension's separator (`.csv` → comma, `.tsv` → tab) wins ties and files with none. Misnamed files are common: a tab-separated `.csv` read with commas comes out as one cell per line. The first record is the header, with a leading UTF-8 BOM removed. It returns:

```json
{ "header": ["repo", "files"], "headerLine": 1,
  "rows": [{ "line": 2, "cells": ["linux", "81902"] }],
  "cols": 2, "truncated": false }
```

`line` is `csv.Reader.FieldPos(0)`: the line the record's first cell starts on. Quoted cells that span lines and skipped blank lines therefore keep row numbers equal to source lines.

### Caps

On the server, `renderTable(r, size, fallback)` in `internal/table` reads through `io.LimitReader(r, 1 MiB)` and stops after 1,000 data rows, so cost is bounded by the cap, not the file (a 50 MB file answers in well under a second). When the limit reader stops short of the end of the file (`size` over the cap), the last record may be cut in half: it is dropped and `truncated` is set. A parse error under the byte cap is ignored for the same reason. An error in a file read to its end returns 422.

### Rendering

In the browser, `renderTable(t, root)` in `previews.js` fetches `/api/table` and builds the table with `h()`, which creates every cell as a text node. Nothing from the file is parsed as HTML, so the table needs no sanitizer. The first column (`.tv-ln`) is each row's source `line`; the header row comes from `header`; rows shorter than `cols` are padded with empty cells. The toolbar shows `rows × columns`, `(truncated)` when the server stopped at a cap, and **Open as Text**, which opens the file in the editor (`openFile(path, { asText: true })`). The table is fetched when the tab renders and is not refreshed when the file changes.

### Tests

[`internal/table/table_test.go`](../../internal/table/table_test.go) holds the parsing rules (quoted comma and newline, line skipping, ragged rows, TSV, BOM, blank lines, stray quotes, empty file, row cap, exactly-at-cap), separator detection and ties, and the byte cap: an endless reader proves no more than 1 MiB is read and that the record the cap cuts through is dropped. `TestTableEndpointServesRowsAndFileFlagsTables` in [`px0_test.go`](../../px0_test.go) covers the endpoint and the `table` flag on `/api/file`.
