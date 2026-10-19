import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.ts";

const base = {
  ARCLAMP_BASE_URL: "http://127.0.0.1:8080/",
  ARCLAMP_KEY: "arclamp-vibes-x",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadConfig", () => {
  it("needs RC OAuth or dev login", () => {
    expect(() => loadConfig(base)).toThrow(/RC_CLIENT_ID/);
    expect(loadConfig({ ...base, RC_CLIENT_ID: "id", RC_CLIENT_SECRET: "secret" }).rc).toEqual({
      clientId: "id",
      clientSecret: "secret",
    });
  });

  it("refuses dev login in production", () => {
    expect(() => loadConfig({ ...base, VIBES_DEV_LOGIN: "1", NODE_ENV: "production" })).toThrow(/refused/);
  });

  it("trims the trailing slash from the arclamp URL", () => {
    expect(loadConfig({ ...base, VIBES_DEV_LOGIN: "1" }).arclamp.baseUrl).toBe("http://127.0.0.1:8080");
  });

  it("reads every public address, main one first", () => {
    const urls = loadConfig({
      ...base,
      VIBES_DEV_LOGIN: "1",
      PUBLIC_URL: "https://vibes.hall.ly, https://vibes.recurse.com",
    }).publicUrls;
    expect(urls.map((u) => u.origin)).toEqual(["https://vibes.hall.ly", "https://vibes.recurse.com"]);
    expect(() => loadConfig({ ...base, VIBES_DEV_LOGIN: "1", PUBLIC_URL: "https://vibes.hall.ly,nope" })).toThrow(
      /PUBLIC_URL/,
    );
  });

  it("rejects a short session secret", () => {
    expect(() => loadConfig({ ...base, VIBES_DEV_LOGIN: "1", SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});
