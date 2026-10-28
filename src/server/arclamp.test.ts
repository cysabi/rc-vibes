import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArclamp } from "./arclamp.ts";

// A stand-in for arclamp: answers each request as `answer` says, keeping what it was sent.
let server: Server;
let base: string;
let seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[];
let answer: { status: number; body?: unknown };

beforeEach(async () => {
  seen = [];
  answer = { status: 204 };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((done) => server.close(() => done())));

const AT = 1_800_000_000_123.4;

describe("changes put off", () => {
  it("sends a mute with its time, its own id and what it takes the place of, and says the frame it goes in with", async () => {
    answer = { status: 202, body: { id: 7, scheduled_at: "2027-01-15T08:00:00.123Z", frame_at: "2027-01-15T08:00:00.130000000Z", schedule_id: "b" } };
    const frame = await createArclamp(base, "k").setMutedAt(3, true, { at: AT, id: "b", emplace: "a" });
    expect(frame).toBe(Date.parse("2027-01-15T08:00:00.130Z"));
    const [req] = seen;
    expect([req!.method, req!.url, JSON.parse(req!.body)]).toEqual(["POST", "/v1/shader/3/muted", { muted: true }]);
    expect(req!.headers["x-arclamp-schedule"]).toBe("1800000000123");
    expect(req!.headers["x-arclamp-schedule-id"]).toBe("b");
    expect(req!.headers["x-arclamp-schedule-emplace"]).toBe("a");
  });

  it("says none when its time had passed and it went in at once, and sends no names it wasn't given", async () => {
    expect(await createArclamp(base, "k").setMutedAt(3, false, { at: AT })).toBeNull();
    expect(seen[0]!.headers["x-arclamp-schedule-id"]).toBeUndefined();
    expect(seen[0]!.headers["x-arclamp-schedule-emplace"]).toBeUndefined();
  });

  it("puts off a statement, or says it ran at once", async () => {
    const arclamp = createArclamp(base, "k");
    answer = { status: 202, body: { id: 8, scheduled_at: "2027-01-15T08:00:00.123Z", schedule_id: "c" } };
    expect(await arclamp.evalAt(4, "x = 1", { at: AT, id: "c" })).toBe(true);
    expect([seen[0]!.url, JSON.parse(seen[0]!.body), seen[0]!.headers["x-arclamp-schedule-id"]]).toEqual(["/v1/shader/4/eval", { code: "x = 1" }, "c"]);
    answer = { status: 200, body: { ok: true, result: "1" } };
    expect(await arclamp.evalAt(4, "x = 1", { at: AT })).toBe(false);
  });

  it("passes on a refusal: one superseded, as any other", async () => {
    answer = { status: 409, body: { error: "a request has emplaced this one's X-Arclamp-Schedule-Id", code: "superseded" } };
    await expect(createArclamp(base, "k").setMutedAt(3, true, { at: AT, id: "a" })).rejects.toMatchObject({ status: 409, code: "superseded" });
  });
});
