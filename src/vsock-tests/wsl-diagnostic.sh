#!/bin/bash
# WSL2 vsock connection diagnostics with strace

set -e

PORT=${1:-9787}
MESSAGE=${2:-"Hello vsock"}

echo "WSL2 AF_VSOCK Connection Diagnostics"
echo "====================================="
echo ""

# Check prerequisites
echo "[1] Checking kernel modules..."
if [[ -d /sys/module/vsock ]]; then
  echo "  ✓ vsock module loaded"
else
  echo "  ✗ vsock module not loaded - run: sudo modprobe vsock"
  exit 1
fi

if [[ -d /sys/module/vmw_vsock_virtio_transport ]]; then
  echo "  ✓ vmw_vsock_virtio_transport module loaded"
else
  echo "  ⚠ vmw_vsock_virtio_transport not loaded (may not be required)"
fi

echo ""
echo "[2] Checking /dev/vsock permissions..."
if [[ -c /dev/vsock ]]; then
  ls -l /dev/vsock
  stat -c "%a %u:%g" /dev/vsock
else
  echo "  ✗ /dev/vsock not found"
  exit 1
fi

echo ""
echo "[3] Checking vsock configuration..."
cat /proc/sys/net/vsock/max_buffer_size 2>/dev/null || echo "  (no max_buffer_size found)"
cat /proc/sys/net/vsock/max_conns_pending 2>/dev/null || echo "  (no max_conns_pending found)"

echo ""
echo "[4] Tracing socket syscalls..."
echo "  Running: strace -e socket,bind,listen,connect,send,recv -v node wsl-vsock-echo-client.js"
echo "  (This will show system-level socket operations)"
echo ""

strace -e trace=socket,bind,listen,connect,send,recv,write,read -f -v \
  node wsl-vsock-echo-client.js --message "$MESSAGE" --port "$PORT" 2>&1 | tee vsock-strace.log

echo ""
echo "Trace saved to: vsock-strace.log"
