#!/bin/bash
# Check WSL2's actual vsock capabilities

echo ""
echo "=========================================="
echo "WSL2 AF_VSOCK Capability Check"
echo "=========================================="
echo ""

echo "[1] Kernel vsock module status..."
if [[ -d /sys/module/vsock ]]; then
  echo "  ✓ vsock module loaded"
  lsmod | grep vsock
else
  echo "  ✗ vsock module not loaded"
  echo "    Trying: sudo modprobe vsock"
  sudo modprobe vsock 2>/dev/null || true
fi
echo ""

echo "[2] vsock device..."
if [[ -c /dev/vsock ]]; then
  echo "  ✓ /dev/vsock exists"
  ls -l /dev/vsock
  stat /dev/vsock
else
  echo "  ✗ /dev/vsock not found"
fi
echo ""

echo "[3] Current CID (Context ID)..."
cat /proc/sys/net/vsock/auto_bind_low
cat /proc/sys/net/vsock/auto_bind_high
echo ""

echo "[4] Checking vsock address..."
# Try to get our own CID
if [[ -f /proc/net/vsock ]]; then
  echo "  Listening sockets on this machine:"
  cat /proc/net/vsock | head -5
fi
echo ""

echo "[5] Testing socket creation..."
python3 << 'EOF'
import socket
import struct

try:
    # Try to create AF_VSOCK socket
    sock = socket.socket(40, socket.SOCK_STREAM)  # 40 = AF_VSOCK
    print("  ✓ AF_VSOCK socket created successfully")
    
    # Try to get our CID via SO_VM_SOCKETS_GET_LOCAL_CID
    try:
        cid = struct.unpack('I', sock.getsockopt(40, 0, 4))[0]
        print(f"    Local CID: {cid}")
    except:
        print("    (Could not read local CID)")
    
    sock.close()
except Exception as e:
    print(f"  ✗ Failed to create AF_VSOCK socket: {e}")
EOF
echo ""

echo "[6] Testing connection to Windows host (CID 2)..."
python3 << 'EOF'
import socket
import sys
import time

try:
    sock = socket.socket(40, socket.SOCK_STREAM)  # AF_VSOCK
    print("  Socket created")
    
    # Try to connect to Windows host (CID 2) on port 9787
    print("  Attempting connect to CID 2 (Windows host), port 9787...")
    sock.settimeout(3)
    
    start = time.time()
    try:
        sock.connect((2, 9787))
        elapsed = time.time() - start
        print(f"  ✓ Connected successfully! Elapsed: {elapsed:.2f}s")
        
        # Try to send/receive
        sock.send(b"Hello vsock\n")
        response = sock.recv(1024)
        print(f"  Received: {response.decode().strip()}")
        
    except socket.timeout:
        print("  ✗ Connection timed out (3s)")
    except ConnectionRefused:
        print("  ✗ Connection refused - nothing listening on that port")
    except Exception as e:
        print(f"  ✗ Connection error: {e}")
    finally:
        sock.close()
        
except Exception as e:
    print(f"  ✗ Failed to create socket: {e}")
EOF
echo ""

echo "[7] Environment variables..."
env | grep -i wsl || echo "  (No WSL-specific env vars)"
echo ""

echo "[8] WSL2 distro info..."
uname -a
echo ""

echo "Summary:"
echo "--------"
echo "If you see 'Connection timed out', the issue is Hyper-V routing."
echo "If you see 'Nothing listening', the Windows server isn't reachable."
echo "If socket creation fails, AF_VSOCK may not be available in this WSL2 setup."
