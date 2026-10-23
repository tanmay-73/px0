# Language Servers & Code Intelligence

px0 connects Monaco to the language servers already installed on your machine (`gopls`, `rust-analyzer`, `typescript-language-server`, `pyright`, `clangd`, ...). A server is started lazily, the first time you open a file in its language, and px0 falls back to its own index when no server is available, so navigation works in any language.

---

## What you get

| Feature | How | Source |
| :--- | :--- | :--- |
| **Hover** | Rest the pointer on an identifier | Language server |
| **Go to Definition** | `F12`, `Ctrl/Cmd+Click`, or the context menu | Language server; otherwise px0's symbol index (`/api/def`) |
| **Peek Definition** | `Alt+F12` | Same |
| **Find References** | `Shift+F12` (opens Monaco's peek view) | Language server |
| **Document symbols** | `Ctrl/Cmd+Shift+O`, the Explorer's Outline | Language server; otherwise px0's regex outline (`/api/outline`) |
| **Diagnostics** | Squiggles in the editor, the **Problems** panel, counts in the status bar | Language server |

- Definitions in another file open it in a tab at the declaration; definitions outside the workspace (a standard library, a dependency cache) open read-only.
- `Alt+Left` / `Alt+Right` go back and forward through the places you jumped between.
- The status bar shows the language server for the active file and its state: starting, indexing, ready or failed (hover it for details). Diagnostics are refreshed after each save and every few seconds while the server is ready.

### Problems panel

`Ctrl/Cmd+Shift+M` (or a click on the error and warning counts in the status bar) opens **Problems**: every diagnostic in every open file, grouped by file, with its source and code. Type in the filter to narrow it by text or path. Click a problem to go to it; `F8` / `Shift+F8` step through problems in the editor.

## Supported language servers

px0 looks for these on your `PATH` (and the usual install locations):

| Language | Binary | Install |
| :--- | :--- | :--- |
| **Go** | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| **Rust** | `rust-analyzer` | `rustup component add rust-analyzer` |
| **TypeScript / JavaScript** | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| **Python** | `pyright` / `pylsp` / `ruff` | `npm install -g pyright` or `pipx install python-lsp-server` |
| **C / C++** | `clangd` | `sudo apt install clangd` or `brew install llvm` |
| **Zig** | `zls` | `brew install zls` or download from [zigtools/zls](https://github.com/zigtools/zls) |
| **Lua** | `lua-language-server` | `brew install lua-language-server` |
| **Ruby** | `solargraph` | `gem install solargraph` |
| **Java** | `jdtls` | `brew install jdtls` |
| **C#** | `omnisharp` | Install OmniSharp on `PATH` |
| **LaTeX** | `texlab` | `brew install texlab` |

Install a server and reopen the file (or reload the window); px0 picks it up without a restart.

## Without a language server

- Go to Definition searches px0's symbol index for the word under the cursor.
- The outline and Go to Symbol use px0's built-in regex outline.
- Hover, references and diagnostics are not available.

Monaco's own TypeScript, JSON, CSS and HTML language services are not bundled (they would add megabytes and duplicate the language servers); those languages still get syntax highlighting.

## Configuration

- `px0 -no-lsp` runs without language servers, relying on px0's own index.

For the server lifecycle, JSON-RPC transport, external path sandboxing and the endpoints (`/api/lsp/*`), see [Language Server Protocol Architecture](../internals/lsp-and-intelligence.md).
