import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Person } from "../shared/vibes.ts";
import { backgroundStore, historyPathOf } from "./db-background.ts";
import { openDb } from "./db.ts";
import { createHistory, memoryStore } from "./history.ts";

const ada: Person = { id: "rc:1", name: "Ada" };
const bob: Person = { id: "rc:2", name: "Bob" };
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the history", () => {
  it("is newest first, a run of one change folded into one entry, as its newest says", async () => {
    const h = createHistory(memoryStore());
    h.log({ user: ada, action: "shader.mute", shaderId: 3, shaderName: "Wave" });
    const param = (user: Person, param: string, lights: number) => h.logCoalesced({ user, action: "shader.param", detail: { param, lights } }, 60_000, (last) => last?.param === param);
    param(ada, "speed", 1);
    param(ada, "speed", 2);
    // Another param, then someone else: each their own.
    param(ada, "bands", 3);
    param(bob, "bands", 4);
    expect((await h.activity(10)).map((a) => [a.user.name, a.action, a.detail])).toEqual([
      ["Bob", "shader.param", { param: "bands", lights: 4 }],
      ["Ada", "shader.param", { param: "bands", lights: 3 }],
      ["Ada", "shader.param", { param: "speed", lights: 2 }],
      ["Ada", "shader.mute", null],
    ]);
    expect(await h.activity(1)).toHaveLength(1);
  });

  it("starts a new entry once a run's been quiet its while", async () => {
    const h = createHistory(memoryStore());
    h.logCoalesced({ user: ada, action: "roomtone.set", detail: { lights: 1 } }, 20);
    await settle(30);
    h.logCoalesced({ user: ada, action: "roomtone.set", detail: { lights: 2 } }, 20);
    expect(await h.activity(10)).toHaveLength(2);
  });
});

describe("the history on its own thread", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibes-history-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is kept beside vibes' database, in one of its own", () => {
    expect(historyPathOf("/data/vibes.db")).toBe("/data/vibes-history.db");
    expect(historyPathOf("/data/vibes")).toBe("/data/vibes-history.db");
  });

  it("keeps what it's handed, in order, and reads it back; kept when vibes starts again", async () => {
    const path = join(dir, "vibes.db");
    const db = openDb(path, { background: true });
    db.log({ user: ada, action: "shader.mute", shaderId: 3 });
    db.logCoalesced({ user: ada, action: "roomtone.set", detail: { lights: 1 } }, 60_000);
    db.logCoalesced({ user: ada, action: "roomtone.set", detail: { lights: 5 } }, 60_000);
    expect((await db.activity(10)).map((a) => [a.action, a.detail])).toEqual([
      ["roomtone.set", { lights: 5 }],
      ["shader.mute", null],
    ]);
    await db.close();
    expect(existsSync(join(dir, "vibes-history.db"))).toBe(true);
    // Not in vibes' own database.
    expect(new DatabaseSync(path).prepare("SELECT count(*) AS n FROM activity").get()).toEqual({ n: 0 });
    const again = openDb(path, { background: true });
    expect(await again.activity(10)).toHaveLength(2);
    await again.close();
  });

  it("moves the history vibes kept before it had a database of its own, once", async () => {
    const path = join(dir, "vibes.db");
    // As vibes kept it.
    openDb(path).close();
    const old = new DatabaseSync(path);
    old.prepare("INSERT INTO activity (ts, user_id, user_name, action, shader_id, shader_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?)").run("2026-10-01T00:00:00.000Z", "rc:1", "Ada", "shader.create", 7, "Wave", null);
    old.close();
    const db = openDb(path, { background: true });
    db.log({ user: bob, action: "shader.mute", shaderId: 7 });
    expect((await db.activity(10)).map((a) => [a.id, a.user.name, a.action])).toEqual([
      [2, "Bob", "shader.mute"],
      [1, "Ada", "shader.create"],
    ]);
    await db.close();
    // Once: it's had it.
    const again = openDb(path, { background: true });
    expect(await again.activity(10)).toHaveLength(2);
    await again.close();
  });

  it("puts what vibes' database writes to its log into it, so the main thread never has to", async () => {
    const path = join(dir, "vibes.db");
    const main = new DatabaseSync(path);
    main.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (n INTEGER)");
    const store = backgroundStore(path, 20);
    for (let i = 0; i < 50; i++) main.prepare("INSERT INTO t VALUES (?)").run(i);
    await settle(200);
    // The database file alone, without its log: what's been put into it.
    copyFileSync(path, join(dir, "copy.db"));
    expect(new DatabaseSync(join(dir, "copy.db")).prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 50 });
    await store.close();
    main.close();
  });
});
