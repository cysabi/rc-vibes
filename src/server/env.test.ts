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

  it("rejects a short session secret", () => {
    expect(() => loadConfig({ ...base, VIBES_DEV_LOGIN: "1", SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});
