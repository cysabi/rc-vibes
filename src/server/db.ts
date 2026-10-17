// vibes' own records: who made each shader and what it's called, plus an
// activity log. arclamp sees every vibes action as the single "vibes" token.

import { DatabaseSync } from "node:sqlite";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { RailShape } from "../shared/rails.ts";
import type { ActivityAction, ActivityEntry, Person, ShaderMeta, Spot } from "../shared/vibes.ts";

/**
 * arclamp keeps its scene in memory and restarts ids from 1, so an id alone
 * could match a shader from before a restart. created_at disambiguates.
 */
export function shaderKey(d: Pick<ShaderDescriptor, "id" | "created_at">): string {
  return `${d.id}@${d.created_at ?? ""}`;
}

interface MetaRow {
  key: string;
  name: string;
  created_by_id: string;
  created_by_name: string;
  modified_by_id: string;
  modified_by_name: string;
  seen_error: string | null;
}

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
    CREATE TABLE IF NOT EXISTS shader_meta (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      modified_by_id TEXT NOT NULL,
      modified_by_name TEXT NOT NULL,
      seen_error TEXT
    );
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

  const metaColumns = db.prepare("PRAGMA table_info(shader_meta)").all() as { name: string }[];
  if (!metaColumns.some((c) => c.name === "seen_error")) {
    db.exec("ALTER TABLE shader_meta ADD COLUMN seen_error TEXT");
  }
  const placementColumns = db.prepare("PRAGMA table_info(placements)").all() as { name: string }[];
  if (!placementColumns.some((c) => c.name === "rail_id")) {
    db.exec("ALTER TABLE placements ADD COLUMN rail_id TEXT; ALTER TABLE placements ADD COLUMN mm_along REAL");
  }

  const selectMeta = db.prepare("SELECT * FROM shader_meta WHERE key = ?");
  const insertMeta = db.prepare(`
    INSERT INTO shader_meta (key, name, created_by_id, created_by_name, modified_by_id, modified_by_name)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET
      name = excluded.name,
      modified_by_id = excluded.modified_by_id,
      modified_by_name = excluded.modified_by_name
  `);
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
  const updateSeenError = db.prepare("UPDATE shader_meta SET seen_error = ? WHERE key = ?");
  const insertActivity = db.prepare(`
    INSERT INTO activity (ts, user_id, user_name, action, shader_id, shader_name, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectActivity = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?");
  const lastActivity = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 1");
  const updateActivity = db.prepare("UPDATE activity SET ts = ?, detail = ? WHERE id = ?");

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

  function toMeta(row: MetaRow): ShaderMeta {
    return {
      name: row.name,
      createdBy: { id: row.created_by_id, name: row.created_by_name },
      modifiedBy: { id: row.modified_by_id, name: row.modified_by_name },
      seenError: row.seen_error,
    };
  }

  return {
    meta(key: string): ShaderMeta | null {
      const row = selectMeta.get(key) as MetaRow | undefined;
      return row ? toMeta(row) : null;
    },

    /**
     * Record a shader's name and last editor. The creator is only written the
     * first time; later saves keep the original.
     */
    saveMeta(key: string, name: string, createdBy: Person, modifiedBy: Person) {
      insertMeta.run(key, name, createdBy.id, createdBy.name, modifiedBy.id, modifiedBy.name);
    },

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

    setSeenError(key: string, error: string | null) {
      updateSeenError.run(error, key);
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

    close: () => db.close(),
  };
}

export type Db = ReturnType<typeof openDb>;
