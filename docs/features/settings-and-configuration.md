# Settings & Configuration

px0 keeps one per-user settings file, `~/.px0/settings.json` (or `$XDG_CONFIG_HOME/px0/settings.json`), outside every repository. Changes apply at once to every open editor, without a reload.

---

## Opening settings

- **Settings editor**: `Ctrl/Cmd+,`, **File > Settings**, the **Manage** gear at the bottom of the activity bar, or **Preferences: Open Settings (UI)**. It is a searchable form, grouped by category, with a table of contents on the left. Each setting shows its key; a changed setting is marked as modified. Token settings are masked.
- **settings.json**: **Open Settings (JSON)** in the Settings editor, **Manage > Open Settings (JSON)**, or **Preferences: Open User Settings (JSON)**. It opens in Monaco; `Ctrl/Cmd+S` saves it.

## Settings the editor uses

| Key | Default | Values | Effect |
| :--- | :--- | :--- | :--- |
| `editor.fontSize` | `14` | 6–32 | Editor font size (px) |
| `editor.fontFamily` | `""` (VS Code's platform default: Menlo, Consolas or Droid Sans Mono) | CSS font list | Editor font |
| `editor.fontLigatures` | `false` | boolean | Font ligatures |
| `editor.lineHeight` | `0` (from the font size) | 0–48 | Line height (px) |
| `editor.tabSize` | `4` | `2`, `4`, `8` | Tab width |
| `editor.insertSpaces` | `true` | boolean | Insert spaces when pressing Tab |
| `editor.detectIndentation` | `true` | boolean | Take tab size and spaces from the file's content |
| `editor.wordWrap` | `"on"` | `"on"`, `"off"` | Soft wrap (`Alt+Z` toggles it) |
| `editor.lineNumbers` | `"on"` | `"on"`, `"off"` | Line numbers |
| `editor.renderWhitespace` | `"selection"` | `none`, `boundary`, `selection`, `all` | Show whitespace |
| `editor.minimap.enabled` | `true` | boolean | Minimap |
| `editor.rulers` | `[]` | array of columns | Vertical rulers (settings.json only) |
| `editor.cursorStyle` | `"line"` | `line`, `block`, `underline` | Cursor shape |
| `editor.cursorBlinking` | `"smooth"` | `blink`, `smooth`, `solid` | Cursor animation |
| `editor.renderLineHighlight` | `"line"` | `line`, `none` | Highlight the current line |
| `editor.scrollBeyondLastLine` | `true` | boolean | Scroll past the end of the file |
| `editor.smoothScrolling` | `true` | boolean | Animated scrolling (settings.json only) |
| `editor.mouseWheelZoom` | `false` | boolean | `Ctrl/Cmd`+wheel changes the font size (settings.json only) |
| `editor.bracketPairColorization.enabled` | `true` | boolean | Colour matching brackets |
| `editor.stickyScroll.enabled` | `true` | boolean | Keep enclosing scopes at the top while scrolling |
| `files.autoSave` | `"off"` | `off`, `afterDelay`, `onFocusChange` | Save dirty files automatically |
| `files.autoSaveDelay` | `1000` | milliseconds | Delay for `afterDelay` |
| `files.trimTrailingWhitespace` | `false` | boolean | Trim trailing whitespace on save |
| `files.insertFinalNewline` | `false` | boolean | End the file with a newline on save |
| `explorer.autoReveal` | `true` | boolean | Reveal the active file in the explorer |
| `diffEditor.renderSideBySide` | `true` | boolean | Side-by-side (`true`) or inline diffs |
| `diffEditor.ignoreTrimWhitespace` | `true` | boolean | Ignore leading and trailing whitespace in diffs |
| `diffEditor.hideUnchangedRegions.enabled` | `false` | boolean | Collapse unchanged regions in diffs |
| `terminal.integrated.shell`, `.fontSize`, `.fontFamily`, `.fontWeight`, `.fontWeightBold`, `.letterSpacing`, `.lineHeight`, `.cursorStyle`, `.cursorBlinking`, `.scrollback`, `.minimumContrastRatio`, `.gpuAcceleration`, `.shellIntegration.enabled`, `.shellIntegration.decorationsEnabled`, `.copyOnSelection`, `.altClickMovesCursor`, `.sendKeybindingsToShell`, `.enableBell` | see [Integrated Terminal](terminal.md#settings) | | The integrated terminal |
| `workbench.colorTheme` | `"vscode-dark-2026"` | a theme ID | Color theme (see [Themes](themes-and-styling.md)) |

The `editor.*` and `diffEditor.*` keys are passed to Monaco as its options of the same name.

**File > Auto Save** toggles `files.autoSave` between `off` and `afterDelay`. The checkmark also appears when `onFocusChange` is selected in Settings. Both controls update the same persistent preference. `afterDelay` waits for the last edit in each file; `onFocusChange` saves when leaving an editor, switching editors, or leaving the window. Changing the delay reschedules pending saves; disabling Auto Save cancels them. A request already sent to the server can still finish.

## Forge tokens and server

| Key | Effect |
| :--- | :--- |
| `github.token` | GitHub token for pull request review; takes precedence over `GITHUB_TOKEN` and `gh auth token`. |
| `gitlab.token`, `gitlab.host` | GitLab token (`api` scope) and the instance it belongs to (falls back to `GITLAB_HOST`, then gitlab.com). The token is sent only to that host. |
| `gitea.token`, `gitea.host` | Gitea / Forgejo / Codeberg token and its instance (falls back to `GITEA_HOST`, then codeberg.org). |
| `bitbucket.token`, `bitbucket.email` | Bitbucket Cloud access token, or an Atlassian API token with its account email. |
| `server.basePath` | URL path prefix to serve px0 under (e.g. `"/rev-123/"`); the `-base-path` flag overrides it. |

The forge host settings are filled in automatically when you connect a token from a pull request review. See [Getting Started with PR Review](pr-review-getting-started.md#2-connect-your-forge).

## Settings listed but not used by the current editor

The server's schema still lists a few settings from px0's earlier editor. They are saved if you change them but have no effect: `markdown.preview.open`, `table.preview.open`, `editor.occurrencesHighlight`, `editor.bracketPairColorization` (use `editor.bracketPairColorization.enabled`), `explorer.compactFolders`, `files.exclude`, `search.smartCase`, `search.maxResults`, `git.gutterIndicators`, `lsp.enabled` and `lsp.hover.enabled`. To run without language servers or git, use the `-no-lsp` and `-no-git` flags.

## Example

```json
{
  "editor.fontSize": 14,
  "editor.fontFamily": "\"JetBrains Mono\", monospace",
  "editor.wordWrap": "off",
  "editor.rulers": [100],
  "files.autoSave": "afterDelay",
  "files.trimTrailingWhitespace": true,
  "workbench.colorTheme": "dark",
  "diffEditor.renderSideBySide": true
}
```

## What else px0 remembers

Per browser, not in settings.json: the layout (side bar and panel size and visibility, the last view), open tabs per workspace, expanded folders, Search toggles, the draft commit message, recent files and commands, and the last theme.
