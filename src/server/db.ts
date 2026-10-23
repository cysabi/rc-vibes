// vibes' own records: the lights' positions, rails, orientations and tags set
// in vibes, plus an activity log. arclamp sees every vibes action as the
// single "vibes" token.

import type { ParamSpec, ParamTable } from "../shared/params.ts";
import { DatabaseSync } from "node:sqlite";
import type { RailShape } from "../shared/rails.ts";
import type { ActivityAction, ActivityEntry, Me, Person, Spot } from "../shared/vibes.ts";

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
    -- A deleted one keeps its row, marked (deleted_at, deleted_by_*), to restore.
    CREATE TABLE IF NOT EXISTS sketches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    -- Boxes: one person's VS Code for one sketch, with their own clone of it,
    -- on main. branch is main for every box since; each person once had a
    -- branch of their own, and an older vibes still writes it. pod is the box
    -- it was last claimed in (whether that's still running is the box
    -- runner's to say).
    CREATE TABLE IF NOT EXISTS boxes (
      id TEXT PRIMARY KEY,
      sketch_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      at INTEGER NOT NULL,
      UNIQUE (sketch_id, user_id)
    );
    -- Builds: one commit of a sketch, built for the room by vibes' builder
    -- (builder is its version), and how it went: its log, and the script,
    -- stamped, if it built.
    CREATE TABLE IF NOT EXISTS builds (
      id TEXT PRIMARY KEY,
      sketch_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      builder TEXT NOT NULL,
      state TEXT NOT NULL,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at INTEGER NOT NULL,
      finished_at INTEGER,
      plan TEXT,
      error TEXT,
      log TEXT,
      script TEXT
    );
    CREATE INDEX IF NOT EXISTS builds_by_sketch ON builds (sketch_id, at);
    -- Instances: sketches put in the room from vibes, each on a home (the
    -- lights it was put on, a JSON array of ids), which it's masked to. Its
    -- build is the one it runs, or will once built; shader_id is its shader
    -- in arclamp once it's there. state: building, failed (error says why),
    -- or live. next_build_id is a newer build on its way in.
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      sketch_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      home TEXT NOT NULL,
      shader_id INTEGER,
      state TEXT NOT NULL,
      error TEXT,
      next_build_id TEXT,
      by_id TEXT NOT NULL,
      by_name TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    -- Footprints: every light a shader has changed, before its mask or mute,
    -- since its script (script_hash) last changed: a JSON array of ids.
    CREATE TABLE IF NOT EXISTS footprints (
      shader_id INTEGER PRIMARY KEY,
      script_hash TEXT NOT NULL,
      lights TEXT NOT NULL
    );
  `);

  const placementColumns = db.prepare("PRAGMA table_info(placements)").all() as { name: string }[];
  if (!placementColumns.some((c) => c.name === "rail_id")) {
    db.exec("ALTER TABLE placements ADD COLUMN rail_id TEXT; ALTER TABLE placements ADD COLUMN mm_along REAL");
  }
  const boxColumns = db.prepare("PRAGMA table_info(boxes)").all() as { name: string }[];
  if (!boxColumns.some((c) => c.name === "pod")) db.exec("ALTER TABLE boxes ADD COLUMN pod TEXT");
  const sketchColumns = db.prepare("PRAGMA table_info(sketches)").all() as { name: string }[];
  if (!sketchColumns.some((c) => c.name === "deleted_at")) {
    db.exec("ALTER TABLE sketches ADD COLUMN deleted_at INTEGER; ALTER TABLE sketches ADD COLUMN deleted_by_id TEXT; ALTER TABLE sketches ADD COLUMN deleted_by_name TEXT");
  }
  // The branch an instance was put in from (all of them main, before there was a choice).
  const instanceColumns = db.prepare("PRAGMA table_info(instances)").all() as { name: string }[];
  if (!instanceColumns.some((c) => c.name === "branch")) db.exec("ALTER TABLE instances ADD COLUMN branch TEXT NOT NULL DEFAULT 'main'");
  // The key the browser sent with it (its pending edit's), so the same edit sent again is the same instance.
  if (!instanceColumns.some((c) => c.name === "client_key")) db.exec("ALTER TABLE instances ADD COLUMN client_key TEXT");
  // What's wanted of it before it's in the room, to go in that way: muted, its whole mask, and its place.
  if (!instanceColumns.some((c) => c.name === "muted")) {
    db.exec("ALTER TABLE instances ADD COLUMN muted INTEGER NOT NULL DEFAULT 0; ALTER TABLE instances ADD COLUMN mask TEXT; ALTER TABLE instances ADD COLUMN above TEXT");
  }
  // Its params (params.ts): their values, by name; what its shader last said its sketch declares; and its link's number.
  if (!instanceColumns.some((c) => c.name === "params")) {
    db.exec("ALTER TABLE instances ADD COLUMN params TEXT; ALTER TABLE instances ADD COLUMN declared TEXT; ALTER TABLE instances ADD COLUMN link_epoch INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS instances_by_client_key ON instances (by_id, client_key)");

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
  const selectSketches = db.prepare("SELECT * FROM sketches WHERE deleted_at IS NULL ORDER BY at DESC");
  const selectDeletedSketches = db.prepare("SELECT * FROM sketches WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
  const markSketchDeleted = db.prepare("UPDATE sketches SET deleted_at = ?, deleted_by_id = ?, deleted_by_name = ? WHERE id = ? AND deleted_at IS NULL");
  const unmarkSketchDeleted = db.prepare("UPDATE sketches SET deleted_at = NULL, deleted_by_id = NULL, deleted_by_name = NULL WHERE id = ?");
  const selectBoxesOf = db.prepare("SELECT * FROM boxes WHERE sketch_id = ?");
  const selectSketch = db.prepare("SELECT * FROM sketches WHERE id = ?");
  const insertSketch = db.prepare("INSERT INTO sketches (id, name, by_id, by_name, at) VALUES (?, ?, ?, ?, ?)");
  const selectBox = db.prepare("SELECT * FROM boxes WHERE id = ?");
  const selectBoxFor = db.prepare("SELECT * FROM boxes WHERE sketch_id = ? AND user_id = ?");
  const insertBox = db.prepare("INSERT INTO boxes (id, sketch_id, user_id, user_name, branch, at) VALUES (?, ?, ?, ?, 'main', ?)");
  const updateBoxPod = db.prepare("UPDATE boxes SET pod = ? WHERE id = ?");
  const selectBoxPods = db.prepare("SELECT id, pod FROM boxes WHERE pod IS NOT NULL");
  const insertBuild = db.prepare("INSERT INTO builds (id, sketch_id, commit_sha, builder, state, by_id, by_name, at) VALUES (?, ?, ?, ?, 'building', ?, ?, ?)");
  const selectBuild = db.prepare("SELECT * FROM builds WHERE id = ?");
  const selectBuildsOf = db.prepare("SELECT * FROM builds WHERE sketch_id = ? ORDER BY at DESC LIMIT ?");
  const selectBuildOfCommit = db.prepare("SELECT * FROM builds WHERE sketch_id = ? AND commit_sha = ? AND builder = ? AND state IN ('building', 'built') ORDER BY at DESC LIMIT 1");
  const selectBuilding = db.prepare("SELECT * FROM builds WHERE state = 'building'");
  const updateBuild = db.prepare("UPDATE builds SET state = ?, finished_at = ?, plan = ?, error = ?, log = ?, script = ? WHERE id = ? AND state = 'building'");
  const insertInstance = db.prepare(
    "INSERT INTO instances (id, sketch_id, branch, build_id, home, shader_id, state, error, next_build_id, by_id, by_name, at, client_key, muted, mask, above) VALUES (?, ?, ?, ?, ?, NULL, 'building', NULL, NULL, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectInstanceOfKey = db.prepare("SELECT * FROM instances WHERE by_id = ? AND client_key = ?");
  const selectInstance = db.prepare("SELECT * FROM instances WHERE id = ?");
  const selectInstances = db.prepare("SELECT * FROM instances ORDER BY at");
  const selectInstanceOfShader = db.prepare("SELECT * FROM instances WHERE shader_id = ?");
  const deleteInstanceRow = db.prepare("DELETE FROM instances WHERE id = ?");
  const selectFootprints = db.prepare("SELECT shader_id, script_hash, lights FROM footprints");
  const upsertFootprint = db.prepare(
    "INSERT INTO footprints (shader_id, script_hash, lights) VALUES (?, ?, ?) ON CONFLICT (shader_id) DO UPDATE SET script_hash = excluded.script_hash, lights = excluded.lights",
  );
  const deleteFootprintRow = db.prepare("DELETE FROM footprints WHERE shader_id = ?");

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
     * room tone changes; the history should show one). With `same`, only
     * when the previous entry was about the same thing too, by its detail
     * (the same param of the same shader, say).
     */
    logCoalesced(entry: LogInput, windowMs: number, same?: (lastDetail: Record<string, unknown> | null) => boolean) {
      const last = lastActivity.get() as ActivityRow | undefined;
      const now = new Date();
      if (
        last &&
        last.user_id === entry.user.id &&
        last.action === entry.action &&
        now.getTime() - new Date(last.ts).getTime() < windowMs &&
        (!same || same(last.detail ? (JSON.parse(last.detail) as Record<string, unknown>) : null))
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

    /** Every sketch that isn't deleted, newest first. */
    sketches: () => selectSketches.all() as unknown as SketchRow[],

    /** The deleted sketches, the most recently deleted first. */
    deletedSketches: () => selectDeletedSketches.all() as unknown as SketchRow[],

    /** A sketch, deleted or not. */
    sketch: (id: string) => selectSketch.get(id) as SketchRow | undefined,

    addSketch(s: Omit<SketchRow, "deleted_at" | "deleted_by_id" | "deleted_by_name">) {
      insertSketch.run(s.id, s.name, s.by_id, s.by_name, s.at);
    },

    deleteSketch(id: string, by: Me, at: number) {
      markSketchDeleted.run(at, by.id, by.name, id);
    },

    restoreSketch(id: string) {
      unmarkSketchDeleted.run(id);
    },

    /** Everyone's boxes for a sketch. */
    boxesOf: (sketchId: string) => selectBoxesOf.all(sketchId) as unknown as BoxRow[],

    box: (id: string) => selectBox.get(id) as BoxRow | undefined,

    /** Someone's box for a sketch, if they've opened it before. */
    boxFor: (sketchId: string, userId: string) => selectBoxFor.get(sketchId, userId) as BoxRow | undefined,

    addBox(b: Omit<BoxRow, "pod">) {
      insertBox.run(b.id, b.sketch_id, b.user_id, b.user_name, b.at);
    },

    setBoxPod(id: string, pod: string | null) {
      updateBoxPod.run(pod, id);
    },

    /** The boxes claimed for someone, and whose. */
    boxPods: () => selectBoxPods.all() as { id: string; pod: string }[],

    addBuild(b: Pick<BuildRow, "id" | "sketch_id" | "commit_sha" | "builder" | "by_id" | "by_name" | "at">) {
      insertBuild.run(b.id, b.sketch_id, b.commit_sha, b.builder, b.by_id, b.by_name, b.at);
    },

    build: (id: string) => selectBuild.get(id) as BuildRow | undefined,

    /** A sketch's latest builds, newest first. */
    buildsOf: (sketchId: string, limit = 20) => selectBuildsOf.all(sketchId, limit) as unknown as BuildRow[],

    /** A build of this commit by this builder that's built, or still building. */
    buildOfCommit: (sketchId: string, commit: string, builder: string) => selectBuildOfCommit.get(sketchId, commit, builder) as BuildRow | undefined,

    /** The builds still going. */
    building: () => selectBuilding.all() as unknown as BuildRow[],

    /** How a build ended; false if it had already. */
    finishBuild(id: string, end: Pick<BuildRow, "state" | "finished_at" | "plan" | "error" | "log" | "script">): boolean {
      return updateBuild.run(end.state, end.finished_at, end.plan, end.error, end.log, end.script, id).changes > 0;
    },

    /** A new instance, building: from main, unless it says otherwise. */
    addInstance(
      i: Pick<InstanceRow, "id" | "sketch_id" | "build_id" | "home" | "by_id" | "by_name" | "at"> &
        Partial<Pick<InstanceRow, "branch" | "client_key" | "muted" | "mask" | "above">>,
    ) {
      insertInstance.run(
        i.id,
        i.sketch_id,
        i.branch ?? "main",
        i.build_id,
        JSON.stringify(i.home),
        i.by_id,
        i.by_name,
        i.at,
        i.client_key ?? null,
        i.muted ? 1 : 0,
        i.mask ? JSON.stringify(i.mask) : null,
        i.above ?? null,
      );
    },

    /** The instance someone put in with a key of theirs, if there is one. */
    instanceOfKey: (byId: string, key: string) => instanceOf(selectInstanceOfKey.get(byId, key)),

    instance: (id: string) => instanceOf(selectInstance.get(id)),

    /** Every instance, the oldest first. */
    instances: () => (selectInstances.all() as unknown as RawInstance[]).map((r) => instanceOf(r)!),

    /** The instance a shader is, if it's one. */
    instanceOfShader: (shaderId: number) => instanceOf(selectInstanceOfShader.get(shaderId)),

    /** Changes some of an instance. */
    updateInstance(
      id: string,
      patch: Partial<Pick<InstanceRow, "build_id" | "home" | "shader_id" | "state" | "error" | "next_build_id" | "muted" | "mask" | "above" | "params" | "declared" | "link_epoch">>,
    ) {
      const cols = Object.keys(patch) as (keyof typeof patch)[];
      if (cols.length === 0) return;
      const json = new Set<string>(["home", "mask", "params", "declared"]);
      const values = cols.map((c) => (json.has(c) ? (patch[c] ? JSON.stringify(patch[c]) : null) : c === "muted" ? (patch.muted ? 1 : 0) : (patch[c] ?? null)));
      db.prepare(`UPDATE instances SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...(values as (string | number | null)[]), id);
    },

    deleteInstance(id: string) {
      deleteInstanceRow.run(id);
    },

    /** Every shader's footprint, as kept. */
    footprints: () =>
      (selectFootprints.all() as { shader_id: number; script_hash: string; lights: string }[]).map((r) => ({
        shaderId: r.shader_id,
        scriptHash: r.script_hash,
        lights: JSON.parse(r.lights) as number[],
      })),

    setFootprint(shaderId: number, scriptHash: string, lights: number[]) {
      upsertFootprint.run(shaderId, scriptHash, JSON.stringify(lights));
    },

    deleteFootprint(shaderId: number) {
      deleteFootprintRow.run(shaderId);
    },

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
  /** When it was deleted, and by whom, if it has been. */
  deleted_at: number | null;
  deleted_by_id: string | null;
  deleted_by_name: string | null;
}

export interface BoxRow {
  id: string;
  sketch_id: string;
  user_id: string;
  user_name: string;
  /** When it was first opened, in ms. */
  at: number;
  /** The box it was last claimed in, unless it's been let go since. */
  pod: string | null;
}

export interface BuildRow {
  id: string;
  sketch_id: string;
  /** The commit built (its full hash). */
  commit_sha: string;
  /** The builder's version (BUILDER_VERSION). */
  builder: string;
  state: "building" | "built" | "failed";
  by_id: string;
  by_name: string;
  /** When it was started, and when it ended, in ms. */
  at: number;
  finished_at: number | null;
  /** How it was built: "vite main.ts", "package.json: pnpm run build", … */
  plan: string | null;
  error: string | null;
  log: string | null;
  /** The script, stamped, if it built. */
  script: string | null;
}

export interface InstanceRow {
  id: string;
  sketch_id: string;
  /** The branch it was put in from: trying again, or updating, moves it to that branch's head. */
  branch: string;
  /** The key the browser put it in with (its pending edit's), if it sent one. */
  client_key: string | null;
  /** The build it runs, or will once it's built. */
  build_id: string;
  /** The lights it was put on, by id. */
  home: number[];
  shader_id: number | null;
  state: "building" | "failed" | "live";
  error: string | null;
  /** A newer build on its way in. */
  next_build_id: string | null;
  by_id: string;
  by_name: string;
  /** When it was put in, in ms. */
  at: number;
  /**
   * What's wanted of it until it's in the room, to go in that way: muted, its
   * whole mask (null: every light outside its home), and its place, just
   * above the shader with this key ("" the bottom; null the top).
   */
  muted: boolean;
  mask: number[] | null;
  above: string | null;
  /** Its params' values, by name (params.ts). */
  params: ParamTable;
  /** What its shader last said its sketch declares; null until it has. */
  declared: ParamSpec[] | null;
  /** How many times its shader's been linked for params: only the last link's token is good. */
  link_epoch: number;
}

type RawInstance = Omit<InstanceRow, "home" | "muted" | "mask" | "params" | "declared"> & {
  home: string;
  muted: number;
  mask: string | null;
  params: string | null;
  declared: string | null;
};

function instanceOf(raw: unknown): InstanceRow | undefined {
  if (!raw) return undefined;
  const r = raw as RawInstance;
  return {
    ...r,
    home: JSON.parse(r.home) as number[],
    muted: r.muted === 1,
    mask: r.mask ? (JSON.parse(r.mask) as number[]) : null,
    params: r.params ? (JSON.parse(r.params) as ParamTable) : {},
    declared: r.declared ? (JSON.parse(r.declared) as ParamSpec[]) : null,
  };
}

export type Db = ReturnType<typeof openDb>;
