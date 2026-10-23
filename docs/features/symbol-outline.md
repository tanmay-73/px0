# Symbol Outline & Go to Symbol

px0 lists the declarations in the active file (functions, methods, types, classes, constants, Markdown headings, ...) in two places:

- **Go to Symbol in Editor** (`Ctrl/Cmd+Shift+O`, or `@` in Quick Open): type to fuzzy-filter the symbols; moving through the list scrolls the editor to each one, `Enter` jumps there. Each entry shows its kind and an icon.
- **Outline**, the bottom section of the Explorer: the file's symbols as a tree that follows the cursor. Click a symbol to go to it. Collapse the section when you don't need it; its state is remembered.

---

## Where the symbols come from

- **Language server.** When a language server is running for the file (`gopls`, `rust-analyzer`, `pyright`, ...), px0 asks it for the document symbols, with their nesting.
- **Built-in fallback.** Otherwise px0 extracts symbols with its own fast regex outline for Go, Python, JavaScript/TypeScript, Rust, C/C++, Java, Ruby, Shell, PHP, Lua, Zig, Elixir and Markdown, so the outline always works, even before a language server has started.

## Keys

| Key | Action |
| :--- | :--- |
| `Ctrl/Cmd+Shift+O` | Go to Symbol in Editor |
| `@` (first character) | Switch Quick Open into symbol mode |
| `↑` / `↓` | Move through symbols (the editor follows) |
| `Enter` / `Esc` | Jump / close |

For the LSP symbol request and the regex fallback (`/api/lsp/symbols`, `/api/outline`), see [Language Server Protocol Architecture](../internals/lsp-and-intelligence.md) and [Workspace Search & Symbol Extraction](../internals/workspace-search.md).
