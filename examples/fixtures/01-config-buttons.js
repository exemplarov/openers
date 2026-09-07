const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "obsidian")
    return { Plugin: class {}, MarkdownRenderChild: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, setIcon: () => {} };
  if (request === "electron") return {};
  return origLoad.apply(this, [request, ...args]);
};
const src =
  fs.readFileSync(path.join(__dirname, "..", "..", "main.js"), "utf8") +
  "\nmodule.exports = { parseBlockConfig, parseScalar, parseValue, mergeButtons, resolveWidgetPath, splitCommandTokens, buildCommand, normalizeSettingsButton, terminalCommand, DEFAULT_BUTTONS, capitalize };";
const m = { exports: {} };
new Function("module", "exports", "require", src)(m, m.exports, (r) => Module._load(r));
const O = m.exports;

let failed = 0;
function ok(name, cond, detail) {
  if (!cond) {
    failed++;
    console.log("FAIL:", name, detail ?? "");
  } else console.log("ok:", name);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re ? re.test(e.message) : true;
  }
};

// --- parser: nested maps (the extension over the siblings' flat parser) ----

const nested = `dir: /tmp/x
label: My Dir
buttons:
  zed: zed
  cursor:
    name: Cursor
    cmd: cursor
  notes: false
  keep: true`;
let cfg = O.parseBlockConfig(nested);
ok("parse: top-level scalars", cfg.dir === "/tmp/x" && cfg.label === "My Dir");
ok(
  "parse: nested buttons map (string / map / bool / true)",
  eq(cfg.buttons, { zed: "zed", cursor: { name: "Cursor", cmd: "cursor" }, notes: false, keep: true })
);

cfg = O.parseBlockConfig("buttons: { zed: zed, notes: false }");
ok("parse: inline flow map", eq(cfg.buttons, { zed: "zed", notes: false }));

cfg = O.parseBlockConfig('{ "dir": "/tmp", "buttons": { "zed": "zed" } }');
ok("parse: JSON object config", cfg.dir === "/tmp" && cfg.buttons.zed === "zed");

cfg = O.parseBlockConfig(`dirs:
  - vaults/loomp-os
  - spaces/loomp-tools
data:
  - date: 2026-09-07
    platform: mac
    count: 3
cmd: |
  zed
    --wait`);
ok("parse: plain string list", eq(cfg.dirs, ["vaults/loomp-os", "spaces/loomp-tools"]));
ok("parse: mapping list items with continuations", cfg.data.length === 1 && eq(cfg.data[0], { date: "2026-09-07", platform: "mac", count: 3 }));
ok("parse: block scalar dedented", cfg.cmd === "zed\n  --wait");
ok("parse: scalar typing", O.parseBlockConfig("a: true\nb: 42\nc: 'x'").a === true && O.parseBlockConfig("a: true\nb: 42").b === 42);

ok("parse: key without value errors", throws(() => O.parseBlockConfig("buttons:"), /needs an indented value/));
ok("parse: bad indentation errors", throws(() => O.parseBlockConfig("a: 1\n    b: 2"), /unexpected indentation/));
ok("parse: non-item at list indent errors", throws(() => O.parseBlockConfig("dirs:\n  - a\n  b: 2"), /expected a list item/));
ok("parse: unterminated flow quote errors", throws(() => O.parseBlockConfig("a: [x, 'y]"), /unterminated quote/));
ok("parse: invalid JSON errors", throws(() => O.parseBlockConfig("{ nope"), /invalid JSON config/));

// --- merge semantics ---------------------------------------------------------

const GLOBALS = [
  { id: "finder", kind: "finder", name: "Finder", icon: "folder", enabled: true },
  { id: "terminal", kind: "terminal", name: "Terminal", icon: "terminal", app: "", enabled: true },
  { id: "zed", kind: "cmd", name: "Zed", cmd: "zed", icon: "code", enabled: true },
  { id: "notes", kind: "cmd", name: "Notes", cmd: "obsidian-notes", enabled: true },
  { id: "off", kind: "cmd", name: "Off", cmd: "x", enabled: false },
];

let merged = O.mergeButtons(GLOBALS, null);
ok("merge: no spec = enabled globals in order", eq(merged.buttons.map((b) => b.id), ["finder", "terminal", "zed", "notes"]) && merged.errors.length === 0);

merged = O.mergeButtons(GLOBALS, { cursor: "cursor" });
ok(
  "merge: string form appends with capitalized name",
  merged.buttons.length === 5 &&
    merged.buttons[4].id === "cursor" &&
    merged.buttons[4].name === "Cursor" &&
    merged.buttons[4].cmd === "cursor" &&
    merged.buttons[4].kind === "cmd"
);

merged = O.mergeButtons(GLOBALS, { cursor: { name: "Cursor IDE", cmd: "cursor", icon: "code" } });
ok("merge: map form with fields", merged.buttons[4].name === "Cursor IDE" && merged.buttons[4].icon === "code");

merged = O.mergeButtons(GLOBALS, { notes: false });
ok("merge: false removes the global", !merged.buttons.some((b) => b.id === "notes"));

merged = O.mergeButtons(GLOBALS, { zed: { name: "Zed!" } });
ok("merge: map override keeps position, name, cmd", merged.buttons[2].id === "zed" && merged.buttons[2].name === "Zed!" && merged.buttons[2].cmd === "zed" && merged.buttons[2].icon === "code");

merged = O.mergeButtons(GLOBALS, { zed: "zed-nightly" });
ok("merge: string override replaces cmd in place", merged.buttons[2].cmd === "zed-nightly" && merged.buttons[2].name === "Zed");

merged = O.mergeButtons(GLOBALS, { zed: true, terminal: { name: "iTerm", kind: "terminal", app: "iTerm" } });
ok("merge: true no-op; kind preserved on override", merged.buttons.some((b) => b.id === "zed") && merged.buttons[1].app === "iTerm" && merged.buttons[1].name === "iTerm");

merged = O.mergeButtons(GLOBALS, { finder: { name: "Reveal" } });
ok("merge: finder rename keeps kind", merged.buttons[0].kind === "finder" && merged.buttons[0].name === "Reveal");

merged = O.mergeButtons(GLOBALS, { vi: { kind: "teleport" } });
ok("merge: unknown kind errors", merged.errors.some((e) => /buttons\.vi: unknown kind/.test(e)));

merged = O.mergeButtons(GLOBALS, { vi: {} });
ok("merge: cmd without cmd errors", merged.errors.some((e) => /buttons\.vi: command buttons need a cmd/.test(e)));

merged = O.mergeButtons(GLOBALS, { vi: 3 });
ok("merge: bad spec type errors", merged.errors.some((e) => /buttons\.vi: expected/.test(e)));

merged = O.mergeButtons(GLOBALS, "zed");
ok("merge: non-map buttons errors", merged.errors.some((e) => /buttons: must be a map/.test(e)));

merged = O.mergeButtons(GLOBALS, { off: true });
ok("merge: true cannot resurrect a disabled global", !merged.buttons.some((b) => b.id === "off"));

// --- settings normalization --------------------------------------------------

let nb = O.normalizeSettingsButton({ id: "zed", kind: "cmd", cmd: "zed" });
ok("normalize: defaults filled", nb.name === "Zed" && nb.enabled === true && nb.icon === "" && nb.app === "");
ok("normalize: rejects whitespace/colon ids", O.normalizeSettingsButton({ id: "a b" }) === null && O.normalizeSettingsButton({ id: "a:b" }) === null && O.normalizeSettingsButton(null) === null);
ok("normalize: unknown kind falls back to cmd", O.normalizeSettingsButton({ id: "x", kind: "wat" }).kind === "cmd");
ok("normalize: default buttons ship finder+terminal", O.DEFAULT_BUTTONS.length === 2 && O.DEFAULT_BUTTONS[0].id === "finder" && O.DEFAULT_BUTTONS[1].id === "terminal");

// --- path resolution -----------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openers-fx-"));
const tmpFile = path.join(tmp, "note.md");
fs.writeFileSync(tmpFile, "x");
const ctx = { home: "/Users/tester", vaultRoot: "/vault" };

ok("resolve: absolute passes through", O.resolveWidgetPath({ dir: "/a/b" }, ctx).target.path === "/a/b");
ok("resolve: ~ expands", O.resolveWidgetPath({ dir: "~/dev/x" }, ctx).target.path === "/Users/tester/dev/x");
ok("resolve: relative joins vault root", O.resolveWidgetPath({ dir: "projects/a" }, ctx).target.path === "/vault/projects/a");
ok("resolve: file:// url decodes", O.resolveWidgetPath({ dir: "file:///Users/tester/a%20b/c" }, ctx).target.path === "/Users/tester/a b/c");
ok("resolve: dir+file both = error", O.resolveWidgetPath({ dir: "/a", file: "/b" }, ctx).errors.length === 1);
ok("resolve: neither = error", O.resolveWidgetPath({}, ctx).errors.some((e) => /missing required option/.test(e)));
ok("resolve: real dir detected", (() => { const r = O.resolveWidgetPath({ dir: tmp }, ctx).target; return r.exists === true && r.isDir === true; })());
ok("resolve: real file detected", (() => { const r = O.resolveWidgetPath({ file: tmpFile }, ctx).target; return r.exists === true && r.isDir === false; })());
ok("resolve: missing marked", O.resolveWidgetPath({ dir: path.join(tmp, "nope") }, ctx).target.exists === false);
fs.rmSync(tmp, { recursive: true, force: true });

// --- command tokenizer & buildCommand -------------------------------------------

ok("tokens: simple", eq(O.splitCommandTokens("zed"), ["zed"]));
ok("tokens: args split", eq(O.splitCommandTokens("code -r"), ["code", "-r"]));
ok("tokens: quotes group", eq(O.splitCommandTokens('"My App" --flag x'), ["My App", "--flag", "x"]));
ok("tokens: unterminated errors", throws(() => O.splitCommandTokens('a "b'), /unterminated quote/));

const binOf = (cmd, target) => {
  const { bin, args } = O.buildCommand({ id: "t", cmd }, target);
  return { bin, args };
};
let r = binOf("zed", "/p");
ok("build: path appended by default", eq(r.args, ["/p"]) && (r.bin === "zed" || r.bin.endsWith("/zed")));
r = binOf("code -r", "/p");
ok("build: extra args preserved", eq(r.args, ["-r", "/p"]));
r = binOf("nvim {path}", "/p");
ok("build: {path} substituted, not appended", eq(r.args, ["/p"]));
r = binOf("ls {dir}", "/a/b/c");
ok("build: {dir} substitutes dirname; {path} still appended", eq(r.args, ["/a/b", "/a/b/c"]));
ok("build: empty cmd throws", throws(() => O.buildCommand({ id: "t", cmd: "" }, "/p"), /has no command/));

// --- terminal command (darwin path of the table) --------------------------------

const tc = O.terminalCommand({ app: "" }, "/some/dir");
ok("terminal: darwin default app", tc.bin === "/usr/bin/open" && eq(tc.args, ["-a", "Terminal", "/some/dir"]));
const tc2 = O.terminalCommand({ app: "iTerm" }, "/some/dir");
ok("terminal: darwin custom app", eq(tc2.args, ["-a", "iTerm", "/some/dir"]));

console.log(failed ? `\n${failed} FAILURES` : "\nall green");
process.exit(failed ? 1 : 0);
