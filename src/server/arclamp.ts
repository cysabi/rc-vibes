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

export function createArclamp(baseUrl: string, key: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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
    // The whole mask: the lights the shader may not change ([] clears it).
    setMask: (id: number, mask: number[]) => call<void>("POST", `/v1/shader/${id}/mask`, { mask }),
    // A statement run in the shader's live sandbox, between ticks: what it
    // came to (JSON where JSON can say it; "undefined" for nothing), or what
    // it threw. arclamp logs each one, with its code.
    evalShader: (id: number, code: string) => call<{ ok: boolean; result?: string; error?: string }>("POST", `/v1/shader/${id}/eval`, { code }),
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
