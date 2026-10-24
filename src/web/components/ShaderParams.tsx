// A shader's params, for the lights selected: what opens under its row in the
// selection, as room tone's color does under its own. A control for each
// param it has for any of those lights (the ones it lights, that the param's
// filter lets through: kinds, tags, ids), each setting just them. A change is
// a pending edit like any other (the simulation shows it; Apply sends it, or
// live mode at once). Every light selected sets it everywhere. What it has is
// what its pool says it declares: as it runs in the room, or, for a sketch
// you're adding, as its preview here does (sim.ts), before it's in.

import type { LightInfo } from "../../shared/arclamp.ts";
import { appliesTo, valuesAt, type ParamSpec } from "../../shared/params.ts";
import { drafts, reachOf, type Layer } from "../draft.ts";
import { count } from "../words.ts";
import { ColorParam } from "./ColorParam.tsx";
import { ParamControl } from "./ParamControl.tsx";

export interface ParamRow {
  spec: ParamSpec;
  /** The lights it's for, of those selected. */
  lights: LightInfo[];
}

/** Its params for these lights (none until something running it has said what they are, or if it couldn't go in). */
export function paramRowsOf(layer: Layer, selected: LightInfo[]): ParamRow[] {
  const declared = layer.params?.declared;
  if (!declared || layer.stage === "failed") return [];
  const reach = new Set(reachOf(layer));
  const here = selected.filter((l) => reach.has(l.id));
  return declared.flatMap((spec) => {
    const theirs = here.filter((l) => appliesTo(spec, l));
    return theirs.length > 0 ? [{ spec, lights: theirs }] : [];
  });
}

export function ShaderParams({ layer, rows }: { layer: Layer; rows: ParamRow[] }) {
  return (
    <div className="param-list">
      {rows.map(({ spec, lights }) => (
        <ParamControl
          key={spec.name}
          spec={spec}
          lights={lights}
          values={valuesAt(
            spec,
            layer.params?.values[spec.name],
            lights.map((l) => l.id),
          )}
          onChange={(changes) => drafts.setParam(layer.key, spec.name, changes)}
          colorPicker={ColorParam}
          note={count(lights.length, "light")}
        />
      ))}
    </div>
  );
}
