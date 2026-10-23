# File Updates & Reloading Open Files

Most changes to a workspace happen outside px0: `git checkout`, `git pull`, code generators, formatters, another editor. This document describes how px0 notices them and brings the open editors, the explorer and the git views up to date, without losing unsaved work. The code is in [`web/src/models.js`](../../web/src/models.js), [`web/src/main.js`](../../web/src/main.js), [`web/src/explorer.js`](../../web/src/explorer.js), [`web/src/git.js`](../../web/src/git.js) and, on the server, [`server.go`](../../server.go) and [`git.go`](../../git.go).

---

## 1. Sources of change

| Source | How the browser hears about it |
| :--- | :--- |
| px0's own writes (`/api/file/save`, `/api/fs/*`, `/api/git/*`) | The calling module emits `doc:saved` / `fs:changed` / `fs:renamed` / `git:after-op` locally; the server also triggers the git watcher and, when the tree changed shape, a `tree` event. |
| Git operations in a terminal | The git watcher stats `.git/index`, `.git/HEAD` and `.git/packed-refs` every second and broadcasts `git-status` on `/api/stream` ([Git Integration §5](git-integration.md#5-real-time-streaming--adaptive-monitoring-engine)). |
| Other tools editing tracked files | The watcher's adaptive worktree poll (2–15 s) broadcasts `git-status`. |
| Untracked files appearing or disappearing | The watcher updates the index (`TouchPath`) and broadcasts `tree`. |
| Any change to an **open** file's content | The browser polls `/api/file/stat` for open documents (§2). |

`main.js` turns the stream's events into bus events: `git-status` → `stream:git`, `tree` → `stream:tree`, `metrics` → `stream:metrics`. While the page is hidden the `EventSource` is closed (the server then stops polling for it); when it becomes visible again px0 reconnects, emits `stream:git` and checks open files at once. A dropped stream reconnects after 3 seconds.

## 2. Open documents (`checkDisk`)

Every open file is one Monaco model in a document record (`models.js`) that remembers the file's `mtime` when it was read or last saved. `checkDisk()` runs every 5 seconds while the page is visible, on window focus, and when the page becomes visible:

1. It sends the paths of every loaded workspace document to `POST /api/file/stat` (at most 500; files outside the workspace are skipped).
2. A file that no longer exists is marked `deleted`; its tab label is struck through. If it reappears, the mark goes.
3. A file whose `mtime` differs:
   - **No unsaved edits**: `revert(d)` re-reads it with `/api/file/text` and replaces the model's text with one `pushEditOperations` over the full range, so undo history survives and Monaco keeps the cursor as well as it can. The document takes the new `mtime`. Every editor showing the model (tabs, splits, the editable side of a diff) updates with it.
   - **Unsaved edits**: nothing is replaced. The document is flagged `conflict` and a notification offers **Revert to Disk** or **Keep Mine**. It is shown once per conflict.
4. A guard (`checking`) keeps two checks from overlapping.

Saving is the other half: `save()` sends the remembered `mtime`, and the server refuses with `409` if the file changed since. The user then picks **Overwrite** (saves again without the `mtime`) or **Revert to Disk**. See [File Editing](file-editing.md).

Models are reference-counted (`retain`/`release`): a model is disposed when the last tab showing it closes, unless it has unsaved edits, so the next open reads the file fresh.

## 3. Renames and deletes made in px0

- **Rename / move** (`explorer.js`): after `/api/fs/rename`, the explorer emits `fs:renamed {from, to}`. `followRename` in `editors.js` reopens every file tab under `from` at its new path in the same position, carries unsaved text across, and closes the old tab.
- **Delete**: tabs of the deleted file (or of files under a deleted folder) close if they have no unsaved edits.

## 4. The explorer

`stream:tree` and `fs:changed` re-list every loaded folder (debounced 150 ms) while keeping what is expanded (`refreshTree`). Git colouring is redrawn on `git:changed` without reloading anything. The tree is virtualized and rows whose content did not change keep their DOM element, so a redraw between mouse down and up cannot swallow a click.

## 5. Git state, gutters and diffs

- `stream:git`, `doc:saved` and `fs:changed` refetch `/api/git/status` (debounced 120 ms). `git:changed` then redraws the Source Control view, explorer badges, tab colours and the status bar.
- The gutter quick diff (`dirtydiff.js`) compares the model with the file's `INDEX` version from `/api/git/show`. After a px0 git operation (`git:after-op`) it re-reads the index version; otherwise it recomputes on every edit and on `git:changed`.
- The commit list in Source Control reloads after commit, push, pull and abort, and on `stream:git` while it is expanded.
- The read-only sides of open diff tabs (`HEAD`, `INDEX`, `BASE`) are fetched when the tab opens and are not refreshed afterwards; the editable working-tree side is the live document, so it always shows the current file.

## 6. Other views

- A **Markdown preview** re-renders when its file is saved in px0 (`doc:saved`), and on `theme:changed` for Mermaid's colours.
- **Search** re-runs the current query after a save.
- **Diagnostics** are re-read 600 ms after a save and every 4 seconds for open documents whose language server is ready.
- The **table** and **image** viewers read their file when the tab is rendered; reopen them to see a change made outside px0.

## 7. Server side

On a px0 write, the server keeps its own state in step before answering: `TouchPath`/`TouchTree` patch the in-memory index, the highlight cache entry is evicted, the language server's document is closed and open documents refreshed, and the git watcher is triggered (see [File Editing](file-editing.md#1-endpoints)). `/api/reindex` still rebuilds the whole index on demand, but the current frontend does not call it.

## Related

- [File Editing](file-editing.md): the endpoints and the document model.
- [Git Integration](git-integration.md): the watcher, the event stream and `/api/git/status`.
- [System Architecture §6](architecture.md#6-frontend): the frontend's structure and event bus.
