# Integrated Terminal

px0 has VS Code's integrated terminal: real shells running on the machine px0 runs on, in the **Terminal** panel, drawn by [xterm.js](https://xtermjs.org/) (the terminal VS Code uses).

---

## Opening terminals

| Action | How |
| :--- | :--- |
| Toggle the terminal | `` Ctrl+` `` (on macOS too), **View > Terminal**, or the **Terminal** tab of the panel. Opening the panel with no terminal starts one; pressing the key again while the terminal has focus hides the panel. |
| New terminal | `` Ctrl+Shift+` ``, the **+** button in the panel title, or **Terminal > New Terminal** in the application menu |
| Split terminal | `Ctrl+Shift+5` (`Cmd+\` on macOS while the terminal has focus), the split button, or **Split Terminal** in a terminal's context menu |
| Terminal in a folder | **Open in Integrated Terminal** in the Explorer's context menu |
| Kill a terminal | The trash button, **Kill Terminal** in the context menu or **…** menu, or exit the shell |

A new terminal starts in the workspace root with your shell: the **Terminal: Shell** setting, else `$SHELL`, else bash, zsh or sh. A split starts in the directory its neighbour's shell is in now (after any `cd`). On macOS it is a login shell, as in VS Code. The shell sees `TERM=xterm-256color`, `COLORTERM=truecolor` and `TERM_PROGRAM=px0`, and `LANG=C.UTF-8` when no locale is set, so bash edits non-ASCII text correctly.

## Shell integration (bash)

bash terminals load VS Code's shell integration. px0 feeds bash a small startup script (through a pipe, so nothing is written to disk). The script runs your usual `~/.bashrc` first, then marks each prompt and command. With it:

- **Command decorations.** A circle in the gutter beside each command's prompt: hollow while it runs, blue when it succeeded, a red ✕ when it failed. Hover for the exit code; click for **Rerun Command**, **Copy Command** and **Copy Output**. The same marks appear beside the scrollbar.
- **Step between commands** with `Ctrl+Up` / `Ctrl+Down` (`Cmd` on macOS).
- **The working directory is followed**, for splits, the tab's tooltip, and links relative to where you `cd`'d.
- `Ctrl+Left` / `Ctrl+Right` move by word even where the distribution ships no `/etc/inputrc` (Alpine, the Docker image), unless your inputrc binds them.

It keeps your own `PROMPT_COMMAND` (string or array) and `DEBUG` trap, and re-marks `PS1` when a prompt framework rebuilds it. Turn it off with **Terminal: Shell Integration** (`terminal.integrated.shellIntegration.enabled`); other shells run without it.

## Terminals, splits and tabs

Terminals live in groups. A group shows its terminals side by side; drag the line between two to resize them. With more than one terminal, the tabs list appears on the right of the panel: one row per terminal, split terminals joined by `┌ ├ └`, with Split and Kill on hover. Click a row to switch, double-click it (or **Rename...**) to name it. A terminal's label is its foreground process (`bash`, `vim`, `npm`, ...) until you rename it.

When a shell exits cleanly its terminal closes. If it fails, the terminal stays and says how it ended (*The terminal process "/bin/bash" terminated with exit code: 1.*); press any key to close it.

## Reloads keep your shells

A terminal belongs to the px0 server, not the page. Reloading the page, or opening the workspace in another tab, re-attaches to every running shell and keeps the split layout. The screen comes back as it was:

- **Recent output** (the last 512 KB) is replayed at the sizes it was drawn at, so prompts that bash redrew while you resized the panel come back clean.
- **A full-screen program** (vim, less, man, htop, nano) that is still running is redrawn. What it drew earlier is left out of the replay, so it doesn't push your shell history out.
- **Terminal modes are restored**, including mouse reporting, bracketed paste, application cursor keys and a hidden cursor.

Shells end when you kill them, when they exit (even if a background job still holds the terminal), or when px0 stops. Under the [workbench](workbench.md), an open terminal keeps its workspace from being stopped as idle.

## Heavy output

The page acknowledges output once xterm has drawn it, and px0 stops reading from a shell whose page is far behind. A program flooding the terminal (`yes`, `cat` of a large log, `seq 1 10000000`) is then held back by the kernel instead of freezing the browser, and `Ctrl+C` still stops it at once. Output is drawn with WebGL (**GPU Acceleration**), falling back to the DOM renderer when WebGL is unavailable. While the browser tab is in the background its output is kept. If more than a few megabytes pile up, the screen is replayed from px0 when you come back instead.

## Keys

While a terminal has focus, keys go to the shell, as in VS Code: `Ctrl+R`, `Ctrl+K`, `Ctrl+E`, `Ctrl+B`, `Ctrl+U` and the rest do what the shell does. A few workbench shortcuts still work: Go to File (`Ctrl/Cmd+P`), the Command Palette (`Ctrl/Cmd+Shift+P`, `F1`), Toggle Panel (`Ctrl/Cmd+J`), Show Explorer / Search / Source Control / Problems, Settings, and the terminal commands themselves. Turn on **Send Keybindings To Shell** to give the shell those too, `Ctrl+P` included (Toggle Terminal, New / Split Terminal and the Command Palette stay).

The browser keeps `Ctrl+W`, `Ctrl+T` and `Ctrl+N` for itself and a page cannot stop that. If `Ctrl+W` is pressed in a terminal, px0 asks before the tab closes; use `Ctrl+Backspace` to delete a word.

| Keys | Action |
| :--- | :--- |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` (`Cmd+C` / `Cmd+V` on macOS) | Copy the selection / paste |
| `Ctrl/Cmd+F` | Find in the terminal (Match Case, Whole Word, Regular Expression; `Enter` / `Shift+Enter` for next / previous) |
| `Ctrl+Backspace` / `Ctrl+Delete` (`Alt` on macOS) | Delete the word before / after the cursor |
| `Ctrl+Up` / `Ctrl+Down` | Scroll to the previous / next command (shell integration); without it, one line |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down`, `Shift+PageUp` / `Shift+PageDown` | Scroll by line / page |
| `Ctrl+Home` / `Ctrl+End` | Scroll to the top / bottom |
| `Cmd+K` (macOS) | Clear the terminal |
| `Ctrl/Cmd+click` | Open a link: URLs in the browser, `path/to/file.go:12:3` in the editor (relative to the terminal's directory), and hyperlinks programs print (`ls --hyperlink`, compiler messages) |

Right-click a terminal for Copy, Paste, Select All, Clear, Split, Rename and Kill. Programs can copy to the clipboard too (OSC 52, as vim and tmux do), but they can't read it. When px0 is opened over plain `http://` on another address, the browser blocks the **Paste** menu item; keyboard paste still works.

## Settings

| Setting | Default | |
| :--- | :--- | :--- |
| `terminal.integrated.shell` | `""` | The shell to run; empty for `$SHELL`, then bash, zsh or sh |
| `terminal.integrated.fontSize` | `14` | Font size (px) |
| `terminal.integrated.fontFamily` | `""` | Font; empty for the editor's font |
| `terminal.integrated.lineHeight` | `1` | Line height, times the font size |
| `terminal.integrated.cursorStyle` | `block` | `block`, `line` or `underline` |
| `terminal.integrated.cursorBlinking` | `false` | Blink the cursor |
| `terminal.integrated.scrollback` | `1000` | Lines kept in the terminal's buffer |
| `terminal.integrated.fontWeight` / `fontWeightBold` | `normal` / `bold` | Font weights |
| `terminal.integrated.letterSpacing` | `0` | Extra pixels between characters |
| `terminal.integrated.minimumContrastRatio` | `4.5` | Adjusts text colours to this contrast with their background, as VS Code does (`1` to keep colours as they are) |
| `terminal.integrated.gpuAcceleration` | `auto` | Draw with WebGL: `auto` (falling back to the DOM renderer), `on`, `off` |
| `terminal.integrated.shellIntegration.enabled` | `true` | Load shell integration into bash (new terminals) |
| `terminal.integrated.shellIntegration.decorationsEnabled` | `both` | Command status in the `gutter`, the `overviewRuler`, `both` or `never` |
| `terminal.integrated.copyOnSelection` | `false` | Copy selected text to the clipboard |
| `terminal.integrated.altClickMovesCursor` | `true` | `Alt+click` moves the shell's cursor there |
| `terminal.integrated.sendKeybindingsToShell` | `false` | Send almost every key to the shell |
| `terminal.integrated.enableBell` | `false` | Show a bell on the tab when a program rings |

Colours follow the theme: the panel background, the theme's text colour, and VS Code's default ANSI palette for dark or light themes (a theme can set its own with `--ansi-red`, `--ansi-bright-red`, ...).

## When the terminal is off

A terminal runs any command, as you, for whoever can reach px0. So px0 offers it only when it listens on a loopback address (`127.0.0.1`, `localhost`, the default):

- With `-host 0.0.0.0` or any other address, the terminal is off and the panel says why. Start px0 with **`-terminal`** to allow it anyway (px0 prints a warning); do that only on a network you trust, or behind an authenticating proxy.
- **`-no-terminal`** turns it off everywhere.
- The workbench passes its own address and these flags on to every workspace it starts.
- In the Docker image px0 listens on `0.0.0.0`, so the terminal is off unless you add `-terminal` to the command (see `compose.yaml`). The image includes bash.
- Windows is not supported yet (the panel says so).

Every terminal request is checked like px0's other machine-changing requests: it must come from px0's own page (the `Origin` matches the `Host`), and the `Host` must be an IP address or `localhost`, which stops DNS-rebinding attacks.
