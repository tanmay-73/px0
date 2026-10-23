<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://px0.ai/logo/px0-logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://px0.ai/logo/px0-logo-light.png">
  <img alt="px0" src="https://px0.ai/logo/px0-logo-dark.png" width="120">
</picture>

---

px0 is a browser-based code editor with the look and feel of VS Code, served by a single static Go binary. Run it on any machine, open it from any browser, and browse, edit and commit across every repository on that machine. It is built on Monaco, VS Code's own editor, and has no AI features of its own: pair it with whatever coding agent you run in a terminal.

- Single static Go binary with zero runtime dependencies (no Electron, no Node at run time, no CGO); the whole frontend is embedded (~1.5 MB gzipped)
- ~20–30 MB server RAM per workspace
- Remote-first: `-host 0.0.0.0` and open it from anywhere on your network

## Features

- **VS Code workbench**: activity bar, Explorer / Search / Source Control / Repositories / Pull Request views, editor tabs with preview tabs, split editors, breadcrumbs, Problems panel, status bar, menu bar, command center, Command Palette (`Ctrl/Cmd+Shift+P`) and Quick Open (`Ctrl/Cmd+P`, `@` symbols, `:` line).
- **Monaco editor**: VS Code's editor with multi-cursor, find/replace, minimap, sticky scroll, bracket colouring, folding, and syntax highlighting for every Monaco language. Saving detects files changed on disk; files changed outside px0 reload by themselves.
- **Source Control**: staged and unstaged changes, stage / unstage / discard per file or all, commit (and amend, commit & push, commit & sync), push, pull, sync, merge/rebase conflict state with abort, commit history with each commit's files, and quick-diff bars in the editor gutter. Changes open in Monaco's side-by-side or inline diff editor, editable on the working-tree side.
- **Explorer**: file tree with git decorations, new file/folder, rename, delete, drag-and-drop move, Open Editors and Outline sections.
- **Many repositories**: run `px0` with no folder to get the workbench, which lists every git repository on the machine with its branch and pending changes. Switch repository from inside any workspace with `Alt+O`, in the same tab or a new one.
- **Compare any two files** (Select for Compare / Compare with Selected), like VS Code.
- **Search across files** with regex, case and whole-word options, include globs, and Replace All.
- **Language servers** (optional, zero-config): hover, go to definition, peek references, document symbols and diagnostics.
- **Pull request review** for GitHub, GitLab, Gitea/Forgejo and Bitbucket Cloud (`px0 <pr-url>`): the PR's files as diffs against the merge base, inline draft comments from the editor, replies, Approve / Request Changes / Comment, and merging.
- **Previews**: rendered Markdown (with Mermaid), CSV/TSV tables, images.
- A workbench laid out like VS Code 1.142's modern UI (floating parts, connected tabs, sentence-case views, the compact application menu in the activity bar) and 18 themes, including VS Code's current defaults Dark 2026 (the default) and Light 2026 plus Dark Modern and Light Modern, that style both the workbench and the editor; settings in a VS Code-style Settings editor or as `settings.json`.
- An integrated terminal like VS Code's: shells in the panel (xterm.js, WebGL) with splits, tabs, find and file links; bash shell integration (command decorations with exit codes, Ctrl+Up/Down between commands); flow control for heavy output; and shells, including vim or htop, that survive page reloads.

## Installation

Quick install (macOS, Linux, BSD):

```bash
curl -fsSL https://px0.ai/install.sh | sh
```

Build from source (requires Go 1.24+ and Node.js or Bun):

```bash
git clone https://github.com/px0-ai/px0.git
cd px0
make build
install -d ~/.local/bin && install px0 ~/.local/bin/
```

To update an existing installation:

```bash
px0 --update
```

## Usage

```bash
# Open the review workbench: pick any directory or paste a PR URL
px0

# Inspect current directory
px0 .

# Inspect a specific directory or file
px0 ~/workspace/project
px0 main.go:42

# Review a pull request: GitHub, GitLab, Gitea/Forgejo/Codeberg, or Bitbucket Cloud
# (first time? see docs/features/pr-review-getting-started.md)
px0 https://github.com/owner/repo/pull/123
px0 https://gitlab.com/group/project/-/merge_requests/45
px0 https://codeberg.org/owner/repo/pulls/7
px0 https://bitbucket.org/workspace/repo/pull-requests/9

# Remote or headless server mode
px0 -host 0.0.0.0 -port 7777 ~/workspace

# Workbench limited to the repositories under one folder (separate several with ':')
px0 -host 0.0.0.0 -roots ~/workspace

# Allow the integrated terminal on a non-loopback address (anyone who can reach px0 can run commands)
px0 -host 0.0.0.0 -terminal ~/workspace

# Behind a reverse proxy under a subpath
px0 -base-path /rev-123/ -host 0.0.0.0 -port 7777 ~/workspace
```

When px0 binds to `0.0.0.0`, it prints a `network` URL for every unique
non-loopback IPv4 address on the machine, using the port selected by the
listener:

```text
  url:        http://0.0.0.0:7777
  network:    http://10.0.0.15:7777
  network:    http://192.168.1.42:7777
```

With no target, px0 serves the [review workbench](docs/features/workbench.md)
instead, which runs each directory or PR you open as its own px0 under
`/w/<id>/` on the same port. Its list of what you opened is saved in
`$XDG_STATE_HOME/px0/workbench.json` (or `~/.px0/workbench.json`).

Open the address that is reachable from your local machine. The list can
include LAN, VPN, and container-network addresses, depending on the remote
host's interfaces.

Access securely over Tailscale, WireGuard, reverse proxy, or Cloudflare Tunnel
with zero remote setup overhead and workspace-confined file access
(path traversal protection & DNS rebinding checks). Anyone who can reach the
address can also edit files in that workspace, so expose it only over trusted networks.
The workbench goes further: anyone who can reach it can browse and open any directory px0 can read.
The [integrated terminal](docs/features/terminal.md) is off on non-loopback addresses unless you pass `-terminal`; `-no-terminal` turns it off everywhere.

## Development

### Local Docker deployment

See the [detailed Docker deployment guide](docs/deployment.md) for setting up a
new Linux machine, configuring LAN access, updates, backups, and troubleshooting.
For host tools in the integrated terminal and a systemd user service, see the
[native deployment guide](docs/native-deployment.md).

On this machine, run `docker compose up -d --build` and open
`http://10.20.7.180:7777` from the local network. The container runs the
workbench: every git repository under `PX0_REPOS` (default `/mnt/nvme1/Projects`,
mounted at the same path inside the container) is listed and can be opened,
reviewed, staged and committed, in the same tab or a new one, and `-roots` keeps
browsing inside that folder. Your `~/.gitconfig` is mounted read-only so commits
carry your identity; pushing over HTTPS also needs the commented-out
`~/.git-credentials` mount in `compose.yaml`. Settings and the workbench's list
persist in the `px0-home` volume. The container runs as UID 1000 and restarts
automatically unless explicitly stopped. To serve a different folder, run
`PX0_REPOS=/path/to/repos docker compose up -d`.

Use `docker compose ps` to check health, `docker compose logs -f` to view logs,
and `docker compose down` to stop the deployment while retaining settings.
To deploy on another machine, change the host IP in `compose.yaml` and ensure
the workspace owner matches the container's UID.

Building needs Go 1.24+ and [Bun](https://bun.sh) (it bundles Monaco from
`node_modules`; `make web` installs the dependencies the first time):

```bash
git clone https://github.com/px0-ai/px0.git
cd px0

# Bundle the frontend (web/src -> web/dist) and build the binary
make build

# Run tests (Go, plus the frontend checks in scripts/check-web.js)
make test
make web-check
```

The frontend lives in `web/src` (ES modules, entry `main.js`; the workbench
page is `web/src/workbench/main.js`) and is bundled by `scripts/build-web.js`.

## Keyboard shortcuts

The usual VS Code bindings, except where the browser keeps a key for itself
(Ctrl/Cmd+W, +T, +N, +Tab):

| Keys | Action |
| :--- | :--- |
| `Ctrl/Cmd+P` | Go to File (type `@` for symbols, `:` for a line, `>` for commands) |
| `Ctrl/Cmd+Shift+P`, `F1` | Command Palette |
| `Ctrl/Cmd+S`, `Ctrl/Cmd+Alt+S` | Save, Save All |
| `Alt+W` | Close Editor (`Alt+Shift+T` reopens it) |
| `Alt+1`…`Alt+9`, `Ctrl/Cmd+Alt+←/→` | Switch editor tabs |
| `Ctrl/Cmd+\` | Split Editor |
| `Ctrl/Cmd+B`, `Ctrl/Cmd+J` | Toggle Side Bar, Toggle Panel |
| `` Ctrl+` ``, `` Ctrl+Shift+` ``, `Ctrl+Shift+5` | Toggle Terminal, New Terminal, Split Terminal |
| `Ctrl/Cmd+Shift+E` / `F` / `G` | Explorer / Search / Source Control |
| `Ctrl/Cmd+Shift+M` | Problems |
| `Ctrl/Cmd+Shift+V`, `Ctrl/Cmd+K V` | Markdown preview, to the side |
| `F12`, `Alt+F12`, `Shift+F12` | Go to / Peek Definition, References |
| `Alt+←`, `Alt+→` | Go Back / Forward |
| `Alt+F5`, `Shift+Alt+F5` | Next / previous change in a diff |
| `Ctrl/Cmd+Enter` | Commit (in the Source Control message box) |
| `Alt+O` | Switch Repository (workbench) |
| `Ctrl/Cmd+,`, `Ctrl/Cmd+K Ctrl/Cmd+S`, `Ctrl/Cmd+K Ctrl/Cmd+T` | Settings, Keyboard Shortcuts, Color Theme |

## Benchmarks

```bash
# Clone the benchmark corpus (~3 GB: Linux, Kubernetes, TypeScript, etc.)
./benchmark.sh --clone

# Run benchmarks across the corpus
./benchmark.sh

# Compare px0 directly against VS Code on the current workspace
./benchmark.sh --vscode .

# Profile memory lifecycle (index, search, idle memory release)
./benchmark.sh --memory bench-repos/linux
```

> **Architecture & Memory Accounting**: px0 separates the lightweight native Go daemon from the browser-rendered UI. The Go server consumes ~20–30 MB resident RAM (RSS). The active browser tab allocates ~80–150 MB for DOM nodes, V8 JS runtime, and GPU compositing. Combined, the total local memory footprint is ~100–180 MB (~85–90% lighter than Electron IDEs like VS Code at ~1,440 MB, which bundle dedicated Chromium and Node runtimes). In remote or container environments (`px0 -host 0.0.0.0`), the remote host pays strictly the ~20–30 MB server cost. See [BENCHMARKS.md](BENCHMARKS.md) for full methodology and breakdowns.

## Documentation

- [Docs](https://px0.ai/docs)
- [Benchmarks](https://px0.ai/benchmarks)
- [Blog](https://px0.ai/blog)
- [Changelog](https://px0.ai/changelog)
- [Partners](https://px0.ai/design-partners)

## License

[MIT License](LICENSE) © Arpit Bhayani
