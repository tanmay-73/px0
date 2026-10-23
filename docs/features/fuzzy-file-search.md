# Quick Open & Fuzzy File Search

`Ctrl/Cmd+P` (or `Ctrl/Cmd+E`, or a click on the command center in the title bar) opens Quick Open: type a few characters of a file's name or path and open it. The matching runs on the server against its in-memory index, so it stays instant on repositories with tens of thousands of files.

---

## Matching

- **Fuzzy, path-aware.** Characters may be scattered: `srvt` finds `server_test.go`, and directory fragments narrow it down (`auth/tok`, `pkg/srv/cfg`), which separates the dozens of `index.ts` or `types.go` in a large repository.
- **Ranked by where characters land.** Matches at the start of the name, after `/`, `_` or `-`, and at camelCase humps score higher than scattered ones; whole-basename matches come first.
- **Highlighted.** The matched characters are highlighted in the file name and its folder.
- **Recent files.** With an empty query, Quick Open lists the files you opened recently in this workspace (most recent first, the active one left out).
- **Ignored files** (by `.gitignore`) are left out.
- Up to 100 results are listed.

## Modes

The first character switches mode, as in VS Code:

| Prefix | Mode |
| :--- | :--- |
| *(none)* | Files. `name.go:42` (or `name.go:42:7`) opens the file at that line and column. |
| `>` | Commands (the Command Palette, `Ctrl/Cmd+Shift+P` / `F1`) |
| `@` | Symbols in the active file (`Ctrl/Cmd+Shift+O`) |
| `:` | Go to line or `line:column` in the active file (`Ctrl/Cmd+G`) |

## Keys

| Key | Action |
| :--- | :--- |
| `Ctrl/Cmd+P`, `Ctrl/Cmd+E` | Open Quick Open |
| `↑` / `↓`, `Ctrl+N` / `Ctrl+P`, `Tab` / `Shift+Tab` | Move through results |
| `PageUp` / `PageDown` | Move ten results |
| `Enter` | Open the file |
| `Ctrl/Cmd+Enter` | Open the file to the side |
| `Esc` | Close |

Files opened from Quick Open open in a kept tab (not a preview).

For the scoring algorithm and the bounded two-pass search behind `/api/find`, see [Fuzzy Path Matching Internals](../internals/fuzzy-search.md).
