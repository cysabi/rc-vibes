import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRoutes, readSession } from "./auth.ts";
import { loadConfig } from "./env.ts";

const config = loadConfig({
  ARCLAMP_BASE_URL: "http://127.0.0.1:8080",
  ARCLAMP_KEY: "arclamp-vibes-x",
  SESSION_SECRET: "x".repeat(32),
  RC_CLIENT_ID: "id",
  RC_CLIENT_SECRET: "secret",
  PUBLIC_URL: "https://vibes.hall.ly,https://vibes.recurse.com",
});
const CALLBACK = "https://vibes.hall.ly/auth/callback";

// One address's cookie jar, as a browser keeps it.
class Jar {
  cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = pair!.split(/=(.*)/s);
      if (/Max-Age=0/i.test(line)) this.cookies.delete(name!);
      else this.cookies.set(name!, value!);
    }
    return res;
  }
  get header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

let app: Hono;
const get = async (jar: Jar, url: string) =>
  jar.take(await app.request(new URL(url).pathname + new URL(url).search, { headers: { cookie: jar.header } }));
const location = (res: Response, from = "https://vibes.hall.ly") => new URL(res.headers.get("location")!, from);

beforeEach(() => {
  app = new Hono().route("/auth", authRoutes(config));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/oauth/token")) {
        expect(new URLSearchParams(String(init?.body)).get("redirect_uri")).toBe(CALLBACK);
        return Response.json({ access_token: "token" });
      }
      return Response.json({ id: 7, name: "Ada" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Logs in from `origin`, following redirects as a browser would, with one
// cookie jar per address; RC approves straight away.
async function logIn(origin: string, jars = { hall: new Jar(), recurse: new Jar() }) {
  const jarFor = (url: URL) => (url.host === "vibes.recurse.com" ? jars.recurse : jars.hall);
  let url = new URL(`/auth/login?origin=${encodeURIComponent(origin)}`, origin);
  for (let hops = 0; hops < 6; hops++) {
    if (url.host === "www.recurse.com") {
      expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
      url = new URL(`${CALLBACK}?code=c&state=${url.searchParams.get("state")}`);
      continue;
    }
    const res = await get(jarFor(url), url.toString());
    if (res.status !== 302) return { res, url, jars };
    const next = location(res, url.toString());
    if (next.pathname === "/") return { res, url, jars };
    url = next;
  }
  throw new Error("too many redirects");
}

describe("RC login", () => {
  it("logs in on the main address directly", async () => {
    const { url, jars } = await logIn("https://vibes.hall.ly");
    expect(url.host).toBe("vibes.hall.ly");
    expect(jars.hall.cookies.has("vibes_session")).toBe(true);
  });

  it("logs in on another address through the main one", async () => {
    const { url, jars } = await logIn("https://vibes.recurse.com");
    expect(url.host).toBe("vibes.recurse.com");
    expect(url.pathname).toBe("/auth/handoff");
    expect(jars.recurse.cookies.has("vibes_session")).toBe(true);
    expect(jars.recurse.cookies.has("vibes_handoff")).toBe(false);
  });

  it("treats an unknown address as the main one", async () => {
    const res = await get(new Jar(), "https://vibes.hall.ly/auth/login?origin=https%3A%2F%2Fevil.example");
    expect(location(res).searchParams.get("redirect_uri")).toBe(CALLBACK);
  });

  it("redeems a handoff only once, and only in the browser that asked", async () => {
    // Stop just before the handoff: hop, RC, callback.
    const recurse = new Jar();
    const hall = new Jar();
    const hop = location(await get(recurse, "https://vibes.recurse.com/auth/login?origin=https%3A%2F%2Fvibes.recurse.com"));
    const rc = location(await get(hall, hop.toString()));
    const back = location(await get(hall, `${CALLBACK}?code=c&state=${rc.searchParams.get("state")}`));
    expect(back.host).toBe("vibes.recurse.com");

    // Another browser can't use it, and trying spends it, even for the right one.
    expect((await get(new Jar(), back.toString())).status).toBe(400);
    expect((await get(recurse, back.toString())).status).toBe(400);
  });

  it("refuses a callback whose state doesn't match", async () => {
    const hall = new Jar();
    await get(hall, "https://vibes.hall.ly/auth/login?origin=https%3A%2F%2Fvibes.hall.ly");
    expect((await get(hall, `${CALLBACK}?code=c&state=other`)).status).toBe(400);
  });
});

describe("device keys", () => {
  const KEY = "k".repeat(40);
  const withKeys = (keys: string) =>
    loadConfig({
      ARCLAMP_BASE_URL: "http://127.0.0.1:8080",
      ARCLAMP_KEY: "arclamp-vibes-x",
      SESSION_SECRET: "x".repeat(32),
      RC_CLIENT_ID: "id",
      RC_CLIENT_SECRET: "secret",
      PUBLIC_URL: "https://vibes.hall.ly",
      VIBES_DEVICE_KEYS: keys,
    });
  const appFor = (cfg: ReturnType<typeof loadConfig>) =>
    new Hono()
      .route("/auth", authRoutes(cfg))
      .get("/me", async (c) => c.json(await readSession(c, cfg)));
  const me = async (a: Hono, jar: Jar) => (await a.request("/me", { headers: { cookie: jar.header } })).json();

  it("logs a device in with its key, and out when the key changes or goes", async () => {
    const cfg = withKeys(`portal=${KEY}`);
    const jar = new Jar();
    const res = jar.take(await appFor(cfg).request(`/auth/device?key=${KEY}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await me(appFor(cfg), jar)).toEqual({ id: "device:portal", name: "Portal", dev: false });

    expect(await me(appFor(withKeys(`portal=${"j".repeat(40)}`)), jar)).toBeNull();
    expect(await me(appFor(withKeys("")), jar)).toBeNull();
  });

  it("refuses a key it doesn't know", async () => {
    const a = appFor(withKeys(`portal=${KEY}`));
    expect((await a.request(`/auth/device?key=${"z".repeat(40)}`)).status).toBe(403);
    expect((await a.request("/auth/device")).status).toBe(403);
    expect((await appFor(withKeys("")).request(`/auth/device?key=${KEY}`)).status).toBe(403);
  });

  it("checks the keys it's given", () => {
    expect(withKeys(`portal=${KEY}, kitchen=${"m".repeat(32)}`).deviceKeys.size).toBe(2);
    expect(() => withKeys("portal=short")).toThrow(/32/);
    expect(() => withKeys(`Portal=${KEY}`)).toThrow(/name=key/);
    expect(() => withKeys(KEY)).toThrow(/name=key/);
    expect(() => withKeys(`portal=${KEY},portal=${"m".repeat(32)}`)).toThrow(/twice/);
    expect(() => withKeys(`portal=${KEY},kitchen=${KEY}`)).toThrow(/another/);
  });

  it("ends a device's token with its key, as its session", async () => {
    const cfg = withKeys(`portal=${KEY}`);
    const jar = new Jar();
    jar.take(await appFor(cfg).request(`/auth/device?key=${KEY}`));
    const { token } = (await (await appFor(cfg).request("/auth/token", { headers: { cookie: jar.header } })).json()) as { token: string };
    const asked = async (a: Hono) => (await a.request("/me", { headers: { authorization: `Bearer ${token}` } })).json();
    expect(await asked(appFor(cfg))).toEqual({ id: "device:portal", name: "Portal", dev: false });
    expect(await asked(appFor(withKeys(`portal=${"j".repeat(40)}`)))).toBeNull();
  });
});

describe("the API at the main address, from another", () => {
  const withMe = () => app.get("/me", async (c) => c.json(await readSession(c, config)));
  const options = async (origin: string) => (await (await app.request(`/auth/options?origin=${encodeURIComponent(origin)}`)).json()) as { api: string | null };
  afterEach(() => vi.useRealTimers());

  it("is the main address for a page at another, and the page's own otherwise", async () => {
    expect((await options("https://vibes.recurse.com")).api).toBe("https://vibes.hall.ly");
    expect((await options("https://vibes.hall.ly")).api).toBeNull();
    expect((await options("https://evil.example")).api).toBeNull();
  });

  it("takes a token from the page's own address in place of the cookie, for ten minutes", async () => {
    withMe();
    const { jars } = await logIn("https://vibes.recurse.com");
    const res = await get(jars.recurse, "https://vibes.recurse.com/auth/token");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token, exp } = (await res.json()) as { token: string; exp: number };
    expect(exp - Date.now()).toBeGreaterThan(9 * 60_000);
    const asked = async (t: string) => (await app.request("/me", { headers: { authorization: `Bearer ${t}` } })).json();
    expect(await asked(token)).toEqual({ id: "rc:7", name: "Ada", dev: false });
    // Changed, it's no one's.
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(Buffer.from(payload!, "base64url").toString().replace("Ada", "Eve")).toString("base64url");
    expect(await asked(`${forged}.${sig}`)).toBeNull();
    // Nor once it's run out.
    vi.useFakeTimers({ now: exp + 1 });
    expect(await asked(token)).toBeNull();
  });

  it("gives no token without a session", async () => {
    expect((await get(new Jar(), "https://vibes.recurse.com/auth/token")).status).toBe(401);
  });
});
