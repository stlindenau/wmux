#!/usr/bin/env node
/**
 * wmux hook helper — sends a hook event to wmux.
 * Called by Claude Code hooks (PostToolUse, Notification, Stop, SubagentStop).
 *
 * Usage:
 *   node wmux-hook.js <tool-name>        # PostToolUse — sidebar/diff tracking
 *   node wmux-hook.js --event <Event>    # Notification/Stop fire a wmux notification;
 *                                        # Stop/SubagentStop also drive sidebar agent lifecycle
 *
 * Reads stdin for the Claude Code hook payload (JSON):
 *   - PostToolUse Edit/Write → extracts tool_input.file_path
 *   - Notification           → extracts the `message` (what the agent is waiting for)
 * WMUX_SURFACE_ID (set by wmux in each pane's shell) ties the event to its pane.
 *
 * Transport (issue #19): connects to the named pipe by default. When
 * WMUX_API_URL is set (e.g. running inside a devcontainer that cannot reach
 * a Windows named pipe directly), POSTs the same event to the FastAPI
 * command server's /v1/hook endpoint instead, authenticated with the same
 * WMUX_PIPE_TOKEN this script already reads.
 */
import net from 'net';
import http from 'http';
import https from 'https';

const argv = process.argv.slice(2);
let tool = '';
let event = '';
if (argv[0] === '--event') {
  event = argv[1] || 'Notification';
} else {
  tool = argv[0] || 'unknown';
}

const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';
const token = process.env.WMUX_PIPE_TOKEN || '';
const surfaceId = process.env.WMUX_SURFACE_ID || '';
const apiUrl = process.env.WMUX_API_URL || '';

let stdinData = '';
let sent = false;
const MAX_STDIN = 64 * 1024; // 64KB cap

function sendHook(): void {
  if (sent) return;
  sent = true;

  let file = '';
  let message = '';
  try {
    if (stdinData.trim()) {
      const data = JSON.parse(stdinData);
      // Claude Code provides tool_input with file_path for Edit/Write.
      file = data.tool_input?.file_path
        || data.tool_input?.path
        || data.input?.file_path
        || '';
      // The Notification hook payload carries the prompt text in `message`.
      message = data.message || '';
    }
  } catch {
    // stdin wasn't valid JSON — that's fine.
  }

  const params: Record<string, string> = {};
  if (event) params.event = event;
  if (tool) params.tool = tool;
  if (file) params.file = file;
  if (message) params.message = message;
  if (surfaceId) params.surfaceId = surfaceId;

  if (apiUrl) {
    sendHookHttp(params);
    return;
  }

  const client = net.connect({ path: pipePath }, () => {
    const msg = JSON.stringify({ method: 'hook.event', params, id: 1, token });
    client.write(msg + '\n', () => client.end());
  });
  client.on('error', () => {
    // wmux not running — silently ignore.
    process.exit(0);
  });
}

// Devcontainer transport (issue #19): POST the same event/tool/file/message/
// surfaceId payload to the FastAPI command server's /v1/hook endpoint.
function sendHookHttp(params: Record<string, string>): void {
  let url: URL;
  try {
    url = new URL('/v1/hook', apiUrl);
  } catch {
    process.exit(0);
    return;
  }
  const body = JSON.stringify(params);
  const transport = url.protocol === 'https:' ? https : http;
  const req = transport.request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 3000,
    },
    (res) => { res.resume(); process.exit(0); },
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
}

// Read stdin (Claude Code pipes the hook payload as JSON).
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN) stdinData += chunk; });
process.stdin.on('end', sendHook);
process.stdin.on('error', sendHook);

// Timeout: if no stdin arrives within 1s, send without payload info.
setTimeout(sendHook, 1000);

// If stdin is already ended (e.g. no pipe), send immediately.
if (process.stdin.readableEnded) sendHook();
