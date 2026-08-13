# wmux config file

wmux reads `~/.wmux/config.toml` on startup (Windows: `%USERPROFILE%\.wmux\config.toml`).
The file is optional — if it isn't present, built-in defaults apply.

Edit it, then run `wmux reload-config` (or restart wmux) to pick up changes.

## Full example

```toml
[terminal]
font-family      = "Cascadia Mono"
font-size        = 14
cursor-style     = "block"        # block | underline | bar
cursor-blink     = true
scrollback-lines = 10000

[terminal.colors]
# Default scheme for every new pane. Any bundled theme name works
# (see `wmux list-themes`), or the key of a user-defined scheme below.
default = "Dracula"

# User-defined named schemes — override individual fields of the base theme.
# Invoke them with:   wmux split --color-scheme prod
[terminal.colors.schemes.prod]
background = "#2b0b0b"
foreground = "#ffdddd"
cursor     = "#ff5555"

[terminal.colors.schemes.staging]
background = "#2b1f0b"
foreground = "#ffeecc"
cursor     = "#ffaa44"

[terminal.colors.schemes.dev]
background = "#0b1f0b"
foreground = "#ccffcc"
cursor     = "#55ff55"

# Full palette override (up to 16 ANSI colors) — optional.
[terminal.colors.schemes.mono]
background = "#000000"
foreground = "#ffffff"
palette = [
  "#000000", "#ff0000", "#00ff00", "#ffff00",
  "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  "#555555", "#ff5555", "#55ff55", "#ffff55",
  "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
]

[keys]
# Remap what a key sends to the terminal (see "Key remaps" below).
"ctrl+k"       = "<C-k><Delete>"   # kill to end of line, then pull the next line up
"ctrl+alt+r"   = "clear<CR>"
"ctrl+shift+q" = ""                # empty value = swallow the key
```

## Key remaps

`[keys]` maps a key chord to the bytes wmux should send to the program running in
the terminal. Each entry is `"chord" = "sequence"`.

```toml
[keys]
"ctrl+k" = "<C-k><Delete>"
```

**Chords** are written `ctrl+shift+alt+key` (any subset, any order), or in the
vim style `<C-k>` / `<C-S-Tab>`. `alt` and `meta` both mean Alt.

**Sequences** are sent as typed, with `<...>` naming a key:

| Token | Sends | Token | Sends |
|---|---|---|---|
| `<CR>` / `<Enter>` | Enter | `<Up>` `<Down>` `<Left>` `<Right>` | arrow keys |
| `<Esc>` | Escape | `<Home>` `<End>` | Home / End |
| `<Tab>` / `<S-Tab>` | Tab / Shift+Tab | `<PgUp>` `<PgDn>` | Page Up / Down |
| `<BS>` | Backspace | `<Ins>` | Insert |
| `<Delete>` / `<Del>` | Delete | `<F1>`…`<F12>` | function keys |
| `<C-x>` | Ctrl+x control byte | `<Space>` | space |
| `<A-x>` / `<M-x>` | Alt+x (ESC prefix) | `<lt>` | a literal `<` |

Anything outside `<...>` is sent literally, so `"clear<CR>"` types the word and
presses Enter. An empty value (`""`) swallows the key.

Notes:

- Remaps apply **inside terminal panes only**, and they take priority over
  wmux's own shortcuts there — remapping `ctrl+t` means Ctrl+T no longer opens a
  tab while a terminal has focus.
- Modifiers match exactly: a `ctrl+k` remap does not fire on Ctrl+Shift+K.
- A binding that doesn't parse is reported by `wmux config show` and skipped;
  the rest of your bindings still apply.
- `wmux reload-config` applies edits live, including removing bindings.

## WSL working directory

Nothing to configure here — this section explains what wmux does on its own, and
the one thing you have to do in the distro for it to be seamless.

When wmux opens a WSL pane in a directory — a new tab, a split, or a pane
restored from the last session — it passes that directory to `wsl.exe --cd`.
WSL applies `--cd` **before** the interactive login shell reads its rc, so a
distro whose `/etc/profile` or `~/.profile` ends up in `$HOME` (common on
managed/corporate images) silently discards it:

```
> wsl --cd /tmp -- pwd     # non-interactive: /tmp        — --cd holds
> wsl --cd /tmp            # interactive login: ~         — the rc wins
```

The pane would then open in the home directory instead of the project, and
anything replayed into it — a quick-launch startup command, a restored session's
command — would run in the wrong place.

So wmux also sends the pane an explicit `cd '<dir>'`, plus any startup commands,
through the shell's own initialization rather than as keystrokes: they arrive
base64-encoded in `WMUX_STARTUP_B64`, and `wmux-bash-integration.sh` runs them
from the shell's first prompt hook. That is **after every rc file**, so the rc
cannot override it — and because nothing is typed at the prompt, nothing is
echoed above it. `--cd` is still passed, so on a distro that honours it the pane
is already in the right place and the `cd` is a no-op.

### Sourcing the integration script

wmux installs no rc hook inside a distro, so this only works once you source the
script yourself. It ships at `resources/shell-integration/wmux-bash-integration.sh`
in your wmux install, which WSL reaches under `/mnt/c/...`. Add to `~/.bashrc`
(or `~/.zshrc`), with the path to your own install:

```sh
WMUX_SH=/mnt/c/Users/<you>/wmux/resources/shell-integration/wmux-bash-integration.sh
[ -n "$WMUX_INTEGRATION" ] && [ -f "$WMUX_SH" ] && . "$WMUX_SH"
```

The `$WMUX_INTEGRATION` guard is what keeps the script out of shells wmux did
not start — wmux sets it (along with `WMUX_SURFACE_ID`, `WMUX_CLI` and friends)
only in the panes it spawns.

Without this, wmux waits for the pane to fall silent and then **types** the
commands instead — the pane still lands in the right directory, you just see the
`cd` line above the first prompt, and the console logs a one-line warning.

Notes:

- WSL panes only. PowerShell and cmd panes get a real Win32 working directory,
  which Windows does not let an rc file take away; PowerShell has had the
  equivalent init-time path via `WMUX_STARTUP_COMMANDS` all along.
- Panes that are already open keep their directory; this applies at pane
  creation.
- The real fix, where you control the image, is to stop the login rc from
  changing directory — then `--cd` works on its own and none of this is needed.
- Removed after 0.44.0: the `[wsl] enforce-cwd` option. It existed only to suppress
  the echoed `cd` line, which no longer happens; setting it to `false` on a
  distro whose rc discards `--cd` just put every pane in `$HOME`. An
  `enforce-cwd` left in your config is ignored, not an error.

## Precedence

1. Built-in defaults
2. Settings UI values (persisted to Zustand / localStorage)
3. **`config.toml`** — applied over 1 and 2 at startup and on `reload-config`
4. Per-pane overrides (e.g. `wmux split --color-scheme prod`) — always win for that pane

"File wins at startup, app wins at runtime": if you tweak a value in the Settings
UI after wmux booted, your tweak sticks until the next reload.

## CLI helpers

```bash
wmux config path      # print the config file path
wmux config show      # dump the parsed config (useful for debugging syntax)
wmux config reload    # re-read the file and apply to running surfaces
wmux reload-config    # alias of `config reload`
wmux list-themes      # print all valid `default`/`--color-scheme` names
```

## Notes

- Keys can be written either `kebab-case` or `camelCase`
  (`font-family` and `fontFamily` both work).
- `cursor` inside a scheme is the cursor color; use `cursor-style` (under `[terminal]`)
  for the shape.
- A parse error in one key is reported in `wmux config show` but never
  aborts loading — the rest of the file still applies.
- Per-pane overrides via `wmux split --color-scheme NAME` or
  `wmux set-color-scheme [id] NAME` always take precedence for that surface.
