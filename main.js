const { Plugin, MarkdownRenderChild, PluginSettingTab, Setting, Notice, setIcon } = require("obsidian");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Openers — one code block, one line of buttons that open a directory or
// file elsewhere on the machine: file manager, terminal, or any CLI
// (`zed <dir>`, `cursor <dir>`). Global settings define the default line;
// blocks extend, override or disable it. See spec/001-architecture.md.
//
// Phase status: 2 (1.0.0) — parser with nested maps, path resolution,
// global/block merge, finder/terminal/cmd actions, settings tab, public API.
// ---------------------------------------------------------------------------

const BLOCK_LANGUAGE = "openers";
const API_VERSION = 1;
const BUTTON_KINDS = new Set(["finder", "terminal", "cmd"]);
const DEFAULT_BUTTONS = [
  { id: "finder", kind: "finder", name: "Finder", icon: "folder", enabled: true },
  { id: "terminal", kind: "terminal", name: "Terminal", icon: "terminal", app: "", enabled: true },
];
const DEFAULT_SETTINGS = { schemaVersion: 1, buttons: [] };

// Linux terminal candidates for the `terminal` kind (darwin uses `open -a`,
// win32 is best-effort). First probe hit wins; flags per terminal.
const LINUX_TERMINALS = [
  ["x-terminal-emulator", (dir) => [dir]],
  ["gnome-terminal", (dir) => ["--working-directory", dir]],
  ["konsole", (dir) => ["--workdir", dir]],
  ["xfce4-terminal", (dir) => ["--working-directory", dir]],
  ["wezterm", (dir) => ["start", "--cwd", dir]],
  ["kitty", (dir) => ["--directory", dir]],
  ["alacritty", (dir) => ["--working-directory", dir]],
  ["terminator", (dir) => [`--working-directory=${dir}`]],
];

const capitalize = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

// ---------------------------------------------------------------------------
// Block config parsing (spec §4.2). Simple form: `key: value` lines with
// nested maps (`buttons:` → `id: …`), `- item` lists (mapping items with
// continuation lines), `key: |` block scalars, inline flow lists (`[a, b]`)
// and flow maps (`{x: 1}`). Or one JSON object. Recursive by indentation.
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  let s = String(raw).trim();
  if (s === "" || s === "~" || s === "null") return null;
  const unquote = (t) =>
    t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : null;
  const quoted = unquote(s);
  if (quoted !== null) return quoted;
  const hash = s.search(/\s+#/); // trailing comment (bare values only — quoted handled above)
  const body = hash === -1 ? s : s.slice(0, hash).trim();
  const quotedBody = unquote(body);
  if (quotedBody !== null) return quotedBody;
  if (body === "true") return true;
  if (body === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(body)) return Number(body);
  return body;
}

function splitFlowList(inner) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error(`unterminated quote in inline list: "${inner.slice(0, 40)}"`);
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function parseFlowMap(text) {
  const inner = text.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  const out = {};
  if (!inner) return out;
  for (const part of splitFlowList(inner)) { // quote-aware: commas inside "…" don't split
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(part.trim());
    if (!kv) throw new Error(`cannot parse inline object: "${part.trim().slice(0, 60)}"`);
    out[kv[1]] = parseScalar(kv[2]);
  }
  return out;
}

function parseValue(raw) {
  const s = String(raw).trim();
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`unbalanced inline list: "${s.slice(0, 40)}"`);
    const inner = s.slice(1, -1).trim();
    return inner ? splitFlowList(inner).map((part) => parseScalar(part)) : [];
  }
  if (s.startsWith("{")) {
    if (!s.endsWith("}")) throw new Error(`unbalanced inline object: "${s.slice(0, 40)}"`);
    try {
      return JSON.parse(s);
    } catch {
      return parseFlowMap(s); // relaxed { zed: zed, notes: false } maps
    }
  }
  return parseScalar(s);
}

function dedentBlock(lines) {
  const meaningful = lines.filter((l) => l.trim());
  if (!meaningful.length) return "";
  const min = Math.min(...meaningful.map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(min)).join("\n").replace(/\s+$/, "");
}

function parseBlockConfig(source) {
  const text = String(source || "").replace(/\r/g, "");
  if (!text.trim()) return {};
  const firstMeaningful = text.split("\n").find((l) => l.trim());
  if (firstMeaningful.trim().startsWith("{")) {
    try {
      return JSON.parse(text.trim());
    } catch (error) {
      throw new Error(`invalid JSON config: ${error.message}`);
    }
  }

  const lines = text.split("\n").map((l) => l.replace(/\t/g, "  "));
  let pos = 0;
  const peek = () => {
    while (pos < lines.length) {
      const trimmed = lines[pos].trim();
      if (trimmed && !trimmed.startsWith("#")) return lines[pos];
      pos++;
    }
    return null;
  };
  const indentOf = (line) => line.length - line.trimStart().length;

  // Map at exactly `indent` (keys aligned); nested values recurse via parseNested.
  function parseMap(indent) {
    const out = {};
    for (;;) {
      const line = peek();
      if (!line || indentOf(line) < indent) break;
      if (indentOf(line) > indent) throw new Error(`unexpected indentation: "${line.trim().slice(0, 50)}"`);
      const trimmed = line.trim();
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
      if (!kv) throw new Error(`cannot parse config line: "${trimmed.slice(0, 60)}"`);
      pos++;
      if (kv[2] === "") out[kv[1]] = parseNested(kv[1], indent);
      else if (kv[2] === "|" || kv[2] === "|-") out[kv[1]] = parseBlockScalar(indent);
      else out[kv[1]] = parseValue(kv[2]);
    }
    return out;
  }

  // Empty value under `key:` — lookahead decides list vs map (spec §4.3).
  function parseNested(key, parentIndent) {
    const line = peek();
    if (!line || indentOf(line) <= parentIndent) {
      throw new Error(`"${key}:" needs an indented value (list or map) or an inline one`);
    }
    const childIndent = indentOf(line);
    return /^-(\s|$)/.test(line.trim()) ? parseList(childIndent) : parseMap(childIndent);
  }

  function parseList(indent) {
    const out = [];
    for (;;) {
      const line = peek();
      if (!line || indentOf(line) < indent) break;
      if (indentOf(line) > indent) throw new Error(`unexpected indentation in list: "${line.trim().slice(0, 50)}"`);
      const trimmed = line.trim();
      if (!/^-(\s|$)/.test(trimmed)) throw new Error(`expected a list item, got: "${trimmed.slice(0, 50)}"`);
      pos++;
      const rest = trimmed.replace(/^-\s+/, "");
      if (rest === "") {
        out.push(null);
        continue;
      }
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
      if (!kv) {
        out.push(parseValue(rest));
        continue;
      }
      const obj = {};
      const contentIndent = indent + (trimmed.length - rest.length); // column of the first key
      if (kv[2] === "") obj[kv[1]] = parseNested(kv[1], contentIndent);
      else if (kv[2] === "|" || kv[2] === "|-") obj[kv[1]] = parseBlockScalar(contentIndent);
      else obj[kv[1]] = parseValue(kv[2]);
      Object.assign(obj, parseMap(contentIndent)); // aligned continuation keys of this item
      out.push(obj);
    }
    return out;
  }

  function parseBlockScalar(parentIndent) {
    const blockLines = [];
    for (;;) {
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (!line.trim()) {
        blockLines.push(line);
        pos++;
        continue;
      }
      if (indentOf(line) <= parentIndent) break;
      blockLines.push(line);
      pos++;
    }
    return dedentBlock(blockLines);
  }

  return parseMap(0);
}

// ---------------------------------------------------------------------------
// Target path resolution (spec §4.2). `dir:` or `file:` (exactly one),
// `~` expansion, `file://` URL decode, vault-relative fallback, existence.
// ---------------------------------------------------------------------------

function resolveWidgetPath(config, ctx) {
  const errors = [];
  const dir = config.dir;
  const file = config.file;
  if (dir != null && file != null) errors.push("give either dir: or file:, not both");
  const raw = dir != null ? dir : file;
  if (raw == null || String(raw).trim() === "") {
    if (!errors.length) errors.push("missing required option: dir (or file)");
    return { errors };
  }
  let p = String(raw).trim();
  if (p.startsWith("file://")) {
    p = decodeURIComponent(p.replace(/^file:\/\//, ""));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // file:///C:/… → C:/…
  }
  if (p === "") {
    errors.push("empty path");
    return { errors };
  }
  if (p === "~") p = ctx.home || "~";
  else if (p.startsWith("~/")) p = path.join(ctx.home || "", p.slice(2));
  else if (!path.isAbsolute(p)) p = path.join(ctx.vaultRoot || "", p);
  p = path.normalize(p);
  let exists = true;
  let isDir = false;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    exists = false;
  }
  return { errors, target: { path: p, exists, isDir } };
}

// ---------------------------------------------------------------------------
// Button model (spec §4.3, §6). Settings rows are normalized at load; block
// specs merge over the enabled globals (in-place overrides, appended extras).
// ---------------------------------------------------------------------------

function normalizeSettingsButton(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id || id.includes(":") || /\s/.test(id)) return null;
  const kind = BUTTON_KINDS.has(raw.kind) ? raw.kind : "cmd";
  return {
    id,
    kind,
    name: raw.name != null && String(raw.name).trim() !== "" ? String(raw.name).trim() : capitalize(id),
    cmd: raw.cmd != null ? String(raw.cmd) : "",
    app: raw.app != null ? String(raw.app) : "",
    icon: raw.icon != null ? String(raw.icon).trim() : "",
    enabled: raw.enabled !== false,
  };
}

function mergeButtons(settingsButtons, spec) {
  const errors = [];
  const list = [];
  for (const raw of settingsButtons || []) {
    const button = normalizeSettingsButton(raw);
    if (button && button.enabled !== false) list.push(button);
  }
  if (spec != null && (typeof spec !== "object" || Array.isArray(spec))) {
    errors.push("buttons: must be a map (id: cmd | {name, cmd} | false)");
    return { buttons: list, errors };
  }
  const entries = spec ? Object.entries(spec) : [];
  for (const [id, value] of entries) {
    const existingIndex = list.findIndex((b) => b.id === id);
    const base = existingIndex !== -1 ? list[existingIndex] : { kind: "cmd", name: capitalize(id) };
    let def = null;
    if (value === false) {
      if (existingIndex !== -1) list.splice(existingIndex, 1);
      continue;
    }
    if (value === true || value == null) continue; // no-op
    if (typeof value === "string") {
      def = Object.assign({}, base, { id, kind: "cmd", cmd: value });
    } else if (typeof value === "object") {
      const kind = value.kind != null ? String(value.kind) : base.kind;
      if (!BUTTON_KINDS.has(kind)) {
        errors.push(`buttons.${id}: unknown kind "${kind}" (expected finder, terminal or cmd)`);
        continue;
      }
      def = Object.assign({}, base, value, { id, kind });
    } else {
      errors.push(`buttons.${id}: expected a command string, {name, cmd} object, or false`);
      continue;
    }
    if (def.kind === "cmd" && !String(def.cmd || "").trim()) {
      errors.push(`buttons.${id}: command buttons need a cmd`);
      continue;
    }
    def.enabled = def.enabled !== false;
    if (existingIndex !== -1) list[existingIndex] = def;
    else if (def.enabled !== false) list.push(def);
  }
  return { buttons: list, errors };
}

// ---------------------------------------------------------------------------
// Actions (spec §5). No shell anywhere — argv arrays only, so spaces in
// paths are safe and nothing from the note is ever interpreted.
// ---------------------------------------------------------------------------

// GUI apps (Obsidian) inherit launchd's minimal PATH — Homebrew and
// ~/.local/bin binaries are invisible there even when a shell finds them.
function probeBinary(bin) {
  if (!bin || bin.includes("/") || bin.includes("\\")) return null;
  const dirs = [];
  const home = os.homedir();
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  if (home) dirs.push(path.join(home, ".local/bin"), path.join(home, "bin"));
  for (const d of String(process.env.PATH || "").split(path.delimiter)) if (d) dirs.push(d);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not present — keep probing
    }
  }
  return null;
}

function resolveBinary(bin) {
  return probeBinary(bin) || bin;
}

function splitCommandTokens(text) {
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  const push = () => {
    if (started) {
      out.push(cur);
      cur = "";
      started = false;
    }
  };
  for (const ch of String(text ?? "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    cur += ch;
    started = true;
  }
  push();
  if (quote) throw new Error(`unterminated quote in command: "${String(text).slice(0, 40)}"`);
  return out;
}

function buildCommand(button, targetPath) {
  const tokens = splitCommandTokens(String(button.cmd || ""));
  if (!tokens.length) throw new Error(`button "${button.id}" has no command`);
  const dir = path.dirname(targetPath);
  let usedPath = false;
  const argv = tokens.map((token) => {
    let t = token.split("{path}").join(targetPath);
    if (t !== token) usedPath = true;
    return t.split("{dir}").join(dir);
  });
  if (!usedPath) argv.push(targetPath); // default: `zed` means `zed <path>`
  const [bin, ...args] = argv;
  return { bin: resolveBinary(bin), args };
}

function terminalCommand(button, dir) {
  if (process.platform === "darwin") {
    const app = String(button.app || "").trim() || "Terminal";
    return { bin: "/usr/bin/open", args: ["-a", app, dir] };
  }
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return { bin: comspec, args: ["/c", "start", "", "/D", dir, "cmd.exe"] };
  }
  for (const [name, mkArgs] of LINUX_TERMINALS) {
    const bin = probeBinary(name);
    if (bin) return { bin, args: mkArgs(dir) };
  }
  throw new Error(`no terminal found — tried: ${LINUX_TERMINALS.map(([n]) => n).join(", ")}`);
}

function spawnDetached(bin, args, label) {
  const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (error) => {
    let detail = error.message;
    if (error.code === "ENOENT") {
      detail = `"${bin}" not found — install it or set an absolute path in the button config (GUI apps inherit a minimal PATH)`;
    }
    new Notice(`openers: ${label}: ${detail}`, 8000);
  });
  child.unref();
  return child;
}

function electronShell() {
  try {
    return require("electron").shell || null;
  } catch {
    return null;
  }
}

async function openInFileManager(target) {
  const shell = electronShell();
  if (shell && typeof shell.openPath === "function") {
    if (target.isDir) return (await shell.openPath(target.path)) || "";
    if (typeof shell.showItemInFolder === "function") {
      shell.showItemInFolder(target.path);
      return "";
    }
    return (await shell.openPath(target.path)) || "";
  }
  if (process.platform === "darwin") {
    spawnDetached("/usr/bin/open", [target.path], "Finder");
    return "";
  }
  return "electron shell unavailable";
}

async function runButtonAction(button, target) {
  const label = button.name || button.id;
  if (!target.exists) {
    new Notice(`openers: ${label}: path does not exist — ${target.path}`, 7000);
    return;
  }
  try {
    if (button.kind === "finder") {
      const error = await openInFileManager(target);
      if (error) new Notice(`openers: ${label}: ${error}`, 7000);
      return;
    }
    if (button.kind === "terminal") {
      const dir = target.isDir ? target.path : path.dirname(target.path); // terminals open dirs
      const { bin, args } = terminalCommand(button, dir);
      spawnDetached(bin, args, label);
      return;
    }
    const { bin, args } = buildCommand(button, target.path);
    spawnDetached(bin, args, label);
  } catch (error) {
    new Notice(`openers: ${label}: ${error.message}`, 8000);
  }
}

function describeButton(button, target) {
  try {
    if (button.kind === "finder") return target.isDir ? `open ${target.path}` : `reveal ${target.path}`;
    if (button.kind === "terminal") {
      const dir = target.isDir ? target.path : path.dirname(target.path);
      if (process.platform === "darwin") return `open -a ${String(button.app || "").trim() || "Terminal"} ${dir}`;
      return `terminal: ${dir}`;
    }
    const { bin, args } = buildCommand(button, target.path);
    return [bin, ...args].map((a) => (/[\s]/.test(a) ? `"${a}"` : a)).join(" ");
  } catch {
    return button.kind;
  }
}

// ---------------------------------------------------------------------------
// Widget (spec §7) — one line: path chip + buttons.
// ---------------------------------------------------------------------------

class OpenersWidget extends MarkdownRenderChild {
  constructor(containerEl, source, plugin, sourcePath) {
    super(containerEl);
    this.source = source;
    this.plugin = plugin;
    this.sourcePath = sourcePath || "";
    this.errors = [];
    this.buttons = [];
    this.target = null;
    this.label = "";
  }

  onload() {
    let config = {};
    try {
      config = parseBlockConfig(this.source);
    } catch (error) {
      this.errors = [error.message];
    }
    if (!this.errors.length) {
      const resolved = resolveWidgetPath(config, this.plugin.pathContext());
      if (resolved.errors.length) this.errors.push(...resolved.errors);
      else {
        this.target = resolved.target;
        const explicit = config.label != null ? String(config.label).trim() : "";
        this.label = explicit || path.basename(this.target.path) || this.target.path;
        const merged = mergeButtons(this.plugin.settings.buttons, config.buttons);
        if (merged.errors.length) this.errors.push(...merged.errors);
        else this.buttons = merged.buttons;
      }
    }
    this.render();
  }

  render() {
    const root = this.containerEl;
    root.empty();
    if (this.errors.length) {
      const card = root.createDiv({ cls: "openers-error" });
      card.createDiv({ cls: "openers-error-title" }, (el) => {
        el.textContent = "openers: invalid block";
      });
      for (const line of this.errors) {
        card.createDiv({ cls: "openers-error-line" }, (el) => {
          el.textContent = line;
        });
      }
      return;
    }

    const line = root.createDiv({ cls: "openers" });
    const chip = line.createSpan({ cls: `openers-path${this.target.exists ? "" : " is-missing"}` }, (el) => {
      el.textContent = this.label;
      el.title = this.target.path + (this.target.exists ? "" : "\n(path does not exist)");
    });
    if (this.target.exists) this.renderIcon(chip, this.target.isDir ? "folder" : "file");

    for (const button of this.buttons) {
      const btn = line.createSpan({ cls: "openers-btn", attr: { role: "button", tabindex: "0" } });
      this.renderIcon(btn, button.icon);
      btn.createSpan({ cls: "openers-btn-label" }, (el) => {
        el.textContent = button.name || button.id;
      });
      btn.title = describeButton(button, this.target);
      const activate = (event) => {
        event.preventDefault();
        this.plugin.runButton(button, this.target);
      };
      btn.addEventListener("click", activate);
      btn.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      });
    }
  }

  renderIcon(parent, name) {
    if (!name) return;
    const holder = parent.createSpan({ cls: "openers-icon" });
    try {
      setIcon(holder, String(name));
    } catch {
      holder.remove(); // unknown lucide name — text-only button
    }
  }
}

// ---------------------------------------------------------------------------
// Settings (spec §6) — sibling card pattern: live-mutated rows, saved
// per keystroke; widgets re-read on next render.
// ---------------------------------------------------------------------------

class OpenersSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Openers" });
    containerEl.createEl("p", {
      cls: "openers-settings-note",
      text: "Global buttons are the default line for every openers block. Blocks can override entries (name, cmd, icon), add new ones, or disable a global with `id: false`.",
    });

    containerEl.createEl("h4", { text: "Buttons" });
    for (const button of this.plugin.settings.buttons) this.renderButtonCard(containerEl, button);

    new Setting(containerEl)
      .setName("Add command button")
      .setDesc("Runs `<command> <path>` — e.g. zed, cursor, code. Use {path} to place the path explicitly.")
      .addButton((button) =>
        button.setButtonText("Add").onClick(async () => {
          this.plugin.settings.buttons.push(
            normalizeSettingsButton({ id: this.suggestId("app"), kind: "cmd", name: "App", cmd: "" })
          );
          await this.plugin.saveSettings();
          this.display();
        })
      );

    containerEl.createEl("p", {
      cls: "openers-settings-note",
      text: "Buttons run local executables from your notes — the same local-trust model as SQL blocks in viz.",
    });
  }

  suggestId(base) {
    const taken = new Set(this.plugin.settings.buttons.map((b) => b.id));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const id = `${base}-${n}`;
      if (!taken.has(id)) return id;
    }
  }

  renderButtonCard(containerEl, button) {
    const card = containerEl.createDiv({ cls: "openers-card" });
    const header = card.createDiv({ cls: "openers-card-header" });
    header.createSpan({ cls: "openers-card-kind" }, (el) => {
      el.textContent = button.kind === "finder" ? "Finder" : button.kind === "terminal" ? "Terminal" : "Command";
    });
    header.createSpan({ cls: "openers-card-id" }, (el) => {
      el.textContent = button.id;
      el.title = "id — reference it in a block's buttons: to override or disable";
    });

    let nameInput = null;
    const nameSetting = new Setting(header).setClass("openers-card-name");
    nameSetting.addText((text) => {
      nameInput = text;
      text.setPlaceholder("name").setValue(button.name);
      text.onChange(async (value) => {
        const name = value.trim();
        if (!name) {
          new Notice("openers: button name must be non-empty");
          nameInput.setValue(button.name);
          return;
        }
        button.name = name;
        await this.plugin.saveSettings();
      });
    });
    new Setting(header)
      .setClass("openers-card-toggle")
      .addToggle((toggle) =>
        toggle.setValue(button.enabled !== false).onChange(async (value) => {
          button.enabled = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(header)
      .setClass("openers-card-delete")
      .addButton((button2) =>
        button2.setButtonText("Delete").onClick(async () => {
          const list = this.plugin.settings.buttons;
          list.splice(list.indexOf(button), 1);
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (button.kind === "cmd") {
      new Setting(card)
        .setName("Command")
        .setClass("openers-card-field")
        .setDesc("Executable + optional args; the target path is appended (or substituted for {path})")
        .addText((text) => {
          text.setPlaceholder("zed").setValue(button.cmd);
          text.onChange(async (value) => {
            button.cmd = value.trim();
            await this.plugin.saveSettings();
          });
        });
    }
    if (button.kind === "terminal") {
      new Setting(card)
        .setName("Terminal app (macOS)")
        .setClass("openers-card-field")
        .setDesc("App name passed to `open -a`; empty = Terminal (e.g. iTerm, WezTerm, Warp). Linux autodetects; Windows is best-effort.")
        .addText((text) => {
          text.setPlaceholder("Terminal").setValue(button.app || "");
          text.onChange(async (value) => {
            button.app = value.trim();
            await this.plugin.saveSettings();
          });
        });
    }
    new Setting(card)
      .setName("Icon")
      .setClass("openers-card-field")
      .setDesc("Lucide icon name (folder, terminal, code, …); empty = text only")
      .addText((text) => {
        text.setPlaceholder("folder").setValue(button.icon || "");
        text.onChange(async (value) => {
          button.icon = value.trim();
          await this.plugin.saveSettings();
        });
      });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class OpenersPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.buttons)) this.settings.buttons = [];
    if (!("buttons" in saved)) {
      this.settings.buttons = DEFAULT_BUTTONS.map((b) => Object.assign({}, b)); // fresh install seed
    } else {
      const normalized = [];
      for (const raw of this.settings.buttons) {
        const button = normalizeSettingsButton(raw);
        if (button) normalized.push(button);
        else console.warn("openers: dropping invalid settings button", raw);
      }
      this.settings.buttons = normalized;
    }

    this.addSettingTab(new OpenersSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) => {
      ctx.addChild(new OpenersWidget(el, source, this, ctx.sourcePath || ""));
    });

    // Public API, version 1 (spec §9).
    globalThis.openers = {
      version: API_VERSION,
      buttons: () =>
        mergeButtons(this.settings.buttons, null).buttons.map((b) => ({
          id: b.id,
          kind: b.kind,
          name: b.name,
          cmd: b.cmd || null,
          enabled: b.enabled !== false,
        })),
      open: (rawPath, id) => this.openWith(rawPath, id),
      render: (el, source) => {
        const widget = new OpenersWidget(el, String(source), this, "api");
        widget.load();
        return { unload: () => widget.unload() };
      },
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  pathContext() {
    let vaultRoot = "";
    try {
      vaultRoot = this.app.vault.adapter.basePath || "";
    } catch {
      // non-filesystem adapter — relative paths resolve against "" (cwd)
    }
    return { home: os.homedir(), vaultRoot };
  }

  enabledButtons() {
    return mergeButtons(this.settings.buttons, null).buttons;
  }

  runButton(button, target) {
    runButtonAction(button, target);
  }

  openWith(rawPath, id) {
    const buttons = this.enabledButtons();
    const button = buttons.find((b) => b.id === id) || null;
    if (!button) {
      const available = buttons.map((b) => b.id).join(", ") || "none configured";
      new Notice(`openers: unknown button "${id}" — available: ${available}`, 6000);
      return;
    }
    const resolved = resolveWidgetPath({ dir: rawPath }, this.pathContext());
    if (resolved.errors.length) {
      new Notice(`openers: ${resolved.errors.join("; ")}`, 6000);
      return;
    }
    runButtonAction(button, resolved.target);
  }

  onunload() {
    if (globalThis.openers && globalThis.openers.version === API_VERSION) delete globalThis.openers;
  }
}

module.exports = OpenersPlugin;
