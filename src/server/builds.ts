// Builds: a commit of a sketch, built for the room. Each build runs in a pod
// (or container) of its own, from the box image, running box/builder.ts: in a
// Kata VM on kokuzo, as uid 1000 with no privileges, reaching only the
// internet and vibes. It fetches the commit's files from vibes and sends back
// the script and its log, through /build-api with its own token, once.
//
// vibes trusts nothing the builder says: it checks the script itself (a
// script rclamp can run, within rclamp's size limit, defining a global
// update()), then stamps it (stamp.ts) and keeps it with the log. A commit is
// built once per builder version; asking again gets the same build (or the
// one still going), unless it failed.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import vm from "node:vm";
import { z } from "zod";
import { BUILDER_VERSION } from "../shared/sketch-plan.ts";
import type { Build, Me } from "../shared/vibes.ts";
import type { BuildRow, Db } from "./db.ts";
import type { Config, SketchesConfig } from "./env.ts";
import { archive, resolveCommit } from "./git.ts";
import { specsOf } from "./params.ts";
import { stamp } from "./stamp.ts";

/** The most a script can be: rclamp's limit. */
export const SCRIPT_LIMIT = 256 * 1024;
const MAX_LOG = 200_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const CHECK_MS = 5_000;
// A pod ended this long ago with no result has none coming.
const RESULT_GRACE_MS = 10_000;
// What a build's pod runs: the builder, beside the extension in the box image.
const BUILD_COMMAND = ["sh", "-c", 'exec node "$VIBES_EXTENSION/builder.mjs"'];

/**
 * What a build may do, as root in its VM: start Nix's daemon, then the build
 * itself as uid 1000 (box/builder.ts). Nothing to mount with.
 */
export const BUILD_CAPABILITIES = ["CHOWN", "SETUID", "SETGID", "KILL", "FOWNER", "DAC_OVERRIDE"];

/** Where builds run: the same runner as boxes. */
export interface BuildRunner {
  /** Starts a build from `image`, running `command`, with no home and no privileges; it ends by itself. */
  startBuild(name: string, image: string, command: string[], env: Record<string, string>): Promise<void>;
  /** How a build's going: still running, ended, or not there at all. */
  buildState(name: string): Promise<"running" | "ended" | "gone">;
  removeBuild(name: string): Promise<void>;
  /** The builds there are now. */
  builds(): Promise<string[]>;
}

const mac = (secret: string, id: string) => createHmac("sha256", secret).update(`build:${id}`).digest("base64url");

/** A build's own token, for /build-api: its id, signed. */
export const buildToken = (secret: string, id: string) => `${id}.${mac(secret, id)}`;

/** The build a token is for, if it's a real one. */
export function buildOfToken(secret: string, token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(secret, id));
  return given.length === want.length && timingSafeEqual(given, want) ? id : null;
}

/** Why vibes won't use a built script, or null if it will. */
export function checkScript(script: string): string | null {
  const size = Buffer.byteLength(script);
  if (size > SCRIPT_LIMIT) return `it's ${Math.ceil(size / 1024)} KB, over rclamp's ${SCRIPT_LIMIT / 1024} KB`;
  try {
    // Compiled only, to see it's a script: never run.
    new vm.Script(script, { filename: "sketch.js" });
  } catch (err) {
    return `it isn't a script rclamp can run: ${(err as Error).message}`;
  }
  if (!/(^|[^\w$.])(function\s+update\s*\(|(var|let|const)\s+update\s*=|globalThis\.update\s*=)/m.test(script)) return "it doesn't define a global update()";
  return null;
}

const podOf = (id: string) => `build-${id}`;

/** A tool's message without its terminal colors (Vite's, say), for a page to show. */
export const plainText = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

export function view(row: BuildRow, withLog = false): Build {
  return {
    id: row.id,
    sketchId: row.sketch_id,
    commit: row.commit_sha,
    builder: row.builder,
    state: row.state,
    by: row.by_name,
    at: row.at,
    finishedAt: row.finished_at,
    plan: row.plan,
    error: row.error,
    params: row.params,
    ...(withLog ? { log: row.log ?? "" } : {}),
  };
}

export function createBuilds(config: Config, sketches: SketchesConfig, db: Db, runner: BuildRunner, timing = { checkMs: CHECK_MS, graceMs: RESULT_GRACE_MS }) {
  const removePod = (id: string, after = 0) =>
    setTimeout(() => runner.removeBuild(podOf(id)).catch((err) => console.error(`couldn't remove build ${id}:`, err)), after).unref();

  // Told of each build as it ends, built or not (instances waiting on it).
  const finished = new Set<(id: string) => void>();
  const ended = (id: string) => {
    for (const listener of finished) listener(id);
  };

  function fail(id: string, error: string, log: string | null = null, plan: string | null = null) {
    if (db.finishBuild(id, { state: "failed", finished_at: Date.now(), plan, error: plainText(error), log, script: null })) {
      console.error(`build ${id} failed: ${error}`);
      ended(id);
    }
    removePod(id);
  }

  // Builds going when vibes last stopped have nowhere to send their results now.
  for (const row of db.building()) fail(row.id, "vibes restarted while it was building", row.log);
  void runner
    .builds()
    .then((names) => Promise.all(names.map((name) => runner.removeBuild(name))))
    .catch((err) => console.error("couldn't clear old builds:", err));

  // A build that's stopped with nothing sent back, or taken too long, has failed.
  const stoppedAt = new Map<string, number>();
  const watch = setInterval(() => {
    for (const row of db.building()) {
      if (Date.now() - row.at > BUILD_TIMEOUT_MS) {
        fail(row.id, `it took longer than ${BUILD_TIMEOUT_MS / 60_000} minutes`);
        continue;
      }
      runner
        .buildState(podOf(row.id))
        .then((state) => {
          if (state === "running") return;
          const since = stoppedAt.get(row.id) ?? Date.now();
          stoppedAt.set(row.id, since);
          if (Date.now() - since > timing.graceMs) {
            stoppedAt.delete(row.id);
            fail(row.id, "the build stopped without sending a result");
          }
        })
        .catch((err) => console.error(`couldn't check on build ${row.id}:`, err));
    }
  }, timing.checkMs);
  watch.unref();

  return {
    /** A build of a commit of a sketch (main's latest, by default): started, or the one there is already. */
    async start(sketchId: string, rev: string, user: Me): Promise<{ build: Build } | { refused: string; status: 404 | 503 }> {
      if (!config.signingKey) return { refused: "vibes has no signing key (VIBES_SIGNING_KEY), so it can't stamp what it builds", status: 503 };
      const commit = await resolveCommit(sketches.dir, sketchId, rev);
      if (!commit) return { refused: `the sketch has no commit ${rev}`, status: 404 };
      const existing = db.buildOfCommit(sketchId, commit, BUILDER_VERSION);
      if (existing) return { build: view(existing) };
      const id = randomUUID();
      db.addBuild({ id, sketch_id: sketchId, commit_sha: commit, builder: BUILDER_VERSION, by_id: user.id, by_name: user.name, at: Date.now() });
      try {
        await runner.startBuild(podOf(id), sketches.image, BUILD_COMMAND, {
          VIBES_BUILD_URL: sketches.vibesUrl,
          VIBES_BUILD_TOKEN: buildToken(config.sessionSecret, id),
        });
      } catch (err) {
        fail(id, `couldn't start the build: ${(err as Error).message}`);
      }
      return { build: view(db.build(id)!) };
    },

    /** The commit's files, for the build that's building it. */
    source(id: string): ReadableStream<Uint8Array> | null {
      const row = db.build(id);
      return row?.state === "building" ? archive(sketches.dir, row.sketch_id, row.commit_sha) : null;
    },

    /** What a build sent back: checked, and stamped if it's a script vibes will use. False if it had already ended. */
    finish(id: string, result: { ok: boolean; script?: string; error?: string; log?: string; plan?: string | null; params?: unknown[] }): boolean {
      const row = db.build(id);
      if (row?.state !== "building") return false;
      const log = (result.log ?? "").slice(0, MAX_LOG);
      const plan = result.plan ?? null;
      if (!result.ok || typeof result.script !== "string") {
        fail(id, result.error || "the build failed", log, plan);
      } else {
        const problem = checkScript(result.script);
        if (problem) fail(id, `vibes won't use what it built: ${problem}`, log, plan);
        else {
          const script = stamp(result.script, { sketch: row.sketch_id, commit: row.commit_sha, builder: row.builder }, config.signingKey!);
          db.finishBuild(id, { state: "built", finished_at: Date.now(), plan, error: null, log, script, params: specsOf(result.params) });
          ended(id);
          // Its request still on its way back to it.
          removePod(id, 5_000);
        }
      }
      return true;
    },

    /** Tells `listener` of each build as it ends (its id), built or failed; returns a way to stop. */
    onFinish(listener: (id: string) => void): () => void {
      finished.add(listener);
      return () => void finished.delete(listener);
    },

    stop() {
      clearInterval(watch);
    },
  };
}

export type Builds = ReturnType<typeof createBuilds>;

/** What builds ask vibes for, with their own token: their commit's files, and where to send the result. */
export function buildApiRoutes(config: Config, builds: Builds) {
  const resultSchema = z.object({
    ok: z.boolean(),
    script: z.string().optional(),
    error: z.string().optional(),
    log: z.string().optional(),
    plan: z.string().nullable().optional(),
    params: z.array(z.unknown()).max(1000).optional(),
  });
  const buildOf = (header: string | undefined) => {
    const [scheme, token = ""] = (header ?? "").split(" ");
    return scheme?.toLowerCase() === "bearer" ? buildOfToken(config.sessionSecret, token) : null;
  };
  return new Hono()
    .get("/build-api/source", (c) => {
      const id = buildOf(c.req.header("authorization"));
      const source = id ? builds.source(id) : null;
      if (!source) return c.text("no such build, or it's over", 401);
      return c.body(source, 200, { "content-type": "application/x-tar" });
    })
    .post(
      "/build-api/result",
      bodyLimit({ maxSize: SCRIPT_LIMIT * 4 + MAX_LOG * 2 }),
      zValidator("json", resultSchema, (r, c) => (r.success ? undefined : c.text("not a result", 400))),
      (c) => {
        const id = buildOf(c.req.header("authorization"));
        if (!id) return c.text("a build's token, please", 401);
        return builds.finish(id, c.req.valid("json")) ? c.body(null, 204) : c.text("that build is over", 409);
      },
    );
}
