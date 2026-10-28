// Who's here (shared/presence.ts): each room socket, once it's known who's on
// it, joins; says where it is as that changes; and leaves as it closes. Every
// page is told everyone's, as one list, whenever any of it changes: changes
// that come together (a drag across lights, many pages at once) told together,
// a moment later.

import { randomUUID } from "node:crypto";
import { same } from "../shared/live.ts";
import type { Presence } from "../shared/presence.ts";
import type { Person } from "../shared/vibes.ts";

// How long changes wait to be told together.
const BATCH_MS = 50;

export function createPresence({ batchMs = BATCH_MS }: { batchMs?: number } = {}) {
  const pages = new Map<string, { presence: Presence; say: (json: string) => void }>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const list = (): Presence[] => [...pages.values()].map((p) => p.presence);

  function tell() {
    timer = undefined;
    const json = JSON.stringify({ type: "presence", people: list() });
    for (const p of pages.values()) p.say(json);
  }

  function changed() {
    if (timer === undefined) timer = setTimeout(tell, batchMs);
  }

  return {
    list,

    /** A page, with who's on it, and how to tell it; it's told everyone's as soon as anything's told. */
    join(person: Person, say: (json: string) => void) {
      const id = randomUUID();
      // Just who they are: nothing else of the session goes to everyone.
      pages.set(id, { presence: { id, person: { id: person.id, name: person.name }, floor: null, selected: [] }, say });
      changed();
      return {
        /** Where it is now. */
        move(floor: number | null, selected: number[]) {
          const page = pages.get(id);
          if (!page) return;
          const next = { ...page.presence, floor, selected: [...new Set(selected)] };
          if (same(next, page.presence)) return;
          page.presence = next;
          changed();
        },
        leave() {
          if (pages.delete(id)) changed();
        },
      };
    },

    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

export type PresenceHub = ReturnType<typeof createPresence>;
