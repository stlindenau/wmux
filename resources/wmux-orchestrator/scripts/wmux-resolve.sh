#!/usr/bin/env bash
# wmux-resolve.sh — make `wmux` callable even where it isn't on PATH, and
# transparently switch transport to the FastAPI command server when running
# inside a devcontainer (issue #19).
#
# The orchestrator calls bare `wmux` from non-interactive shells (Claude Code's
# Bash tool, these hook scripts). Three resolution tiers, checked in order:
#   1. WMUX_API_URL is set        -> HTTP shim (see below), for containers that
#                                     cannot reach a Windows named pipe at all.
#   2. `wmux` is already on PATH  -> no-op, use it as-is.
#   3. $WMUX_CLI is set           -> fall back to `node "$WMUX_CLI"` (a
#                                     patched/upstream wmux still injects this
#                                     into every shell it spawns).
#
# Defining a function makes `command -v wmux` succeed in every tier, so the
# callers' existing `command -v wmux` guards pass without change.
if [ -n "${WMUX_API_URL:-}" ]; then
  # shellcheck disable=SC2317  # invoked indirectly via `wmux ...` call sites
  wmux() { _wmux_http "$@"; }
elif ! command -v wmux >/dev/null 2>&1 && [ -n "${WMUX_CLI:-}" ]; then
  wmux() { node "$WMUX_CLI" "$@"; }
fi

# HTTP shim covering the subset of `wmux` subcommands the orchestrator plugin
# actually calls (ping, agent spawn/list/kill, layout grid, markdown set,
# notify). Prints the same JSON/plain-text shape the CLI would, so callers'
# existing `parse_json "$RESULT" '.field'` calls keep working unmodified.
_wmux_http() {
  local base="${WMUX_API_URL%/}"
  local auth=(-H "Authorization: Bearer ${WMUX_PIPE_TOKEN:-}")
  local ct=(-H "Content-Type: application/json")

  case "$1" in
    ping)
      curl -fsS -m 5 "${auth[@]}" -X POST "$base/v1/ping" | node -e \
        'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).result)}catch{console.log(d)}})'
      ;;
    agent)
      case "$2" in
        spawn)
          local cmd="" label="" cwd="" pane="" replace_tab=false
          shift 2
          while [ $# -gt 0 ]; do
            case "$1" in
              --cmd) cmd="$2"; shift 2 ;;
              --label) label="$2"; shift 2 ;;
              --cwd) cwd="$2"; shift 2 ;;
              --pane) pane="$2"; shift 2 ;;
              --replace-tab) replace_tab=true; shift ;;
              *) shift ;;
            esac
          done
          local body
          body=$(node "${JSON_TOOL:?JSON_TOOL must be set}" build-json \
            "cmd=$cmd" "label=$label" "cwd=$cwd" "paneId=$pane" "replaceTab=$replace_tab")
          curl -fsS -m 15 "${auth[@]}" "${ct[@]}" -X POST "$base/v1/agent/spawn" -d "$body"
          ;;
        list)
          curl -fsS -m 5 "${auth[@]}" "$base/v1/agent/list"
          ;;
        kill)
          curl -fsS -m 5 "${auth[@]}" -X POST "$base/v1/agent/kill/$3"
          ;;
        status)
          curl -fsS -m 5 "${auth[@]}" "$base/v1/agent/status/$3"
          ;;
        *) echo "wmux-resolve: unsupported 'agent $2' over HTTP transport" >&2; return 1 ;;
      esac
      ;;
    layout)
      if [ "$2" = grid ]; then
        local count="" type=""
        shift 2
        while [ $# -gt 0 ]; do
          case "$1" in
            --count) count="$2"; shift 2 ;;
            --type) type="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        local body
        body=$(node "${JSON_TOOL:?JSON_TOOL must be set}" build-json "count=$count" "type=$type")
        curl -fsS -m 15 "${auth[@]}" "${ct[@]}" -X POST "$base/v1/layout/grid" -d "$body"
      else
        echo "wmux-resolve: unsupported 'layout $2' over HTTP transport" >&2; return 1
      fi
      ;;
    markdown)
      if [ "$2" = set ]; then
        local surface_id="$3" body
        shift 3
        if [ "$1" = --file ]; then
          body=$(node "${JSON_TOOL:?JSON_TOOL must be set}" build-json "surfaceId=$surface_id" "filePath=$2")
        elif [ "$1" = --content ]; then
          shift
          body=$(node "${JSON_TOOL:?JSON_TOOL must be set}" build-json "surfaceId=$surface_id" "content=$*")
        else
          echo "Usage: wmux markdown set <id> --content <text> | --file <path>" >&2; return 1
        fi
        curl -fsS -m 10 "${auth[@]}" "${ct[@]}" -X POST "$base/v1/markdown" -d "$body"
      else
        echo "wmux-resolve: unsupported 'markdown $2' over HTTP transport" >&2; return 1
      fi
      ;;
    notify)
      shift
      local body
      body=$(node "${JSON_TOOL:?JSON_TOOL must be set}" build-json "text=$*")
      curl -fsS -m 5 "${auth[@]}" "${ct[@]}" -X POST "$base/v1/notify" -d "$body" >/dev/null
      ;;
    *)
      echo "wmux-resolve: '$1' is not supported over the HTTP transport (WMUX_API_URL)" >&2
      return 1
      ;;
  esac
}
