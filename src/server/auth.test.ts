import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRoutes } from "./auth.ts";
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
