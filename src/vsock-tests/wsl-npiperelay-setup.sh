#!/usr/bin/env bash
# wsl-npiperelay-setup.sh — Download npiperelay (hash-pinned) and create a
# socat relay that bridges \\.\pipe\wmux to a Unix socket in WSL2.
#
# Transport chain:
#   WSL2 client  ──>  /tmp/wmux.sock  ──>  socat  ──>  npiperelay.exe  ──>  \\.\pipe\wmux  ──>  wmux
#
# Requires: socat, curl (both available via apt)
# Run once to install; re-run to recreate the socket if WSL2 was restarted.
#
# Usage:
#   bash wsl-npiperelay-setup.sh [--pipe-name wmux] [--socket /tmp/wmux.sock]

set -euo pipefail

# ── Pinned release (albertony/npiperelay v1.11.4, 2026-07-08) ─────────────────
NPIPERELAY_VERSION="v1.11.4"
NPIPERELAY_URL="https://github.com/albertony/npiperelay/releases/download/${NPIPERELAY_VERSION}/npiperelay_windows_amd64.exe"
NPIPERELAY_SHA256="cea82cf5c9c22a28bef8075750acb7958f766393baebff4597cf21442f71c4b3"
NPIPERELAY_CHECKSUMS_URL="https://github.com/albertony/npiperelay/releases/download/${NPIPERELAY_VERSION}/npiperelay_checksums.txt"
NPIPERELAY_CHECKSUMS_SHA256="313973839744601ae73eb3597f62c9adb5f9e6985e97b4054ed18701f2cb5df7"
# ──────────────────────────────────────────────────────────────────────────────

PIPE_NAME="${1:-}"
SOCKET_PATH="${2:-}"

# Parse named flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pipe-name) PIPE_NAME="$2"; shift 2 ;;
    --socket)    SOCKET_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

PIPE_NAME="${PIPE_NAME:-wmux}"
SOCKET_PATH="${SOCKET_PATH:-/tmp/wmux.sock}"

INSTALL_DIR="${HOME}/.local/bin"
NPIPERELAY_BIN="${INSTALL_DIR}/npiperelay.exe"

echo "wmux npiperelay bridge setup"
echo "============================"
echo "  pipe    : \\\\\\\\.\\\pipe\\\\${PIPE_NAME}"
echo "  socket  : ${SOCKET_PATH}"
echo "  relay   : ${NPIPERELAY_BIN}"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────
for cmd in curl socat sha256sum; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found. Install with: sudo apt-get install $cmd"
    exit 1
  fi
done

# ── Download npiperelay if not present or hash mismatch ───────────────────────
mkdir -p "${INSTALL_DIR}"

need_download=false
if [[ ! -f "${NPIPERELAY_BIN}" ]]; then
  echo "[+] npiperelay.exe not found, downloading..."
  need_download=true
else
  existing_hash=$(sha256sum "${NPIPERELAY_BIN}" | awk '{print $1}')
  if [[ "${existing_hash}" != "${NPIPERELAY_SHA256}" ]]; then
    echo "[!] Existing npiperelay.exe hash mismatch (got ${existing_hash}), re-downloading..."
    need_download=true
  else
    echo "[OK] npiperelay.exe already present and hash verified."
  fi
fi

if [[ "${need_download}" == "true" ]]; then
  # First download and verify the checksums file itself
  echo "    Downloading checksums file..."
  tmp_checksums=$(mktemp)
  curl -fsSL --proxy "${http_proxy:-}" "${NPIPERELAY_CHECKSUMS_URL}" -o "${tmp_checksums}"
  actual_checksums_hash=$(sha256sum "${tmp_checksums}" | awk '{print $1}')
  if [[ "${actual_checksums_hash}" != "${NPIPERELAY_CHECKSUMS_SHA256}" ]]; then
    echo "ERROR: Checksums file hash mismatch!"
    echo "  expected: ${NPIPERELAY_CHECKSUMS_SHA256}"
    echo "  got:      ${actual_checksums_hash}"
    rm -f "${tmp_checksums}"
    exit 1
  fi
  echo "    Checksums file verified."

  # Verify expected binary hash is listed in the checksums file
  if ! grep -q "${NPIPERELAY_SHA256}" "${tmp_checksums}"; then
    echo "ERROR: Expected binary hash not found in checksums file — pinned hash outdated?"
    rm -f "${tmp_checksums}"
    exit 1
  fi
  rm -f "${tmp_checksums}"

  # Download the binary
  echo "    Downloading npiperelay_windows_amd64.exe..."
  tmp_bin=$(mktemp)
  curl -fsSL --proxy "${http_proxy:-}" "${NPIPERELAY_URL}" -o "${tmp_bin}"

  # Verify binary hash
  actual_hash=$(sha256sum "${tmp_bin}" | awk '{print $1}')
  if [[ "${actual_hash}" != "${NPIPERELAY_SHA256}" ]]; then
    echo "ERROR: Downloaded binary hash mismatch!"
    echo "  expected: ${NPIPERELAY_SHA256}"
    echo "  got:      ${actual_hash}"
    rm -f "${tmp_bin}"
    exit 1
  fi
  echo "    Hash verified: ${actual_hash}"

  mv "${tmp_bin}" "${NPIPERELAY_BIN}"
  chmod +x "${NPIPERELAY_BIN}"
  echo "[OK] npiperelay.exe installed to ${NPIPERELAY_BIN}"
fi

echo ""

# ── Kill any existing relay on the same socket ────────────────────────────────
if [[ -S "${SOCKET_PATH}" ]]; then
  echo "[~] Removing stale socket ${SOCKET_PATH}"
  rm -f "${SOCKET_PATH}"
fi
# Kill previous socat for this socket
pkill -f "socat.*${SOCKET_PATH}" 2>/dev/null || true

# ── Convert Unix path to Windows path for npiperelay ─────────────────────────
# npiperelay.exe is a Windows binary; we invoke it via WSL interop.
# The -ei flag makes it exit on EOF (so socat can reconnect per-client).
# The -s flag enables stderr passthrough for diagnostics.
# Use double-slash Windows-style path for the pipe.
WINDOWS_PIPE_PATH="//${PIPE_NAME}"   # socat EXEC uses // for UNC-style

echo "[+] Starting socat relay..."
echo "    socket  : ${SOCKET_PATH}"
echo "    relay   : ${NPIPERELAY_BIN} -ei -s //${PIPE_NAME}"
echo ""

# Run socat in background; logs to syslog/stderr
socat \
  UNIX-LISTEN:"${SOCKET_PATH}",fork \
  EXEC:"${NPIPERELAY_BIN} -ei -s //./pipe/${PIPE_NAME}",nofork \
  &

SOCAT_PID=$!
sleep 0.5   # wait for socat to create the socket

if [[ ! -S "${SOCKET_PATH}" ]]; then
  echo "ERROR: socat failed to create socket (PID ${SOCAT_PID} may have exited)"
  echo "       Check that wmux is running on Windows and \\\\\\\\.\\\pipe\\\\${PIPE_NAME} exists."
  exit 1
fi

echo "[OK] Relay running (socat PID=${SOCAT_PID})"
echo ""
echo "Test the connection:"
echo "  WMUX_PIPE=${SOCKET_PATH} wmux ping"
echo ""
echo "Or use the wmux CLI directly:"
echo "  export WMUX_PIPE=${SOCKET_PATH}"
echo "  wmux list-workspaces"
echo ""
echo "To stop the relay:"
echo "  kill ${SOCAT_PID}"
echo "  rm -f ${SOCKET_PATH}"
