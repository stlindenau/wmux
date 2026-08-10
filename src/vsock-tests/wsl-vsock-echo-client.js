#!/usr/bin/env node
// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes
// See: docs/AGENTS.md for policy and provenance information

/**
 * WSL2 -> Windows host vsock echo client (canonical demonstrator).
 *
 * Transport: pure AF_VSOCK via the node-vsock addon. NO Python bridge, NO TCP fallback.
 * The WSL2 guest CONNECTS to the Windows host (CID 2 = VMADDR_CID_HOST). The host runs
 * windows-hyperv-echo-server.exe (AF_HYPERV listener) and echoes each message back.
 *
 * WSL2 translates the vsock PORT used here into the Hyper-V service GUID
 *   {port:x8}-facb-11e6-bd58-64006a7986d3
 * so the Windows server MUST listen on / register that same GUID for the port below.
 *
 * Usage:
 *   node wsl-vsock-echo-client.js [--message "text"] [--port 9787] [--cid 2] [--timeout 10000]
 */

'use strict';

const fs = require('fs');

const HOST_CID = 2; // VMADDR_CID_HOST — the Windows host from inside WSL2

function parseArgs(argv) {
  const opts = { message: 'Hello vsock', port: 9787, cid: HOST_CID, timeout: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--message':
        if (next !== undefined) { opts.message = next; i++; }
        break;
      case '--port':
        if (next !== undefined) { opts.port = parseInt(next, 10); i++; }
        break;
      case '--cid':
        if (next !== undefined) { opts.cid = parseInt(next, 10); i++; }
        break;
      case '--timeout':
        if (next !== undefined) { opts.timeout = parseInt(next, 10); i++; }
        break;
      default:
        break;
    }
  }
  return opts;
}

function serviceGuidForPort(port) {
  // Matches how WSL2/Hyper-V derives the AF_HYPERV service GUID from a vsock port.
  return `${(port >>> 0).toString(16).padStart(8, '0')}-facb-11e6-bd58-64006a7986d3`;
}

function loadVsock() {
  console.log('Checking AF_VSOCK prerequisites...');

  let procVersion = '';
  try {
    procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
  } catch (err) {
    console.error(`  x cannot read /proc/version: ${err.message}`);
    return null;
  }
  if (!procVersion.includes('microsoft')) {
    console.error('  x not running under WSL (no "microsoft" in /proc/version)');
    return null;
  }
  console.log('  + WSL2 environment detected');

  if (!fs.existsSync('/dev/vsock')) {
    console.error('  x /dev/vsock not found  ->  sudo modprobe vsock');
    return null;
  }
  console.log('  + /dev/vsock present');

  try {
    const mod = require('node-vsock');
    console.log('  + node-vsock module loaded');
    return mod;
  } catch (err) {
    console.error(`  x node-vsock not available: ${err.message}`);
    console.error('    ->  npm install node-vsock  (or ./install-node-vsock.sh)');
    return null;
  }
}

function diagnose(err) {
  const code = err && err.code;
  if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(err.message || '')) {
    console.error('  -> Connection timed out (errno 110). Most likely causes:');
    console.error('     * windows-hyperv-echo-server.exe is not running on the host');
    console.error('     * first run was not elevated, so the service GUID is not registered');
    console.error('     * server GUID/port does not match this client port');
  } else if (code === 'ECONNREFUSED') {
    console.error('  -> Connection refused: GUID registered but nothing is listening.');
  } else if (code === 'ENODEV') {
    console.error('  -> VSOCK kernel support missing  ->  sudo modprobe vsock vmw_vsock_virtio_transport');
  } else if (code === 'EPERM' || code === 'EACCES') {
    console.error('  -> Permission denied on /dev/vsock  ->  sudo chmod 666 /dev/vsock');
  }
}

function run(vsock, opts) {
  const { VsockSocket } = vsock;
  const guid = serviceGuidForPort(opts.port);

  console.log('');
  console.log('WSL2 -> Windows host vsock echo test');
  console.log('====================================');
  console.log(`  target       : CID ${opts.cid}, port ${opts.port}`);
  console.log(`  host service : ${guid}`);
  console.log(`  message      : ${opts.message}`);
  console.log('');

  return new Promise((resolve, reject) => {
    const socket = new VsockSocket();
    let settled = false;
    let gotEcho = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(gotEcho);
    };

    const timer = setTimeout(() => {
      const err = new Error(`Connection/response timeout (${opts.timeout}ms)`);
      err.code = 'ETIMEDOUT';
      finish(err);
    }, opts.timeout);

    socket.on('data', (buf) => {
      gotEcho = true;
      console.log(`RECV from host: ${buf.toString().trim()}`);
      // One request/response cycle is enough to prove the transport.
      socket.end(() => finish(null));
      // Fallback in case 'end' callback does not fire promptly.
      setTimeout(() => finish(null), 500);
    });

    socket.on('error', (err) => finish(err));
    socket.on('end', () => { if (gotEcho) finish(null); });
    socket.on('close', () => { if (gotEcho) finish(null); });

    // node-vsock's connect callback takes NO arguments; errors arrive via 'error'.
    socket.connect(opts.cid, opts.port, () => {
      console.log('Connection established (AF_VSOCK).');
      const payload = JSON.stringify({
        type: 'vsock-echo',
        content: opts.message,
        source: 'wsl2-vsock-echo-client',
        transport: 'AF_VSOCK',
      });
      console.log(`SEND to host  : ${payload}`);
      socket.writeTextSync(payload + '\n');
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const vsock = loadVsock();
  if (!vsock) {
    process.exitCode = 1;
    return;
  }

  try {
    const gotEcho = await run(vsock, opts);
    if (gotEcho) {
      console.log('');
      console.log('SUCCESS: pure vsock round-trip completed (no TCP, no IP, no firewall).');
      process.exitCode = 0;
    } else {
      console.error('');
      console.error('FAILED: connected but no echo received.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('');
    console.error(`FAILED: ${err.message}`);
    diagnose(err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { serviceGuidForPort, parseArgs };
