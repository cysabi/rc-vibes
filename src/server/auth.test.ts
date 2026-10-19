import { afterEach, describe, expect, it, vi } from "vitest";
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
const auth = authRoutes(config);

async function login(origin?: string) {
  const res = await auth.request(origin ? `/login?origin=${encodeURIComponent(origin)}` : "/login");
  const location = new URL(res.headers.get("location")!);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { redirectUri: location.searchParams.get("redirect_uri"), state: location.searchParams.get("state"), cookie };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RC login", () => {
  it("returns to the address the login started from", async () => {
    expect((await login("https://vibes.recurse.com")).redirectUri).toBe("https://vibes.recurse.com/auth/callback");
    expect((await login("https://vibes.hall.ly")).redirectUri).toBe("https://vibes.hall.ly/auth/callback");
  });

  it("uses the main address for any other", async () => {
    expect((await login("https://evil.example")).redirectUri).toBe("https://vibes.hall.ly/auth/callback");
    expect((await login()).redirectUri).toBe("https://vibes.hall.ly/auth/callback");
  });

  it("trades the code with the same callback, and starts a session", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/oauth/token")) {
        expect(new URLSearchParams(String(init?.body)).get("redirect_uri")).toBe(
          "https://vibes.recurse.com/auth/callback",
        );
        return Response.json({ access_token: "token" });
      }
      return Response.json({ id: 7, name: "Ada" });
    });
    vi.stubGlobal("fetch", fetch);

    const { state, cookie } = await login("https://vibes.recurse.com");
    const res = await auth.request(`/callback?code=c&state=${state}`, { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/vibes_session=/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a callback whose state doesn't match", async () => {
    const { cookie } = await login("https://vibes.recurse.com");
    const res = await auth.request("/callback?code=c&state=other", { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
