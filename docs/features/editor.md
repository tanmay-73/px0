# The Editor Workbench

px0's browser UI is a VS Code-style workbench built on [Monaco](https://microsoft.github.io/monaco-editor/), the editor component of VS Code. If you know VS Code, you already know where most things are and what most keys do. This page is the tour; the other feature guides go deeper into each area.

---

## Layout

| Area | What it holds |
| :--- | :--- |
The layout is VS Code 1.142's modern UI: the activity bar, side bars, editor and panel float as rounded cards on the window background.

| Area | What it holds |
| :--- | :--- |
| **Title bar** | The px0 app icon (a link back to the [workbench](workbench.md) when the workspace was opened from it), **Go Back** / **Go Forward** and the command center in the middle (click it for Quick Open), and the layout controls: **Customize Layout** (show or hide the activity bar, side bars, panel and status bar), and toggles for the primary side bar, the panel and the secondary side bar. |
| **Activity bar** | The application menu (the ☰ button: **File**, **Edit**, **Selection**, **View**, **Go**, **Help**, as in VS Code for the Web), then one icon per side bar view: **Explorer**, **Search**, **Source Control** (with a badge counting changes), **Pull Request** (only in a PR review), **Repositories** (only under the workbench). At the bottom, **Accounts** (sign in to the forge with a token for pull requests) and **Manage**: Command Palette, Settings, settings.json, Keyboard Shortcuts, Themes. |
| **Side bar** | The active view. Drag its edge to resize; `Ctrl/Cmd+B` hides it. Clicking the active view's icon again also hides it. The **…** button in its title lists the view's sections and the other views. |
| **Editor area** | One or more editor groups side by side, each with its own tabs, breadcrumbs (the file's path, then the symbols around the cursor) and title actions. The active tab joins the editor below it. |
| **Panel** | **Problems** (diagnostics from language servers, with a filter box in the panel title), **Output** (logs of git operations and language server state, one channel at a time) and **Terminal** (shells on the server: see [Integrated Terminal](terminal.md)). `Ctrl/Cmd+J` toggles it; it can be resized and maximized. |
| **Secondary side bar** | The **Outline** of the active file, docked on the right. `Ctrl/Cmd+Alt+B` toggles it. |
| **Status bar** | Branch, sync, problem counts on the left (and, under the workbench, the repository switcher); cursor position, indentation, encoding, line endings, language, language server, px0's CPU/memory and the notifications bell on the right. |

Sizes, visibility and the last active view are remembered in the browser. Notifications appear as toasts in the bottom-right corner and stay in the **notification center** (the bell): clear them, or turn on **Do Not Disturb** to keep all but errors out of the way.

## Editing

The editor is Monaco, so the usual VS Code editing features are there: multiple cursors, column selection, find and replace (`Ctrl/Cmd+F`, `Ctrl+H` / `Cmd+Alt+F`), comment toggling, line moves and copies, bracket matching and colorization, folding, sticky scroll, minimap, and undo history per file. The **Edit** and **Selection** menus list the common ones with their keys.

- **One document per file.** Every view of a file (a tab, a split, the editable side of a diff) shares one model, so an edit shows everywhere and the file is dirty in one place.
- **Save** with `Ctrl/Cmd+S`, **Save All** with `Ctrl/Cmd+Alt+S`. A dirty tab shows a dot instead of its close button. Closing a dirty tab asks whether to save; leaving the page with unsaved changes asks the browser to confirm.
- **Auto save**, **trim trailing whitespace** and **insert final newline** are settings (`files.autoSave`, `files.trimTrailingWhitespace`, `files.insertFinalNewline`).
- **Changes on disk** are picked up: see [File Editing](file-editing.md).
- Files outside the workspace (a library a language server pointed at) open read-only. Binary files and files over 20 MB open as a placeholder with an **Open Raw** link.

## Tabs, preview tabs and split editors

- **Preview tabs.** A single click on a file in the explorer, a search result or a change opens it in a *preview* tab, shown in italics. The next preview replaces it. Editing the file, double-clicking it or its tab, or **Keep Editor** (`Ctrl/Cmd+K Enter`) keeps it open.
- **Switching tabs:** `Alt+1` … `Alt+9` (9 is the last tab), `Ctrl/Cmd+Alt+Left/Right` or `Ctrl+PageUp/PageDown`. The **Open Editors** section of the Explorer lists every tab.
- **Closing:** `Alt+W` closes the active tab, a middle click closes any tab. The tab's context menu has **Close**, **Close Others**, **Close to the Right**, **Close Saved** and **Close All**, plus Copy Path, Reveal in Explorer View, Keep Open, Split Right, Select for Compare / Compare with Selected, and Open Preview for Markdown. `Alt+Shift+T` reopens the last closed file.
- **Splitting:** `Ctrl/Cmd+\` (or the split button in the group's title bar) opens the active tab in a new group to the right. Drag a tab onto another tab to reorder it, or onto a tab in another group to move it there. `Alt`-click a file in the explorer opens it to the side.
- **Breadcrumbs** above the editor show the file's path; clicking a segment reveals it in the explorer.
- **Session restore.** The tabs open in each group (file tabs and preview tabs such as Markdown, table and image views, up to three groups) are restored the next time the workspace opens in the same browser. Diff tabs and unsaved edits are not restored.

## Quick Open and the Command Palette

`Ctrl/Cmd+P` opens Quick Open; the first character of the query picks the mode, as in VS Code:

| Prefix | Mode |
| :--- | :--- |
| *(none)* | Files, fuzzy-matched by the server across the whole index. With an empty query, recently opened files. `name.go:42` opens at line 42. |
| `>` | Commands (`Ctrl/Cmd+Shift+P` or `F1` opens straight into it). Recently used commands come first. |
| `@` | Symbols in the active file (`Ctrl/Cmd+Shift+O`). |
| `:` | Go to line, or `line:column` (`Ctrl/Cmd+G`). |

`↑`/`↓` (or `Ctrl+N`/`Ctrl+P`, `Tab`) move, `Enter` opens, `Ctrl/Cmd+Enter` opens a file to the side, `Esc` closes. See [Fuzzy File Search](fuzzy-file-search.md).

## Explorer

The Explorer has the workspace folder's file tree and **Outline** (symbols of the active file); **Open Editors** is hidden by default, as in VS Code, and can be shown from the **…** menu in the Explorer's title. The tree is virtualized, loads folders lazily, colours files by git status with VS Code's letter badges, and dims ignored files. New File, New Folder and Rename happen inline in the tree; drag a file or folder onto a folder to move it. See [File Explorer](file-explorer.md) and [Symbol Outline](symbol-outline.md).

## Search

`Ctrl/Cmd+Shift+F` opens the Search view (seeded with the selected text): search the whole workspace with **Match Case**, **Match Whole Word** and **Use Regular Expression**, limit it with a files-to-include glob, and replace across files. See [Workspace Search](workspace-search.md). In-file find and replace is Monaco's own (`Ctrl/Cmd+F`, `Ctrl+H` / `Cmd+Alt+F`).

## Source Control, diffs and compare

`Ctrl/Cmd+Shift+G` opens Source Control: a commit message box, **Merge Changes**, **Staged Changes** and **Changes** groups with stage, unstage and discard on every file, Commit / Commit (Amend) / Commit & Push / Commit & Sync, Pull, Push, Sync, and the commit history. Clicking a change opens it in Monaco's diff editor; for **Changes** the right side is the working tree and stays editable. Gutter bars in every editor mark lines added, changed and removed against the index; click one to open the file's changes. `Alt+F5` / `Shift+Alt+F5` jump between changes in a diff.

Any two files can be compared: **Select for Compare** on one, **Compare with Selected** on the other (explorer or tab context menu), or **File: Compare Active File With...** from the palette. See [Git Integration](git-integration.md).

## Language intelligence and Problems

When a language server is installed for the file's language, hover, Go to Definition (`F12`, `Ctrl/Cmd+Click`), Peek Definition (`Alt+F12`), Find References (`Shift+F12`) and document symbols come from it, and its diagnostics show as squiggles and in the **Problems** panel (`Ctrl/Cmd+Shift+M`, `F8` / `Shift+F8` to step through them). Without one, definitions and symbols fall back to px0's own index. See [LSP & Code Intelligence](lsp-code-intelligence.md).

## Status bar

| Item | Click to |
| :--- | :--- |
| Remote indicator (with the repository name under the workbench) | Switch repository (`Alt+O`) |
| Branch (`*` for unstaged changes, `+` for staged ones, the operation in progress if any) | Pull, Push, Sync, Copy Branch Name, Refresh |
| Sync (`↓ behind ↑ ahead`, or a cloud icon to publish) | Pull then push |
| Errors and warnings | Open the Problems panel |
| `Ln, Col` (and the selection length) | Go to Line/Column |
| `Spaces: 4` / `Tab Size: 4` | Indent using spaces or tabs, detect or convert indentation |
| `UTF-8` | The file's encoding |
| `LF` / `CRLF` | Change the file's line endings |
| Language | Change the language mode of the file |
| Language server | Shows its name and state (starting, indexing, ready, failed) |
| CPU and memory | px0's own process, plus its language servers |
| Bell | Open the notification center |

While the first half of a chord (such as `Ctrl/Cmd+K`) is pressed, the status bar says it is waiting for the second key.

## Settings and themes

`Ctrl/Cmd+,` opens the Settings editor, a searchable form; **Open Settings (JSON)** edits `settings.json` in Monaco. `Ctrl/Cmd+K Ctrl/Cmd+T` picks a color theme, previewing each as you move through the list. See [Settings & Configuration](settings-and-configuration.md) and [Themes](themes-and-styling.md).

`Ctrl/Cmd+K Ctrl/Cmd+S` opens **Keyboard Shortcuts**, a searchable list of every command, its keys and its command ID; double-click a row to run the command. Keybindings cannot be changed yet.

---

## Keyboard shortcuts

`Ctrl/Cmd` means `Cmd` on macOS and `Ctrl` elsewhere; `Alt` is `Option` on macOS. A space separates the two halves of a chord. These are px0's own commands (the source of truth is `web/src/actions.js`); Monaco's editing keys are listed in the Edit, Selection and Go menus.

| Command | Keys |
| :--- | :--- |
| Go to File (Quick Open) | `Ctrl/Cmd+P`, `Ctrl/Cmd+E` |
| Show All Commands | `Ctrl/Cmd+Shift+P`, `F1` |
| Go to Line/Column | `Ctrl/Cmd+G` |
| Go to Symbol in Editor | `Ctrl/Cmd+Shift+O` |
| Go Back / Go Forward | `Alt+Left` / `Alt+Right` (also `Ctrl/Cmd+Alt+-` / `Ctrl/Cmd+Shift+-`) |
| Save / Save All | `Ctrl/Cmd+S` / `Ctrl/Cmd+Alt+S` |
| New File | `Ctrl/Cmd+Alt+N` |
| Rename / Delete (in the explorer) | `F2` / `Delete` |
| Copy Path of Active File | `Shift+Alt+C` |
| Copy Relative Path of Active File | `Ctrl/Cmd+K Ctrl/Cmd+Shift+Alt+C` |
| Close Editor | `Alt+W`, `Ctrl/Cmd+F4` |
| Close All Editors | `Ctrl/Cmd+K Ctrl/Cmd+W`, `Alt+Shift+W` |
| Reopen Closed Editor | `Alt+Shift+T` |
| Keep Editor (pin a preview tab) | `Ctrl/Cmd+K Enter` |
| Next / Previous Editor | `Ctrl/Cmd+Alt+Right` / `Ctrl/Cmd+Alt+Left`, `Ctrl+PageDown` / `Ctrl+PageUp` |
| Open Editor at Index 1–9 | `Alt+1` … `Alt+9` (9 is the last) |
| Split Editor | `Ctrl/Cmd+\` |
| Toggle Word Wrap | `Alt+Z` |
| Go to Next / Previous Change (diff) | `Alt+F5` / `Shift+Alt+F5` |
| Toggle Primary Side Bar | `Ctrl/Cmd+B` |
| Toggle Panel | `Ctrl/Cmd+J` |
| Toggle Secondary Side Bar | `Ctrl/Cmd+Alt+B` |
| Toggle Output | `Ctrl/Cmd+K Ctrl/Cmd+H` |
| Toggle Terminal | `` Ctrl+` `` |
| Create New Terminal | `` Ctrl+Shift+` `` |
| Split Terminal | `Ctrl+Shift+5` (`Cmd+\` on macOS, in the terminal) |
| Show Explorer | `Ctrl/Cmd+Shift+E` |
| Show Search | `Ctrl/Cmd+Shift+F` |
| Show Source Control | `Ctrl/Cmd+Shift+G` |
| Show Problems | `Ctrl/Cmd+Shift+M` |
| Open Settings | `Ctrl/Cmd+,` |
| Open Keyboard Shortcuts | `Ctrl/Cmd+K Ctrl/Cmd+S` |
| Color Theme | `Ctrl/Cmd+K Ctrl/Cmd+T` |
| Markdown: Open Preview | `Ctrl/Cmd+Shift+V` |
| Markdown: Open Preview to the Side | `Ctrl/Cmd+K V` |
| Switch Repository (under the workbench) | `Alt+O` |
| Commit (in the commit message box) | `Ctrl/Cmd+Enter` |

Commands without keys (Customize Layout, Toggle Maximized Panel, Toggle Activity Bar / Status Bar Visibility, the Notifications commands, Revert File, New Folder, Compare Active File With..., Toggle Minimap, Toggle Render Whitespace, Toggle Inline View, Toggle Ignore Trim Whitespace, Open Table Preview, the Git commands, Reload Window, ...) are in the Command Palette.

Quick Open, the Command Palette, Save, Save All, Close Editor, Search, Settings, Keyboard Shortcuts and Color Theme work even while a text field (the commit box, the search box) has focus; the rest give way to the field.

> [!NOTE]
> **Keys the browser keeps.** Browsers do not let a page have `Ctrl/Cmd+W`, `Ctrl/Cmd+T`, `Ctrl/Cmd+N` or `Ctrl+Tab`, so px0 uses VS Code's alternatives: `Alt+W` closes a tab, `Alt+1` … `Alt+9`, `Ctrl/Cmd+Alt+Left/Right` and `Ctrl+PageUp/PageDown` switch tabs, `Alt+Shift+T` reopens a closed tab, and `Ctrl/Cmd+Alt+N` creates a file.
