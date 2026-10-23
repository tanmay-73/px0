# px0 shell integration for bash (terminal.go embeds this file).
#
# Marks each prompt, command line, and exit code with VS Code's OSC 633
# sequences, so the terminal can decorate commands, step between them, and
# follow the working directory. bash reads this as its --init-file from a
# pipe on fd 3, so it first runs the startup files bash would have read.

builtin exec 3<&- # bash has read all of this file already

if [[ -n "${PX0_SHELL_LOGIN-}" ]]; then
	builtin unset PX0_SHELL_LOGIN
	# What bash -l reads (--init-file cannot be combined with -l).
	[[ -r /etc/profile ]] && builtin . /etc/profile
	if [[ -r ~/.bash_profile ]]; then builtin . ~/.bash_profile
	elif [[ -r ~/.bash_login ]]; then builtin . ~/.bash_login
	elif [[ -r ~/.profile ]]; then builtin . ~/.profile
	fi
else
	# bash reads /etc/bash.bashrc (or its distribution's equivalent) itself.
	[[ -r ~/.bashrc ]] && builtin . ~/.bashrc
fi

# Not an interactive shell, or loaded twice: leave it be.
if [[ $- != *i* || -n "${__px0_loaded-}" ]]; then
	builtin return 0 2>/dev/null
fi
__px0_loaded=1

# Ctrl+arrows move by word, as in most terminals, unless the user's inputrc
# binds them already (some distributions ship no /etc/inputrc).
__px0_bind() {
	builtin bind -p 2>/dev/null | command grep -qF "\"$1\"" || builtin bind "\"$1\": $2" 2>/dev/null
}
__px0_bind '\e[1;5C' forward-word
__px0_bind '\e[1;5D' backward-word
__px0_bind '\e[3;5~' kill-word
builtin unset -f __px0_bind

# Escapes a value for an OSC 633 parameter: backslash, semicolon, and
# control characters become \\, \x3b, and \xNN. The result is in __px0_esc.
__px0_escape() {
	__px0_esc=${1//\\/\\\\}
	__px0_esc=${__px0_esc//;/\\x3b}
	__px0_esc=${__px0_esc//$'\n'/\\x0a}
	__px0_esc=${__px0_esc//$'\r'/\\x0d}
	__px0_esc=${__px0_esc//$'\e'/\\x1b}
	__px0_esc=${__px0_esc//$'\a'/\\x07}
	__px0_esc=${__px0_esc//$'\t'/\\x09}
}

__px0_running=0   # a command line the user entered is running
__px0_prompting=0 # PROMPT_COMMAND is running
__px0_last_hist=

# Runs before a command line: OSC 633 E (the command line) and C (its output
# starts). The DEBUG trap fires before every simple command, so only the
# first one of each line counts.
__px0_preexec() {
	[[ $__px0_running == 0 && $__px0_prompting == 0 ]] || return 0
	[[ -z "${COMP_LINE-}" ]] || return 0 # tab completion
	[[ $BASH_COMMAND != __px0_* ]] || return 0
	__px0_running=1
	# The whole line from history, which BASH_COMMAND (its first simple
	# command) is not; unless history skipped it (a leading space): then the
	# last entry is an older line.
	local line=$BASH_COMMAND hist
	hist=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
	if [[ $hist =~ ^[[:space:]]*([0-9]+)[*[:space:]]+(.*)$ ]] &&
		[[ ${BASH_REMATCH[1]} != "$__px0_last_hist" || ${BASH_REMATCH[2]} == *"$BASH_COMMAND"* ]]; then
		__px0_last_hist=${BASH_REMATCH[1]}
		line=${BASH_REMATCH[2]}
	fi
	__px0_escape "$line"
	builtin printf '\e]633;E;%s\a\e]633;C\a' "$__px0_esc"
}

__px0_status() { return "$1"; }

# Runs before each prompt: OSC 633 D (the command finished, with its exit
# code), P (the working directory), then the user's own PROMPT_COMMAND, and
# marks the prompt with A and B.
__px0_precmd() {
	local status=$?
	__px0_prompting=1
	if [[ $__px0_running == 1 ]]; then
		builtin printf '\e]633;D;%s\a' "$status"
	else
		builtin printf '\e]633;D\a'
	fi
	__px0_running=0
	__px0_escape "$PWD"
	builtin printf '\e]633;P;Cwd=%s\a' "$__px0_esc"
	local __px0_cmd
	for __px0_cmd in "${__px0_prompt_command[@]}"; do
		__px0_status "$status"
		builtin eval -- "$__px0_cmd"
	done
	# Prompt frameworks rebuild PS1 on every prompt; mark it again if so.
	if [[ $PS1 != *'\e]633;A\a'* ]]; then
		PS1='\[\e]633;A\a\]'$PS1'\[\e]633;B\a\]'
	fi
	__px0_prompting=0
	__px0_status "$status"
}

# Keep the user's PROMPT_COMMAND (a string, or an array in bash 5.1+) and
# DEBUG trap, and run ours around them.
if [[ "$(builtin declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
	__px0_prompt_command=("${PROMPT_COMMAND[@]}")
else
	__px0_prompt_command=(${PROMPT_COMMAND:+"$PROMPT_COMMAND"})
fi
builtin unset PROMPT_COMMAND
PROMPT_COMMAND=__px0_precmd

__px0_debug_trap=
if [[ -n "$(builtin trap -p DEBUG)" ]]; then
	builtin eval "__px0_debug_trap=($(builtin trap -p DEBUG))"
	__px0_debug_trap=${__px0_debug_trap[2]}
fi
__px0_debug() {
	__px0_preexec
	[[ -z "$__px0_debug_trap" ]] || builtin eval -- "$__px0_debug_trap"
}
builtin trap '__px0_debug' DEBUG
