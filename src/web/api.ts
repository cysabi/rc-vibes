// Browser side of vibes' API: a fetch wrapper and React Query hooks.

import { QueryCache, QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "../shared/arclamp.ts";
import type {
  ActivityEntry,
  ApiError,
  Lights,
  LoginOptions,
  Me,
  Placement,
  RailChange,
  SceneNode,
  Status,
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

export const useActivity = () =>
  useQuery({
    queryKey: ["activity"],
    queryFn: () => request<ActivityEntry[]>("GET", "/api/activity?limit=100"),
    refetchInterval: 3000,
  });

export function invalidateScene() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["scene"] }),
    queryClient.invalidateQueries({ queryKey: ["activity"] }),
  ]);
}

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
      queryClient.clear();
      queryClient.setQueryData(["me"], null);
    },
  });
}

export function useCreateShader() {
  return useMutation({
    mutationFn: (body: { name: string; script: string }) => request<SceneNode>("POST", "/api/shaders", body),
    onSettled: invalidateScene,
  });
}

export function useUpdateShader() {
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; script?: string }) =>
      request<SceneNode>("PUT", `/api/shaders/${id}`, body),
    onSettled: invalidateScene,
  });
}

export function useDeleteShader() {
  return useMutation({
    mutationFn: (id: number) => request<void>("DELETE", `/api/shaders/${id}`),
    onSettled: invalidateScene,
  });
}

export function useSetMuted() {
  return useMutation({
    mutationFn: ({ id, muted }: { id: number; muted: boolean }) =>
      request<void>("POST", `/api/shaders/${id}/muted`, { muted }),
    onSettled: invalidateScene,
  });
}

export function useMoveShader() {
  return useMutation({
    mutationFn: ({ id, position }: { id: number; position: number }) =>
      request<void>("POST", `/api/shaders/${id}/position`, { position }),
    onSettled: invalidateScene,
  });
}

const invalidateLights = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["lights"] }),
    queryClient.invalidateQueries({ queryKey: ["activity"] }),
  ]);

/** A change to the map: rails drawn or moved, lights moved, and/or lights turned to another orientation. */
export interface LayoutChange {
  rails?: RailChange[];
  placements?: Placement[];
  types?: TypeChange[];
}

export function useChangeLayout() {
  return useMutation({
    // Rails first, so lights can be put on a rail drawn in the same change.
    mutationFn: async ({ rails, placements, types }: LayoutChange) => {
      if (rails?.length) await request<void>("PUT", "/api/rails", { rails });
      if (placements?.length) await request<void>("PUT", "/api/placements", { placements });
      if (types?.length) await request<void>("PUT", "/api/light-types", { lights: types });
    },
    onSettled: invalidateLights,
  });
}

export function useClearScene() {
  return useMutation({
    mutationFn: () => request<void>("DELETE", "/api/scene"),
    onSettled: invalidateScene,
  });
}
