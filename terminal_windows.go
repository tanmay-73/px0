//go:build windows

package main

import (
	"errors"
	"os"
)

// The integrated terminal needs ConPTY on Windows, which px0 does not drive
// yet; terminalPolicy reports it as unsupported.
const termSupported = false

var defaultShells = []string{"powershell.exe", "cmd.exe"}

type termProcess interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int)
	Kill()
	Wait() int
	Close()
	Pid() int
	Foreground() string
	Cwd() string
}

func startTerm(shell string, args []string, cwd string, env []string, cols, rows int, extra ...*os.File) (termProcess, error) {
	return nil, errors.New("not supported on Windows")
}
