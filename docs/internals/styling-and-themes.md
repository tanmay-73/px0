# Styling & Theme Architecture

px0 reads every colour through a CSS custom property, a *token*. A theme is one CSS file that assigns the tokens. The workbench chrome reads them straight from CSS; Monaco cannot read CSS variables, so [`web/src/theme.js`](../../web/src/theme.js) turns the computed values into a Monaco theme whenever the theme changes.

## 1. How Themes Load

- **Stylesheets.** [`web/src/css/app.css`](../../web/src/css/app.css) lays out and styles the workbench (title bar, activity bar, side bars, connected tabs, panel, status bar, views, menus, quick input, notifications, dialogs) after VS Code 1.142's modern UI, with sizes taken from VS Code's own stylesheets and measured from the running workbench; [`web/src/css/markdown.css`](../../web/src/css/markdown.css) styles the Markdown preview; [`web/src/css/workbench.css`](../../web/src/css/workbench.css) the workbench page. They are imported by the entry modules and bundled into `web/dist/app.css` and `workbench.css`. They contain no theme colours: `app.css`'s `:root` block holds structural tokens (fonts `--ui` / `--mono`, radii, bar heights) and defaults for the optional colour tokens (`--kt: var(--k)`, `--gi: var(--s)`, `--git-modified: var(--mark-active)`, ...).
- **Theme files.** Each theme is [`web/themes/<id>.css`](../../web/themes/), a single rule for `:root[data-theme="<id>"]`. The file name is the theme ID.
- **`/static/themes.css`.** The server joins every `web/themes/*.css` in file-name order once (`sync.Once`) and serves the result. [`web/index.html`](../../web/index.html) and `web/workbench.html` link it before the bundled CSS.
- **Discovery.** `listThemes()` in `theme.js` walks the loaded stylesheets for `[data-theme="<id>"]` rules and reads the display name from `--theme-name` and the scheme from `color-scheme`. There is no list of themes in code.
- **Applying.** `setTheme(id)` sets `data-theme` on `<html>`, emits `theme:changed`, and (when persisting) stores the ID in `localStorage` (`px0.theme`) and posts `workbench.colorTheme` to `/api/settings`, which the workbench page and every workspace read. `initialTheme` prefers a non-default `workbench.colorTheme` from settings, then the browser's saved choice, then `vscode-dark-2026`. An unknown ID falls back to the default.

> [!NOTE]
> Theme rules use `:root[data-theme="<id>"]` rather than a bare `[data-theme="<id>"]`. The `:root` pseudo-class raises specificity above the fallback rules in `app.css`, so theme tokens win regardless of stylesheet order.

## 2. Monaco Themes

`monacoTheme()` in `theme.js` reads the computed tokens (`themeTokens()`), converts each to `#rrggbb` (non-hex values go through a canvas context; `alpha()` adds transparency) and builds a Monaco theme on `vs-dark` or `vs` according to `color-scheme`:

- **Token rules** map Monarch scopes onto px0's syntax tokens: `keyword` → `--k`, `string` → `--s`, `comment` → `--c` (italic), `number` → `--m`, `type` → `--kt`, `type.identifier` / `class` / `namespace` → `--nc`, `function` → `--nf`, `predefined` → `--nb`, `identifier` / `variable` → `--nv`, `constant` → `--no`, `delimiter` → `--p`, `operator` → `--o`, `tag` → `--nt`, `attribute.name` → `--na`, `annotation` → `--nd`, `metatag` → `--cp`, `string.key` / `key` → `--np`, `invalid` → `--err`.
- **Workbench colours** map the surfaces. A theme may set VS Code's editor colours directly (`--editor-bg`, `--editor-fg`, `--line-number-active`, `--gutter-added` / `-modified` / `-deleted`, `--diff-ins-text` / `--diff-del-text` / `--diff-ins-line` / `--diff-del-line`, `--find-match`, `--find-match-hl`, `--word-hl`, `--sel-hl`, `--sel-inactive`, `--bracket-match`, `--indent-guide`, `--indent-guide-active`, `--whitespace`, `--suggest-selected`, `--scrollbar*`); otherwise they are derived: editor background `--bg`, line highlight `--cur`, selection `--sel`, find matches `--mark` / `--mark-active`, cursor `--accent`, line numbers `--faint` / `--fg`, widgets, hovers, peek views, menus and quick input `--bg2` / `--bg3` / `--bg4`, quick-diff gutter `--gi` / `--accent-fg` / `--gd`, diff inserted / removed text `--gi` / `--gd` at 22% and lines `--gi-bg` / `--gd-bg`, markers `--err` / `--mark-active` / `--accent-fg`.

`applyMonacoTheme()` in `monaco.js` defines the theme as `px0` and applies it at boot and on every `theme:changed`, so the theme picker's live preview recolours open editors too.

## 3. Built-in Themes

| Name             | ID                 | Scheme |
| ---------------- | ------------------ | ------ |
| Catppuccin Latte | `catppuccin-latte` | light  |
| Catppuccin Mocha | `catppuccin-mocha` | dark |
| Dark 2026 | `vscode-dark-2026` | dark (default) |
| Light 2026 | `vscode-light-2026` | light |
| Dark Modern | `vscode-dark` | dark |
| Light Modern | `vscode-light` | light |
| Dracula          | `dracula`          | dark   |
| GitHub Dark      | `github-dark`      | dark   |
| Gruvbox Dark     | `gruvbox-dark`     | dark   |
| Gruvbox Light    | `gruvbox-light`    | light  |
| Monokai          | `monokai`          | dark   |
| Nord             | `nord`             | dark   |
| One Dark         | `one-dark`         | dark   |
| Paper            | `light`            | light  |
| Rose Pine        | `rose-pine`        | dark   |
| Solarized Dark   | `solarized-dark`   | dark   |
| Solarized Light  | `solarized-light`  | light  |
| Tokyo Night      | `dark`             | dark   |

## 4. Creating a Custom Theme

1. Copy an existing theme file:
  ```bash
  cp web/themes/dark.css web/themes/midnight.css
  ```
1. Update the selector to match the new ID:
  ```css
  :root[data-theme="midnight"] {
  ```
1. Set the metadata properties:
  ```css
  --theme-name: "Midnight";
  color-scheme: dark;
  ```
1. Define the required colour tokens (see the reference below).
1. Rebuild and run (themes are embedded in the binary):
  ```bash
  make build && ./px0 .
  ```
1. Run the tests:
  ```bash
  go test ./...
  ```
  `TestThemesStylesheetJoinsEveryThemeFile` in [`px0_test.go`](../../px0_test.go) checks that every theme file is joined, its selector ID matches its file name, and it defines every required token.

### Minimal Working Theme

```css
:root[data-theme="midnight"] {
  --theme-name: "Midnight";
  color-scheme: dark;

  --bg: #002b36; --bg2: #00252e; --bg3: #073642; --bg4: #0d4452;
  --fg: #93a1a1; --dim: #839496; --faint: #586e75;
  --line: #0a3b47; --accent: #268bd2; --accent-fg: #2aa198;
  --sel: #0f4b5c; --mark: #4a3f0b; --mark-active: #7a4a12; --cur: #04313c;
  --shadow: 0 16px 48px rgba(0, 0, 0, 0.6);

  --k: #859900; --nf: #268bd2; --s: #2aa198; --m: #d33682; --c: #586e75; --err: #dc322f;
}
```

## 5. Token Reference

### Surfaces

| Token   | Required | Controls |
| ------- | -------- | -------- |
| `--bg`  | Yes | Editor and Monaco background, inputs, the workbench background, the Markdown preview. |
| `--bg2` | Yes | Title bar, activity bar, side bar, tab bar, panel, status bar; menus, notifications, dialogs, Monaco widgets and hovers. |
| `--bg3` | Yes | Hover state of rows, buttons and menu items; keycaps; Monaco suggest and peek title. |
| `--bg4` | Yes | Selected rows, badges, secondary buttons, widget and input borders. |

### Text

| Token              | Required | Fallback    | Controls |
| ------------------ | -------- | ----------- | -------- |
| `--fg`             | Yes      | -           | Primary text; Monaco's default foreground and active line number. |
| `--dim`            | Yes      | -           | Secondary text: inactive tabs, descriptions, folder names beside files, Markdown blockquotes. |
| `--faint`          | Yes      | -           | Line numbers, ignored files, hints, indent guides, scrollbar sliders. |
| `--on-accent`      | No       | `#fff`      | Text on an `--accent` background (primary buttons, badges). |

### Borders, Accents & Selection

| Token           | Required | Controls |
| --------------- | -------- | -------- |
| `--line`        | Yes | Dividers between bars, panes and tabs; Markdown table and code borders. |
| `--accent`      | Yes | Active tab and activity indicators, focus outlines, primary buttons, Monaco's cursor and peek border. |
| `--accent-fg`   | Yes | Links, highlighted match characters in quick input, renamed files, quick-diff "changed" bars. |
| `--sel`         | Yes | Text selection in the page and in Monaco, word and selection highlights. |
| `--mark`        | Yes | Search matches (Search view, Monaco find, peek views). |
| `--mark-active` | Yes | The current find match; warnings; modified files (`--git-modified`). |
| `--cur`         | Yes | Monaco's current line. |
| `--shadow`      | Yes | Floating surfaces: menus, quick input, notifications, dialogs. |

### Syntax

Used by Monaco (through `monacoTheme()`) and by Chroma's short classes in the Markdown preview's code blocks (`.md-code .k`, ...):

| Token   | Role | Required | Fallback |
| ------- | ---- | -------- | -------- |
| `--k`   | Keywords | Yes | - |
| `--kt`  | Types | No | `var(--k)` |
| `--nf`  | Functions | Yes | - |
| `--nc`  | Classes, type names, namespaces | No | `var(--nf)` |
| `--nb`  | Built-ins | No | `var(--nf)` |
| `--nv`  | Variables, identifiers | No | `var(--fg)` |
| `--no`  | Constants | No | `var(--m)` |
| `--na`  | Attribute names | No | `var(--nf)` |
| `--nt`  | Tags | No | `var(--k)` |
| `--nd`  | Annotations, decorators | No | `var(--k)` |
| `--np`  | Keys (JSON keys, properties) | No | `var(--fg)` |
| `--s`   | Strings | Yes | - |
| `--m`   | Numbers | Yes | - |
| `--o`   | Operators | No | `var(--fg)` |
| `--p`   | Punctuation, delimiters | No | `var(--dim)` |
| `--c`   | Comments | Yes | - |
| `--cp`  | Preprocessor, meta tags | No | `var(--k)` |
| `--err` | Errors, invalid tokens, conflicts | Yes | - |

### Git and Diff

| Token | Fallback | Controls |
| ----- | -------- | -------- |
| `--gi` | `var(--s)` | Added and untracked files, quick-diff "added" bars, inserted text in diffs. |
| `--gd` | `var(--err)` | Deleted files, quick-diff "removed" markers, removed text in diffs. |
| `--gi-bg`, `--gd-bg` | `transparent` | Whole-line backgrounds of inserted and removed lines in the diff editor. |
| `--git-modified`, `--git-added`, `--git-untracked`, `--git-deleted`, `--git-conflict`, `--git-renamed` | derived in `app.css` | Explorer, tab and Source Control colours per status. A theme may override them. |

## 6. Markdown Preview and Mermaid

The preview's styles read only the tokens above, so no theme needs preview-specific values. Alerts set a local `--alert` from existing tokens. Mermaid diagrams render inside `.md-mermaid` using `--bg2`, `--bg3`, `--bg4`, `--line` and `--err`; Mermaid itself gets a `base` theme derived from the active px0 theme's `--bg`, `--bg2`, `--bg3`, `--fg`, `--dim` and `--line`. `theme:changed` re-renders open previews so diagrams follow the theme. Repository-supplied SVG is removed by the sanitizer; only SVG generated by the pinned, strict-mode Mermaid runtime reaches `.md-mermaid`.

## Workbench surfaces and file icons

The optional semantic tokens name VS Code's workbench colours, so a theme can match VS Code exactly; `app.css` derives every one of them from the base tokens, so other themes need none:

| Tokens | VS Code colours |
| ------ | --------------- |
| `--shell`, `--card-border`, `--sidebar-bg`, `--panel-bg`, `--editor-bg` | window (title bar, status bar) background, the floating parts' borders and backgrounds |
| `--tab-strip`, `--tab-hover`, `--tab-active-fg`, `--tab-inactive-fg` | connected tab strip, tab hover, tab foregrounds |
| `--active-fg`, `--icon-fg`, `--title-fg`, `--status-fg`, `--status-hover`, `--desc-fg`, `--disabled-fg` | emphasized text, icons, title bar and status bar foregrounds, description and disabled text |
| `--focus`, `--sash`, `--highlight-fg` | focus border, sash hover, matched characters in lists |
| `--list-hover`, `--list-active`, `--list-selection`, `--list-active-fg`, `--toolbar-hover` | list hover, focused and unfocused selection, toolbar button hover |
| `--activity-fg`, `--activity-muted`, `--activity-active-bg`, `--badge-bg`, `--badge-fg` | activity bar icons and active indicator, count badges |
| `--button-*`, `--button2-*` | primary and secondary buttons |
| `--input-bg`, `--input-border`, `--input-placeholder`, `--option-active-bg`, `--option-active-border` | inputs and their toggles (Match Case, ...) |
| `--widget-bg`, `--widget-border`, `--quick-input-bg`, `--qi-focus-bg`, `--qi-focus-fg` | widgets, notifications, dialogs; quick input and its focused row |
| `--menu-bg`, `--menu-border`, `--menu-sep`, `--menu-hover`, `--menu-focus-border` | context and application menus |
| `--kb-bg`, `--kb-border`, `--kb-bottom`, `--kb-fg`, `--kb-shadow` | keybinding key caps |
| `--command-bg`, `--command-border`, `--command-hover-bg`, `--command-hover-border` | the command center |
| `--letterpress`, `--warn`, `--info`, `--error-icon`, `--git-ignored`, `--code-bg`, `--quote-bg`, `--quote-border` | the empty editor's letterpress, problem icons, ignored files, code and quote blocks |

The VS Code themes also set `--line-number`, `--cursor` and `--comment-style`; `theme.js` maps these and the widget/list colours into Monaco.

`web/src/icons.js` resolves VS Code Seti filename, compound extension and language associations from `web/src/gen/seti.js`. The pinned upstream revision is recorded in that file. `web/src/fonts/seti.woff` is bundled into `web/dist/` and embedded with the frontend; the font needs no network access. Light/dark icon colours follow the theme's `color-scheme`. The upstream notice is preserved in `web/vendor/LICENSE.seti`.

The bundler extracts inline font data from generated CSS into content-addressed font assets before compression. This keeps fonts same-origin under the existing Content Security Policy, including workspaces served under a base path.
