<!--
# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
-->

# Running wmux-orchestrator inside a devcontainer

wmux itself is Windows-only, but Claude Code sessions frequently run inside a
Linux devcontainer (WSL2 + Docker) instead of directly on Windows. A container
cannot open a Windows named pipe (`\\.\pipe\wmux`), so the orchestrator
plugin's usual transport — the `wmux` CLI talking to that pipe directly —
doesn't work there. This document describes how to bridge the container to the
Windows pipe: a `wmux bridge` running **inside WSL2** relays TCP ⇄ the pipe via
`npiperelay.exe`, and the container reaches it over `host.docker.internal`.

## Architecture

```
Devcontainer (Linux)          WSL2                                Windows host
┌────────────────────────┐   ┌──────────────────────────┐        ┌────────────┐
│ Claude Code             │   │ wmux bridge (node)        │  pipe  │ wmux       │
│  + wmux-orchestrator     │TCP│  listens :9787            │───────►│ \\.\pipe\  │
│  + wmux-hook.js          │──►│  spawns npiperelay.exe ───┼──interop│   wmux    │
│  + wmux-bash-integration │   │  (per connection)         │        │            │
└────────────────────────┘   └──────────────────────────┘        └────────────┘
      host.docker.internal:9787
```

No new server or protocol: everything in the container drives the same
`wmux` CLI (`resources/cli/wmux.js`) that already works natively. When a
remote target is configured, the CLI's existing `--remote`/`WMUX_REMOTE`
support (and `wmux-hook.js`'s matching TCP branch) connects over TCP to the
WSL2 `wmux bridge`. The bridge in turn reaches the Windows-host named pipe
through `npiperelay.exe` (`connectTransport()` in `wmux.ts` selects npiperelay
automatically when it runs inside WSL2). Because the TCP listener lives inside
WSL2 rather than on a Windows `0.0.0.0` bind, no Windows firewall rule is
required.

## Enabling it

**1. Install npiperelay (once per WSL2 distro).** The bridge needs it to reach
the Windows named pipe from inside WSL2:

```bash
bash scripts/install-npiperelay.sh   # SHA-256 pinned; idempotent
```

**2. Start the bridge inside WSL2** (not on Windows), pointing `node` at the
wmux CLI. `--wsl` binds `0.0.0.0` so the container can reach it via the Docker
gateway:

```bash
node "$WMUX_CLI" bridge --wsl --port 9787   # WMUX_CLI → .../resources/cli/wmux.js
wmux token                                   # prints the per-instance auth token
```

Inside the devcontainer, forward these environment variables (the launcher
already forwards `WMUX`/`WMUX_CLI`/`WMUX_SURFACE_ID`/`WMUX_PIPE` — add the
two below alongside them):

- `WMUX_REMOTE` — `host.docker.internal:9787` (the container reaches the WSL2
  bridge through the Docker host gateway; requires
  `--add-host=host.docker.internal:host-gateway` on non-Docker-Desktop setups).
- `WMUX_REMOTE_TOKEN` — the token `wmux token` printed above.

That's it. `wmux-resolve.sh`'s existing `wmux() { node "$WMUX_CLI" "$@"; }`
shim, `wmux-hook.js`, and `wmux-bash-integration.sh`'s `_wmux_report` (via
`wmux raw-v1`) all pick up `WMUX_REMOTE`/`WMUX_REMOTE_TOKEN` automatically —
no orchestrator-plugin-specific configuration needed, and nothing changes
when they're unset (falls straight back to the local named pipe).

## Security model

- The bridge runs **inside WSL2** and, with `--wsl`, binds `0.0.0.0` there so
  the container can reach it via the Docker host gateway. This is *not* a
  Windows-host `0.0.0.0` bind: the listener is confined to the WSL2 network
  namespace, so it is not exposed to the LAN/corporate network and needs no
  Windows firewall rule. The WSL2→Windows hop is `npiperelay.exe` over interop,
  which only ever touches the local `\\.\pipe\wmux`.
- Every V1/V2 request over the bridge is authenticated with the per-instance
  pipe token (`auth <token> ...` for V1 lines, a `token` field for V2
  JSON-RPC) — the bridge itself is a pure byte relay with no auth of its own;
  wmux's own pipe server verifies every request end-to-end.

## Commands that work this way

Everything the orchestrator plugin and Claude Code hooks already use goes
through this transport once configured:

- `wmux ping`, `wmux agent spawn|list|status|kill`, `wmux layout grid`,
  `wmux markdown set`, `wmux notify`, `wmux hook ...` — via `wmux-resolve.sh`'s
  shim, unchanged.
- `wmux-hook.js` (Claude Code PostToolUse/Notification/Stop/SubagentStop
  hooks) — connects over TCP directly when `WMUX_REMOTE` is set, mirroring
  `connectTransport()` in `wmux.ts`.
- `wmux-bash-integration.sh` (git branch/dirty/cwd/shell-state reporting, and
  `report_startup_command` for session restore) — calls `wmux raw-v1 <line>`
  when `WMUX_REMOTE` is set, instead of writing to the native WSL temp-file
  path.

## Working directory: a restored pane may start in `$HOME`

A devcontainer pane is a WSL pane from wmux's point of view, and WSL panes do
not reliably start where wmux puts them. `wsl.exe --cd <dir>` is applied
**before** the interactive login shell reads its rc, so a distro whose
`/etc/profile` or `~/.profile` ends up in `$HOME` — common on managed images —
discards it:

```
> wsl --cd /tmp -- pwd     # non-interactive: /tmp        — --cd holds
> wsl --cd /tmp            # interactive login: ~         — the rc wins
```

wmux compensates by typing an explicit `cd` into the pane once its shell is up
(`[wsl] enforce-cwd`, on by default — see `docs/config.md`). But that only
covers directories wmux knows about, and a user can switch it off, so:

> **A command sent via `report_startup_command` must be cwd-independent.**

wmux replays it as keystrokes into a freshly spawned shell. A relative
`./relaunch-my-container.sh` dies with "No such file or directory" the moment
the pane comes up in the home directory, and the container is never re-entered.
Report an absolute path, or open the command with its own `cd`:

```bash
_wmux_report "report_startup_command ${WMUX_SURFACE_ID} cd '/home/me/project' && ./relaunch.sh"
```

Expand the path where you *send* the report — inside the container, from
whatever variable the launcher forwarded — so the stored command holds a
literal host-side path and does not depend on the restored shell's environment.
Single-quote it: it is typed at a prompt, so a space would split it and a `$`
would expand. A redundant `cd` (wmux typed one, the command starts with
another) is a harmless no-op; the two do not need to coordinate.

Reporting the pane's cwd has the same requirement in reverse: `$(pwd)` inside a
container is a container path that means nothing on the Windows/WSL side, so
report the host-side workspace path instead.

## Without the remote transport

If `WMUX_REMOTE` is unset, everything falls back to today's behavior
unchanged: the named pipe directly, or the native WSL temp-file path for
shell integration. The devcontainer transport is purely additive.
