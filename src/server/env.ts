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
});

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
  return {
    arclamp: { baseUrl: env.ARCLAMP_BASE_URL.replace(/\/+$/, ""), key: env.ARCLAMP_KEY },
    sessionSecret: env.SESSION_SECRET,
    publicUrls: env.PUBLIC_URL.map((u) => new URL(u)),
    rc,
    devLogin,
    databasePath: env.DATABASE_PATH,
    port: env.PORT,
    production,
  };
}
