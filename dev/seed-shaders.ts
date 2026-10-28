// A handful of shaders in the local arclamp, to try the UI's shader display
// with: a rainbow wave, a warm wash on the couches, blinking old bulbs, one
// that keeps throwing, one muted, and one masked off half the room. Each is
// a plain script put straight into arclamp (as something outside vibes
// would), so vibes shows them as "Shader #n". Needs arclamp running
// (pnpm arclamp) and .env's ARCLAMP_BASE_URL and ARCLAMP_KEY.
//
//   node --env-file=.env dev/seed-shaders.ts            add them
//   node --env-file=.env dev/seed-shaders.ts --clear    take every js shader out first
//   node --env-file=.env dev/seed-shaders.ts --count 1  just the first so many

import { whiteAB } from "../packages/vibes/src/lemtone.ts";

const base = process.env.ARCLAMP_BASE_URL;
const key = process.env.ARCLAMP_KEY;
if (!base || !key) throw new Error("ARCLAMP_BASE_URL and ARCLAMP_KEY are needed (run with --env-file=.env)");

interface Shader {
  id: number;
  type: string;
  position: number;
  state: string;
  muted: boolean;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A script's body as update(), given what it does for each light (`l`, with `t` seconds and `i` its index). */
const script = (prelude: string, perLight: string) => `${prelude}
function update(prev, nowMs, initialMs) {
  var t = initialMs / 1000;
  var out = [];
  var lights = prev.lights;
  for (var i = 0; i < lights.length; i++) {
    var l = lights[i];
    var ch = (function () { ${perLight} })();
    if (ch) out.push({ id: l.id, channels: ch });
  }
  return { lights: out };
}
`;

const [warmA, warmB] = whiteAB(2700);
const [coolA, coolB] = whiteAB(5000);
const isColor = `var color = l.channels && "a" in l.channels;`;

const SEEDS: { what: string; script: string; muted?: boolean; maskHalf?: boolean }[] = [
  {
    what: "a rainbow wave across the room",
    script: script(
      "",
      `${isColor} if (!color || !l.coords) return null;
      var phase = l.coords.mm_x / 9000 - t * 0.25;
      return { a: 0.18 * Math.cos(phase * 6.283), b: 0.18 * Math.sin(phase * 6.283), brightness: 0.35, fidelity: 0.2 };`,
    ),
  },
  {
    what: "a warm wash on the couches",
    script: script(
      `var WARM = [${warmA}, ${warmB}];`,
      `${isColor} var tags = l.tags || [];
      if (!color || tags.indexOf("couches") < 0) return null;
      return { a: WARM[0], b: WARM[1], brightness: 0.4, fidelity: 1 };`,
    ),
  },
  {
    what: "old bulbs blinking",
    script: script(
      "",
      `if (!l.channels || !("on" in l.channels)) return null;
      return { on: Math.floor(t + l.id) % 2 === 0 ? 1 : 0 };`,
    ),
  },
  {
    what: "one that keeps throwing",
    script: `function update(prev, nowMs, initialMs) {\n  throw new Error("the demo shader that always fails: nothing to see here");\n}\n`,
  },
  {
    what: "a cool pulse, muted",
    muted: true,
    script: script(
      `var COOL = [${coolA}, ${coolB}];`,
      `${isColor} if (!color) return null;
      var pulse = 0.5 + 0.5 * Math.sin(t * 2 + i * 0.3);
      return { a: COOL[0], b: COOL[1], brightness: 0.1 + 0.4 * pulse, fidelity: 0.8 };`,
    ),
  },
  {
    what: "a blue tint, masked off half the room",
    maskHalf: true,
    script: script(
      "",
      `${isColor} if (!color) return null;
      var below = l.channels;
      return { a: below.a * 0.5 - 0.04, b: below.b * 0.5 - 0.16, brightness: Math.max(below.brightness, 0.15), fidelity: below.fidelity };`,
    ),
  },
];

async function main() {
  const scene = await call<Shader[]>("GET", "/v1/scene");
  const js = scene.filter((s) => s.type === "js");
  if (process.argv.includes("--clear")) {
    for (const s of js) await call("DELETE", `/v1/shader/${s.id}`);
    console.log(`took ${js.length} shader${js.length === 1 ? "" : "s"} out`);
  } else if (js.length > 0) {
    console.log(`${js.length} js shader${js.length === 1 ? " is" : "s are"} already in (pass --clear to start over)`);
  }
  const at = process.argv.indexOf("--count");
  const count = at >= 0 ? Number(process.argv[at + 1]) : SEEDS.length;
  const lights = await call<{ lights: { id: number }[] }>("GET", "/v1/lights");
  const ids = lights.lights.map((l) => l.id).sort((a, b) => a - b);
  const half = ids.slice(0, Math.ceil(ids.length / 2));
  for (const seed of SEEDS.slice(0, count)) {
    const made = await call<Shader>("POST", "/v1/scene/shader", { type: "js", script: seed.script, position: "bottom" });
    if (seed.muted) await call("POST", `/v1/shader/${made.id}/muted`, { muted: true });
    if (seed.maskHalf) await call("POST", `/v1/shader/${made.id}/mask`, { mask: half });
    console.log(`#${made.id}: ${seed.what}${seed.muted ? " (muted)" : ""}${seed.maskHalf ? ` (masked off ${half.length} lights)` : ""}`);
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
