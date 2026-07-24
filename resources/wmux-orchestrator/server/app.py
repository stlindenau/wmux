"""FastAPI command server bridging HTTP requests to the wmux CLI/named pipe.

Lets a Claude Code session running inside a Linux devcontainer (which cannot
reach a Windows named pipe directly) drive wmux over HTTP instead. Every
endpoint shells out to the same `wmux` CLI the native integration already
uses (src/cli/wmux.ts), so the named-pipe/JSON-RPC protocol itself is never
reimplemented here — this process only translates HTTP <-> CLI invocation.

Opt-in only: started via `wmux serve-api` when WMUX_ENABLE_API=1 is set.
Binds to 127.0.0.1 by default and requires the same per-instance pipe token
already used by `wmux bridge`/`wmux --remote --token` (see readPipeToken()
in src/cli/wmux.ts) as a Bearer token — no new secret to provision.
"""

from __future__ import annotations

import hmac
import json
import os
import subprocess
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

app = FastAPI(title="wmux command server", version="0.1.0")
security = HTTPBearer(auto_error=False)


def _token_file() -> Path:
    instance = os.environ.get("WMUX_INSTANCE", "").strip()
    suffix = f"-{instance}" if instance else ""
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / f"wmux{suffix}" / "pipe-token"


def _expected_token() -> str:
    env_token = os.environ.get("WMUX_PIPE_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        return _token_file().read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def require_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
) -> None:
    expected = _expected_token()
    if not expected:
        raise HTTPException(status_code=503, detail="no pipe token configured on this wmux instance")
    provided = credentials.credentials if credentials else ""
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


def _wmux_cli_argv() -> list[str]:
    """Base argv to invoke the wmux CLI, mirroring wmux-resolve.sh's PATH fallback."""
    cli_path = os.environ.get("WMUX_CLI")
    if cli_path:
        return ["node", cli_path]
    return ["wmux"]


def run_wmux(args: list[str], timeout: float = 10.0) -> Any:
    """Run a wmux CLI command and return its parsed JSON stdout (or raw text)."""
    try:
        result = subprocess.run(  # noqa: S603 - argv is built from fixed flags + validated fields, no shell
            [*_wmux_cli_argv(), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=502, detail=f"wmux CLI not found: {exc}") from None
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="wmux CLI timed out") from None

    if result.returncode != 0:
        raise HTTPException(status_code=502, detail=result.stderr.strip() or "wmux CLI failed")

    stdout = result.stdout.strip()
    try:
        return json.loads(stdout) if stdout else None
    except json.JSONDecodeError:
        return stdout


@app.post("/v1/ping", dependencies=[Depends(require_token)])
def ping() -> dict[str, Any]:
    return {"result": run_wmux(["ping"])}


@app.post("/v1/raw", dependencies=[Depends(require_token)])
def raw_v1(payload: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Generic passthrough for a single raw V1 command line (e.g.
    "report_pwd <surface> <path>", "ports_kick <surface>",
    "clear_git_branch <surface>") — the same lines
    wmux-bash-integration.sh's `_wmux_report` writes natively. Lets the shell
    integration relay any V1 command without the server needing a dedicated
    field for each one."""
    line = str(payload.get("line", "")).strip()
    if not line:
        raise HTTPException(status_code=422, detail="line is required")
    return {"result": run_wmux(["raw-v1", line])}


@app.post("/v1/hook", dependencies=[Depends(require_token)])
def hook(payload: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Mirrors wmux-hook.ts's `hook.event` call (event/tool/agentId)."""
    args = ["hook"]
    if payload.get("event"):
        args += ["--event", str(payload["event"])]
    if payload.get("tool"):
        args += ["--tool", str(payload["tool"])]
    if payload.get("agentId"):
        args += ["--agent", str(payload["agentId"])]
    return {"result": run_wmux(args)}


@app.post("/v1/status", dependencies=[Depends(require_token)])
def status(payload: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    """Consolidated cwd/git-branch/shell-state report, mirroring the V1 commands
    wmux-bash-integration.sh sends directly today (report_pwd, report_git_branch,
    report_shell_state)."""
    surface_id = str(payload.get("surfaceId", ""))
    if not surface_id:
        raise HTTPException(status_code=422, detail="surfaceId is required")

    results: dict[str, Any] = {}
    if "pwd" in payload:
        results["pwd"] = run_wmux(["raw-v1", "report_pwd", surface_id, str(payload["pwd"])])
    if "branch" in payload:
        branch_args = ["raw-v1", "report_git_branch", surface_id, str(payload["branch"])]
        if payload.get("dirty"):
            branch_args.append("dirty")
        results["branch"] = run_wmux(branch_args)
    if "state" in payload:
        results["state"] = run_wmux(["raw-v1", "report_shell_state", surface_id, str(payload["state"])])
    return results


@app.post("/v1/agent/spawn", dependencies=[Depends(require_token)])
def agent_spawn(payload: Annotated[dict[str, Any], Body()]) -> Any:
    args = ["agent", "spawn"]
    for flag, key in (("--cmd", "cmd"), ("--label", "label"), ("--cwd", "cwd"), ("--pane", "paneId")):
        if payload.get(key):
            args += [flag, str(payload[key])]
    if payload.get("replaceTab"):
        args.append("--replace-tab")
    return run_wmux(args)


@app.get("/v1/agent/list", dependencies=[Depends(require_token)])
def agent_list() -> Any:
    return run_wmux(["agent", "list"])


@app.get("/v1/agent/status/{agent_id}", dependencies=[Depends(require_token)])
def agent_status(agent_id: str) -> Any:
    return run_wmux(["agent", "status", agent_id])


@app.post("/v1/agent/kill/{agent_id}", dependencies=[Depends(require_token)])
def agent_kill(agent_id: str) -> Any:
    return run_wmux(["agent", "kill", agent_id])


@app.post("/v1/notify", dependencies=[Depends(require_token)])
def notify(payload: Annotated[dict[str, Any], Body()]) -> dict[str, Any]:
    text = str(payload.get("text", ""))
    if not text:
        raise HTTPException(status_code=422, detail="text is required")
    return {"result": run_wmux(["notify", text])}


@app.post("/v1/layout/grid", dependencies=[Depends(require_token)])
def layout_grid(payload: Annotated[dict[str, Any], Body()]) -> Any:
    args = ["layout", "grid", "--count", str(payload.get("count", 1))]
    if payload.get("type"):
        args += ["--type", str(payload["type"])]
    if payload.get("anchorSurfaceId"):
        args += ["--anchor-surface", str(payload["anchorSurfaceId"])]
    return run_wmux(args)


@app.post("/v1/markdown", dependencies=[Depends(require_token)])
def markdown_set(payload: Annotated[dict[str, Any], Body()]) -> Any:
    surface_id = str(payload.get("surfaceId", ""))
    if not surface_id:
        raise HTTPException(status_code=422, detail="surfaceId is required")
    args = ["markdown", "set", surface_id]
    if "content" in payload:
        args += ["--content", str(payload["content"])]
    elif "filePath" in payload:
        args += ["--file", str(payload["filePath"])]
    else:
        raise HTTPException(status_code=422, detail="content or filePath is required")
    return run_wmux(args)
