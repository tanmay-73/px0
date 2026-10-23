package main

// The integrated terminal: shells running in pseudo-terminals on the server,
// streamed to xterm.js in the browser over a WebSocket, as VS Code's.
//
// A session outlives the WebSocket that shows it: reloading the page
// re-attaches to every running shell and replays its screen (termScreen),
// so a long build, or vim, keeps running across reloads. Sessions end when
// their shell exits, when the user kills them, or when px0 stops.
//
// Output is flow-controlled as in VS Code: the page acknowledges what xterm
// has drawn, and while too much is unacknowledged px0 stops reading the
// terminal, so a program flooding it (yes, cat of a big file) is held back
// by the kernel instead of burying the browser. Ctrl+C still gets through.
//
// bash gets VS Code's shell integration (terminal_bash.sh): OSC 633 marks
// around prompts and commands, from which the page decorates each command
// with its exit status and lets you step between commands.
//
// A terminal runs any command the user types, so px0 offers it only to its
// own page on a loopback address unless started with -terminal (see
// terminalPolicy). Every request is checked like the other machine-changing
// endpoints: POSTs through localPost, the WebSocket by Host and Origin.

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"px0/internal/settings"
)

const (
	termMaxSessions = 32
	termScrollback  = 512 << 10 // bytes of output kept per session for re-attaching
	termMaxPending  = 16 << 20  // output held for one socket before it is dropped, whatever it acknowledges
	termHighWater   = 256 << 10 // unacknowledged bytes before the shell's output is held
	termPing        = 30 * time.Second
)

// termStall: a page over termHighWater that acknowledges nothing for this
// long is dropped (a variable for the tests).
var termStall = 5 * time.Second

//go:embed terminal_bash.sh
var bashIntegration string

// terminalPolicy decides whether this px0 offers terminals. A loopback
// listener can only be reached from this machine; anything wider needs the
// user's explicit -terminal, because a terminal is a shell for whoever can
// reach px0.
func terminalPolicy(host string, force, disable bool) (bool, string) {
	if disable {
		return false, "The terminal is disabled (-no-terminal)."
	}
	if !termSupported {
		return false, "The integrated terminal is not supported on " + runtime.GOOS + " yet."
	}
	if force || isLoopbackHost(host) {
		return true, ""
	}
	return false, "The terminal is off because px0 is listening on " + host + ": anyone who can reach this address could run commands. Start px0 with -terminal to allow it."
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

type termManager struct {
	root    string
	enabled bool
	reason  string

	mu       sync.Mutex
	sessions map[string]*termSession
	seq      int
	closed   bool
}

type termSession struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Title      string    `json:"title"` // the foreground process, as VS Code's tab label
	Cwd        string    `json:"cwd"`   // the shell's working directory, followed as it changes
	Shell      string    `json:"shell"`
	PID        int       `json:"pid"`
	Created    time.Time `json:"created"`
	Integrated bool      `json:"integrated"` // shell integration is loaded

	proc  termProcess
	mgr   *termManager
	input chan []byte   // keystrokes, written by one goroutine in order
	acked chan struct{} // a page acknowledged output
	gone  chan struct{} // closed when the shell has exited
	done  chan struct{} // closed when the session has ended

	mu       sync.Mutex
	cols     int // the terminal's size, so a re-attaching page starts at it
	rows     int
	screen   *termScreen
	clients  map[*termClient]struct{}
	exited   bool
	exitCode int
}

// termClient is an attached socket. Output waiting for it is gathered into
// one buffer, so a program writing many small pieces costs one message per
// send rather than one each. Guarded by the session's mu.
type termClient struct {
	wake    chan struct{}    // something to send
	pending []byte           // output not yet sent
	events  []map[string]any // control messages (info, exit), sent after the output
	closed  bool             // send what is left, then close the socket
	unacked int              // output bytes sent but not yet drawn
	stalled time.Time        // when it went over termHighWater, or zero
}

func (c *termClient) poke() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func newTermManager(root string, enabled bool, reason string) *termManager {
	return &termManager{root: root, enabled: enabled, reason: reason, sessions: map[string]*termSession{}}
}

// shellFor picks the shell: the terminal.integrated.shell setting, then
// $SHELL, then bash or sh.
func shellFor() (string, []string) {
	if v, ok := settings.ReadRawMap()["terminal.integrated.shell"].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v), shellArgs(v)
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		if _, err := exec.LookPath(sh); err == nil {
			return sh, shellArgs(sh)
		}
	}
	for _, sh := range defaultShells {
		if p, err := exec.LookPath(sh); err == nil {
			return p, shellArgs(p)
		}
	}
	return "/bin/sh", nil
}

// shellArgs: macOS terminals start login shells, as VS Code's do there.
func shellArgs(sh string) []string {
	if runtime.GOOS == "darwin" {
		switch filepath.Base(sh) {
		case "bash", "zsh", "sh", "fish", "ksh":
			return []string{"-l"}
		}
	}
	return nil
}

func settingBool(key string, def bool) bool {
	if v, ok := settings.ReadRawMap()[key].(bool); ok {
		return v
	}
	return def
}

func termEnv() []string {
	env := make([]string, 0, len(os.Environ())+5)
	locale := false
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		switch k {
		case "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "PX0_SHELL_LOGIN":
			continue
		case "LANG", "LC_ALL", "LC_CTYPE":
			locale = locale || v != ""
		}
		env = append(env, kv)
	}
	if !locale {
		// Without a UTF-8 locale bash's line editor mangles non-ASCII input.
		env = append(env, "LANG=C.UTF-8")
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=px0", "TERM_PROGRAM_VERSION="+version)
}

// withIntegration starts bash with the shell integration script as its
// init file, fed through a pipe on fd 3 so nothing is written to disk.
func withIntegration(args, env []string) ([]string, []string, *os.File, bool) {
	r, w, err := os.Pipe()
	if err != nil {
		return args, env, nil, false
	}
	_, err = w.WriteString(bashIntegration) // smaller than a pipe's buffer
	w.Close()
	if err != nil {
		r.Close()
		return args, env, nil, false
	}
	rest := []string{}
	for _, a := range args {
		if a == "-l" || a == "--login" {
			env = append(env, "PX0_SHELL_LOGIN=1") // the script reads the login files
			continue
		}
		rest = append(rest, a)
	}
	fd3 := "/dev/fd/3"
	if runtime.GOOS == "linux" {
		fd3 = "/proc/self/fd/3"
	}
	return append([]string{"--init-file", fd3}, rest...), env, r, true
}

func (m *termManager) create(cwd string, cols, rows int, name string) (*termSession, error) {
	if !m.enabled {
		return nil, errors.New(m.reason)
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errors.New("px0 is stopping")
	}
	if len(m.sessions) >= termMaxSessions {
		m.mu.Unlock()
		return nil, fmt.Errorf("too many terminals (at most %d)", termMaxSessions)
	}
	m.seq++
	id := strconv.Itoa(m.seq)
	m.mu.Unlock()

	shell, args := shellFor()
	env := termEnv()
	var extra []*os.File
	integrated := false
	if filepath.Base(shell) == "bash" && settingBool("terminal.integrated.shellIntegration.enabled", true) {
		var script *os.File
		if args, env, script, integrated = withIntegration(args, env); script != nil {
			extra = append(extra, script)
			defer script.Close()
		}
	}
	cols, rows = clampSize(cols, rows)
	proc, err := startTerm(shell, args, cwd, env, cols, rows, extra...)
	if err != nil {
		return nil, fmt.Errorf("could not start %s: %w", shell, err)
	}
	if name == "" {
		name = filepath.Base(shell)
	}
	t := &termSession{
		ID: id, Name: name, Title: filepath.Base(shell), Cwd: cwd, Shell: shell, PID: proc.Pid(), Created: time.Now(), Integrated: integrated,
		proc: proc, mgr: m, input: make(chan []byte, 64), acked: make(chan struct{}, 1), gone: make(chan struct{}), done: make(chan struct{}),
		cols: cols, rows: rows, screen: newTermScreen(termScrollback, cols, rows), clients: map[*termClient]struct{}{},
	}
	m.mu.Lock()
	m.sessions[id] = t
	m.mu.Unlock()
	go t.run()
	go t.writeInput()
	go t.watchInfo()
	return t, nil
}

func clampSize(cols, rows int) (int, int) {
	if cols < 2 || cols > 1000 {
		cols = 80
	}
	if rows < 1 || rows > 500 {
		rows = 24
	}
	return cols, rows
}

func (m *termManager) get(id string) *termSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *termManager) list() []*termSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*termSession, 0, len(m.sessions))
	for _, t := range m.sessions {
		out = append(out, t)
	}
	// Oldest first, the order the tabs were opened in.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Created.Before(out[j-1].Created); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// closeAll ends every shell; px0 is stopping.
func (m *termManager) closeAll() {
	m.mu.Lock()
	m.closed = true
	all := make([]*termSession, 0, len(m.sessions))
	for _, t := range m.sessions {
		all = append(all, t)
	}
	m.mu.Unlock()
	for _, t := range all {
		t.kill()
	}
	for _, t := range all {
		select {
		case <-t.done:
		case <-time.After(2 * time.Second):
		}
	}
}

// run follows the shell until it exits, then ends the session.
func (t *termSession) run() {
	read := make(chan struct{})
	go func() { t.pump(); close(read) }()
	code := t.proc.Wait()
	close(t.gone)
	select {
	case <-read: // the terminal closed with the shell, as usual
	case <-time.After(500 * time.Millisecond):
		// A job left running in the background still holds the terminal;
		// the session ends with its shell all the same.
		t.proc.Close()
		<-read
	}
	t.mu.Lock()
	t.exited, t.exitCode = true, code
	for c := range t.clients {
		c.events = append(c.events, map[string]any{"type": "exit", "code": code})
		t.dropLocked(c)
	}
	t.mu.Unlock()
	t.proc.Close()
	t.mgr.mu.Lock()
	delete(t.mgr.sessions, t.ID)
	t.mgr.mu.Unlock()
	close(t.done)
}

// pump copies the shell's output into the screen and to every attached
// socket.
func (t *termSession) pump() {
	chunk := make([]byte, 32<<10)
	for {
		n, err := t.proc.Read(chunk)
		if n > 0 {
			data := chunk[:n]
			t.mu.Lock()
			t.screen.write(data)
			for c := range t.clients {
				if len(c.pending) > termMaxPending {
					t.dropLocked(c) // it re-attaches and replays
					continue
				}
				c.pending = append(c.pending, data...)
				c.unacked += n
				c.poke()
			}
			t.mu.Unlock()
			t.throttle()
		}
		if err != nil {
			return
		}
	}
}

// throttle stops reading while a page has too much output it has not drawn
// yet. The shell then blocks writing to its terminal, as on a slow real one.
// A page that stops acknowledging altogether is dropped (it re-attaches
// and replays) rather than holding the shell up.
func (t *termSession) throttle() {
	for {
		wait := time.Duration(-1)
		now := time.Now()
		t.mu.Lock()
		for c := range t.clients {
			if c.unacked <= termHighWater {
				c.stalled = time.Time{}
				continue
			}
			if c.stalled.IsZero() {
				c.stalled = now
			}
			if left := termStall - now.Sub(c.stalled); left <= 0 {
				t.dropLocked(c)
			} else if wait < 0 || left < wait {
				wait = left
			}
		}
		t.mu.Unlock()
		if wait < 0 {
			return
		}
		select {
		case <-t.acked:
		case <-time.After(wait):
		case <-t.gone:
			return
		}
	}
}

// ack records that a page has drawn n more bytes.
func (t *termSession) ack(c *termClient, n int) {
	t.mu.Lock()
	c.unacked = max(0, c.unacked-n)
	if c.unacked <= termHighWater {
		c.stalled = time.Time{}
	} else if !c.stalled.IsZero() {
		c.stalled = time.Now() // slow, but drawing
	}
	t.mu.Unlock()
	select {
	case t.acked <- struct{}{}:
	default:
	}
}

// dropLocked detaches a socket: it sends what it has, then closes.
func (t *termSession) dropLocked(c *termClient) {
	delete(t.clients, c)
	c.closed = true
	c.poke()
}

// send queues keystrokes for the shell.
func (t *termSession) send(b []byte) {
	select {
	case t.input <- b:
	case <-t.done:
	}
}

// writeInput writes keystrokes in order, so a shell that is not reading
// (a paste larger than the terminal's buffer) holds up only its own input.
func (t *termSession) writeInput() {
	for {
		select {
		case b := <-t.input:
			_, _ = t.proc.Write(b)
		case <-t.done:
			return
		}
	}
}

// watchInfo reports the foreground process (vim, npm, ...) as the title, and
// the shell's working directory.
func (t *termSession) watchInfo() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-t.done:
			return
		case <-tick.C:
		}
		title, cwd := t.proc.Foreground(), t.proc.Cwd()
		t.mu.Lock()
		changed := false
		if title != "" && title != t.Title {
			t.Title, changed = title, true
		}
		if cwd != "" && cwd != t.Cwd {
			t.Cwd, changed = cwd, true
		}
		if changed {
			for c := range t.clients {
				c.events = append(c.events, t.infoLocked())
				c.poke()
			}
		}
		t.mu.Unlock()
	}
}

func (t *termSession) infoLocked() map[string]any {
	return map[string]any{"type": "info", "title": t.Title, "cwd": t.Cwd}
}

// attach subscribes a socket to the output and returns what to replay
// first, and whether a full-screen program is running (it is asked to
// repaint once the replay is sent).
func (t *termSession) attach() (*termClient, []termReplay, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.exited {
		return nil, nil, false
	}
	replay := t.screen.replay()
	// The replay is acknowledged like any other output.
	c := &termClient{wake: make(chan struct{}, 1)}
	for _, p := range replay {
		c.unacked += len(p.data)
	}
	t.clients[c] = struct{}{}
	return c, replay, t.screen.alt
}

func (t *termSession) detach(c *termClient) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dropLocked(c)
}

// redraw makes the full-screen program running repaint everything. A
// SIGWINCH alone is not enough: curses programs (htop, less) then repaint
// only what they believe changed, and the kernel sends none for an unchanged
// size anyway. So the terminal is made a row shorter for a moment, as tmux
// does on re-attaching.
func (t *termSession) redraw() {
	t.mu.Lock()
	cols, rows := t.cols, t.rows
	t.mu.Unlock()
	nudge := rows - 1
	if nudge < 1 {
		nudge = rows + 1
	}
	t.proc.Resize(cols, nudge)
	time.AfterFunc(100*time.Millisecond, func() {
		t.mu.Lock()
		cols, rows := t.cols, t.rows // a resize may have come meanwhile
		t.mu.Unlock()
		t.proc.Resize(cols, rows)
	})
}

func (t *termSession) kill() { t.proc.Kill() }

func (t *termSession) snapshot() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{"id": t.ID, "name": t.Name, "title": t.Title, "cwd": t.Cwd, "shell": t.Shell, "pid": t.PID, "cols": t.cols, "rows": t.rows, "integrated": t.Integrated}
}

/* ---------- HTTP ---------- */

func (s *Server) handleTerminalList(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, t := range s.terms.list() {
		out = append(out, t.snapshot())
	}
	writeJSON(w, map[string]any{"enabled": s.terms.enabled, "reason": s.terms.reason, "terminals": out})
}

func (s *Server) handleTerminalNew(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req struct {
		Cwd  string `json:"cwd"`
		From string `json:"from"` // a terminal whose working directory to start in (Split Terminal)
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "bad request")
		return
	}
	cwd := s.ix.Root()
	if req.Cwd != "" && req.Cwd != "." {
		abs, _, ok := s.safePath(req.Cwd)
		if !ok {
			fail(w, http.StatusBadRequest, "bad path")
			return
		}
		if st, err := os.Stat(abs); err != nil || !st.IsDir() {
			abs = filepath.Dir(abs)
		}
		cwd = abs
	} else if src := s.terms.get(req.From); src != nil {
		dir := src.proc.Cwd() // now, not as last polled: a cd may have just run
		if dir == "" {
			src.mu.Lock()
			dir = src.Cwd
			src.mu.Unlock()
		}
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			cwd = dir
		}
	}
	t, err := s.terms.create(cwd, req.Cols, req.Rows, strings.TrimSpace(req.Name))
	if err != nil {
		fail(w, http.StatusForbidden, err.Error())
		return
	}
	writeJSON(w, t.snapshot())
}

func (s *Server) handleTerminalKill(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if t := s.terms.get(req.ID); t != nil {
		t.kill()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleTerminalRename(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	t := s.terms.get(req.ID)
	if t == nil {
		fail(w, http.StatusNotFound, "no such terminal")
		return
	}
	t.mu.Lock()
	t.Name = strings.TrimSpace(req.Name)
	t.mu.Unlock()
	writeJSON(w, t.snapshot())
}

// terminalSocketAllowed admits the WebSocket only from px0's own page: the
// Host must be an IP address or localhost (no DNS rebinding) and the Origin
// must be that same host (no other site's page).
func terminalSocketAllowed(r *http.Request) bool {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host != "localhost" && net.ParseIP(host) == nil {
		return false
	}
	o, err := url.Parse(r.Header.Get("Origin"))
	return err == nil && o.Host == r.Host
}

func (s *Server) handleTerminalSocket(w http.ResponseWriter, r *http.Request) {
	if !terminalSocketAllowed(r) {
		fail(w, http.StatusForbidden, "request did not come from px0")
		return
	}
	t := s.terms.get(r.URL.Query().Get("id"))
	if t == nil {
		fail(w, http.StatusNotFound, "no such terminal")
		return
	}
	bypassGzip(w)
	c, err := websocket.Accept(w, r, nil) // checks the Origin against the Host too
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(4 << 20) // a large paste arrives as one message

	cl, replay, alt := t.attach()
	if cl == nil {
		c.Close(websocket.StatusNormalClosure, "exited")
		return
	}
	defer t.detach(cl)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Browser to shell: keystrokes as binary messages; resizes and
	// acknowledgements as JSON.
	go func() {
		defer cancel()
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				t.send(data)
				continue
			}
			var msg struct {
				Type  string `json:"type"`
				Data  string `json:"data"`
				Cols  int    `json:"cols"`
				Rows  int    `json:"rows"`
				Bytes int    `json:"bytes"`
			}
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch msg.Type {
			case "input":
				t.send([]byte(msg.Data))
			case "ack":
				t.ack(cl, msg.Bytes)
			case "resize":
				cols, rows := clampSize(msg.Cols, msg.Rows)
				t.mu.Lock()
				t.cols, t.rows = cols, rows
				t.screen.resize(cols, rows)
				t.mu.Unlock()
				t.proc.Resize(cols, rows)
			}
		}
	}()

	// Keep the connection alive through proxies, and notice a page that
	// went away without closing it.
	go func() {
		tick := time.NewTicker(termPing)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				pctx, pcancel := context.WithTimeout(ctx, termPing)
				err := c.Ping(pctx)
				pcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	// Shell to browser.
	write := func(typ websocket.MessageType, b []byte) error {
		wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
		defer wcancel()
		return c.Write(wctx, typ, b)
	}
	writeEvent := func(ev map[string]any) error {
		b, _ := json.Marshal(ev)
		return write(websocket.MessageText, b)
	}
	// The replay: each part after the size it was drawn at; then the page
	// fits the terminal to its panel and sends the size it ends up with.
	for _, p := range replay {
		if writeEvent(map[string]any{"type": "size", "cols": p.cols, "rows": p.rows}) != nil {
			return
		}
		if len(p.data) > 0 && write(websocket.MessageBinary, p.data) != nil {
			return
		}
	}
	t.mu.Lock()
	info := t.infoLocked()
	t.mu.Unlock()
	if writeEvent(map[string]any{"type": "replayed"}) != nil || writeEvent(info) != nil {
		return
	}
	if alt {
		t.redraw() // the replay left the alternate screen blank
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-cl.wake:
		}
		t.mu.Lock()
		data, events, closed := cl.pending, cl.events, cl.closed
		cl.pending, cl.events = nil, nil
		t.mu.Unlock()
		if len(data) > 0 && write(websocket.MessageBinary, data) != nil {
			return
		}
		for _, ev := range events {
			if writeEvent(ev) != nil {
				return
			}
		}
		if closed {
			// Dropped for falling behind, or the shell exited (its exit
			// message went last).
			c.Close(websocket.StatusNormalClosure, "")
			return
		}
	}
}
