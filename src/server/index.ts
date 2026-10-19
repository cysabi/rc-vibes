import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import http from "node:http";
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

const app = new Hono();
app.onError(handleError);
app.use("*", csrf({ origin: origins }));
app.route("/auth", authRoutes(config));
if (sketches) app.route("/", boxApiRoutes(config, sketches, db, lights));
if (builds) app.route("/", buildApiRoutes(config, builds));
const sketchApi = sketches && boxes && builds ? sketchRoutes(sketches, db, boxes, builds) : null;
app.route("/api", apiRoutes({ config, arclamp, db, relay, origins, lights, sketches: sketchApi }));
if (config.production) {
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
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
// And their WebSockets (Hono's own listener leaves alone what it doesn't route).
server.on("upgrade", (req: http.IncomingMessage, socket, head) => {
  if (proxy?.handles(req)) void proxy.upgrade(req, socket, head);
});

// Browsers hold the light stream and keep-alive connections open
// indefinitely, so close them rather than waiting for them to finish.
function shutdown() {
  relay.stop();
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
