// The preview panel outside VS Code, for working on it, and on a sketch,
// without a box or arclamp: the same panel (main.tsx), fed what the
// extension would feed it by vite.config.ts instead. The room is the real
// one if dev/lights.json has been saved (/dev/layout; dev/room.ts), and the
// sketch is dev/sketch/main.ts, built as the builder builds it
// (/dev/sketch.js), again whenever it's saved: the panel swaps each build in
// on the same clock.
//
//   pnpm dev:web, then http://localhost:5173/preview/

import type { Lights } from "../../shared/vibes.ts";
import type { FromPreview, ToPreview } from "./protocol.ts";

// What VS Code's webview would give the panel: here, its messages go to the console.
(window as unknown as { acquireVsCodeApi: () => { postMessage(m: FromPreview): void } }).acquireVsCodeApi = () => ({
  postMessage(m) {
    if (m.type === "log") console[m.line.level === "log" ? "log" : m.line.level](`sketch: ${m.line.text}`);
  },
});
await import("./main.tsx");

const post = (m: ToPreview) => window.postMessage(m, "*");
post({ type: "layout", layout: (await (await fetch("/dev/layout")).json()) as Lights });

let last = "";
async function refresh() {
  const res = await fetch("/dev/sketch.js", { cache: "no-store" });
  const script = await res.text();
  if (!res.ok) {
    console.error(`the sketch didn't build: ${script}`);
    return;
  }
  if (script === last) return;
  last = script;
  post({ type: "source", source: { kind: "script", script } });
}
await refresh();
setInterval(() => void refresh(), 1000);
