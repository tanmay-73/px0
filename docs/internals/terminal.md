# Integrated Terminal

The terminal panel (`web/src/terminal.js`) draws shells that run on the server in pseudo-terminals (`terminal.go`, `terminal_unix.go`), connected by one WebSocket per terminal. `terminal_screen.go` keeps what a re-attaching page needs; `terminal_bash.sh` is bash's shell integration.

## 1. Server

- **Policy.** `terminalPolicy(host, force, disable)` turns terminals on for a loopback listener, or for any listener with `-terminal`; `-no-terminal` and unsupported platforms (Windows: no ConPTY yet, `terminal_windows.go`) turn them off. `main.go` applies it with `Server.SetTerminalPolicy`; a workbench passes `-terminal-host <its address>` (and `-terminal` / `-no-terminal`) to its children, which listen on loopback themselves. `NewServer` starts with terminals off.
- **Sessions.** `termManager` holds up to 32 `termSession`s keyed by a counter ID. `startTerm` runs the shell with `creack/pty` (pure Go, no CGO), which gives it its own session and the pty as controlling terminal. pty leaves the master descriptor blocking, so `startTerm` swaps it for a non-blocking duplicate served by Go's poller: `Close` then interrupts a pending `Read`, and ioctls (`TIOCSWINSZ`, `TIOCGPGRP`) go through `SyscallConn` so the descriptor never turns blocking again. `shellFor` picks `terminal.integrated.shell`, `$SHELL`, then bash / zsh / sh; macOS shells get `-l`. The environment gains `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=px0`, and `LANG=C.UTF-8` when no locale variable is set.
- **Shell integration.** For bash (unless `terminal.integrated.shellIntegration.enabled` is false), `withIntegration` writes the embedded `terminal_bash.sh` into a pipe passed as fd 3 and runs `bash --init-file /proc/self/fd/3`. A login shell is imitated with `PX0_SHELL_LOGIN=1`, because `--init-file` excludes `-l`. The script closes fd 3, sources `~/.bashrc` (or the login files), and then hooks `PROMPT_COMMAND` and the `DEBUG` trap, chaining the user's own, to write VS Code's OSC 633 marks:
  - `A` / `B` around the prompt (`PS1` is re-marked whenever a framework rebuilds it)
  - `E;<command line>`, then `C`, before a command
  - `D;<exit code>` after it (`D` alone for an empty line)
  - `P;Cwd=<dir>`

  Values escape `\`, `;` and control characters as `\\`, `\x3b` and `\xNN`.
- **Running.** `run` waits for the shell. When it exits, the pump has 500 ms to drain; after that the pty is closed even if a background job still holds the slave open, so the session ends with its shell. Then every socket gets `{"type":"exit","code":n}` (128+signal for a signalled shell) and the session is removed.
- **Output and flow control.** `pump` reads the pty in 32 KB chunks and passes each through the session's `termScreen`. It appends the chunk to every attached `termClient`'s pending buffer, so many small writes become one message, and wakes that socket's writer. Each client counts bytes sent but not yet acknowledged; the page acknowledges them (`{"type":"ack","bytes"}`) once xterm has parsed them. While any client has more than 256 KB outstanding, `throttle` stops reading, the pty's kernel buffer fills, and the program blocks writing, as on a slow terminal (`Ctrl+C` is input, so it still gets through). A client over the mark that acknowledges nothing for `termStall` (5 s) is dropped, as is one with 16 MB pending; its page reconnects and replays.
- **Input.** Binary frames are keystrokes; `writeInput` writes them to the pty in order from one goroutine, so a shell that is not reading (a paste bigger than the tty buffer) blocks only its own input, not resizes.
- **Screen (`termScreen`).** It tokenizes the output, without emulating a terminal, to keep:
  - **The output drawn on the normal screen.** Alternate-screen sections (`CSI ? 1049/1047/47 h … l`) are cut out; output before a full reset (`ESC c`) or a scrollback erase (`CSI 3 J`) is dropped. The buffer is cut back to 512 KB, at a line start, whenever it reaches twice that.
  - **The DEC private modes worth restoring**, followed through the whole stream: cursor keys, autowrap, cursor visibility, mouse modes 1000–1015, focus events and bracketed paste, plus the keypad mode.
  - **The terminal size at each offset**, recorded on every resize, because bash redraws its prompt for the size it had.

  `replay()` returns the kept output in parts with the size each was drawn at. The last part ends with `CSI ? 1049 h` (if a full-screen program is still running) and the modes. An escape sequence or UTF-8 character the output stops partway through goes after them, so the live stream completes it.
- **Re-attaching.** The socket sends each replay part as `{"type":"size","cols","rows"}` followed by its bytes, then `{"type":"replayed"}` and `{"type":"info"}`. If a full-screen program is running, `redraw` shortens the terminal by a row for 100 ms. That makes even curses programs, which repaint only what changed on a plain `SIGWINCH`, repaint everything.
- **Info.** `watchInfo` polls once a second for the foreground process (Linux: `TIOCGPGRP` on the master, then `/proc/<pgrp>/comm`) and the shell's directory (`/proc/<pid>/cwd`). It sends `{"type":"info","title","cwd"}` when either changes. `POST /api/terminal/new` with `from` reads that terminal's directory right away.
- **Keepalive.** The server pings every socket every 30 s, which keeps proxies from closing idle connections and detects pages that vanished.
- **Kill.** `SIGHUP` to the process group, then `SIGKILL` after 2 s. `Server.CloseTerminals` ends every shell when px0 stops.

### Endpoints

| Endpoint | |
| :--- | :--- |
| `GET /api/terminal/list` | `{enabled, reason, terminals: [{id, name, title, cwd, shell, pid, cols, rows, integrated}]}` |
| `POST /api/terminal/new` | `{cwd, from, cols, rows, name}` → the new session; `cwd` is workspace-relative (`safePath`), `from` starts in another terminal's current directory |
| `POST /api/terminal/kill`, `/rename` | `{id}`, `{id, name}` |
| `GET /api/terminal/ws?id=` | WebSocket (`coder/websocket`). Page to server: binary frames are keystrokes; text frames are `{"type":"resize","cols","rows"}`, `{"type":"ack","bytes"}` (and `{"type":"input","data"}`). Server to page: binary frames are output; text frames are `size` / `replayed` (the replay), `info` and `exit` |

POSTs go through `localPost`; the WebSocket through `terminalSocketAllowed` (Host is an IP or `localhost`, Origin host equals Host) and then `websocket.Accept`'s own origin check. `ServeHTTP` skips gzip for upgrade requests. The workbench's `httputil.ReverseProxy` forwards the upgrade, and an open socket counts as activity, so a workspace with a connected terminal is not stopped as idle.

## 2. Browser

- **Instances and groups.** `newTerminal({cwd, split})` posts `/api/terminal/new` with the size the new pane will have. `estimateSize` measures a character cell the way xterm does and allows for the tabs list appearing, so the shell starts at its real size and draws its first prompt only once. A split passes `from`, the terminal it splits. The instance goes into a new group or the active one. An instance owns:
  - an xterm `Terminal` with the fit, search, web-links, unicode11 and WebGL addons (WebGL per `terminal.integrated.gpuAcceleration`, dropped on context loss)
  - a file-link provider, an OSC 8 link handler, an OSC 52 handler (it writes the clipboard but never reads it), and an OSC 633 handler
  - its socket
- **Connection.** `connect` opens the socket and resets the screen on open, then marks the instance `replaying`. Each `size` message resizes xterm once everything before it has been parsed (`term.write('', callback)`). During the replay, fits and resize messages are held back. On `replayed` the instance fits to its pane and sends the size it ended with. Output is acknowledged in batches (32 KB or 16 ms) from xterm's write callbacks. While the document is hidden, output is acknowledged on arrival and held; past 8 MB it is dropped, and the socket is reopened for a fresh replay when the page is shown. A socket that closes without an exit message reconnects with backoff; after repeated failures `checkGone` asks `/api/terminal/list` and closes the terminal if the server no longer has it.
- **Shell integration.** `shellIntegration` turns OSC 633 marks into commands: an xterm marker at the prompt (`A`) and at the start of the output (`C`), plus the command line (`E`) and exit code (`D`). A decoration on the prompt marker draws the gutter circle (`codicon-circle-outline` / `primitive-dot` / `error-small` in VS Code's `terminalCommandDecoration.*` colours) and the overview-ruler mark; clicking it opens `commandMenu` (Rerun, Copy Command, Copy Output, read from the buffer between the markers). Decorations are hidden while the alternate buffer is active. `scrollToCommand` uses the prompt markers. `P;Cwd=` updates the instance's directory at once.
- **Reloads.** On boot `initTerminal` loads `/api/terminal/list` and re-creates every session, arranged by the group layout saved in `localStorage` (`px0.terminal.groups:<root>`).
- **Panel.** `registerPanel({ id: 'terminal', widget, actions, onShow })`: the title shows the terminal's name while there is one terminal, then **+**, split, kill and **…**; the tabs list (right, resizable) appears with two or more. `onShow` starts a terminal when there is none, unless `showTerminal` is about to.
- **Keys.** `commands.js` treats a focused `.terminal-instance` as the shell's: only commands marked `terminal: true` (or listing the key in `terminal: [...]`) run, narrowed by `setTerminalKeyFilter` when `terminal.integrated.sendKeybindingsToShell` is on. xterm's custom key handler takes:
  - copy, paste and Find
  - `Ctrl+Backspace` / `Ctrl+Delete`, sent as `\x17` / `\x1bd` as VS Code does
  - command and line scrolling (normal buffer only)
  - macOS `Cmd+K`; other `Cmd` keys pass to the browser

  A `beforeunload` guard asks before the tab closes when `Ctrl`/`Cmd` was held in a terminal (`Ctrl+W`).
- **Look.** `xtermTheme()` reads the theme tokens (`--term-bg` / `--panel-bg`, `--term-fg` / `--fg`, `--sel`, scrollbar tokens, optional `--ansi-*`) and VS Code's default ANSI palette; `theme:changed` and `settings:changed` update open terminals.
