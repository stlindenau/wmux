#!/usr/bin/env python3
"""Windows Unix socket capability and policy triage report.

This script mirrors the PowerShell check by collecting:
- OS/build capability signals
- Python AF_UNIX availability
- Multi-path Unix socket bind probes
- Defender/ASR/AppLocker/AV provider hints via PowerShell
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple


ASR_ACTIONS = {
    0: "Disabled",
    1: "Block",
    2: "Audit",
    6: "Warn",
}


def run_powershell(command: str) -> Tuple[bool, str]:
    """Run a PowerShell command and return (ok, stdout_or_error)."""
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except Exception as exc:  # pragma: no cover - best effort environment probe
        return False, f"failed to start powershell: {exc}"

    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "unknown PowerShell error").strip()
        return False, msg
    return True, (proc.stdout or "").strip()


def parse_json_output(text: str) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def windows_build_info() -> Tuple[str, int | None]:
    try:
        build = sys.getwindowsversion().build  # type: ignore[attr-defined]
    except Exception:
        build = None
    return platform.version(), build


def unique_paths(values: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for value in values:
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def probe_unix_socket_bind(sock_path: str) -> Dict[str, Any]:
    path = Path(sock_path)
    result: Dict[str, Any] = {
        "path": str(path),
        "ok": False,
        "error": None,
    }

    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass

    srv = None
    try:
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(path))
        srv.listen(1)
        result["ok"] = True
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            if srv is not None:
                srv.close()
        except Exception:
            pass
        try:
            if path.exists():
                path.unlink()
        except Exception:
            pass

    return result


def collect_defender_policy() -> Dict[str, Any]:
    cmd = r"""
if (-not (Get-Command Get-MpPreference -ErrorAction SilentlyContinue)) {
  [pscustomobject]@{ available = $false } | ConvertTo-Json -Depth 5
  exit 0
}
$p = Get-MpPreference
[pscustomobject]@{
  available = $true
  ControlledFolderAccessEnabled = $p.ControlledFolderAccessEnabled
  AttackSurfaceReductionRules_Ids = $p.AttackSurfaceReductionRules_Ids
  AttackSurfaceReductionRules_Actions = $p.AttackSurfaceReductionRules_Actions
} | ConvertTo-Json -Depth 5
"""
    ok, out = run_powershell(cmd)
    if not ok:
        return {"available": False, "error": out}
    data = parse_json_output(out)
    if isinstance(data, dict):
        return data
    return {"available": False, "raw": data}


def collect_av_products() -> Dict[str, Any]:
    cmd = r"""
Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct |
  Select-Object displayName, productState, pathToSignedProductExe |
  ConvertTo-Json -Depth 5
"""
    ok, out = run_powershell(cmd)
    if not ok:
        return {"ok": False, "error": out}
    return {"ok": True, "data": parse_json_output(out)}


def collect_applocker_state() -> Dict[str, Any]:
    cmd = r"""
$available = [bool](Get-Command Get-AppLockerPolicy -ErrorAction SilentlyContinue)
$readable = $false
if ($available) {
  try {
    $null = Get-AppLockerPolicy -Effective -ErrorAction Stop
    $readable = $true
  } catch {
    $readable = $false
  }
}
[pscustomobject]@{ available = $available; readable = $readable } | ConvertTo-Json -Depth 3
"""
    ok, out = run_powershell(cmd)
    if not ok:
        return {"available": False, "readable": False, "error": out}
    data = parse_json_output(out)
    if isinstance(data, dict):
        return data
    return {"available": False, "readable": False, "raw": data}


def summarize(report: Dict[str, Any]) -> str:
    if report["platform"] != "win32":
        return "Not a Windows system; AF_UNIX Windows policy checks skipped."

    if not report["python_af_unix_available"]:
        return "Python runtime does not expose AF_UNIX on this machine/runtime."

    if report["windows_build"] is not None and report["windows_build"] < 17063:
        return "Windows build appears too old for AF_UNIX support (need 17063+)."

    successes = [p for p in report["bind_probes"] if p.get("ok")]
    if successes:
        if len(successes) == len(report["bind_probes"]):
            return "Unix socket bind works in all tested paths."
        return "Unix socket bind works, but only on some paths (path-specific issue likely)."

    return (
        "Unix socket bind failed on all tested paths. Likely causes: endpoint policy/AV "
        "outside Defender, ACL/path constraints, or runtime-specific behavior."
    )


def build_report() -> Dict[str, Any]:
    os_version, win_build = windows_build_info()

    test_roots = unique_paths(
        [
            os.environ.get("USERPROFILE", ""),
            os.environ.get("APPDATA", ""),
            os.environ.get("TEMP", ""),
            tempfile.gettempdir(),
        ]
    )
    test_paths = [str(Path(root) / "python-unix-socket-probe.sock") for root in test_roots]

    probes: List[Dict[str, Any]] = []
    if hasattr(socket, "AF_UNIX"):
        probes = [probe_unix_socket_bind(p) for p in test_paths]

    defender = collect_defender_policy()
    av = collect_av_products()
    applocker = collect_applocker_state()

    asr_pairs: List[Dict[str, Any]] = []
    if isinstance(defender, dict) and defender.get("available"):
        ids = defender.get("AttackSurfaceReductionRules_Ids") or []
        actions = defender.get("AttackSurfaceReductionRules_Actions") or []
        if not isinstance(ids, list):
            ids = [ids]
        if not isinstance(actions, list):
            actions = [actions]
        limit = min(len(ids), len(actions))
        for i in range(limit):
            action = actions[i]
            asr_pairs.append(
                {
                    "rule_id": ids[i],
                    "action_value": action,
                    "action": ASR_ACTIONS.get(action, "Unknown"),
                }
            )

    report: Dict[str, Any] = {
        "timestamp": dt.datetime.now().isoformat(timespec="seconds"),
        "platform": sys.platform,
        "python_version": platform.python_version(),
        "os_release": platform.release(),
        "os_version": os_version,
        "windows_build": win_build,
        "af_unix_build_eligible": (win_build is not None and win_build >= 17063),
        "python_af_unix_available": hasattr(socket, "AF_UNIX"),
        "test_paths": test_paths,
        "bind_probes": probes,
        "defender": defender,
        "asr_rules": asr_pairs,
        "av_products": av,
        "applocker": applocker,
    }
    report["verdict"] = summarize(report)
    return report


def print_human(report: Dict[str, Any]) -> None:
    print("=== Windows Unix Socket Policy and Capability Report (Python) ===")
    print()
    print("System:")
    print(f"  Platform: {report['platform']}")
    print(f"  Python:   {report['python_version']}")
    print(f"  OS:       {report['os_release']} ({report['os_version']})")
    print(f"  Build:    {report['windows_build']}")
    print(f"  AF_UNIX build eligible (>=17063): {report['af_unix_build_eligible']}")
    print(f"  Python AF_UNIX available:         {report['python_af_unix_available']}")
    print()

    print("Bind probes:")
    if not report["bind_probes"]:
        print("  (skipped: AF_UNIX unavailable in this runtime)")
    else:
        for probe in report["bind_probes"]:
            if probe["ok"]:
                print(f"  PASS  {probe['path']}")
            else:
                print(f"  FAIL  {probe['path']} -> {probe['error']}")
    print()

    defender = report["defender"]
    print("Defender policy:")
    if defender.get("available"):
        cfa = defender.get("ControlledFolderAccessEnabled")
        if cfa is None:
            cfa = "Unknown"
        print(f"  ControlledFolderAccessEnabled: {cfa}")
        blocks = sum(1 for rule in report["asr_rules"] if rule["action_value"] == 1)
        audits = sum(1 for rule in report["asr_rules"] if rule["action_value"] == 2)
        print(f"  ASR block rules: {blocks}")
        print(f"  ASR audit rules: {audits}")
    else:
        print("  Defender cmdlet data unavailable")
        if defender.get("error"):
            print(f"  Error: {defender['error']}")
    print()

    av = report["av_products"]
    print("AV providers:")
    if av.get("ok"):
        data = av.get("data")
        if isinstance(data, list):
            if not data:
                print("  (none returned)")
            for item in data:
                print(f"  - {item.get('displayName', 'Unknown')} (state={item.get('productState')})")
        elif isinstance(data, dict):
            print(f"  - {data.get('displayName', 'Unknown')} (state={data.get('productState')})")
        else:
            print(f"  Raw: {data}")
    else:
        print(f"  Unavailable: {av.get('error')}")
    print()

    app = report["applocker"]
    print("AppLocker:")
    print(f"  Cmdlet available: {app.get('available')}")
    print(f"  Effective policy readable: {app.get('readable')}")
    if app.get("error"):
        print(f"  Error: {app['error']}")
    print()

    print("Verdict:")
    print(f"  {report['verdict']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Unix socket capability and policy hints on Windows.")
    parser.add_argument("--json", action="store_true", help="Print JSON output only.")
    args = parser.parse_args()

    report = build_report()
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_human(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
