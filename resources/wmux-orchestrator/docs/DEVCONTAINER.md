# Running wmux-orchestrator inside a devcontainer

wmux itself is Windows-only, but Claude Code sessions frequently run inside a
Linux devcontainer (WSL2 + Docker) instead of directly on Windows. A container
cannot open a Windows named pipe (`\\.\pipe\wmux`), so the orchestrator
plugin's usual transport — the `wmux` CLI talking to that pipe — doesn't work
there. This document describes the alternative HTTP transport built for that
case.

## Architecture

```
Devcontainer (Linux)                    Windows host (or WSL2)
┌─────────────────────────┐             ┌──────────────────────────────┐
│ Claude Code              │             │ wmux (Electron app)           │
│  + wmux-orchestrator      │  HTTP       │  ┌──────────────────────────┐│
│    plugin scripts/hooks   ├────────────►│  │ FastAPI command server   ││
│  + wmux-hook.js            │  Bearer     │  │ (wmux serve-api)         ││
│  + wmux-bash-integration.sh│  token      │  └──────────┬───────────────┘│
└─────────────────────────┘             │             │ subprocess       │
                                          │             ▼                  │
                                          │  wmux CLI → named pipe         │
                                          └──────────────────────────────┘
```

The FastAPI server (`resources/wmux-orchestrator/server/`) is a thin HTTP
front end over the existing `wmux` CLI: every endpoint shells out to the same
CLI commands (`wmux ping`, `wmux agent spawn`, `wmux layout grid`, ...) that
already talk to the named pipe today. It does not reimplement the pipe
protocol — it only translates HTTP requests into CLI invocations.

## Enabling it

On the host (or WSL2, wherever the `wmux` CLI already works):

```bash
export WMUX_ENABLE_API=1
wmux serve-api --host 127.0.0.1 --port 8787
```

`serve-api` refuses to start unless `WMUX_ENABLE_API=1` is set — the HTTP
transport is opt-in.

Inside the devcontainer, set:

- `WMUX_API_URL` — base URL of the FastAPI server (e.g.
  `http://127.0.0.1:8787` when WSL2's loopback networking makes the host
  reachable directly; use `http://host.docker.internal:8787` if your Docker
  networking requires it).
- `WMUX_PIPE_TOKEN` — the same per-instance token `wmux token` prints. This is
  the identical token already used by `wmux bridge`/`wmux --remote --token`
  (see the main README's "Remote wmux management" section) — no new secret to
  provision.

Every script under `resources/wmux-orchestrator/scripts/` sources
`wmux-resolve.sh`, which switches the `wmux()` shim to the HTTP transport
automatically once these two variables are set — no other configuration is
needed. `wmux-hook.js` and `wmux-bash-integration.sh` (used for Claude Code
tool hooks and shell-prompt git/status reporting, respectively) check the
same variables and switch transport the same way.

## Security model

- The FastAPI server binds to `127.0.0.1` by default. Binding it beyond
  loopback exposes the wmux pipe to the network — prefer WSL2's existing
  loopback reachability from the container, or an SSH tunnel, over widening
  the bind address.
- Every request must carry `Authorization: Bearer <token>`, checked with a
  constant-time comparison against the wmux instance's `pipe-token` file
  (or `WMUX_PIPE_TOKEN` if set in the server's own environment). Requests
  without a valid token are rejected before any CLI command runs.
- The server holds no state of its own beyond the token check — it is a pure
  request/subprocess translator, so it inherits whatever authorization the
  underlying `wmux` CLI/pipe already enforces.

## Endpoint reference

| Endpoint                      | Mirrors                                  |
|--------------------------------|-------------------------------------------|
| `POST /v1/ping`                | `wmux ping`                              |
| `POST /v1/hook`                | `wmux hook --event E --tool T --agent A` |
| `POST /v1/status`              | `report_pwd`/`report_git_branch`/`report_shell_state` (structured) |
| `POST /v1/raw`                 | any single raw V1 command line (generic passthrough) |
| `POST /v1/agent/spawn`         | `wmux agent spawn ...`                   |
| `GET  /v1/agent/list`          | `wmux agent list`                        |
| `GET  /v1/agent/status/{id}`   | `wmux agent status <id>`                 |
| `POST /v1/agent/kill/{id}`     | `wmux agent kill <id>`                   |
| `POST /v1/layout/grid`         | `wmux layout grid --count N --type T`    |
| `POST /v1/markdown`            | `wmux markdown set <id> --content\|--file` |
| `POST /v1/notify`              | `wmux notify <text>`                     |

## Without the HTTP transport

If `WMUX_API_URL` is unset, everything falls back to today's behavior
unchanged: `wmux-resolve.sh` falls back to `$WMUX_CLI` (or a `wmux` already on
PATH), and `wmux-hook.js`/`wmux-bash-integration.sh` talk to the named pipe
directly. The HTTP transport is purely additive.
