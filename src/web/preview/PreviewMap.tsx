// A sketch's preview on the plan: the map, drawing from whatever frame source
// it's given (a SketchRunner), where lights select as on the room's map (no
// tags) and what they look like shows in the corner.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Lights } from "../../shared/vibes.ts";
import { ColorPreview } from "../components/ColorPreview.tsx";
import { RoomMap } from "../components/RoomMap.tsx";
import type { SelectMode } from "../selection.ts";

export function PreviewMap({ layout }: { layout: Lights | null }) {
  const all = useMemo(() => layout?.lights ?? [], [layout]);
  // Start on whichever floor has the most lights.
  const busiest = useMemo(() => {
    const counts = new Map<number, number>();
    for (const l of all) if (l.coords) counts.set(l.coords.floor, (counts.get(l.coords.floor) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 5;
  }, [all]);
  const [chosenFloor, setChosenFloor] = useState<number | null>(null);
  const floor = chosenFloor ?? busiest;

  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const here = useMemo(() => all.filter((l) => l.coords?.floor === floor), [all, floor]);
  const chosen = useMemo(() => here.filter((l) => selected.has(l.id)), [here, selected]);
  const select = useCallback((ids: number[], mode: SelectMode) => {
    setSelected((prev) => {
      if (mode === "replace") return new Set(ids);
      const next = new Set(prev);
      for (const id of ids) {
        if (mode === "remove" || (mode === "toggle" && next.has(id))) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(new Set());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // .app, for the color readout: it sizes itself against it, and tells it
    // its height (--preview-h) so the map's fit keeps clear of it.
    <div className="preview-map app">
      {layout && (
        <RoomMap
          lights={all}
          rails={layout.rails ?? []}
          floor={floor}
          onFloor={(f) => {
            setChosenFloor(f);
            setSelected(new Set());
          }}
          changed={layout.changed ?? 0}
          selected={selected}
          onSelect={select}
          look={chosen.length > 0 && <ColorPreview lights={chosen} />}
        />
      )}
    </div>
  );
}
