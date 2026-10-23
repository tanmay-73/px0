package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"px0/internal/fuzzy"
	"px0/internal/metrics"
	"px0/internal/render"
	"px0/internal/settings"
	"px0/internal/symbols"
	"px0/internal/table"
	"px0/internal/ui"
)

// web/dist is the frontend bundled by scripts/build-web.js (`make web`).
//go:embed web/index.html web/workbench.html web/themes web/vendor web/dist
var embedded embed.FS

// assets is the embedded web/ directory.
var assets fs.FS = embedded

func cleanBasePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || p == "/" || p == "." {
		return "/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	p = path.Clean(p)
	if !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}

// Server is the main px0 HTTP server handling the web UI, static assets,
// REST API endpoints, Server-Sent Events (SSE), and workspace services.
type Server struct {
	ix        *Index
	lsp       *lspManager
	pr        *prSession // nil unless main launched this process as `px0 pr ...`
	diffBase  string     // ref /api/diff and /api/gutter diff against; "HEAD" unless in PR mode
	prHeadSHA string     // PR mode only: the checked-out PR head commit. Frozen boundary between
	// the PR's own diff (diffBase..prHeadSHA) and the reviewer's local edits
	// since checkout (prHeadSHA..working tree); refreshed on Pull.
	gitWatcher *GitWatcher
	mux        *http.ServeMux
	basePath   string
	session    *sessionManager

	workbenchURL string // the workbench's base path, when this px0 is one of its workspaces

	terms *termManager // integrated terminals (terminal.go); off until SetTerminalPolicy

	lastReq atomic.Int64 // unix nanos of the most recent request

	// streamsDone closes when the HTTP server starts shutting down, so event
	// streams end their responses cleanly instead of being cut when we exit.
	streamsDone chan struct{}
	endStreams  sync.Once
}

// EndStreams ends every open event stream. Register it with
// http.Server.RegisterOnShutdown: Shutdown does not cancel request contexts,
// so streams would otherwise hold it up until its deadline.
func (s *Server) EndStreams() {
	s.endStreams.Do(func() {
		if s.streamsDone != nil {
			close(s.streamsDone)
		}
	})
}

// SetTerminalPolicy turns the integrated terminal on or off (reason says why
// it is off). See terminalPolicy.
func (s *Server) SetTerminalPolicy(enabled bool, reason string) {
	s.terms.enabled, s.terms.reason = enabled, reason
}

// CloseTerminals ends every terminal's shell; call it when px0 stops.
func (s *Server) CloseTerminals() { s.terms.closeAll() }

// BasePath returns the URL path prefix configured for this server (e.g. "/" or "/rev-123/").
func (s *Server) BasePath() string {
	if s.basePath == "" {
		return "/"
	}
	return s.basePath
}

func (s *Server) routePath(subpath string) string {
	if s.basePath == "" || s.basePath == "/" {
		return subpath
	}
	bp := strings.TrimSuffix(s.basePath, "/")
	if !strings.HasPrefix(subpath, "/") {
		return bp + "/" + subpath
	}
	return bp + subpath
}

func (s *Server) registerRoutes() {
	sub, _ := fs.Sub(assets, "web")
	staticPrefix := s.routePath("/static/")
	s.mux.Handle(staticPrefix, s.handleStatic(sub, staticPrefix))
	s.mux.HandleFunc(s.routePath("/static/themes.css"), s.handleThemes)

	if s.basePath != "/" && s.basePath != "" {
		s.mux.HandleFunc(s.basePath, s.handleIndex)
		trimmed := strings.TrimSuffix(s.basePath, "/")
		s.mux.HandleFunc(trimmed, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, s.basePath, http.StatusMovedPermanently)
		})
		s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				http.Redirect(w, r, s.basePath, http.StatusFound)
				return
			}
			http.NotFound(w, r)
		})
	} else {
		s.mux.HandleFunc("/", s.handleIndex)
	}

	s.mux.HandleFunc(s.routePath("/api/meta"), s.handleMeta)
	s.mux.HandleFunc(s.routePath("/api/metrics"), s.handleMetrics)
	s.mux.HandleFunc(s.routePath("/api/tree"), s.handleTree)
	s.mux.HandleFunc(s.routePath("/api/find"), s.handleFind)
	s.mux.HandleFunc(s.routePath("/api/file"), s.handleFile)
	s.mux.HandleFunc(s.routePath("/api/close"), s.handleClose)
	s.mux.HandleFunc(s.routePath("/api/raw"), s.handleRaw)
	s.mux.HandleFunc(s.routePath("/api/file/text"), s.handleFileText)
	s.mux.HandleFunc(s.routePath("/api/file/save"), s.handleFileSave)
	s.mux.HandleFunc(s.routePath("/api/file/stat"), s.handleFileStat)
	s.mux.HandleFunc(s.routePath("/api/fs/new"), s.handleFSNew)
	s.mux.HandleFunc(s.routePath("/api/fs/rename"), s.handleFSRename)
	s.mux.HandleFunc(s.routePath("/api/fs/delete"), s.handleFSDelete)
	s.mux.HandleFunc(s.routePath("/api/markdown"), s.handleMarkdown)
	s.mux.HandleFunc(s.routePath("/api/table"), s.handleTable)
	s.mux.HandleFunc(s.routePath("/api/diff"), s.handleDiff)
	s.mux.HandleFunc(s.routePath("/api/gutter"), s.handleGutter)
	s.mux.HandleFunc(s.routePath("/api/stream"), s.handleEventStream)
	s.mux.HandleFunc(s.routePath("/api/git/stream"), s.handleEventStream)
	s.mux.HandleFunc(s.routePath("/api/git/refresh"), s.handleGitRefresh)
	s.mux.HandleFunc(s.routePath("/api/git/status"), s.handleGitStatus)
	s.mux.HandleFunc(s.routePath("/api/git/show"), s.handleGitShow)
	s.mux.HandleFunc(s.routePath("/api/git/stage"), s.handleGitStage)
	s.mux.HandleFunc(s.routePath("/api/git/unstage"), s.handleGitUnstage)
	s.mux.HandleFunc(s.routePath("/api/git/discard"), s.handleGitDiscard)
	s.mux.HandleFunc(s.routePath("/api/git/hunk"), s.handleGitHunk)
	s.mux.HandleFunc(s.routePath("/api/git/commit"), s.handleGitCommit)
	s.mux.HandleFunc(s.routePath("/api/git/push"), s.handleGitPush)
	s.mux.HandleFunc(s.routePath("/api/git/pull"), s.handleGitPull)
	s.mux.HandleFunc(s.routePath("/api/git/sync-state"), s.handleGitSyncState)
	s.mux.HandleFunc(s.routePath("/api/git/abort"), s.handleGitAbort)
	s.mux.HandleFunc(s.routePath("/api/git/log"), s.handleGitLog)
	s.mux.HandleFunc(s.routePath("/api/unpushed"), s.handleUnpushed)
	s.mux.HandleFunc(s.routePath("/api/commitfiles"), s.handleCommitFiles)
	s.mux.HandleFunc(s.routePath("/api/commitdetail"), s.handleCommitDetail)
	s.mux.HandleFunc(s.routePath("/api/search"), s.handleSearch)
	s.mux.HandleFunc(s.routePath("/api/outline"), s.handleOutline)
	s.mux.HandleFunc(s.routePath("/api/def"), s.handleDef)
	s.mux.HandleFunc(s.routePath("/api/reindex"), s.handleReindex)
	s.mux.HandleFunc(s.routePath("/api/lsp/def"), s.handleLSPDef)
	s.mux.HandleFunc(s.routePath("/api/lsp/refs"), s.handleLSPRefs)
	s.mux.HandleFunc(s.routePath("/api/lsp/calls"), s.handleLSPCalls)
	s.mux.HandleFunc(s.routePath("/api/lsp/symbols"), s.handleLSPSymbols)
	s.mux.HandleFunc(s.routePath("/api/lsp/hover"), s.handleLSPHover)
	s.mux.HandleFunc(s.routePath("/api/lsp/diagnostics"), s.handleLSPDiagnostics)
	s.mux.HandleFunc(s.routePath("/api/lsp/warm"), s.handleLSPWarm)
	s.mux.HandleFunc(s.routePath("/api/lsp/setup"), s.handleLSPSetup)
	s.mux.HandleFunc(s.routePath("/api/lsp/install"), s.handleLSPInstall)
	s.mux.HandleFunc(s.routePath("/api/lsp/start"), s.handleLSPStart)
	s.mux.HandleFunc(s.routePath("/api/lsp/stop"), s.handleLSPStop)
	s.mux.HandleFunc(s.routePath("/api/lsp/servers"), s.handleLSPServers)
	s.mux.HandleFunc(s.routePath("/api/settings"), s.handleSettings)
	s.mux.HandleFunc(s.routePath("/api/terminal/list"), s.handleTerminalList)
	s.mux.HandleFunc(s.routePath("/api/terminal/new"), s.handleTerminalNew)
	s.mux.HandleFunc(s.routePath("/api/terminal/kill"), s.handleTerminalKill)
	s.mux.HandleFunc(s.routePath("/api/terminal/rename"), s.handleTerminalRename)
	s.mux.HandleFunc(s.routePath("/api/terminal/ws"), s.handleTerminalSocket)
	s.mux.HandleFunc(s.routePath("/api/pr/meta"), s.handlePRMeta)
	s.mux.HandleFunc(s.routePath("/api/pr/comments"), s.handlePRComments)
	s.mux.HandleFunc(s.routePath("/api/pr/comments/delete"), s.handlePRCommentDelete)
	s.mux.HandleFunc(s.routePath("/api/pr/submit"), s.handlePRSubmit)
	s.mux.HandleFunc(s.routePath("/api/pr/launch"), s.handleLaunchPR)
	s.mux.HandleFunc(s.routePath("/api/pr/existing-comments"), s.handlePRExistingComments)
	s.mux.HandleFunc(s.routePath("/api/pr/comments/issue"), s.handlePRIssueCommentPost)
	s.mux.HandleFunc(s.routePath("/api/pr/comments/review-reply"), s.handlePRReviewCommentReply)
	s.mux.HandleFunc(s.routePath("/api/pr/merge-status"), s.handlePRMergeStatus)
	s.mux.HandleFunc(s.routePath("/api/pr/merge"), s.handlePRMerge)
	s.mux.HandleFunc(s.routePath("/api/forge/connect"), s.handleForgeConnect)
	s.mux.HandleFunc(s.routePath("/api/session"), s.handleSession)
}

// NewServer creates and initializes a px0 Server instance, binding index and language servers,
// starting the background GitWatcher, and registering all HTTP and SSE routes.
func NewServer(ix *Index, lsp *lspManager, basePaths ...string) *Server {
	if lsp == nil {
		lsp = newLSPManager(ix.Root(), false)
	}
	bp := "/"
	if len(basePaths) > 0 && basePaths[0] != "" {
		bp = cleanBasePath(basePaths[0])
	}
	s := &Server{ix: ix, lsp: lsp, diffBase: "HEAD", basePath: bp, mux: http.NewServeMux(), streamsDone: make(chan struct{})}
	s.terms = newTermManager(ix.Root(), false, "The terminal is not enabled.")
	s.session = newSessionManager(s.basePath, ix.Root())
	s.gitWatcher = NewGitWatcher(ix)
	s.gitWatcher.Start(context.Background())
	s.registerRoutes()
	s.lastReq.Store(time.Now().UnixNano())
	go s.scavenge()
	return s
}

// scavenge hands freed pages back to the OS once nobody is asking for anything.
// Reading a large tree churns through a lot of short-lived memory, and the Go
// runtime is in no hurry to return it. That is harmless but it makes a process
// that is doing nothing look like it is holding hundreds of megabytes.
func (s *Server) scavenge() {
	const idleFor = 15 * time.Second
	const lspIdleFor = 10 * time.Minute
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	done := true // nothing to release before the first request
	for range tick.C {
		idle := time.Since(time.Unix(0, s.lastReq.Load()))
		if s.lsp != nil && idle >= lspIdleFor {
			s.lsp.ReapIdle(lspIdleFor)
		}
		if idle < idleFor {
			done = false
			continue
		}
		if done {
			continue // already released since the last burst of work
		}
		render.Scavenge()
		debug.FreeOSMemory()
		done = true
	}
}

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: http:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none';"

// ServeHTTP delegates incoming HTTP requests to the configured ServeMux,
// recording request timing and updating access timestamps.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	streamPath := s.routePath("/api/stream")
	gitStreamPath := s.routePath("/api/git/stream")
	metricsPath := s.routePath("/api/metrics")
	isSSE := r.URL.Path == streamPath || r.URL.Path == gitStreamPath || r.Header.Get("Accept") == "text/event-stream"
	// A WebSocket handshake hijacks the connection; it must not be gzipped.
	isUpgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	if r.URL.Path != metricsPath && !isSSE {
		s.lastReq.Store(time.Now().UnixNano())
	}
	start := time.Now()

	rec := &statusRecorder{ResponseWriter: w}
	if ui.Verbose {
		defer func() {
			dur := ui.FmtDuration(time.Since(start))
			status := rec.status
			if status == 0 {
				status = http.StatusOK
			}
			role := "info"
			if status >= 500 {
				role = "err"
			} else if status >= 400 {
				role = "warn"
			}
			uri := r.RequestURI
			if uri == "" {
				uri = r.URL.RequestURI()
			}
			if uri == "" {
				uri = r.URL.Path
			}
			if uri == "" {
				uri = "/"
			}
			ui.Status(role, "http", fmt.Sprintf("%s %s · %d  (%s)", r.Method, uri, status, dur), 0, os.Stdout)
		}()
	}

	var out http.ResponseWriter = rec
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") && !isSSE && !isUpgrade {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		gz := gzipPool.Get().(*gzip.Writer)
		gz.Reset(rec)
		var disabled bool
		gw := &gzipWriter{ResponseWriter: rec, w: gz, disabled: &disabled}
		defer func() { gz.Close(); gzipPool.Put(gz) }()
		out = gw
	}

	s.mux.ServeHTTP(out, r)
}

type gzipBypasser interface {
	BypassGzip()
}

func bypassGzip(w http.ResponseWriter) {
	curr := w
	for curr != nil {
		if b, ok := curr.(gzipBypasser); ok {
			b.BypassGzip()
			return
		}
		if u, ok := curr.(interface{ Unwrap() http.ResponseWriter }); ok {
			curr = u.Unwrap()
		} else {
			break
		}
	}
}

var gzipPool = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	return w
}}

type gzipWriter struct {
	http.ResponseWriter
	w        *gzip.Writer
	disabled *bool
}

func (g gzipWriter) BypassGzip() {
	if g.disabled != nil {
		*g.disabled = true
	}
	if g.w != nil {
		g.w.Reset(io.Discard)
	}
}

func (g gzipWriter) isDisabled() bool {
	return g.disabled != nil && *g.disabled
}

func (g gzipWriter) WriteHeader(status int) {
	if g.isDisabled() {
		g.ResponseWriter.WriteHeader(status)
		return
	}
	g.Header().Del("Content-Length")
	if status == http.StatusNotModified || status == http.StatusNoContent {
		g.Header().Del("Content-Encoding")
		if g.w != nil {
			g.w.Reset(io.Discard)
		}
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g gzipWriter) Write(b []byte) (int, error) {
	if g.isDisabled() || g.w == nil {
		return g.ResponseWriter.Write(b)
	}
	g.Header().Del("Content-Length")
	return g.w.Write(b)
}

func (g gzipWriter) Flush() {
	if !g.isDisabled() && g.w != nil {
		_ = g.w.Flush()
	}
	if flusher, ok := g.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (g gzipWriter) Unwrap() http.ResponseWriter {
	return g.ResponseWriter
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hijacker, ok := r.ResponseWriter.(http.Hijacker); ok {
		return hijacker.Hijack()
	}
	return nil, nil, errors.New("hijack unsupported")
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// safePath resolves a client-supplied relative path inside the root, refusing
// anything that escapes it.
func (s *Server) safePath(rel string) (string, string, bool) {
	rel = strings.TrimPrefix(strings.TrimSpace(rel), "/")
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." {
		return s.ix.Root(), "", true
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		return "", "", false
	}
	abs := filepath.Join(s.ix.Root(), clean)
	if abs != s.ix.Root() && !strings.HasPrefix(abs, s.ix.Root()+string(filepath.Separator)) {
		return "", "", false
	}
	return abs, filepath.ToSlash(clean), true
}

// resolvePath is safePath plus the one documented exception: an absolute path a
// language server named as a definition target, such as a file in the standard
// library or the module cache. Nothing else outside the root is reachable.
func (s *Server) resolvePath(p string) (string, string, bool) {
	if filepath.IsAbs(filepath.FromSlash(p)) {
		abs := filepath.Clean(filepath.FromSlash(p))
		if s.lsp.Allowed(abs) {
			return abs, filepath.ToSlash(abs), true
		}
		return "", "", false
	}
	return s.safePath(p)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	// Highlighted lines are already HTML-escaped by the time they get here, so
	// the extra \u003c encoding only inflates the payload and makes the API
	// awkward to read with anything but a JSON parser.
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// SetPR marks this process as a PR review session: diffs are computed
// against the PR's merge-base instead of HEAD, and the /api/pr/* endpoints
// become live. Unset (nil) for a normal workspace.
func (s *Server) SetPR(p *prSession) {
	s.pr = p
	if p != nil {
		s.diffBase = p.diffBase
		s.prHeadSHA = p.meta.HeadSHA
		if s.ix != nil {
			s.ix.SetDiffBase(p.diffBase)
			s.ix.SetPRHead(p.meta.HeadSHA)
			s.ix.SetPushedHead(p.meta.HeadSHA)
		}
		if s.gitWatcher != nil {
			s.gitWatcher.Trigger()
		}
		if p.target.Owner != "" && p.target.Repo != "" && p.target.Number > 0 {
			// Drafts are keyed on the PR, not the base path. Carry over any
			// drafts an older px0 saved under the base-path file.
			prs := newPRSessionManager(p.target)
			if old := s.session; old != nil && len(prs.Get().Drafts) == 0 && len(old.Get().Drafts) > 0 {
				drafts := old.Get().Drafts
				prs.Update(func(ws *WorkspaceSession) { ws.Drafts = drafts })
				old.Update(func(ws *WorkspaceSession) { ws.Drafts = nil })
			}
			s.session = prs
		}
		if s.session != nil {
			p.mu.Lock()
			if len(p.comments) == 0 && len(s.session.Get().Drafts) > 0 {
				p.comments = append([]prComment(nil), s.session.Get().Drafts...)
				for _, c := range p.comments {
					if c.ID > p.nextID {
						p.nextID = c.ID
					}
				}
			}
			p.mu.Unlock()
		}
	}
}

var baseHrefRe = regexp.MustCompile(`<base\s+href="[^"]*">`)

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	expected := s.BasePath()
	if r.URL.Path != expected && r.URL.Path != strings.TrimSuffix(expected, "/") {
		http.NotFound(w, r)
		return
	}
	b, err := fs.ReadFile(assets, "web/index.html")
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	html := string(b)
	baseTag := fmt.Sprintf(`<base href="%s">`, expected)
	if strings.Contains(html, "<base ") {
		html = baseHrefRe.ReplaceAllString(html, baseTag)
	} else if idx := strings.Index(html, "<head>"); idx != -1 {
		html = html[:idx+6] + "\n" + baseTag + html[idx+6:]
	} else {
		html = baseTag + "\n" + html
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, html)
}

var (
	themesCSSOnce sync.Once
	themesCSSBody string
	themesCSSErr  error
)

// handleThemes joins web/themes/*.css into one stylesheet in file name order, so
// adding a theme means adding a file: there is no list to keep in sync.
func (s *Server) handleThemes(w http.ResponseWriter, r *http.Request) {
	themesCSSOnce.Do(func() {
		names, err := fs.Glob(assets, "web/themes/*.css")
		if err != nil {
			themesCSSErr = err
			return
		}
		var css strings.Builder
		for _, name := range names {
			b, err := fs.ReadFile(assets, name)
			if err != nil {
				themesCSSErr = err
				return
			}
			css.WriteString("/* " + strings.TrimPrefix(name, "web/") + " */\n")
			css.Write(b)
			css.WriteString("\n")
		}
		themesCSSBody = css.String()
	})
	if themesCSSErr != nil {
		fail(w, 500, themesCSSErr.Error())
		return
	}
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	io.WriteString(w, themesCSSBody)
}

func staticContentType(p string) string {
	ext := strings.ToLower(path.Ext(p))
	switch ext {
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html":
		return "text/html; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".ico":
		return "image/x-icon"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

var (
	vendorFetchMu sync.Mutex
	vendorCDNs    = map[string]string{
		"vendor/mermaid-12.0.0.min.js": "https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js",
	}
)

func vendorCacheDir() string {
	if c := os.Getenv("XDG_CACHE_HOME"); c != "" {
		return filepath.Join(c, "px0", "vendor")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".px0", "cache", "vendor")
	}
	return filepath.Join(os.TempDir(), "px0-cache", "vendor")
}

type memGzFile struct {
	*bytes.Reader
	name    string
	size    int64
	modTime time.Time
}

func (m *memGzFile) Stat() (fs.FileInfo, error) { return m, nil }
func (m *memGzFile) Close() error               { return nil }
func (m *memGzFile) Name() string               { return m.name }
func (m *memGzFile) Size() int64                { return m.size }
func (m *memGzFile) Mode() fs.FileMode          { return 0644 }
func (m *memGzFile) ModTime() time.Time         { return m.modTime }
func (m *memGzFile) IsDir() bool                { return false }
func (m *memGzFile) Sys() any                   { return nil }

func openOrFetchVendorAsset(rel string) (fs.File, error) {
	gzName := path.Base(rel) + ".gz"
	cachedPath := filepath.Join(vendorCacheDir(), gzName)

	// 1. Check local persistent cache
	if f, err := os.Open(cachedPath); err == nil {
		return f, nil
	}

	// 2. Check local repository web/ directory (for dev/test fallback)
	localGz := filepath.Join("web", filepath.FromSlash(rel)+".gz")
	if f, err := os.Open(localGz); err == nil {
		return f, nil
	}

	cdnURL, ok := vendorCDNs[rel]
	if !ok {
		return nil, os.ErrNotExist
	}

	vendorFetchMu.Lock()
	defer vendorFetchMu.Unlock()

	// Double-check cache after acquiring lock
	if f, err := os.Open(cachedPath); err == nil {
		return f, nil
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(cdnURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("CDN returned HTTP %d for %s", resp.StatusCode, rel)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Compress downloaded asset with gzip level 9
	var gzBuf bytes.Buffer
	gw, err := gzip.NewWriterLevel(&gzBuf, gzip.BestCompression)
	if err != nil {
		gw = gzip.NewWriter(&gzBuf)
	}
	if _, err := gw.Write(body); err != nil {
		gw.Close()
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}

	gzBytes := gzBuf.Bytes()

	// Cache to disk for offline and subsequent requests
	if err := os.MkdirAll(vendorCacheDir(), 0755); err == nil {
		tmpPath := cachedPath + fmt.Sprintf(".%d.tmp", time.Now().UnixNano())
		if err := os.WriteFile(tmpPath, gzBytes, 0644); err == nil {
			_ = os.Rename(tmpPath, cachedPath)
		}
	}

	if f, err := os.Open(cachedPath); err == nil {
		return f, nil
	}
	return &memGzFile{
		Reader:  bytes.NewReader(gzBytes),
		name:    gzName,
		size:    int64(len(gzBytes)),
		modTime: time.Now(),
	}, nil
}

func (s *Server) handleStatic(sub fs.FS, prefix string) http.Handler {
	fileServer := http.StripPrefix(prefix, http.FileServer(http.FS(sub)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, prefix)
		rel = path.Clean(strings.TrimPrefix(rel, "/"))
		if rel == "." || strings.HasPrefix(rel, "..") {
			http.NotFound(w, r)
			return
		}

		// Check if a pre-compressed .gz asset exists for this path.
		gzPath := rel + ".gz"
		gzFile, err := sub.Open(gzPath)
		if err != nil && strings.HasPrefix(rel, "vendor/") {
			gzFile, err = openOrFetchVendorAsset(rel)
		}
		if err == nil {
			defer gzFile.Close()
			fi, err := gzFile.Stat()
			if err == nil && !fi.IsDir() {
				mimeType := staticContentType(rel)
				if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
					bypassGzip(w)
					w.Header().Set("Content-Type", mimeType)
					w.Header().Set("Content-Encoding", "gzip")
					w.Header().Set("Vary", "Accept-Encoding")
					if strings.HasPrefix(rel, "vendor/") {
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					}
					if rs, ok := gzFile.(io.ReadSeeker); ok {
						http.ServeContent(w, r, path.Base(rel), fi.ModTime(), rs)
						return
					}
					io.Copy(w, gzFile)
					return
				}

				// Client does not accept gzip: decompress on the fly.
				gzReader, err := gzip.NewReader(gzFile)
				if err == nil {
					defer gzReader.Close()
					w.Header().Set("Content-Type", mimeType)
					w.Header().Set("Vary", "Accept-Encoding")
					if strings.HasPrefix(rel, "vendor/") {
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					}
					io.Copy(w, gzReader)
					return
				}
			}
		}

		fileServer.ServeHTTP(w, r)
	})
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	n, at, ms := s.ix.Stats()
	inGit := gitAvailable(s.ix.Root())
	if inGit && s.ix.Ready() {
		s.ix.mu.RLock()
		noStatus := s.ix.gitStatusMap == nil
		s.ix.mu.RUnlock()
		if noStatus {
			s.ix.UpdateGitStatus()
		}
	}
	gitCount, gitFiles := s.ix.GitChanges()
	meta := map[string]any{
		"root":       s.ix.Root(),
		"name":       filepath.Base(s.ix.Root()),
		"files":      n,
		"indexMs":    ms,
		"builtAt":    at,
		"ready":      s.ix.Ready(),
		"git":        inGit,
		"gitChanges": gitCount,
		"gitFiles":   gitFiles,
		"forge":      s.forgeMeta(),
		"lspServers": s.lsp.Available(),
		"metrics":    getProcessMetrics(s.lsp),
		"version":    version,
		"basePath":   s.BasePath(),
		"workbench":  s.workbenchURL,
		"compare":    gitBinary(),
		"terminal":   s.terms.enabled,
	}
	if s.pr != nil {
		meta["pr"] = s.pr.metaMap(s.ix.PRFiles())
	}
	writeJSON(w, meta)
}

func getProcessMetrics(lsp *lspManager) metrics.ProcessMetrics {
	if lsp == nil {
		return metrics.Collect(0, false)
	}
	return metrics.Collect(lsp.memBytes(), lsp.Enabled())
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, getProcessMetrics(s.lsp))
}

// lspCtx bounds how long a caller is willing to wait. Language servers can take
// tens of seconds to index a large workspace on first use, so the budget is
// generous but always finite.
func lspCtx(r *http.Request) (context.Context, context.CancelFunc) {
	ms, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	if ms <= 0 {
		ms = 10000
	}
	if ms > 120000 {
		ms = 120000
	}
	return context.WithTimeout(r.Context(), time.Duration(ms)*time.Millisecond)
}

// lspPos pulls the shared path/line/col arguments. col arrives in UTF-16 code
// units because that is what JavaScript string offsets count.
func (s *Server) lspPos(r *http.Request) (abs, rel string, line, col int, ok bool) {
	q := r.URL.Query()
	abs, rel, ok = s.resolvePath(q.Get("path"))
	if !ok {
		return
	}
	line, _ = strconv.Atoi(q.Get("line"))
	col, _ = strconv.Atoi(q.Get("col"))
	if line < 1 {
		line = 1
	}
	if col < 0 {
		col = 0
	}
	return abs, rel, line, col, true
}

func (s *Server) lspRespond(w http.ResponseWriter, rel string, hits []NavHit, err error) {
	state, server := s.lsp.State(rel)
	if err != nil {
		writeJSON(w, map[string]any{
			"hits": []NavHit{}, "state": string(state), "server": server,
			"error": err.Error(),
		})
		return
	}
	if hits == nil {
		hits = []NavHit{}
	}
	writeJSON(w, map[string]any{"hits": hits, "state": string(state), "server": server})
}

func (s *Server) handleLSPDef(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	abs, rel, line, col, ok := s.lspPos(r)
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	ctx, cancel := lspCtx(r)
	defer cancel()
	hits, err := s.lsp.Definition(ctx, abs, rel, line, col)
	if ui.Verbose {
		dur := ui.FmtDuration(time.Since(start))
		if len(hits) == 1 {
			dest := fmt.Sprintf("%s:%d", hits[0].Path, hits[0].Line)
			ui.Status("info", "lsp def", fmt.Sprintf("%s:%d:%d -> %s  (%s)", rel, line, col, dest, dur), 0, os.Stdout)
		} else {
			ui.Status("info", "lsp def", fmt.Sprintf("%s:%d:%d · %d hits  (%s)", rel, line, col, len(hits), dur), 0, os.Stdout)
		}
	}
	s.lspRespond(w, rel, hits, err)
}

func (s *Server) handleLSPRefs(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	abs, rel, line, col, ok := s.lspPos(r)
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	ctx, cancel := lspCtx(r)
	defer cancel()
	hits, err := s.lsp.References(ctx, abs, rel, line, col)
	if ui.Verbose {
		dur := ui.FmtDuration(time.Since(start))
		files := make(map[string]bool)
		for _, h := range hits {
			files[h.Path] = true
		}
		ui.Status("info", "lsp refs", fmt.Sprintf("%s:%d:%d · %d refs in %d files  (%s)", rel, line, col, len(hits), len(files), dur), 0, os.Stdout)
	}
	s.lspRespond(w, rel, hits, err)
}

// handleLSPCalls serves call trails. Without item it resolves the function at
// path/line/col into trail roots; with item (a node's opaque item, echoed back)
// it expands that node into callers, or callees when dir=out. path always names
// the file the trail started in, which picks the language server.
func (s *Server) handleLSPCalls(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	abs, rel, line, col, ok := s.lspPos(r)
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	ctx, cancel := lspCtx(r)
	defer cancel()
	q := r.URL.Query()
	var nodes []CallNode
	var err error
	if item := q.Get("item"); item != "" {
		nodes, err = s.lsp.Calls(ctx, rel, item, q.Get("dir") == "out")
	} else {
		nodes, err = s.lsp.PrepareCalls(ctx, abs, rel, line, col)
	}
	if nodes == nil {
		nodes = []CallNode{}
	}
	state, server := s.lsp.State(rel)
	resp := map[string]any{"nodes": nodes, "state": string(state), "server": server}
	if err != nil {
		resp["error"] = err.Error()
	}
	if ui.Verbose {
		dir := "callers"
		if q.Get("dir") == "out" {
			dir = "callees"
		}
		ui.Status("info", "lsp calls", fmt.Sprintf("%s:%d:%d (%s) · %d nodes  (%s)", rel, line, col, dir, len(nodes), ui.FmtDuration(time.Since(start))), 0, os.Stdout)
	}
	writeJSON(w, resp)
}

// handleLSPWarm starts the server for this file type if it is not running and
// reports where it has got to. Opening a file calls this so the server is awake
// by the time the reader wants to hover or jump, and so the status indicator
// reflects reality without anyone having to ask a question first.
func (s *Server) handleLSPWarm(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	ms, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	if ms <= 0 {
		ms = 1
	}
	if ms > 60000 {
		ms = 60000
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(ms)*time.Millisecond)
	defer cancel()
	// The spawn keeps going even when this call gives up waiting on it.
	_ = s.lsp.EnsureOpen(ctx, abs, rel)
	writeJSON(w, s.lspBrief(rel))
}

func (s *Server) handleLSPHover(w http.ResponseWriter, r *http.Request) {
	abs, rel, line, col, ok := s.lspPos(r)
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	ctx, cancel := lspCtx(r)
	defer cancel()
	info, err := s.lsp.Hover(ctx, abs, rel, line, col)
	state, srv := s.lsp.State(rel)
	if err != nil || info == nil {
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, map[string]any{"empty": true, "state": string(state), "server": srv, "error": msg})
		return
	}
	writeJSON(w, map[string]any{
		"signature": info.Signature, "doc": info.Doc, "empty": info.Empty,
		"state": string(state), "server": srv,
	})
}

func (s *Server) handleLSPSymbols(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	ctx, cancel := lspCtx(r)
	defer cancel()
	syms, err := s.lsp.Symbols(ctx, abs, rel)
	state, server := s.lsp.State(rel)
	if err != nil {
		writeJSON(w, map[string]any{
			"symbols": []symbols.Symbol{}, "state": string(state), "server": server, "error": err.Error(),
		})
		return
	}
	if syms == nil {
		syms = []symbols.Symbol{}
	}
	writeJSON(w, map[string]any{"symbols": syms, "state": string(state), "server": server})
}

func (s *Server) handleLSPDiagnostics(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	diags := s.lsp.Diagnostics(abs, rel)
	state, server := s.lsp.State(rel)
	writeJSON(w, map[string]any{
		"path":        rel,
		"diagnostics": diags,
		"state":       string(state),
		"server":      server,
	})
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	dir := strings.Trim(r.URL.Query().Get("dir"), "/")
	kids, ok := s.ix.Children(dir)
	if !ok && !s.ix.Ready() {
		// If indexing is still in flight, wait up to 300ms for this directory to be scanned
		for i := 0; i < 30; i++ {
			time.Sleep(10 * time.Millisecond)
			if kids, ok = s.ix.Children(dir); ok {
				break
			}
			if s.ix.Ready() {
				kids, ok = s.ix.Children(dir)
				break
			}
		}
	}
	if !ok {
		fail(w, 404, "not indexed: "+dir)
		return
	}
	// Folders that are repositories of their own (nested clones, submodules)
	// are marked, so the tree can offer to open them as a workspace.
	for i := range kids {
		if kids[i].Dir && hasGitMarker(filepath.Join(s.ix.Root(), filepath.FromSlash(kids[i].Path))) {
			kids[i].Repo = true
		}
	}
	writeJSON(w, map[string]any{"dir": dir, "children": kids})
}

func (s *Server) handleFind(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if !s.ix.Ready() {
		s.ix.WaitReady(300 * time.Millisecond)
	}
	ready := s.ix.Ready()
	res := fuzzy.Find(s.ix.Files(), q, limit)
	if res == nil {
		res = []fuzzy.Result{}
	}
	if ui.Verbose && q != "" {
		dur := ui.FmtDuration(time.Since(start))
		ui.Status("info", "find", fmt.Sprintf("%q · %d files  (%s)", q, len(res), dur), 0, os.Stdout)
	}
	writeJSON(w, map[string]any{"results": res, "indexing": !ready})
}

var imageExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".svg": true, ".ico": true, ".bmp": true, ".avif": true,
}

var imageMime = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".bmp":  "image/bmp",
	".avif": "image/avif",
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	abs, rel, ok := s.resolvePath(q.Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) && gitAvailable(s.ix.Root()) {
			diffAvail := false
			// A file a local commit deleted has nothing on disk, so the normal
			// working-tree check below can't vouch for it. Its commit diff can.
			if ref := q.Get("ref"); ref != "" {
				diffAvail = gitDiffCommit(s.ix.Root(), rel, ref) != ""
			} else if avail, ok := s.ix.HasDiffAvailable(rel, s.diffBase, s.pr != nil); ok {
				diffAvail = avail
			} else if s.pr != nil {
				diffAvail = gitDiffAgainst(s.ix.Root(), rel, s.diffBase) != "" ||
					gitDiffBetween(s.ix.Root(), rel, s.diffBase, s.prHeadSHA) != "" ||
					gitDiffAgainst(s.ix.Root(), rel, s.prHeadSHA) != ""
			} else {
				diffAvail = gitDiffAgainst(s.ix.Root(), rel, s.diffBase) != ""
			}
			if diffAvail {
				d := render.NewDoc("", rel)
				if ui.Verbose {
					ui.Status("info", "view", fmt.Sprintf("%s · deleted (0 bytes)", rel), 0, os.Stdout)
				}
				writeJSON(w, map[string]any{
					"path": rel, "lang": d.Lang, "total": 0, "maxCols": 0,
					"start": 0, "lines": []string{}, "size": 0,
					"exact": true, "refine": false,
					"markdown":      render.IsMarkdown(rel),
					"table":         table.IsTable(rel),
					"diffAvailable": true,
					"deleted":       true,
					"lsp":           s.lspBrief(rel),
				})
				return
			}
		}
		fail(w, 404, err.Error())
		return
	}
	if imageExt[strings.ToLower(filepath.Ext(rel))] {
		if ui.Verbose {
			ui.Status("info", "view", fmt.Sprintf("%s · image (%s)", rel, ui.FormatBytes(st.Size())), 0, os.Stdout)
		}
		writeJSON(w, map[string]any{"path": rel, "image": true, "size": st.Size()})
		return
	}

	d, err := render.Open(abs, rel)
	if err != nil {
		fail(w, 415, err.Error())
		return
	}
	start, _ := strconv.Atoi(q.Get("start"))
	count, _ := strconv.Atoi(q.Get("count"))
	if count <= 0 {
		count = render.ChunkLines
	}
	if start < 0 {
		start = 0
	}
	if start > d.Total {
		start = d.Total
	}
	if ui.Verbose && start == 0 {
		ui.Status("info", "view", fmt.Sprintf("%s · %d lines (%s)", rel, d.Total, ui.FormatBytes(st.Size())), 0, os.Stdout)
	}
	lines, exact := d.Lines(start, start+count)
	_, coming := d.Exact()
	diffAvail := false
	if gitAvailable(s.ix.Root()) {
		if ref := q.Get("ref"); ref != "" {
			if base := q.Get("base"); base != "" && validSHA(base) && validSHA(ref) {
				diffAvail = gitDiffBetween(s.ix.Root(), rel, base, ref) != ""
			} else {
				// Pinned to one commit: what matters is whether that commit touched
				// the file, not whether the working tree has since diverged.
				diffAvail = gitDiffCommit(s.ix.Root(), rel, ref) != ""
			}
		} else if avail, ok := s.ix.HasDiffAvailable(rel, s.diffBase, s.pr != nil); ok {
			diffAvail = avail
		} else if s.pr != nil {
			diffAvail = gitDiffAgainst(s.ix.Root(), rel, s.diffBase) != "" ||
				gitDiffBetween(s.ix.Root(), rel, s.diffBase, s.prHeadSHA) != "" ||
				gitDiffAgainst(s.ix.Root(), rel, s.prHeadSHA) != ""
		} else {
			diffAvail = gitDiffAgainst(s.ix.Root(), rel, s.diffBase) != ""
		}
	}
	resp := map[string]any{
		"path": rel, "lang": d.Lang, "total": d.Total, "maxCols": d.MaxCols,
		"start": start, "lines": lines, "size": st.Size(),
		"exact": exact, "refine": !exact && coming,
		"markdown":      render.IsMarkdown(rel),
		"table":         table.IsTable(rel),
		"diffAvailable": diffAvail,
		"lsp":           s.lspBrief(rel),
		"diagnostics":   s.lsp.Diagnostics(abs, rel),
	}
	if q.Get("raw") == "1" {
		rawLines := make([]string, len(lines))
		for i := range lines {
			rawLines[i] = d.Raw(start + i + 1)
		}
		resp["raw"] = rawLines
	}
	writeJSON(w, resp)
}

func (s *Server) handleClose(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	abs, rel, ok := s.resolvePath(q.Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	render.Evict(abs)
	s.lsp.CloseDoc(abs, rel)
	writeJSON(w, map[string]any{"ok": true, "path": rel})
}

func (s *Server) handleMarkdown(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	if !render.IsMarkdown(rel) {
		fail(w, 415, "not a Markdown file")
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	if st.IsDir() {
		fail(w, 415, "is a directory")
		return
	}
	if st.Size() > render.MaxMarkdownBytes {
		fail(w, 413, "too large to preview")
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	out, err := render.RenderMarkdown(data)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]any{"path": rel, "html": out})
}

// handleTable serves a CSV or TSV file parsed into rows for the table view.
// Cells go back as plain strings; the client inserts them as text, never HTML.
func (s *Server) handleTable(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	delim, ok := table.Delim(rel)
	if !ok {
		fail(w, 415, "not a CSV or TSV file")
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	if st.IsDir() {
		fail(w, 415, "is a directory")
		return
	}
	res, err := table.Render(f, st.Size(), delim)
	if err != nil {
		var pe *csv.ParseError
		if errors.As(err, &pe) {
			fail(w, 422, err.Error())
			return
		}
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func setRawHeaders(w http.ResponseWriter, rel string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	base := filepath.Base(rel)
	cd := mime.FormatMediaType("attachment", map[string]string{
		"filename": base,
	})
	if cd == "" {
		cd = fmt.Sprintf(`attachment; filename=%q`, base)
	}
	w.Header().Set("Content-Disposition", cd)

	ext := strings.ToLower(filepath.Ext(rel))
	ct := ""
	if imageExt[ext] {
		ct = mime.TypeByExtension(ext)
		if ct == "" {
			ct = imageMime[ext]
		}
	}
	if ct == "" || !strings.HasPrefix(ct, "image/") {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
}

func (s *Server) handleRaw(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.safePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	setRawHeaders(w, rel)
	http.ServeFile(w, r, abs)
}

// maxTextBytes caps what /api/file/text and /api/git/show hand an editor:
// past it a file is reported tooLarge instead of shipped.
const maxTextBytes = 20 << 20

// fileText is what an editor opens: the file's exact bytes as a string (line
// endings untouched, so saving it back round-trips), or a flag saying why not.
type fileText struct {
	Path     string `json:"path"`
	Text     string `json:"text"`
	Size     int64  `json:"size"`
	Mtime    int64  `json:"mtime"` // unix milliseconds; hand back to /api/file/save
	Binary   bool   `json:"binary"`
	TooLarge bool   `json:"tooLarge"`
	EOL      string `json:"eol"` // "\r\n" when the first line break is CRLF, else "\n"
}

// textOf fills in t's text from data, or marks it binary. Bytes that aren't
// valid UTF-8 count as binary too: a JSON string can't carry them, so the
// editor would be handed (and would save back) something else.
func (t *fileText) textOf(data []byte) {
	t.EOL = "\n"
	if render.IsBinary(data) || !utf8.Valid(data) {
		t.Binary = true
		return
	}
	if i := bytes.IndexByte(data, '\n'); i > 0 && data[i-1] == '\r' {
		t.EOL = "\r\n"
	}
	t.Text = string(data)
}

// handleFileText serves a file whole, for editing (GET ?path=).
func (s *Server) handleFileText(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok || rel == "" {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	defer f.Close()
	// Stat before reading: a write racing the read then leaves the mtime
	// older than the text, so the next save reports a conflict rather than
	// quietly overwriting what landed in between.
	st, err := f.Stat()
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	if st.IsDir() {
		fail(w, http.StatusBadRequest, "is a directory")
		return
	}
	t := fileText{Path: rel, Size: st.Size(), Mtime: st.ModTime().UnixMilli(), EOL: "\n"}
	if st.Size() > maxTextBytes {
		t.TooLarge = true
		writeJSON(w, t)
		return
	}
	data, err := io.ReadAll(f)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	t.Size = int64(len(data))
	t.textOf(data)
	writeJSON(w, t)
}

type fileSaveRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// Mtime, when set, is the unix-millisecond mtime the editor loaded the
	// file at. A file on disk with any other is refused (409) rather than
	// overwritten: something else changed it since.
	Mtime *int64 `json:"mtime"`
}

func (s *Server) handleFileSave(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req fileSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	abs, rel, ok := s.safePath(req.Path)
	if !ok || rel == "" {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}

	st, statErr := os.Stat(abs)
	if statErr == nil && st.IsDir() {
		fail(w, http.StatusBadRequest, "target is a directory")
		return
	}
	if statErr == nil && req.Mtime != nil && st.ModTime().UnixMilli() != *req.Mtime {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{
			"error": "the file changed on disk", "conflict": true, "mtime": st.ModTime().UnixMilli(),
		})
		return
	}

	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(w, http.StatusInternalServerError, "failed to create directory: "+err.Error())
		return
	}

	if err := os.WriteFile(abs, []byte(req.Content), 0o644); err != nil {
		fail(w, http.StatusInternalServerError, "failed to write file: "+err.Error())
		return
	}
	var mtime int64
	if st, err := os.Stat(abs); err == nil {
		mtime = st.ModTime().UnixMilli()
	}

	render.Evict(abs)
	if s.lsp != nil {
		s.lsp.CloseDoc(abs, rel)
		s.lsp.RefreshOpenDocs()
	}
	s.ix.TouchPath(rel)
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
		if os.IsNotExist(statErr) {
			s.gitWatcher.NotifyTree()
		}
	}

	writeJSON(w, map[string]any{
		"ok":    true,
		"path":  rel,
		"size":  len(req.Content),
		"mtime": mtime,
	})
}

// maxStatPaths caps one /api/file/stat request.
const maxStatPaths = 500

type fileStat struct {
	Exists bool  `json:"exists"`
	Mtime  int64 `json:"mtime"` // unix milliseconds
	Size   int64 `json:"size"`
	Dir    bool  `json:"dir,omitempty"`
}

// handleFileStat reports whether each of a list of files exists and when it
// last changed (POST {paths}), so an editor can notice open files changing
// on disk under it. Results are keyed by the path as sent; paths outside the
// workspace are left out, and so is everything past the first maxStatPaths.
func (s *Server) handleFileStat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	truncated := len(req.Paths) > maxStatPaths
	if truncated {
		req.Paths = req.Paths[:maxStatPaths]
	}
	files := make(map[string]fileStat, len(req.Paths))
	for _, p := range req.Paths {
		abs, _, ok := s.resolvePath(p)
		if !ok {
			continue
		}
		st, err := os.Stat(abs)
		if err != nil {
			files[p] = fileStat{}
			continue
		}
		files[p] = fileStat{Exists: true, Mtime: st.ModTime().UnixMilli(), Size: st.Size(), Dir: st.IsDir()}
	}
	writeJSON(w, map[string]any{"files": files, "truncated": truncated})
}

type fsNewRequest struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

func (s *Server) handleFSNew(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req fsNewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	abs, rel, ok := s.safePath(req.Path)
	if !ok || rel == "" {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}

	if _, err := os.Stat(abs); err == nil {
		fail(w, http.StatusConflict, "already exists: "+rel)
		return
	}

	if req.Type == "dir" {
		if err := os.MkdirAll(abs, 0o755); err != nil {
			fail(w, http.StatusInternalServerError, "failed to create directory: "+err.Error())
			return
		}
	} else {
		dir := filepath.Dir(abs)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fail(w, http.StatusInternalServerError, "failed to create parent directory: "+err.Error())
			return
		}
		if err := os.WriteFile(abs, []byte(""), 0o644); err != nil {
			fail(w, http.StatusInternalServerError, "failed to create file: "+err.Error())
			return
		}
		render.Evict(abs)
	}

	s.ix.TouchPath(rel)
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
		s.gitWatcher.NotifyTree()
	}

	writeJSON(w, map[string]any{
		"ok":   true,
		"path": rel,
		"type": req.Type,
	})
}

// editablePath is safePath for moving and deleting: never the workspace root
// itself, and never anything in or under a .git directory, whose contents
// only git should touch.
func (s *Server) editablePath(p string) (abs, rel string, ok bool) {
	abs, rel, ok = s.safePath(p)
	if !ok || rel == "" {
		return "", "", false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.EqualFold(seg, ".git") {
			return "", "", false
		}
	}
	return abs, rel, true
}

// treeChanged tells the caches keyed on a path that the files at rel -- one
// file, or a whole folder -- were rewritten, appeared or went away on disk.
// Follow a batch of them with one fsChanged.
func (s *Server) treeChanged(abs, rel string, dir bool) {
	if dir {
		render.EvictAll()
	} else {
		render.Evict(abs)
	}
	if s.lsp != nil {
		s.lsp.CloseDoc(abs, rel)
	}
	s.ix.TouchTree(rel)
}

// fsChanged follows treeChanged calls: language servers re-read the documents
// they have open (closing those that no longer exist), git status is
// refreshed, and, when the tree changed shape, its listeners are told.
func (s *Server) fsChanged(tree bool) {
	if s.lsp != nil {
		s.lsp.RefreshOpenDocs()
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
		if tree {
			s.gitWatcher.NotifyTree()
		}
	}
}

// handleFSRename moves a file or folder within the workspace (POST {from,
// to}), creating to's missing parent folders. It never overwrites anything.
func (s *Server) handleFSRename(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	fromAbs, fromRel, ok1 := s.editablePath(req.From)
	toAbs, toRel, ok2 := s.editablePath(req.To)
	if !ok1 || !ok2 {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}
	from, err := os.Lstat(fromAbs)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	if fromRel == toRel {
		writeJSON(w, map[string]any{"ok": true, "path": toRel})
		return
	}
	// On a case-insensitive disk "a.go" -> "A.go" finds the file itself at
	// the destination; that is a rename, not a collision.
	if to, err := os.Lstat(toAbs); err == nil && !(strings.EqualFold(fromRel, toRel) && os.SameFile(from, to)) {
		fail(w, http.StatusConflict, "already exists: "+toRel)
		return
	}
	if from.IsDir() && strings.HasPrefix(toRel, fromRel+"/") {
		fail(w, http.StatusBadRequest, "cannot move a folder into itself")
		return
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		fail(w, http.StatusInternalServerError, "failed to create parent directory: "+err.Error())
		return
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		fail(w, http.StatusInternalServerError, "failed to rename: "+err.Error())
		return
	}
	s.treeChanged(fromAbs, fromRel, from.IsDir())
	s.treeChanged(toAbs, toRel, from.IsDir())
	s.fsChanged(true)
	writeJSON(w, map[string]any{"ok": true, "path": toRel})
}

// handleFSDelete deletes a file, or a folder and everything in it (POST
// {path}).
func (s *Server) handleFSDelete(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	abs, rel, ok := s.editablePath(req.Path)
	if !ok {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}
	st, err := os.Lstat(abs)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		fail(w, http.StatusInternalServerError, "failed to delete: "+err.Error())
		return
	}
	s.treeChanged(abs, rel, st.IsDir())
	s.fsChanged(true)
	writeJSON(w, map[string]any{"ok": true})
}

// handleDiff returns the unified diff of a file against HEAD. available is false
// (with an empty diff and 200) when git is off/absent or the file is unchanged.
//
// In a PR review session, "diff" stays the full merge-base..working-tree diff
// for backward compatibility, but the response also splits it into prDiff
// (diffBase..prHeadSHA -- the PR's own, frozen change) and yourDiff
// (prHeadSHA..working-tree -- what the reviewer has edited/committed locally
// since checkout). Committing in that session only ever changes yourDiff, so
// the frontend can label the two apart instead of showing one blended diff
// that looks the same whether or not the reviewer has touched anything.
func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	// compare names a second file: the diff is from it to path, two files
	// side by side rather than a file against git.
	if other := r.URL.Query().Get("compare"); other != "" {
		s.handleCompare(w, other, abs, rel)
		return
	}
	// A ref names one local commit to read instead of the working tree: the
	// diff that commit itself made to this file, frozen regardless of what has
	// been edited since. Empty ref -> today's working-tree-vs-diffBase diff.
	if ref := r.URL.Query().Get("ref"); ref != "" {
		base := r.URL.Query().Get("base")
		var diff string
		if base != "" && validSHA(base) && validSHA(ref) {
			diff = gitDiffBetween(s.ix.Root(), rel, base, ref)
		} else {
			diff = gitDiffCommit(s.ix.Root(), rel, ref)
		}
		writeJSON(w, map[string]any{
			"path":      rel,
			"ref":       ref,
			"base":      base,
			"diff":      diff,
			"hunks":     render.HighlightDiff(rel, diff),
			"available": diff != "",
		})
		return
	}
	diff := gitDiffAgainst(s.ix.Root(), rel, s.diffBase)
	if ui.Verbose {
		status := "clean"
		if diff != "" {
			lines := strings.Count(diff, "\n")
			status = fmt.Sprintf("%d diff lines", lines)
		}
		ui.Status("info", "diff", fmt.Sprintf("%s · %s", rel, status), 0, os.Stdout)
	}
	avail := diff != ""
	resp := map[string]any{
		"path":  rel,
		"diff":  diff,
		"hunks": render.HighlightDiff(rel, diff),
	}
	if s.pr != nil {
		prDiff := gitDiffBetween(s.ix.Root(), rel, s.diffBase, s.prHeadSHA)
		yourDiff := gitDiffAgainst(s.ix.Root(), rel, s.prHeadSHA)
		resp["prDiff"] = prDiff
		resp["yourDiff"] = yourDiff
		resp["prHunks"] = render.HighlightDiff(rel, prDiff)
		resp["yourHunks"] = render.HighlightDiff(rel, yourDiff)
		avail = avail || prDiff != "" || yourDiff != ""
	}
	resp["available"] = avail
	writeJSON(w, resp)
}

// handleCompare diffs two files of the workspace, left (the original) to
// right, the way an editor's "Compare with Selected" does. Neither needs to be
// tracked, or even inside a repository: `git diff --no-index` only needs git.
func (s *Server) handleCompare(w http.ResponseWriter, left, rightAbs, rightRel string) {
	leftAbs, leftRel, ok := s.resolvePath(left)
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	for _, p := range []string{leftAbs, rightAbs} {
		st, err := os.Stat(p)
		if err != nil {
			fail(w, 404, err.Error())
			return
		}
		if st.IsDir() {
			fail(w, 400, filepath.Base(p)+" is a directory")
			return
		}
	}
	diff, binary, err := diffFiles(leftAbs, rightAbs)
	if err != nil {
		fail(w, 503, err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"path":      rightRel,
		"compare":   leftRel,
		"diff":      diff,
		"hunks":     render.HighlightDiff(rightRel, diff),
		"binary":    binary,
		"identical": diff == "",
		"available": true,
	})
}

// handleGutter returns per-file changed-line ranges (new-file line numbers) for
// a VS Code-style change gutter. available is false (200, empty arrays) when
// git is off/absent or the file is unchanged/untracked; never 500 for those.
func (s *Server) handleGutter(w http.ResponseWriter, r *http.Request) {
	_, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	var added, modified, deleted []int
	if ref := r.URL.Query().Get("ref"); ref != "" {
		added, modified, deleted = gitHunksCommit(s.ix.Root(), rel, ref)
	} else {
		added, modified, deleted = gitHunksAgainst(s.ix.Root(), rel, s.diffBase)
	}
	nz := func(v []int) []int { // marshal as [] not null
		if v == nil {
			return []int{}
		}
		return v
	}
	writeJSON(w, map[string]any{
		"path":      rel,
		"available": added != nil || modified != nil || deleted != nil,
		"added":     nz(added),
		"modified":  nz(modified),
		"deleted":   nz(deleted),
	})
}

// handleEventStream streams real-time workspace events (git status notifications and process metrics) via Server-Sent Events (SSE).
func (s *Server) handleEventStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	includeMetrics := r.URL.Path != s.routePath("/api/git/stream")

	// 1. Immediately send initial metrics on connection (for unified stream)
	if includeMetrics {
		if mBytes, err := json.Marshal(getProcessMetrics(s.lsp)); err == nil {
			if _, err := fmt.Fprintf(w, "event: metrics\ndata: %s\n\n", mBytes); err != nil {
				return
			}
			flusher.Flush()
		}
	}

	// 2. Subscribe to git watcher if available
	var gitCh <-chan []byte
	if s.gitWatcher != nil {
		var cancel func()
		gitCh, cancel = s.gitWatcher.Subscribe()
		defer cancel()
	}

	// 3. Periodic metrics ticker (2500ms) for unified stream
	var metricsTicker *time.Ticker
	var metricsC <-chan time.Time
	if includeMetrics {
		metricsTicker = time.NewTicker(2500 * time.Millisecond)
		defer metricsTicker.Stop()
		metricsC = metricsTicker.C
	}

	// 4. Heartbeat ticker (15s) in case gitWatcher is disabled or not ticking
	heartbeatTicker := time.NewTicker(15 * time.Second)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.streamsDone:
			return

		case msg, ok := <-gitCh:
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()

		case <-metricsC:
			if mBytes, err := json.Marshal(getProcessMetrics(s.lsp)); err == nil {
				if _, err := fmt.Fprintf(w, "event: metrics\ndata: %s\n\n", mBytes); err != nil {
					return
				}
				flusher.Flush()
			}

		case <-heartbeatTicker.C:
			if _, err := fmt.Fprintf(w, "event: ping\ndata: {}\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// handleGitRefresh triggers an immediate git status check and returns the latest git summary.
func (s *Server) handleGitRefresh(w http.ResponseWriter, r *http.Request) {
	if s.gitWatcher != nil {
		payload := s.gitWatcher.Refresh()
		writeJSON(w, payload)
		return
	}
	count, files := s.ix.GitChanges()
	writeJSON(w, map[string]any{
		"git":        gitAvailable(s.ix.Root()),
		"gitChanges": count,
		"gitFiles":   files,
		"statuses":   s.ix.GitStatusMap(),
	})
}

// decodeGitPaths reads the files a git action applies to: {"path": p},
// {"paths": [...]}, or, when all is allowed, {"all": true} for the whole
// served root (returned as ""). Every path is workspace-relative.
func (s *Server) decodeGitPaths(w http.ResponseWriter, r *http.Request, all bool) ([]string, bool) {
	var body struct {
		Path  string   `json:"path"`
		Paths []string `json:"paths"`
		All   bool     `json:"all"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return nil, false
	}
	if body.All && all {
		return []string{""}, true
	}
	raw := body.Paths
	if body.Path != "" {
		raw = append(raw, body.Path)
	}
	if len(raw) == 0 {
		fail(w, http.StatusBadRequest, "path is required")
		return nil, false
	}
	rels := make([]string, 0, len(raw))
	for _, p := range raw {
		_, rel, ok := s.safePath(p)
		if !ok || (rel == "" && !all) {
			fail(w, http.StatusBadRequest, "bad path: "+p)
			return nil, false
		}
		rels = append(rels, rel)
	}
	return rels, true
}

// gitChanged reports a git action's result the way stage always has: the
// fresh status payload (also pushed to every listener), or just ok.
func (s *Server) gitChanged(w http.ResponseWriter) {
	if s.gitWatcher != nil {
		writeJSON(w, s.gitWatcher.Refresh())
		return
	}
	s.ix.UpdateGitStatus()
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitStatus serves the Source Control view: staged changes, working
// tree changes, conflicts, and where the branch stands (GET).
func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rep := gitStatusReport(s.ix.Root())
	if rep.Git && s.pr != nil {
		// A PR checkout is a detached HEAD with no upstream of its own: it
		// pushes to the PR's head branch, and is ahead by the commits made
		// on top of what that branch holds.
		s.pr.mu.Lock()
		head, branch := s.pr.remoteHead(), s.pr.meta.HeadRef
		s.pr.mu.Unlock()
		rep.Upstream = branch
		rep.Ahead, rep.Behind = gitCountSince(s.ix.Root(), head), 0
	}
	writeJSON(w, rep)
}

// handleGitShow serves one file as it is at a ref, for the left (or right)
// side of a diff editor (GET ?path=&ref=). ref is HEAD (the default), INDEX
// (what is staged), BASE (what /api/diff compares the working tree with: the
// merge-base in a PR review, HEAD otherwise), a commit SHA, or a SHA with "^"
// for its first parent. The file need not exist on disk; one missing at ref
// is exists false, not an error.
func (s *Server) handleGitShow(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	_, rel, ok := s.safePath(q.Get("path"))
	if !ok || rel == "" {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}
	ref := q.Get("ref")
	if ref == "" {
		ref = "HEAD"
	}
	var rev string
	switch {
	case ref == "HEAD":
		rev = "HEAD"
	case ref == "INDEX":
		rev = "" // ":path" is the index
	case ref == "BASE":
		rev = s.diffBase
	case validSHA(ref):
		rev = ref
	case strings.HasSuffix(ref, "^") && validSHA(strings.TrimSuffix(ref, "^")):
		rev = ref
	default:
		fail(w, http.StatusBadRequest, "ref must be HEAD, INDEX, BASE, a commit SHA, or a SHA followed by ^")
		return
	}
	if !gitAvailable(s.ix.Root()) {
		writeJSON(w, map[string]any{
			"path": rel, "ref": ref, "exists": false,
			"binary": false, "tooLarge": false, "text": "", "size": 0, "eol": "\n",
		})
		return
	}
	data, size, exists, dir, err := gitBlob(s.ix.Root(), rev, rel, maxTextBytes)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if dir {
		fail(w, http.StatusBadRequest, "is a directory")
		return
	}
	t := fileText{Path: rel, Size: size, EOL: "\n"}
	if exists && data == nil && size > maxTextBytes {
		t.TooLarge = true
	} else if exists {
		t.textOf(data)
	}
	writeJSON(w, map[string]any{
		"path": rel, "ref": ref, "exists": exists,
		"binary": t.Binary, "tooLarge": t.TooLarge, "text": t.Text,
		"size": t.Size, "eol": t.EOL,
	})
}

// handleGitStage adds files to the index (POST {path}, {paths} or {all}).
func (s *Server) handleGitStage(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	rels, ok := s.decodeGitPaths(w, r, true)
	if !ok {
		return
	}
	if err := gitStagePaths(s.ix.Root(), rels); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	s.gitChanged(w)
}

// handleGitUnstage removes files from the index without touching the
// working tree (POST {path}, {paths} or {all}).
func (s *Server) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	rels, ok := s.decodeGitPaths(w, r, true)
	if !ok {
		return
	}
	if err := gitUnstagePaths(s.ix.Root(), rels); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	s.gitChanged(w)
}

// handleGitDiscard throws away the working tree's changes to files (POST
// {paths} or {path}): tracked files go back to their staged version,
// untracked ones are deleted. Never the whole root at once, and never .git.
func (s *Server) handleGitDiscard(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	rels, ok := s.decodeGitPaths(w, r, false)
	if !ok {
		return
	}
	root := s.ix.Root()
	for _, rel := range rels {
		if _, _, ok := s.editablePath(rel); !ok {
			fail(w, http.StatusBadRequest, "bad path: "+rel)
			return
		}
	}
	removed, err := gitDiscardPaths(root, rels)
	for _, rel := range append(rels, removed...) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		st, statErr := os.Stat(abs)
		s.treeChanged(abs, rel, statErr == nil && st.IsDir())
	}
	// Restoring brings deleted files back and removing takes untracked ones
	// away: either way the tree may have changed shape.
	s.fsChanged(true)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if s.gitWatcher != nil {
		writeJSON(w, struct {
			OK bool `json:"ok"`
			GitStatusPayload
		}{true, s.gitWatcher.Refresh()})
		return
	}
	s.ix.UpdateGitStatus()
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitHunk stages, unstages, or discards a single unified diff hunk
// (POST {path, hunk, action}).
func (s *Server) handleGitHunk(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var body struct {
		Path   string `json:"path"`
		Hunk   string `json:"hunk"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil || body.Path == "" || body.Hunk == "" || body.Action == "" {
		fail(w, http.StatusBadRequest, "path, hunk, and action are required")
		return
	}
	abs, rel, ok := s.safePath(body.Path)
	if !ok || rel == "" {
		fail(w, http.StatusBadRequest, "bad path")
		return
	}
	if err := gitApplyHunk(s.ix.Root(), rel, body.Hunk, body.Action); err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if body.Action == "discard" {
		render.Evict(abs)
		if s.lsp != nil {
			s.lsp.CloseDoc(abs, rel)
			s.lsp.RefreshOpenDocs()
		}
		s.ix.TouchPath(rel)
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
	writeJSON(w, map[string]any{"ok": true, "path": rel, "action": body.Action})
}

// handleGitCommit commits whatever is currently staged (POST {message}),
// staging everything first when nothing is. With amend it replaces the last
// commit instead: with what is staged (and only that), keeping the old
// message when message is empty.
func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var body struct {
		Message string `json:"message"`
		Amend   bool   `json:"amend"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil || (strings.TrimSpace(body.Message) == "" && !body.Amend) {
		fail(w, http.StatusBadRequest, "message is required")
		return
	}
	root := s.ix.Root()
	var err error
	if body.Amend {
		err = gitCommitAmend(root, strings.TrimSpace(body.Message))
	} else {
		if len(gitStagedPaths(root)) == 0 && gitHasUncommittedChanges(root) {
			_ = gitStage(root, ".")
		}
		err = gitCommit(root, strings.TrimSpace(body.Message))
	}
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitPush pushes the current branch to its remote -- or, in a PR
// review session, pushes the worktree's HEAD to the PR's actual head branch
// (possibly a fork), which may itself be a fresh branch with no upstream.
func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	if s.pr != nil {
		// force is only sent after the reviewer confirmed pushing a rebased
		// PR branch; it is a lease, never a blind overwrite (prSession.Push).
		var body struct {
			Force bool `json:"force"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body)
		if op := gitOpInProgress(s.ix.Root()); op != "" {
			fail(w, http.StatusConflict, "a "+op+" is in progress; finish or abort it before pushing")
			return
		}
		if err := s.pr.Push(body.Force); err != nil {
			fail(w, http.StatusBadGateway, err.Error())
			return
		}
		// Pushed commits are part of the PR now: move the PR-head boundary so
		// they stop being "yours" (and the PR's file set picks them up).
		s.syncPRRefs()
		writeJSON(w, map[string]any{"ok": true})
		return
	}
	root := s.ix.Root()
	out, err := gitPush(root)
	if err != nil && strings.Contains(out, "has no upstream branch") {
		if branch := gitCurrentBranch(root); branch != "" && branch != "HEAD" {
			out, err = gitPushSetUpstream(root, "origin", branch)
		}
	}
	if err != nil {
		fail(w, http.StatusBadGateway, out)
		return
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitPull fast-forwards onto the latest remote -- or, in a PR review
// session, the PR's current head. Never merges: a non-fast-forward is
// refused outright (409), since resolving a real conflict isn't supported.
func (s *Server) handleGitPull(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	if s.pr != nil {
		if op := gitOpInProgress(s.ix.Root()); op != "" {
			st, _ := s.prSyncState(false)
			failSync(w, st, "a "+op+" is already in progress")
			return
		}
		info, err := s.pr.Pull()
		if err != nil {
			status := http.StatusBadGateway
			if errors.Is(err, errPRDiverged) {
				status = http.StatusConflict
			}
			fail(w, status, err.Error())
			return
		}
		s.syncPRRefs()
		writeJSON(w, map[string]any{"ok": true, "message": info})
		return
	}

	root := s.ix.Root()
	if op := gitOpInProgress(root); op != "" {
		failSync(w, s.gitSyncState(root), "a "+op+" is already in progress")
		return
	}
	if gitHasUncommittedChanges(root) {
		fail(w, http.StatusConflict, "commit or discard your local changes before pulling")
		return
	}
	branch := gitCurrentBranch(root)
	if branch == "" || branch == "HEAD" {
		fail(w, http.StatusBadRequest, "not on a branch")
		return
	}
	remote, remoteBranch, ok := gitUpstream(root, branch)
	if !ok {
		fail(w, http.StatusBadRequest, "no upstream branch configured for "+branch)
		return
	}
	if err := gitFFOnlyPull(root, remote, remoteBranch); err != nil {
		if errors.Is(err, errNotFastForward) {
			// The fetch already landed, so the counts reflect the remote as
			// it is now: the panel shows how far the two have diverged.
			st := s.gitSyncState(root)
			st.Code = "diverged"
			failSync(w, st, fmt.Sprintf("can't fast-forward: %s has diverged from %s", branch, st.Upstream))
			return
		}
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
	writeJSON(w, map[string]any{"ok": true, "message": "pulled the latest changes"})
}

// gitSyncState is where the current branch stands against its upstream:
// what the git panel shows when a pull refuses to fast-forward, or when a
// rebase or merge started elsewhere was left half-done.
type gitSyncState struct {
	Code       string `json:"code,omitempty"` // "diverged" or "in-progress" on a refused pull
	Branch     string `json:"branch"`
	Upstream   string `json:"upstream"` // e.g. "origin/main"; empty when none is configured; a PR's base branch name
	Ahead      int    `json:"ahead"`
	Behind     int    `json:"behind"`
	InProgress string `json:"inProgress,omitempty"` // an operation left half-done (gitOpInProgress)
	Dirty      bool   `json:"dirty"`

	// PR review sessions only: the PR number, and whether the checkout was
	// rewritten (rebased) past the PR head on the remote, so only a
	// force-push can update the PR.
	PR        int  `json:"pr,omitempty"`
	Rewritten bool `json:"rewritten,omitempty"`
}

// syncPRRefs copies the PR session's head and merge-base into the server and
// index after anything moved them (push, pull), so diffs, the file tree and
// the ahead count all measure from the new boundary.
func (s *Server) syncPRRefs() {
	s.pr.mu.Lock()
	s.diffBase = s.pr.diffBase
	s.prHeadSHA = s.pr.meta.HeadSHA
	s.pr.mu.Unlock()
	if s.ix != nil {
		s.ix.SetDiffBase(s.diffBase)
		s.ix.SetPRHead(s.prHeadSHA)
		s.ix.SetPushedHead(s.prHeadSHA)
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
}

// prSyncState is gitSyncState for a PR review: the detached checkout
// against the PR's base branch rather than an upstream. With fetch it
// refreshes the base first (a network call), as a rebase must start from
// the base as it is now.
func (s *Server) prSyncState(fetch bool) (gitSyncState, error) {
	p := s.pr
	root := s.ix.Root()
	p.mu.Lock()
	st := gitSyncState{PR: p.meta.Number, Branch: p.meta.HeadRef, Upstream: p.meta.BaseRef}
	p.mu.Unlock()
	st.InProgress = gitOpInProgress(root)
	if st.InProgress != "" {
		st.Code = "in-progress"
	}
	var err error
	if fetch && st.InProgress == "" {
		_, err = p.FetchBase()
	}
	st.Ahead, st.Behind = gitAheadBehindRef(root, prBaseRef(st.PR))
	st.Rewritten = p.Rewritten()
	st.Dirty = gitHasUncommittedChanges(root)
	return st, err
}

func (s *Server) gitSyncState(root string) gitSyncState {
	st := gitSyncState{Branch: gitCurrentBranch(root), InProgress: gitOpInProgress(root)}
	if st.InProgress != "" {
		st.Code = "in-progress"
	}
	if st.InProgress == "rebase" {
		if b := gitRebasingBranch(root); b != "" {
			st.Branch = b
		}
	}
	if st.Branch != "" && st.Branch != "HEAD" {
		if remote, rb, ok := gitUpstream(root, st.Branch); ok {
			st.Upstream = remote + "/" + rb
		}
	}
	st.Ahead, st.Behind, _ = gitAheadBehind(root)
	st.Dirty = gitHasUncommittedChanges(root)
	return st
}

// failSync is a 409 that carries the sync state alongside the message, so
// the panel can render the next step instead of just the refusal.
func failSync(w http.ResponseWriter, st gitSyncState, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
		gitSyncState
	}{msg, st})
}

// handleGitSyncState reports the branch's standing against its upstream,
// including a rebase or merge left half-done (from a terminal), so the panel
// can offer to abort it.
func (s *Server) handleGitSyncState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.pr != nil {
		st, err := s.prSyncState(r.URL.Query().Get("fetch") == "1")
		if err != nil {
			fail(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, st)
		return
	}
	if !gitAvailable(s.ix.Root()) {
		writeJSON(w, gitSyncState{})
		return
	}
	writeJSON(w, s.gitSyncState(s.ix.Root()))
}

// handleGitAbort aborts a rebase, merge, cherry-pick or revert left in progress.
func (s *Server) handleGitAbort(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	if err := gitAbortOp(s.ix.Root()); err != nil {
		fail(w, http.StatusConflict, err.Error())
		return
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleGitLog returns recent commits from HEAD (?limit=, default 5, at
// most 200; ?skip= pages further back).
func (s *Server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	limit := 5
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
	branch := gitCurrentBranch(s.ix.Root())
	commits := gitLog(s.ix.Root(), limit, max(skip, 0))
	commitsURL := gitCommitsWebURL(s.ix.Root(), branch)
	writeJSON(w, map[string]any{
		"commits":    commits,
		"commitsUrl": commitsURL,
	})
}

// handleUnpushed lists the commits that exist locally but not on the tracking
// branch (@{u}..HEAD), newest first, plus the name of that tracking branch so
// the sidebar can say what the list is measured against. available is false
// (200, empty list) when git is off, no upstream is configured, or nothing is
// ahead -- there is no guessed fallback branch, since measuring against the
// wrong ref is worse than showing nothing.
func (s *Server) handleUnpushed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	limit := 0
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			limit = n
		}
	}
	var upstream string
	var commits []UnpushedCommit
	if s.pr != nil {
		// Detached PR checkout: your commits are everything past the PR head.
		s.pr.mu.Lock()
		head, branch := s.pr.remoteHead(), s.pr.meta.HeadRef
		s.pr.mu.Unlock()
		commits = gitCommitsSince(s.ix.Root(), head, limit)
		upstream = fmt.Sprintf("PR #%d head (%s)", s.pr.meta.Number, branch)
	} else {
		upstream, commits = gitUnpushedCommits(s.ix.Root(), limit)
	}
	if commits == nil {
		commits = []UnpushedCommit{}
	}
	writeJSON(w, map[string]any{
		"available": upstream != "" && len(commits) > 0,
		"upstream":  upstream,
		"commits":   commits,
	})
}

// handleCommitFiles returns the paths one commit touched, badged with git's
// name-status letter. Unknown SHAs come back as an empty list, not an error:
// the only way to ask for one is from a list px0 handed out, and a commit
// that has since been rewritten is a stale click, not a failure worth a toast.
func (s *Server) handleCommitFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	sha := r.URL.Query().Get("sha")
	files := gitCommitFiles(s.ix.Root(), sha)
	if files == nil {
		files = []CommitFile{}
	}
	writeJSON(w, map[string]any{"sha": sha, "files": files})
}

// handleCommitDetail returns one commit's author, full message and diffstat
// for the hover card.
func (s *Server) handleCommitDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	sha := r.URL.Query().Get("sha")
	d, ok := gitCommitDetail(s.ix.Root(), sha)
	if !ok {
		fail(w, http.StatusNotFound, "unknown commit")
		return
	}
	writeJSON(w, d)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	q := r.URL.Query()
	opts := SearchOpts{
		Query: q.Get("q"),
		Regex: q.Get("re") == "1",
		Case:  q.Get("case") == "1",
		Word:  q.Get("word") == "1",
		Glob:  q.Get("glob"),
	}
	res, truncated, err := SearchContext(r.Context(), s.ix, opts)
	if err != nil {
		if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
			return
		}
		fail(w, 400, err.Error())
		return
	}
	total := 0
	for _, f := range res {
		total += len(f.Matches)
	}
	if res == nil {
		res = []FileMatches{} // an empty result is [], never null
	}
	if ui.Verbose && opts.Query != "" {
		dur := ui.FmtDuration(time.Since(start))
		matchStr := "matches"
		if total == 1 {
			matchStr = "match"
		}
		fileStr := "files"
		if len(res) == 1 {
			fileStr = "file"
		}
		truncStr := ""
		if truncated {
			truncStr = " (truncated)"
		}
		ui.Status("info", "search", fmt.Sprintf("%q · %d %s in %d %s%s  (%s)", opts.Query, total, matchStr, len(res), fileStr, truncStr, dur), 0, os.Stdout)
	}
	writeJSON(w, map[string]any{"results": res, "files": len(res), "total": total, "truncated": truncated})
}

func (s *Server) handleOutline(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	abs, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	syms, err := symbols.Outline(abs, rel)
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	if syms == nil {
		syms = []symbols.Symbol{}
	}
	if ui.Verbose {
		ui.Status("info", "outline", fmt.Sprintf("%s · %d symbols  (%s)", rel, len(syms), ui.FmtDuration(time.Since(start))), 0, os.Stdout)
	}
	writeJSON(w, map[string]any{"path": rel, "symbols": syms})
}

// handleDef approximates go-to-definition: a whole-word search across the
// index, with lines that look like declarations floated to the top.
func (s *Server) handleDef(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	sym := strings.TrimSpace(r.URL.Query().Get("sym"))
	if sym == "" {
		fail(w, 400, "no symbol")
		return
	}
	res, _, err := SearchContext(r.Context(), s.ix, SearchOpts{
		Query: sym, Word: true, Case: true,
		MaxFiles: 400, MaxPerFil: 20, classifyDefs: true,
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
			return
		}
		fail(w, 400, err.Error())
		return
	}
	type hit struct {
		Path string `json:"path"`
		Match
	}
	var defs []hit
	refs := 0
	seen := map[string]bool{}
	for _, f := range res {
		for _, m := range f.Matches {
			if !m.Def {
				refs++
				continue
			}
			// One entry per declaring line, however often the name repeats on it.
			k := f.Path + ":" + strconv.Itoa(m.Line)
			if seen[k] {
				continue
			}
			seen[k] = true
			defs = append(defs, hit{f.Path, m})
		}
	}
	// Prefer declarations in files whose name echoes the symbol.
	low := strings.ToLower(sym)
	sort.SliceStable(defs, func(i, j int) bool {
		a := strings.Contains(strings.ToLower(filepath.Base(defs[i].Path)), low)
		b := strings.Contains(strings.ToLower(filepath.Base(defs[j].Path)), low)
		return a && !b
	})
	state, server := s.lsp.State(r.URL.Query().Get("path"))
	if defs == nil {
		defs = []hit{}
	}
	if ui.Verbose {
		dur := ui.FmtDuration(time.Since(start))
		defStr := "definitions"
		if len(defs) == 1 {
			defStr = "definition"
		}
		ui.Status("info", "def", fmt.Sprintf("%q · %d %s, %d refs  (%s)", sym, len(defs), defStr, refs, dur), 0, os.Stdout)
	}
	writeJSON(w, map[string]any{
		"symbol": sym, "defs": defs, "refCount": refs,
		"lsp": map[string]any{"state": string(state), "server": server},
	})
}

func (s *Server) handleReindex(w http.ResponseWriter, r *http.Request) {
	render.EvictAll()
	s.ix.Build()
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
	if s.lsp != nil {
		s.lsp.RefreshOpenDocs()
	}
	n, _, ms := s.ix.Stats()
	gitCount, gitFiles := s.ix.GitChanges()
	writeJSON(w, map[string]any{"files": n, "indexMs": ms, "gitChanges": gitCount, "gitFiles": gitFiles})
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{
			"settings": settings.ReadMergedMap(),
			"defaults": settings.DefaultMap(),
			"schema":   settings.Schema,
			"raw":      settings.ReadRawJSON(),
			"path":     settings.Path(),
		})
	case http.MethodPost:
		if !localPost(w, r) {
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
		if err != nil {
			fail(w, 400, "failed to read body")
			return
		}
		var payload map[string]any
		if len(body) > 0 {
			if err := json.Unmarshal(body, &payload); err != nil {
				fail(w, 400, "invalid JSON: "+err.Error())
				return
			}
		} else {
			payload = make(map[string]any)
			for k, vs := range r.URL.Query() {
				if len(vs) > 0 {
					payload[k] = vs[0]
				}
			}
		}

		if rawStr, ok := payload["raw"].(string); ok {
			if err := settings.SaveRawJSON([]byte(rawStr)); err != nil {
				fail(w, 400, "invalid JSON in settings: "+err.Error())
				return
			}
		} else {
			if err := settings.UpdateMap(payload); err != nil {
				fail(w, 500, err.Error())
				return
			}
		}

		writeJSON(w, map[string]any{
			"settings": settings.ReadMergedMap(),
			"raw":      settings.ReadRawJSON(),
			"path":     settings.Path(),
			"ok":       true,
		})
	default:
		fail(w, 405, "method not allowed")
	}
}

// ---------------------------------------------------------------- LSP setup & control HTTP handlers

// localPost admits a request that changes the machine only when it is a POST
// from px0's own page. Browsers send Origin on every POST, so a page from another
// site cannot pass. Requiring the Host to be an IP address or localhost also
// shuts out DNS rebinding, where an attacker's domain is pointed at this machine
// and its Origin would otherwise match.
func localPost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "POST only")
		return false
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host != "localhost" && net.ParseIP(host) == nil {
		fail(w, http.StatusForbidden, "open px0 by IP address or localhost to set up language servers")
		return false
	}
	if o, err := url.Parse(r.Header.Get("Origin")); err != nil || o.Host != r.Host {
		fail(w, http.StatusForbidden, "request did not come from px0")
		return false
	}
	return true
}

func (s *Server) handleLSPSetup(w http.ResponseWriter, r *http.Request) {
	if s.lsp == nil {
		fail(w, 503, "language servers are disabled")
		return
	}
	_, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path")
		return
	}
	writeJSON(w, s.lsp.Setup(rel))
}

func (s *Server) handleLSPInstall(w http.ResponseWriter, r *http.Request) {
	if s.lsp == nil {
		fail(w, 503, "language servers are disabled")
		return
	}
	if !localPost(w, r) {
		return
	}
	q := r.URL.Query()
	option, _ := strconv.Atoi(q.Get("option"))
	j, err := s.lsp.Install(q.Get("server"), option)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	writeJSON(w, j)
}

func (s *Server) relevantLSPServers() []map[string]any {
	if s.lsp == nil || !s.lsp.Enabled() {
		return []map[string]any{}
	}

	extMap := map[string]bool{}
	if s.ix != nil {
		for _, f := range s.ix.Files() {
			ext := strings.ToLower(filepath.Ext(f.Path))
			if ext != "" {
				extMap[ext] = true
			}
		}
	}

	seen := map[string]bool{}
	var result []map[string]any

	// 1. Add servers matching extensions present in the workspace
	for i := range lspRegistry {
		def := &lspRegistry[i]
		matchesExt := false
		for _, ext := range def.Exts {
			if extMap[ext] {
				matchesExt = true
				break
			}
		}
		if matchesExt && !seen[def.Name] {
			seen[def.Name] = true
			result = append(result, s.lsp.ServerStatus(def))
		}
	}

	// 2. Also include any server that is currently running or starting.
	// Snapshot the names under RLock first: ServerStatus takes m.mu.RLock
	// itself, and Go's RWMutex is not reentrant, so holding the lock across
	// the call would deadlock.
	s.lsp.mu.RLock()
	var extra []string
	for name := range s.lsp.clients {
		if !seen[name] {
			extra = append(extra, name)
		}
	}
	for name := range s.lsp.starting {
		if !seen[name] {
			extra = append(extra, name)
		}
	}
	s.lsp.mu.RUnlock()
	for _, name := range extra {
		for i := range lspRegistry {
			if lspRegistry[i].Name == name {
				seen[name] = true
				result = append(result, s.lsp.ServerStatus(&lspRegistry[i]))
				break
			}
		}
	}

	return result
}

// handleLSPServers returns the list of all language servers relevant to the workspace
// along with their runtime states.
func (s *Server) handleLSPServers(w http.ResponseWriter, r *http.Request) {
	if s.lsp == nil {
		writeJSON(w, map[string]any{
			"enabled":    false,
			"anyRunning": false,
			"servers":    []any{},
		})
		return
	}
	servers := s.relevantLSPServers()
	anyRunning := false
	for _, srv := range servers {
		if r, ok := srv["running"].(bool); ok && r {
			anyRunning = true
			break
		}
	}
	if !anyRunning && s.lsp.AnyRunning() {
		anyRunning = true
	}
	writeJSON(w, map[string]any{
		"enabled":    s.lsp.Enabled(),
		"anyRunning": anyRunning,
		"servers":    servers,
	})
}

// handleLSPStop stops a running language server or all servers.
func (s *Server) handleLSPStop(w http.ResponseWriter, r *http.Request) {
	if s.lsp == nil {
		fail(w, 503, "language servers are disabled")
		return
	}
	if !localPost(w, r) {
		return
	}
	server := r.URL.Query().Get("server")
	if server == "" {
		var body struct {
			Server string `json:"server"`
		}
		if json.NewDecoder(r.Body).Decode(&body) == nil && body.Server != "" {
			server = body.Server
		}
	}
	s.lsp.Stop(server)
	s.handleLSPServers(w, r)
}

// handleLSPStart finds servers installed since startup, clears earlier start
// failures and starts the server for path or server name, reporting status.
func (s *Server) handleLSPStart(w http.ResponseWriter, r *http.Request) {
	if s.lsp == nil {
		fail(w, 503, "language servers are disabled")
		return
	}
	if !localPost(w, r) {
		return
	}
	server := r.URL.Query().Get("server")
	if server == "" {
		var body struct {
			Server string `json:"server"`
			All    bool   `json:"all"`
		}
		if json.NewDecoder(r.Body).Decode(&body) == nil {
			if body.All {
				server = "all"
			} else {
				server = body.Server
			}
		}
	}

	if server != "" {
		if server == "all" {
			servers := s.relevantLSPServers()
			for _, srv := range servers {
				if inst, _ := srv["installed"].(bool); inst {
					if name, _ := srv["name"].(string); name != "" {
						_ = s.lsp.StartServer(name)
					}
				}
			}
		} else {
			if err := s.lsp.StartServer(server); err != nil {
				fail(w, 400, err.Error())
				return
			}
		}
		s.handleLSPServers(w, r)
		return
	}

	_, rel, ok := s.resolvePath(r.URL.Query().Get("path"))
	if !ok {
		fail(w, 400, "bad path or server required")
		return
	}
	s.lsp.Rescan()
	ctx, cancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
	defer cancel()
	s.lsp.client(ctx, rel) // the spawn continues if this gives up waiting
	writeJSON(w, s.lspBrief(rel))
}

// lspBrief is the language server summary sent with a file: its state, and the
// language that lacks a server when none is installed, so the UI can offer one.
func (s *Server) lspBrief(rel string) map[string]any {
	state, srv := s.lsp.State(rel)
	b := map[string]any{
		"state":      string(state),
		"server":     srv,
		"anyRunning": s.lsp.AnyRunning(),
	}
	if lang := s.lsp.MissingLang(rel); lang != "" {
		b["missing"] = lang
	}
	return b
}

// ---------------------------------------------------------------- Workspace Session

// SessionTab represents an open editor tab pointing to a file path. Ref, when
// set, is the commit SHA the tab is pinned to -- a tab opened from the
// Unpushed sidebar section, showing that commit's own diff rather than the
// working tree's. A commit that no longer exists simply restores as an
// ordinary tab.
type SessionTab struct {
	Path string `json:"path"`
	Ref  string `json:"ref,omitempty"`
}

// WorkspaceSession stores the persistent UI state for a workspace:
// the list of open tabs, the currently active tab index, expanded directory tree paths,
// and any unsaved PR review comment drafts.
type WorkspaceSession struct {
	Tabs     []SessionTab `json:"tabs"`
	Active   int          `json:"active"`
	OpenDirs []string     `json:"openDirs"`
	Drafts   []prComment  `json:"drafts,omitempty"`
}

// sessionDir returns the directory holding session files: XDG_STATE_HOME/px0/sessions
// if available, falling back to ~/.px0/sessions or os.TempDir()/px0-sessions.
func sessionDir() string {
	if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" {
		return filepath.Join(xdg, "px0", "sessions")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".px0", "sessions")
	}
	return filepath.Join(os.TempDir(), "px0-sessions")
}

// sessionFilePath returns the path to the JSON file where workspace session state is saved.
// The file name is derived from the base path or an 8-byte SHA-256 hash of the cleaned
// workspace root path.
func sessionFilePath(basePath, root string) string {
	key := ""
	if basePath != "" && basePath != "/" {
		clean := strings.Trim(basePath, "/")
		clean = strings.ReplaceAll(clean, "/", "_")
		key = clean
	} else {
		h := sha256.Sum256([]byte(filepath.Clean(root)))
		key = hex.EncodeToString(h[:8])
	}
	return filepath.Join(sessionDir(), key+".json")
}

// prSessionFilePath returns the session file for a pull request, keyed on the PR
// itself (the workbench item ID) rather than the base path or checkout root. Every
// opening checks the PR out into a new temporary directory, so a root-keyed file
// would never be found again.
func prSessionFilePath(pt PRTarget) string {
	return filepath.Join(sessionDir(), "pr-"+wbPRItem(pt).ID+".json")
}

// newPRSessionManager opens the session file for a pull request.
func newPRSessionManager(pt PRTarget) *sessionManager {
	sm := &sessionManager{
		path: prSessionFilePath(pt),
		data: WorkspaceSession{Tabs: []SessionTab{}, OpenDirs: []string{}},
	}
	sm.load()
	return sm
}

// sessionManager coordinates concurrent thread-safe access and persistence
// for workspace session data on disk.
type sessionManager struct {
	mu   sync.Mutex
	path string
	data WorkspaceSession
}

// newSessionManager initializes a session manager for the given workspace,
// loading any existing session JSON file from disk.
func newSessionManager(basePath, root string) *sessionManager {
	p := sessionFilePath(basePath, root)
	sm := &sessionManager{
		path: p,
		data: WorkspaceSession{
			Tabs:     []SessionTab{},
			OpenDirs: []string{},
		},
	}
	sm.load()
	return sm
}

// load reads the session state from disk into memory, initializing empty slices if nil.
func (sm *sessionManager) load() {
	if sm.path == "" {
		return
	}
	data, err := os.ReadFile(sm.path)
	if err != nil {
		return
	}
	var s WorkspaceSession
	if err := json.Unmarshal(data, &s); err == nil {
		if s.Tabs == nil {
			s.Tabs = []SessionTab{}
		}
		if s.OpenDirs == nil {
			s.OpenDirs = []string{}
		}
		sm.data = s
	}
}

// Get returns a snapshot of the current workspace session.
func (sm *sessionManager) Get() WorkspaceSession {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	return sm.data
}

// Update executes a mutation function on the session state under mutex protection
// and persists the resulting state formatted as JSON to disk.
func (sm *sessionManager) Update(fn func(*WorkspaceSession)) WorkspaceSession {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	fn(&sm.data)
	if sm.path != "" {
		if err := os.MkdirAll(filepath.Dir(sm.path), 0o755); err == nil {
			if b, err := json.MarshalIndent(sm.data, "", "  "); err == nil {
				_ = os.WriteFile(sm.path, append(b, '\n'), 0o644)
			}
		}
	}
	return sm.data
}

// handleSession handles GET and POST requests for /api/session.
// GET returns the current workspace session state.
// POST updates tab list, active tab, and open directories, saving changes to disk.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, s.session.Get())
	case http.MethodPost:
		if !localPost(w, r) {
			return
		}
		var payload struct {
			Tabs     *[]SessionTab `json:"tabs"`
			Active   *int          `json:"active"`
			OpenDirs *[]string     `json:"openDirs"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err != nil {
			fail(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		updated := s.session.Update(func(ws *WorkspaceSession) {
			if payload.Tabs != nil {
				ws.Tabs = *payload.Tabs
			}
			if payload.Active != nil {
				ws.Active = *payload.Active
			}
			if payload.OpenDirs != nil {
				ws.OpenDirs = *payload.OpenDirs
			}
		})
		writeJSON(w, updated)
	default:
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
