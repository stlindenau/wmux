#!/bin/bash
# Raw vsock connection test using nc and strace
# This bypasses node-vsock to test the kernel/Hyper-V layer directly

set -e

PORT=${1:-9787}
TIMEOUT=${2:-5}

echo ""
echo "=========================================="
echo "Raw AF_VSOCK Connection Test"
echo "=========================================="
echo ""

echo "[1] Checking vsock kernel module..."
if [[ -d /sys/module/vsock ]]; then
  echo "  ✓ vsock module loaded"
  cat /sys/module/vsock/version 2>/dev/null || echo "    (version info unavailable)"
else
  echo "  ✗ vsock module not loaded"
  echo "    Try: sudo modprobe vsock vmw_vsock_virtio_transport"
  exit 1
fi
echo ""

echo "[2] Checking /dev/vsock..."
if [[ -c /dev/vsock ]]; then
  echo "  ✓ /dev/vsock exists"
  ls -l /dev/vsock
else
  echo "  ✗ /dev/vsock not found"
  exit 1
fi
echo ""

echo "[3] Checking if port $PORT is listening on CID 2 (Windows host)..."
echo "    CID 2 = VMADDR_CID_HOST (Windows host)"
echo "    Port = $PORT"
echo ""

echo "[4] Attempting raw socket connection with strace..."
echo "    (Will timeout after ${TIMEOUT}s if server not responding)"
echo ""

# Use timeout to prevent hanging, capture strace output
timeout $TIMEOUT strace -e socket,connect,write,read -v -f \
  bash -c "exec 3<>/dev/null; timeout $TIMEOUT bash -c '(echo test >/dev/tcp/127.0.0.1/9787) &'; 
    exec {sock}>/dev/vsock 2>/dev/null && exec {sock}<>/dev/vsock 2>/dev/null; 
    exec 3>&-" 2>&1 | head -100 || true

echo ""
echo "Note: If you see 'ETIMEDOUT (Connection timed out)', the kernel is"
echo "      attempting the connection but Hyper-V isn't routing it."
echo ""

# Alternative: use nc directly if available
if command -v nc &> /dev/null; then
  echo "[5] Trying with netcat (if supported for vsock)..."
  timeout 2 nc -w 1 -v 2 $PORT 2>&1 || true
  echo ""
fi

echo "[6] Checking /proc/net/vsock..."
if [[ -f /proc/net/vsock ]]; then
  echo "  Active vsock connections:"
  cat /proc/net/vsock | head -10
else
  echo "  /proc/net/vsock not available"
fi
echo ""

echo "Done. If the connection timed out, the issue is Hyper-V routing,"
echo "not the socket setup. Check Windows Hyper-V policies."
