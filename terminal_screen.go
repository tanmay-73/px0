package main

import "unicode/utf8"

// termScreen keeps what a page needs to redraw a terminal it re-attaches to
// (after a reload, or after falling behind): the output drawn on the normal
// screen, and the terminal modes in effect.
//
// Full-screen programs (vim, less, htop) draw on the alternate screen, and
// what they draw there never matters once they leave it: the terminal puts
// the normal screen back as it was. So that output is cut out of the
// replay, which keeps the shell's history from being pushed out by a
// program redrawing itself. While such a program is still running, the page
// replays the normal screen, switches to the alternate screen, and the
// program is asked to repaint (termProcess.Redraw).
//
// Modes (application cursor keys, bracketed paste, mouse reporting, a hidden
// cursor) may have been set long before the kept output starts, so they are
// followed through the whole stream and re-applied after the replay.
//
// Programs draw for the size the terminal had at the time (bash redraws its
// prompt on every resize), so resizes are kept with the output, and the page
// replays each part at its size, as VS Code's replay does.
//
// It is a tokenizer, not a terminal emulator: it follows escape sequences
// just far enough to find these, across reads that split them.
type termScreen struct {
	buf   []byte
	limit int        // buf is cut back to about this many bytes
	sizes []termSize // the size from each offset of buf on; sizes[0].at is 0

	alt    bool
	modes  map[int]bool // tracked DEC private modes, as last set
	keypad bool         // application keypad (ESC =)

	state   byte
	params  []byte
	private bool // CSI ? ...
	other   bool // CSI with another prefix (<, =, >) or intermediates: not a mode change
	seq     int  // offset in buf where the escape sequence being read began, or -1
}

const (
	stGround byte = iota
	stEsc
	stEscInter
	stCSI
	stString    // OSC, DCS, SOS, PM, APC: until BEL or ST
	stStringEsc // ESC inside a string: ST, or the start of a new sequence
)

// The DEC private modes worth restoring, with their power-on values.
var termModeDefaults = []struct {
	mode int
	on   bool
}{
	{1, false},    // application cursor keys
	{7, true},     // autowrap
	{25, true},    // cursor visible
	{1000, false}, // mouse: clicks
	{1002, false}, // mouse: drags
	{1003, false}, // mouse: all motion
	{1004, false}, // focus in/out reports
	{1005, false}, // mouse: UTF-8 coordinates
	{1006, false}, // mouse: SGR coordinates
	{1015, false}, // mouse: urxvt coordinates
	{2004, false}, // bracketed paste
}

// termSize is the terminal's size from offset at of the kept output on.
type termSize struct{ at, cols, rows int }

// termReplay is a part of the replay and the size it was drawn at.
type termReplay struct {
	cols, rows int
	data       []byte
}

func newTermScreen(limit, cols, rows int) *termScreen {
	return &termScreen{limit: limit, modes: map[int]bool{}, seq: -1, sizes: []termSize{{0, cols, rows}}}
}

// resize records that output from here on is drawn at a new size.
func (s *termScreen) resize(cols, rows int) {
	last := &s.sizes[len(s.sizes)-1]
	switch {
	case last.cols == cols && last.rows == rows:
	case last.at == len(s.buf):
		last.cols, last.rows = cols, rows
	default:
		s.sizes = append(s.sizes, termSize{len(s.buf), cols, rows})
	}
}

// dropFront moves the sizes when the first n bytes of buf go.
func (s *termScreen) dropFront(n int) {
	keep := 0
	for i := range s.sizes {
		s.sizes[i].at = max(0, s.sizes[i].at-n)
		if s.sizes[i].at == 0 {
			keep = i // the last size in effect at the new start
		}
	}
	s.sizes = s.sizes[keep:]
}

// truncated moves the sizes when buf is cut to its first n bytes: sizes
// set after that point (on the alternate screen) take effect at the end.
func (s *termScreen) truncated(n int) {
	out := s.sizes[:0]
	for _, z := range s.sizes {
		z.at = min(z.at, n)
		if len(out) > 0 && out[len(out)-1].at == z.at {
			out[len(out)-1] = z
		} else {
			out = append(out, z)
		}
	}
	s.sizes = out
}

// write follows a chunk of output.
func (s *termScreen) write(p []byte) {
	// start is the first byte of p not yet copied into buf; -1 while on the
	// alternate screen, whose output is not kept.
	start := 0
	if s.alt {
		start = -1
	}
	at := func(i int) int { // where p[i] lands in buf
		if start < 0 {
			return -1
		}
		return len(s.buf) + i - start
	}
	flush := func(end int) {
		if start >= 0 {
			s.buf = append(s.buf, p[start:end]...)
			start = end
		}
	}
	for i := 0; i < len(p); i++ {
		b := p[i]
		switch s.state {
		case stGround:
			if b == 0x1b {
				s.state, s.seq = stEsc, at(i)
			}
		case stEsc:
			s.state = stGround
			switch {
			case b == '[':
				s.state, s.params, s.private, s.other = stCSI, s.params[:0], false, false
			case b == ']' || b == 'P' || b == 'X' || b == '^' || b == '_':
				s.state = stString
			case b >= 0x20 && b <= 0x2f:
				s.state = stEscInter
			case b == 0x1b:
				s.state, s.seq = stEsc, at(i)
			case b == '=':
				s.keypad = true
			case b == '>':
				s.keypad = false
			case b == 'c': // full reset: nothing before it matters
				flush(i + 1)
				if s.alt {
					s.alt, s.buf, start = false, s.buf[:0], i+1
					s.truncated(0)
				} else if s.seq >= 0 {
					s.dropFront(s.seq)
					s.buf = s.buf[:copy(s.buf, s.buf[s.seq:])]
				}
				clear(s.modes)
				s.keypad = false
			}
		case stEscInter:
			if b == 0x1b {
				s.state, s.seq = stEsc, at(i)
			} else if b >= 0x30 && b <= 0x7e {
				s.state = stGround
			}
		case stCSI:
			switch {
			case b == '?' && len(s.params) == 0 && !s.private:
				s.private = true
			case b == '<' || b == '=' || b == '>' || (b >= 0x20 && b <= 0x2f):
				s.other = true
			case b >= 0x30 && b <= 0x3f:
				s.params = append(s.params, b)
			case b >= 0x40 && b <= 0x7e:
				s.state = stGround
				switch {
				case s.other:
				case s.private && (b == 'h' || b == 'l'):
					on := b == 'h'
					s.setModes(on)
					if on && s.altParam() && !s.alt {
						// Entering the alternate screen: drop this sequence
						// and everything drawn there.
						flush(i + 1)
						if s.seq >= 0 && s.seq <= len(s.buf) {
							s.buf = s.buf[:s.seq]
							s.truncated(s.seq)
						}
						s.alt, start = true, -1
					} else if !on && s.altParam() && s.alt {
						s.alt, start = false, i+1
					}
				case !s.private && b == 'J' && string(s.params) == "3" && !s.alt:
					// Erase scrollback (clear): what came before is gone.
					flush(i + 1)
					if s.seq >= 0 {
						s.dropFront(s.seq)
						s.buf = s.buf[:copy(s.buf, s.buf[s.seq:])]
					}
				}
			case b == 0x1b:
				s.state, s.seq = stEsc, at(i)
			}
		case stString:
			if b == 0x07 {
				s.state = stGround
			} else if b == 0x1b {
				s.state = stStringEsc
			}
		case stStringEsc:
			if b == '\\' {
				s.state = stGround
			} else {
				// Not a terminator: the ESC began a new sequence.
				s.state, s.seq = stEsc, at(i-1)
				i--
			}
		}
	}
	flush(len(p))
	s.trim()
}

// setModes records the tracked modes a CSI ? ... h/l sequence sets.
func (s *termScreen) setModes(on bool) {
	forEachParam(s.params, func(n int) {
		for _, m := range termModeDefaults {
			if m.mode == n {
				s.modes[n] = on
			}
		}
	})
}

// altParam reports whether the sequence switches screens (1049, 1047, 47).
func (s *termScreen) altParam() (alt bool) {
	forEachParam(s.params, func(n int) { alt = alt || n == 1049 || n == 1047 || n == 47 })
	return alt
}

func forEachParam(params []byte, fn func(int)) {
	n, seen := 0, false
	for _, c := range params {
		switch {
		case c >= '0' && c <= '9':
			if n < 1e6 {
				n = n*10 + int(c-'0')
			}
			seen = true
		case c == ';':
			if seen {
				fn(n)
			}
			n, seen = 0, false
		}
	}
	if seen {
		fn(n)
	}
}

// trim cuts buf back to its limit, at a line start, once it has grown to
// twice that, so the copying stays cheap under a flood of output.
func (s *termScreen) trim() {
	if len(s.buf) <= 2*s.limit {
		return
	}
	cut := len(s.buf) - s.limit
	for i := cut; i < len(s.buf) && i < cut+4096; i++ {
		if s.buf[i] == '\n' {
			cut = i + 1
			break
		}
	}
	s.dropFront(cut)
	s.buf = s.buf[:copy(s.buf, s.buf[cut:])]
	if s.seq >= 0 {
		s.seq = max(0, s.seq-cut)
	}
}

// replay is what a page writes into a fresh terminal to reach the current
// state, in parts drawn at different sizes: the kept output, then the
// screen and modes in effect. An escape sequence or character the output
// stops partway through goes after them, so the live output completes it.
func (s *termScreen) replay() []termReplay {
	hold := len(s.buf)
	if s.state != stGround && !s.alt && s.seq >= 0 && s.seq <= len(s.buf) {
		hold = s.seq
	} else {
		for i := len(s.buf) - 1; i >= 0 && i >= len(s.buf)-utf8.UTFMax; i-- {
			if !utf8.RuneStart(s.buf[i]) {
				continue
			}
			if !utf8.FullRune(s.buf[i:]) {
				hold = i
			}
			break
		}
	}
	var suffix []byte
	if s.alt {
		suffix = append(suffix, "\x1b[?1049h"...)
	}
	for _, m := range termModeDefaults {
		if on, set := s.modes[m.mode]; set && on != m.on {
			suffix = append(suffix, "\x1b[?"...)
			suffix = appendInt(suffix, m.mode)
			if on {
				suffix = append(suffix, 'h')
			} else {
				suffix = append(suffix, 'l')
			}
		}
	}
	if s.keypad {
		suffix = append(suffix, "\x1b="...)
	}
	out := make([]termReplay, 0, len(s.sizes))
	for i, z := range s.sizes {
		end := len(s.buf)
		if i+1 < len(s.sizes) {
			end = s.sizes[i+1].at
		}
		part := termReplay{cols: z.cols, rows: z.rows}
		if z.at <= hold && hold <= end && (i+1 == len(s.sizes) || hold < end) {
			part.data = make([]byte, 0, end-z.at+len(suffix))
			part.data = append(append(append(part.data, s.buf[z.at:hold]...), suffix...), s.buf[hold:end]...)
		} else {
			part.data = append([]byte(nil), s.buf[z.at:end]...)
		}
		out = append(out, part)
	}
	return out
}

// replayBytes is the replay as one stream, for tests.
func (s *termScreen) replayBytes() []byte {
	var b []byte
	for _, p := range s.replay() {
		b = append(b, p.data...)
	}
	return b
}

func appendInt(b []byte, n int) []byte {
	if n >= 10 {
		b = appendInt(b, n/10)
	}
	return append(b, byte('0'+n%10))
}
