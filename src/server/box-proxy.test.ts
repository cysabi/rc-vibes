import { Hono } from "hono";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authRoutes } from "./auth.ts";
import { createBoxProxy } from "./box-proxy.ts";
import { vscodeToken, type Boxes } from "./boxes.ts";
import { openDb } from "./db.ts";
import { loadConfig } from "./env.ts";

const BOX = "00000000-0000-4000-8000-000000000001";
const STOPPED = "00000000-0000-4000-8000-000000000002";

const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_DEV_LOGIN: "1" });
let upstream: Server;
let proxyServer: Server;
let base: string;
let seen: IncomingHttpHeaders = {};

/** A dev session's cookie, as the browser would send it. */
async function sessionFor(name: string) {
  const res = await new Hono()
    .route("/auth", authRoutes(config))
    .request("/auth/dev-login", { method: "POST", body: JSON.stringify({ name }), headers: { "content-type": "application/json" } });
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

const listen = (server: Server) =>
  new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeAll(async () => {
  // The box: says what it got, and tries to set a cookie of its own.
  upstream = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "set-cookie": "vibes_session=evil; Path=/", "content-type": "text/plain" }).end("VS Code");
  });
  const target = await listen(upstream);
  const db = openDb(":memory:");
  db.addBox({ id: BOX, sketch_id: "s", user_id: "dev:ada", user_name: "Ada", branch: "ada", at: 0 });
  db.addBox({ id: STOPPED, sketch_id: "t", user_id: "dev:ada", user_name: "Ada", branch: "ada", at: 0 });
  const boxes = { target: (id: string) => (id === BOX ? target : null) } as unknown as Boxes;
  const proxy = createBoxProxy(config, db, boxes);
  proxyServer = http.createServer((req, res) => void proxy.http(req, res));
  base = await listen(proxyServer);
});

afterAll(() => {
  upstream.close();
  proxyServer.close();
});

describe("the box proxy", () => {
  it("lets a box's owner through, with only its VS Code's token for cookies", async () => {
    const res = await fetch(`${base}/box/${BOX}/?folder=x`, { headers: { cookie: `${await sessionFor("Ada")}; other=1` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("VS Code");
    // vibes' own session never reaches the box.
    expect(seen.cookie).toBe(`vscode-tkn=${vscodeToken(config.sessionSecret, BOX)}`);
    // The box's own cookies never reach the browser: just its token, for its own path.
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(new RegExp(`^vscode-tkn=[^;]+; Path=/box/${BOX}; SameSite=Strict`));
  });

  it("turns away everyone else", async () => {
    expect((await fetch(`${base}/box/${BOX}/`)).status).toBe(401);
    expect((await fetch(`${base}/box/${BOX}/`, { headers: { cookie: await sessionFor("Grace") } })).status).toBe(404);
  });

  it("says when the box isn't running", async () => {
    expect((await fetch(`${base}/box/${STOPPED}/`, { headers: { cookie: await sessionFor("Ada") } })).status).toBe(503);
  });
});
