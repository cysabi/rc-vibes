import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A page at vibes' other address; the API at its main one.
const PAGE = "https://vibes.recurse.com";
const MAIN = "https://vibes.hall.ly";

/** Requests as this page makes them, answered as vibes would; the main address reachable from here or not (turned away by CORS, say). Each request made, by where it went. */
function serve(mainReachable: boolean): string[] {
  const asked: string[] = [];
  vi.stubGlobal("location", { origin: PAGE });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      if (url.startsWith("/auth/options")) return Response.json({ api: MAIN });
      if (url === "/auth/token") return Response.json({ token: "t", exp: Date.now() + 600_000 });
      if (url.startsWith(MAIN) && !mainReachable) throw new TypeError("Failed to fetch");
      return Response.json({});
    }),
  );
  return asked;
}

// Where the API is is asked once a page: each test, a page of its own.
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("the API, from vibes' other address", () => {
  it("is at the main address, when that can be reached from here", async () => {
    const asked = serve(true);
    const { apiFetch, apiSocket } = await import("./api.ts");
    await apiFetch("/api/status");
    expect(asked.at(-1)).toBe(`${MAIN}/api/status`);
    expect(await apiSocket("/api/scene/ws")).toEqual({ url: "wss://vibes.hall.ly/api/scene/ws", hello: JSON.stringify({ type: "auth", token: "t" }) });
  });

  it("is at this page's own, sockets too, when the main one can't be", async () => {
    const asked = serve(false);
    const { apiFetch, apiSocket } = await import("./api.ts");
    await apiFetch("/api/status");
    expect(asked.at(-1)).toBe("/api/status");
    expect(await apiSocket("/api/scene/ws")).toEqual({ url: "wss://vibes.recurse.com/api/scene/ws", hello: null });
  });
});
