// vibes inside a sketch's VS Code, in the sketch's box. A "Sketch" panel along
// the bottom holds the preview (the sketch running on the plan: src/web/preview,
// in a webview) and its console beside it. The dev loop (dev.ts) keeps the
// preview up to date as you type: by Vite's HMR, or by swapping in each new
// build, on the same clock either way. Build errors go to Problems and the
// console, and the preview keeps running what last worked. Play, pause and
// restart sit in the panel's title bar, and the clock in the status bar.
//
// The lights' layout comes from vibes (VIBES_URL), asked with the box's own
// token (VIBES_BOX_TOKEN), so the webview never needs vibes' cookies. So do
// the preview's params: a pool of its own on vibes (one each time this
// starts), followed here as a shader in the room follows its own (the same
// stream: src/server/params.ts), with each knob turned in the preview sent on.
//
// Opened at <BOX_COMMITS_FOLDER>/<commit>/sketch (vibes' page does that for a
// sketch at one commit), it first makes that folder: a checkout of just that
// commit, beside the clone, which it's left alone.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { Changes, ParamSpec, ParamTable, ParamValue } from "../../../src/shared/params.ts";
import { BOX_COMMITS_FOLDER, type Lights } from "../../../src/shared/vibes.ts";
import type { FromPreview, LogLine, SketchSource, ToPreview } from "../../../src/web/preview/protocol.ts";
import { DevLoop } from "./dev.ts";

const MAX_LINES = 500;
// Lights move now and then; the layout is asked for again this often.
const LAYOUT_EVERY_MS = 5 * 60_000;
const LAYOUT_RETRY_MS = 10_000;

/** A line in the console: what the sketch logged (with when, in the preview), or how a build went. */
type ConsoleLine = { kind: LogLine["level"] | "build"; at?: number; text: string };

/** Minutes, seconds and tenths: 1:04.2. */
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${((ms % 60_000) / 1000).toFixed(1).padStart(4, "0")}`;

export function activate(context: vscode.ExtensionContext) {
  // A sketch's commands (pnpm, its build) want `node` by name; the extension host is one.
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const commit = root && path.dirname(path.dirname(root)) === BOX_COMMITS_FOLDER ? path.basename(path.dirname(root)) : null;
  if (root && commit && !fs.existsSync(root)) {
    void checkOut(root, commit);
    return;
  }
  const problems = vscode.languages.createDiagnosticCollection("sketch");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "vibes.toggle";
  status.tooltip = "The sketch's preview: play or pause";
  const consoleView = new ConsoleView();
  const preview = new PreviewView(context.extensionUri, consoleView, status);
  const pool = new PoolLink((m) => preview.post(m), (text) => consoleView.add({ kind: "error", text }));
  preview.onDeclared = (specs) => pool.declare(specs);
  preview.onSet = (name, changes) => pool.set(name, changes);
  context.subscriptions.push({ dispose: () => pool.stop() });

  const retain = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    problems,
    status,
    vscode.window.registerWebviewViewProvider("vibes.preview", preview, retain),
    vscode.window.registerWebviewViewProvider("vibes.console", consoleView, retain),
    vscode.commands.registerCommand("vibes.play", () => preview.post({ type: "play" })),
    vscode.commands.registerCommand("vibes.pause", () => preview.post({ type: "pause" })),
    vscode.commands.registerCommand("vibes.toggle", () => preview.post({ type: "toggle" })),
    vscode.commands.registerCommand("vibes.restart", () => {
      consoleView.clear();
      preview.post({ type: "restart" });
    }),
    vscode.commands.registerCommand("vibes.clear", () => consoleView.clear()),
  );

  void keepLayout(preview, consoleView);
  if (root) {
    const dev = new DevLoop(root, {
      source: (source) => preview.setSource(source),
      hmr: (payload) => preview.post({ type: "hmr", payload }),
      line: (kind, text) => consoleView.add({ kind, text }),
      problems,
    });
    preview.onHmr = (payload) => dev.deliver(payload);
    dev.watch(context);
    dev.restart();
  }

  // Bring the panel up, then hand the keyboard back to the code.
  setTimeout(async () => {
    await vscode.commands.executeCommand("vibes.preview.focus");
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }, 300);
}

export function deactivate() {}

const git = promisify(execFile);

/**
 * Makes `folder` a checkout of `commit` (fetched first, since it may be newer
 * than the clone), then opens the window again on it. The clone is left as
 * it is.
 */
async function checkOut(folder: string, commit: string) {
  const clone = process.env.VIBES_FOLDER;
  if (!clone) {
    void vscode.window.showErrorMessage("This box doesn't know where its clone is (VIBES_FOLDER).");
    return;
  }
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking out ${commit.slice(0, 7)}…` }, async () => {
      await git("git", ["-C", clone, "fetch", "--quiet", "origin"]);
      await git("git", ["-C", clone, "worktree", "add", "--detach", folder, commit]);
    });
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    void vscode.window.showErrorMessage(`Couldn't check out ${commit.slice(0, 7)}: ${stderr || (err as Error).message}`);
  }
}

/** The lights' layout from vibes, again every so often (and soon, after a failure). */
async function keepLayout(preview: PreviewView, consoleView: ConsoleView) {
  const url = process.env.VIBES_URL;
  const token = process.env.VIBES_BOX_TOKEN;
  if (!url || !token) {
    consoleView.add({ kind: "error", text: "This box doesn't know where vibes is (VIBES_URL, VIBES_BOX_TOKEN), so there's no plan to preview on." });
    return;
  }
  let failed = false;
  for (;;) {
    try {
      const res = await fetch(new URL("/box-api/layout", url), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`vibes answered ${res.status}`);
      preview.setLayout((await res.json()) as Lights);
      failed = false;
      await sleep(LAYOUT_EVERY_MS);
    } catch (err) {
      if (!failed) consoleView.add({ kind: "error", text: `Couldn't get the plan from vibes: ${(err as Error).message}. Trying again.` });
      failed = true;
      await sleep(LAYOUT_RETRY_MS);
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The pool's stream: opened again after a break (1 s, doubling to 30 s).
const POOL_FIRST_WAIT_MS = 1000;
const POOL_MOST_WAIT_MS = 30_000;

/**
 * The preview's params on vibes: a pool of its own, made (and a token for it
 * had) once the sketch says what it declares, then followed: vibes' values
 * (all of them, then each change, as the stream sends them) handed to the
 * preview, and opened again with each change to what it declares. Knobs
 * turned in the preview go to vibes as they're turned.
 */
class PoolLink {
  /** The pool: this run of the extension's own. */
  readonly id = randomUUID();
  private declared: ParamSpec[] | null = null;
  private stream: AbortController | null = null;
  private wait = POOL_FIRST_WAIT_MS;
  private stopped = false;
  private failing = false;
  private readonly url = process.env.VIBES_URL;
  private readonly token = process.env.VIBES_BOX_TOKEN;

  private readonly tell: (m: Extract<ToPreview, { type: "pool" }>) => void;
  private readonly warn: (text: string) => void;

  constructor(tell: (m: Extract<ToPreview, { type: "pool" }>) => void, warn: (text: string) => void) {
    this.tell = tell;
    this.warn = warn;
  }

  declare(specs: ParamSpec[]) {
    if (JSON.stringify(specs) === JSON.stringify(this.declared)) return;
    this.declared = specs;
    this.wait = POOL_FIRST_WAIT_MS;
    void this.follow();
  }

  /** A knob turned in the preview, to vibes. */
  set(name: string, changes: [number, ParamValue | null][]) {
    if (!this.url || !this.token || this.declared === null) return;
    void fetch(new URL(`/box-api/pools/${this.id}/values`, this.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, changes }),
    }).catch(() => {
      // vibes is away: the preview has it anyway, and the stream's state, when it's back, says what vibes kept.
    });
  }

  stop() {
    this.stopped = true;
    this.stream?.abort();
  }

  /** The pool's stream, from scratch: a token (making the pool, the first time), then what's declared, then every value and each change. */
  private async follow() {
    if (!this.url || !this.token || this.stopped) return;
    this.stream?.abort();
    const ctl = new AbortController();
    this.stream = ctl;
    try {
      const made = await fetch(new URL("/box-api/pools", this.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pool: this.id }),
        signal: ctl.signal,
      });
      if (!made.ok) throw new Error(`vibes answered ${made.status}`);
      const { token } = (await made.json()) as { token: string };
      const res = await fetch(new URL("/shader-api/params", this.url), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ v: 1, params: this.declared }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`vibes answered ${res.status}`);
      this.failing = false;
      this.wait = POOL_FIRST_WAIT_MS;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
          this.take(text.slice(0, at));
          text = text.slice(at + 2);
        }
      }
    } catch (err) {
      if (ctl.signal.aborted) return;
      if (!this.failing) this.warn(`Couldn't follow the preview's params on vibes: ${(err as Error).message}. Trying again.`);
      this.failing = true;
    }
    if (this.stream !== ctl || this.stopped) return;
    // Broken, or ended: again, after a while.
    await sleep(this.wait);
    this.wait = Math.min(POOL_MOST_WAIT_MS, this.wait * 2);
    if (this.stream === ctl) void this.follow();
  }

  /** One event from the stream, to the preview. */
  private take(block: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const d = JSON.parse(data.join("\n")) as { values?: ParamTable; name?: string; set?: Changes };
    if (event === "state" && d.values) this.tell({ type: "pool", event: "state", values: d.values });
    else if (event === "change" && d.name && d.set) this.tell({ type: "pool", event: "change", name: d.name, set: d.set });
  }
}

/** The preview: src/web/preview's bundle in a webview, fed the layout and the sketch. */
class PreviewView implements vscode.WebviewViewProvider {
  private readonly media: vscode.Uri;
  private readonly console: ConsoleView;
  private readonly status: vscode.StatusBarItem;
  private view: vscode.WebviewView | null = null;
  private layout: Lights | null = null;
  private playing: boolean | null = null;
  private source: SketchSource | null = null;
  /** What the preview's module runner sends the box's Vite. */
  onHmr: ((payload: unknown) => void) | null = null;
  /** What the sketch declares, as the preview says; and each knob turned there. */
  onDeclared: ((specs: ParamSpec[]) => void) | null = null;
  onSet: ((name: string, changes: [number, ParamValue | null][]) => void) | null = null;

  constructor(extensionUri: vscode.Uri, consoleView: ConsoleView, status: vscode.StatusBarItem) {
    this.media = vscode.Uri.joinPath(extensionUri, "media", "preview");
    this.console = consoleView;
    this.status = status;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const { webview } = view;
    webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.media, "preview.js"));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.media, "preview.css"));
    const src = webview.cspSource;
    // The sketch runs in a worker made from a blob, through eval, as arclamp runs it.
    webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; font-src ${src} data:; style-src ${src} 'unsafe-inline'; script-src ${src} 'unsafe-eval' blob:; worker-src blob:; connect-src ${src};">
<link rel="stylesheet" href="${css}">
</head>
<body><div id="root"></div><script type="module" src="${js}"></script></body>
</html>`;
    webview.onDidReceiveMessage((m: FromPreview) => this.receive(m));
    view.onDidDispose(() => {
      this.view = null;
      this.status.hide();
    });
  }

  private receive(m: FromPreview) {
    if (m.type === "ready") {
      if (this.layout) this.post({ type: "layout", layout: this.layout });
      if (this.source) this.post({ type: "source", source: this.source });
    } else if (m.type === "hmr") {
      this.onHmr?.(m.payload);
    } else if (m.type === "declared") {
      this.onDeclared?.(m.specs);
    } else if (m.type === "set") {
      this.onSet?.(m.name, m.changes);
    } else if (m.type === "log") {
      this.console.add({ kind: m.line.level, at: m.line.at, text: m.line.text });
    } else {
      if (m.playing !== this.playing) {
        this.playing = m.playing;
        void vscode.commands.executeCommand("setContext", "vibes.playing", m.playing);
      }
      const note = m.stopped ? " · stopped" : m.playing ? "" : " · paused";
      this.status.text = `${m.playing ? "$(debug-pause)" : "$(play)"} ${clock(m.ms)}${note}`;
      this.status.show();
    }
  }

  setLayout(layout: Lights) {
    // Unchanged, it's left alone, so the preview isn't started over.
    if (this.layout && JSON.stringify(this.layout) === JSON.stringify(layout)) return;
    this.layout = layout;
    this.post({ type: "layout", layout });
  }

  setSource(source: SketchSource) {
    this.source = source;
    this.post({ type: "source", source });
  }

  post(m: ToPreview) {
    void this.view?.webview.postMessage(m);
  }
}

/** What the sketch logs, and how its builds went, beside the preview. */
class ConsoleView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private lines: ConsoleLine[] = [];

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = consoleHtml();
    view.webview.onDidReceiveMessage((m: { type: string }) => {
      if (m.type === "ready") void view.webview.postMessage({ type: "lines", lines: this.lines });
    });
    view.onDidDispose(() => (this.view = null));
  }

  add(line: ConsoleLine) {
    // Tools color what they print for a terminal; this isn't one.
    const plain = { ...line, text: line.text.replace(/\x1b\[[0-9;]*m/g, "") };
    this.lines = [...this.lines.slice(-(MAX_LINES - 1)), plain];
    void this.view?.webview.postMessage({ type: "line", line: plain });
  }

  clear() {
    this.lines = [];
    void this.view?.webview.postMessage({ type: "clear" });
  }
}

function consoleHtml() {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { padding: 6px 14px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  ol { list-style: none; margin: 0; padding: 0; }
  li { white-space: pre-wrap; line-height: 1.6; }
  .at { margin-right: 12px; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .build, .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<ol id="log"><li class="empty">console.log shows up here.</li></ol>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById("log");
  const clock = ${clock.toString()};
  function add(line) {
    log.querySelector(".empty")?.remove();
    const li = document.createElement("li");
    li.className = line.kind;
    if (line.at !== undefined) {
      const at = document.createElement("span");
      at.className = "at";
      at.textContent = clock(line.at);
      li.append(at);
    }
    li.append(line.text);
    log.append(li);
    while (log.children.length > ${MAX_LINES}) log.firstChild.remove();
    // The newest line, all of it in sight.
    li.scrollIntoView({ block: "end" });
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "lines") { log.textContent = ""; m.lines.forEach(add); }
    else if (m.type === "line") add(m.line);
    else if (m.type === "clear") log.textContent = "";
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
