import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PtyManager,
  parseShellSpec,
  resolveSpawnCwd,
  resolveShellForCwd,
  shellEnv,
  wslCdCommand,
  wslStartupPayload,
  containsStartupAck,
  ackTail,
  createStartupFallback,
  STARTUP_ACK,
  WSL_STARTUP_ENV,
  WMUX_WSLENV,
} from '../../src/main/pty-manager';
import type { SurfaceId } from '../../src/shared/types';

const TEST_SHELL = 'cmd.exe';
const TEST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined)
) as Record<string, string>;

describe('PtyManager', () => {
  const managers: PtyManager[] = [];

  function makeManager(): PtyManager {
    const m = new PtyManager();
    managers.push(m);
    return m;
  }

  /**
   * Resolves once the pty has emitted anything, which on Windows is the signal
   * that node-pty's socket is connected and no longer deferring calls.
   *
   * Resolves rather than rejects on timeout: this is a readiness barrier, not
   * an assertion, and a slow CI runner should not turn into a hang.
   */
  function firstData(manager: PtyManager, id: SurfaceId, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);
      const unsub = manager.onData(id, () => {
        clearTimeout(timer);
        unsub();
        resolve();
      });
    });
  }

  afterEach(() => {
    for (const m of managers) {
      m.killAll();
    }
    managers.length = 0;
  });

  it('create returns a surf- prefixed SurfaceId', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(id).toMatch(/^surf-/);
  });

  it('has() returns true after create and false after kill', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(manager.has(id)).toBe(true);
    manager.kill(id);
    expect(manager.has(id)).toBe(false);
  });

  it('write does not throw', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(() => manager.write(id, 'echo hello\r')).not.toThrow();
  });

  it('write of a large payload (>1KB) does not throw and is processed via the chunked queue', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    // 8 KiB payload — would have flooded ConPTY's input buffer in one shot
    // before the per-PTY chunked write queue was added.
    const big = 'x'.repeat(8 * 1024);
    expect(() => manager.write(id, big)).not.toThrow();
    // Yield long enough for setImmediate-driven chunks to drain.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('resize does not throw', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    // Wait for the pty to actually connect before resizing.
    //
    // On Windows, node-pty DEFERS any call made before its socket is up and
    // replays it on connect. Resizing a just-created pty therefore queued a
    // resize that afterEach's killAll() outran: the socket connected after the
    // pty was dead, the replayed resize threw "Cannot resize a pty that has
    // already exited" from inside node-pty's socket callback, and because that
    // throw is asynchronous no try/catch here or in PtyManager could ever see
    // it. Vitest reported it as an unhandled error and failed the whole run —
    // on CI only, since locally the connect usually won the race.
    //
    // Resizing a connected pty is also the thing this test claims to cover;
    // the old form was accidentally exercising node-pty's deferral queue.
    await firstData(manager, id);
    expect(() => manager.resize(id, 120, 40)).not.toThrow();
  });

  it('receives data from PTY after writing', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
      cols: 80,
      rows: 24,
    });

    const received = await new Promise<string>((resolve) => {
      const unsub = manager.onData(id, (data) => {
        unsub();
        resolve(data);
      });
      // Write something to trigger output; initial prompt should arrive shortly
    });

    expect(typeof received).toBe('string');
    expect(received.length).toBeGreaterThan(0);
  });

  it('kill removes the PTY from the manager', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(manager.has(id)).toBe(true);
    manager.kill(id);
    expect(manager.has(id)).toBe(false);
  });

  it('getPid returns a numeric PID', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    const pid = manager.getPid(id);
    expect(typeof pid).toBe('number');
    expect(pid).toBeGreaterThan(0);
  });

  it('killAll removes all PTYs', () => {
    const manager = makeManager();
    const { id: id1 } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    const { id: id2 } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    manager.killAll();
    expect(manager.has(id1)).toBe(false);
    expect(manager.has(id2)).toBe(false);
  });
});

describe('parseShellSpec (issue #78 — shell command lines with args)', () => {
  it('treats a bare executable as command with no args', () => {
    expect(parseShellSpec('pwsh.exe')).toEqual({ command: 'pwsh.exe', args: [] });
  });

  it('returns empty command for undefined/empty specs', () => {
    expect(parseShellSpec(undefined)).toEqual({ command: '', args: [] });
    expect(parseShellSpec('   ')).toEqual({ command: '', args: [] });
  });

  it('splits an ssh command line into command + args', () => {
    expect(parseShellSpec('ssh user@host')).toEqual({ command: 'ssh', args: ['user@host'] });
    expect(parseShellSpec('ssh -p 2222 user@host')).toEqual({
      command: 'ssh',
      args: ['-p', '2222', 'user@host'],
    });
  });

  it('never splits an existing absolute path containing spaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux spec '));
    const exe = path.join(dir, 'my shell.exe');
    fs.writeFileSync(exe, '');
    try {
      expect(parseShellSpec(exe)).toEqual({ command: exe, args: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors double quotes around an executable path with spaces', () => {
    expect(parseShellSpec('"C:\\some path\\tool.exe" --flag')).toEqual({
      command: 'C:\\some path\\tool.exe',
      args: ['--flag'],
    });
  });
});

/**
 * CreateProcess fails with error 267 (ERROR_DIRECTORY) when handed a working
 * dir that isn't a real directory, and node-pty surfaces it as an opaque
 * "Failed to create terminal: Cannot create process, error code: 267" — the
 * pane just dies. The cwd comes from session state / CLI args (e.g. an agent
 * spawned into a git worktree that was deleted after its wave, or ordered
 * before `git worktree add` finished), so it cannot be trusted to still exist.
 */
describe('resolveSpawnCwd', () => {
  const home = process.env.USERPROFILE || 'C:\\';

  it('keeps a cwd that exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cwd-'));
    try {
      expect(resolveSpawnCwd(dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back when the cwd was deleted (the worktree case → error 267)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cwd-'));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(resolveSpawnCwd(dir)).toBe(home);
  });

  it('falls back when the cwd never existed', () => {
    expect(resolveSpawnCwd('C:\\definitely\\not\\here\\wmux-test')).toBe(home);
  });

  it('falls back when the cwd is a file, not a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cwd-'));
    const file = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x');
    try {
      expect(resolveSpawnCwd(file)).toBe(home);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back for a POSIX/WSL cwd (issue #60)', () => {
    expect(resolveSpawnCwd('/home/user/project')).toBe(home);
  });

  it('passes undefined through (node-pty default)', () => {
    expect(resolveSpawnCwd(undefined)).toBeUndefined();
  });
});

/**
 * resolveSpawnCwd above is the honest Win32 answer — %USERPROFILE% — but it is
 * also why a new tab in a WSL/devcontainer workspace silently opened in the
 * Windows home folder instead of the project. A UNC working directory is not an
 * option (CreateProcess rejects it), so the fix is to pick the one shell that
 * can actually reach the path.
 */
describe('resolveShellForCwd (POSIX cwd → WSL shell)', () => {
  const POSIX = '/home/user/agent/project';

  beforeEach(() => {
    vi.spyOn(shellEnv, 'isWindows').mockReturnValue(true);
    vi.spyOn(shellEnv, 'hasWsl').mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('swaps a Win32 shell for wsl.exe when the cwd is POSIX', () => {
    expect(resolveShellForCwd('pwsh.exe', POSIX)).toBe('wsl.exe');
    expect(resolveShellForCwd('powershell.exe', POSIX)).toBe('wsl.exe');
    expect(resolveShellForCwd('cmd.exe', POSIX)).toBe('wsl.exe');
  });

  it('leaves a Win32 cwd alone', () => {
    expect(resolveShellForCwd('pwsh.exe', 'C:\\work\\project')).toBe('pwsh.exe');
    expect(resolveShellForCwd('pwsh.exe', undefined)).toBe('pwsh.exe');
  });

  it('leaves a shell that is already WSL alone', () => {
    expect(resolveShellForCwd('wsl.exe', POSIX)).toBe('wsl.exe');
  });

  it('does not hijack a deliberate remote command line (issue #78)', () => {
    // `wmux ssh user@host` resolves to a shell wmux cannot classify. Replacing
    // it with wsl.exe would drop the user somewhere else entirely, which is a
    // worse failure than opening in the wrong directory.
    expect(resolveShellForCwd('ssh', POSIX)).toBe('ssh');
  });

  it('keeps today\'s behaviour when WSL is not installed', () => {
    vi.spyOn(shellEnv, 'hasWsl').mockReturnValue(false);
    expect(resolveShellForCwd('pwsh.exe', POSIX)).toBe('pwsh.exe');
  });

  it('is a no-op off Windows', () => {
    vi.spyOn(shellEnv, 'isWindows').mockReturnValue(false);
    expect(resolveShellForCwd('/bin/bash', POSIX)).toBe('/bin/bash');
  });
});

/**
 * `wsl.exe --cd` is applied before the interactive login shell reads its rc, so
 * a distro whose /etc/profile or ~/.profile cds to $HOME discards it and every
 * pane opens in the home directory. Reproduced by hand:
 *
 *   > wsl --cd /tmp -- pwd     ->  /tmp        (non-interactive: --cd holds)
 *   > wsl --cd /tmp            ->  ~           (interactive login: rc wins)
 *
 * So the pane has to be told where it is, by a command the shell runs itself
 * after its rc (see wslStartupPayload).
 */
describe('wslCdCommand (typed cd for WSL panes)', () => {
  const POSIX = '/home/user/agent/project';

  it('synthesizes a quoted cd for a WSL pane with a POSIX cwd', () => {
    // Unconditional since `[wsl] enforce-cwd` was removed: the option only ever
    // bought back the echoed `cd` line, which the init channel already removes.
    expect(wslCdCommand('wsl', POSIX)).toBe(`cd '${POSIX}'`);
  });

  it('quotes a path containing spaces', () => {
    expect(wslCdCommand('wsl', '/home/user/my projects/app')).toBe("cd '/home/user/my projects/app'");
  });

  it("escapes an embedded single quote as '\\''", () => {
    // A literal quote would otherwise close the string and turn the rest of the
    // path into shell syntax.
    expect(wslCdCommand('wsl', "/home/user/o'brien")).toBe("cd '/home/user/o'\\''brien'");
  });

  it('stays out of the way when there is no POSIX directory to go to', () => {
    expect(wslCdCommand('wsl', undefined)).toBeNull();
    expect(wslCdCommand('wsl', '')).toBeNull();
    expect(wslCdCommand('wsl', 'C:\\work\\project')).toBeNull();
  });

  it('is WSL-only — other shells already get a working cwd', () => {
    // pwsh/cmd receive a real Win32 working dir from resolveSpawnCwd, and an
    // 'unknown' spec may be `ssh user@host`, where a local path means nothing.
    expect(wslCdCommand('powershell', POSIX)).toBeNull();
    expect(wslCdCommand('cmd', POSIX)).toBeNull();
    expect(wslCdCommand('unknown', POSIX)).toBeNull();
  });

  it('does not consult the user config at all', () => {
    // Regression guard for the reverted `[wsl] enforce-cwd`. Reading the config
    // here also meant a disk read per pane spawn; if that import comes back,
    // this fails before anyone has to rediscover why it was a bad idea.
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/main/pty-manager.ts'), 'utf-8',
    );
    expect(src).not.toMatch(/loadUserConfig|enforceCwd/);
  });
});

/**
 * The WSL half of WMUX_STARTUP_COMMANDS: a pane's `cd` and startup commands
 * handed to the shell's own init instead of typed at its prompt, so nothing is
 * echoed above the first prompt.
 *
 * The payload's job is to survive WSLENV — which copies the Win32 environment
 * block into the distro — and then a round trip through `base64 -d` and `eval`.
 */
describe('wslStartupPayload (WSL init-channel transport)', () => {
  const decode = (b64: string): string[] =>
    Buffer.from(b64, 'base64').toString('utf-8').split('\n');

  it('puts the cd first, then the startup commands', () => {
    // Order is the whole point for a restored devcontainer pane: its launcher
    // has to find itself in the project, not in $HOME.
    const payload = wslStartupPayload("cd '/w/proj'", ['./launch.sh', 'echo hi']);
    expect(decode(payload!)).toEqual(["cd '/w/proj'", './launch.sh', 'echo hi']);
  });

  it('carries either half alone', () => {
    expect(decode(wslStartupPayload("cd '/w'", [])!)).toEqual(["cd '/w'"]);
    expect(decode(wslStartupPayload(undefined, ['nvim'])!)).toEqual(['nvim']);
  });

  it('is null when there is nothing to run, so no env var is set', () => {
    expect(wslStartupPayload(undefined, [])).toBeNull();
  });

  it('round-trips quoting, && and ; intact', () => {
    // The real devcontainer case, verbatim: report_startup_command sends this
    // whole line, and a single mangled character means the container is never
    // re-entered.
    const cmd = "cd '/workspaces/my proj' && .devcontainer/launch.sh; echo $?";
    expect(decode(wslStartupPayload(undefined, [cmd])!)).toEqual([cmd]);
  });

  it('emits nothing WSLENV or a shell could chew on', () => {
    // This is why it is base64 and not the raw newline-joined string PowerShell
    // gets: WSLENV splits on `:`, and a newline in a Win32 environment value is
    // not documented as safe. Base64 is one line of [A-Za-z0-9+/=].
    const payload = wslStartupPayload(
      "cd '/home/user/o'\\''brien/my proj'",
      ["run --flag='a b' && next; done", 'echo "$HOME"'],
    )!;
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('is listed in WSLENV as /u — never /p or /l', () => {
    // /l would split the payload on separators and /p would have the interop
    // layer rewrite it as a path. Either corrupts it silently.
    // Anchored on both sides: `/up` starts with `/u`, so `toContain` alone
    // would pass on exactly the flag this rules out.
    expect(WMUX_WSLENV).toMatch(new RegExp(`(^|:)${WSL_STARTUP_ENV}/u(:|$)`));
  });
});

/**
 * The shell integration acks the payload over the PTY. ConPTY splits its output
 * at arbitrary offsets, so the ack routinely arrives in two chunks — and a
 * missed ack means the fallback types commands the shell already ran, which for
 * a devcontainer pane launches the container a second time.
 */
describe('containsStartupAck (straddle-safe ack detection)', () => {
  it('finds the ack inside ordinary output', () => {
    expect(containsStartupAck('', `noise${STARTUP_ACK}more`)).toBe(true);
  });

  it('finds it at every possible split offset', () => {
    for (let i = 1; i < STARTUP_ACK.length; i++) {
      const first = `prompt$ ${STARTUP_ACK.slice(0, i)}`;
      const second = `${STARTUP_ACK.slice(i)}rest`;
      expect(containsStartupAck('', first)).toBe(false);
      expect(containsStartupAck(ackTail(first), second)).toBe(true);
    }
  });

  it('does not fire on output that merely resembles it', () => {
    expect(containsStartupAck('', 'echo 7717;startup-consumed')).toBe(false);
    expect(containsStartupAck('', '\x1b]7717;startup-pending\x07')).toBe(false);
  });

  it('keeps a tail short enough to never match on its own', () => {
    expect(ackTail('x'.repeat(4096)).length).toBe(STARTUP_ACK.length - 1);
  });
});

/**
 * When the shell never acks — no integration script sourced, no `base64` — main
 * types the commands after all, so the pane still lands in the right directory.
 *
 * Quiescence-driven rather than a fixed delay: a cold distro can take many
 * seconds to reach ~/.bashrc, so a short timer fires into a shell that does not
 * exist yet, and a long one makes the no-integration case feel broken.
 */
describe('createStartupFallback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (onFire: () => void) =>
    createStartupFallback({ onFire, quiescenceMs: 1200, capMs: 15000 });

  it('stays disarmed until the PTY produces something', () => {
    // Before the first byte there is no evidence a shell exists to type into.
    const onFire = vi.fn();
    make(onFire);
    vi.advanceTimersByTime(60_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires once the pane falls silent', () => {
    const onFire = vi.fn();
    const fb = make(onFire);
    fb.onData();
    vi.advanceTimersByTime(1199);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('re-arms on every chunk, so a slow-booting distro is not cut off', () => {
    const onFire = vi.fn();
    const fb = make(onFire);
    for (let i = 0; i < 10; i++) {
      fb.onData();
      vi.advanceTimersByTime(1000);
    }
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('gives up at the cap when the pane never goes quiet', () => {
    // A shell that streams forever would otherwise re-arm the timer for good.
    const onFire = vi.fn();
    const fb = make(onFire);
    for (let i = 0; i < 100; i++) {
      fb.onData();
      vi.advanceTimersByTime(200);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('never fires after cancel — the ack, or another writer, won', () => {
    const onFire = vi.fn();
    const fb = make(onFire);
    fb.onData();
    fb.cancel();
    vi.advanceTimersByTime(60_000);
    fb.onData();
    vi.advanceTimersByTime(60_000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires at most once, whatever happens afterwards', () => {
    // At-most-once is the invariant that matters: firing twice means running a
    // container launcher twice.
    const onFire = vi.fn();
    const fb = make(onFire);
    fb.onData();
    vi.advanceTimersByTime(1200);
    fb.onData();
    vi.advanceTimersByTime(60_000);
    fb.cancel();
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
