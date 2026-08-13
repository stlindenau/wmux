// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';

// wmux-hook.js is what every Claude Code hook actually execs, so these run the
// compiled artifact rather than the TypeScript source.
//
// The behaviour under test is the ack: the hook used to `write(frame, () =>
// end())`, treating a local flush as delivery. Over the devcontainer TCP bridge
// that close raced ahead of the relay and the frame was discarded — silently,
// because the hook had already exited 0. It now holds the socket until the reply
// line arrives, bounded by WMUX_HOOK_ACK_TIMEOUT_MS.
const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux-hook.js');

interface HookRun {
  code: number | null;
  ms: number;
}

/** Run the hook against a WMUX_REMOTE target, feeding it a payload on stdin. */
function runHook(port: number, env: Record<string, string> = {}): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn('node', [HOOK_SCRIPT, '--event', 'Notification'], {
      env: {
        ...process.env,
        WMUX_PIPE: '',
        WMUX_REMOTE: `127.0.0.1:${port}`,
        WMUX_SURFACE_ID: 'surf-test',
        ...env,
      } as Record<string, string>,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(JSON.stringify({ message: 'ACK-TEST' }));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }));
  });
}

describe('wmux-hook ack handling', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    while (servers.length) servers.pop()!.close();
  });

  /** Listen on an ephemeral port; `onConn` sees every accepted socket. */
  function listen(onConn: (sock: net.Socket) => void): Promise<number> {
    return new Promise((resolve) => {
      const srv = net.createServer(onConn);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  it('holds the socket open until the reply arrives, then exits at once', async () => {
    let frame = '';
    let closedEarly = false;
    const REPLY_DELAY_MS = 800;

    const port = await listen((sock) => {
      // The regression: pre-fix the hook half-closed as soon as the write flushed,
      // so this fired before the reply was ever written. That close is what made
      // `wmux bridge` tear down a still-draining relay.
      sock.on('end', () => { if (!frame) closedEarly = true; });
      sock.on('data', (d) => {
        frame += d.toString();
        if (!frame.includes('\n')) return;
        setTimeout(() => sock.write(JSON.stringify({ result: {}, id: 1 }) + '\n'), REPLY_DELAY_MS);
      });
    });

    const run = await runHook(port, { WMUX_HOOK_ACK_TIMEOUT_MS: '10000' });

    expect(closedEarly).toBe(false);
    expect(frame).toContain('hook.event');
    expect(frame).toContain('ACK-TEST');
    expect(run.code).toBe(0);
    // Waited for the reply, but did not linger to the ack timeout afterwards.
    expect(run.ms).toBeGreaterThanOrEqual(REPLY_DELAY_MS);
    expect(run.ms).toBeLessThan(5000);
  }, 20000);

  it('gives up on its own against a bridge that accepts but never replies', async () => {
    // The failure mode the bound exists for, and the one the baseline run caught:
    // pre-fix the hook sat on a half-open socket forever and had to be killed,
    // stalling the tool call that fired it.
    const ACK_TIMEOUT_MS = 1500;
    const port = await listen(() => { /* black hole: accept, never answer */ });

    const run = await runHook(port, { WMUX_HOOK_ACK_TIMEOUT_MS: String(ACK_TIMEOUT_MS) });

    // Exit 0 regardless — a hook must never fail the agent's turn because the
    // sidebar is unreachable.
    expect(run.code).toBe(0);
    expect(run.ms).toBeGreaterThanOrEqual(ACK_TIMEOUT_MS);
    expect(run.ms).toBeLessThan(ACK_TIMEOUT_MS + 5000);
  }, 20000);

  it('exits quietly and fast when nothing is listening at all', async () => {
    // Port 1 is reserved and unbound: connect fails immediately.
    const t0 = Date.now();
    const run = await runHook(1, { WMUX_HOOK_ACK_TIMEOUT_MS: '10000' });
    expect(run.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20000);
});
