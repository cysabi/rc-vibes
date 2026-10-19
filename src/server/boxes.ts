// Boxes: one person's VS Code for one sketch (openvscode-server, with vibes'
// extension), with their own clone of the sketch on their own branch. A box
// runs somewhere a runner can start one (Docker here, or a pod on the
// cluster), and is reached only through vibes (box-proxy.ts).
//
// Opening a sketch is quick because a box is always waiting: vibes keeps a
// pool of booted boxes that are no one's yet (BOX_POOL), each running only
// its agent (box/agent.ts). Opening a sketch claims one: vibes hands its agent
// the person's box and settings, and the agent puts their home in place (from
// the homes every box is given, taking the rest away) and starts their VS
// Code. A box is never anyone else's after that: once it's done with, it's
// removed, and the pool topped up with a new one. Homes are kept, so the
// clone, VS Code's state and anything installed carry on from one to the next.
//
// A box lives while its page is open and in sight: the page checks in
// (ensure) every so often, and a box nothing's checked in on for
// BOX_IDLE_MINUTES is removed. Each one claimed is a new run; a page that
// finds a new run loads VS Code afresh.
//
// A box has three secrets, all made from the session secret, so vibes never
// has to store them: its token, which it shows vibes for git and the lights'
// layout; the connection token its VS Code wants, which only vibes' proxy
// adds; and, before it's claimed, the token its agent wants to be claimed.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BoxState, Me } from "../shared/vibes.ts";
import type { BoxRow, Db } from "./db.ts";
import type { Config, SketchesConfig } from "./env.ts";

// A box that isn't waiting to be claimed by then hasn't booted (a first boot
// may pull its image, which takes a while).
const BOOT_TIMEOUT_MS = 5 * 60_000;
// One claimed, whose VS Code isn't answering by then, has failed.
const CLAIM_TIMEOUT_MS = 2 * 60_000;
// After a box fails to boot, the pool waits this long before trying again.
const BOOT_RETRY_MS = 30_000;
const IDLE_CHECK_MS = 60_000;

/** Where boxes run. Each box is one container (or pod); homes are kept apart from them. */
export interface BoxRunner {
  /** Boots a box that's no one's yet, from `image`, and says where it answers (an http origin). */
  boot(name: string, image: string, env: Record<string, string>): Promise<string>;
  /** Where a box answers, if it's running. */
  find(name: string): Promise<string | null>;
  /** Removes a box. Nothing's lost: its home is kept elsewhere. */
  remove(name: string): Promise<void>;
  /** The boxes there are now, and whether each is from `image`. */
  list(image: string): Promise<{ name: string; current: boolean }[]>;
}

const mac = (secret: string, purpose: string, id: string) => createHmac("sha256", secret).update(`${purpose}:${id}`).digest("base64url");

/** What a box shows vibes, for git and the lights' layout. */
export const boxToken = (secret: string, id: string) => `${id}.${mac(secret, "box", id)}`;

/** The box a token belongs to, if it's a real one. */
export function boxOfToken(secret: string, token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(secret, "box", id));
  return given.length === want.length && timingSafeEqual(given, want) ? id : null;
}

/** The connection token a box's VS Code is started with; only vibes' proxy sends it. */
export const vscodeToken = (secret: string, id: string) => mac(secret, "vscode", id);

/** What a waiting box's agent wants before it'll be claimed: it's booted with it. */
export const claimToken = (secret: string, name: string) => mac(secret, "claim", name);

/** Where a box's VS Code is: the path vibes proxies to it, which is also its base path. */
export const boxPath = (id: string) => `/box/${id}`;

/** The folder a box's clone of its sketch is in. */
export const SKETCH_FOLDER = "/home/workspace/sketch";

// What VS Code's page is told as it opens (it reads these from its address):
// no welcome page.
const PAYLOAD = JSON.stringify([["skipWelcome", "true"]]);

/** A booted box, no one's yet. */
interface Waiting {
  name: string;
  target: string;
}

interface Live {
  id: string;
  state: "starting" | "ready" | "failed";
  /** The box it's running in, which is also which run of it this is. */
  pod?: string;
  target?: string;
  error?: string;
  /** When its page last checked in. */
  seen: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBoxes(config: Config, sketches: SketchesConfig, db: Db, runner: BoxRunner) {
  /** Waits until box `name` is `ready`, asking five times a second, or throws `late` at the deadline, or if it's ended meanwhile. */
  async function until(name: string, ready: () => Promise<boolean>, ms: number, late: string) {
    const deadline = Date.now() + ms;
    for (let i = 1; !(await ready()); i++) {
      if (Date.now() > deadline) throw new Error(late);
      if (i % 10 === 0 && !(await runner.find(name))) throw new Error("it ended as it started");
      await sleep(200);
    }
  }

  const live = new Map<string, Live>();
  const pool: Waiting[] = [];
  let booting = 0;
  let retryAt = 0;
  let stopped = false;

  const branchFor = (sketchId: string, name: string) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "me";
    let branch = base;
    for (let n = 2; db.sketchBranchTaken(sketchId, branch); n++) branch = `${base}-${n}`;
    return branch;
  };

  function envFor(box: BoxRow): Record<string, string> {
    return {
      VIBES_BOX_ID: box.id,
      VIBES_BOX_TOKEN: boxToken(config.sessionSecret, box.id),
      VIBES_VSCODE_TOKEN: vscodeToken(config.sessionSecret, box.id),
      VIBES_URL: sketches.vibesUrl,
      VIBES_GIT_URL: `${sketches.vibesUrl}/git/${box.sketch_id}.git`,
      VIBES_BRANCH: box.branch,
      VIBES_USER_NAME: box.user_name,
      VIBES_USER_EMAIL: `${box.user_id.replace(/[^a-z0-9]+/gi, "-")}@users.vibes.invalid`,
      VIBES_BASE_PATH: boxPath(box.id),
      VIBES_FOLDER: SKETCH_FOLDER,
    };
  }

  const removeBox = (name: string) => runner.remove(name).catch((err) => console.error(`couldn't remove box ${name}:`, err));

  /** Whether a box's agent is there, waiting to be claimed. */
  async function waiting(target: string): Promise<boolean> {
    try {
      const res = await fetch(`${target}/claim`, { signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
      return res.status === 204;
    } catch {
      return false;
    }
  }

  /** Whether a box's VS Code is answering yet. */
  async function answers(target: string, id: string): Promise<boolean> {
    try {
      const res = await fetch(`${target}${boxPath(id)}/`, {
        headers: { cookie: `vscode-tkn=${vscodeToken(config.sessionSecret, id)}` },
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      await res.body?.cancel();
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** A new box, booted and waiting to be claimed. */
  async function boot(): Promise<Waiting> {
    const name = `box-${randomBytes(6).toString("hex")}`;
    try {
      const target = await runner.boot(name, sketches.image, { VIBES_CLAIM_TOKEN: claimToken(config.sessionSecret, name) });
      await until(name, () => waiting(target), BOOT_TIMEOUT_MS, "its agent didn't start in time");
      return { name, target };
    } catch (err) {
      void removeBox(name);
      throw err;
    }
  }

  /** Boots boxes until there are BOX_POOL waiting (or on their way). */
  function refill() {
    while (!stopped && pool.length + booting < sketches.pool && Date.now() >= retryAt) {
      booting++;
      boot()
        .then((w) => {
          if (stopped) void removeBox(w.name);
          else pool.push(w);
        })
        .catch((err) => {
          console.error("a box for the pool didn't boot:", err);
          retryAt = Date.now() + BOOT_RETRY_MS;
          setTimeout(refill, BOOT_RETRY_MS).unref();
        })
        .finally(() => booting--);
    }
  }

  /** A waiting box: one from the pool, or (if it's empty) one booted now. */
  function take(): Promise<Waiting> {
    const w = pool.shift();
    refill();
    return w ? Promise.resolve(w) : boot();
  }

  async function claim(w: Waiting, box: BoxRow) {
    const res = await fetch(`${w.target}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${claimToken(config.sessionSecret, w.name)}`, "content-type": "application/json" },
      body: JSON.stringify({ box: box.id, env: envFor(box) }),
      signal: AbortSignal.timeout(10_000),
    });
    const message = await res.text();
    if (res.status !== 204) throw new Error(`its agent answered ${res.status}: ${message}`);
  }

  /** A waiting box, claimed for `box`. */
  async function claimFor(box: BoxRow): Promise<Waiting> {
    // A waiting box can have ended while it waited: then another.
    for (let tries = 1; ; tries++) {
      const w = await take();
      // Written down before it's claimed, so a vibes that restarts knows whose it is.
      db.setBoxPod(box.id, w.name);
      try {
        await claim(w, box);
        return w;
      } catch (err) {
        void removeBox(w.name);
        if (tries === 3) throw err;
      }
    }
  }

  async function start(box: BoxRow, l: Live) {
    let w: Waiting | undefined;
    try {
      // One box per person per sketch: any it had before (one that's
      // stopped answering) goes first.
      if (box.pod) await removeBox(box.pod);
      w = await claimFor(box);
      const { target } = w;
      await until(w.name, () => answers(target, box.id), CLAIM_TIMEOUT_MS, "its VS Code didn't start answering in time");
      Object.assign(l, { state: "ready", pod: w.name, target });
    } catch (err) {
      console.error(`box ${box.id} didn't start:`, err);
      if (w) void removeBox(w.name);
      db.setBoxPod(box.id, null);
      Object.assign(l, { state: "failed", error: (err as Error).message });
    }
  }

  const view = (l: Live): BoxState =>
    l.state === "ready"
      ? { state: "ready", run: l.pod!, url: `${boxPath(l.id)}/?folder=${encodeURIComponent(SKETCH_FOLDER)}&payload=${encodeURIComponent(PAYLOAD)}` }
      : l.state === "failed"
        ? { state: "failed", error: l.error ?? "it failed" }
        : { state: "starting" };

  // What's left from before vibes last started: boxes still someone's carry on
  // (until nothing checks in on them), waiting ones from this image go back in
  // the pool, and the rest go.
  async function adopt() {
    const owners = new Map(db.boxPods().map((b) => [b.pod, b.id]));
    for (const { name, current } of await runner.list(sketches.image)) {
      const id = owners.get(name);
      const target = await runner.find(name);
      if (id && target && (await answers(target, id))) live.set(id, { id, state: "ready", pod: name, target, seen: Date.now() });
      else if (!id && current && target && (await waiting(target))) pool.push({ name, target });
      else void removeBox(name);
    }
  }
  const adopted = adopt()
    .catch((err) => console.error("couldn't look for boxes left running:", err))
    .finally(refill);

  const idle = setInterval(
    () => {
      const now = Date.now();
      for (const [id, l] of live) {
        if (l.state === "starting" || now - l.seen < sketches.idleMs) continue;
        live.delete(id);
        if (l.pod) void removeBox(l.pod);
        db.setBoxPod(id, null);
      }
    },
    Math.min(IDLE_CHECK_MS, sketches.idleMs),
  );
  idle.unref();

  return {
    /**
     * Someone's box for a sketch, started if it isn't running, and how it's
     * doing. Their page asks this while it's open and in sight, which keeps the
     * box.
     */
    async ensure(sketchId: string, user: Me): Promise<BoxState> {
      await adopted;
      let box = db.boxFor(sketchId, user.id);
      if (!box) {
        box = { id: randomUUID(), sketch_id: sketchId, user_id: user.id, user_name: user.name, branch: branchFor(sketchId, user.name), at: Date.now(), pod: null };
        db.addBox(box);
      }
      let l = live.get(box.id);
      if (!l || l.state === "failed") {
        l = { id: box.id, state: "starting", seen: Date.now() };
        live.set(box.id, l);
        void start(box, l);
      } else if (l.state === "ready" && !(await answers(l.target!, box.id)) && l.state === "ready") {
        // It ended (or was removed) behind vibes' back. (Checked again: another
        // check-in may have seen to it meanwhile.)
        Object.assign(l, { state: "starting", target: undefined });
        void start(box, l);
      }
      l.seen = Date.now();
      return view(l);
    },

    /** Where to send a request for a box, if it's running. */
    target(id: string): string | null {
      const l = live.get(id);
      return l?.state === "ready" ? l.target! : null;
    },

    /** Stops looking after boxes; they carry on, for the next vibes to adopt. */
    stop() {
      stopped = true;
      clearInterval(idle);
    },
  };
}

export type Boxes = ReturnType<typeof createBoxes>;
