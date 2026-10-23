# File Editing & File Operations

Every file opens in Monaco, ready to edit; there is no separate edit mode. px0 writes to disk when you save, perform a file operation in the explorer, run a git action, or enable Auto Save.

---

## Editing and saving

- Type in any open file. A dirty tab shows a dot instead of its close button, the window title gets a `●`, and the Explorer's **Open Editors** section counts unsaved files.
- **Save** with `Ctrl/Cmd+S` (also **File > Save**), **Save All** with `Ctrl/Cmd+Alt+S`. **File: Revert File** throws away unsaved edits and reloads the file from disk.
- Closing a dirty tab asks **Save** / **Don't Save**; leaving the page with unsaved edits asks the browser to confirm.
- **File > Auto Save** enables or disables automatic saving. It is off by default; enabling it from the menu saves each dirty file after one second without edits. The choice persists across restarts and stays in sync with Settings.
- In **Settings**, search for **Auto Save** to choose `off`, `afterDelay`, or `onFocusChange`, and adjust **Auto Save Delay** (milliseconds, default `1000`). Focus mode saves when you switch editors, leave an editor for another control, or leave the browser window. Disabling Auto Save cancels pending timers; a save already sent to the server can finish.
- On every save, `files.trimTrailingWhitespace` and `files.insertFinalNewline` apply when enabled. Automatic saves preserve dirty files with disk conflicts; use **Save** to resolve them manually.
- Line endings are kept: a CRLF file stays CRLF (the status bar shows and changes it).
- Read-only: files outside the workspace (library sources a language server pointed at), and the original side of a diff. Binary files and files over 20 MB open as a placeholder with **Open Raw**.
- Editor behaviour (tab size, word wrap, font, rulers, ...) is set in Settings; see [Settings](settings-and-configuration.md).

## Changes on disk

px0 remembers each open file's modification time and checks open files every 5 seconds, and when the window regains focus or becomes visible (`/api/file/stat`):

- A file you have **not** edited follows the disk quietly: the new content replaces the old, keeping undo history.
- A file you **have** edited is not touched; a notification offers **Revert to Disk** or **Keep Mine**.
- A deleted file is marked in its tab (struck through).
- **Saving over a newer file** is refused first: px0 asks whether to **Overwrite** it with your version or **Revert to Disk**.

## Creating, renaming, moving and deleting

- **New File** / **New Folder**: the buttons in the Explorer's title, the context menu of a folder (or the empty space below the tree), or the commands **File: New File...** (`Ctrl/Cmd+Alt+N`) and **File: New Folder...**. The name is typed inline in the tree, in the selected folder; a path such as `pkg/util/x.go` creates the missing folders. Outside the Explorer, New File asks for a path relative to the workspace. A new file opens in the editor.
- **Rename**: `F2` in the tree or **Rename...** in its context menu, inline. Open tabs of the file, or of files inside a renamed folder, follow it, unsaved edits included.
- **Move**: drag a file or folder onto a folder (or onto empty space for the workspace root); px0 asks before moving.
- **Delete**: `Delete` in the tree or **Delete** in its context menu, after a confirmation. Deleting a folder deletes everything in it. Saved tabs of deleted files close.
- Creating or moving onto something that already exists is refused. The workspace root and anything in `.git` can never be renamed or deleted.

## Git and the rest of the UI

A save or file operation refreshes git status, badges and the gutter right away, and the server updates its index, language server documents and caches for the file (or every file under a renamed or deleted folder), so search, symbols and diagnostics see the new content. When the tree changes shape, every open browser tab reloads its explorer.

## Endpoints

All writes require a same-origin POST over `localhost` or a direct IP address, like the git endpoints.

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/file/text?path=P` | The file's exact bytes as text (line endings untouched), with `mtime` (unix ms), `size` and `eol`. Binary files and files over 20 MB come back flagged `binary` / `tooLarge` with no text. |
| `POST /api/file/save` | `{path, content, mtime?}`. With `mtime`, a file that changed on disk since is refused with `409` (`conflict: true`). Success returns the new `mtime`. |
| `POST /api/file/stat` | `{paths: [...]}` → existence, `mtime` and `size` for up to 500 paths. |
| `POST /api/fs/new` | `{path, type: "file" \| "dir"}`: create a file or folder. |
| `POST /api/fs/rename` | `{from, to}`: move a file or folder; `409` if `to` exists. |
| `POST /api/fs/delete` | `{path}`: delete a file, or a folder recursively. |

See [File Editing Internals](../internals/file-editing.md) and [File Reload & Updates](../internals/file-reload-and-updates.md).
