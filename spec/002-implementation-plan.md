# 002 — Implementation Plan

Status: done
Date: 2026-09-07
Depends on: spec/001-architecture.md
Convention: single-file `main.js`, hand-written ES2022, no build step
(`node --check main.js` to syntax-check). Estimates assume that style.

## Phase overview

| Phase | Scope | Est. | Release | Risk |
| ----- | ----- | ---- | ------- | ---- |
| 0 | Repo scaffolding, spec, manifest, styles, README | 0.25 d | – | – |
| 1 | Parser (nested maps), path resolution, merge, widget render | 0.5 d | 0.1.0 | low |
| 2 | Actions (finder/terminal/cmd), settings tab, API, fixtures, vault install | 0.5 d | 0.1.0 | low (per-OS terminal table) |

Small enough to land as one 0.1.0 release; phases kept for review order.

---

## Phase 0 — scaffolding

- [x] Repo `~/spaces/loomp-tools/obsidian/openers` (`main.js`,
      `manifest.json`, `styles.css`, `spec/`, `examples/`), `.gitignore`
      (`data.json`, `.hotreload`, `.DS_Store`), MIT LICENSE.
- [x] `manifest.json` — id `openers`, desktop-only, minAppVersion 1.4.0.

## Phase 1 — config, merge, widget

- [x] Block parser: recursive maps (the siblings' flat parser extended),
      lists, flow lists/maps, `key: |` block scalars, JSON-object config;
      clear errors for bad indentation / valueless keys.
- [x] `resolveWidgetPath`: `dir:`/`file:` (exactly one), `~`, `file://`
      URLs, vault-relative fallback, existence + dir/file detection.
- [x] `mergeButtons(settings.buttons, block.buttons)`: string/map/false/
      true specs, in-place overrides, appended extras, validation errors.
- [x] Widget: one line — path chip + pill buttons, icons, title = exact
      command, missing-path styling, error card.

## Phase 2 — actions, settings, API

- [x] `finder` via Electron `shell.openPath`/`showItemInFolder` (darwin
      `open` fallback); `terminal` per-OS table (macOS `open -a`, Linux
      probe list, Windows best-effort); `cmd` quote-aware tokenizer,
      `{path}`/`{dir}` placeholders, binary probing (launchd PATH),
      detached spawn + Notice on failure.
- [x] Settings tab: button cards (kind, id chip, name, enabled, delete,
      per-kind fields, icon), Add command button with suggested ids.
- [x] `globalThis.openers` v1: `buttons()`, `open(path, id)`, `render()`.
- [x] Fixtures (`examples/fixtures/01-config-buttons.js`) + examples note;
      `node --check` green.
- [x] Vault install (copy 3 files, `data.json` with finder + terminal +
      zed, community-plugins registration) + session-note widgets.

**Acceptance:** a ```openers block with only `dir:` renders Finder,
Terminal, Zed (from the vault's global config); clicks open the dir in
each; `zed: zed`-style per-block config and `notes: false` disable work;
bad blocks render the error card; fixtures exit 0.
