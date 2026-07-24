# Running wmux-orchestrator inside a devcontainer

wmux itself is Windows-only, but Claude Code sessions frequently run inside a
Linux devcontainer (WSL2 + Docker) instead of directly on Windows. A container
cannot open a Windows named pipe (`\\.\pipe\wmux`), so the orchestrator
plugin's usual transport — the `wmux` CLI talking to that pipe directly —
doesn't work there. This document describes how to use wmux's existing TCP
remote-management support (`wmux bridge` / `--remote`, issue #78) instead.

## Architecture

```
Devcontainer (Linux)                     Windows host (or WSL2)
┌───────────────────────────┐            ┌───────────────────────────┐
│ Claude Code                │   TCP      │ wmux (Electron app)        │
│  + wmux-orchestrator        │──────────►│  ┌────────────────────────┐│
│    plugin scripts/hooks     │  token     │  │ wmux bridge (port 9787)││
│  + wmux-hook.js              │  auth      │  └───────────┬────────────┘│
│  + wmux-bash-integration.sh  │            │              │ named pipe   │
└───────────────────────────┘            └──────────────┴──────────────┘
```

No new server or protocol: everything in the container drives the same
`wmux` CLI (`resources/cli/wmux.js`) that already works natively. When a
remote target is configured, the CLI's existing `--remote`/`WMUX_REMOTE`
support (and `wmux-hook.js`'s matching TCP branch) transparently connects
over TCP to a `wmux bridge` instance instead of the local named pipe — the
exact same mechanism already used for driving a remote wmux over an SSH
tunnel.

## Enabling it

On the host (or WSL2, wherever wmux itself runs):

```bash
wmux bridge --port 9787
wmux token   # prints the per-instance auth token
```

Inside the devcontainer, forward these environment variables (the launcher
already forwards `WMUX`/`WMUX_CLI`/`WMUX_SURFACE_ID`/`WMUX_PIPE` — add the
two below alongside them):

- `WMUX_REMOTE` — `host:port` of the bridge (e.g. `127.0.0.1:9787` when
  WSL2's loopback networking makes the host directly reachable from the
  container; `host.docker.internal:9787` if your Docker networking requires
  it).
- `WMUX_REMOTE_TOKEN` — the token `wmux token` printed above.

That's it. `wmux-resolve.sh`'s existing `wmux() { node "$WMUX_CLI" "$@"; }`
shim, `wmux-hook.js`, and `wmux-bash-integration.sh`'s `_wmux_report` (via
`wmux raw-v1`) all pick up `WMUX_REMOTE`/`WMUX_REMOTE_TOKEN` automatically —
no orchestrator-plugin-specific configuration needed, and nothing changes
when they're unset (falls straight back to the local named pipe).

## Security model

Unchanged from `wmux bridge`'s existing model (issue #78):

- The bridge binds to `127.0.0.1` by default. Binding it beyond loopback
  exposes the wmux pipe to the network — prefer WSL2's existing loopback
  reachability from the container, or an SSH tunnel, over widening the bind
  address.
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
- `wmux-bash-integration.sh` (git branch/dirty/cwd/shell-state reporting) —
  calls `wmux raw-v1 <line>` when `WMUX_REMOTE` is set, instead of writing to
  the native WSL temp-file path.

## Without the remote transport

If `WMUX_REMOTE` is unset, everything falls back to today's behavior
unchanged: the named pipe directly, or the native WSL temp-file path for
shell integration. The devcontainer transport is purely additive.
