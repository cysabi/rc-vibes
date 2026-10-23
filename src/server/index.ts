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
import { dockerRunner } from "./box-docker.ts";
import { createBoxProxy } from "./box-proxy.ts";
import { createBoxes, type BoxRunner } from "./boxes.ts";
import { buildApiRoutes, createBuilds, type BuildRunner } from "./builds.ts";
import { openDb } from "./db.ts";
import { loadConfig } from "./env.ts";
import { followEvents } from "./event-stream.ts";
import { createHealthWatch } from "./health.ts";
import { createInstances, type Instances } from "./instances.ts";
import { createParamsSender } from "./params.ts";
import { createSceneFeed } from "./scene-feed.ts";
import { boxApiRoutes, sketchRoutes } from "./sketches.ts";
import { createStreamRelay } from "./stream.ts";

const config = loadConfig();
const arclamp = createArclamp(config.arclamp.baseUrl, config.arclamp.key);
const db = openDb(config.databasePath);
const relay = createStreamRelay(arclamp.streamUrl(), arclamp.key);
const lights = createLights(arclamp, db);

const origins = config.publicUrls.map((u) => u.origin);
if (!config.production) origins.push("http://localhost:5173", "http://127.0.0.1:5173");

// Sketches, the boxes they're edited in, and their builds, while they're on.
const sketches = config.sketches;
let runner: (BoxRunner & BuildRunner) | null = null;
if (sketches) runner = sketches.runner === "docker" ? dockerRunner(sketches) : (await import("./box-kube.ts")).kubernetesRunner(sketches);
const boxes = sketches && runner ? createBoxes(config, sketches, db, runner) : null;
const builds = sketches && runner ? createBuilds(config, sketches, db, runner) : null;
const proxy = boxes ? createBoxProxy(config, db, boxes) : null;

// The scene as browsers get it, followed as it changes, its footprints from
// the light stream; arclamp's health, likewise; and sketches put in the room
// (instances).
let instances: Instances | null = null;
// Instances' params, to their shaders over udp, where the scene says each takes it.
const params = createParamsSender({ db, arclampHost: new URL(config.arclamp.baseUrl).hostname });
const feed = createSceneFeed({
  config,
  db,
  arclamp,
  follow: (on) => followEvents(arclamp.url("/v1/scene/events"), arclamp.key, on),
  layout: () => lights.arclampLights(),
  instances: () => instances,
  onPorts: (id, ports) => params.learn(id, ports),
});
relay.subscribe((frame) => feed.touched(frame));
// What vibes changes in the scene, it changes through this, so the feed shows it at once.
const noted = feed.noting(arclamp);
const health = createHealthWatch((on) => followEvents(arclamp.url("/v1/scene/health/events"), arclamp.key, on));
if (builds) {
  const lightIds = async () => (await lights.arclampLights()).lights.map((l) => l.id);
  instances = createInstances({ config, db, arclamp: noted, builds, lightIds, changed: () => feed.poke(), sendParams: (id) => params.send(id) });
}

const app = new Hono();
app.onError(handleError);
app.use("*", csrf({ origin: origins }));
app.route("/auth", authRoutes(config));
if (sketches) app.route("/", boxApiRoutes(config, sketches, db, lights));
if (builds) app.route("/", buildApiRoutes(config, builds));
const sketchApi = sketches && boxes && builds ? sketchRoutes(sketches, db, boxes, builds) : null;
app.route("/api", apiRoutes({ config, arclamp: noted, db, relay, origins, lights, feed, sketches: sketchApi, instances, health }));
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
  params.stop();
  health.stop();
  boxes?.stop();
  builds?.stop();
  for (const ws of sockets.clients) ws.terminate();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  if ("closeAllConnections" in server) server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
