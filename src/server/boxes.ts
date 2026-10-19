// Boxes: one person's VS Code for one sketch (openvscode-server, with vibes'
// extension), with their own clone of the sketch on their own branch. A box
// runs somewhere a runner can start it (Docker here, or a pod on the cluster),
// is reached only through vibes (box-proxy.ts), and is stopped after it's sat
// unused for a while; its files are kept for next time.
//
// A box has two secrets, both made from the session secret and its id, so
// vibes never has to store them: its token, which it shows vibes for git and
// the lights' layout, and the connection token its VS Code wants, which only
// vibes' proxy adds.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { BoxState, Me } from "../shared/vibes.ts";
import type { BoxRow, Db } from "./db.ts";
import type { Config, SketchesConfig } from "./env.ts";

// A box that hasn't started answering by then has failed (a first start may
// pull its image, which takes a while).
const START_TIMEOUT_MS = 5 * 60_000;
const IDLE_CHECK_MS = 60_000;

/** Where boxes run. Each box is one container (or pod), with a volume for its files. */
export interface BoxRunner {
  /** Where the box answers (an http origin), if it's running. */
  find(id: string): Promise<string | null>;
  /** Starts the box from `image` (making it, and its volume, the first time), and says where it answers. */
  start(id: string, image: string, env: Record<string, string>): Promise<string>;
  /** Stops the box, keeping its files. */
  stop(id: string): Promise<void>;
  /** The boxes running now. */
  running(): Promise<string[]>;
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

/** Where a box's VS Code is: the path vibes proxies to it, which is also its base path. */
export const boxPath = (id: string) => `/box/${id}`;

/** The folder a box's clone of its sketch is in. */
export const SKETCH_FOLDER = "/home/workspace/sketch";

interface Live {
  id: string;
  state: "starting" | "ready" | "failed";
  target?: string;
  error?: string;
  lastUsed: number;
  /** WebSockets open to it through the proxy: VS Code keeps one open while its page is. */
  sockets: number;
}

export function createBoxes(config: Config, sketches: SketchesConfig, db: Db, runner: BoxRunner) {
  const live = new Map<string, Live>();

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

  /** Whether the box's VS Code is answering yet. */
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

  async function start(box: BoxRow, l: Live) {
    try {
      const target = await runner.start(box.id, sketches.image, envFor(box));
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (!(await answers(target, box.id))) {
        if (Date.now() > deadline) throw new Error("it didn't start answering in time");
        await new Promise((r) => setTimeout(r, 500));
      }
      Object.assign(l, { state: "ready", target });
    } catch (err) {
      console.error(`box ${box.id} didn't start:`, err);
      Object.assign(l, { state: "failed", error: (err as Error).message });
    }
  }

  const view = (l: Live): BoxState =>
    l.state === "ready"
      ? { state: "ready", url: `${boxPath(l.id)}/?folder=${encodeURIComponent(SKETCH_FOLDER)}` }
      : l.state === "failed"
        ? { state: "failed", error: l.error ?? "it failed" }
        : { state: "starting" };
  const track = (id: string): Live => {
    const l: Live = { id, state: "starting", lastUsed: Date.now(), sockets: 0 };
    live.set(id, l);
    return l;
  };

  // Boxes left running from before vibes last started: stopped in their turn when idle.
  void runner
    .running()
    .then(async (running) => {
      for (const id of running) {
        if (live.has(id)) continue;
        const l = track(id);
        const target = await runner.find(id);
        if (target) Object.assign(l, { state: "ready", target });
        else live.delete(id);
      }
    })
    .catch((err) => console.error("couldn't list running boxes:", err));

  const idle = setInterval(() => {
    const now = Date.now();
    for (const [id, l] of live) {
      if (l.state === "starting" || l.sockets > 0 || now - l.lastUsed < sketches.idleMs) continue;
      live.delete(id);
      runner.stop(id).catch((err) => console.error(`couldn't stop box ${id}:`, err));
    }
  }, IDLE_CHECK_MS);
  idle.unref();

  return {
    /** Someone's box for a sketch, started if it isn't running, and how it's doing. */
    async ensure(sketchId: string, user: Me): Promise<BoxState> {
      let box = db.boxFor(sketchId, user.id);
      if (!box) {
        box = { id: randomUUID(), sketch_id: sketchId, user_id: user.id, user_name: user.name, branch: branchFor(sketchId, user.name), at: Date.now() };
        db.addBox(box);
      }
      let l = live.get(box.id);
      if (!l || l.state === "failed") {
        l = track(box.id);
        void start(box, l);
      } else if (l.state === "ready" && !(await answers(l.target!, box.id))) {
        // It stopped (or was stopped) behind vibes' back.
        Object.assign(l, { state: "starting", target: undefined });
        void start(box, l);
      }
      l.lastUsed = Date.now();
      return view(l);
    },

    /** Where to send a request for a box, if it's running. */
    target(id: string): string | null {
      const l = live.get(id);
      return l?.state === "ready" ? l.target! : null;
    },

    /** The box's been used: it's not idle. */
    touch(id: string) {
      const l = live.get(id);
      if (l) l.lastUsed = Date.now();
    },

    socketOpened(id: string) {
      const l = live.get(id);
      if (l) l.sockets++;
    },

    socketClosed(id: string) {
      const l = live.get(id);
      if (l) {
        l.sockets = Math.max(0, l.sockets - 1);
        l.lastUsed = Date.now();
      }
    },

    stop() {
      clearInterval(idle);
    },
  };
}

export type Boxes = ReturnType<typeof createBoxes>;
