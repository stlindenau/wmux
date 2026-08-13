// Parts of this file are created by genAI.
// This notice needs to remain attached to any reproduction of or excerpt from this file.
// Agent: Claude Code
// AI-assisted: Yes

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { forBash, hasBash } from '../helpers/bash-path';

/**
 * The WSL half of the startup-command init channel, exercised against the real
 * `wmux-bash-integration.sh` rather than a reimplementation of it.
 *
 * This is where the feature is actually decided. Everything on the TypeScript
 * side is a string in an env var; whether the pane ends up in the right
 * directory — silently, exactly once, without leaking the payload into the
 * container it launches — is a property of these ~40 lines of shell, and of
 * subtleties (`<<<` vs `|`, exported vs not) that no type checker sees.
 */

const SCRIPT = path.resolve(__dirname, '../../src/shell-integration/wmux-bash-integration.sh');
const ACK = '\x1b]7717;startup-consumed\x07';

/** base64 of a command list, as PtyManager.wslStartupPayload would produce it. */
const payload = (...lines: string[]): string => Buffer.from(lines.join('\n'), 'utf8').toString('base64');

interface Run { stdout: string; stderr: string; }

/**
 * Source the script in a fresh shell and run `body` after it.
 *
 * WMUX_SURFACE_ID is deliberately left unset: every _wmux_report path bails
 * without it, so the pipe/temp-file reporting stays out of the way and stdout
 * holds only what the startup-command path wrote.
 */
function run(body: string, env: Record<string, string> = {}, shell = 'bash'): Run {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  const script = `unset WMUX_STARTUP_CONSUMED WMUX_STARTUP_B64 WMUX_SURFACE_ID
export ${assignments || 'WMUX_UNUSED=1'}
. "${forBash(SCRIPT)}"
${body}`;
  const res = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const hasZsh = (): boolean => spawnSync('zsh', ['-c', 'exit 0']).status === 0;

describe.skipIf(!hasBash())('wmux-bash-integration.sh startup commands', () => {
  const CD = "cd '/tmp'";

  it('runs the commands in the current shell, so the cd sticks', () => {
    // The reason `_wmux_run_startup_commands` reads with `<<<` and not a pipe:
    // bash runs the right-hand side of a pipe in a subshell, where `cd` would
    // apply to a process that exits one line later and the pane would stay put.
    const { stdout } = run('_wmux_run_startup_commands; pwd', { WMUX_STARTUP_B64: payload(CD) });
    expect(stdout.trim().endsWith('/tmp')).toBe(true);
  });

  it('acks while the script is still being sourced, before running anything', () => {
    // Split deliberately. A startup command that enters a container never comes
    // back to a prompt, so an ack deferred until after it ran would arrive after
    // wmux gave up waiting — and wmux would launch the container a second time.
    const { stdout } = run('echo SOURCED; _wmux_run_startup_commands', {
      WMUX_STARTUP_B64: payload('echo RAN'),
    });
    expect(stdout.indexOf(ACK)).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf(ACK)).toBeLessThan(stdout.indexOf('SOURCED'));
    expect(stdout.indexOf('SOURCED')).toBeLessThan(stdout.indexOf('RAN'));
  });

  it('runs multi-line payloads in order', () => {
    const { stdout } = run('_wmux_run_startup_commands', {
      WMUX_STARTUP_B64: payload('echo one', 'echo two', 'echo three'),
    });
    expect(stdout.replace(ACK, '').trim().split('\n')).toEqual(['one', 'two', 'three']);
  });

  it('preserves quoting through base64, eval and all', () => {
    // The real devcontainer line: a path with a space, a `&&`, and a `$` that
    // must not expand at the wrong moment.
    const { stdout } = run("mkdir -p '/tmp/wmux t' && _wmux_run_startup_commands && pwd", {
      WMUX_STARTUP_B64: payload("cd '/tmp/wmux t' && echo 'a && b'"),
    });
    expect(stdout).toContain('a && b');
    expect(stdout.trim().endsWith('/tmp/wmux t')).toBe(true);
  });

  it('clears the payload from the environment as it is captured', () => {
    const { stdout } = run('echo "[${WMUX_STARTUP_B64-unset}] [$WMUX_STARTUP_CONSUMED]"', {
      WMUX_STARTUP_B64: payload(CD),
    });
    expect(stdout).toContain('[unset] [1]');
  });

  it('lets no child shell see the payload', () => {
    // This is the one that matters most. The devcontainer launcher runs
    // `devcontainer exec … -- env <WMUX_*> bash -i`, and the container sources
    // its own copy of this script. A payload reaching the child would have it
    // relaunch the container from inside the container, without end.
    const { stdout } = run(
      `bash -c 'echo "[\${WMUX_STARTUP_B64-unset}] [\${_wmux_startup_pending-unset}]"'`,
      { WMUX_STARTUP_B64: payload(CD) },
    );
    expect(stdout).toContain('[unset] [unset]');
  });

  it('does not re-run when the sentinel is already set', () => {
    const { stdout } = run('_wmux_run_startup_commands; echo DONE', {
      WMUX_STARTUP_CONSUMED: '1',
      WMUX_STARTUP_B64: payload('echo SHOULD_NOT_RUN'),
    });
    expect(stdout).not.toContain('SHOULD_NOT_RUN');
    expect(stdout).not.toContain(ACK);
    expect(stdout).toContain('DONE');
  });

  it('runs the list exactly once, however many prompts follow', () => {
    // Cleared before the eval, not after: a command that execs into a container
    // never returns to clear it, and the next prompt would replay the lot.
    const { stdout } = run('_wmux_run_startup_commands; _wmux_run_startup_commands', {
      WMUX_STARTUP_B64: payload('echo RAN'),
    });
    expect(stdout.split('RAN').length - 1).toBe(1);
  });

  it('stays silent on a payload it cannot decode', () => {
    // No ack means wmux types the commands after the pane goes quiet, so the
    // directory is still right. Acking a payload we do not hold would lose it.
    const { stdout } = run('echo "[${_wmux_startup_pending}]"', {
      WMUX_STARTUP_B64: '!!! not base64 !!!',
    });
    expect(stdout).not.toContain(ACK);
    expect(stdout).toContain('[]');
  });

  it('acks nothing when there are no startup commands', () => {
    const { stdout } = run('echo OK');
    expect(stdout).not.toContain(ACK);
    expect(stdout).toContain('OK');
  });

  it('hands $? through to _wmux_precmd, which reads it to spot a Ctrl+C', () => {
    // The hook is installed ahead of _wmux_precmd so the first report_pwd
    // carries the post-cd directory — which puts it between the user's command
    // and the only thing that looks at its exit code.
    const { stdout } = run(
      '(exit 130); _wmux_run_startup_commands; echo "status=$?"',
      { WMUX_STARTUP_B64: payload('true') },
    );
    expect(stdout).toContain('status=130');
  });

  it('installs itself into PROMPT_COMMAND ahead of _wmux_precmd', () => {
    const { stdout } = run('echo "$PROMPT_COMMAND"', { WMUX_STARTUP_B64: payload(CD) });
    const pc = stdout.replace(ACK, '');
    expect(pc.indexOf('_wmux_run_startup_commands')).toBeGreaterThanOrEqual(0);
    expect(pc.indexOf('_wmux_run_startup_commands')).toBeLessThan(pc.indexOf('_wmux_precmd'));
  });

  it('keeps a pre-existing PROMPT_COMMAND', () => {
    const { stdout } = run('PROMPT_COMMAND="mine"; . "' + forBash(SCRIPT) + '"; echo "$PROMPT_COMMAND"', {
      WMUX_STARTUP_B64: payload(CD),
    });
    expect(stdout).toContain('mine');
  });
});

// zsh has no `export -f` and its own precmd machinery, so the same script takes
// a visibly different path through the file. `<<<` and `local` are the two
// pieces that have to behave identically for a zsh pane to work at all.
describe.skipIf(!hasZsh())('wmux-bash-integration.sh startup commands (zsh)', () => {
  it('runs the commands in the current shell, so the cd sticks', () => {
    const { stdout } = run("_wmux_run_startup_commands; pwd", {
      WMUX_STARTUP_B64: payload("cd '/tmp'"),
    }, 'zsh');
    expect(stdout.trim().endsWith('/tmp')).toBe(true);
  });

  it('registers the hook before _wmux_precmd', () => {
    const { stdout } = run('print -r -- "${precmd_functions[@]}"', {
      WMUX_STARTUP_B64: payload("cd '/tmp'"),
    }, 'zsh');
    const hooks = stdout.replace(ACK, '');
    expect(hooks.indexOf('_wmux_run_startup_commands')).toBeGreaterThanOrEqual(0);
    expect(hooks.indexOf('_wmux_run_startup_commands')).toBeLessThan(hooks.indexOf('_wmux_precmd'));
  });
});
