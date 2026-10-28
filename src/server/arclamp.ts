// Typed client for arclamp's HTTP API. Every call carries vibes' key.

import type {
  HealthResponse,
  LightsResponse,
  RoomTemplate,
  ShaderDescriptor,
} from "../shared/arclamp.ts";

export class ArclampError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 10_000;

/**
 * A change put off till `at` (arclamp's time, ms since 1970): it goes in with
 * the first frame at or after then, with every other change due by that
 * frame, as one. Named `id` (vibes' own, unique), a later change can take its
 * place: one with `emplace` naming it drops it if it's still to come, and
 * stops it if it hasn't got there yet. Either way the scene ends as the later
 * one leaves it (arclamp's §10.1).
 */
export interface Schedule {
  at: number;
  id?: string;
  emplace?: string;
}

const scheduleHeaders = (s: Schedule | undefined): Record<string, string> =>
  s
    ? {
        "X-Arclamp-Schedule": String(Math.round(s.at)),
        ...(s.id ? { "X-Arclamp-Schedule-Id": s.id } : {}),
        ...(s.emplace ? { "X-Arclamp-Schedule-Emplace": s.emplace } : {}),
      }
    : {};

/** What arclamp said of a change put off: the frame it goes in with (arclamp's time, ms); none, if its time had passed and it went in at once. */
interface Scheduled {
  frame_at?: string;
}

export function createArclamp(baseUrl: string, key: string) {
  async function call<T>(method: string, path: string, body?: unknown, schedule?: Schedule): Promise<T> {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...scheduleHeaders(schedule),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ArclampError(0, "unreachable", `arclamp unreachable: ${(err as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const e = data as { error?: string; code?: string } | undefined;
      throw new ArclampError(res.status, e?.code ?? "arclamp", e?.error ?? `arclamp returned ${res.status}`);
    }
    return data as T;
  }

  return {
    scene: () => call<ShaderDescriptor[]>("GET", "/v1/scene"),
    shader: (id: number) => call<ShaderDescriptor>("GET", `/v1/shader/${id}`),
    lights: () => call<LightsResponse>("GET", "/v1/lights"),
    health: () => call<HealthResponse>("GET", "/v1/scene/health"),
    /** arclamp's clock, the one its frames are stamped with (ms since 1970, to the microsecond): for rclamp-time.ts. */
    time: () => call<{ now_ms: number }>("GET", "/v1/time"),
    // Appends after every other shader, so it renders last (on top), unless
    // given a position (1 the bottom; past the last is the top). Muted and
    // masked as `initial` says from its first frame; an arclamp from before
    // that ignores it, so check the descriptor.
    createShader: (script: string, position?: number, initial?: { muted: boolean; mask: number[] }) =>
      call<ShaderDescriptor>("POST", "/v1/scene/shader", { type: "js", script, position: position ?? "bottom", ...initial }),
    setScript: (id: number, script: string) => call<ShaderDescriptor>("PUT", `/v1/shader/${id}`, { script }),
    deleteShader: (id: number) => call<void>("DELETE", `/v1/shader/${id}`),
    moveShader: (id: number, position: number) => call<void>("POST", `/v1/shader/${id}/position`, { position }),
    setMuted: (id: number, muted: boolean) => call<void>("POST", `/v1/shader/${id}/muted`, { muted }),
    /** Muted or not, put off (Schedule): the frame it goes in with (arclamp's time, ms), or null if it went in at once. */
    setMutedAt: async (id: number, muted: boolean, schedule: Schedule): Promise<number | null> => {
      const ack = await call<Scheduled | undefined>("POST", `/v1/shader/${id}/muted`, { muted }, schedule);
      // To the millisecond: arclamp says it to the nanosecond, which Date doesn't read.
      const frame = ack?.frame_at ? Date.parse(ack.frame_at.replace(/(\.\d{3})\d+/, "$1")) : Number.NaN;
      return Number.isFinite(frame) ? frame : null;
    },
    // The whole mask: the lights the shader may not change ([] clears it).
    setMask: (id: number, mask: number[]) => call<void>("POST", `/v1/shader/${id}/mask`, { mask }),
    // A statement run in the shader's live sandbox, between ticks: what it
    // came to (JSON where JSON can say it; "undefined" for nothing), or what
    // it threw. arclamp logs each one, with its code.
    evalShader: (id: number, code: string) => call<{ ok: boolean; result?: string; error?: string }>("POST", `/v1/shader/${id}/eval`, { code }),
    /**
     * A statement put off (Schedule): run in the shader's sandbox before it
     * renders the first frame at or after `at`, so that frame shows what it
     * set. Whether it was put off; if its time had passed, it ran at once.
     */
    evalAt: async (id: number, code: string, schedule: Schedule): Promise<boolean> => {
      const ack = await call<{ scheduled_at?: string } | undefined>("POST", `/v1/shader/${id}/eval`, { code }, schedule);
      return typeof ack?.scheduled_at === "string";
    },
    // Merges into the running template: lights and channels not named are
    // left as they are.
    mergeRoomtone: (template: RoomTemplate) => call<ShaderDescriptor>("PUT", "/v1/shader/0", template),
    clearScene: () => call<void>("DELETE", "/v1/scene"),
    // The light stream: each frame's lights, and what each shader touched in it.
    streamUrl: () => `${baseUrl.replace(/^http/, "ws")}/v1/scene/ws?include=frames,touched`,
    // For its event streams (event-stream.ts).
    url: (path: string) => baseUrl + path,
    key,
  };
}

export type Arclamp = ReturnType<typeof createArclamp>;
