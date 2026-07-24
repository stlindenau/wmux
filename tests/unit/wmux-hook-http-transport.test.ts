import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import http from 'http';
import path from 'path';

// Exercises the real compiled wmux-hook.js (resources/cli/wmux-hook.js) against
// a local HTTP server standing in for the FastAPI command server (issue #19).
// Unlike the named-pipe path, this script has no exported functions to unit
// test directly (it's a fire-and-forget CLI leaf), so we verify its actual
// process behavior end-to-end instead.

const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux-hook.js');

function runHook(args: string[], env: Record<string, string>, stdin = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK_SCRIPT, ...args], { env, timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.end(stdin);
  });
}

function startCapturingServer(): Promise<{ url: string; requests: Promise<{ headers: http.IncomingHttpHeaders; body: string }> ; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let resolveRequest: (v: { headers: http.IncomingHttpHeaders; body: string }) => void;
    const requests = new Promise<{ headers: http.IncomingHttpHeaders; body: string }>((r) => { resolveRequest = r; });

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        resolveRequest({ headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('wmux-hook.js HTTP transport (issue #19)', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('POSTs to /v1/hook with the bearer token when WMUX_API_URL is set', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(['Bash'], {
      ...process.env,
      WMUX_API_URL: server.url,
      WMUX_PIPE_TOKEN: 'secret-token',
      WMUX_SURFACE_ID: 'pane-1',
    } as Record<string, string>);

    const req = await server.requests;
    expect(req.headers.authorization).toBe('Bearer secret-token');
    expect(req.headers['content-type']).toBe('application/json');

    const parsed = JSON.parse(req.body);
    expect(parsed).toEqual({ tool: 'Bash', surfaceId: 'pane-1' });
  });

  it('includes file_path from PostToolUse Edit/Write stdin payloads', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(
      ['Edit'],
      { ...process.env, WMUX_API_URL: server.url, WMUX_PIPE_TOKEN: 't', WMUX_SURFACE_ID: 'pane-2' } as Record<string, string>,
      JSON.stringify({ tool_input: { file_path: '/workspaces/repo/foo.ts' } }),
    );

    const req = await server.requests;
    const parsed = JSON.parse(req.body);
    expect(parsed).toEqual({ tool: 'Edit', file: '/workspaces/repo/foo.ts', surfaceId: 'pane-2' });
  });

  it('sends the --event flag as the event field for Notification/Stop', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(
      ['--event', 'Notification'],
      { ...process.env, WMUX_API_URL: server.url, WMUX_PIPE_TOKEN: 't', WMUX_SURFACE_ID: '' } as Record<string, string>,
      JSON.stringify({ message: 'Permission needed' }),
    );

    const req = await server.requests;
    const parsed = JSON.parse(req.body);
    expect(parsed).toEqual({ event: 'Notification', message: 'Permission needed' });
  });

  it('exits cleanly (does not hang or throw) when the HTTP server is unreachable', async () => {
    await expect(
      runHook(['Bash'], {
        ...process.env,
        WMUX_API_URL: 'http://127.0.0.1:1', // nothing listens on port 1
        WMUX_PIPE_TOKEN: 't',
      } as Record<string, string>),
    ).resolves.toBeUndefined();
  });
});
