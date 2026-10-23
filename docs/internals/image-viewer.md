# Image Viewer & Non-Text Files

Images and other files that are not text open in `view` tabs drawn by viewers in [`web/src/previews.js`](../../web/src/previews.js). User-facing behaviour is in [Image Viewer](../features/image-viewer.md).

## 1. Choosing a viewer

`openFile(path)` in [`web/src/editors.js`](../../web/src/editors.js) asks `viewerFor(path)` first. An image extension (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `ico`, `bmp`, `avif`) opens `openView('image', path)` without reading the file as text. Everything else goes through `openDoc` (`/api/file/text`); a document flagged `binary` (a NUL in the first 8000 bytes, or not valid UTF-8) or `tooLarge` (over 20 MB) is released and replaced by `openView('binary', path, { info })`. `openFile(path, { asText: true })` skips the viewer, which is how **Open as Text** opens an SVG's source.

Viewer tabs follow the same rules as other tabs: preview (italic) on a single click, kept on a double click, saved with the session (except `binary`).

## 2. Image viewer (`renderImage`)

- The image is an `<img>` whose `src` is `api/raw?path=<path>&v=<timestamp>`; the timestamp makes a re-render fetch the current file rather than a cached copy. `/api/raw` serves the bytes with the image's MIME type.
- On `load` the toolbar shows `naturalWidth × naturalHeight`. On `error` the canvas is replaced with a message.
- **Zoom** is a single number: `0` means fit (the canvas gets the `fit` class and CSS keeps the image inside the tab), otherwise the image's CSS width is `naturalWidth × zoom` and the canvas scrolls. `step(±1)` moves between fixed levels (10%, 25%, 50%, 75%, 100%, 150%, 200%, 300%, 400%, 600%, 800%), starting from the fitted scale when in fit mode. Buttons, a click (in) or `Alt`-click (out), and `Ctrl/Cmd`+wheel call it; **Fit** and **Actual Size** set `0` and `1`.
- SVG files get **Open as Text**. An SVG renders through `<img>`, so scripts inside it do not run.

## 3. Binary placeholder (`renderBinary`)

Says why the file is not shown (binary or unsupported encoding, or very large) and links **Open Raw** to `api/raw?path=` in a new browser tab.

## 4. Images in Markdown

The [Markdown preview](markdown.md) rewrites relative image references to `api/raw?path=<resolved>` (`mdSetImage`), keeps `http(s):` and `data:image/` sources, drops every other scheme, and adds `loading="lazy"` and `decoding="async"`. See [Markdown Preview §4](markdown.md#4-sanitization).

## 5. Server side

`handleRaw` resolves the path with `safePath` (inside the workspace only) and serves the file with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`. Image extensions get their `image/*` type; everything else is `application/octet-stream`, so a browser never renders arbitrary workspace HTML on px0's origin. An `<img>` ignores the attachment disposition; **Open Raw** downloads the file.
