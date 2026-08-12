#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * wmux hook helper — sends a hook event to wmux.
 * Called by Claude Code hooks (PermissionRequest, PermissionDenied, PostToolUse,
 * Notification, UserPromptSubmit, SubagentStart, SubagentStop, Stop, SessionEnd).
 *
 * Usage:
 *   node wmux-hook.js <tool-name>        # PostToolUse — sidebar/diff tracking
 *   node wmux-hook.js --event <Event>    # Notification/Stop fire a wmux notification;
 *                                        # the rest drive sidebar agent lifecycle
 *
 * Reads stdin for the Claude Code hook payload (JSON):
 *   - PostToolUse Edit/Write → extracts tool_input.file_path
 *   - Notification           → extracts the `message` (what the agent is waiting for)
 *   - tool-scoped events     → extracts `tool_name`
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
const perf_hooks_1 = require("perf_hooks");
const argv = process.argv.slice(2);
let tool = '';
let event = '';
if (argv[0] === '--event') {
    event = argv[1] || 'Notification';
}
else {
    tool = argv[0] || 'unknown';
    // PostToolUse is registered positionally (`wmux-hook.js <tool>`), so it
    // carries no --event. The main-process receiver gates the declared
    // agent-state update on `surfaceId && event` (index.ts handleHookEvent), so
    // without an event PostToolUse never maps to runDepth:1 ("working"). Set it
    // here so the sidebar's run state lights up while a turn is in flight.
    event = 'PostToolUse';
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
            // PermissionRequest/PermissionDenied are registered with --event, so the
            // tool they concern only arrives in the payload. wmux pairs the two —
            // "parked on a permission prompt for X" is only resolved by X itself
            // running — so without this the pane could never unblock on the allow
            // path. Harmless for the positional PostToolUse form, where the CLI arg
            // already carries the name and wins.
            if (!tool)
                tool = data.tool_name || '';
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
    // Each hook runs as its own short-lived process and opens its own connection
    // to wmux, so the frames race: TCP only orders bytes WITHIN one connection.
    // Without a sequence number the receiver has no way to tell that a `Stop`
    // (turn over → runDepth 0) is newer than a trailing `PostToolUse` (runDepth 1)
    // that overtook it on the wire, and the pane stays stuck on "working" until
    // the next turn. Stamp every frame with a wall-clock-anchored microsecond
    // `seq` — comparable across processes because performance.timeOrigin anchors
    // performance.now() to the same wall clock — so the receiver's monotonic seq
    // gate (acceptSeq in agent-state.ts) applies frames in send order regardless
    // of arrival order. µs resolution makes a collision between two distinct hook
    // fires effectively impossible. It travels inside `params` because that is the
    // object handleHookEvent receives (index.ts passes request.params, not the
    // whole message).
    params.seq = Math.round((perf_hooks_1.performance.timeOrigin + perf_hooks_1.performance.now()) * 1000);
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
