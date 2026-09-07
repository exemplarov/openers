# 001 — Openers: One Line of Open-In Buttons

Status: implemented
Date: 2026-09-07
Applies to: openers ≥ 0.1.0
Convention: sibling of `opencode-sessions` and `viz` — single-file `main.js`,
hand-written ES2022, no build step (`node --check main.js`), desktop-only,
spec-first.

## 1. Goal

One Obsidian code block = one line of buttons that open a directory or file
elsewhere on the machine: the system file manager (Finder), a terminal
window at the dir, or any editor/CLI that takes a path (`zed <dir>`,
`cursor <dir>`). Global settings define the default button line; blocks
extend, override, or disable it. A typed, consistent replacement for
hand-written `[Dir](file:///…)` links.

Typical use: the top of a project's sessions note carries one `openers`
block for the project dir; Finder/Terminal/Zed are one click each.

Non-requirements that shape the design: no file picker or insertion UI
(the author writes the path), no remote/SSH opening, no workspace-file
integrations — just argv.

## 2. Non-goals (v1)

- No mobile support (process spawning + Electron shell →
  `isDesktopOnly: true`).
- No URL/protocol handler (nothing addressable from outside notes).
- No command palette / editor commands — the widget is the only surface
  (plus a small `globalThis.openers` API).
- No per-OS GUI automation beyond "open dir in terminal" and "reveal in
  file manager".
- No change to the single-file convention.

## 3. Concepts

| term | meaning |
| ---- | ------- |
| **target** | resolved absolute path (dir **or** file) the buttons act on |
| **button** | one action: `{ id, kind, name, cmd?, app?, icon?, enabled }` |
| **kind** | `finder` \| `terminal` \| `cmd` |
| **global** | the settings-defined default button line |
| **merge** | block-level `buttons:` layered over the global line |

## 4. Widget: one code block — one line of buttons

### 4.1 Examples

Global defaults only (whatever Settings → Openers defines — ships with
Finder + Terminal):

````markdown
```openers
dir: /Users/roman/spaces/loomp-tools/obsidian/viz
```
````

Per-block buttons: extend with a command button (string shorthand), a
named one (map form), and disable a global:

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

Inline flow form works too:

````markdown
```openers
file: ./notes/spec.md
buttons: { vi: { name: Vim, cmd: "nvim {path}" } }
```
````

### 4.2 Config schema

Same contract as the siblings: simple `key: value` lines (now with
**nested maps**, lists, flow lists/maps, `key: |` block scalars) or one
JSON object.

| key | default | description |
| --- | ------- | ----------- |
| `dir` / `file` | — (exactly one required) | target path; both given → error card |
| `label` | basename | path-chip label |
| `buttons` | – | merge map, §4.3 |

Path rules: absolute, `~`-expanded, `file://` URLs accepted
(paste-migration), anything else resolves against the vault root.
Existence is checked at render; a missing path renders dimmed/dashed and
clicks explain themselves (Notice), so renamed dirs degrade visibly
instead of silently.

### 4.3 Merge semantics

Block `buttons:` is a map `id → spec` layered over the enabled globals
(in settings order):

| spec | effect |
| ---- | ------ |
| `"zed"` (string) | command button `{ id, kind: cmd, cmd: "zed", name: capitalize(id) }`; if `id` collides with a global, it overrides `cmd` in place (position, name, icon kept) |
| `{ name, cmd, icon?, kind?, app? }` (map) | same, with explicit fields; colliding ids override field-by-field in place |
| `false` | removes the global with that id |
| `true` | no-op (kept for symmetry) |
| anything else | error card naming the id |

New ids append after the globals (config order). `kind` must be one of
`finder | terminal | cmd` (unknown → error card); `cmd`-kind buttons
require a `cmd` (global fallback counts when overriding one).

## 5. Actions

### 5.1 `finder` — open in file manager

OS-agnostic by construction: Electron `shell.openPath(dir)` for dirs,
`shell.showItemInFolder(file)` for files (reveal + select, the behavior
of a `file://` link). Fallback when Electron is unavailable: `/usr/bin/open`
on macOS, error Notice otherwise.

### 5.2 `terminal` — open a terminal at the dir

Terminals cannot open files: a file target opens its **parent dir**.

| platform | command |
| -------- | ------- |
| darwin | `open -a <app|Terminal> <dir>` — `app` from the button (`iTerm`, `WezTerm`, `Warp`, …) |
| win32 | `cmd.exe /c start "" /D <dir> cmd.exe` (best-effort, documented) |
| linux | probe `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `wezterm`, `kitty`, `alacritty`, `terminator` with the right flag per terminal |

### 5.3 `cmd` — run a CLI with the target

- `cmd` is split into tokens **quote-aware** (no shell; args array —
  spaces in paths are safe).
- Placeholders: `{path}` (the target) and `{dir}` (its dir) are
  substituted; when no `{path}` appears, the path is **appended**.
  `zed` ⇒ `zed <path>`; `nvim {path}` ⇒ `nvim <path>`; `code -r` ⇒
  `code -r <path>`.
- Binary resolution: GUI apps inherit launchd's minimal PATH, so bare
  names are probed against `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin`, `~/bin`, then `PATH`; slashed paths pass through
  untouched. Unresolved names still spawn (loud ENOENT Notice with a
  hint).
- Spawned `detached: true, stdio: "ignore"`, `unref()` — editors that
  stay alive never block Obsidian; spawn errors surface as Notices.

## 6. Settings model (`data.json`)

```jsonc
{
  "schemaVersion": 1,
  "buttons": [
    { "id": "finder",   "kind": "finder",   "name": "Finder",   "icon": "folder",   "enabled": true },
    { "id": "terminal", "kind": "terminal", "name": "Terminal", "icon": "terminal", "app": "", "enabled": true },
    { "id": "zed",      "kind": "cmd",      "name": "Zed",      "cmd": "zed", "icon": "code", "enabled": true }
  ]
}
```

- Fresh installs seed the two built-ins (`finder`, `terminal`); an
  existing `buttons` array (even empty) is respected as-is.
- Settings UI = the sibling card pattern: kind label, id chip (monospace
  — the key blocks reference), inline-editable name, enabled toggle,
  delete; per-kind fields (`Command` for cmd, `Terminal app` for
  terminal, `Icon` lucide name for all); **Add command button** with
  suggested ids (`app`, `app-2`, …).
- Buttons are plain data — nothing prevents two terminals (`Terminal` +
  `iTerm`) or editing `data.json` by hand; unknown kinds are dropped
  with a console warning at load.

## 7. Rendering & lifecycle

- One line: path chip (icon `folder`/`file`, label, `title` = full path)
  + one pill button per merged button (optional lucide icon via
  `setIcon`, label, `title` = the exact command it runs).
- Missing target: path chip dashed/error-tinted, `title` notes it.
- Config errors (no `dir:`/`file:`, both, bad `buttons:`, …) render the
  sibling-style inline error card.
- `MarkdownRenderChild` via `ctx.addChild`; nothing to tear down (no
  timers/observers). Live Preview and reading view share the block
  processor entry point.

## 8. Safety

Notes run local executables by design — same local-trust model as viz's
SQL blocks. Mitigations: no shell interpolation (argv arrays only),
paths from the note are never executed themselves, spawning is
user-initiated (click), and error paths are Notices, not silent.

## 9. Public API (`globalThis.openers`, version 1)

```js
const api = globalThis.openers;
api.version;                          // 1
api.buttons();                        // [{ id, kind, name, cmd, enabled }]
api.open("/some/dir", "zed");         // resolve + run a global button
const h = api.render(el, "dir: /x");  // render the widget into any element
h.unload();
```

## 10. Testing strategy

- `node --check main.js` after every edit (house rule).
- Node harness under `examples/fixtures/` (no framework): block parser
  (nested maps, flow forms, errors), merge semantics, path resolution,
  command tokenizing + placeholders, settings normalization. Exit 0 =
  green.
- Manual matrix: macOS finder/terminal/zed/cursor × dir/file/missing ×
  live preview/reading.

## 11. Open questions

1. **Button ordering** — `order: [zed, finder]` to reorder per block?
   Deferred; globals-first then block order covers current use.
2. **More placeholders** — `{name}`, `{basename}`? Add on demand.
3. **Icon aliases for common apps** (zed/cursor glyphs)? Lucide has no
   brand icons; text labels carry it today.
4. **Windows `start` quirks** — titles/`/D` handling is best-effort;
   revisit if a Windows machine ever runs this.
