#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
 * Transport: connects to the named pipe (WMUX_PIPE) by default. When
 * WMUX_REMOTE is set (e.g. running inside a devcontainer that cannot open a
 * Windows named pipe directly, driving a `wmux bridge` on the host instead —
 * issue #78), connects over TCP to that host:port instead, mirroring
 * connectTransport() in wmux.ts. Auth token is the same WMUX_PIPE_TOKEN /
 * WMUX_REMOTE_TOKEN this script already reads either way.
 */
const net_1 = __importDefault(require("net"));
const argv = process.argv.slice(2);
let tool = '';
let event = '';
if (argv[0] === '--event') {
    event = argv[1] || 'Notification';
}
else {
    tool = argv[0] || 'unknown';
}
const DEFAULT_BRIDGE_PORT = 9787;
const pipePath = process.env.WMUX_PIPE || '\\\\.\\pipe\\wmux';
const token = process.env.WMUX_REMOTE_TOKEN || process.env.WMUX_PIPE_TOKEN || '';
const surfaceId = process.env.WMUX_SURFACE_ID || '';
function remoteTarget() {
    const spec = process.env.WMUX_REMOTE?.trim();
    if (!spec)
        return null;
    const idx = spec.lastIndexOf(':');
    if (idx === -1)
        return { host: spec, port: DEFAULT_BRIDGE_PORT };
    const port = parseInt(spec.slice(idx + 1), 10);
    return Number.isFinite(port) && port > 0 && port <= 65535
        ? { host: spec.slice(0, idx) || '127.0.0.1', port }
        : { host: spec, port: DEFAULT_BRIDGE_PORT };
}
function connectTransport(onConnect) {
    const remote = remoteTarget();
    return remote
        ? net_1.default.connect({ host: remote.host, port: remote.port }, onConnect)
        : net_1.default.connect({ path: pipePath }, onConnect);
}
let stdinData = '';
let sent = false;
const MAX_STDIN = 64 * 1024; // 64KB cap
function sendHook() {
    if (sent)
        return;
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
    }
    catch {
        // stdin wasn't valid JSON — that's fine.
    }
    const params = {};
    if (event)
        params.event = event;
    if (tool)
        params.tool = tool;
    if (file)
        params.file = file;
    if (message)
        params.message = message;
    if (surfaceId)
        params.surfaceId = surfaceId;
    const client = connectTransport(() => {
        const msg = JSON.stringify({ method: 'hook.event', params, id: 1, token });
        client.write(msg + '\n', () => client.end());
    });
    client.on('error', () => {
        // wmux (or the bridge) not reachable — silently ignore.
        process.exit(0);
    });
}
// Read stdin (Claude Code pipes the hook payload as JSON).
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (stdinData.length < MAX_STDIN)
    stdinData += chunk; });
process.stdin.on('end', sendHook);
process.stdin.on('error', sendHook);
// Timeout: if no stdin arrives within 1s, send without payload info.
setTimeout(sendHook, 1000);
// If stdin is already ended (e.g. no pipe), send immediately.
if (process.stdin.readableEnded)
    sendHook();
