<!--
# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information
-->

# WSL ↔ Windows vsock IPC demonstrator

A minimal, **working** end-to-end demo that proves IPC between a WSL2 guest and the
Windows host over **vsock** — no TCP, no IP address, no firewall rule.

The WSL2 guest opens an `AF_VSOCK` connection to the Windows host; the host answers on
an `AF_HYPERV` listener and echoes every message back. This is the transport we want to
replace the current TCP `wmux bridge` (`host.docker.internal:9787`) with, which suffers
from rotating host IPs, `0.0.0.0` LAN exposure, and corporate firewall drops.

```
WSL2 guest (node-vsock, AF_VSOCK)                     Windows host (C#, AF_HYPERV)
  connect(CID 2, port 9787)  ──────hypervisor──────▶  listen on service GUID
  writeTextSync("...")                                 0000263b-facb-11e6-bd58-64006a7986d3
                             ◀─────── [ECHO] ────────  send(...) back
```

## The one rule that makes it work: port → service GUID

WSL2/Hyper-V translates a guest→host vsock **port** `N` into a Windows Hyper-V socket
**service GUID**:

```
{N as 8 lowercase hex}-facb-11e6-bd58-64006a7986d3
```

Port **9787 = 0x0000263b**, so the host must listen on and register
`0000263b-facb-11e6-bd58-64006a7986d3`. Both sides here derive the GUID from the port, so
the port is the single source of truth. (The earlier PoC hardcoded an unrelated GUID —
that mismatch is why connections timed out with errno 110.)

## Files

| File | Side | Purpose |
|------|------|---------|
| `wsl-vsock-echo-client.js`     | WSL2    | AF_VSOCK client (node-vsock). Connects to CID 2, sends a message, prints the echo. |
| `windows-hyperv-echo-server.cs`| Windows | AF_HYPERV listener. Registers the service GUID, echoes each message, **prints RECV and SENT**. |
| `build-echo-server.cmd`        | Windows | Compiles the server with `csc`. |
| `check-vsock-support.py`       | WSL2    | Pre-flight: `/dev/vsock`, kernel, `socket.AF_VSOCK`. |
| `check-hyperv-support.ps1`     | Windows | Pre-flight: Hyper-V / Windows Hypervisor Platform. |
| `install-node-vsock.sh`        | WSL2    | Optional helper to (re)install the `node-vsock` addon. |

## Prerequisites

- **WSL2** (not WSL1) with `/dev/vsock` present (`ls -l /dev/vsock`; `sudo modprobe vsock` if missing).
- **node-vsock** available to Node in WSL2 (`node -e "require('node-vsock')"`). Use
  `./install-node-vsock.sh` if needed.
- **Windows host**: Hyper-V / Windows Hypervisor Platform enabled (implied by WSL2), plus a
  C# compiler (`csc` on PATH, or the bundled .NET Framework `csc.exe`).
- **Administrator** on the Windows host for the **first** server run (to register the service GUID).

## Run it (three steps)

### 1. Windows host — build and start the server (elevated PowerShell/cmd)

```cmd
.\build-echo-server.cmd
windows-hyperv-echo-server.exe
```

Expected:

```
[OK] Service GUID registered under GuestCommunicationServices.
[OK] Listening. Waiting for the WSL2 vsock client...
```

### 2. WSL2 — run the client

```bash
node wsl-vsock-echo-client.js --message "Hello vsock"
```

Expected (client):

```
Connection established (AF_VSOCK).
SEND to host  : {"type":"vsock-echo","content":"Hello vsock",...}
RECV from host: [ECHO] {"type":"vsock-echo","content":"Hello vsock",...}
SUCCESS: pure vsock round-trip completed (no TCP, no IP, no firewall).
```

Expected (server):

```
[a1b2c3d4] vsock client connected
[a1b2c3d4] RECV: {"type":"vsock-echo","content":"Hello vsock",...}
[a1b2c3d4] SENT: [ECHO] {"type":"vsock-echo","content":"Hello vsock",...}
```

### 3. Options

```bash
node wsl-vsock-echo-client.js --message "text" --port 9787 --cid 2 --timeout 10000
windows-hyperv-echo-server.exe 9787
```

Both sides accept the port; keep them equal.

## Troubleshooting

- **Client times out (errno 110 / ETIMEDOUT):**
  - The server is not running, or its first run was **not elevated** (GUID never registered).
  - Verify the key exists on the host:
    `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\0000263b-facb-11e6-bd58-64006a7986d3"`
  - After first-time GUID registration, a `wsl --shutdown` (then relaunch) helps the host surface it.
  - Confirm client and server use the **same port** (→ same GUID).
- **`socket() failed` on Windows:** Hyper-V / Windows Hypervisor Platform not available.
- **`node-vsock not available`:** run `./install-node-vsock.sh`, and check `ls -l /dev/vsock`.

## Next steps (not built here)

1. Relay the vsock stream into the real `\\.\pipe\wmux` and speak wmux JSON-RPC (instead of echo).
2. Wire vsock into `host_scripts/launch-isolated-devcontainer.sh`, retiring the TCP bridge,
   `WMUX_REMOTE`, and `enable-wmux-bridge-firewall.ps1`; update `docs/WMUX-INTEGRATION.md`.
