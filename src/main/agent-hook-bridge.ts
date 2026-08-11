/**
 * Claude Code hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the wmux pipe can drive it. But Claude Code is what most wmux
 * panes actually run, and wmux ALREADY configures its hooks in
 * ~/.claude/settings.json (see ensureClaudeHooks in claude-context.ts):
 *
 *   PermissionRequest — a permission prompt is about to be shown
 *   PermissionDenied  — the human said no
 *   PostToolUse       — a tool just finished running
 *   Notification      — Claude Code wants the user's attention
 *   UserPromptSubmit  — the human typed an answer
 *   SubagentStart     — one parallel subagent began
 *   SubagentStop      — one parallel subagent finished
 *   Stop              — the turn is over
 *   SessionEnd        — Claude Code exited; the pane has no agent any more
 *
 * Translating those into report_agent calls means the "which pane needs me?"
 * signal works for Claude Code with zero install: no plugin, no wrapper, no
 * opt-in. Other agents (OpenCode, custom harnesses) call the pipe directly.
 *
 * These hooks are lifecycle truth from the agent process itself, which is the
 * same reasoning that made hooks — not output parsing — authoritative for the
 * sidebar's agent lines (issue #81 class).
 */

import { SurfaceId } from '../shared/types';
import { reportAgent, releaseAgent, ReportAgentParams } from './agent-state';

/** The hook events wmux registers. */
export type ClaudeHookEvent =
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'PostToolUse'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'SessionEnd';

const KNOWN_EVENTS: ClaudeHookEvent[] = [
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'Notification',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
];

/** Human-readable `blockedReason` for a pane parked on a permission prompt. */
export function permissionReason(tool: string | null | undefined): string {
  return tool ? `permission: ${tool}` : 'permission';
}

export interface HookInput {
  event: ClaudeHookEvent;
  /** Tool name, for the tool-scoped events (PermissionRequest/Denied, PostToolUse). */
  tool?: string | null;
  /** Notification text — what the agent says it is waiting for. */
  message?: string | null;
  seq?: number;
  /**
   * The tool whose permission prompt this pane is currently parked on, tracked
   * by applyHookToAgentState. Passed in rather than read here so this mapping
   * stays a pure function of its inputs.
   */
  pendingPermissionTool?: string | null;
}

/** How one hook event changes the declared state — and the pending-permission tracker. */
export interface HookOutcome {
  /** The report to apply, or null when the event maps to no state change. */
  report: ReportAgentParams | null;
  /** 'set' remembers `tool` as the pending permission; 'clear' forgets it. */
  pending?: 'set' | 'clear';
  /** The agent is gone — drop the record entirely rather than reporting a state. */
  release?: boolean;
}

/**
 * Map one Claude Code hook event to a report_agent payload.
 *
 * `seq`, when the hook client stamps it, rides along on every payload so
 * reportAgent's monotonic gate (acceptSeq) can reject a frame that overtook a
 * newer one on the wire. Each hook fires as its own process over its own
 * connection, so without this a trailing PostToolUse landing after Stop would
 * re-assert runDepth:1 and strand the pane on "working".
 */
export function hookToAgentReport(input: HookInput): HookOutcome {
  const { event, tool, message, seq, pendingPermissionTool } = input;
  const withSeq = (params: ReportAgentParams): ReportAgentParams =>
    seq === undefined ? params : { ...params, seq };

  switch (event) {
    // The permission prompt is about to appear. This is the precise, tool-scoped
    // "parked on a human" edge — strictly better than inferring it from
    // Notification, which also fires for the ~60s idle nudge and whose wording
    // is not a contract. Recording WHICH tool is pending is what lets the
    // matching PostToolUse below act as the "the human allowed it" resume edge.
    case 'PermissionRequest':
      return {
        report: withSeq({ awaitingHuman: true, reason: permissionReason(tool) }),
        pending: 'set',
      };

    // The human said no. The turn continues with a denial result, so the pane
    // is running again, not parked. Without this the deny path would stay
    // blocked until Stop — the allow path has PostToolUse, deny has nothing.
    case 'PermissionDenied':
      return { report: withSeq({ awaitingHuman: false }), pending: 'clear' };

    // Claude Code wants the user. This fires both for permission/question
    // prompts and for the ~60s "still waiting on you" idle nudge, and we park
    // the pane for both: in either case the agent genuinely is waiting on a
    // human, which is exactly what `blocked` claims. Sniffing the message text
    // to tell the two apart was considered and rejected — it would silently
    // stop working the day Claude Code rewords a prompt, and the failure would
    // be the dangerous direction (a real prompt read as "not blocked").
    case 'Notification':
      return { report: withSeq({ awaitingHuman: true, reason: message ?? null }) };

    // A tool finished, so a turn is in flight.
    //
    // It deliberately does NOT clear awaitingHuman on its own. A tool running
    // proves that SOMETHING is running, not that nobody is parked on a prompt:
    // parallel subagents inherit the parent's WMUX_SURFACE_ID, so while the
    // human sits on an AskUserQuestion their PostToolUse hooks keep arriving on
    // the same surface. Clearing unconditionally wiped `blocked` back to
    // `working` within milliseconds, which is why "Pending on user" was
    // effectively never visible in the sidebar.
    //
    // It DOES clear when this is the very tool whose permission prompt the pane
    // is parked on — that tool could only have run because the human allowed
    // it, which makes this the allow-path resume edge.
    //
    // Absolute runDepth rather than a delta: this fires on EVERY tool call and
    // nothing decrements per-call, so `runDelta: +1` would climb forever. An
    // absolute value is idempotent — five hundred tool calls still leave the
    // depth at 1.
    case 'PostToolUse': {
      const answered = !!tool && !!pendingPermissionTool && tool === pendingPermissionTool;
      return answered
        ? { report: withSeq({ awaitingHuman: false, runDepth: 1 }), pending: 'clear' }
        : { report: withSeq({ runDepth: 1 }) };
    }

    // The human typed something — the unambiguous resume edge for every kind of
    // block, including the ones with no tool attached (idle nudge, plan review).
    // Says nothing about what is running, so a turn that continues after the
    // answer keeps its runDepth.
    case 'UserPromptSubmit':
      return { report: withSeq({ awaitingHuman: false }), pending: 'clear' };

    // One parallel subagent began. Pairs with SubagentStop so the refcount
    // actually balances — until this was wired, SubagentStop decremented a
    // counter nothing had ever incremented.
    case 'SubagentStart':
      return { report: withSeq({ runDelta: 1 }) };

    // One parallel subagent finished. The outer turn normally continues, so
    // this decrements rather than clearing — that is the whole reason runDepth
    // is a refcount. reportAgent clamps at zero, so an unbalanced decrement
    // (a subagent whose start we never saw) cannot go negative.
    case 'SubagentStop':
      return { report: withSeq({ runDelta: -1 }) };

    // The turn is over: nothing can still be running and nothing can still be
    // waiting on the user. Decisive on purpose — this is the backstop that
    // guarantees no ghost state survives a turn even if an earlier event was
    // dropped, the same role Stop already plays for the sidebar's agent lines
    // (issue #81 class).
    case 'Stop':
      return { report: withSeq({ awaitingHuman: false, runDepth: 0 }), pending: 'clear' };

    // Claude Code exited (quit, /clear, session replaced). Anything the process
    // declared is now a lie, and reporting `idle` would be a claim of its own —
    // the sidebar gives a declared state precedence over its own inference, so
    // a dead pane would sit there looking deliberately idle. Drop the record
    // instead and let the pane fall back to `unknown`.
    case 'SessionEnd':
      return { report: null, pending: 'clear', release: true };

    default:
      return { report: null };
  }
}

/**
 * The tool each surface is currently parked on a permission prompt for.
 *
 * Held here rather than in the agent-state record because it is a Claude-Code
 * hook detail, not part of the agent-agnostic protocol. Deriving it from
 * `blockedReason` instead was rejected: Notification races PermissionRequest for
 * the same prompt and overwrites the reason with free text, which would silently
 * break the resume edge and strand the pane on "blocked".
 */
const pendingPermissions = new Map<SurfaceId, string>();

/** Same bound as agent-state's record map — a buggy reporter must not grow this without limit. */
const MAX_PENDING = 256;

/** Test seam: forget every tracked permission prompt. */
export function resetHookBridge(): void {
  pendingPermissions.clear();
}

/**
 * Apply a Claude Code hook event to the declared agent state for `surfaceId`.
 * Called from the hook.event pipe handler in index.ts.
 */
export function applyHookToAgentState(
  surfaceId: SurfaceId,
  event: string,
  message: string | null,
  seq?: number,
  tool?: string | null,
): void {
  if (!KNOWN_EVENTS.includes(event as ClaudeHookEvent)) return;

  const outcome = hookToAgentReport({
    event: event as ClaudeHookEvent,
    tool,
    message,
    seq,
    pendingPermissionTool: pendingPermissions.get(surfaceId) ?? null,
  });

  if (outcome.pending === 'clear') {
    pendingPermissions.delete(surfaceId);
  } else if (outcome.pending === 'set' && tool) {
    // Evict the least recently added entry rather than refusing a live prompt.
    if (!pendingPermissions.has(surfaceId) && pendingPermissions.size >= MAX_PENDING) {
      const oldest = pendingPermissions.keys().next();
      if (!oldest.done) pendingPermissions.delete(oldest.value);
    }
    pendingPermissions.set(surfaceId, tool);
  }

  if (outcome.release) {
    releaseAgent(surfaceId, seq === undefined ? {} : { seq });
    return;
  }
  if (!outcome.report) return;
  reportAgent(surfaceId, outcome.report);
}
