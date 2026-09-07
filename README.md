# Openers (Obsidian plugin)

**Status: 0.1.0 — feature-complete v1: finder/terminal/cmd buttons, global
defaults + per-block merge, settings, public API.** Design:
[`spec/001-architecture.md`](spec/001-architecture.md).

One [Obsidian](https://obsidian.md) code block — **one line of buttons that
open a directory or file elsewhere on the machine**: the file manager
(Finder), a terminal at the dir, or any CLI that takes a path
(`zed <dir>`, `cursor <dir>`). Global settings define the default line;
blocks extend, override, or disable it. A typed replacement for
hand-written `[Dir](file:///…)` links.

## Embed in a note

Global defaults only (Settings → Openers ships with Finder + Terminal):

````markdown
```openers
dir: /Users/roman/spaces/loomp-tools/obsidian/viz
```
````

Per-block buttons — string shorthand, named map form, disable a global:

````markdown
```openers
dir: ~/dev/some-project
label: Some Project
buttons:
  zed: zed
  cursor:
    name: Cursor
    cmd: cursor
  notes: false
```
````

The body can be simple `key: value` lines (nested maps, `- item` lists,
inline flow maps `{zed: zed}`, `key: |` block scalars) or one JSON object.
Paths are absolute, `~`-expanded, `file://` URLs (paste migration), or
vault-relative. `file:` works the same as `dir:` — Terminal opens the
containing folder for file targets, Finder reveals and selects the file.

## Highlights

- **One block, one line** — path chip (label + folder/file icon, tooltip =
  full path) + one pill per button (tooltip = the exact command it runs).
- **Three kinds** — `finder` (Electron shell, OS-agnostic by construction),
  `terminal` (macOS `open -a Terminal|<app>`, Linux terminal probe, Windows
  best-effort), `cmd` (any executable; the path is appended, or substituted
  for `{path}`; `{dir}` also available).
- **Globals + merge** — settings define the default line; blocks override
  in place (`zed: zed-nightly`), extend (`cursor:`), or disable
  (`notes: false`).
- **No shell anywhere** — argv arrays only; spaces in paths are safe and
  nothing from the note is ever interpreted. Spawned detached, so editors
  that stay alive never block Obsidian.
- **Binary autodetection** — GUI apps inherit launchd's minimal PATH, so
  bare names are probed against `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin`, `~/bin`, then `PATH`; failures surface as actionable
  Notices.
- **Missing paths degrade visibly** — dashed path chip, click explains
  itself.

## Settings

- **Buttons** — one card per global button: kind (Finder / Terminal /
  Command), id chip (the key blocks reference), name, enabled toggle,
  delete; Command buttons get a `Command` field (`zed`, `code -r`,
  `nvim {path}`), Terminal buttons a macOS app name (empty = Terminal;
  e.g. iTerm, WezTerm, Warp), all get an optional lucide icon.
- Fresh installs seed `finder` + `terminal`; add command buttons (suggested
  ids `app`, `app-2`, …) or edit `data.json` by hand.

## Install (manual)

Copy `main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/openers/`, then enable **Openers** under
Settings → Community plugins. Desktop only (spawns local executables).

## API

`globalThis.openers` (version 1):

```js
const api = globalThis.openers;
api.version;                          // 1
api.buttons();                        // [{ id, kind, name, cmd, enabled }]
api.open("/some/dir", "zed");         // resolve + run a global button
const handle = api.render(el, source);// render the widget into any element
handle.unload();
```

## Development

Plain single-file plugin, no build step (`main.js` is hand-written ES2022).
`node --check main.js` to syntax-check; design docs in `spec/`; sample
blocks in `examples/widgets.md`; node harness in `examples/fixtures/`.
Excluded from the repo: `data.json` (local settings) and `.hotreload`
(dev marker).
