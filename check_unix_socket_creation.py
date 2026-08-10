#!/usr/bin/env python3
"""Minimal Windows Unix socket creation test."""

from __future__ import annotations

import os
import platform
import socket
import sys
import tempfile
from pathlib import Path


def candidate_paths() -> list[Path]:
    roots = [
        os.environ.get("USERPROFILE", ""),
        os.environ.get("APPDATA", ""),
        os.environ.get("TEMP", ""),
        tempfile.gettempdir(),
    ]
    seen = set()
    out: list[Path] = []
    for root in roots:
        if not root or root in seen:
            continue
        seen.add(root)
        out.append(Path(root) / "python-unix.sock")
    return out


def try_bind(sock_path: Path) -> tuple[bool, str]:
    try:
        if sock_path.exists():
            sock_path.unlink()
    except Exception:
        pass

    srv = None
    try:
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(sock_path))
        srv.listen(1)
        return True, "OK"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        if srv is not None:
            try:
                srv.close()
            except Exception:
                pass
        try:
            if sock_path.exists():
                sock_path.unlink()
        except Exception:
            pass


def main() -> int:
    print("=== Python Unix Socket Creation Test ===")
    print(f"Platform: {sys.platform}")
    print(f"Python:   {platform.python_version()}")
    print()

    if sys.platform != "win32":
        print("Warning: This script is intended for Windows.")

    if not hasattr(socket, "AF_UNIX"):
        print("AF_UNIX is not available in this Python runtime.")
        return 1

    success = 0
    paths = candidate_paths()
    for i, p in enumerate(paths, start=1):
        ok, msg = try_bind(p)
        if ok:
            success += 1
            print(f"{i}. PASS {p}")
        else:
            print(f"{i}. FAIL {p} -> {msg}")

    print()
    print(f"Summary: {success}/{len(paths)} paths succeeded")
    if success == 0:
        print("Result: Unix socket creation failed on all tested paths.")
        return 1

    print("Result: Unix socket creation works on this machine.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
