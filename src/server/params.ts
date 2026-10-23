// Params in the room: what a build declares (checked here, from what the
// builder read), each instance's values (routes in shaders.ts, kept in
// instances.ts), and getting them to the shader. arclamp has no way to hand
// a running shader anything but its lights, so values go over udp: a sketch
// with params binds a socket (the library does, on its first tick), arclamp
// says which port in the shader's descriptor (ports), and this sends each
// param's whole state there as one packet, when it changes and every second
// regardless, so a lost packet, or a sandbox started over, is behind for a
// second at most.

import dgram from "node:dgram";
import { z } from "zod";
import type { PortInfo } from "../shared/arclamp.ts";
import { MAX_PARAMS, PARAM_NAME, packetOf, type ParamSpec } from "../shared/params.ts";
import type { Db, InstanceRow } from "./db.ts";

const finite = z.number().finite();

/** A param as a builder says the script declares it. */
export const paramSpec: z.ZodType<ParamSpec> = z
  .object({
    name: z.string().regex(PARAM_NAME),
    default: finite,
    min: finite,
    max: finite,
    step: finite.positive(),
    label: z.string().min(1).max(60),
    perLight: z.boolean(),
  })
  .refine((p) => p.min < p.max && p.default >= p.min && p.default <= p.max, "a param's default is within its range, and its min below its max");

/** What a builder sends of a script's params; any that don't read as params are dropped, not the build. */
export function specsOf(raw: unknown): ParamSpec[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const specs: ParamSpec[] = [];
  for (const item of raw.slice(0, MAX_PARAMS)) {
    const parsed = paramSpec.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    specs.push(parsed.data);
  }
  return specs;
}

/** A change to a param's values, as a browser sends it (ParamPatch): a part left out is kept, null unsets it. */
export const paramPatchBody = z.object({
  all: finite.nullable().optional(),
  lights: z
    .record(z.string().regex(/^[1-9][0-9]{0,5}$/), finite.nullable())
    .refine((r) => Object.keys(r).length <= 2000, "at most 2000 lights")
    .nullable()
    .optional(),
});

const RESEND_MS = 1000;

export interface SenderDeps {
  db: Pick<Db, "instance" | "instances" | "build">;
  /** arclamp's host, for a port bound on every address (0.0.0.0). */
  arclampHost: string;
  resendMs?: number;
  /** The socket to send from (a test's, say); udp4 otherwise. */
  socket?: Pick<dgram.Socket, "send" | "close" | "unref" | "on">;
}

/** Where a shader takes udp, as arclamp reports it. */
export type Target = { host: string; port: number };

const anyAddress = (host: string) => host === "" || host === "0.0.0.0" || host === "::" || host === "[::]";

/** The udp port a shader's descriptor says it's bound, if one. */
export function targetOf(ports: PortInfo[] | undefined, arclampHost: string): Target | null {
  const p = ports?.find((p) => p.proto.toLowerCase().startsWith("udp") && Number.isInteger(p.port) && p.port > 0);
  if (!p) return null;
  const host = anyAddress(p.host) ? arclampHost : p.host;
  return { host: host.replace(/^\[(.*)\]$/, "$1"), port: p.port };
}

export function createParamsSender({ db, arclampHost, resendMs = RESEND_MS, socket = dgram.createSocket("udp4") }: SenderDeps) {
  socket.on("error", (err) => console.error("params socket:", err.message));
  socket.unref();
  // Where each shader takes udp, by arclamp's id; and each instance's last seq.
  const targets = new Map<number, Target>();
  const seqs = new Map<string, number>();
  let sent = 0;

  /**
   * A packet's seq: the time, in ms, or one more than the last, so it only
   * ever goes up, across vibes restarting too: a sketch ignores a seq below
   * the last it took for a param, and keeps running through a restart here.
   */
  const nextSeq = (instanceId: string) => {
    const seq = Math.max((seqs.get(instanceId) ?? 0) + 1, Date.now());
    seqs.set(instanceId, seq);
    return seq;
  };

  function sendTo(inst: InstanceRow) {
    if (inst.shader_id === null) return;
    const to = targets.get(inst.shader_id);
    if (!to) return;
    const specs = db.build(inst.build_id)?.params ?? [];
    for (const spec of specs) {
      socket.send(Buffer.from(packetOf(nextSeq(inst.id), spec.name, inst.params[spec.name] ?? {})), to.port, to.host);
      sent++;
    }
  }

  const timer = setInterval(() => sendAll(), resendMs);
  timer.unref();

  function sendAll() {
    for (const inst of db.instances()) if (inst.state === "live") sendTo(inst);
  }

  return {
    /** Where a shader takes udp, from its descriptor (none: it's bound nothing, or it's gone). */
    learn(shaderId: number, ports: PortInfo[] | undefined) {
      const to = targetOf(ports, arclampHost);
      const had = targets.get(shaderId);
      if (to) targets.set(shaderId, to);
      else targets.delete(shaderId);
      // Newly bound (or bound afresh): its values, at once.
      if (to && (!had || had.port !== to.port || had.host !== to.host)) {
        const inst = db.instances().find((i) => i.shader_id === shaderId);
        if (inst) sendTo(inst);
      }
    },
    /** An instance's values to its shader now (they've changed). */
    send(instanceId: string) {
      const inst = db.instance(instanceId);
      if (inst) sendTo(inst);
    },
    sendAll,
    /** How many packets have gone out. */
    count: () => sent,
    stop() {
      clearInterval(timer);
      socket.close();
    },
  };
}

export type ParamsSender = ReturnType<typeof createParamsSender>;
