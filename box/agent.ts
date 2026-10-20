// A box's agent: all a box runs until it's someone's (src/server/boxes.ts
// keeps a pool of them, booted and waiting). It waits, as root, for vibes to
// claim the box for one person's box; then it puts that box's home (from the
// homes every box is given, at /homes) at /home/workspace, takes the rest of
// the homes away, starts Nix's daemon (which can't mount anything), and
// starts their VS Code (box/start.sh) as them: uid 1000, with no privileges
// left. From then on it only waits for VS Code to end, and ends with it.
//
// It answers on VS Code's port, 3000, until it's claimed: GET /claim says it's
// waiting (204), and POST /claim, with the claim token vibes booted it with,
// claims it. Anything else is a 503: there's no VS Code here yet.
//
// A box can be claimed for a job instead (POST /claim with a job): pushing
// someone's changes to main (box/publish.sh), for adding a sketch to the room
// with them. Then it puts their home in place as for VS Code, runs the job as
// them, answers the claim with how it went, and ends.

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

// A job may take this long, at most.
const JOB_TIMEOUT_MS = 2 * 60_000;

const start = process.argv[2];
const publish = process.argv[3];
const token = process.env.VIBES_CLAIM_TOKEN;
delete process.env.VIBES_CLAIM_TOKEN;
if (!start || !token) {
  console.error("usage: VIBES_CLAIM_TOKEN=… node agent.ts <start script> [<publish script>]");
  process.exit(2);
}

// The homes, seen from the machine they're kept on, are no one's to look
// through: vibes reaches one it knows the name of (read-only, to see what's
// changed in it: src/server/changes.ts), and nothing can list them.
try {
  chmodSync(HOMES, 0o711);
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

/**
 * Nix's daemon, for the person's Nix: root in the VM (it runs builds as its
 * own build users), but unable to mount anything, so never able to bring
 * back the homes taken away.
 */
function startNix() {
  const { NIX_REMOTE: _, ...env } = process.env;
  const daemon = spawn("setpriv", ["--bounding-set=-sys_admin", "--inh-caps=-all", "--", "nix-daemon"], { stdio: ["ignore", "inherit", "inherit"], env });
  daemon.on("error", (err) => console.error("couldn't start nix-daemon:", err.message));
  daemon.on("exit", (code) => console.error(`nix-daemon ended (${code})`));
}

const settingsOf = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([k, v]) => SETTING.test(k) && typeof v === "string"));

function startVsCode(env: Record<string, string>) {
  const settings = settingsOf(env);
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

/** A job's script, run as them as VS Code would be, until it ends (or JOB_TIMEOUT_MS): how it ended, its last line out, and the end of all it said. */
function runJob(script: string, env: Record<string, string>): Promise<{ code: number; said: string; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(script, [], { uid: UID, gid: GID, cwd: "/", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...settingsOf(env), HOME } });
    let out = "";
    let output = "";
    child.stdout.on("data", (c: Buffer) => {
      out = (out + c.toString()).slice(-4000);
      output = (output + c.toString()).slice(-16_000);
    });
    child.stderr.on("data", (c: Buffer) => void (output = (output + c.toString()).slice(-16_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), JOB_TIMEOUT_MS);
    const done = (code: number, also = "") => {
      clearTimeout(timer);
      resolve({ code, said: out.trim().split("\n").at(-1) ?? "", output: output + also });
    };
    child.on("error", (err) => done(-1, err.message));
    child.on("close", (code) => done(code ?? -1));
  });
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
      const { box, env, job } = JSON.parse(Buffer.concat(chunks).toString()) as { box: string; env: Record<string, string>; job?: string };
      if (typeof box !== "string" || !BOX.test(box)) throw new Error("that isn't a box");
      if (job !== undefined) {
        if (job !== "publish" || !publish) throw new Error(`this box can't do ${String(job)}`);
        moveIn(box);
        console.log(`claimed to ${job} for box ${box}`);
        void runJob(publish, env ?? {}).then((result) => {
          res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify(result), () => process.exit(0));
        });
        return;
      }
      moveIn(box);
      startNix();
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
