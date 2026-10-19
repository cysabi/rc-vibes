// Browser side of vibes' API: a fetch wrapper and React Query hooks.

import { QueryCache, QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "../shared/arclamp.ts";
import type {
  ApiError,
  BoxState,
  Lights,
  LoginOptions,
  Me,
  Placement,
  RailChange,
  SceneNode,
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

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
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
  });

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: () => request<Status>("GET", "/api/status"), refetchInterval: 5000 });

export const useLights = () =>
  useQuery({ queryKey: ["lights"], queryFn: () => request<Lights>("GET", "/api/lights"), staleTime: 60_000 });

// arclamp has no change notifications, so the scene is polled.
export const useScene = () =>
  useQuery({ queryKey: ["scene"], queryFn: () => request<SceneNode[]>("GET", "/api/scene"), refetchInterval: 1000 });

export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: () => request<HealthResponse>("GET", "/api/health"), refetchInterval: 2000 });

export const invalidateScene = () => queryClient.invalidateQueries({ queryKey: ["scene"] });

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
