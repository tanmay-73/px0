# Image Viewer

Image files open in an image tab instead of the text editor: `.png`, `.jpg` / `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.bmp` and `.avif`. Like any tab, a single click in the explorer opens it as a preview tab.

---

## Controls

The toolbar shows the image's natural size (`width × height`) and the current zoom.

| Control | Action |
| :--- | :--- |
| **Zoom In** / **Zoom Out** buttons | Step through 10%, 25%, 50%, 75%, 100%, 150%, 200%, 300%, 400%, 600%, 800% |
| Click the image / `Alt`-click | Zoom in / zoom out one step |
| `Ctrl/Cmd` + mouse wheel | Zoom in or out |
| **Fit** | Fit the image to the tab (the default) |
| **Actual Size** | 100% |
| **Open as Text** (SVG only) | Open the SVG source in the editor |

A zoomed image scrolls inside the tab. An image that cannot be decoded shows a message instead.

## Other non-text files

A binary file (or one that is not valid UTF-8 text) or a file over 20 MB opens a placeholder that says why, with **Open Raw** to download it.

## Images in Markdown

The [Markdown preview](markdown-preview.md) loads relative images from the workspace and web images as usual, lazily. Files are served by `/api/raw`.

See [Image Viewer Internals](../internals/image-viewer.md).
