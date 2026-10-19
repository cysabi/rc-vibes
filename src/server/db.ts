// vibes' own records: the lights' positions, rails, orientations and tags set
// in vibes, plus an activity log. arclamp sees every vibes action as the
// single "vibes" token.

import { DatabaseSync } from "node:sqlite";
import type { RailShape } from "../shared/rails.ts";
import type { ActivityAction, ActivityEntry, Person, Spot } from "../shared/vibes.ts";

interface ActivityRow {
  id: number;
  ts: string;
  user_id: string;
  user_name: string;
  action: ActivityAction;
  shader_id: number | null;
  shader_name: string | null;
  detail: string | null;
}

export interface LogInput {
  user: Person;
  action: ActivityAction;
  shaderId?: number;
  shaderName?: string | null;
  detail?: Record<string, unknown>;
}

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- Light positions set in vibes, until exported into arclamp's lights.json.
    -- A light is on a rail when rail_id is set, otherwise at mm_x, mm_y on
    -- floor; all of them null means "taken off the plan".
    CREATE TABLE IF NOT EXISTS placements (
      light_id INTEGER PRIMARY KEY,
      mm_x REAL,
      mm_y REAL,
      floor INTEGER,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at TEXT NOT NULL
    );
    -- Rails drawn or moved in vibes. floor null means "taken away".
    CREATE TABLE IF NOT EXISTS rails (
      id TEXT PRIMARY KEY,
      floor INTEGER,
      from_x REAL,
      from_y REAL,
      to_x REAL,
      to_y REAL,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at TEXT NOT NULL
    );
    -- Orientations set in vibes: a light's arclamp type, e.g. "4x1-horizontal".
    CREATE TABLE IF NOT EXISTS light_types (
      light_id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at TEXT NOT NULL
    );
    -- Tags set in vibes: a light's whole set, as a JSON array, in place of
    -- arclamp's until exported into its lights.json.
    CREATE TABLE IF NOT EXISTS light_tags (
      light_id INTEGER PRIMARY KEY,
      tags TEXT NOT NULL,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at TEXT NOT NULL
    );
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
    -- Sketches: each is a git repo, <sketches dir>/<id>.git; its name lives here.
    CREATE TABLE IF NOT EXISTS sketches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    -- Boxes: one person's VS Code for one sketch, with their own clone of it
    -- on their own branch. pod is the box it was last claimed in (whether
    -- that's still running is the box runner's to say).
    CREATE TABLE IF NOT EXISTS boxes (
      id TEXT PRIMARY KEY,
      sketch_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      at INTEGER NOT NULL,
      UNIQUE (sketch_id, user_id)
    );
  `);

  const placementColumns = db.prepare("PRAGMA table_info(placements)").all() as { name: string }[];
  if (!placementColumns.some((c) => c.name === "rail_id")) {
    db.exec("ALTER TABLE placements ADD COLUMN rail_id TEXT; ALTER TABLE placements ADD COLUMN mm_along REAL");
  }
  const boxColumns = db.prepare("PRAGMA table_info(boxes)").all() as { name: string }[];
  if (!boxColumns.some((c) => c.name === "pod")) db.exec("ALTER TABLE boxes ADD COLUMN pod TEXT");

  const selectPlacements = db.prepare("SELECT light_id, mm_x, mm_y, floor, rail_id, mm_along FROM placements");
  const upsertPlacement = db.prepare(`
    INSERT INTO placements (light_id, mm_x, mm_y, floor, rail_id, mm_along, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (light_id) DO UPDATE SET
      mm_x = excluded.mm_x, mm_y = excluded.mm_y, floor = excluded.floor,
      rail_id = excluded.rail_id, mm_along = excluded.mm_along,
      by_id = excluded.by_id, by_name = excluded.by_name, at = excluded.at
  `);
  // In the order they were first drawn: an upsert keeps a row's rowid.
  const selectRails = db.prepare("SELECT * FROM rails ORDER BY rowid");
  const upsertRail = db.prepare(`
    INSERT INTO rails (id, floor, from_x, from_y, to_x, to_y, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      floor = excluded.floor, from_x = excluded.from_x, from_y = excluded.from_y, to_x = excluded.to_x, to_y = excluded.to_y,
      by_id = excluded.by_id, by_name = excluded.by_name, at = excluded.at
  `);
  const selectTypes = db.prepare("SELECT light_id, type FROM light_types");
  const upsertType = db.prepare(`
    INSERT INTO light_types (light_id, type, by_id, by_name, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (light_id) DO UPDATE SET type = excluded.type, by_id = excluded.by_id, by_name = excluded.by_name, at = excluded.at
  `);
  const selectTags = db.prepare("SELECT light_id, tags FROM light_tags");
  const upsertTags = db.prepare(`
    INSERT INTO light_tags (light_id, tags, by_id, by_name, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (light_id) DO UPDATE SET tags = excluded.tags, by_id = excluded.by_id, by_name = excluded.by_name, at = excluded.at
  `);
  const insertActivity = db.prepare(`
    INSERT INTO activity (ts, user_id, user_name, action, shader_id, shader_name, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectActivity = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?");
  const lastActivity = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 1");
  const updateActivity = db.prepare("UPDATE activity SET ts = ?, detail = ? WHERE id = ?");
  const selectSketches = db.prepare("SELECT * FROM sketches ORDER BY at DESC");
  const selectSketch = db.prepare("SELECT * FROM sketches WHERE id = ?");
  const insertSketch = db.prepare("INSERT INTO sketches (id, name, by_id, by_name, at) VALUES (?, ?, ?, ?, ?)");
  const selectBox = db.prepare("SELECT * FROM boxes WHERE id = ?");
  const selectBoxFor = db.prepare("SELECT * FROM boxes WHERE sketch_id = ? AND user_id = ?");
  const insertBox = db.prepare("INSERT INTO boxes (id, sketch_id, user_id, user_name, branch, at) VALUES (?, ?, ?, ?, ?, ?)");
  const selectBranch = db.prepare("SELECT 1 FROM boxes WHERE sketch_id = ? AND branch = ?");
  const updateBoxPod = db.prepare("UPDATE boxes SET pod = ? WHERE id = ?");
  const selectBoxPods = db.prepare("SELECT id, pod FROM boxes WHERE pod IS NOT NULL");

  // Nests: an inner transaction just joins the outer one.
  let depth = 0;
  function transaction(fn: () => void) {
    if (depth++ === 0) db.exec("BEGIN");
    try {
      fn();
      if (depth === 1) db.exec("COMMIT");
    } catch (err) {
      if (depth === 1) db.exec("ROLLBACK");
      throw err;
    } finally {
      depth--;
    }
  }

  return {
    /** Positions set in vibes, by light id. Null means deliberately unplaced. */
    placements(): Map<number, Spot | null> {
      const rows = selectPlacements.all() as {
        light_id: number;
        mm_x: number | null;
        mm_y: number | null;
        floor: number | null;
        rail_id: string | null;
        mm_along: number | null;
      }[];
      return new Map(
        rows.map((r): [number, Spot | null] => [
          r.light_id,
          r.rail_id !== null && r.mm_along !== null
            ? { rail: { id: r.rail_id, mm_along: r.mm_along } }
            : r.mm_x === null || r.mm_y === null || r.floor === null
              ? null
              : { coords: { mm_x: r.mm_x, mm_y: r.mm_y, floor: r.floor } },
        ]),
      );
    },

    setPlacements(list: { id: number; spot: Spot | null }[], by: Person) {
      const at = new Date().toISOString();
      transaction(() => {
        for (const { id, spot } of list) {
          const coords = spot && "coords" in spot ? spot.coords : null;
          const rail = spot && "rail" in spot ? spot.rail : null;
          upsertPlacement.run(id, coords?.mm_x ?? null, coords?.mm_y ?? null, coords?.floor ?? null, rail?.id ?? null, rail?.mm_along ?? null, by.id, by.name, at);
        }
      });
    },

    /** Rails drawn or moved in vibes, by id, oldest first. Null means taken away. */
    rails(): Map<string, RailShape | null> {
      const rows = selectRails.all() as {
        id: string;
        floor: number | null;
        from_x: number;
        from_y: number;
        to_x: number;
        to_y: number;
      }[];
      return new Map(
        rows.map((r): [string, RailShape | null] => [
          r.id,
          r.floor === null ? null : { floor: r.floor, from: { mm_x: r.from_x, mm_y: r.from_y }, to: { mm_x: r.to_x, mm_y: r.to_y } },
        ]),
      );
    },

    /** Change rails, and move lights in the same go (e.g. off a rail being taken away). */
    setRails(list: { id: string; rail: RailShape | null }[], moved: { id: number; spot: Spot | null }[], by: Person) {
      const at = new Date().toISOString();
      transaction(() => {
        this.setPlacements(moved, by);
        for (const { id, rail } of list) {
          upsertRail.run(id, rail?.floor ?? null, rail?.from.mm_x ?? null, rail?.from.mm_y ?? null, rail?.to.mm_x ?? null, rail?.to.mm_y ?? null, by.id, by.name, at);
        }
      });
    },

    /** Light types (orientations) set in vibes, by light id. */
    types(): Map<number, string> {
      const rows = selectTypes.all() as { light_id: number; type: string }[];
      return new Map(rows.map((r) => [r.light_id, r.type]));
    },

    setTypes(list: { id: number; type: string }[], by: Person) {
      const at = new Date().toISOString();
      transaction(() => {
        for (const { id, type } of list) upsertType.run(id, type, by.id, by.name, at);
      });
    },

    /** Tags set in vibes, by light id: each light's whole set. */
    tags(): Map<number, string[]> {
      const rows = selectTags.all() as { light_id: number; tags: string }[];
      return new Map(rows.map((r) => [r.light_id, JSON.parse(r.tags) as string[]]));
    },

    setTags(list: { id: number; tags: string[] }[], by: Person) {
      const at = new Date().toISOString();
      transaction(() => {
        for (const { id, tags } of list) upsertTags.run(id, JSON.stringify(tags), by.id, by.name, at);
      });
    },

    log(entry: LogInput) {
      insertActivity.run(
        new Date().toISOString(),
        entry.user.id,
        entry.user.name,
        entry.action,
        entry.shaderId ?? null,
        entry.shaderName ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      );
    },

    /**
     * Log an entry, or fold it into the previous one when the same person did
     * the same thing moments ago (dragging a color picker sends a stream of
     * room tone changes; the history should show one).
     */
    logCoalesced(entry: LogInput, windowMs: number) {
      const last = lastActivity.get() as ActivityRow | undefined;
      const now = new Date();
      if (
        last &&
        last.user_id === entry.user.id &&
        last.action === entry.action &&
        now.getTime() - new Date(last.ts).getTime() < windowMs
      ) {
        updateActivity.run(now.toISOString(), entry.detail ? JSON.stringify(entry.detail) : null, last.id);
        return;
      }
      this.log(entry);
    },

    activity(limit: number): ActivityEntry[] {
      return (selectActivity.all(limit) as unknown as ActivityRow[]).map((r) => ({
        id: r.id,
        ts: r.ts,
        user: { id: r.user_id, name: r.user_name },
        action: r.action,
        shaderId: r.shader_id,
        shaderName: r.shader_name,
        detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
      }));
    },

    /** Every sketch, newest first. */
    sketches: () => selectSketches.all() as unknown as SketchRow[],

    sketch: (id: string) => selectSketch.get(id) as SketchRow | undefined,

    addSketch(s: SketchRow) {
      insertSketch.run(s.id, s.name, s.by_id, s.by_name, s.at);
    },

    box: (id: string) => selectBox.get(id) as BoxRow | undefined,

    /** Someone's box for a sketch, if they've opened it before. */
    boxFor: (sketchId: string, userId: string) => selectBoxFor.get(sketchId, userId) as BoxRow | undefined,

    addBox(b: Omit<BoxRow, "pod">) {
      insertBox.run(b.id, b.sketch_id, b.user_id, b.user_name, b.branch, b.at);
    },

    /** Whether someone's box for a sketch already works on this branch. */
    sketchBranchTaken: (sketchId: string, branch: string) => selectBranch.get(sketchId, branch) !== undefined,

    setBoxPod(id: string, pod: string | null) {
      updateBoxPod.run(pod, id);
    },

    /** The boxes claimed for someone, and whose. */
    boxPods: () => selectBoxPods.all() as { id: string; pod: string }[],

    close: () => db.close(),
  };
}

export interface SketchRow {
  id: string;
  name: string;
  by_id: string;
  by_name: string;
  /** When it was made, in ms. */
  at: number;
}

export interface BoxRow {
  id: string;
  sketch_id: string;
  user_id: string;
  user_name: string;
  /** Their branch in the sketch's repo. */
  branch: string;
  /** When it was first opened, in ms. */
  at: number;
  /** The box it was last claimed in, unless it's been let go since. */
  pod: string | null;
}

export type Db = ReturnType<typeof openDb>;
