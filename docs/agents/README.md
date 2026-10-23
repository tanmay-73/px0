# Operational Guidelines for AI Agents

This document defines critical instructions, architectural principles, and documentation maintenance workflows for AI coding agents working on px0.

## 1. Core Architectural Tenets

1. Explicit Writes Only: reads stay px0's hot path, and px0 never authors or formats changes on its own initiative. It writes files only through its own endpoints, and only as one explicit, user-initiated action at a time: saving typed content (`/api/file/save`, with an `mtime` conflict check), creating, renaming and deleting files and folders (`/api/fs/new`, `/api/fs/rename`, `/api/fs/delete`), and discarding worktree changes (`/api/git/discard`), see [`docs/internals/file-editing.md`](../internals/file-editing.md). Every write endpoint is a same-origin POST (`localPost`). Do not add further file modification APIs that take content from the client; extend the endpoints above instead. The integrated terminal (`terminal.go`) is the one place the user can run arbitrary commands; it is user-driven like the rest, and stays behind its policy (loopback only unless `-terminal`) and `localPost` / `terminalSocketAllowed`.
1. Zero Runtime and Single Binary Footprint: Any change must compile into a single static binary (`go:embed` for web assets). Do not introduce runtime dependencies (no Node.js/npm runtime requirement, no external database, no CGO dependencies).
1. Nothing Written Into a Working Tree: px0 keeps its own state (`settings.json`) under the user's config directory (`$XDG_CONFIG_HOME/px0/` or `~/.px0/`), and per-workspace session files (`server.go`, PR review drafts) and the workbench store (`workbench.json`) under the state directory (`$XDG_STATE_HOME/px0/` or `~/.px0/`), never inside a workspace. There are no local `.px0/` folders or cache files in a repository. *File content* is only written by the user's own explicit save, create, rename, delete or discard in the browser, never by px0 on its own initiative. *Git state* follows the same rule: the git endpoints (Stage/Unstage/Discard/Commit/Amend/Push/Pull/Abort in `git.go`, `server.go`, driven by the Source Control view) write to the index, refs, and remote only as one explicit, user-clicked action at a time, never automatically, and Pull is fast-forward-only so it can never leave a repository mid-conflict. Do not add any other px0-authored write to a working tree.
1. Performance Budgets: Indexing must complete in milliseconds using bounded concurrency (`NumCPU * 4`). Searches, fuzzy finds and tree listings run against the in-memory index; the explorer stays virtualized and lazy. Keep the frontend bundle lean: Monaco's language-service workers stay out (`scripts/gen-monaco.js`), and heavy vendor assets (Mermaid) are fetched on demand rather than embedded. Maintain explicit memory reclamation (`debug.FreeOSMemory()` on idle).

## 2. Mandatory Documentation Maintenance Protocol

Whenever modifying, adding, or refactoring code in this repository, you must audit and update the documentation accordingly:

### Documentation Mapping Matrix

| Component Modified                   | Primary Source Files                                             | Docs to Update                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| System Architecture / Optimizations  | All `.go` files, `web/src/**/*.js`                               | [`docs/internals/architecture.md`](../internals/architecture.md)                                                 |
| Indexing / Tree Walk / Gitignore     | `index.go`, `internal/ignore/ignore.go`                          | [`docs/internals/indexing-and-ignore.md`](../internals/indexing-and-ignore.md), [`README.md`](../../README.md)    |
| Fuzzy File Finder                    | `internal/fuzzy/fuzzy.go`                                        | [`docs/internals/fuzzy-search.md`](../internals/fuzzy-search.md)                                                 |
| Search / Regex / Symbol Outlines     | `search.go`, `internal/symbols/symbols.go`                       | [`docs/internals/workspace-search.md`](../internals/workspace-search.md), [`BENCHMARKS.md`](../../BENCHMARKS.md) |
| Syntax Highlighting                  | `internal/render/render.go` (Chroma: Markdown fences, `/api/file`), `web/src/monaco.js`, `scripts/gen-monaco.js` (Monarch languages) | [`docs/internals/syntax-highlighting.md`](../internals/syntax-highlighting.md), [`docs/features/syntax-highlighting.md`](../features/syntax-highlighting.md) |
| Integrated Terminal (`/api/terminal/*`, policy, `-terminal`, `-no-terminal`) | `terminal.go`, `terminal_screen.go` (replay), `terminal_bash.sh` (shell integration), `terminal_unix.go`, `terminal_windows.go`, `main.go`, `web/src/terminal.js`, `web/src/commands.js` (terminal key routing) | [`docs/internals/terminal.md`](../internals/terminal.md), [`docs/features/terminal.md`](../features/terminal.md), [`README.md`](../../README.md) |
| Language Servers (LSP)               | `lsp.go`, `server.go`, `web/src/lsp.js`, `web/src/problems.js`   | [`docs/internals/lsp-and-intelligence.md`](../internals/lsp-and-intelligence.md), [`README.md`](../../README.md)|
| Git Integration & Diffing            | `git.go`                                                         | [`docs/internals/git-integration.md`](../internals/git-integration.md)                                           |
| Source Control (`/api/git/status`, stage/unstage, discard, show, commit/amend, push/pull, abort, `tree` SSE event) | `git.go`, `server.go`, `index.go` (`TouchPath`), `web/src/git.js`, `web/src/scm.js`, `web/src/dirtydiff.js`, `web/src/linediff.js` | [`docs/internals/git-integration.md`](../internals/git-integration.md), [`docs/features/git-integration.md`](../features/git-integration.md), [`README.md`](../../README.md) |
| Commit History & Unpushed Commits (`/api/git/log`, `@{u}..HEAD`, `/api/commitfiles`, per-commit diffs) | `git.go`, `server.go`, `web/src/scm.js` (Commits section), `web/src/editors.js` (`openDiff`) | [`docs/internals/git-integration.md`](../internals/git-integration.md), [`docs/features/git-integration.md`](../features/git-integration.md), [`README.md`](../../README.md) |
| Pull Request Review (all forges)     | `pr.go`, `forge.go` (the `GitProvider` interface), `server.go` (draft persistence), `web/src/pr.js` (Pull Request view, review comments, merging, Connect) | [`docs/internals/github-pr-review.md`](../internals/github-pr-review.md), [`docs/features/github-pr-review.md`](../features/github-pr-review.md), [`README.md`](../../README.md) |
| Forge Providers (GitHub, GitLab, Gitea/Forgejo, Bitbucket Cloud) | `forge.go`, `internal/settings/settings.go` (token settings); tests in `pr_test.go` | [`docs/internals/github-pr-review.md` §2 and "Adding a forge"](../internals/github-pr-review.md) |
| Forge Onboarding (Connect, token check) | `pr.go`, `forge.go`, `web/src/pr.js` (`connectForge`), each provider's `TokenSetup` | [`docs/internals/github-pr-review.md` §4](../internals/github-pr-review.md), [`docs/features/pr-review-getting-started.md`](../features/pr-review-getting-started.md) |
| PR Merging, Merge Status & Rebase onto Base | `pr.go` (merge handlers, `Push(force)`), `server.go` (`prSyncState`), `web/src/pr.js` (Merge section) | [`docs/internals/github-pr-review.md`](../internals/github-pr-review.md), [`docs/features/github-pr-review.md` §6](../features/github-pr-review.md) |
| Review Workbench (bare `px0`, child workspaces, proxy, PR clones, `workbench.json`) | `workbench.go`, `pr.go` (`findPRRemote`), `main.go` (`runWorkbench`, `-workbench-child`), `web/workbench.html`, `web/src/workbench/main.js`, `web/src/css/workbench.css`, `web/src/repos.js` (Repositories view, `Alt+O`), `web/src/api.js` (`inWorkbench`, `wbURL`), `scripts/build-web.js` | [`docs/internals/workbench.md`](../internals/workbench.md), [`docs/features/workbench.md`](../features/workbench.md), [`README.md`](../../README.md) |
| File Editing & File Operations (`/api/file/text`, `/api/file/save`, `/api/file/stat`, `/api/fs/new`, `/api/fs/rename`, `/api/fs/delete`) | `server.go`, `index.go` (`TouchPath`, `TouchTree`), `web/src/models.js`, `web/src/actions.js` (save, auto save), `web/src/explorer.js` | [`docs/internals/file-editing.md`](../internals/file-editing.md), [`docs/features/file-editing.md`](../features/file-editing.md), [`README.md`](../../README.md) |
| Frontend UI (workbench, editors, commands, keybindings) | `web/src/**/*.js`, `web/src/css/*.css`, `web/index.html`, `scripts/build-web.js`, `scripts/gen-monaco.js` | [`docs/features/editor.md`](../features/editor.md) (shortcut table from `web/src/actions.js`), [`docs/internals/architecture.md` §6](../internals/architecture.md#6-frontend), this file's §5 |
| Markdown Preview / Table / Image Viewers | `internal/render/render.go`, `internal/table/table.go`, `web/src/previews.js`, `web/src/mermaid.js`, `web/src/css/markdown.css` | [`docs/internals/markdown.md`](../internals/markdown.md), [`docs/internals/image-viewer.md`](../internals/image-viewer.md) |
| Themes / Colour Tokens               | `web/themes/*.css`, `web/src/css/*.css`, `web/src/theme.js` (incl. the Monaco theme) | [`docs/internals/styling-and-themes.md`](../internals/styling-and-themes.md)                                    |
| User-Facing Features / Workflows    | All features, UX, and controls                                   | [`docs/features/README.md`](../features/README.md)                                                               |
| CLI Flags / Configuration            | `main.go`, `internal/settings/settings.go`, `web/src/settings.js` (editor options, Settings editor) | [`docs/features/settings-and-configuration.md`](../features/settings-and-configuration.md), [`README.md`](../../README.md)|
| Performance Metrics / Scripts        | `benchmark.sh`                                                   | [`BENCHMARKS.md`](../../BENCHMARKS.md)                                                                           |
| Release Workflow                     | `Makefile`, `build.sh`, `scripts/build-web.js`                   | [`PUBLISHING.md`](../../PUBLISHING.md)                                                                           |

## 3. Checklist for Agents Prior to Submitting Work

- Fast Inner Loop: Run `make check` or `go test -short .` for fast iteration (~10s). For frontend-only changes, `make web-check` (syntax, imports, `bun test web/src/`).
- Full Verification: Ran `make test` or `go test .` and confirmed all unit/regression tests pass (`ok px0`).
- Build Integrity: Verified successful build with `make build` (or `go build -o px0 .`).
- Architecture Sync: Any new optimization, algorithmic adjustment, or structural change is documented in the corresponding [`docs/internals/`](../internals/README.md) write-up.
- Flag & Shortcut Sync: Any new keyboard shortcut, UI behavior, or CLI flag is reflected in [`README.md`](../../README.md).
- Benchmark Alignment: If search, highlight, or index performance characteristics change, verify whether [`BENCHMARKS.md`](../../BENCHMARKS.md) requires updated notes or numbers.

## 4. Version Bump & Release Verification Protocol

When committing a version bump (triggered after the user updates the `VERSION` file):
1. **Verify Release Pipeline First**: Before creating the version bump commit, verify that all GitHub release scripts and build workflows are working cleanly without errors:
   - Frontend bundling: Verify `node ./scripts/build-web.js` (needs Bun) bundles cleanly, and `make web-check` passes.
   - Build & Cross-Compilation: Verify `go test ./...` passes and target builds in `build.sh` / `.github/workflows/release.yml` compile cleanly.
   - Release Configuration: Verify checksums, release workflow definitions, and installer compatibility.
2. **Commit Release Fixes First**: If any release scripts, bundlers, or workflow configurations need updates or fixes, make those changes and commit them in a separate commit first.
3. **Commit Version Bump**: Finally, create the version bump commit staging `VERSION` with the updated version number that the user started with (following the `ape-commit` format).

## 5. Frontend Architecture & Code Map for Agents

The frontend is a VS Code-style workbench built on Monaco: plain ES modules under [`web/src/`](../../web/src/), bundled by Bun ([`scripts/build-web.js`](../../scripts/build-web.js)) into `web/dist/` (gzipped, embedded by `server.go`). Every module starts with a header comment describing what it owns; read it before editing. The architecture is described in [`docs/internals/architecture.md` §6](../internals/architecture.md#6-frontend).

### Pages

| File | Description |
| ---- | ----------- |
| `web/index.html` | The editor page: `<div id="app">`, `static/themes.css`, `static/dist/app.css`, `static/dist/app.js`. `web/src/main.js` builds everything inside `#app`. |
| `web/workbench.html` | The workbench page (bare `px0`): loads `static/dist/workbench.js` / `workbench.css`, built from `web/src/workbench/main.js`. |

### Modules (`web/src/`)

| Module | Responsibilities |
| ------ | ---------------- |
| `main.js` | Entry point. `boot()`: `/api/meta`, settings, theme, layout, editors, keybindings; registers views (Explorer, Search, Source Control, Pull Request, Repositories), the Problems panel, viewers and editor title actions; the menu bar (File, Edit, Selection, View, Go, Help); the `/api/stream` EventSource (`stream:git`, `stream:tree`, `stream:metrics`); periodic `checkDisk()`; session restore and `?path=&line=`; the settings.json editor tab. |
| `layout.js` | The shell in VS Code's modern layout (parts as floating cards): title bar (app icon, command center, layout controls, Customize Layout), activity bar (application menu, view icons with badges, Accounts and Manage menus), side bar with resizable sash and its **…** menu (`view.menu`), secondary side bar (`setAuxView`), editor area, panel (tabs, per-panel `widget` and `actions`, maximize), status bar items (`statusItem`). `registerView`, `registerPanel`, `showView`, `showPanel`, `setAppMenu`, `setAccountsMenu`; remembers sizes and visibility. |
| `editors.js` | Editor groups and tabs. Tab kinds `file` / `diff` / `view`; preview tabs; `openFile`, `openDiff`, `openView`, `splitTab`, `closeTab(s)`, drag between groups, tab context menu, breadcrumbs, title actions (`registerEditorAction`), viewers (`registerViewer`), session save/restore, follow renames (`fs:renamed`), Monaco editor opener. |
| `models.js` | Monaco models: one shared document per file (`openDoc`, `retain`/`release`), `save` with mtime conflict handling, `revert`, `checkDisk` via `/api/file/stat`, read-only originals from `/api/git/show` (`originalModel`), `textModel`. |
| `commands.js` | Command registry (`register`, `run`, `allCommands`, `keysFor`) and the capture-phase key dispatcher with chords. |
| `actions.js` | Every command and its keybinding (source of truth for shortcuts), save/auto save/trim/final newline, navigation history (Alt+Left/Right), theme picker, Keyboard Shortcuts view. |
| `palette.js` | Quick Open: files (`/api/find`, recent files), `>` commands, `@` symbols, `:` line; `pickFile`. |
| `quickinput.js` | VS Code's quick input widget (`quickPick`, `inputBox`), fuzzy match and highlight. Tested by `quickinput.test.js`. |
| `explorer.js` | Explorer view: Open Editors, the virtualized lazy tree (`/api/tree`) with git decorations, keyboard navigation, inline new/rename, delete, drag-and-drop move, context menus, auto reveal. |
| `outline.js` | The Explorer's Outline section, following the cursor. |
| `search.js` | Search view: `/api/search` with case / word / regex / include glob, results, Replace / Replace All through the document models. |
| `git.js` | Git state `G` from `/api/git/status`, `decoration(path)`, and the write operations (`stage`, `unstage`, `discard`, `commit`, `push`, `pull`, `sync`, `abortOperation`) run one at a time through `op()`. |
| `scm.js` | Source Control view: commit box and button (smart commit, amend, commit & push/sync, sync/publish), Merge / Staged / Changes groups, inline actions, Commits history (`/api/git/log`, `/api/unpushed`, `/api/commitfiles`), `openChange` diff semantics. |
| `dirtydiff.js` | Gutter quick diff against the `INDEX` version, click to open changes. |
| `linediff.js` | Myers line diff used by `dirtydiff.js`. No imports; tested by `linediff.test.js`. |
| `compare.js` | Select for Compare / Compare with Selected / compare two files in a diff editor. |
| `lsp.js` | Monaco hover, definition, reference and document-symbol providers over `/api/lsp/*`, fallbacks `/api/def` and `/api/outline`, warm-up and state, diagnostics as markers. |
| `problems.js` | Problems panel from Monaco markers, its filter box and actions in the panel title; counts for the status bar and badge. |
| `terminal.js` | Terminal panel: xterm.js instances in groups (splits) with a tabs list, one WebSocket each to `/api/terminal/ws`, flow-control acks, reconnect and replay (sized parts), re-attach on reload (`px0.terminal.groups:<root>`), shell-integration decorations (OSC 633), WebGL renderer, find widget, file links, copy/paste, `showTerminal` / `toggleTerminal` / `newTerminal`. |
| `output.js` | Output panel: named channels (Git, Language Server, px0) written through `emit('output', { channel, text })`, a channel picker in the panel title, Clear Output. |
| `statusbar.js` | Status bar items: remote indicator / repository switcher, branch menu, sync, problems, chord hint, git busy; cursor, indentation, encoding, EOL, language, language server, CPU/memory, notifications bell. |
| `previews.js` | Viewers: Markdown preview (`/api/markdown`, `mdSanitize`, `mdEnhance`, links), CSV/TSV table (`/api/table`), image, binary. |
| `mermaid.js` | Lazy, strict-mode Mermaid rendering for Markdown fences, with zoom, pan, full screen and an SVG cache. |
| `settings.js` | Settings values (`/api/settings`), `editorOptions()` / `diffOptions()` mapped from `editor.*` / `diffEditor.*`, the Settings editor form. |
| `theme.js` | Theme discovery from loaded CSS, `setTheme`, `initialTheme`, and `monacoTheme()` mapping px0 tokens to a Monaco theme. Shared with the workbench page. |
| `monaco.js` | Monaco setup: worker URL, JSON Monarch highlighter, `applyMonacoTheme`, `languageFor(path)` file-name mappings. |
| `gen/monaco.js` | Generated by `scripts/gen-monaco.js`: Monaco's import list minus the TS/HTML/CSS/JSON language services. Do not edit. |
| `repos.js` | Workbench integration inside a workspace: Repositories view, Switch Repository picker (`Alt+O`), `openInWorkbench`. |
| `pr.js` | Pull Request view (Overview, Files Changed, Comments, Your Review, Merge), PR diffs against `BASE`, Add Review Comment and glyph-margin comments, submit, merge, Connect. |
| `ui.js` | Context menus with submenus, keybinding key caps (`keycaps`), notification toasts and the notification center (Do Not Disturb), confirm and prompt dialogs, panes, tooltips. |
| `icons.js` | File icons (codicons tinted per language). |
| `api.js` | Shared state `S`, `api()` / `post()` relative to `<base>`, workbench URLs (`inWorkbench`, `wbURL`). |
| `util.js` | DOM builder `h()`, `icon()`, event bus (`emit`/`on`), `pref`/`setPref` (`localStorage`, `px0.` prefix), key labels, paths, `debounce`, formatting. |
| `workbench/main.js` | The workbench page: Start (path / PR URL with folder completion, clone prompt), Recent (pin/stop/remove), Browse, Repositories, theme picker, metrics. |
| `css/app.css`, `css/markdown.css`, `css/workbench.css` | Workbench, Markdown preview and workbench-page styles; colours only from theme tokens. |

### Conventions

- Add a user-facing action as a command in `actions.js` (with VS Code's command ID and keybinding where the browser allows it), then call it by ID from menus and buttons. Update the shortcut table in [`docs/features/editor.md`](../features/editor.md) when keys change.
- Cross-module notifications go through the event bus (`emit`/`on` in `util.js`) rather than new imports, to avoid cycles.
- Run `make web-check` after changing `web/src/`; add `*.test.js` beside pure modules (no DOM or Monaco imports) to have `bun test` cover them.
