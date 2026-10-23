# Themes

px0 ships 18 color themes. A theme colours the whole workbench (side bar, tabs, panels, status bar, Markdown preview) and the Monaco editor, including syntax highlighting and diffs, from one set of CSS tokens.

---

## Built-in themes

| Theme | ID | Scheme |
| :--- | :--- | :--- |
| **Catppuccin Mocha** | `catppuccin-mocha` | dark |
| **Catppuccin Latte** | `catppuccin-latte` | light |
| **Dark 2026** (default) | `vscode-dark-2026` | dark |
| **Light 2026** | `vscode-light-2026` | light |
| **Dark Modern** | `vscode-dark` | dark |
| **Light Modern** | `vscode-light` | light |
| **Dracula** | `dracula` | dark |
| **GitHub Dark** | `github-dark` | dark |
| **Gruvbox Dark** | `gruvbox-dark` | dark |
| **Gruvbox Light** | `gruvbox-light` | light |
| **Monokai** | `monokai` | dark |
| **Nord** | `nord` | dark |
| **One Dark** | `one-dark` | dark |
| **Paper** | `light` | light |
| **Rose Pine** | `rose-pine` | dark |
| **Solarized Dark** | `solarized-dark` | dark |
| **Solarized Light** | `solarized-light` | light |
| **Tokyo Night** | `dark` | dark |

## Switching themes

- **Preferences: Color Theme** (`Ctrl/Cmd+K Ctrl/Cmd+T`), **File > Color Theme** (in the application menu) or **Manage > Themes > Color Theme** opens a picker grouped into dark and light themes. Moving through the list previews each theme; `Enter` keeps it, `Esc` restores the one you had.
- Or set `workbench.colorTheme` in Settings (`Ctrl/Cmd+,`) or settings.json.

The choice is saved to settings.json, so the [workbench](workbench.md) page and every workspace use it, and also remembered in the browser. The workbench page has its own theme button in its title bar.

## Custom themes

A theme is one CSS file in `web/themes/` that sets px0's colour tokens; adding a file adds a theme, with no list to update. See [Theme Architecture & CSS Tokens](../internals/styling-and-themes.md) for the token reference and how px0 turns a theme into a Monaco theme.

Dark 2026 and Light 2026 are VS Code's default themes (as of VS Code 1.142); they and the Modern themes use VS Code's own editor and workbench colours, measured from the running VS Code. Saved theme choices are preserved. Every theme shares VS Code's modern layout: the activity bar, side bar, editor and panel float as rounded cards on the window background, the active editor tab joins the editor below it, and view titles are in sentence case. File icons use the bundled Seti font. The title bar's Back, Forward and layout buttons run the same commands available in the menus and keyboard shortcuts.
