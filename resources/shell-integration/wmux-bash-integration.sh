#!/bin/bash
# wmux Bash/Zsh Integration
# Sourced via WMUX_INTEGRATION=1 detection

export WMUX=1

# wmux CLI shortcut — Claude Code and users can just type: wmux browser open <url>
wmux() { node "$WMUX_CLI" "$@"; }
export -f wmux

_wmux_report() {
    local msg="$1"
    # Devcontainer transport (issue #19): when WMUX_REMOTE is set (this shell
    # can't reach a Windows named pipe or the host's Temp dir directly, e.g.
    # running inside a Linux container driving a `wmux bridge` on the host —
    # issue #78), relay the same V1 command line via `wmux raw-v1` instead of
    # writing to the native message file. The `wmux` shim already resolves to
    # `node "$WMUX_CLI"`, which transparently uses the TCP remote transport
    # once WMUX_REMOTE/WMUX_REMOTE_TOKEN are set — no protocol duplication
    # here. Fire-and-forget: backgrounded, output discarded, never blocks or
    # fails the prompt on a slow/unreachable bridge.
    if [ -n "${WMUX_REMOTE}" ] && command -v wmux &>/dev/null; then
        ( wmux raw-v1 "$msg" >/dev/null 2>&1 & )
        return
    fi
    # Native: write to temp file for the main process to pick up.
    local tmpdir="/mnt/c/Users/${USER}/AppData/Local/Temp/wmux"
    mkdir -p "$tmpdir" 2>/dev/null
    echo "$msg" >> "$tmpdir/messages"
}

_wmux_report_cwd() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    _wmux_report "report_pwd $surface_id $(pwd)"
}

_wmux_report_git() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$branch" ]; then
        local dirty=""
        [ -n "$(git status --porcelain 2>/dev/null)" ] && dirty="dirty"
        _wmux_report "report_git_branch $surface_id $branch $dirty"
    else
        _wmux_report "clear_git_branch $surface_id"
    fi
}

_wmux_precmd() {
    local exit_code=$?
    _wmux_report_cwd
    _wmux_report_git
    # 130 = SIGINT (Ctrl+C), 137 = SIGKILL, 143 = SIGTERM
    if [ $exit_code -eq 130 ] || [ $exit_code -eq 137 ] || [ $exit_code -eq 143 ]; then
        _wmux_report "report_shell_state ${WMUX_SURFACE_ID} interrupted"
    else
        _wmux_report "report_shell_state ${WMUX_SURFACE_ID} idle"
    fi
    _wmux_report "ports_kick ${WMUX_SURFACE_ID}"
}

# Report "running" before a command executes (pre-execution hook)
_wmux_preexec() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    _wmux_report "report_shell_state $surface_id running"
}

# --- Startup commands (the WSL half of WMUX_STARTUP_COMMANDS) ----------------
#
# wmux passes a pane's `cd` and any quick-launch commands in WMUX_STARTUP_B64
# rather than typing them at the prompt, so they leave no echoed line above it.
# Base64 because the value crosses WSLENV, and the commands contain spaces,
# quotes and `&&`.
#
# Captured HERE, at source time, but run from the first precmd — those are
# deliberately different moments:
#
#  - Running at the first prompt is the only point after EVERY rc file, so a
#    /etc/profile that cds to $HOME cannot undo the pane's directory. This is
#    what `wsl.exe --cd` cannot promise.
#  - Acking here, while the script is still being sourced, is the only point
#    that is reliably reached. wmux gives up waiting once the pane falls silent
#    and types the commands itself; a startup command that enters a container
#    never returns to a prompt, so an ack deferred until after it ran would
#    arrive too late — and wmux would launch the container a second time.
if [ -z "${WMUX_STARTUP_CONSUMED}" ]; then
    # NOT exported, and never should be: the devcontainer launcher runs
    # `devcontainer exec … -- env <WMUX_*> bash -i`, and the container sources
    # its own copy of this script. A payload that reached the child would have
    # it relaunch the container from inside the container, without end.
    _wmux_startup_pending=""
    if [ -n "${WMUX_STARTUP_B64}" ]; then
        _wmux_startup_pending=$(printf '%s' "${WMUX_STARTUP_B64}" | base64 -d 2>/dev/null)
        # Only ack a payload we actually hold. A missing or non-GNU `base64`
        # leaves this empty, and staying silent is what makes wmux fall back to
        # typing the commands — the pane still ends up in the right place.
        if [ -n "$_wmux_startup_pending" ]; then
            printf '\033]7717;startup-consumed\007'
        fi
    fi
    # Unconditional, and separate from the decode: whether or not we can run
    # them, nothing downstream of this shell may inherit the payload.
    unset WMUX_STARTUP_B64
    export WMUX_STARTUP_CONSUMED=1
fi

_wmux_run_startup_commands() {
    # $? belongs to whatever ran before the prompt. This hook is installed ahead
    # of _wmux_precmd, which reads it to detect a Ctrl+C, so hand it through
    # untouched on every path.
    local _wmux_status=$?
    [ -z "$_wmux_startup_pending" ] && return $_wmux_status
    local _wmux_payload="$_wmux_startup_pending"
    # Cleared BEFORE the eval, not after: a command that execs into a container
    # or a new shell never comes back to clear it, and the next prompt would run
    # the whole list again.
    _wmux_startup_pending=""
    local _wmux_line
    # A here-string, never a pipe — bash runs the right-hand side of a pipe in a
    # subshell, where `cd` would apply to a process that exits one line later.
    while IFS= read -r _wmux_line; do
        [ -z "$_wmux_line" ] && continue
        eval "$_wmux_line"
    done <<< "$_wmux_payload"
    return $_wmux_status
}

# Install hooks
if [ -n "$ZSH_VERSION" ]; then
    # Zsh: native preexec + precmd
    autoload -Uz add-zsh-hook
    # Before _wmux_precmd, so the first report_pwd carries the directory the
    # startup `cd` landed in rather than the one it is about to leave.
    add-zsh-hook precmd _wmux_run_startup_commands
    add-zsh-hook precmd _wmux_precmd
    add-zsh-hook preexec _wmux_preexec
elif [ -n "$BASH_VERSION" ]; then
    # Bash: DEBUG trap as preexec, PROMPT_COMMAND as precmd
    _wmux_bash_preexec_active=0
    trap '_wmux_bash_preexec_active=1; _wmux_preexec' DEBUG
    PROMPT_COMMAND="_wmux_run_startup_commands; _wmux_precmd; _wmux_bash_preexec_active=0${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
