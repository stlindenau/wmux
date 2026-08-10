# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# WMUX VSOCK/AF_HYPERV Test Suite

This directory contains test scripts to validate AF_VSOCK (WSL2) and AF_HYPERV (Windows) communication as an alternative to TCP-based wmux bridge.

## Benefits of VSOCK/AF_HYPERV

- **No network exposure**: Pure VM-host communication
- **Stable addressing**: No changing IPs on WiFi reconnects  
- **High performance**: Direct hypervisor-level IPC
- **Secure**: VM boundary isolation, no corporate network access

## Test Components

### Windows Side (AF_HYPERV)
- `windows-hyperv-server.js` - Node.js AF_HYPERV server (wmux integration point)
- `check-hyperv-support.ps1` - Validate AF_HYPERV availability

### WSL2 Side (AF_VSOCK) 
- `wsl-vsock-client.js` - JavaScript AF_VSOCK client (for Windows -> VSOCK -> WSL -> TCP -> Container chain)
- `wsl-vsock-client.py` - Python AF_VSOCK client (direct testing)
- `check-vsock-support.py` - Validate AF_VSOCK availability

### Cross-Platform
- `test-vsock-communication.sh` - End-to-end test suite

## Usage

1. **Check Support**:
   ```bash
   # WSL2 side
   python3 check-vsock-support.py
   
   # Windows side  
   powershell check-hyperv-support.ps1
   ```

2. **Run Tests**:
   ```bash
   # Automated test suite
   ./test-vsock-communication.sh
   ```

## Architecture

The intended communication flow is:
```
Windows wmux bridge (AF_HYPERV) 
    ↕ 
WSL2 client (AF_VSOCK)
    ↕
Container client (TCP to WSL2)
```

This provides secure IPC without exposing ports to the corporate network.