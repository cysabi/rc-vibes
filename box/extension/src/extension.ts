// vibes inside a sketch's VS Code, in the sketch's box. A "Sketch" panel along
// the bottom holds the preview (the sketch running on the plan: src/web/preview,
// in a webview) and its console beside it. The extension builds the sketch
// from the box's files with esbuild (its wasm build, so it runs on any box) on
// start and on every save, and hands each build to the preview, which swaps
// it in on the same clock. Build errors go to Problems and the console, and
// the preview keeps running what last built. Play, pause and restart sit in
// the panel's title bar, and the clock in the status bar.
//
// The lights' layout comes from vibes (VIBES_URL), asked with the box's own
// token (VIBES_BOX_TOKEN), so the webview never needs vibes' cookies.

import * as esbuild from "esbuild-wasm";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { Lights } from "../../../src/shared/vibes.ts";
import type { FromPreview, LogLine, ToPreview } from "../../../src/web/preview/protocol.ts";

// What a sketch is built from: the first of these it has.
const ENTRIES = ["main.ts", "main.js", "src/main.ts", "src/index.ts", "index.ts", "index.js"];
// The build is a global script defining update(), as arclamp runs it.
const FOOTER = "function update(prev, nowMs, initialMs) { return __sketch.update(prev, nowMs, initialMs); }";
const MAX_LINES = 500;
// Lights move now and then; the layout is asked for again this often.
const LAYOUT_EVERY_MS = 5 * 60_000;
const LAYOUT_RETRY_MS = 10_000;

/** A line in the console: what the sketch logged (with when, in the preview), or how a build went. */
type ConsoleLine = { kind: LogLine["level"] | "build"; at?: number; text: string };

/** Minutes, seconds and tenths: 1:04.2. */
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${((ms % 60_000) / 1000).toFixed(1).padStart(4, "0")}`;

export function activate(context: vscode.ExtensionContext) {
  // esbuild-wasm runs its wasm under `node`, by name; a box needn't have one
  // on its PATH, but the extension host is one.
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const problems = vscode.languages.createDiagnosticCollection("sketch");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "vibes.toggle";
  status.tooltip = "The sketch's preview: play or pause";
  const consoleView = new ConsoleView();
  const preview = new PreviewView(context.extensionUri, consoleView, status);

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
  if (root) watchAndBuild(context, root, preview, consoleView, problems);

  // Bring the panel up, then hand the keyboard back to the code.
  setTimeout(async () => {
    await vscode.commands.executeCommand("vibes.preview.focus");
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }, 300);
}

export function deactivate() {}

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

function watchAndBuild(
  context: vscode.ExtensionContext,
  root: string,
  preview: PreviewView,
  consoleView: ConsoleView,
  problems: vscode.DiagnosticCollection,
) {
  const rebuild = async () => {
    const started = Date.now();
    const result = await build(root);
    problems.clear();
    if ("script" in result) {
      consoleView.add({ kind: "build", text: `Built ${result.entry} in ${Date.now() - started} ms` });
      preview.setScript(result.script);
      return;
    }
    const byFile = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
    for (const e of result.errors) {
      const at = e.location;
      consoleView.add({ kind: "error", text: `Couldn't build: ${at ? `${at.file}:${at.line}:${at.column + 1} ` : ""}${e.text}` });
      if (!at) continue;
      const uri = vscode.Uri.file(path.join(root, at.file));
      const range = new vscode.Range(at.line - 1, at.column, at.line - 1, at.column + Math.max(1, at.length));
      const list = byFile.get(uri.toString()) ?? { uri, items: [] };
      list.items.push(new vscode.Diagnostic(range, e.text, vscode.DiagnosticSeverity.Error));
      byFile.set(uri.toString(), list);
    }
    for (const { uri, items } of byFile.values()) problems.set(uri, items);
    if (preview.script !== null) consoleView.add({ kind: "build", text: "The preview keeps running what last built." });
  };
  // Saves come in bunches (and autosave is on): build once they settle.
  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 120);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.{ts,js,mjs,json}"));
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(later),
    watcher.onDidChange(later),
    watcher.onDidDelete(later),
    vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.fsPath.startsWith(root) && later()),
  );
  void rebuild();
}

type BuildError = { text: string; location: esbuild.Location | null };
type Built = { entry: string; script: string } | { entry: string | null; errors: BuildError[] };

/** The sketch bundled into one global script, or why it couldn't be. */
async function build(root: string): Promise<Built> {
  const entry = ENTRIES.find((e) => fs.existsSync(path.join(root, e)));
  if (!entry) return { entry: null, errors: [{ text: `nothing to build: none of ${ENTRIES.join(", ")}`, location: null }] };
  try {
    const out = await esbuild.build({
      entryPoints: [path.join(root, entry)],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__sketch",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      footer: { js: FOOTER },
    });
    return { entry, script: out.outputFiles[0]!.text };
  } catch (err) {
    const errors = (err as esbuild.BuildFailure).errors;
    return { entry, errors: errors?.length ? errors : [{ text: String((err as Error).message ?? err), location: null }] };
  }
}

/** The preview: src/web/preview's bundle in a webview, fed the layout and each build. */
class PreviewView implements vscode.WebviewViewProvider {
  private readonly media: vscode.Uri;
  private readonly console: ConsoleView;
  private readonly status: vscode.StatusBarItem;
  private view: vscode.WebviewView | null = null;
  private layout: Lights | null = null;
  private playing: boolean | null = null;
  script: string | null = null;

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
      if (this.script !== null) this.post({ type: "script", script: this.script });
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

  setScript(script: string) {
    this.script = script;
    this.post({ type: "script", script });
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
    this.lines = [...this.lines.slice(-(MAX_LINES - 1)), line];
    void this.view?.webview.postMessage({ type: "line", line });
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
    window.scrollTo(0, document.body.scrollHeight);
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
