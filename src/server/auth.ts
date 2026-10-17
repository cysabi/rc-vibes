// Login: Recurse Center OAuth (authorization code flow) in production, or a
// pick-your-name dev login when VIBES_DEV_LOGIN=1. Sessions are signed
// cookies holding the user's id and name; nothing is stored server-side.

import { randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import type { LoginOptions, Me } from "../shared/vibes.ts";
import type { Config } from "./env.ts";

const SESSION_COOKIE = "vibes_session";
const STATE_COOKIE = "vibes_oauth_state";
const SESSION_DAYS = 30;

const RC_AUTHORIZE = "https://www.recurse.com/oauth/authorize";
const RC_TOKEN = "https://www.recurse.com/oauth/token";
const RC_PROFILE = "https://www.recurse.com/api/v1/profiles/me";

export type AuthEnv = { Variables: { user: Me } };

const sessionSchema = z.object({ id: z.string(), name: z.string(), dev: z.boolean(), exp: z.number() });

function cookieOptions(config: Config, maxAgeSeconds: number) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: config.publicUrl.protocol === "https:",
    maxAge: maxAgeSeconds,
  };
}

async function startSession(c: Context, config: Config, user: Me) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const value = JSON.stringify({ ...user, exp: Date.now() + maxAge * 1000 });
  await setSignedCookie(c, SESSION_COOKIE, value, config.sessionSecret, cookieOptions(config, maxAge));
}

export async function readSession(c: Context, config: Config): Promise<Me | null> {
  const raw = await getSignedCookie(c, config.sessionSecret, SESSION_COOKIE);
  if (!raw) return null;
  let parsed;
  try {
    parsed = sessionSchema.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed.success || parsed.data.exp < Date.now()) return null;
  // A dev session must not outlive turning dev login off.
  if (parsed.data.dev && !config.devLogin) return null;
  const { id, name, dev } = parsed.data;
  return { id, name, dev };
}

export function requireUser(config: Config): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = await readSession(c, config);
    if (!user) return c.json({ error: "log in first", code: "unauthenticated" }, 401);
    c.set("user", user);
    await next();
  };
}

export function authRoutes(config: Config) {
  const auth = new Hono();
  const callbackUrl = new URL("/auth/callback", config.publicUrl).toString();

  auth.get("/options", (c) => c.json<LoginOptions>({ rc: config.rc !== null, dev: config.devLogin }));

  auth.get("/login", async (c) => {
    if (!config.rc) return c.redirect("/");
    const state = randomBytes(16).toString("hex");
    await setSignedCookie(c, STATE_COOKIE, state, config.sessionSecret, cookieOptions(config, 600));
    const url = new URL(RC_AUTHORIZE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.rc.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  auth.get("/callback", async (c) => {
    if (!config.rc) return c.redirect("/");
    const expected = await getSignedCookie(c, config.sessionSecret, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const code = c.req.query("code");
    if (!expected || !code || c.req.query("state") !== expected) {
      return c.text("Login failed: the request didn't match. Try logging in again.", 400);
    }

    const tokenRes = await fetch(RC_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: config.rc.clientId,
        client_secret: config.rc.clientSecret,
      }),
    });
    if (!tokenRes.ok) return c.text(`Login failed: Recurse Center returned ${tokenRes.status}.`, 502);
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return c.text("Login failed: no access token from Recurse Center.", 502);

    const profileRes = await fetch(RC_PROFILE, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!profileRes.ok) return c.text(`Login failed: couldn't read your RC profile (${profileRes.status}).`, 502);
    const profile = (await profileRes.json()) as { id: number; name: string };

    await startSession(c, config, { id: `rc:${profile.id}`, name: profile.name, dev: false });
    return c.redirect("/");
  });

  auth.post("/dev-login", async (c) => {
    if (!config.devLogin) return c.json({ error: "dev login is off", code: "not_found" }, 404);
    const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "name required", code: "bad_body" }, 400);
    const name = body.data.name;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "anon";
    const user: Me = { id: `dev:${slug}`, name, dev: true };
    await startSession(c, config, user);
    return c.json(user);
  });

  auth.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  return auth;
}
