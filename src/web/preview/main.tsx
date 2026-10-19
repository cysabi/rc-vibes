// The preview panel in a sketch's VS Code (box/extension): the sketch running
// on the plan, in a webview. The extension hands it the lights' layout and
// each build of the sketch; it runs them (runner.ts), swapping each new build
// in on the same clock, and sends back what's logged and whether it's
// playing, for the console beside it, the panel's buttons and the status bar.
//   pnpm build:box

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lights } from "../../shared/vibes.ts";
import { FramesProvider, type FrameSource } from "../live.ts";
import { PreviewMap } from "./PreviewMap.tsx";
import type { FromPreview, ToPreview } from "./protocol.ts";
import { SketchRunner } from "./runner.ts";
import "@fontsource-variable/recursive/full.css";
import "../styles.css";
import "./preview.css";

declare function acquireVsCodeApi(): { postMessage(message: FromPreview): void };
const vscode = acquireVsCodeApi();

const NO_FRAMES: FrameSource = { latest: () => null, subscribe: () => () => {} };
// The map's editing hooks want one; nothing here edits.
const queryClient = new QueryClient();

function Preview() {
  const [layout, setLayout] = useState<Lights | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [runner, setRunner] = useState<SketchRunner | null>(null);
  const current = useRef<SketchRunner | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToPreview>) => {
      const m = e.data;
      const r = current.current;
      if (m.type === "layout") setLayout(m.layout);
      else if (m.type === "script") setScript(m.script);
      else if (m.type === "restart") r?.restart();
      else if (m.type === "pause" || (m.type === "toggle" && r?.playing)) r?.pause();
      else if (r?.stopped) r.restart();
      else r?.play();
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The first build starts it; each one after swaps in on the same clock. A
  // new layout (lights moved) starts it afresh on that.
  useEffect(() => {
    if (!layout || script === null) return;
    const r = current.current;
    if (r && r.lights === layout.lights) {
      r.swap(script);
      return;
    }
    r?.dispose();
    const next = new SketchRunner(script, layout.lights);
    next.onLine = (line) => vscode.postMessage({ type: "log", line });
    current.current = next;
    setRunner(next);
  }, [layout, script]);

  // Whether it's playing, and its clock, for the panel's buttons and the status bar.
  useEffect(() => {
    if (!runner) return;
    const report = () => vscode.postMessage({ type: "state", playing: runner.playing, stopped: runner.stopped, ms: runner.elapsedMs() });
    report();
    const t = window.setInterval(report, 250);
    const unwatch = runner.watch(report);
    return () => {
      window.clearInterval(t);
      unwatch();
    };
  }, [runner]);

  return (
    <QueryClientProvider client={queryClient}>
      <FramesProvider value={runner ?? NO_FRAMES}>
        <PreviewMap layout={layout} />
      </FramesProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
