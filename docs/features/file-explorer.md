# File Explorer

The Explorer view (`Ctrl/Cmd+Shift+E`) has three collapsible sections, as in VS Code:

- **Open Editors**: every open tab, across all editor groups, with a close button (a dot while unsaved) and its folder. Its header counts unsaved files.
- **The workspace folder**: the file tree, titled with the workspace name.
- **Outline**: the symbols of the active file (see [Symbol Outline](symbol-outline.md)).

---

## The tree

- **Fast on any size.** The tree is virtualized (only the rows in view exist in the page) and folders load on demand from the server's in-memory index, so folders with thousands of entries stay quick. Folders sort before files, names sort naturally (`file2` before `file10`).
- **Git status.** Changed files are coloured and carry VS Code's letter badges (`M`, `A`, `D`, `U`, `R`, `!` for conflicts); a folder containing changes gets a dot, so changes are visible with the folder collapsed.
- **Ignored files** (by `.gitignore`) are shown dimmed; they are left out of Quick Open and search.
- **Nested repositories** (a clone or submodule inside the workspace) carry a `git` tag. Under the [workbench](workbench.md) their context menu has **Open Repository** and **Open Repository in New Tab**.
- **Auto reveal.** The active file is revealed and selected in the tree when you switch to it (`explorer.autoReveal`, on by default).
- **Remembered.** Expanded folders are kept per workspace in the browser, and restored on reload.
- **Live.** The tree reloads when the server reports that it changed shape (px0's own file operations, discards, and, in a git repository, untracked files appearing or disappearing) and after px0's own file operations.

## Mouse and keyboard

| Action | Effect |
| :--- | :--- |
| Click a file | Open it in a preview tab |
| Double-click, or `Ctrl/Cmd`-click a file | Open it in a kept tab |
| `Alt`-click a file | Open it to the side |
| Click a folder | Expand / collapse |
| Drag onto a folder (or empty space) | Move the file or folder there, after a confirmation |
| `↑` / `↓`, `Home` / `End`, `PageUp` / `PageDown` | Move the selection |
| `→` / `←` | Expand a folder or step into it / collapse it or go to the parent |
| `Enter` | Open the file or toggle the folder |
| `Space` | Open the file in a preview tab, keeping focus in the tree |
| `F2` | Rename inline |
| `Delete` | Delete, after a confirmation |

## Context menu

Right-click a row for: **New File...**, **New Folder...**, **Open to the Side**, **Open Preview** (Markdown), **Open Changes** (changed files), **Select for Compare** / **Compare with '...'**, **Copy Path**, **Copy Relative Path**, **Find in Folder...** (folders: opens Search limited to that folder), **Rename...** and **Delete**. Right-click empty space for New File, New Folder, **Refresh Explorer** and **Collapse Folders in Explorer**.

The tree's title bar has **New File...**, **New Folder...**, **Refresh Explorer** and **Collapse Folders in Explorer**. File operations are described in [File Editing](file-editing.md).

## Related

- `Ctrl/Cmd+B` hides and shows the whole side bar.
- **File: Reveal Active File in Explorer View** (also on the tab's context menu and the breadcrumbs).
- Tabs, preview tabs and split editors are described in [The Editor Workbench](editor.md#tabs-preview-tabs-and-split-editors).

## Configuration

- `explorer.autoReveal` (default `true`): reveal the active file in the tree.

For how the server walks and indexes the workspace and applies `.gitignore`, see [Filesystem Indexing & Ignore Engine](../internals/indexing-and-ignore.md).
