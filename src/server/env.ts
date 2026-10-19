import path from "node:path";
import { z } from "zod";

const schema = z.object({
  ARCLAMP_BASE_URL: z.url(),
  ARCLAMP_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  // Comma-separated: every address vibes is reached at, the main one first.
  PUBLIC_URL: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((u) => u.trim()))
    .pipe(z.array(z.url()).min(1)),
  RC_CLIENT_ID: z.string().min(1).optional(),
  RC_CLIENT_SECRET: z.string().min(1).optional(),
  VIBES_DEV_LOGIN: z.enum(["0", "1"]).default("0"),
  DATABASE_PATH: z.string().min(1).default("vibes.db"),
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.string().default("development"),
  // Sketches, and the boxes they're edited in (see Config.sketches).
  SKETCHES: z.enum(["0", "1"]).default("0"),
  SKETCHES_DIR: z.string().min(1).optional(),
  BOX_RUNNER: z.enum(["docker", "kubernetes"]).default("docker"),
  BOX_IMAGE: z.string().min(1).optional(),
  BOX_VIBES_URL: z.url().optional(),
  BOX_NAMESPACE: z.string().min(1).default("vibes-boxes"),
  BOX_RUNTIME_CLASS: z.string().default("kata"),
  BOX_IDLE_MINUTES: z.coerce.number().positive().default(30),
});

export interface SketchesConfig {
  /** Where each sketch's canonical repo lives: <dir>/<id>.git. */
  dir: string;
  /** How boxes run: Docker on this machine, or pods on the cluster vibes runs in. */
  runner: "docker" | "kubernetes";
  /** The box image: VS Code, the sketch's tools, and vibes' extension. */
  image: string;
  /** Where a box reaches vibes (for git and the lights' layout). */
  vibesUrl: string;
  /** The Kubernetes namespace boxes run in. */
  namespace: string;
  /** The RuntimeClass box pods run with (a Kata VM on kokuzo), or "" for the cluster's own. */
  runtimeClass: string;
  /** A box nobody has used for this long is stopped (its files are kept). */
  idleMs: number;
}

export interface Config {
  arclamp: { baseUrl: string; key: string };
  sessionSecret: string;
  /** Where people reach vibes, the main one first: each logs in on its own. */
  publicUrls: URL[];
  rc: { clientId: string; clientSecret: string } | null;
  devLogin: boolean;
  databasePath: string;
  port: number;
  production: boolean;
  /** Sketches and their boxes, or null while they're off (SKETCHES=0). */
  sketches: SketchesConfig | null;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === "production";
  const devLogin = env.VIBES_DEV_LOGIN === "1";
  if (devLogin && production) {
    throw new Error("VIBES_DEV_LOGIN=1 is refused when NODE_ENV=production");
  }
  const rc =
    env.RC_CLIENT_ID && env.RC_CLIENT_SECRET
      ? { clientId: env.RC_CLIENT_ID, clientSecret: env.RC_CLIENT_SECRET }
      : null;
  if (!rc && !devLogin) {
    throw new Error("set RC_CLIENT_ID and RC_CLIENT_SECRET (or VIBES_DEV_LOGIN=1 for local development)");
  }
  let sketches: SketchesConfig | null = null;
  if (env.SKETCHES === "1") {
    if (!env.BOX_IMAGE) throw new Error("SKETCHES=1 needs BOX_IMAGE, the box image to run");
    // Docker containers reach the machine they run on by this name.
    const vibesUrl = env.BOX_VIBES_URL ?? (env.BOX_RUNNER === "docker" ? `http://host.docker.internal:${env.PORT}` : undefined);
    if (!vibesUrl) throw new Error("BOX_RUNNER=kubernetes needs BOX_VIBES_URL, where boxes reach vibes in the cluster");
    sketches = {
      dir: env.SKETCHES_DIR ?? path.join(path.dirname(path.resolve(env.DATABASE_PATH)), "sketches"),
      runner: env.BOX_RUNNER,
      image: env.BOX_IMAGE,
      vibesUrl: vibesUrl.replace(/\/+$/, ""),
      namespace: env.BOX_NAMESPACE,
      runtimeClass: env.BOX_RUNTIME_CLASS,
      idleMs: env.BOX_IDLE_MINUTES * 60_000,
    };
  }
  return {
    arclamp: { baseUrl: env.ARCLAMP_BASE_URL.replace(/\/+$/, ""), key: env.ARCLAMP_KEY },
    sessionSecret: env.SESSION_SECRET,
    publicUrls: env.PUBLIC_URL.map((u) => new URL(u)),
    rc,
    devLogin,
    databasePath: env.DATABASE_PATH,
    port: env.PORT,
    production,
    sketches,
  };
}
