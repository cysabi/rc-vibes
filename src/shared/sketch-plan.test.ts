import { describe, expect, it } from "vitest";
import { planSketch } from "./sketch-plan.ts";

const files = (fs: Record<string, string>) => ({ exists: (f: string) => f in fs, read: (f: string) => fs[f] ?? null });

describe("how a sketch is built", () => {
  it("is by Vite from its entry, by default, with HMR in the editor", () => {
    expect(planSketch(files({ "main.ts": "" }))).toEqual({
      build: { kind: "vite", entry: "main.ts" },
      dev: { kind: "vite", entry: "main.ts" },
      install: null,
    });
    expect(planSketch(files({ "src/index.ts": "", "index.js": "" }))).toMatchObject({ build: { entry: "src/index.ts" } });
  });

  it("installs its packages first, with the package manager its lockfile says", () => {
    expect(planSketch(files({ "main.ts": "", "package.json": "{}" }))).toMatchObject({ install: "pnpm install" });
    expect(planSketch(files({ "main.ts": "", "package.json": "{}", "pnpm-lock.yaml": "" }))).toMatchObject({ install: "pnpm install --frozen-lockfile" });
    expect(planSketch(files({ "main.ts": "", "package.json": "{}", "package-lock.json": "" }))).toMatchObject({ install: "npm ci" });
    expect(planSketch(files({ "main.ts": "", "package.json": "{}", "yarn.lock": "" }))).toHaveProperty("error");
  });

  it("is by its package.json build script, if it has one, run again on each change in the editor", () => {
    const pkg = JSON.stringify({ scripts: { build: "node build.mjs" } });
    expect(planSketch(files({ "main.ts": "", "package.json": pkg, "package-lock.json": "" }))).toEqual({
      build: { kind: "command", command: "npm run build", output: "dist/sketch.js", from: "package.json" },
      dev: { kind: "command", command: "npm run build", output: "dist/sketch.js", watch: false },
      install: "npm ci",
    });
  });

  it("is by sketch.json's commands above all, each loop its own", () => {
    const json = JSON.stringify({
      build: { command: "nix build .#sketch", output: "result/sketch.js" },
      dev: { command: "cargo watch -s ./build.sh", output: "dist/sketch.js", watch: true },
    });
    expect(planSketch(files({ "main.ts": "", "sketch.json": json }))).toEqual({
      build: { kind: "command", command: "nix build .#sketch", output: "result/sketch.js", from: "sketch.json" },
      dev: { kind: "command", command: "cargo watch -s ./build.sh", output: "dist/sketch.js", watch: true },
      install: null,
    });
    // Just a build: the editor runs that.
    const only = JSON.stringify({ build: { command: "make", output: "out.js" } });
    expect(planSketch(files({ "sketch.json": only }))).toMatchObject({ dev: { kind: "command", command: "make", output: "out.js", watch: false } });
  });

  it("says why it can't be", () => {
    expect(planSketch(files({}))).toHaveProperty("error", expect.stringContaining("nothing to build"));
    expect(planSketch(files({ "sketch.json": "{" }))).toHaveProperty("error", expect.stringContaining("isn't JSON"));
    expect(planSketch(files({ "sketch.json": JSON.stringify({ build: { command: "make" } }) }))).toHaveProperty("error");
  });
});
