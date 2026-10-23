// Browser side of vibes' API: a fetch wrapper and React Query hooks.

import { QueryCache, QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "../shared/arclamp.ts";
import type {
  ApiError,
  ApiToken,
  BoxState,
  Lights,
  LoginOptions,
  Me,
  Placement,
  RailChange,
  RoomRequest,
  Sketch,
  Status,
  TagChange,
  TypeChange,
} from "../shared/vibes.ts";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Where the API is (LoginOptions.api): this page's own address, or, from
// another of vibes' addresses, the main one (no proxy between), reached with
// a short-lived token from this page's own (/auth/token) in place of the
// cookie, which doesn't go from one site to another. Asked once; without an
// answer, this page's own will do.
let apiBase: Promise<string | null> | null = null;
const apiBaseOf = () =>
  (apiBase ??= fetch(`/auth/options?origin=${encodeURIComponent(location.origin)}`)
    .then(async (r) => (r.ok ? ((await r.json()) as LoginOptions).api : null))
    .catch(() => null));

// The token, fetched again with this long to spare.
const TOKEN_SPARE_MS = 60_000;
let token: ApiToken | null = null;
let fetchingToken: Promise<ApiToken | null> | null = null;
async function tokenFor(fresh = false): Promise<string | null> {
  if (!fresh && token && token.exp - Date.now() > TOKEN_SPARE_MS) return token.token;
  fetchingToken ??= fetch("/auth/token", { cache: "no-store" })
    .then(async (r) => (r.ok ? ((await r.json()) as ApiToken) : null))
    .catch(() => null)
    .finally(() => (fetchingToken = null));
  token = await fetchingToken;
  return token?.token ?? null;
}

/** A request to vibes: under /api, at its API's address (with the token there, tried once more with a fresh one if it's turned down); else this page's. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const at = path.startsWith("/api/") ? await apiBaseOf() : null;
  if (!at) return fetch(path, init);
  const send = async (fresh: boolean) => {
    const t = await tokenFor(fresh);
    return fetch(at + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
  };
  const res = await send(false);
  return res.status === 401 ? send(true) : res;
}

/** A socket to vibes' API (a path under /api): its address, and what to say on it first (the token, if it's another site's). */
export async function apiSocket(path: string): Promise<{ url: string; hello: string | null }> {
  const at = await apiBaseOf();
  const url = `${(at ?? location.origin).replace(/^http/, "ws")}${path}`;
  if (!at) return { url, hello: null };
  const t = await tokenFor();
  return { url, hello: t ? JSON.stringify({ type: "auth", token: t } satisfies RoomRequest) : null };
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = data as Partial<ApiError> | null;
    throw new RequestError(res.status, e?.code ?? "error", e?.error ?? `request failed (${res.status})`);
  }
  return data as T;
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // A session that expires mid-use sends everyone back to the login screen.
    onError: (err) => {
      if (err instanceof RequestError && err.status === 401) {
        queryClient.setQueryData(["me"], null);
      }
    },
  }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});

export const useLoginOptions = () =>
  useQuery({ queryKey: ["login-options"], queryFn: () => request<LoginOptions>("GET", "/auth/options") });

/** null when logged out. */
export const useMe = () =>
  useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await request<Me>("GET", "/api/me");
      } catch (err) {
        if (err instanceof RequestError && err.status === 401) return null;
        throw err;
      }
    },
    // Not reaching vibes at all (no network yet, as a wall display that's
    // just booted; vibes restarting) is worth waiting out: everything else
    // waits on this. Up to 30 s apart, and at once when the network's back.
    retry: (_, err) => !(err instanceof RequestError),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
  });

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: () => request<Status>("GET", "/api/status"), refetchInterval: 5000 });

export const useLights = () =>
  useQuery({ queryKey: ["lights"], queryFn: () => request<Lights>("GET", "/api/lights"), staleTime: 60_000 });

// The scene: scene.ts (pushed by vibes, not polled).

export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: () => request<HealthResponse>("GET", "/api/health"), refetchInterval: 2000 });

export function useDevLogin() {
  return useMutation({
    mutationFn: (name: string) => request<Me>("POST", "/auth/dev-login", { name }),
    onSuccess: (me) => queryClient.setQueryData(["me"], me),
  });
}

export function useLogout() {
  return useMutation({
    mutationFn: () => request<void>("POST", "/auth/logout"),
    onSuccess: () => {
      token = null;
      // Logged out first, so the app swaps to the login page; then drop the
      // rest. (clear() would also drop "me" from under the mounted app, which
      // then never hears that it's null.)
      queryClient.setQueryData(["me"], null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
  });
}

export const useSketches = () =>
  useQuery({ queryKey: ["sketches"], queryFn: () => request<{ sketches: Sketch[] }>("GET", "/api/sketches").then((r) => r.sketches) });

export const useSketch = (id: string) =>
  useQuery({ queryKey: ["sketches", id], queryFn: () => request<Sketch>("GET", `/api/sketches/${encodeURIComponent(id)}`) });

/**
 * A sketch's branch's head, as the browser knows it: main's (a sketch says
 * only main's so far, and main is all that's added from), else null.
 */
export function useBranchHead(sketchId: string, branch: string): string | null {
  const sketch = useSketch(sketchId);
  return branch === "main" ? (sketch.data?.head ?? null) : null;
}

/** The deleted sketches that can still be restored. */
export const useDeletedSketches = () =>
  useQuery({ queryKey: ["sketches", "deleted"], queryFn: () => request<{ sketches: Sketch[] }>("GET", "/api/sketches/deleted").then((r) => r.sketches) });

const invalidateSketches = () => queryClient.invalidateQueries({ queryKey: ["sketches"] });

export function useCreateSketch() {
  return useMutation({
    mutationFn: (name: string) => request<Sketch>("POST", "/api/sketches", { name }),
    onSuccess: invalidateSketches,
  });
}

/** Deletes a sketch, for everyone; it can be restored for a while. */
export function useDeleteSketch() {
  return useMutation({
    mutationFn: (id: string) => request<Sketch>("DELETE", `/api/sketches/${encodeURIComponent(id)}`, {}),
    onSuccess: invalidateSketches,
  });
}

export function useRestoreSketch() {
  return useMutation({
    mutationFn: (id: string) => request<Sketch>("POST", `/api/sketches/${encodeURIComponent(id)}/restore`, {}),
    onSuccess: invalidateSketches,
  });
}

/**
 * Your box for a sketch, started if it isn't running, and asked after until
 * it's ready (or has failed).
 */
export const useBox = (sketchId: string, enabled: boolean) =>
  useQuery({
    queryKey: ["box", sketchId],
    enabled,
    // A JSON body, so it's never taken for a form posted from another site.
    // A sketch deleted meanwhile (410) is looked at again, to say so.
    queryFn: () =>
      request<BoxState>("POST", `/api/sketches/${encodeURIComponent(sketchId)}/box`, {}).catch((err: unknown) => {
        if (err instanceof RequestError && err.status === 410) void invalidateSketches();
        throw err;
      }),
    // Asked again soon while it starts, to show it the moment it's ready, and
    // every half minute once it is: that keeps it (a box nothing's checked in
    // on for a while is removed), and finds out if it's gone. Only while the
    // page is in sight; coming back into sight asks at once.
    refetchInterval: (q) => (q.state.data?.state === "starting" ? 500 : q.state.data?.state === "ready" ? 30_000 : false),
    refetchOnWindowFocus: "always",
  });

const invalidateLights = () => queryClient.invalidateQueries({ queryKey: ["lights"] });

/** A change to the map: rails drawn or moved, lights moved, turned to another orientation, and/or tagged. */
export interface LayoutChange {
  rails?: RailChange[];
  placements?: Placement[];
  types?: TypeChange[];
  tags?: TagChange[];
}

export function useChangeLayout() {
  return useMutation({
    // Rails first, so lights can be put on a rail drawn in the same change.
    mutationFn: async ({ rails, placements, types, tags }: LayoutChange) => {
      if (rails?.length) await request<void>("PUT", "/api/rails", { rails });
      if (placements?.length) await request<void>("PUT", "/api/placements", { placements });
      if (types?.length) await request<void>("PUT", "/api/light-types", { lights: types });
      if (tags?.length) await request<void>("PUT", "/api/light-tags", { lights: tags });
    },
    onSettled: invalidateLights,
  });
}
