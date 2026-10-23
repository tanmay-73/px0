# px0 Features Guide

px0 is a fast, zero-config code editor and pull request review tool in a single binary. The server indexes, searches and runs git and language servers; the browser UI is a VS Code-style workbench built on Monaco, VS Code's editor. If you know VS Code, you already know most of the keys.

Start with **[The Editor Workbench](editor.md)**: the layout, tabs and splits, Quick Open, the views, and the full keyboard shortcut table.

---

## Feature matrix

| Feature area | Primary shortcut | What it does | Guide |
| :--- | :--- | :--- | :--- |
| **Editor workbench** | `Ctrl/Cmd+Shift+P` | Monaco editor, editor groups, preview tabs, menus, status bar, session restore | [The Editor Workbench](editor.md) |
| **Quick Open** | `Ctrl/Cmd+P` | Server-side fuzzy file search over the whole index; `>` commands, `@` symbols, `:` line | [Quick Open & Fuzzy File Search](fuzzy-file-search.md) |
| **Workspace search** | `Ctrl/Cmd+Shift+F` | Parallel text and regex search with case, whole-word, include globs and Replace All | [Workspace Search & Replace](workspace-search.md) |
| **Symbols** | `Ctrl/Cmd+Shift+O` | Go to Symbol and the Explorer's Outline, from the language server or px0's regex outline | [Symbol Outline](symbol-outline.md) |
| **Code intelligence** | `F12`, `Shift+F12` | Hover, definitions, references and diagnostics from installed language servers, with fallbacks | [Language Servers & Code Intelligence](lsp-code-intelligence.md) |
| **Explorer** | `Ctrl/Cmd+Shift+E` | Virtualized tree with git badges, inline new/rename, drag-and-drop move, Open Editors, Outline | [File Explorer](file-explorer.md) |
| **Editing & files** | `Ctrl/Cmd+S` | Save with on-disk conflict detection, quiet reload of unchanged files, create/rename/move/delete | [File Editing](file-editing.md) |
| **Source Control** | `Ctrl/Cmd+Shift+G` | Stage, unstage, discard, commit, amend, pull, push, sync, history, diffs, gutter quick diff, compare | [Git Integration](git-integration.md) |
| **Pull request review** | `px0 <pr-url>` | GitHub, GitLab, Gitea/Forgejo and Bitbucket Cloud: merge-base diffs, review comments, verdicts, merging | [Pull Request Review](github-pr-review.md) · [Getting Started](pr-review-getting-started.md) |
| **Workbench** | `px0`, `Alt+O` | Open any folder or PR from one page; Repositories view and switcher | [Review Workbench](workbench.md) |
| **Markdown preview** | `Ctrl/Cmd+Shift+V`, `Ctrl/Cmd+K V` | GFM, alerts, highlighted code, Mermaid, sanitized HTML | [Markdown Preview](markdown-preview.md) |
| **CSV / TSV tables** | Open Table Preview | Data files as a table with source line numbers | [Table View](table-view.md) |
| **Images** | Open an image | Image tabs with zoom, fit and actual size | [Image Viewer](image-viewer.md) |
| **Syntax highlighting** | Automatic | Monaco's Monarch highlighters for ~80 languages, coloured by the px0 theme | [Syntax Highlighting](syntax-highlighting.md) |
| **Integrated terminal** | `` Ctrl+` `` | Shells in the panel (xterm.js), splits, tabs, find, file links; survive reloads | [Integrated Terminal](terminal.md) |
| **Settings** | `Ctrl/Cmd+,` | Settings editor and settings.json in Monaco, applied live | [Settings & Configuration](settings-and-configuration.md) |
| **Themes** | `Ctrl/Cmd+K Ctrl/Cmd+T` | 18 dark and light themes for the workbench and the editor | [Themes](themes-and-styling.md) |
| **Remote use** | CLI flags | Run on a server or container, browse from your machine; `-base-path` for proxies | [Remote Workspaces](remote-workspaces.md) |

---

## 1. Navigating code

- **[Quick Open](fuzzy-file-search.md)** finds any file in a few keystrokes; the same box runs commands (`>`), jumps to symbols (`@`) and lines (`:`).
- **[Workspace Search](workspace-search.md)** greps the whole repository in parallel and can replace across files.
- **[Symbols](symbol-outline.md)** and **[Code Intelligence](lsp-code-intelligence.md)** give Go to Definition, Peek, References, hover and diagnostics through the language servers you already have, falling back to px0's own index.
- **[File Explorer](file-explorer.md)** shows the tree with git status, and handles file operations inline.

## 2. Editing

- **[The Editor Workbench](editor.md)**: Monaco editing, preview tabs, split editor groups, and tabs restored per workspace.
- **[File Editing](file-editing.md)**: saving, auto save, conflict detection when a file changed on disk, and creating, renaming, moving and deleting files and folders.

## 3. Git and review

- **[Git Integration](git-integration.md)**: the Source Control view (Merge / Staged / Changes groups, commit variants, pull, push, sync, history), Monaco diffs with an editable working-tree side, gutter quick diff against the index, and comparing any two files.
- **[Pull Request Review](github-pr-review.md)** and **[Getting Started](pr-review-getting-started.md)**: `px0 <pr-url>` checks out the PR, diffs it against its merge-base, and adds a Pull Request view for comments, reviews and merging.
- **[Review Workbench](workbench.md)**: a bare `px0` opens a launcher for every folder and PR, each in its own process, with a Repositories view and `Alt+O` switcher inside every workspace.

## 4. Documents and media

- **[Markdown Preview](markdown-preview.md)**, **[Table View](table-view.md)** and **[Image Viewer](image-viewer.md)** open as their own tabs beside the text editor.

## 5. Customization

- **[Settings & Configuration](settings-and-configuration.md)**: one `settings.json` outside every repository; `editor.*` keys go straight to Monaco.
- **[Themes](themes-and-styling.md)** and **[Syntax Highlighting](syntax-highlighting.md)**: one CSS token set colours the workbench, Monaco and the Markdown preview.

## 6. Running px0 remotely

- **[Remote Workspaces](remote-workspaces.md)**: run px0 on a remote machine, VM, container or CI runner and use it from your local browser.
