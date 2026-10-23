// An apply: a browser's pending edits, sent as one run of changes to the room
// (Change, in shared/vibes.ts) over the room socket, and made here in order.
// A change refused stops it there: the ones before it are made, and the
// browser keeps the rest pending. A shader gone meanwhile has nothing left to
// change, so changing (or taking out) one isn't refused. vibes works with
// rclamp as it is, so an apply isn't all or nothing: each change is made in
// the room as it's reached.

import { z } from "zod";
import { PARAM_NAME } from "../shared/params.ts";
import type { Change, Me, ShaderKey } from "../shared/vibes.ts";
import { ArclampError } from "./arclamp.ts";
import { isBranchName } from "./git.ts";
import type { Instances } from "./instances.ts";
import { changesBody } from "./params.ts";
import { Refused, type Shaders } from "./shaders.ts";

const key = z.string().min(1).max(100);
const ids = z.array(z.number().int()).max(2000);

export const change: z.ZodType<Change> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("roomtone"), lights: z.record(z.string(), z.record(z.string(), z.number().finite())), code: z.string().max(60).optional() }),
  z.object({ op: z.literal("remove"), key }),
  z.object({
    op: z.literal("add"),
    key,
    sketch: z.string().min(1),
    branch: z.string().refine(isBranchName),
    build: key.optional(),
    home: ids.min(1),
    muted: z.boolean(),
    mask: ids,
    above: z.string().max(100).optional(),
  }),
  z.object({ op: z.literal("muted"), key, muted: z.boolean() }),
  z.object({ op: z.literal("mask"), key, mask: ids }),
  z.object({ op: z.literal("params"), key, name: z.string().regex(PARAM_NAME), set: changesBody }),
  z.object({ op: z.literal("stack"), order: z.array(key).max(500) }),
]);

export const request = z.object({ type: z.literal("apply"), id: key, changes: z.array(change).max(1000) });

/** An apply stopped at change `at`, why, and what it added before it. */
export class ApplyRefused extends Error {
  readonly at: number;
  readonly code: string;
  readonly made: Record<string, ShaderKey>;

  constructor(at: number, code: string, message: string, made: Record<string, ShaderKey>) {
    super(message);
    this.at = at;
    this.code = code;
    this.made = made;
  }
}

export interface ApplyDeps {
  shaders: Shaders;
  /** Sketches in the room (null with sketches off: nothing can be added). */
  instances: Instances | null;
  /** Room tone, merged and logged as PUT /api/roomtone does. */
  setRoomtone: (lights: Record<string, Record<string, number>>, user: Me, code?: string) => Promise<unknown>;
}

/** Gone already: nothing left to change (a shader, or a param its sketch no longer has). */
const gone = (err: unknown) => (err instanceof Refused || err instanceof ArclampError) && err.status === 404;

export function createApply({ shaders, instances, setRoomtone }: ApplyDeps) {
  async function make(c: Change, user: Me, made: Record<string, ShaderKey>) {
    switch (c.op) {
      case "roomtone":
        return setRoomtone(c.lights, user, c.code);
      case "remove":
        return shaders.remove(c.key, user);
      case "muted":
        return shaders.setMuted(c.key, c.muted, user);
      case "mask":
        return shaders.setMask(c.key, c.mask, user);
      case "params":
        return shaders.setParam(c.key, c.name, c.set, user);
      case "stack":
        return shaders.reorder(c.order, user);
      case "add": {
        if (!instances) throw new Refused(503, "no_sketches", "sketches are off here");
        const above = c.above === undefined ? null : c.above === "" ? "" : shaders.keyOf(c.above, user);
        const from = { branch: c.branch, ...(c.build ? { build: c.build } : {}) };
        const it = await instances.create(c.sketch, from, c.home, user, c.key, { muted: c.muted, mask: c.mask, above });
        if ("refused" in it) throw new Refused(it.status, it.code, it.refused);
        made[c.key] = it.instance.id;
      }
    }
  }

  /** Each change, in order, as `user`; the shaders it added, by their edits' keys. Refused, ApplyRefused. */
  return async function apply(changes: Change[], user: Me): Promise<Record<string, ShaderKey>> {
    const made: Record<string, ShaderKey> = {};
    for (const [at, c] of changes.entries()) {
      try {
        await make(c, user, made);
      } catch (err) {
        if (c.op !== "add" && c.op !== "roomtone" && gone(err)) continue;
        const why = err instanceof Refused || err instanceof ArclampError ? err : null;
        if (!why) console.error(err);
        throw new ApplyRefused(at, why?.code ?? "internal", why?.message ?? "internal error", made);
      }
    }
    return made;
  };
}

export type Apply = ReturnType<typeof createApply>;
