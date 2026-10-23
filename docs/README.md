# px0 Documentation Hub

px0 is a fast, zero-config code editor and pull request review tool packaged as a single static binary. The Go server indexes the workspace, searches it, and runs git and your language servers; the browser UI is a VS Code-style workbench built on Monaco, VS Code's editor.

This directory holds the user-facing feature guides, the internal engineering write-ups, and the operating guidelines for AI coding agents.

---

## Documentation Sections

### 1. [Feature Guides](features/README.md)
How each feature works and how to use it.
- **[Features Overview](features/README.md)**: index of all feature areas.
- **[The Editor Workbench](features/editor.md)**: layout, editing, tabs and splits, Quick Open, the views, status bar, and the keyboard shortcut table.
- **[Review Workbench](features/workbench.md)**: the single-port launcher (`px0`), folder completion, the Repositories view and `Alt+O` switcher, worktree-backed PRs, pinned and recent workspaces.
- **[Quick Open & Fuzzy File Search](features/fuzzy-file-search.md)**: `Ctrl/Cmd+P`, with `>` commands, `@` symbols and `:` lines.
- **[Workspace Search & Replace](features/workspace-search.md)**: `Ctrl/Cmd+Shift+F`, with case, whole-word, regex, include globs and Replace All.
- **[Symbol Outline](features/symbol-outline.md)**: `Ctrl/Cmd+Shift+O` and the Explorer's Outline.
- **[Language Servers & Code Intelligence](features/lsp-code-intelligence.md)**: hover, `F12`, `Shift+F12`, diagnostics and the Problems panel.
- **[File Explorer](features/file-explorer.md)**: the tree, git badges, inline file operations, drag-and-drop.
- **[File Editing](features/file-editing.md)**: saving, auto save, conflict detection, and file operations.
- **[Git Integration](features/git-integration.md)**: the Source Control view, diffs, gutter quick diff and file compare.
- **[Getting Started with Pull Request Review](features/pr-review-getting-started.md)**: open, connect, review, fix and merge your first PR on GitHub, GitLab, Gitea/Forgejo or Bitbucket.
- **[Pull Request Review](features/github-pr-review.md)**: the Pull Request view, merge-base diffs, review comments, verdicts and merging (`px0 <pr-url>`).
- **[Markdown Preview](features/markdown-preview.md)**: `Ctrl/Cmd+Shift+V`, GFM, alerts, Mermaid, sanitized HTML.
- **[CSV & TSV Table View](features/table-view.md)**: data files as a table.
- **[Image Viewer](features/image-viewer.md)**: image tabs with zoom.
- **[Syntax Highlighting](features/syntax-highlighting.md)**: Monaco's Monarch highlighters, and Chroma on the server.
- **[Settings & Configuration](features/settings-and-configuration.md)**: the Settings editor and `settings.json`.
- **[Themes](features/themes-and-styling.md)**: 14 built-in dark and light themes.
- **[Remote Workspaces](features/remote-workspaces.md)**: remote use over Tailscale/VPNs, `-base-path`, CLI flags.

### 2. [Internal Architecture & Design](internals/README.md)
How px0 works inside: the Go server, its engines, and the frontend.
- **[Subsystem Architecture Map](internals/README.md#1-subsystem-architecture-map)**
- **[System Architecture & Runtime Lifecycle](internals/architecture.md)**
- **[Review Workbench Architecture](internals/workbench.md)**
- **[Filesystem Indexing & Ignore Engine](internals/indexing-and-ignore.md)**
- **[Fuzzy Path Matching Algorithm](internals/fuzzy-search.md)**
- **[Workspace Search & Parallel Grep](internals/workspace-search.md)**
- **[Server-Side Syntax Highlighting](internals/syntax-highlighting.md)**
- **[Language Server Protocol Architecture](internals/lsp-and-intelligence.md)**
- **[Git Integration Internals](internals/git-integration.md)**
- **[Pull Request Review & Forge Providers](internals/github-pr-review.md)**
- **[File Editing & File Operations](internals/file-editing.md)**
- **[File Updates & Reloading Open Files](internals/file-reload-and-updates.md)**
- **[Image Viewer](internals/image-viewer.md)**
- **[Markdown Preview Implementation](internals/markdown.md)**
- **[Theme Architecture & CSS Tokens](internals/styling-and-themes.md)**
- **[Testing & Benchmarks](internals/testing-and-benchmarks.md)**

### 3. [AI Agent Operational Guidelines](agents/README.md)
Architectural rules, the documentation maintenance protocol, and the frontend module map for automated coding agents.

---

## Performance & Comparative Benchmarks

For benchmark results across a 7-repository test suite (from Flask to the 95,000-file Linux kernel) and client/server memory breakdowns against VS Code, see [BENCHMARKS.md](../BENCHMARKS.md).
