// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Exercises the real compiled wmux.js (resources/cli/wmux.js) `bridge` command
// end-to-end. `wmux bridge` is a pure byte relay: it accepts TCP connections and
// forwards them to the local wmux via connectTransport(). This verifies the two
// non-TCP transport branches the bridge must pick between:
//   * WMUX_PIPE=/path        → Unix-socket upstream
//   * inside WSL2            → spawn npiperelay.exe and use its stdio
// so a `wmux bridge` running inside WSL2 reaches the Windows-host named pipe.

const BRIDGE_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux.js');

// Bind to :0 to discover a free port, then release it for the bridge to reuse.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// Spawn `node wmux.js bridge --wsl --port <port>` and resolve once it logs that
// it is listening. Returns the child so the test can kill it in afterEach.
function startBridge(port: number, env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BRIDGE_SCRIPT, 'bridge', '--wsl', '--port', String(port)], { env });
    const timer = setTimeout(() => reject(new Error('bridge did not start listening in time')), 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`bridge exited early (code ${code})`)); });
  });
}

// Round-trip a payload through the bridge: connect over TCP, send, and collect
// whatever the (echoing) upstream sends back.
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(payload));
    let received = '';
    sock.on('data', (chunk) => { received += chunk.toString(); });
    sock.on('end', () => resolve(received));
    sock.on('close', () => resolve(received));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(received); }, 2000);
  });
}

describe('wmux bridge transport selection (WSL2 devcontainer path)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('relays TCP ↔ a Unix-socket upstream when WMUX_PIPE is a /path', async () => {
    // Stand-in for the local pipe: a Unix-socket echo server.
    const sockPath = path.join(os.tmpdir(), `wmux-bridge-test-${process.pid}.sock`);
    try { fs.unlinkSync(sockPath); } catch { /* not present */ }
    const upstream = net.createServer((c) => c.pipe(c)); // echo
    await new Promise<void>((r) => upstream.listen(sockPath, r));
    cleanups.push(() => { upstream.close(); try { fs.unlinkSync(sockPath); } catch { /* gone */ } });

    const port = await freePort();
    // WMUX_PIPE starting with '/' selects the Unix-socket branch regardless of
    // WSL detection, so this branch needs no fake npiperelay. WMUX_REMOTE must
    // be cleared: it takes precedence (TCP) and is set when this suite itself
    // runs inside a wmux devcontainer.
    const child = await startBridge(port, {
      ...process.env,
      WMUX_REMOTE: '',
      WMUX_REMOTE_TOKEN: '',
      WMUX_PIPE: sockPath,
    } as Record<string, string>);
    cleanups.push(() => child.kill());

    const echoed = await roundTrip(port, 'ping-unix\n');
    expect(echoed).toContain('ping-unix');
  });

  it('relays TCP ↔ npiperelay.exe stdio when running inside WSL2', async () => {
    // Fake npiperelay.exe: ignores its args (-ei -s //./pipe/wmux) and echoes
    // stdin→stdout, standing in for the Windows named pipe over interop.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-npiperelay-'));
    const fakeBin = path.join(binDir, 'npiperelay.exe');
    fs.writeFileSync(fakeBin, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n');
    fs.chmodSync(fakeBin, 0o755);
    cleanups.push(() => fs.rmSync(binDir, { recursive: true, force: true }));

    const port = await freePort();
    // WSL_DISTRO_NAME set + WMUX_PIPE cleared (falls back to the \\.\pipe\wmux
    // default, which is not a '/path') selects the npiperelay branch;
    // findNpiperelay() picks up our fake via PATH.
    const child = await startBridge(port, {
      ...process.env,
      WMUX_PIPE: '',
      WMUX_REMOTE: '',
      WSL_DISTRO_NAME: 'test-distro',
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    } as Record<string, string>);
    cleanups.push(() => child.kill());

    const echoed = await roundTrip(port, 'ping-npiperelay\n');
    expect(echoed).toContain('ping-npiperelay');
  });
});
