// vibes' slow writes, on a thread of their own (db-worker.ts): the history,
// in a database beside vibes' own, and the checkpoints of vibes' own. The
// main thread hands them over and goes on. If the thread stops, it's started
// again; whatever's handed over meanwhile waits for it, and whatever the one
// that stopped hadn't kept yet is lost (it says so).

import { Worker } from "node:worker_threads";
import type { DbWorkerData, DbWorkerMessage } from "./db-worker.ts";
import type { ActivityRow, HistoryStore } from "./history.ts";

// vibes' own database's write-ahead log is put into it this often.
const CHECKPOINT_MS = 2000;
const RESTART_MS = 1000;
// At most this long for the thread to keep what it's been handed, when vibes stops.
const CLOSE_MS = 5000;

/** Where the history's kept, beside vibes' own database: vibes.db's is vibes-history.db. */
export const historyPathOf = (main: string) => main.replace(/(\.db)?$/, "-history.db");

/** The history, kept on its own thread; and vibes' own database (at `main`), checkpointed there. */
export function backgroundStore(main: string, checkpointMs = CHECKPOINT_MS): HistoryStore {
  const data: DbWorkerData = { history: historyPathOf(main), main, checkpointMs };
  const answers = new Map<number, { resolve: (rows: ActivityRow[]) => void; reject: (err: Error) => void }>();
  let asked = 0;
  let closing = false;
  // Handed over while there's no thread running: given to the next.
  let queued: DbWorkerMessage[] | null = null;
  let worker = start();

  function start(): Worker {
    const w = new Worker(new URL("./db-worker.ts", import.meta.url), { workerData: data });
    // It never keeps vibes running by itself.
    w.unref();
    w.on("message", (m: { id: number; rows?: ActivityRow[]; error?: string }) => {
      const a = answers.get(m.id);
      answers.delete(m.id);
      if (m.error !== undefined) a?.reject(new Error(m.error));
      else a?.resolve(m.rows ?? []);
    });
    w.on("error", (err) => console.error("the database thread failed:", err));
    w.on("exit", () => {
      for (const a of answers.values()) a.reject(new Error("the database thread stopped"));
      answers.clear();
      if (closing) return;
      console.error("the database thread stopped: what it hadn't kept is lost; starting it again");
      queued = [];
      setTimeout(() => {
        if (closing) return;
        worker = start();
        for (const m of queued ?? []) worker.postMessage(m);
        queued = null;
      }, RESTART_MS).unref();
    });
    return w;
  }

  const post = (m: DbWorkerMessage) => (queued ? queued.push(m) : worker.postMessage(m));

  return {
    add: (r) => post({ op: "add", row: [r.ts, r.user_id, r.user_name, r.action, r.shader_id, r.shader_name, r.detail] }),
    touch: (ts, detail) => post({ op: "touch", ts, detail }),
    recent: (limit) =>
      new Promise((resolve, reject) => {
        const id = ++asked;
        answers.set(id, { resolve, reject });
        post({ op: "recent", id, limit });
      }),
    async close() {
      if (closing) return;
      closing = true;
      if (queued) return;
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      worker.postMessage({ op: "close" } satisfies DbWorkerMessage);
      const late = setTimeout(() => void worker.terminate(), CLOSE_MS);
      await exited;
      clearTimeout(late);
    },
  };
}
