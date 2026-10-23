# Workspace Search & Replace

The Search view (`Ctrl/Cmd+Shift+F`, or **Edit > Find in Files**) searches every file in the workspace. The server greps the indexed files in parallel on all cores, so a search across a large repository answers in tens of milliseconds.

---

## Searching

- Opening the view with text selected in the editor (on one line) searches for it.
- Results update as you type (after a short pause) and when you press `Enter`.
- Toggles in the search box: **Match Case**, **Match Whole Word** and **Use Regular Expression** (Go regular expression syntax). They are remembered.
- **Toggle Search Details** (`...`) shows **files to include**: comma-separated globs such as `*.go, src/**`. **Find in Folder...** in the explorer's context menu fills it in for that folder.
- Results are grouped by file, with the match count and the matching line, the match highlighted. Click a file row to collapse it; **Collapse All** and **Clear Search Results** are in the summary row; **Dismiss** (`×`) removes one file from the results.
- Click a match to open the file in a preview tab with the match selected; double-click to keep the tab.
- Files ignored by `.gitignore` are not searched. Results are capped; the summary adds "(more not shown)" when they were.
- Saving a file re-runs the current search.

## Replacing

1. Click the chevron left of the search box to show the **Replace** box.
2. Type the replacement. With **Use Regular Expression** on, `$1`, `$&` and the like refer to the match, as in VS Code.
3. **Replace All** (or `Ctrl/Cmd+Enter` in the Replace box) asks for confirmation, then replaces in every file in the results. **Replace All in File** on a file row does just that file.

Replacing edits each file's document, the same one an open editor shows, so it can be undone there. Files that had no unsaved changes are saved straight away; files with unsaved edits get the replacement as another unsaved edit.

## In-file find

Find and replace within one file is Monaco's: `Ctrl/Cmd+F`, and `Ctrl+H` (`Cmd+Alt+F` on macOS), with the same case, whole-word and regex toggles, find in selection, and match highlighting in the scrollbar.

---

## Keys

| Key | Context | Action |
| :--- | :--- | :--- |
| `Ctrl/Cmd+Shift+F` | Anywhere | Show Search (with the selection as the query) |
| `Enter` | Search box | Search now |
| `Ctrl/Cmd+Enter` | Replace box | Replace All |
| `Ctrl/Cmd+F`, `Ctrl+H` / `Cmd+Alt+F` | Editor | Find / replace in the file |

## Endpoint

`GET /api/search?q=&re=1&case=1&word=1&glob=` returns matches grouped by file, each with its line number and the line split into the text before, in and after the match. For the worker pool, buffer reuse and snippet elision behind it, see [Workspace Search Internals](../internals/workspace-search.md).
