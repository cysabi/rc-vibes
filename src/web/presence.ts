// Who else is here (shared/presence.ts), over the room socket (scene.ts):
// where this page is, said as it changes (sharePresence), and everyone else's
// (useOthers), as vibes says them. Others are people, not pages: someone with
// the room open twice is one avatar, their lights both pages' selections.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { cssRgb, rgbOf, type Presence, type Rgb } from "../shared/presence.ts";
import type { Person } from "../shared/vibes.ts";
import { useMe } from "./api.ts";
import { onPresence, sayPresence } from "./scene.ts";

// At most this often: a box dragged across lights changes the selection with every move.
const SAY_MS = 80;

let people: Presence[] = [];
const listeners = new Set<() => void>();
onPresence((next) => {
  people = next;
  for (const l of listeners) l();
});

let said = "";
let next: { floor: number | null; selected: number[] } | null = null;
let timer: number | undefined;
let last = 0;

function flush() {
  timer = undefined;
  if (!next) return;
  const { floor, selected } = next;
  next = null;
  const key = `${floor}:${selected.join(",")}`;
  if (key === said) return;
  said = key;
  last = Date.now();
  sayPresence(floor, selected);
}

/** Where this page is: the floor it's looking at (null: not at the map) and the lights it has selected. */
export function sharePresence(floor: number | null, selected: Iterable<number>) {
  next = { floor, selected: [...selected].sort((a, b) => a - b) };
  if (timer !== undefined) return;
  const wait = SAY_MS - (Date.now() - last);
  if (wait <= 0) flush();
  else timer = window.setTimeout(flush, wait);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Someone else here: who, their color, and what they're up to (all their pages', together). */
export interface Other {
  person: Person;
  /** Their color, and as CSS. */
  rgb: Rgb;
  color: string;
  /** The floors they're looking at. */
  floors: number[];
  selected: ReadonlySet<number>;
}

/** Everyone here but you, in the order they came. */
export function useOthers(): Other[] {
  const all = useSyncExternalStore(subscribe, () => people);
  const me = useMe().data?.id;
  return useMemo(() => {
    const by = new Map<string, Other & { selected: Set<number> }>();
    for (const p of all) {
      if (p.person.id === me) continue;
      let o = by.get(p.person.id);
      if (!o) by.set(p.person.id, (o = { person: p.person, rgb: rgbOf(p.person.id), color: cssRgb(rgbOf(p.person.id)), floors: [], selected: new Set() }));
      if (p.floor !== null && !o.floors.includes(p.floor)) o.floors.push(p.floor);
      for (const id of p.selected) o.selected.add(id);
    }
    return [...by.values()];
  }, [all, me]);
}

/** Each light someone else has selected, with their colors, in the order they came. */
export function othersByLight(others: Other[]): Map<number, Rgb[]> {
  const out = new Map<number, Rgb[]>();
  for (const o of others) {
    for (const id of o.selected) {
      const colors = out.get(id);
      if (colors) colors.push(o.rgb);
      else out.set(id, [o.rgb]);
    }
  }
  return out;
}

/** While mounted, says where this page is as that changes; once it's gone, that it's not at the map. */
export function useSharePresence(floor: number, selected: ReadonlySet<number>) {
  useEffect(() => sharePresence(floor, selected), [floor, selected]);
  useEffect(() => () => sharePresence(null, []), []);
}
