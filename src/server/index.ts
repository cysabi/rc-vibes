import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { apiRoutes, createLights, handleError } from "./api.ts";
import { createArclamp } from "./arclamp.ts";
import { authRoutes } from "./auth.ts";
import { createBaseColor, type BaseColor } from "./base-color.ts";
import { loadDefaultSketchScript } from "./base-color-script.ts";
import { createDefaultSketches, type DefaultSketches } from "./default-sketches.ts";
import { dockerRunner } from "./box-docker.ts";
import { localRunner } from "./box-local.ts";
import { createBoxProxy } from "./box-proxy.ts";
import { createBoxes, type BoxRunner } from "./boxes.ts";
import { buildApiRoutes, createBuilds, type BuildRunner } from "./builds.ts";
import { openDb } from "./db.ts";
import { loadConfig } from "./env.ts";
import { followEvents } from "./event-stream.ts";
import { createHealthWatch } from "./health.ts";
import { createInstances, type Instances } from "./instances.ts";
import { createLayout } from "./layout.ts";
import { createLiveState } from "./live.ts";
import { createParamLinks } from "./params.ts";
import { createPools } from "./pools.ts";
import { createSceneFeed } from "./scene-feed.ts";
import { boxApiRoutes, sketchRoutes } from "./sketches.ts";
import { createStreamRelay } from "./stream.ts";

// arclamp's lights change only when its lights.json does: they're looked at again this often.
const LAYOUT_REFRESH_MS = 60_000;

const config = loadConfig();
const arclamp = createArclamp(config.arclamp.baseUrl, config.arclamp.key);
// Its checkpoints and history on a thread of their own: a slow disk holds nothing up.
const db = openDb(config.databasePath, { background: true });
const relay = createStreamRelay(arclamp.streamUrl(), arclamp.key);
const lights = createLights(arclamp, db);

const origins = config.publicUrls.map((u) => u.origin);
if (!config.production) origins.push("http://localhost:5173", "http://127.0.0.1:5173");

// Sketches, the boxes they're edited in, and their builds, while they're on.
const sketches = config.sketches;
let runner: (BoxRunner & BuildRunner) | null = null;
if (sketches) {
  runner =
    sketches.runner === "docker" ? dockerRunner(sketches) : sketches.runner === "local" ? localRunner() : (await import("./box-kube.ts")).kubernetesRunner(sketches);
}
const boxes = sketches && runner ? createBoxes(config, sketches, db, runner) : null;
const builds = sketches && runner ? createBuilds(config, sketches, db, runner) : null;
const proxy = boxes ? createBoxProxy(config, db, boxes) : null;

// The live state (shared/live.ts), as every page has it: the scene, the
// layout and the pools, each changed here, and every change sent on.
const live = createLiveState();
// Params, in pools: as the selection's panel has the lights (vibes' edits and all), so a param's for the same lights there and here.
const pools = createPools({ db, publish: live.publish, lights: async () => (await lights.currentLights()).lights });
live.replace([["pools", pools.tree()]]);
// The layout, made again whenever it's changed, and now and then for arclamp's own changes.
const showLayout = async () => {
  try {
    live.layout(await lights.currentLights());
  } catch {
    // arclamp's away: next time.
  }
};
void showLayout();
const layoutTimer = setInterval(() => void showLayout(), LAYOUT_REFRESH_MS);
layoutTimer.unref();
const layout = createLayout({ db, arclampLights: lights.arclampLights, currentLights: lights.currentLights, changed: showLayout });

// The scene, followed as it changes, its footprints from the light stream;
// arclamp's health, likewise; and sketches put in the room (instances),
// The base Tone always among them, at the bottom (base-color.ts).
let instances: Instances | null = null;
let baseColor: BaseColor | null = null;
// vibes' own sketches in the library (default-sketches.ts): their builds, made as vibes starts.
let defaults: DefaultSketches | null = null;
// Pools' streams: each shader linked once (an eval), then a stream from it, taking each change.
// Only where shaders can reach vibes (VIBES_SHADER_URL; env.ts).
const params = builds && config.shaderUrl ? createParamLinks({ pools, arclamp, secret: config.sessionSecret, url: `${config.shaderUrl}/shader-api/params` }) : null;
const feed = createSceneFeed({
  config,
  db,
  arclamp,
  follow: (on) => followEvents(arclamp.url("/v1/scene/events"), arclamp.key, on),
  layout: () => lights.arclampLights(),
  instances: () => instances,
  onShaders: (shaders) => params?.scene(shaders),
  onScene: (shaders) => baseColor?.scene(shaders),
});
feed.subscribe((scene) => live.scene(scene));
relay.subscribe((frame) => feed.touched(frame));
// What vibes changes in the scene, it changes through this, so the feed shows it at once.
const noted = feed.noting(arclamp);
const health = createHealthWatch((on) => followEvents(arclamp.url("/v1/scene/health/events"), arclamp.key, on));
if (builds) {
  const lightIds = async () => (await lights.arclampLights()).lights.map((l) => l.id);
  instances = createInstances({
    config,
    db,
    arclamp: noted,
    builds,
    lightIds,
    changed: () => feed.poke(),
    pools,
    gone: (pool) => params?.gone(pool),
    wentIn: (id, d) => baseColor?.wentIn(id, d),
  });
  if (config.signingKey) {
    defaults = createDefaultSketches({ signingKey: config.signingKey, db, script: (s) => loadDefaultSketchScript(s, config.production) });
    baseColor = createBaseColor({
      db,
      defaults,
      instances,
      pools,
      arclamp: noted,
      linked: params ? (pool) => params.linked(pool) : null,
    });
    const made = defaults;
    void made.start().then(() => baseColor?.start());
  }
}

const app = new Hono();
app.onError(handleError);
app.use("*", csrf({ origin: origins }));
app.route("/auth", authRoutes(config));
if (sketches) app.route("/", boxApiRoutes(config, sketches, db, lights, pools, params));
if (builds) app.route("/", buildApiRoutes(config, builds));
if (params) app.route("/", params.routes());
const sketchApi = sketches && boxes && builds ? sketchRoutes(sketches, db, boxes, builds, defaults) : null;
app.route("/api", apiRoutes({ config, arclamp: noted, db, relay, origins, lights, feed, live, pools, layout, sketches: sketchApi, instances, health }));
if (config.production) {
  // The built files' dates are Nix's (1970), which browsers take to mean the
  // page is fresh for years: a cached page then loads without the network
  // (after a deploy, naming scripts that are gone; on a device booting before
  // its Wi-Fi is up, never noticing it's offline). So the page is checked
  // every time; Vite's assets are named by their contents, so they never change.
  const caching = (path: string, c: Context) => {
    c.header("Cache-Control", /(^|\/)assets\//.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
  };
  app.use("/*", serveStatic({ root: "./dist/web", onFound: caching }));
  app.get("*", serveStatic({ path: "./dist/web/index.html", onFound: caching }));
}

// With dev login on, anyone who can reach vibes can log in as anyone, so only
// listen on this machine.
const hostname = config.devLogin ? "127.0.0.1" : "0.0.0.0";
const sockets = new WebSocketServer({ noServer: true });
const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname,
    websocket: { server: sockets },
    // Boxes' requests go straight through, past Hono.
    createServer: ((options: http.ServerOptions, listener: http.RequestListener) =>
      http.createServer(options, (req, res) => (proxy?.handles(req) ? void proxy.http(req, res) : listener(req, res)))) as typeof http.createServer,
  },
  (info) => {
    console.log(`vibes on http://${info.address}:${info.port} → arclamp at ${config.arclamp.baseUrl}`);
    if (config.devLogin) console.warn("dev login is ON: anyone can log in as any name");
    if (sketches) console.log(`sketches on: repos in ${sketches.dir}, boxes on ${sketches.runner} from ${sketches.image}`);
  },
);
// And their WebSockets. One listener for every upgrade: Hono's answers one it
// refuses (a foreign origin, no session) only while it's the only listener,
// leaving it to any other otherwise, which would leave it hanging.
const [hono] = server.listeners("upgrade") as ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)[];
server.removeAllListeners("upgrade");
server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  if (proxy?.handles(req)) void proxy.upgrade(req, socket, head);
  else hono?.call(server, req, socket, head);
});

// Browsers hold the light stream and keep-alive connections open
// indefinitely, so close them rather than waiting for them to finish.
function shutdown() {
  relay.stop();
  feed.stop();
  params?.stop();
  pools.stop();
  clearInterval(layoutTimer);
  health.stop();
  boxes?.stop();
  builds?.stop();
  for (const ws of sockets.clients) ws.terminate();
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
  if ("closeAllConnections" in server) server.closeAllConnections();
  // Long enough for the history's thread to keep what it's been handed (db-background.ts).
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
