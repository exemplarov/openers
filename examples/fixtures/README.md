# Node harness (no framework — sibling convention)

Run with `node <script>` from anywhere; scripts load `../../main.js` with a
stubbed `obsidian` module (and `electron`) and assert the pure-function
layers: parser, merge semantics, settings normalization, path resolution,
command tokenizer, terminal command table.

| script | covers |
| ------ | ------ |
| `01-config-buttons.js` | block parser (nested maps, flow forms, errors), global/block merge, `resolveWidgetPath`, `splitCommandTokens`/`buildCommand`, `terminalCommand` (darwin), settings normalization |

Exit code 0 = all green.
