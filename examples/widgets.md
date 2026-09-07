# Openers examples

Basic — the global line (Finder, Terminal, plus whatever Settings → Openers
adds; the dev vault configures zed too):

```openers
dir: /Users/roman/spaces/loomp-tools/obsidian/openers
```

A file target — Terminal opens the containing folder, Finder reveals and
selects the file:

```openers
file: /Users/roman/spaces/loomp-tools/obsidian/openers/manifest.json
```

Custom label + per-block buttons: extend with a string-shorthand command
button, a named map-form one, disable a global:

```openers
dir: ~/dev/some-project
label: Some Project
buttons:
  zed: zed
  cursor:
    name: Cursor
    cmd: cursor
  finder: false
```

Inline flow form, `{path}` placement, and a deliberately missing path
(dashed chip; clicks explain):

```openers
dir: /definitely/not/here
buttons: { vi: { name: Vim, cmd: "nvim {path}" } }
```

Vault-relative path and JSON config form:

```openers
dir: README.md
```

```openers
{ "dir": "/tmp", "label": "Temp", "buttons": { "zed": "zed" } }
```
