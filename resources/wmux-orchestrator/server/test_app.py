"""Unit tests for the wmux FastAPI command server.

Run with: uv run --with-requirements requirements.txt --with pytest --with httpx pytest test_app.py
"""

from __future__ import annotations

import subprocess
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app as app_module

TOKEN = "test-token-123"


@pytest.fixture(autouse=True)
def _token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WMUX_PIPE_TOKEN", TOKEN)
    monkeypatch.setenv("WMUX_CLI", "/fake/wmux.js")


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app_module.app)


def auth_headers(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class _FakeCompletedProcess:
    def __init__(self, stdout: str = "", returncode: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


def test_ping_requires_token(client: TestClient) -> None:
    resp = client.post("/v1/ping")
    assert resp.status_code == 401


def test_ping_rejects_wrong_token(client: TestClient) -> None:
    resp = client.post("/v1/ping", headers=auth_headers("wrong"))
    assert resp.status_code == 401


def test_ping_no_token_configured(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WMUX_PIPE_TOKEN", raising=False)
    monkeypatch.setattr(app_module, "_token_file", lambda: __import__("pathlib").Path("/nonexistent"))
    resp = client.post("/v1/ping", headers=auth_headers())
    assert resp.status_code == 503


def test_ping_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["argv"] = argv
        return _FakeCompletedProcess(stdout="pong")

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post("/v1/ping", headers=auth_headers())
    assert resp.status_code == 200
    assert resp.json() == {"result": "pong"}
    assert captured["argv"] == ["node", "/fake/wmux.js", "ping"]


def test_raw_v1_requires_line(client: TestClient) -> None:
    resp = client.post("/v1/raw", json={}, headers=auth_headers())
    assert resp.status_code == 422


def test_raw_v1_relays_full_line(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["argv"] = argv
        return _FakeCompletedProcess(stdout="ok")

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post("/v1/raw", json={"line": "ports_kick pane-1"}, headers=auth_headers())
    assert resp.status_code == 200
    assert captured["argv"] == ["node", "/fake/wmux.js", "raw-v1", "ports_kick pane-1"]


def test_status_requires_surface_id(client: TestClient) -> None:
    resp = client.post("/v1/status", json={}, headers=auth_headers())
    assert resp.status_code == 422


def test_status_reports_branch_and_state(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        calls.append(argv)
        return _FakeCompletedProcess(stdout="ok")

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post(
        "/v1/status",
        json={"surfaceId": "pane-1", "branch": "main", "dirty": True, "state": "running", "pwd": "/workspaces/repo"},
        headers=auth_headers(),
    )
    assert resp.status_code == 200
    assert ["node", "/fake/wmux.js", "raw-v1", "report_pwd", "pane-1", "/workspaces/repo"] in calls
    assert ["node", "/fake/wmux.js", "raw-v1", "report_git_branch", "pane-1", "main", "dirty"] in calls
    assert ["node", "/fake/wmux.js", "raw-v1", "report_shell_state", "pane-1", "running"] in calls


def test_wmux_cli_not_found_returns_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        raise FileNotFoundError("node not found")

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post("/v1/ping", headers=auth_headers())
    assert resp.status_code == 502


def test_wmux_cli_failure_returns_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        return _FakeCompletedProcess(stdout="", returncode=1, stderr="wmux is not running")

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post("/v1/ping", headers=auth_headers())
    assert resp.status_code == 502
    assert "not running" in resp.json()["detail"]


def test_notify_requires_text(client: TestClient) -> None:
    resp = client.post("/v1/notify", json={}, headers=auth_headers())
    assert resp.status_code == 422


def test_notify_success(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["argv"] = argv
        return _FakeCompletedProcess(stdout="Notification sent")

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post("/v1/notify", json={"text": "hello"}, headers=auth_headers())
    assert resp.status_code == 200
    assert captured["argv"] == ["node", "/fake/wmux.js", "notify", "hello"]


def test_agent_kill(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["argv"] = argv
        return _FakeCompletedProcess(stdout='{"ok": true}')

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post("/v1/agent/kill/agent-1", headers=auth_headers())
    assert resp.status_code == 200
    assert captured["argv"] == ["node", "/fake/wmux.js", "agent", "kill", "agent-1"]


def test_markdown_requires_content_or_file(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: _FakeCompletedProcess(stdout="ok"))
    resp = client.post("/v1/markdown", json={"surfaceId": "pane-1"}, headers=auth_headers())
    assert resp.status_code == 422


def test_agent_spawn_builds_expected_argv(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> _FakeCompletedProcess:
        captured["argv"] = argv
        return _FakeCompletedProcess(stdout='{"agentId": "a1"}')

    monkeypatch.setattr(subprocess, "run", fake_run)
    resp = client.post(
        "/v1/agent/spawn",
        json={"cmd": "echo hi", "label": "worker", "cwd": "/tmp", "paneId": "pane-2", "replaceTab": True},
        headers=auth_headers(),
    )
    assert resp.status_code == 200
    assert resp.json() == {"agentId": "a1"}
    assert captured["argv"] == [
        "node",
        "/fake/wmux.js",
        "agent",
        "spawn",
        "--cmd",
        "echo hi",
        "--label",
        "worker",
        "--cwd",
        "/tmp",
        "--pane",
        "pane-2",
        "--replace-tab",
    ]
