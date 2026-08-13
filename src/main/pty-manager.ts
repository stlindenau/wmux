import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { SurfaceId } from '../shared/types';
import { getPipePath, readPipeToken } from '../shared/instance';
import { isPosixPath } from '../shared/paths';
import { PtyLedger } from './pty-ledger';

// ─── Shell resolution ──────────────────────────────────────────────────────
// Validates that a shell executable exists before spawning.
// Falls back through: pwsh.exe → powershell.exe → cmd.exe

let cachedDefaultShell: string | null = null;

function isShellAvailable(shell: string): boolean {
  if (!shell) return false;
  if (path.isAbsolute(shell)) {
    return fs.existsSync(shell);
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [shell], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getDefaultShell(): string {
  if (cachedDefaultShell) return cachedDefaultShell;
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe', 'cmd.exe']
    : [process.env.SHELL || '/bin/sh'];
  for (const cmd of candidates) {
    if (isShellAvailable(cmd)) {
      cachedDefaultShell = cmd;
      return cmd;
    }
  }
  // cmd.exe is always available on Windows
  cachedDefaultShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  return cachedDefaultShell;
}

function resolveShell(shell: string | undefined): string {
  if (shell && isShellAvailable(shell)) {
    return shell;
  }
  if (shell) {
    console.warn(`[wmux] Shell not found: "${shell}", falling back to ${getDefaultShell()}`);
  }
  return getDefaultShell();
}

// A shell spec may be a bare executable ("pwsh.exe", an absolute path that can
// contain spaces) or a command line with arguments ("ssh user@host",
// '"C:\Tools\my shell.exe" --flag') — issue #78 remote terminals ride on the
// latter. An existing absolute path is always treated as a bare executable so
// legacy specs like "C:\Program Files\PowerShell\7\pwsh.exe" never get split.
export function parseShellSpec(spec: string | undefined): { command: string; args: string[] } {
  const trimmed = (spec || '').trim();
  if (!trimmed) return { command: '', args: [] };
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    return { command: trimmed, args: [] };
  }
  if (!/\s/.test(trimmed)) return { command: trimmed, args: [] };
  const tokens = (trimmed.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  const [command = '', ...args] = tokens;
  return { command, args };
}

function getShellIntegrationPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'shell-integration');
    }
  } catch {
    // Not running in Electron (e.g., during tests)
  }
  return path.join(__dirname, '../../src/shell-integration');
}

function getCliPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli', 'wmux.js');
    }
  } catch {
    // Not running in Electron
  }
  return path.join(__dirname, '../cli/wmux.js');
}

// Dir holding the `wmux`/`wmux.cmd` shims (each runs `node $WMUX_CLI`). Prepended
// to PATH in every spawned shell so bare `wmux` resolves in NON-interactive shells
// too (Claude Code's Bash tool, orchestrator hook scripts) — the interactive
// `wmux` shell function only exists in the pane's own interactive shell. The dir
// has no wmux.exe, so there is no PATHEXT collision with the GUI.
function getCliBinPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli-bin');
    }
  } catch {
    // Not running in Electron
  }
  return path.join(__dirname, '../../src/cli-bin');
}

function getShellType(shell: string): 'powershell' | 'cmd' | 'wsl' | 'unknown' {
  const lower = shell.toLowerCase();
  if (lower.includes('pwsh') || lower.includes('powershell')) return 'powershell';
  if (lower.includes('cmd')) return 'cmd';
  if (lower.includes('wsl')) return 'wsl';
  return 'unknown';
}

// The two environment facts resolveShellForCwd depends on, behind an object so
// a test can substitute them without pretending to be Windows. `hasWsl` is
// cached because it shells out to `where`, and this runs on every pane create.
let cachedWsl: boolean | null = null;
export const shellEnv = {
  isWindows: (): boolean => process.platform === 'win32',
  hasWsl: (): boolean => {
    if (cachedWsl === null) cachedWsl = isShellAvailable('wsl.exe');
    return cachedWsl;
  },
};

// A pane whose cwd is a POSIX/WSL path (the common case once a WSL or
// devcontainer shell has reported its directory via report_pwd) cannot be
// served by a Win32 shell: resolveSpawnCwd() below has no choice but to hand
// pwsh/cmd %USERPROFILE%, so a new tab or split silently lands in the Windows
// home folder instead of the project. Translating to \\wsl.localhost\... is not
// an option either — CreateProcess rejects a UNC working directory.
//
// wsl.exe is the one shell that CAN open that path (buildShellArgs passes it as
// --cd), so substitute it. Only the two shells that are physically incapable of
// the directory are replaced: an 'unknown' spec is left alone because it may be
// a deliberate remote command line such as `ssh user@host` (issue #78).
export function resolveShellForCwd(shell: string, cwd: string | undefined): string {
  if (!shellEnv.isWindows()) return shell;
  if (!cwd || !isPosixPath(cwd)) return shell;
  const shellType = getShellType(shell);
  if (shellType !== 'powershell' && shellType !== 'cmd') return shell;
  if (!shellEnv.hasWsl()) return shell;
  console.warn(`[wmux] cwd is a POSIX path, using wsl.exe instead of ${shell}: ${cwd}`);
  return 'wsl.exe';
}

// Resolve the working dir handed to pty.spawn, guaranteeing it is a directory
// that exists — otherwise CreateProcess fails with error 267 (ERROR_DIRECTORY)
// and the pane dies with an opaque "Cannot create process, error code: 267".
// Returns undefined (node-pty's own default) when there is nothing usable.
export function resolveSpawnCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;

  const fallback = process.env.USERPROFILE || 'C:\\';

  // POSIX/WSL cwd: not a valid Win32 working dir at all (issue #60).
  if (isPosixPath(cwd)) return fallback;

  // Win32 cwd that no longer exists (deleted git worktree) or does not exist
  // yet (spawn ordered before `git worktree add` finished). Also rejects a path
  // that exists but is a FILE — CreateProcess wants a directory.
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
    console.warn(`[wmux] cwd is not a directory, falling back to ${fallback}: ${cwd}`);
  } catch {
    console.warn(`[wmux] cwd does not exist, falling back to ${fallback}: ${cwd}`);
  }
  return fallback;
}

// Single-quote a path for POSIX sh: everything between the quotes is literal,
// and an embedded quote is closed / backslash-escaped / reopened. Keeps a
// directory containing spaces, $, backticks or quotes intact when the path is
// typed at the pane's prompt rather than passed as an argv entry.
function quotePosix(p: string): string {
  return `'${p.split("'").join("'\\''")}'`;
}

/**
 * The `cd` a freshly spawned WSL pane has to be told explicitly, or null when
 * none is needed.
 *
 * `wsl.exe --cd` (see buildShellArgs) is applied BEFORE the interactive login
 * shell reads its rc, so on a distro whose /etc/profile or ~/.profile cds to
 * $HOME — a common corporate setup — it is silently overwritten and every
 * pane, fresh or restored, opens in the home directory instead of the project.
 * A command the shell itself runs after its rc is the one channel the rc cannot
 * override, so synthesize one.
 *
 * Unconditional, with no opt-out. It used to be governed by `[wsl] enforce-cwd`,
 * whose entire purpose was to buy back the one echoed `cd` line the command cost
 * when it was typed at the prompt — see wslStartupPayload, which no longer types
 * it. What is left of the knob is a way to break every pane's directory on
 * exactly the distros this exists for.
 *
 * WSL only: pwsh/cmd get a real Win32 working directory from resolveSpawnCwd,
 * and an 'unknown' spec may be a remote command line (`ssh user@host`) where a
 * local path means nothing.
 */
export function wslCdCommand(
  shellType: ReturnType<typeof getShellType>,
  cwd: string | undefined,
): string | null {
  if (shellType !== 'wsl') return null;
  if (!cwd || !isPosixPath(cwd)) return null;
  return `cd ${quotePosix(cwd)}`;
}

// ─── WSL startup-command init channel ──────────────────────────────────────
//
// The env var carrying a WSL pane's init-time command list into the distro.
export const WSL_STARTUP_ENV = 'WMUX_STARTUP_B64';

/**
 * The commands a WSL pane should run inside its own init, or null when there
 * are none: the `cd` from wslCdCommand first, then any quick-launch profile
 * command or replayed `report_startup_command`.
 *
 * Handing them to the shell instead of typing them is what stops them being
 * echoed above the first prompt — the same trick PowerShell already gets via
 * WMUX_STARTUP_COMMANDS, which is why that one is not base64. This value has to
 * survive WSLENV, which copies the Win32 environment block into the distro: a
 * newline in an env value is not something the interop layer documents as safe,
 * and the commands routinely contain spaces, single quotes, `;` and `&&`.
 * Base64 is a single line of [A-Za-z0-9+/=] — nothing WSLENV, cmd.exe quoting or
 * the shell can chew on. Node's toString('base64') never wraps.
 *
 * Order matters and matches the order the renderer used to type them: a restore
 * command has to find itself in the pane's directory, not in $HOME.
 */
export function wslStartupPayload(
  cwdCommand: string | undefined,
  startupCommands: string[],
): string | null {
  const lines = [...(cwdCommand ? [cwdCommand] : []), ...startupCommands];
  if (lines.length === 0) return null;
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

/**
 * In-band "I have the startup commands, don't type them" ack, emitted by
 * wmux-bash-integration.sh while it is still being sourced.
 *
 * An OSC rather than a V1 pipe report because a plain WSL pane's only route back
 * to wmux is npiperelay.exe or a `wmux bridge`, and neither is guaranteed to be
 * there — _wmux_report's "native" temp-file branch has no reader in main at all.
 * An ack that can be lost, combined with the timeout below, would type commands
 * the shell has already run: for a devcontainer pane that means launching the
 * container twice. The PTY is the one channel that cannot be missing.
 *
 * 7717 is unclaimed: xterm core handles 0/1/2/4/8/10-12/52/104/110-112, the image
 * addon owns 1337, and useTerminal registers 9, 99, 777 and 52. An OSC nobody
 * registered is swallowed by the parser, never rendered.
 */
export const STARTUP_ACK = '\x1b]7717;startup-consumed\x07';

/** True when `chunk`, joined to the tail kept from the previous chunk, holds the ack. */
export function containsStartupAck(prevTail: string, chunk: string): boolean {
  return (prevTail + chunk).includes(STARTUP_ACK);
}

/** The trailing bytes of `chunk` that could still be the head of a split ack. */
export function ackTail(chunk: string): string {
  return chunk.slice(-(STARTUP_ACK.length - 1));
}

/**
 * Decides when to give up waiting for the ack and type the commands after all.
 *
 * Not a fixed delay from spawn: a cold WSL distro can take many seconds to reach
 * ~/.bashrc, so a short timer fires before the shell exists and a long one makes
 * the no-integration case feel broken. Wait for quiescence instead — nothing at
 * all until the PTY's first byte, then restart the window on every chunk, so it
 * only expires once the shell has gone quiet, i.e. is sitting at a prompt.
 *
 * That is causally safe rather than timing-lucky: the integration script acks
 * while the rc is still being sourced, which is strictly before the first prompt,
 * which is strictly before quiescence. The cap covers a shell that streams
 * forever and never idles.
 */
export interface StartupFallback {
  /** Feed one chunk of PTY output. Arms on the first call, re-arms on each one. */
  onData(): void;
  /** The shell acked, or another caller took ownership — never fire. */
  cancel(): void;
}

export function createStartupFallback(opts: {
  onFire: () => void;
  quiescenceMs?: number;
  capMs?: number;
}): StartupFallback {
  const quiescenceMs = opts.quiescenceMs ?? 1200;
  const capMs = opts.capMs ?? 15000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const fire = (): void => {
    if (done) return;
    done = true;
    clear();
    opts.onFire();
  };
  function clear(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
  }

  return {
    onData(): void {
      if (done) return;
      // The cap runs from the first byte, not from spawn: before that there is
      // no evidence a shell exists to type into.
      if (!capTimer) capTimer = setTimeout(fire, capMs);
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, quiescenceMs);
    },
    cancel(): void {
      if (done) return;
      done = true;
      clear();
    },
  };
}

/**
 * Propagate WMUX_* vars into the WSL distro (issue #60). Without WSLENV, WSL
 * strips every Windows env var, so the notification framework, sidebar and
 * `wmux` CLI inside WSL can't reach the host. /u = pass through, /up = pass
 * through AND translate the Windows path to a WSL mount (/mnt/c/...).
 *
 * WMUX_REMOTE/WMUX_REMOTE_TOKEN must travel too (issue #78): a WSL pane cannot
 * open a Windows named pipe, so the CLI and shell integration reach wmux over
 * the TCP bridge instead — without these two the pane silently reports nothing
 * until the user exports them by hand.
 *
 * WMUX_STARTUP_B64 is /u and must stay /u: it is base64, not a path. /p or /l
 * would have the interop layer rewrite it, and /l would split it on separators.
 * Listing a name whose variable is unset is free — WSLENV skips it — so this can
 * be built here even though the value is only set later, in create().
 */
export const WMUX_WSLENV =
  'WMUX/u:WMUX_SURFACE_ID/u:WMUX_CLI/up:WMUX_PIPE/u:WMUX_PIPE_TOKEN/u:WMUX_INTEGRATION/u'
  + ':WMUX_REMOTE/u:WMUX_REMOTE_TOKEN/u'
  + `:${WSL_STARTUP_ENV}/u`;

// Build the launch args for a shell and mutate `env` with shell-specific vars.
// Kept out of create() so that hot path stays under the cognitive-complexity
// budget. `env` is mutated in place (integration script paths, WSLENV, etc.).
function buildShellArgs(
  shellType: ReturnType<typeof getShellType>,
  env: { [key: string]: string },
  integrationDir: string,
  cwd: string | undefined,
): string[] {
  if (shellType === 'powershell') {
    const script = path.join(integrationDir, 'wmux-powershell-integration.ps1');
    if (fs.existsSync(script)) {
      env.WMUX_PS1_SCRIPT = script;
      return ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', '. $env:WMUX_PS1_SCRIPT'];
    }
    console.warn(`[wmux] shell-integration not found at: ${script} — starting PowerShell without integration`);
    return ['-NoLogo'];
  }
  if (shellType === 'cmd') {
    return ['/K', path.join(integrationDir, 'wmux-cmd-integration.cmd')];
  }
  if (shellType === 'wsl') {
    env.WMUX_INTEGRATION = '1';
    env.WSLENV = env.WSLENV ? `${env.WSLENV}:${WMUX_WSLENV}` : WMUX_WSLENV;
    // A restored WSL/POSIX cwd (issue #60) can't be a Win32 process cwd (error
    // 267). Open it INSIDE the distro via --cd instead; the Win32-side cwd is
    // sanitized to a valid Windows dir by the caller.
    //
    // --cd is BEST-EFFORT: WSL applies it before the interactive login shell
    // reads its rc, so a distro whose /etc/profile or ~/.profile cds to $HOME
    // discards it and the pane opens at home. It still gets the FIRST prompt
    // right wherever the rc leaves it alone, so keep passing it; wslCdCommand()
    // below covers the distros where it doesn't survive.
    const posixCwd = cwd && isPosixPath(cwd) ? cwd : null;
    return ['--cd', posixCwd ?? '~'];
  }
  return [];
}

interface PtyEntry {
  pty: pty.IPty;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
  // Serial queue: long writes are split into ConPTY-friendly chunks and
  // appended here so concurrent calls cannot interleave inside a single paste.
  writeChain: Promise<void>;
  pendingChunks: number;
  alive: boolean;
  // Last applied size. Used to drop redundant same-size resizes, which would
  // otherwise make the shell (PSReadLine/oh-my-posh) redraw the prompt for no
  // reason — a cause of the doubled prompt on startup.
  cols: number;
  rows: number;
  // Resolved shell + whether startup commands were baked in — returned verbatim
  // when create() is called again for the same surfaceId (idempotent reuse).
  shell: string;
  startupConsumed: boolean;
  /** Startup commands were handed to the shell's own init (WSL/PowerShell). */
  initChannel: boolean;
  /**
   * Types the startup commands if the shell never acks having them. Present only
   * while that is still undecided; see createStartupFallback.
   */
  startupFallback?: StartupFallback;
  /** Trailing bytes of the previous PTY chunk, in case the ack was split across two. */
  startupAckTail: string;
}

export interface CreateOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  /** When provided, use this as the PTY key instead of generating a new one.
   *  This keeps Surface IDs and PTY IDs in sync for reliable re-attachment. */
  surfaceId?: SurfaceId;
  /** Quick-launch profile commands (issue #32). When the shell type supports it
   *  they are baked into the shell's own startup (see `startupCommandsConsumed`
   *  in the return value) rather than injected later as keystrokes. */
  startupCommands?: string[];
}

export interface CreateResult {
  id: SurfaceId;
  shell: string;
  /** Startup commands were baked into the shell's own init, not left to type. */
  startupCommandsConsumed: boolean;
  /** A live PTY for this surfaceId already existed and was handed back as-is. */
  reused: boolean;
  /**
   * A `cd` the caller must send once the shell has a prompt, because this WSL
   * pane's login rc would otherwise discard `wsl.exe --cd` (see wslCdCommand).
   * Absent for every other shell type, and for a reused PTY — that one is
   * already sitting where it was put.
   *
   * Absent as well when `initChannel` is set — the shell runs it itself.
   */
  cwdCommand?: string;
  /**
   * The shell was given its startup commands (and `cwdCommand`) to run inside
   * its own init, so the caller must type nothing. Where a shell might not
   * cooperate — a WSL distro that never sources the integration script — main
   * types them itself after the pane goes quiet, still without the caller.
   */
  initChannel?: boolean;
}

// Primary Device Attributes (DA1). oh-my-posh / PSReadLine probe the terminal
// with a DA1 query and block briefly for the reply before drawing the prompt.
//
// xterm answers DA1 too, but its reply travels a slow multi-process round-trip
// (main → renderer → xterm → renderer → main → pty). That latency is the cause
// of three symptoms users saw: the reply arriving after the prompt was drawn and
// leaking onto the command line as `\x1b[?62;4;9;22c`; and, once xterm's reply
// was suppressed to stop that leak, the probe getting no reply at all — so the
// prompt stalled ~3-5s on the probe's timeout and re-rendered (a doubled prompt).
//
// Answering here, in the same process as the PTY, is effectively instant, so the
// probe is satisfied before the prompt draws: one clean prompt, no junk, no
// stall. xterm's own DA1 reply is suppressed in useTerminal so this is the only
// one. The query is `\x1b[c` or `\x1b[<n>c` (no `?`/`>`/`=` prefix — those are
// the reply / DA2 / DA3 forms, which this deliberately does not match). The
// reply advertises the same attributes xterm-with-image did (62=VT220, 4=Sixel,
// 9, 22=ANSI color) so image-capable apps still detect support.
// eslint-disable-next-line no-control-regex -- ESC is intentional: this matches the DA1 query byte-for-byte
const DA1_QUERY = /\x1b\[\d*c/;
const DA1_REPLY = '\x1b[?62;4;9;22c';

export class PtyManager {
  private ptys = new Map<SurfaceId, PtyEntry>();

  /**
   * Optional on-disk record of every PID spawned here, so the next launch can
   * tree-kill whatever this process left running if it dies without reaching
   * `killAll()` (issue #139). Optional rather than constructed internally
   * because tests spawn real PTYs: without an explicit ledger they must not
   * touch — let alone overwrite — the ledger of the wmux instance the user has
   * running on the same machine.
   */
  constructor(private readonly ledger: PtyLedger | null = null) {}

  // ConPTY's input pipe silently drops bytes when a single write outruns the
  // foreground process. Splitting at ~1 KB keeps every chunk well under the
  // pipe buffer; setImmediate between chunks lets ConPTY drain without adding
  // perceptible latency.
  private static readonly CHUNK_THRESHOLD = 1024;
  private static readonly CHUNK_SIZE = 1024;

  create(options: CreateOptions): CreateResult {
    const id: SurfaceId = options.surfaceId ?? `surf-${uuidv4()}` as SurfaceId;

    // Idempotent per surfaceId. React StrictMode (dev) double-mounts the terminal
    // component, and the renderer's `pty.has()` check is async — so create() can
    // fire twice for the same surface before the first spawn registers. Without
    // this guard the second call spawns a SECOND PowerShell process under the
    // same id: both stream to the renderer (doubled prompt + every keystroke
    // echoed twice) and the first leaks as an orphan. Reuse the live PTY instead.
    if (options.surfaceId) {
      const existing = this.ptys.get(options.surfaceId);
      if (existing && existing.alive) {
        return {
          id: options.surfaceId,
          shell: existing.shell,
          startupCommandsConsumed: existing.startupConsumed,
          reused: true,
          initChannel: existing.initChannel,
        };
      }
    }

    // Split "ssh user@host"-style specs into executable + args (issue #78).
    // Extra args only apply when the REQUESTED executable resolved — if we fell
    // back to the default shell, its command line must not inherit ssh's args.
    const spec = parseShellSpec(options.shell);
    // A POSIX cwd forces wsl.exe — pwsh/cmd cannot open that directory at all
    // and would silently start in %USERPROFILE% instead of the project.
    const shell = resolveShellForCwd(resolveShell(spec.command), options.cwd);
    const shellExtraArgs = shell === spec.command ? spec.args : [];
    const shellType = getShellType(shell);
    const integrationDir = getShellIntegrationPath();
    const cliPath = getCliPath();
    // Filter out undefined values from process.env before merging
    const processEnvClean = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    const env: { [key: string]: string } = {
      ...processEnvClean,
      ...options.env,
      WMUX: '1',
      WMUX_SURFACE_ID: id,
      WMUX_PIPE: getPipePath(),
      WMUX_PIPE_TOKEN: readPipeToken(),
      WMUX_CLI: cliPath,
    };

    // Make bare `wmux` resolvable in every spawned shell AND all its children
    // (Claude Code's Bash tool, hook scripts, the orchestrator coordinator) by
    // prepending the cli-bin shim dir to PATH. PATH inherits down the process
    // tree regardless of shell/login/interactive state — which is exactly what
    // the interactive `wmux` shell function cannot reach. Prepend (not append)
    // so this instance's shim wins; it is instance-scoped via $WMUX_CLI/$WMUX_PIPE
    // anyway. The Windows env key is `Path`, so match case-insensitively.
    const cliBinDir = getCliBinPath();
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = env[pathKey] ? `${cliBinDir}${path.delimiter}${env[pathKey]}` : cliBinDir;

    const args = [...buildShellArgs(shellType, env, integrationDir, options.cwd), ...shellExtraArgs];

    // Quick-launch startup commands (issue #32). Run them as part of the shell's
    // own initialization — BEFORE the first interactive prompt — instead of
    // injecting them later as keystrokes (`pty.write('<cmd>\r')`).
    //
    // The keystroke approach raced the shell's init-time terminal queries: with
    // oh-my-posh/PSReadLine, ConPTY answers a Device Attributes query (DA1) by
    // writing `\x1b[?62;4;9;22c` onto the shell's stdin. If that response landed
    // on the prompt the same instant our injected `<cmd>\r` arrived, PSReadLine
    // merged them into one bogus executed line (e.g. `62;4;9;22ccls`). Baking the
    // commands into the integration script (via WMUX_STARTUP_COMMANDS) removes
    // the race: they run during init and the first prompt render — the only one
    // that triggers the leaky query — happens afterward, exactly as it does for a
    // plain terminal that shows no junk.
    const startupCommands = (options.startupCommands ?? []).filter(
      (cmd): cmd is string => typeof cmd === 'string' && cmd.trim().length > 0,
    );
    let startupCommandsConsumed = false;
    if (startupCommands.length > 0 && shellType === 'powershell' && env.WMUX_PS1_SCRIPT) {
      // Newlines survive the env block; the integration script trims each line
      // (so a stray CR is harmless) and runs it via Invoke-Expression.
      env.WMUX_STARTUP_COMMANDS = startupCommands.join('\n');
      startupCommandsConsumed = true;
    }

    // A WSL pane has one more command to run than any other: the distro's login
    // rc may have cd'd away from --cd's directory, so the pane has to be told
    // where it is (see wslCdCommand). It goes first — a restore command has to
    // find itself in the project, not in $HOME.
    let cwdCommand = wslCdCommand(shellType, options.cwd) ?? undefined;

    // The WSL counterpart to WMUX_STARTUP_COMMANDS. There is no profile to bake
    // anything into, so the list travels as base64 in the environment and
    // wmux-bash-integration.sh runs it from the shell's first precmd — after
    // every rc file, so a /etc/profile that cds to $HOME cannot undo it.
    //
    // Unlike PowerShell this is not a promise: wmux installs no rc hook inside a
    // distro, so nothing here proves the integration script will be sourced.
    // Hence `fallbackLines` and the timer below, which reproduce exactly what
    // the renderer used to do when the shell turns out not to cooperate.
    let initChannel = false;
    let fallbackLines: string[] = [];
    if (shellType === 'wsl') {
      const payload = wslStartupPayload(cwdCommand, startupCommands);
      if (payload) {
        env[WSL_STARTUP_ENV] = payload;
        fallbackLines = [...(cwdCommand ? [cwdCommand] : []), ...startupCommands];
        startupCommandsConsumed = true;
        initChannel = true;
        // Owned by the init channel now. Leaving it set would have the caller
        // type the `cd` on top of the shell having already run it.
        cwdCommand = undefined;
      }
    }

    // CreateProcess fails with error 267 (ERROR_DIRECTORY) when the working dir
    // isn't a real directory, and node-pty surfaces that as an opaque "Cannot
    // create process, error code: 267" — the pane just dies. Two ways to get
    // there, both fixed by falling back to a directory that exists:
    //
    //  - a POSIX/WSL cwd restored from session.json (issue #60) is never a valid
    //    Win32 working dir. WSL itself still reaches the POSIX path via --cd above.
    //  - a Win32 cwd that has since been deleted, or has not been created yet:
    //    an agent spawned into a git worktree that was removed after its wave, or
    //    ordered before `git worktree add` finished. The cwd comes from session
    //    state / CLI args, so it must not be trusted to still exist at spawn time.
    const spawnCwd = resolveSpawnCwd(options.cwd);

    const spawnOptions: pty.IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: spawnCwd,
      env,
      useConpty: true,
      // The OS-inbox ConPTY garbles fast TUI repaints (stray inverse cells at
      // the app's cursor position — issues #23/#30). Use node-pty's bundled
      // modern conpty.dll instead; it resolves relative to the loaded
      // conpty.node, so prebuilds/win32-x64/conpty/ must ship in the package.
      useConptyDll: true,
    };
    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell, args, spawnOptions);
    } catch (err) {
      console.warn('[wmux] spawn with bundled conpty.dll failed, retrying with inbox ConPTY:', err);
      ptyProcess = pty.spawn(shell, args, { ...spawnOptions, useConptyDll: false });
    }

    const entry: PtyEntry = {
      pty: ptyProcess,
      dataListeners: new Set(),
      exitListeners: new Set(),
      writeChain: Promise.resolve(),
      pendingChunks: 0,
      alive: true,
      cols: spawnOptions.cols ?? 80,
      rows: spawnOptions.rows ?? 24,
      shell,
      startupConsumed: startupCommandsConsumed,
      initChannel,
      startupAckTail: '',
    };

    if (initChannel && fallbackLines.length > 0) {
      entry.startupFallback = createStartupFallback({
        onFire: () => {
          entry.startupFallback = undefined;
          if (!entry.alive) return;
          console.warn(
            `[wmux] ${id}: no shell-integration ack for the startup commands — typing them instead.`
            + ' Source wmux-bash-integration.sh in the distro to run them silently.',
          );
          for (const line of fallbackLines) this.write(id, `${line}\r`);
        },
      });
    }

    ptyProcess.onData((data) => {
      // Answer DA1 probes in-process so the prompt never stalls or leaks the
      // reply (see DA1_QUERY note above). Only the escape character is common
      // enough to warrant the cheap guard before the regex scan.
      if (entry.alive && data.indexOf('\x1b[') !== -1 && DA1_QUERY.test(data)) {
        try { ptyProcess.write(DA1_REPLY); } catch { /* pty disposed between events */ }
      }
      // Before the fan-out, so the decision is made on the same bytes the
      // renderer is about to see — and so a listener that throws cannot leave
      // the fallback armed against a shell that already ran the commands.
      if (entry.startupFallback) {
        if (containsStartupAck(entry.startupAckTail, data)) {
          entry.startupAckTail = '';
          this.cancelStartupFallback(id);
        } else {
          entry.startupAckTail = ackTail(data);
          entry.startupFallback.onData();
        }
      }
      for (const listener of entry.dataListeners) {
        listener(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      entry.alive = false; // stops any in-flight chunked write
      entry.startupFallback?.cancel();
      entry.startupFallback = undefined;
      if (typeof ptyProcess.pid === 'number') this.ledger?.remove(ptyProcess.pid);
      for (const listener of entry.exitListeners) {
        listener(exitCode);
      }
      this.ptys.delete(id);
    });

    // Recorded after the listeners are attached but before returning, so a
    // crash between here and the first user keystroke still leaves a trail.
    if (typeof ptyProcess.pid === 'number' && ptyProcess.pid > 0) {
      this.ledger?.add(ptyProcess.pid, path.basename(shell));
    }

    this.ptys.set(id, entry);
    return { id, shell, startupCommandsConsumed, reused: false, cwdCommand, initChannel };
  }

  /**
   * Stop waiting for the shell integration's ack: never type the startup
   * commands into this pane. A no-op once the pane has acked, fired or exited.
   *
   * Public because the fallback is not the only clock. AgentManager writes its
   * own `cd` synchronised to the prompt it detects; without this, the two can
   * cross and the pane runs the same command twice.
   */
  cancelStartupFallback(id: SurfaceId): void {
    const entry = this.ptys.get(id);
    if (!entry?.startupFallback) return;
    entry.startupFallback.cancel();
    entry.startupFallback = undefined;
  }

  write(id: SurfaceId, data: string): void {
    const entry = this.ptys.get(id);
    if (!entry || !entry.alive || data.length === 0) return;

    // Fast path: single keystrokes, control sequences, short responses bypass
    // the queue entirely so typing latency is unchanged.
    if (data.length <= PtyManager.CHUNK_THRESHOLD && entry.pendingChunks === 0) {
      try {
        entry.pty.write(data);
      } catch {
        // pty was killed between get() and write()
      }
      return;
    }

    // Slow path: long paste — enqueue behind any in-flight chunked writes so
    // their bytes can't interleave.
    entry.pendingChunks++;
    entry.writeChain = entry.writeChain
      .then(() => this.writeChunked(entry, data))
      .finally(() => {
        entry.pendingChunks = Math.max(0, entry.pendingChunks - 1);
      });
  }

  private writeChunked(entry: PtyEntry, data: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let offset = 0;
      const writeNext = () => {
        if (!entry.alive || offset >= data.length) {
          resolve();
          return;
        }
        const end = Math.min(offset + PtyManager.CHUNK_SIZE, data.length);
        try {
          entry.pty.write(data.slice(offset, end));
        } catch {
          // pty disposed mid-paste — abandon the rest silently
          resolve();
          return;
        }
        offset = end;
        setImmediate(writeNext);
      };
      writeNext();
    });
  }

  resize(id: SurfaceId, cols: number, rows: number): void {
    const entry = this.ptys.get(id);
    // `alive`, not just presence: the exit handler clears the flag before the
    // entry leaves the map, and node-pty throws "Cannot resize a pty that has
    // already exited" for anything in that window. A pane reflowing while its
    // shell exits hits it, and this runs in the main process, where an
    // unhandled throw is a crash rather than a warning. write() has guarded
    // this way for a while; resize() was the one PTY entry point that didn't.
    if (!entry || !entry.alive) return;
    // Drop no-op resizes: a same-size resize still makes the shell redraw its
    // prompt (doubled-prompt cause). Only forward genuine size changes.
    if (cols === entry.cols && rows === entry.rows) return;
    entry.cols = cols;
    entry.rows = rows;
    try {
      entry.pty.resize(cols, rows);
    } catch {
      // Exited between the liveness check and the call — nothing to resize.
    }
  }

  kill(id: SurfaceId): void {
    const entry = this.ptys.get(id);
    if (!entry) return;

    entry.alive = false; // signals any in-flight chunked write to stop
    entry.startupFallback?.cancel();
    entry.startupFallback = undefined;
    const pid = entry.pty.pid;

    // Tree-kill the shell's whole process subtree BEFORE closing the pseudoconsole
    // (issue #65). With `useConptyDll: true`, node-pty's DLL kill path only calls
    // ClosePseudoConsole — it terminates the directly-attached wrapper shell but
    // NOT grandchildren that don't share the console lifetime, notably Claude
    // Code's persistent `-s` backend (`powershell … -s …`), which then orphans.
    // `taskkill /T /F` walks the parent→child snapshot and force-kills the entire
    // tree while it's still intact. Spawned detached + unref'd so it's non-blocking
    // and survives even when this runs from killAll() on app quit.
    if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
      try {
        // Resolve taskkill by absolute path from %SystemRoot%\System32 rather than
        // relying on PATH — PATH could contain a writeable dir shadowing taskkill.
        const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
        const taskkillPath = path.join(systemRoot, 'System32', 'taskkill.exe');
        const killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
        killer.on('error', () => { /* taskkill missing / already gone */ });
        killer.unref();
      } catch {
        // spawn failed (e.g. taskkill unavailable) — fall back to pty.kill below
      }
    }

    try {
      entry.pty.kill();
    } catch {
      // Process may already be dead
    }
    if (typeof pid === 'number') this.ledger?.remove(pid);
    this.ptys.delete(id);
  }

  killAll(): void {
    for (const id of this.ptys.keys()) {
      this.kill(id);
    }
    // Belt and braces: kill() already dropped each PID, but killAll() is the
    // shutdown path and the ledger must not outlive it under any partial failure.
    this.ledger?.clear();
  }

  has(id: SurfaceId): boolean {
    return this.ptys.has(id);
  }

  onData(id: SurfaceId, callback: (data: string) => void): () => void {
    const entry = this.ptys.get(id);
    if (!entry) {
      return () => {};
    }
    entry.dataListeners.add(callback);
    return () => entry.dataListeners.delete(callback);
  }

  onExit(id: SurfaceId, callback: (code: number) => void): () => void {
    const entry = this.ptys.get(id);
    if (!entry) {
      return () => {};
    }
    entry.exitListeners.add(callback);
    return () => entry.exitListeners.delete(callback);
  }

  getPid(id: SurfaceId): number | undefined {
    const entry = this.ptys.get(id);
    return entry?.pty.pid;
  }
}
