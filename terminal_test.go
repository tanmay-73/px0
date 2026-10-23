package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestTerminalPolicy(t *testing.T) {
	cases := []struct {
		host           string
		force, disable bool
		want           bool
	}{
		{"127.0.0.1", false, false, true},
		{"localhost", false, false, true},
		{"::1", false, false, true},
		{"0.0.0.0", false, false, false},
		{"10.20.7.180", false, false, false},
		{"0.0.0.0", true, false, true},
		{"127.0.0.1", false, true, false},
		{"0.0.0.0", true, true, false},
	}
	for _, c := range cases {
		got, reason := terminalPolicy(c.host, c.force, c.disable)
		if !termSupported {
			if got {
				t.Errorf("%s: enabled on an unsupported platform", c.host)
			}
			continue
		}
		if got != c.want {
			t.Errorf("terminalPolicy(%q, force=%v, disable=%v) = %v (%s), want %v", c.host, c.force, c.disable, got, reason, c.want)
		}
		if !got && reason == "" {
			t.Errorf("%s: disabled without a reason", c.host)
		}
	}
}

func TestTerminalSocketAllowed(t *testing.T) {
	cases := []struct {
		host, origin string
		want         bool
	}{
		{"127.0.0.1:7777", "http://127.0.0.1:7777", true},
		{"localhost:7777", "http://localhost:7777", true},
		{"127.0.0.1:7777", "http://evil.example", false},
		{"127.0.0.1:7777", "", false},
		{"evil.example:7777", "http://evil.example:7777", false}, // DNS rebinding
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/api/terminal/ws", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := terminalSocketAllowed(r); got != c.want {
			t.Errorf("host %q origin %q: got %v, want %v", c.host, c.origin, got, c.want)
		}
	}
}

func TestTerminalDisabledByDefault(t *testing.T) {
	s := NewServer(NewIndex(t.TempDir()), nil)
	req := httptest.NewRequest("POST", "/api/terminal/new", strings.NewReader(`{}`))
	req.Host = "127.0.0.1:7777"
	req.Header.Set("Origin", "http://127.0.0.1:7777")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("new terminal on an unconfigured server: status %d, want 403", rec.Code)
	}
}

// End to end: start a shell, type into it over the WebSocket, read its
// output, re-attach and get the scrollback, then exit with a code.
func TestTerminalSession(t *testing.T) {
	if !termSupported || runtime.GOOS == "windows" {
		t.Skip("no pseudo-terminals here")
	}
	if testing.Short() {
		t.Skip("starts a shell")
	}
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // no terminal.integrated.shell setting
	root := t.TempDir()
	s := NewServer(NewIndex(root), nil)
	s.SetTerminalPolicy(true, "")
	defer s.CloseTerminals()
	ts := httptest.NewServer(s)
	defer ts.Close()
	origin := ts.URL

	post := func(path, body string) map[string]any {
		req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(body))
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]any
		json.NewDecoder(resp.Body).Decode(&m)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, m)
		}
		return m
	}
	info := post("/api/terminal/new", `{"cols":100,"rows":30}`)
	id, _ := info["id"].(string)
	if id == "" || info["cwd"] != root {
		t.Fatalf("new terminal: %v", info)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, strings.Replace(ts.URL, "http", "ws", 1)+"/api/terminal/ws?id="+id,
			&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	// readUntil collects output until it contains want; it returns the text
	// and the exit code, if an exit message came.
	readUntil := func(c *websocket.Conn, want string) (string, int) {
		var out strings.Builder
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q: %v; got %q", want, err, out.String())
			}
			if typ == websocket.MessageText {
				var m map[string]any
				json.Unmarshal(data, &m)
				if m["type"] == "exit" {
					return out.String(), int(m["code"].(float64))
				}
				continue
			}
			out.Write(data)
			if want != "" && strings.Contains(out.String(), want) {
				return out.String(), -1
			}
		}
	}
	input := func(c *websocket.Conn, text string) {
		b, _ := json.Marshal(map[string]string{"type": "input", "data": text})
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}

	c := dial()
	input(c, "echo px0-$((40+2))\n")
	readUntil(c, "px0-42")
	c.Close(websocket.StatusNormalClosure, "")

	// A new page re-attaches and replays the output so far.
	c = dial()
	readUntil(c, "px0-42")

	if l := s.terms.list(); len(l) != 1 || l[0].ID != id {
		t.Fatalf("list: %v", l)
	}
	input(c, "exit 7\n")
	_, code := readUntil(c, "")
	if code != 7 {
		t.Errorf("exit code %d, want 7", code)
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(s.terms.list()) != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(s.terms.list()); n != 0 {
		t.Errorf("%d terminals left after exit", n)
	}
}

func TestTermScreen(t *testing.T) {
	const mode = "\x1b[?2004h"
	cases := []struct {
		name, in, want string
	}{
		{"plain", "hello\r\nworld", "hello\r\nworld"},
		{"alternate screen cut out", "before\r\n\x1b[?1049hvim draws\x1b[2J\x1b[?1049lafter", "before\r\nafter"},
		{"47 and 1047 too", "a\x1b[?47hx\x1b[?47lb\x1b[?1047hy\x1b[?1047lc", "abc"},
		{"still on the alternate screen", "$ vim\r\n\x1b[?1049h\x1b[?1h\x1b=drawing", "$ vim\r\n\x1b[?1049h\x1b[?1h\x1b="},
		{"mode set inside and kept", "$ x\r\n\x1b[?1049h\x1b[?2004h\x1b[?1049l$ ", "$ x\r\n$ " + mode},
		{"mode reset", "\x1b[?2004hab\x1b[?2004l", "\x1b[?2004hab\x1b[?2004l"},
		{"cursor hidden", "\x1b[?25lab", "\x1b[?25lab\x1b[?25l"},
		{"full reset", "old stuff\x1b[?2004h\x1bcnew", "\x1bcnew"},
		{"clear", "old\x1b[H\x1b[2J\x1b[3Jnew", "\x1b[3Jnew"},
		{"osc with bel", "\x1b]0;a [?1049h title\x07text", "\x1b]0;a [?1049h title\x07text"},
		{"osc with st", "\x1b]633;A\x1b\\$ \x1b]633;B\x1b\\", "\x1b]633;A\x1b\\$ \x1b]633;B\x1b\\"},
		{"osc cut short by a sequence", "\x1b]0;x\x1b[?1049hgone\x1b[?1049lok", "\x1b]0;xok"},
		{"not a mode change", "\x1b[>1049h\x1b[1049hab", "\x1b[>1049h\x1b[1049hab"},
		{"partial sequence goes after the modes", mode + "abc\x1b[3", mode + "abc" + mode + "\x1b[3"},
		{"partial character goes after the modes", mode + "ab\xc3", mode + "ab" + mode + "\xc3"},
		{"complete character", mode + "ab\xc3\xa9", mode + "ab\xc3\xa9" + mode},
	}
	for _, c := range cases {
		whole := newTermScreen(1<<20, 80, 24)
		whole.write([]byte(c.in))
		if got := string(whole.replayBytes()); got != c.want {
			t.Errorf("%s: replay %q, want %q", c.name, got, c.want)
		}
		// Reads split sequences anywhere: a byte at a time gives the same.
		bytewise := newTermScreen(1<<20, 80, 24)
		for i := 0; i < len(c.in); i++ {
			bytewise.write([]byte{c.in[i]})
		}
		if got := string(bytewise.replayBytes()); got != c.want {
			t.Errorf("%s, a byte at a time: replay %q, want %q", c.name, got, c.want)
		}
	}
}

// Resizes are replayed where they happened; ones made on the alternate
// screen, or before the kept output starts, still count.
func TestTermScreenSizes(t *testing.T) {
	s := newTermScreen(1<<20, 100, 30)
	s.write([]byte("wide prompt$ "))
	s.resize(40, 30)
	s.write([]byte("\rnarrow$ "))
	s.resize(40, 30) // no change
	s.write([]byte("vim\r\n\x1b[?1049hdrawing"))
	s.resize(50, 20)
	s.write([]byte("more drawing"))
	got := s.replay()
	want := []termReplay{{100, 30, []byte("wide prompt$ ")}, {40, 30, []byte("\rnarrow$ vim\r\n")}, {50, 20, []byte("\x1b[?1049h")}}
	if len(got) != len(want) {
		t.Fatalf("replay %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i].cols != want[i].cols || got[i].rows != want[i].rows || string(got[i].data) != string(want[i].data) {
			t.Errorf("part %d: %d×%d %q, want %d×%d %q", i, got[i].cols, got[i].rows, got[i].data, want[i].cols, want[i].rows, want[i].data)
		}
	}
	// A clear drops the earlier sizes with the output.
	s.write([]byte("\x1b[?1049l\x1b[3Jfresh"))
	if got := s.replay(); len(got) != 1 || got[0].cols != 50 || string(got[0].data) != "\x1b[3Jfresh" {
		t.Errorf("after clear: %+v", got)
	}
}

func TestTermScreenTrim(t *testing.T) {
	s := newTermScreen(1000, 80, 24)
	s.write([]byte("\x1b[?1h")) // long before the kept output starts
	line := []byte(strings.Repeat("x", 99) + "\n")
	for i := 0; i < 100; i++ {
		s.write(line)
	}
	if len(s.buf) > 2000 {
		t.Fatalf("kept %d bytes, limit 1000", len(s.buf))
	}
	r := s.replayBytes()
	if !bytes.HasPrefix(r, []byte("xxx")) || !bytes.HasSuffix(r, []byte("\n\x1b[?1h")) {
		t.Errorf("replay should start at a line and end with the mode: %q...%q", r[:10], r[len(r)-10:])
	}
}

// termTest starts a server with the terminal on, and helpers to drive it.
type termTest struct {
	t    *testing.T
	s    *Server
	ts   *httptest.Server
	ctx  context.Context
	root string
}

func newTermTest(t *testing.T, shell string) *termTest {
	if !termSupported || runtime.GOOS == "windows" {
		t.Skip("no pseudo-terminals here")
	}
	if testing.Short() {
		t.Skip("starts a shell")
	}
	path, err := exec.LookPath(shell)
	if err != nil {
		t.Skip(shell + " is not installed")
	}
	t.Setenv("SHELL", path)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // no settings
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()
	s := NewServer(NewIndex(root), nil)
	s.SetTerminalPolicy(true, "")
	ts := httptest.NewServer(s)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(func() { cancel(); s.CloseTerminals(); ts.Close() })
	return &termTest{t: t, s: s, ts: ts, ctx: ctx, root: root}
}

func (x *termTest) newTerminal(body string) string {
	req, _ := http.NewRequest("POST", x.ts.URL+"/api/terminal/new", strings.NewReader(body))
	req.Header.Set("Origin", x.ts.URL)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		x.t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	if resp.StatusCode != 200 {
		x.t.Fatalf("new terminal: %d %v", resp.StatusCode, m)
	}
	return m["id"].(string)
}

func (x *termTest) dial(id string) *websocket.Conn {
	c, _, err := websocket.Dial(x.ctx, strings.Replace(x.ts.URL, "http", "ws", 1)+"/api/terminal/ws?id="+id,
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {x.ts.URL}}})
	if err != nil {
		x.t.Fatal(err)
	}
	c.SetReadLimit(8 << 20)
	return c
}

// read collects output until it contains want (acknowledging it, as the
// page does) or the shell exits; it returns the output and the exit code
// (-1 if it did not exit).
func (x *termTest) read(c *websocket.Conn, want string) (string, int) {
	var out strings.Builder
	for {
		typ, data, err := c.Read(x.ctx)
		if err != nil {
			x.t.Fatalf("waiting for %q: %v; got %q", want, err, out.String())
		}
		if typ == websocket.MessageText {
			var m map[string]any
			json.Unmarshal(data, &m)
			if m["type"] == "exit" {
				return out.String(), int(m["code"].(float64))
			}
			continue
		}
		out.Write(data)
		x.send(c, map[string]any{"type": "ack", "bytes": len(data)})
		if want != "" && strings.Contains(out.String(), want) {
			return out.String(), -1
		}
	}
}

func (x *termTest) send(c *websocket.Conn, msg map[string]any) {
	b, _ := json.Marshal(msg)
	if err := c.Write(x.ctx, websocket.MessageText, b); err != nil {
		x.t.Fatal(err)
	}
}

func (x *termTest) input(c *websocket.Conn, text string) {
	if err := c.Write(x.ctx, websocket.MessageBinary, []byte(text)); err != nil {
		x.t.Fatal(err)
	}
}

// bash gets the shell integration: prompts, command lines, exit codes, and
// the working directory come marked with OSC 633, the user's .bashrc still
// runs, and the pipe the script came through is not left open.
func TestTerminalShellIntegration(t *testing.T) {
	x := newTermTest(t, "bash")
	os.WriteFile(filepath.Join(os.Getenv("HOME"), ".bashrc"), []byte("PX0_RC=from-bashrc\n"), 0o644)
	os.Mkdir(filepath.Join(x.root, "sub"), 0o755)
	c := x.dial(x.newTerminal(`{"cols":120,"rows":30}`))
	x.read(c, "\x1b]633;B\a") // the first prompt
	x.input(c, "cd sub; echo rc=$PX0_RC; [ -e /proc/$$/fd/3 ] && echo fd3=open || echo fd3=closed; false\r")
	out, _ := x.read(c, "\x1b]633;B\a")
	for _, want := range []string{
		"\x1b]633;E;cd sub\\x3b echo rc=$PX0_RC",
		"\x1b]633;C\a",
		"rc=from-bashrc",
		"\x1b]633;D;1\a",
		"\x1b]633;P;Cwd=" + filepath.Join(x.root, "sub") + "\a",
		"\x1b]633;A\a",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%q", want, out)
		}
	}
	if runtime.GOOS == "linux" && !strings.Contains(out, "fd3=closed") {
		t.Errorf("fd 3 left open in the shell: %q", out)
	}
	// An empty line is no command: D comes without an exit code.
	x.input(c, "\r")
	out, _ = x.read(c, "\x1b]633;B\a")
	if !strings.Contains(out, "\x1b]633;D\a") || strings.Contains(out, "633;C") {
		t.Errorf("empty line: %q", out)
	}
}

// The shell is held back while the page has not drawn what it was sent,
// and a page that stops acknowledging is dropped rather than holding the
// shell up for ever.
func TestTerminalFlowControl(t *testing.T) {
	x := newTermTest(t, "sh")
	defer func(d time.Duration) { termStall = d }(termStall)
	termStall = time.Second
	id := x.newTerminal(`{"cols":80,"rows":24}`)
	c := x.dial(id)
	x.read(c, "$ ")
	x.input(c, "yes px0-flood\n")
	// Read without acknowledging: output stops near the high-water mark.
	// (A Read whose context ends closes the socket, so one goroutine reads.)
	var got atomic.Int64
	closed := make(chan error, 1)
	go func() {
		for {
			typ, data, err := c.Read(x.ctx)
			if err != nil {
				closed <- err
				return
			}
			if typ == websocket.MessageBinary {
				got.Add(int64(len(data)))
			}
		}
	}()
	time.Sleep(400 * time.Millisecond)
	if n := got.Load(); n < termHighWater/2 || n > termHighWater+(64<<10) {
		t.Fatalf("read %d bytes without acknowledging; want about %d", n, termHighWater)
	}
	// Acknowledging lets more through.
	before := got.Load()
	x.send(c, map[string]any{"type": "ack", "bytes": before})
	time.Sleep(200 * time.Millisecond)
	if got.Load() <= before {
		t.Fatalf("no output after acknowledging")
	}
	// Silence past termStall: the socket is dropped.
	select {
	case err := <-closed:
		if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
			t.Fatalf("socket ended with %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a page that stopped acknowledging was not dropped")
	}
	// It re-attaches and the shell is still there; Ctrl+C stops the flood.
	c = x.dial(id)
	x.input(c, "\x03")
	x.input(c, "echo px0-$((6*7))\n")
	x.read(c, "px0-42")
}

// A shell that exits leaving a background job holding the terminal still
// ends the session.
func TestTerminalExitWithBackgroundJob(t *testing.T) {
	x := newTermTest(t, "sh")
	c := x.dial(x.newTerminal(`{}`))
	x.read(c, "$ ")
	start := time.Now()
	x.input(c, "sleep 3 & exit 3\n")
	if _, code := x.read(c, ""); code != 3 {
		t.Errorf("exit code %d, want 3", code)
	}
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Errorf("session ended after %v, waiting for the background job", d)
	}
}

// Re-attaching while a full-screen program runs replays the normal screen
// and switches to the alternate one, without what was drawn there.
func TestTerminalReplayAlternateScreen(t *testing.T) {
	x := newTermTest(t, "sh")
	id := x.newTerminal(`{}`)
	c := x.dial(id)
	x.read(c, "$ ")
	x.input(c, "printf 'normal-%s\\n\\033[?1049halt-%s' screen screen\n")
	x.read(c, "alt-screen")
	c.Close(websocket.StatusNormalClosure, "")
	c = x.dial(id)
	var r string
	for {
		typ, data, err := c.Read(x.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ == websocket.MessageBinary {
			r += string(data)
		} else if strings.Contains(string(data), `"replayed"`) {
			break
		}
	}
	if !strings.Contains(r, "normal-screen") || strings.Contains(r, "alt-screen") || !strings.Contains(r, "\x1b[?1049h") {
		t.Errorf("replay: %q", r)
	}
}

// Split Terminal starts in the working directory of the terminal it splits.
func TestTerminalSplitInheritsCwd(t *testing.T) {
	x := newTermTest(t, "sh")
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	os.Mkdir(filepath.Join(x.root, "deep"), 0o755)
	id := x.newTerminal(`{}`)
	c := x.dial(id)
	x.read(c, "$ ")
	x.input(c, "cd deep\n")
	deadline := time.Now().Add(5 * time.Second)
	for {
		x.s.terms.get(id).mu.Lock()
		cwd := x.s.terms.get(id).Cwd
		x.s.terms.get(id).mu.Unlock()
		if cwd == filepath.Join(x.root, "deep") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("cwd not followed: %q", cwd)
		}
		time.Sleep(100 * time.Millisecond)
	}
	split := x.s.terms.get(x.newTerminal(`{"from":"` + id + `"}`))
	if split.Cwd != filepath.Join(x.root, "deep") {
		t.Errorf("split started in %q", split.Cwd)
	}
}

func BenchmarkTermScreen(b *testing.B) {
	chunk := bytes.Repeat([]byte("\x1b[32mok\x1b[0m some build output line\r\n"), 1000)
	s := newTermScreen(termScrollback, 80, 24)
	b.SetBytes(int64(len(chunk)))
	for b.Loop() {
		s.write(chunk)
	}
}

func BenchmarkTerminalPolicy(b *testing.B) {
	for i := 0; i < b.N; i++ {
		terminalPolicy("10.20.7.180", false, false)
	}
}
