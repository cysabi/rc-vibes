// The thread vibes' slow writes are made on (started by db-background.ts):
// the history, in a database of its own; and the checkpoints of vibes' own
// database, whose main thread only appends to its write-ahead log and never
// waits for the disk (db.ts). However slow the disk is, nothing waits for
// this but the history page.
//
// Only Node's own modules here: it's loaded as it is, by Node, in a thread
// of its own.

import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

export interface DbWorkerData {
  /** The history's database. */
  history: string;
  /** vibes' own: its history moved over from it once, and checkpointed every `checkpointMs`. */
  main: string;
  checkpointMs: number;
}

export type DbWorkerMessage =
  | { op: "add"; row: [ts: string, userId: string, userName: string, action: string, shaderId: number | null, shaderName: string | null, detail: string | null] }
  | { op: "touch"; ts: string; detail: string | null }
  | { op: "recent"; id: number; limit: number }
  | { op: "close" };

const { history, main, checkpointMs } = workerData as DbWorkerData;
const port = parentPort!;

const db = new DatabaseSync(history);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    shader_id INTEGER,
    shader_name TEXT,
    detail TEXT
  );
`);

// The history as vibes kept it before it had a database of its own, moved here once.
if ((db.prepare("SELECT count(*) AS n FROM activity").get() as { n: number }).n === 0) {
  db.prepare("ATTACH DATABASE ? AS old").run(main);
  try {
    if (db.prepare("SELECT 1 FROM old.sqlite_master WHERE type = 'table' AND name = 'activity'").get()) {
      db.exec("INSERT INTO activity SELECT id, ts, user_id, user_name, action, shader_id, shader_name, detail FROM old.activity ORDER BY id");
    }
  } finally {
    db.exec("DETACH DATABASE old");
  }
}

const insert = db.prepare("INSERT INTO activity (ts, user_id, user_name, action, shader_id, shader_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)");
const update = db.prepare("UPDATE activity SET ts = ?, detail = ? WHERE id = ?");
const select = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?");
let newest = Number((db.prepare("SELECT max(id) AS id FROM activity").get() as { id: number | null }).id ?? 0);

// vibes' own database: what its main thread's written to its log, put into it now and then (never waiting on anyone).
const own = new DatabaseSync(main);
const checkpoint = () => {
  try {
    own.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  } catch (err) {
    console.error("couldn't checkpoint vibes' database:", err);
  }
};
const checkpoints = setInterval(checkpoint, checkpointMs);

port.on("message", (m: DbWorkerMessage) => {
  switch (m.op) {
    case "add":
      try {
        newest = Number(insert.run(...m.row).lastInsertRowid);
      } catch (err) {
        console.error("couldn't keep a history entry:", err);
      }
      break;
    case "touch":
      try {
        if (newest > 0) update.run(m.ts, m.detail, newest);
      } catch (err) {
        console.error("couldn't keep a history entry:", err);
      }
      break;
    case "recent":
      try {
        port.postMessage({ id: m.id, rows: select.all(m.limit) });
      } catch (err) {
        port.postMessage({ id: m.id, error: String(err) });
      }
      break;
    case "close":
      clearInterval(checkpoints);
      checkpoint();
      own.close();
      db.close();
      port.close();
      break;
  }
});
