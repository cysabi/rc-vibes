import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { WebSocketServer } from "ws";
import { apiRoutes, handleError } from "./api.ts";
import { createArclamp } from "./arclamp.ts";
import { authRoutes } from "./auth.ts";
import { openDb } from "./db.ts";
import { loadConfig } from "./env.ts";
import { createStreamRelay } from "./stream.ts";

const config = loadConfig();
const arclamp = createArclamp(config.arclamp.baseUrl, config.arclamp.key);
const db = openDb(config.databasePath);
const relay = createStreamRelay(arclamp.streamUrl(), arclamp.key);

const origins = [config.publicUrl.origin];
if (!config.production) origins.push("http://localhost:5173", "http://127.0.0.1:5173");

const app = new Hono();
app.onError(handleError);
app.use("*", csrf({ origin: origins }));
app.route("/auth", authRoutes(config));
app.route("/api", apiRoutes({ config, arclamp, db, relay, origins }));
if (config.production) {
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
}

// With dev login on, anyone who can reach vibes can log in as anyone, so only
// listen on this machine.
const hostname = config.devLogin ? "127.0.0.1" : "0.0.0.0";
const sockets = new WebSocketServer({ noServer: true });
const server = serve(
  { fetch: app.fetch, port: config.port, hostname, websocket: { server: sockets } },
  (info) => {
    console.log(`vibes on http://${info.address}:${info.port} → arclamp at ${config.arclamp.baseUrl}`);
    if (config.devLogin) console.warn("dev login is ON: anyone can log in as any name");
  },
);

// Browsers hold the light stream and keep-alive connections open
// indefinitely, so close them rather than waiting for them to finish.
function shutdown() {
  relay.stop();
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
