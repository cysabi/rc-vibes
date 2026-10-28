// A few sketches in the room, to try the UI's shader display with: each made
// (as vibes' starter sketch, unless it's there already by name), built, and
// put in the room on every light, with a pool for its params. Needs vibes
// running with sketches on (SKETCHES=1; BOX_RUNNER=local does without
// Docker) and dev login (VIBES_DEV_LOGIN=1).
//
//   node --env-file=.env dev/seed-sketches.ts                 "Glow" and "Drift"
//   node --env-file=.env dev/seed-sketches.ts Wave Pulse ...  these, by name

import WebSocket from "ws";

const base = `http://127.0.0.1:${process.env.PORT ?? "8787"}`;
const origin = "http://localhost:5173";
const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["Glow", "Drift"];

interface Sketch {
  id: string;
  name: string;
}
interface Build {
  id: string;
  state: "building" | "built" | "failed";
  error: string | null;
  log?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let res = await fetch(`${base}/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ name: "seed" }) });
  if (!res.ok) throw new Error(`dev login failed (${res.status}): is vibes running with VIBES_DEV_LOGIN=1?`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const headers = { cookie, origin, "content-type": "application/json" };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const status = await api<{ sketches: boolean }>("GET", "/api/status");
  if (!status.sketches) throw new Error("sketches are off: set SKETCHES=1 (and BOX_RUNNER=local without Docker)");
  const lights = (await api<{ lights: { id: number }[] }>("GET", "/api/lights")).lights.map((l) => l.id);

  const have = await api<{ sketches: Sketch[] }>("GET", "/api/sketches");
  const sketches: Sketch[] = [];
  for (const name of names) {
    const found = have.sketches.find((s) => s.name === name);
    sketches.push(found ?? (await api<Sketch>("POST", "/api/sketches", { name })));
    console.log(`${found ? "found" : "made"} ${name}`);
  }

  // Built, each: the build started (or the one there is), then waited for.
  const built: { sketch: Sketch; build: Build }[] = [];
  const builds = await Promise.all(sketches.map((s) => api<Build>("POST", `/api/sketches/${s.id}/builds`, {})));
  for (const [i, sketch] of sketches.entries()) {
    let build = builds[i]!;
    while (build.state === "building") {
      await sleep(3000);
      build = await api<Build>("GET", `/api/sketches/${sketch.id}/builds/${build.id}`);
    }
    if (build.state !== "built") {
      console.error(`${sketch.name} didn't build: ${build.error}\n${(build.log ?? "").slice(-1200)}`);
      continue;
    }
    console.log(`built ${sketch.name}`);
    built.push({ sketch, build });
  }
  if (built.length === 0) return;

  // In the room, bottom up, each on every light.
  const ops = built.map(({ sketch }, i) => [
    `shaders/+seed-${i}`,
    { sketch: sketch.id, branch: "main", home: lights, muted: false, mask: [], pool: crypto.randomUUID() },
  ]);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/scene/ws`, { headers: { cookie, origin } });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", rev: null })));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as { type: string; made?: Record<string, string>; error?: string };
      if (m.type === "state") ws.send(JSON.stringify({ type: "update", id: "seed", note: "Seeded sketches", ops }));
      else if (m.type === "done") {
        for (const [i, { sketch }] of built.entries()) console.log(`in the room: ${sketch.name} (${m.made?.[`+seed-${i}`]})`);
        ws.close();
        resolve();
      } else if (m.type !== "delta") {
        ws.close();
        reject(new Error(`vibes said ${JSON.stringify(m)}`));
      }
    });
    ws.on("error", reject);
  });
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
