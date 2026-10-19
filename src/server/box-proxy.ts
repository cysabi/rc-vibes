// vibes' way through to boxes: /box/<id>/… goes to that box's VS Code, for its
// owner only, as HTTP and as WebSockets (VS Code talks over one). Handled
// below Hono, so bodies and sockets pass straight through.
//
// A box never sees vibes' cookies: what it gets in their place is the
// connection token its VS Code wants, which only this adds. And nothing a box
// sets as a cookie reaches the browser; the one cookie its page needs (that
// same token) this sets itself.

import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { sessionFromCookies } from "./auth.ts";
import { vscodeToken, type Boxes } from "./boxes.ts";
import type { Db } from "./db.ts";
import type { Config } from "./env.ts";

const BOX = /^\/box\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/;
// Not passed along: hop-by-hop headers, and the browser's cookies.
const DROP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie"]);

type Allowed = { id: string; target: URL };
type Refused = { status: number; message: string };

export function createBoxProxy(config: Config, db: Db, boxes: Boxes) {
  async function authorize(req: IncomingMessage): Promise<Allowed | Refused> {
    const id = BOX.exec(req.url ?? "")?.[1];
    if (!id) return { status: 404, message: "no such box" };
    const user = await sessionFromCookies(req.headers.cookie, config);
    if (!user) return { status: 401, message: "log in first" };
    const box = db.box(id);
    // Someone else's box is as good as no box.
    if (!box || box.user_id !== user.id) return { status: 404, message: "no such box" };
    const target = boxes.target(id);
    if (!target) return { status: 503, message: "This box isn't running. Open its sketch again to start it." };
    return { id, target: new URL(target) };
  }

  function headersFor(req: IncomingMessage, id: string): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROP.has(name) && value !== undefined) out[name] = value;
    out.cookie = `vscode-tkn=${vscodeToken(config.sessionSecret, id)}`;
    return out;
  }

  return {
    handles: (req: IncomingMessage) => BOX.test(req.url ?? ""),

    async http(req: IncomingMessage, res: ServerResponse) {
      const a = await authorize(req);
      if ("status" in a) {
        res.writeHead(a.status, { "content-type": "text/plain; charset=utf-8" }).end(a.message);
        return;
      }
      boxes.touch(a.id);
      const up = http.request(
        { host: a.target.hostname, port: a.target.port, method: req.method, path: req.url, headers: headersFor(req, a.id) },
        (upRes) => {
          const headers = { ...upRes.headers };
          for (const name of ["set-cookie", "connection", "keep-alive", "transfer-encoding"]) delete headers[name];
          // VS Code's page reads its connection token from this cookie, for
          // its WebSocket's handshake. It's set for the box's own path, so
          // two boxes' tokens never mix, and only the box's owner gets here.
          const secure = config.production ? "; Secure" : "";
          headers["set-cookie"] = [`vscode-tkn=${vscodeToken(config.sessionSecret, a.id)}; Path=/box/${a.id}; SameSite=Strict${secure}`];
          res.writeHead(upRes.statusCode ?? 502, headers);
          upRes.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("The box didn't answer.");
        else res.destroy();
      });
      req.pipe(up);
    },

    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const a = await authorize(req);
      if ("status" in a) {
        socket.end(`HTTP/1.1 ${a.status} ${http.STATUS_CODES[a.status]}\r\nConnection: close\r\n\r\n`);
        return;
      }
      const headers = { ...headersFor(req, a.id), connection: "Upgrade", upgrade: req.headers.upgrade };
      const up = http.request({ host: a.target.hostname, port: a.target.port, method: req.method, path: req.url, headers });
      up.on("upgrade", (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          if (upRes.rawHeaders[i]!.toLowerCase() !== "set-cookie") lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) upSocket.write(head);
        boxes.socketOpened(a.id);
        let open = true;
        const close = () => {
          if (!open) return;
          open = false;
          boxes.socketClosed(a.id);
          socket.destroy();
          upSocket.destroy();
        };
        upSocket.pipe(socket).pipe(upSocket);
        upSocket.on("close", close).on("error", close);
        socket.on("close", close).on("error", close);
      });
      // The box answered, but not with an upgrade.
      up.on("response", (upRes) => {
        socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\nConnection: close\r\n\r\n`);
        upRes.resume();
      });
      up.on("error", () => socket.destroy());
      up.end();
    },
  };
}
