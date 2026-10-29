// The groups of lights on the floor you're looking at, as chips: two for
// whole places, All (every light here) and Main Space (the open floor:
// tags.ts), then one per tag. Each is on, with an ×, while all its lights
// are selected: on adds its lights to the selection, off takes them out
// (every one of them, whatever else they're part of). Selected lights no
// chip that's on covers (picked on the map, or part of a tag) show as a
// count ahead of those, whose × lets go of just them. With a layer in focus,
// the lights here are just its (App.tsx), so the chips are just theirs.
//
// Under the pointer, a chip points out its lights on the map (hint.ts), and
// what its click would let go of: an on chip's own lights, the count's loose
// ones; an off chip only adds, so nothing.

import type { ReactNode } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { inMainSpace, tagLabel } from "../../shared/tags.ts";
import { usePointsOut } from "../hint.ts";
import { CloseIcon } from "../icons.tsx";
import type { SelectMode } from "../selection.ts";

interface Props {
  /** The lights on this floor: the only ones that can be selected. */
  lights: LightInfo[];
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], mode: SelectMode) => void;
}

export function TagChips({ lights, selected, onSelect }: Props) {
  const byTag = new Map<string, number[]>();
  for (const l of lights) for (const t of l.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), l.id]);
  const chipOf = (tag: string, label: string, ids: number[]) => ({ tag, label, ids, on: ids.length > 0 && ids.every((id) => selected.has(id)) });
  const tags = [...byTag].map(([tag, ids]) => chipOf(tag, tagLabel(tag), ids)).sort((a, b) => a.label.localeCompare(b.label));
  // The places: everything here, and the main space (only where it's a part of what's here).
  const main = lights.filter((l) => inMainSpace(l.tags)).map((l) => l.id);
  const places = [
    chipOf("*", "All", lights.map((l) => l.id)),
    ...(main.length > 0 && main.length < lights.length ? [chipOf("*main", "Main Space", main)] : []),
  ];
  const chips = [...places, ...tags];
  if (lights.length === 0 && selected.size === 0) return null;
  const covered = new Set(chips.filter((c) => c.on).flatMap((c) => c.ids));
  const loose = [...selected].filter((id) => !covered.has(id));

  return (
    <div className="tag-bar">
      <div className="tag-chips" role="group" aria-label="Select lights by tag">
        {loose.length > 0 && (
          <Chip on ids={loose} leaving={loose} onClick={() => onSelect([...covered], "replace")} label={`Let go of ${loose.length} selected`}>
            <CloseIcon /> {loose.length} selected
          </Chip>
        )}
        {chips.map((chip) => (
          <Chip key={chip.tag} on={chip.on} pressed ids={chip.ids} leaving={chip.on ? chip.ids : []} onClick={() => onSelect(chip.ids, chip.on ? "remove" : "add")}>
            {chip.on && <CloseIcon />}
            {chip.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** A chip: on or off; under the pointer, its lights pointed out on the map, and what its click would let go of. */
function Chip({
  on,
  pressed = false,
  ids,
  leaving,
  onClick,
  label,
  children,
}: {
  on: boolean;
  /** A toggle (it says whether it's on), not just a button. */
  pressed?: boolean;
  ids: readonly number[];
  leaving: readonly number[];
  onClick: () => void;
  label?: string;
  children: ReactNode;
}) {
  const pointsOut = usePointsOut(
    () => ids,
    () => leaving,
  );
  return (
    <button className={on ? "chip on" : "chip"} aria-pressed={pressed ? on : undefined} aria-label={label} onClick={onClick} {...pointsOut}>
      {children}
    </button>
  );
}
