//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
)

const termSupported = true

var defaultShells = []string{"bash", "zsh", "sh"}

// termProcess is a shell attached to a pseudo-terminal.
type termProcess interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int)
	Kill()
	Wait() int // the exit code
	Close()    // hangs up the terminal; a blocked Read returns
	Pid() int
	Foreground() string // name of the foreground process, or ""
	Cwd() string        // the shell's working directory, or ""
}

type unixTerm struct {
	cmd      *exec.Cmd
	pty      *os.File
	waitOnce sync.Once
	code     int
	exited   chan struct{}
}

// startTerm runs shell in a new pseudo-terminal. extra files are passed on
// as fd 3 and up.
func startTerm(shell string, args []string, cwd string, env []string, cols, rows int, extra ...*os.File) (termProcess, error) {
	cmd := exec.Command(shell, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.ExtraFiles = extra
	// pty.Start puts the shell in a session of its own with the terminal as
	// its controlling tty, so hanging up reaches every job it started.
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	// pty leaves the master in blocking mode, where Close cannot interrupt a
	// Read. Use a non-blocking duplicate, which Go's poller serves.
	m, err := nonblockingFile(f)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	return &unixTerm{cmd: cmd, pty: m, exited: make(chan struct{})}, nil
}

func nonblockingFile(f *os.File) (*os.File, error) {
	defer f.Close()
	syscall.ForkLock.RLock() // no child may inherit the duplicate
	fd, err := syscall.Dup(int(f.Fd()))
	if err == nil {
		syscall.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, err
	}
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), f.Name()), nil
}

func (t *unixTerm) Read(b []byte) (int, error) {
	n, err := t.pty.Read(b)
	// Linux reports EIO once the shell and its children have closed the tty.
	if err != nil && errors.Is(err, syscall.EIO) {
		err = os.ErrClosed
	}
	return n, err
}

func (t *unixTerm) Write(b []byte) (int, error) { return t.pty.Write(b) }

// ioctl runs on the descriptor without f.Fd(), which would switch it back
// to blocking mode.
func (t *unixTerm) ioctl(req uintptr, arg unsafe.Pointer) error {
	sc, err := t.pty.SyscallConn()
	if err != nil {
		return err
	}
	var errno syscall.Errno
	if err := sc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(arg))
	}); err != nil {
		return err
	}
	if errno != 0 {
		return errno
	}
	return nil
}

func (t *unixTerm) Resize(cols, rows int) {
	ws := pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}
	_ = t.ioctl(syscall.TIOCSWINSZ, unsafe.Pointer(&ws))
}

func (t *unixTerm) Pid() int { return t.cmd.Process.Pid }

// foregroundGroup is the terminal's foreground process group: the shell's
// at a prompt, the running program's otherwise.
func (t *unixTerm) foregroundGroup() int {
	var pgrp int32
	if t.ioctl(syscall.TIOCGPGRP, unsafe.Pointer(&pgrp)) != nil || pgrp <= 0 {
		return 0
	}
	return int(pgrp)
}

// Kill hangs up the terminal's process group, as closing a terminal window
// does, and kills it outright if it is still there a moment later.
func (t *unixTerm) Kill() {
	pid := t.Pid()
	_ = syscall.Kill(-pid, syscall.SIGHUP)
	go func() {
		select {
		case <-t.exited:
		case <-time.After(2 * time.Second):
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
	}()
}

func (t *unixTerm) Wait() int {
	t.waitOnce.Do(func() {
		err := t.cmd.Wait()
		t.code = 0
		if ee, ok := err.(*exec.ExitError); ok {
			t.code = ee.ExitCode()
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				t.code = 128 + int(ws.Signal())
			}
		} else if err != nil {
			t.code = -1
		}
		close(t.exited)
	})
	return t.code
}

func (t *unixTerm) Close() { _ = t.pty.Close() }

// Foreground names the foreground process group's leader (Linux).
func (t *unixTerm) Foreground() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	pg := t.foregroundGroup()
	if pg <= 0 {
		return ""
	}
	comm, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pg), "comm"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(comm))
}

// Cwd is the shell's working directory (Linux).
func (t *unixTerm) Cwd() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	dir, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(t.Pid()), "cwd"))
	if err != nil {
		return ""
	}
	return dir
}
