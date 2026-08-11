import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  hookToAgentReport,
  applyHookToAgentState,
  resetHookBridge,
  permissionReason,
} from '../../src/main/agent-hook-bridge';
import { getAgentState, resetAgentState } from '../../src/main/agent-state';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-hook-1' as SurfaceId;

beforeEach(() => {
  resetAgentState();
  resetHookBridge();
});

describe('hookToAgentReport', () => {
  it('Notification parks the pane on the user and keeps the message as the reason', () => {
    expect(hookToAgentReport({ event: 'Notification', message: 'Claude needs your permission to use Bash' }))
      .toEqual({ report: { awaitingHuman: true, reason: 'Claude needs your permission to use Bash' } });
  });

  it('the 60s idle nudge also counts as blocked', () => {
    // Deliberate: the agent genuinely is waiting on the user. Text-sniffing to
    // tell a nudge from a permission prompt would break on any rewording, and
    // would fail in the dangerous direction.
    expect(
      hookToAgentReport({ event: 'Notification', message: 'Claude is waiting for your input' })
        .report?.awaitingHuman,
    ).toBe(true);
  });

  it('PermissionRequest parks the pane and remembers which tool it is waiting on', () => {
    expect(hookToAgentReport({ event: 'PermissionRequest', tool: 'Bash' })).toEqual({
      report: { awaitingHuman: true, reason: 'permission: Bash' },
      pending: 'set',
    });
  });

  it('PermissionRequest still parks the pane when the payload names no tool', () => {
    expect(hookToAgentReport({ event: 'PermissionRequest' }).report).toEqual({
      awaitingHuman: true,
      reason: 'permission',
    });
  });

  it('PostToolUse asserts a run WITHOUT clearing an unrelated block', () => {
    // The regression that hid "Pending on user": parallel subagents share the
    // parent's WMUX_SURFACE_ID, so their tool calls used to wipe `blocked`
    // milliseconds after it was set.
    expect(hookToAgentReport({ event: 'PostToolUse', tool: 'Read' })).toEqual({
      report: { runDepth: 1 },
    });
    expect(
      hookToAgentReport({ event: 'PostToolUse', tool: 'Read', pendingPermissionTool: 'Bash' }).report,
    ).not.toHaveProperty('awaitingHuman');
  });

  it('PostToolUse for the very tool being asked about IS the allow-path resume edge', () => {
    expect(
      hookToAgentReport({ event: 'PostToolUse', tool: 'Bash', pendingPermissionTool: 'Bash' }),
    ).toEqual({ report: { awaitingHuman: false, runDepth: 1 }, pending: 'clear' });
  });

  it('PermissionDenied resumes the pane — the deny path has no PostToolUse', () => {
    expect(hookToAgentReport({ event: 'PermissionDenied', tool: 'Bash' })).toEqual({
      report: { awaitingHuman: false },
      pending: 'clear',
    });
  });

  it('UserPromptSubmit clears the block without claiming anything about the run', () => {
    expect(hookToAgentReport({ event: 'UserPromptSubmit' })).toEqual({
      report: { awaitingHuman: false },
      pending: 'clear',
    });
  });

  it('SubagentStart increments so SubagentStop has something to decrement', () => {
    expect(hookToAgentReport({ event: 'SubagentStart' })).toEqual({ report: { runDelta: 1 } });
  });

  it('SubagentStop decrements rather than clearing the run', () => {
    expect(hookToAgentReport({ event: 'SubagentStop' })).toEqual({ report: { runDelta: -1 } });
  });

  it('Stop is decisive: nothing running, nothing waiting', () => {
    expect(hookToAgentReport({ event: 'Stop' })).toEqual({
      report: { awaitingHuman: false, runDepth: 0 },
      pending: 'clear',
    });
  });

  it('SessionEnd releases the record instead of reporting a state', () => {
    // Reporting `idle` would be a CLAIM, and the sidebar gives a declared state
    // precedence over its own inference — a dead pane would look deliberately
    // idle forever. Dropping the record lets it fall back to `unknown`.
    expect(hookToAgentReport({ event: 'SessionEnd' })).toEqual({
      report: null,
      pending: 'clear',
      release: true,
    });
  });

  it('omits seq when the hook client did not stamp one (back-compat)', () => {
    // An older client sends no seq; the payload must stay exactly as before so
    // acceptSeq opts out and every frame is applied in arrival order.
    expect(hookToAgentReport({ event: 'PostToolUse' }).report).toEqual({ runDepth: 1 });
    expect(hookToAgentReport({ event: 'PostToolUse' }).report).not.toHaveProperty('seq');
  });

  it('forwards a stamped seq onto every event payload', () => {
    expect(hookToAgentReport({ event: 'PostToolUse', seq: 42 }).report)
      .toEqual({ runDepth: 1, seq: 42 });
    expect(hookToAgentReport({ event: 'Stop', seq: 43 }).report)
      .toEqual({ awaitingHuman: false, runDepth: 0, seq: 43 });
    expect(hookToAgentReport({ event: 'Notification', message: 'permission', seq: 44 }).report)
      .toEqual({ awaitingHuman: true, reason: 'permission', seq: 44 });
    expect(hookToAgentReport({ event: 'SubagentStop', seq: 45 }).report)
      .toEqual({ runDelta: -1, seq: 45 });
    expect(hookToAgentReport({ event: 'PermissionRequest', tool: 'Bash', seq: 46 }).report)
      .toEqual({ awaitingHuman: true, reason: 'permission: Bash', seq: 46 });
    expect(hookToAgentReport({ event: 'UserPromptSubmit', seq: 47 }).report)
      .toEqual({ awaitingHuman: false, seq: 47 });
  });
});

describe('applyHookToAgentState', () => {
  it('ignores hook events that are not part of the model', () => {
    applyHookToAgentState(surf, 'SessionStart', null);
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('drives a full turn: tool use → permission prompt → allowed → done', () => {
    applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Read');
    expect(getAgentState(surf)?.state).toBe('working');

    applyHookToAgentState(surf, 'PermissionRequest', null, undefined, 'Bash');
    expect(getAgentState(surf)).toMatchObject({
      state: 'blocked',
      blockedReason: permissionReason('Bash'),
    });

    // The human approved, so Bash itself ran — the only thing that could have
    // let it run — and that is what resumes the pane.
    applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Bash');
    expect(getAgentState(surf)).toMatchObject({ state: 'working', blockedReason: null });

    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('a parallel subagent cannot cancel "Pending on user"', () => {
    // The reported bug: three background agents were running during an
    // AskUserQuestion, and their PostToolUse hooks — same surfaceId — flipped
    // the pane straight back to "working", so the sidebar never showed the
    // block at all.
    applyHookToAgentState(surf, 'PermissionRequest', null, undefined, 'Bash');
    for (const tool of ['Read', 'Grep', 'Glob', 'Read']) {
      applyHookToAgentState(surf, 'PostToolUse', null, undefined, tool);
    }
    expect(getAgentState(surf)).toMatchObject({
      state: 'blocked',
      blockedReason: permissionReason('Bash'),
    });
  });

  it('a Notification racing PermissionRequest still unblocks on the allow path', () => {
    // Both fire for the same prompt and Notification overwrites blockedReason
    // with free text. The pending tool is tracked separately precisely so that
    // race cannot strand the pane on "blocked".
    applyHookToAgentState(surf, 'PermissionRequest', null, undefined, 'Bash');
    applyHookToAgentState(surf, 'Notification', 'Claude needs your permission to use Bash');
    expect(getAgentState(surf)?.state).toBe('blocked');

    applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Bash');
    expect(getAgentState(surf)?.state).toBe('working');
  });

  it('a denied permission resumes the pane', () => {
    applyHookToAgentState(surf, 'PermissionRequest', null, undefined, 'Bash');
    applyHookToAgentState(surf, 'PermissionDenied', null, undefined, 'Bash');
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('UserPromptSubmit clears a block no tool can resolve', () => {
    // The idle nudge and AskUserQuestion park the pane without a permission
    // prompt, so there is no matching PostToolUse to wait for.
    applyHookToAgentState(surf, 'Notification', 'Claude is waiting for your input');
    expect(getAgentState(surf)?.state).toBe('blocked');

    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('SessionEnd drops the record so the pane reads unknown, not idle', () => {
    applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Bash');
    expect(getAgentState(surf)?.state).toBe('working');

    applyHookToAgentState(surf, 'SessionEnd', null);
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('a pending permission does not leak across sessions on the same surface', () => {
    applyHookToAgentState(surf, 'PermissionRequest', null, undefined, 'Bash');
    applyHookToAgentState(surf, 'SessionEnd', null);

    // A fresh session's unrelated Bash call must not be read as answering the
    // prompt from the dead one.
    applyHookToAgentState(surf, 'Notification', 'waiting');
    applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Bash');
    expect(getAgentState(surf)?.state).toBe('blocked');
  });

  it('hundreds of tool calls do not inflate the run depth', () => {
    for (let i = 0; i < 300; i++) applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Read');
    expect(getAgentState(surf)?.runDepth).toBe(1);
  });

  it('Stop clears a pane that was left blocked', () => {
    // The backstop property: even if the un-block event is missed, ending the
    // turn must not leave a ghost "needs you" behind.
    applyHookToAgentState(surf, 'Notification', 'waiting');
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('a stale PostToolUse that overtook Stop on the wire cannot re-pin "working"', () => {
    // The stuck-on-"working" bug: each hook is its own process over its own
    // connection, so a trailing PostToolUse can arrive AFTER Stop. With a
    // send-time seq, Stop (stamped later) wins even when it is applied first —
    // the older PostToolUse is dropped by acceptSeq and the pane stays idle.
    applyHookToAgentState(surf, 'PostToolUse', null, 1000, 'Read');
    applyHookToAgentState(surf, 'Stop', null, 2000);            // sent last, applied here
    expect(getAgentState(surf)?.state).toBe('idle');

    applyHookToAgentState(surf, 'PostToolUse', null, 1500, 'Read'); // older frame, arrives late
    expect(getAgentState(surf)?.state).toBe('idle');            // rejected — no ghost "working"
  });

  it('a subagent finishing does not end the outer turn', () => {
    applyHookToAgentState(surf, 'PostToolUse', null, undefined, 'Read');
    applyHookToAgentState(surf, 'SubagentStop', null);
    // PostToolUse set depth to exactly 1, so one SubagentStop drains it; the
    // clamp is what keeps a second one from going negative.
    applyHookToAgentState(surf, 'SubagentStop', null);
    expect(getAgentState(surf)?.runDepth).toBe(0);
  });

  it('SubagentStart and SubagentStop balance out', () => {
    applyHookToAgentState(surf, 'SubagentStart', null);
    applyHookToAgentState(surf, 'SubagentStart', null);
    expect(getAgentState(surf)?.runDepth).toBe(2);

    applyHookToAgentState(surf, 'SubagentStop', null);
    expect(getAgentState(surf)?.state).toBe('working');
    applyHookToAgentState(surf, 'SubagentStop', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });
});
