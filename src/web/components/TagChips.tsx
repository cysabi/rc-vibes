// The tags on the floor you're looking at, as chips over the top left of the
// map. Each turns on and off on its own: on adds its lights here to the
// selection, off takes them out again (except any another chip that's on
// still covers). A chip is on, with an × to turn it off, while all its
// lights are selected. Ahead of them, All: on whenever every other chip is,
// and turning it on or off turns them all on or off. Selected lights no chip
// that's on covers (picked on the map, or part of a tag) show as a count
// ahead of those, whose × lets go of just them. With more than one chip on,
// a button under them lets go of everything.

import type { LightInfo } from "../../shared/arclamp.ts";
import { tagLabel } from "../../shared/tags.ts";
import { CloseIcon } from "../icons.tsx";
import type { SelectMode } from "./RoomMap.tsx";

interface Props {
  /** The lights on this floor: the only ones that can be selected. */
  lights: LightInfo[];
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], mode: SelectMode) => void;
}

export function TagChips({ lights, selected, onSelect }: Props) {
  const byTag = new Map<string, number[]>();
  for (const l of lights) for (const t of l.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), l.id]);
  const tags = [...byTag]
    .map(([tag, ids]) => ({ tag, label: tagLabel(tag), ids, on: ids.every((id) => selected.has(id)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (tags.length === 0 && selected.size === 0) return null;
  const covered = new Set(tags.filter((t) => t.on).flatMap((t) => t.ids));
  const loose = [...selected].filter((id) => !covered.has(id)).length;
  const allOn = tags.length > 0 && tags.every((t) => t.on);
  const chipsOn = tags.filter((t) => t.on).length + (loose > 0 ? 1 : 0);

  /** Take out the lights of `going` chips that no chip staying on covers. */
  const turnOff = (going: typeof tags) => {
    const kept = new Set(tags.filter((t) => t.on && !going.includes(t)).flatMap((t) => t.ids));
    const out = new Set(going.flatMap((t) => t.ids).filter((id) => !kept.has(id)));
    onSelect([...selected].filter((id) => !out.has(id)), "replace");
  };
  const toggle = (chip: (typeof tags)[number]) => (chip.on ? turnOff([chip]) : onSelect(chip.ids, "add"));
  const toggleAll = () => (allOn ? turnOff(tags) : onSelect(tags.flatMap((t) => t.ids), "add"));

  return (
    <div className="tag-bar">
      <div className="tag-chips" role="group" aria-label="Select lights by tag">
        {loose > 0 && (
          <button className="chip on" onClick={() => onSelect([...covered], "replace")} aria-label={`Let go of ${loose} selected`}>
            <CloseIcon /> {loose} selected
          </button>
        )}
        {tags.length > 1 && (
          <button className={allOn ? "chip on" : "chip"} aria-pressed={allOn} onClick={toggleAll}>
            {allOn && <CloseIcon />}
            All
          </button>
        )}
        {tags.map((chip) => (
          <button key={chip.tag} className={chip.on ? "chip on" : "chip"} aria-pressed={chip.on} onClick={() => toggle(chip)}>
            {chip.on && <CloseIcon />}
            {chip.label}
          </button>
        ))}
      </div>
      {chipsOn > 1 && (
        <button className="tag-clear" onClick={() => onSelect([], "replace")}>
          Deselect all
        </button>
      )}
    </div>
  );
}
