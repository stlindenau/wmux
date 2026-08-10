# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# Complete End-to-End VSOCK Bridge Demo

This demonstrates the **complete bidirectional data flow** from Windows Named Pipe to WSL2 VSOCK and back.

## Architecture Flow

```
Windows Named Pipe Client
    ↕ (Pipe communication)
Windows Bridge Process
    ↕ (AF_HYPERV socket)
Hypervisor Layer
    ↕ (AF_VSOCK socket) 
WSL2 VSOCK Server
```

## Setup Instructions

### Terminal 1: WSL2 VSOCK Server
```bash
# Install node-vsock if needed
./install-node-vsock.sh

# Start the WSL2 end of the bridge
node wsl-vsock-server.js
```

**Expected output:**
```
🚀 Starting VSOCK server for end-to-end demo
============================================
✅ VSOCK server listening on port 9787
📡 Ready to receive data from Windows bridge
```

### Terminal 2: Windows Bridge (Administrator)
```cmd
# Use the simple bridge for testing
.\test-simple-bridge.cmd

# OR use the pure VSOCK bridge
.\wmux-hyperv-bridge-pure.exe
```

**Expected output:**
```
[OK] Client connected!
Listening for data... (Ctrl+C to stop)
```

### Terminal 3: Windows Named Pipe Sender
```powershell
# Send test messages
.\windows-end2end-sender.ps1

# OR interactive mode
.\windows-end2end-sender.ps1 -Interactive
```

## What You'll See

### Windows Named Pipe Sender (Terminal 3):
```
[14:30:15.123] SENDING: Hello from Windows Named Pipe!
[14:30:15.145] RECEIVED FROM WSL2: {"type":"vsock-response","status":"end-to-end-success"...}
```

### Windows Bridge (Terminal 2):
```
[14:30:15.125] RECEIVED: Hello from Windows Named Pipe!
[14:30:15.127] SENT BACK: [BRIDGE-ECHO] Hello from Windows Named Pipe!
```

### WSL2 VSOCK Server (Terminal 1):
```
📞 VSOCK client connected: abc1234
📥 [2024-12-19T14:30:15.140Z] RECEIVED via VSOCK:
   Data: Hello from Windows Named Pipe!
📤 Sent response back via VSOCK
```

## Complete Data Journey

1. **Windows PowerShell** → Types message
2. **Named Pipe Client** → Connects to `\\.\pipe\wmux-bridge-poc`
3. **Bridge Process** → Receives pipe data, relays to AF_HYPERV
4. **AF_HYPERV Socket** → Windows hypervisor-level communication
5. **AF_VSOCK Socket** → WSL2 hypervisor-level communication  
6. **WSL2 Server** → Receives data, processes, sends response
7. **Return Journey** → Same path in reverse

## Benefits Demonstrated

- ✅ **Zero network involvement** (no TCP/IP)
- ✅ **Firewall-proof** (VM boundary communication)
- ✅ **No changing IPs** (stable VM addressing)
- ✅ **Bidirectional** (full request/response cycle)
- ✅ **Real-time** (immediate data transfer)
- ✅ **Secure** (hypervisor-level isolation)

## Test Messages

The demo sends various test cases:
- Simple text messages
- JSON data structures  
- Unicode characters (emojis)
- Structured commands with IDs

Each message travels the **complete end-to-end path** and returns with confirmation from WSL2.

## Troubleshooting

If messages don't reach WSL2:
1. Check WSL2 server is running (`node wsl-vsock-server.js`)
2. Check Windows bridge is running 
3. Verify node-vsock is installed in WSL2
4. Ensure bridge has Administrator privileges (for AF_HYPERV)

This demonstrates **pure VM-to-host communication** without any network stack involvement!