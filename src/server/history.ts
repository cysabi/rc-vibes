// The history (GET /api/activity): who did what, newest first. Where it's
// kept is a store's to say: in production, a database of its own written off
// the main thread (db-background.ts), so a slow disk only makes it land
// later, and nothing waits for it. A run of one change (a color dragged) is
// one entry, its newest kept up to date as the run goes: worked out here,
// from the newest entry as it was put in, never read back.

import type { ActivityAction, ActivityEntry, Person } from "../shared/vibes.ts";

/** An entry, as kept. */
export interface ActivityRow {
  id: number;
  ts: string;
  user_id: string;
  user_name: string;
  action: ActivityAction;
  shader_id: number | null;
  shader_name: string | null;
  detail: string | null;
}

export interface LogInput {
  user: Person;
  action: ActivityAction;
  shaderId?: number;
  shaderName?: string | null;
  detail?: Record<string, unknown>;
}

/** Where the history's kept: entries handed over, never waited for; the newest read back when asked. */
export interface HistoryStore {
  /** A new entry, the newest. */
  add(row: Omit<ActivityRow, "id">): void;
  /** The newest entry, as its run goes on: its time and detail now. */
  touch(ts: string, detail: string | null): void;
  /** The newest entries, newest first. */
  recent(limit: number): Promise<ActivityRow[]>;
  /** Done with, once everything handed over is kept. */
  close(): Promise<void>;
}

const entryOf = (r: ActivityRow): ActivityEntry => ({
  id: r.id,
  ts: r.ts,
  user: { id: r.user_id, name: r.user_name },
  action: r.action,
  shaderId: r.shader_id,
  shaderName: r.shader_name,
  detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
});

export function createHistory(store: HistoryStore) {
  // The newest entry, as it was put in (or last touched): what a run's next change folds into.
  let newest: { user: string; action: ActivityAction; at: number; detail: Record<string, unknown> | null } | null = null;

  function log(entry: LogInput, at = new Date()) {
    store.add({
      ts: at.toISOString(),
      user_id: entry.user.id,
      user_name: entry.user.name,
      action: entry.action,
      shader_id: entry.shaderId ?? null,
      shader_name: entry.shaderName ?? null,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
    });
    newest = { user: entry.user.id, action: entry.action, at: at.getTime(), detail: entry.detail ?? null };
  }

  return {
    log: (entry: LogInput) => log(entry),

    /**
     * Log an entry, or fold it into the previous one when the same person did
     * the same thing moments ago (dragging a color picker sends a stream of
     * room tone changes; the history should show one). With `same`, only
     * when the previous entry was about the same thing too, by its detail
     * (the same param of the same shader, say).
     */
    logCoalesced(entry: LogInput, windowMs: number, same?: (lastDetail: Record<string, unknown> | null) => boolean) {
      const now = new Date();
      if (newest && newest.user === entry.user.id && newest.action === entry.action && now.getTime() - newest.at < windowMs && (!same || same(newest.detail))) {
        store.touch(now.toISOString(), entry.detail ? JSON.stringify(entry.detail) : null);
        newest = { ...newest, at: now.getTime(), detail: entry.detail ?? null };
        return;
      }
      log(entry, now);
    },

    async activity(limit: number): Promise<ActivityEntry[]> {
      return (await store.recent(limit)).map(entryOf);
    },

    close: () => store.close(),
  };
}

export type History = ReturnType<typeof createHistory>;

/** The history kept in memory only: for tests, and a database that's in memory too. */
export function memoryStore(): HistoryStore {
  const rows: ActivityRow[] = [];
  return {
    add: (row) => void rows.push({ id: rows.length + 1, ...row }),
    touch(ts, detail) {
      const r = rows.at(-1);
      if (r) Object.assign(r, { ts, detail });
    },
    recent: async (limit) => rows.slice(-limit).reverse().map((r) => ({ ...r })),
    close: async () => {},
  };
}
