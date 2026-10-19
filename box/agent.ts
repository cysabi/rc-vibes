// A box's agent: all a box runs until it's someone's (src/server/boxes.ts
// keeps a pool of them, booted and waiting). It waits, as root, for vibes to
// claim the box for one person's box; then it puts that box's home (from the
// homes every box is given, at /homes) at /home/workspace, takes the rest of
// the homes away, and starts their VS Code (box/start.sh) as them: uid 1000,
// with no privileges left. From then on it only waits for VS Code to end, and
// ends with it.
//
// It answers on VS Code's port, 3000, until it's claimed: GET /claim says it's
// waiting (204), and POST /claim, with the claim token vibes booted it with,
// claims it. Anything else is a 503: there's no VS Code here yet.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync } from "node:fs";
import http from "node:http";

const HOMES = "/homes";
const HOME = "/home/workspace";
const UID = 1000;
const GID = 1000;
const BOX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only vibes' own settings are passed on to VS Code, never PATH and the like.
const SETTING = /^VIBES_[A-Z_]+$/;

const start = process.argv[2];
const token = process.env.VIBES_CLAIM_TOKEN;
delete process.env.VIBES_CLAIM_TOKEN;
if (!start || !token) {
  console.error("usage: VIBES_CLAIM_TOKEN=… node agent.ts <start script>");
  process.exit(2);
}

// The homes, seen from the machine they're kept on, are no one's to look through.
try {
  chmodSync(HOMES, 0o700);
} catch (err) {
  console.error("couldn't close up the homes:", (err as Error).message);
}

let claimed = false;
let vscode: ChildProcess | null = null;

/** Puts box's home in place, and every other home out of reach. */
function moveIn(box: string) {
  const home = `${HOMES}/${box}`;
  if (!existsSync(home)) {
    mkdirSync(home, { mode: 0o700 });
    chownSync(home, UID, GID);
  }
  execFileSync("mount", ["--bind", home, HOME]);
  // Gone from everything that runs from here on; VS Code is never started
  // while they're still there.
  execFileSync("umount", [HOMES]);
}

function startVsCode(env: Record<string, string>) {
  const settings = Object.fromEntries(Object.entries(env).filter(([k, v]) => SETTING.test(k) && typeof v === "string"));
  // Started as them, which leaves it no capabilities, and nothing in the image
  // can give any back. (It goes into its home itself: root here can't, without
  // a capability to read others' folders.)
  vscode = spawn(start!, [], { uid: UID, gid: GID, cwd: "/", stdio: "inherit", env: { ...process.env, ...settings, HOME } });
  vscode.on("error", (err) => {
    console.error("couldn't start VS Code:", err.message);
    process.exit(1);
  });
  vscode.on("exit", (code) => process.exit(code ?? 1));
}

// As PID 1, nothing ends it but what it does itself.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => (vscode ? vscode.kill("SIGTERM") : process.exit(0)));
}

const authorized = (header: string | undefined) => {
  const given = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
};

const server = http.createServer((req, res) => {
  const end = (status: number, message = "") => void res.writeHead(status, { "content-type": "text/plain", connection: "close" }).end(message);
  if (req.url !== "/claim") return end(503, "no VS Code here yet");
  if (req.method === "GET") return end(claimed ? 409 : 204);
  if (req.method !== "POST") return end(405);
  if (!authorized(req.headers.authorization)) return end(401);
  if (claimed) return end(409, "already claimed");
  // Once only, even if this one fails.
  claimed = true;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > 64 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    try {
      const { box, env } = JSON.parse(Buffer.concat(chunks).toString()) as { box: string; env: Record<string, string> };
      if (typeof box !== "string" || !BOX.test(box)) throw new Error("that isn't a box");
      moveIn(box);
      // VS Code answers on this port from here on.
      server.close();
      startVsCode(env ?? {});
      console.log(`claimed for box ${box}`);
      end(204);
    } catch (err) {
      console.error("couldn't be claimed:", (err as Error).message);
      end(500, (err as Error).message);
      // Of no use to anyone now.
      setTimeout(() => process.exit(1), 100);
    }
  });
});
server.listen(3000, "0.0.0.0", () => console.log("waiting to be claimed"));
