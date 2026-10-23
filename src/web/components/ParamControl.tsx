// One param's control, for some lights: a slider for a number, on and off for
// a toggle, and for a color whatever picker it's given (room tone's color
// editor in vibes: ColorParam.tsx; the editor's preview has something
// lighter, as the color editor can't go there). It shows what those lights
// have (their range, when they differ), and sets them all; a color change can
// be for some of them, as room tone's is. "Default" puts them back.

import type { ComponentType } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { paramText, sameValue, type ColorValue, type ParamSpec, type ParamValue } from "../../shared/params.ts";
import { Segmented } from "./Segmented.tsx";
import { Slider } from "./Slider.tsx";

/** New values (null: back to the default), each with its light. */
export type ParamChanges = (changes: [number, ParamValue | null][]) => void;

export interface ColorPickerProps {
  lights: LightInfo[];
  values: ColorValue[];
  onChange: ParamChanges;
}

interface Props {
  spec: ParamSpec;
  /** The lights it sets here, and what each has now, in the same order. */
  lights: LightInfo[];
  values: ParamValue[];
  onChange: ParamChanges;
  /** How a color is picked. */
  colorPicker: ComponentType<ColorPickerProps>;
  /** What these lights are, said beside what they have ("3 lights"). */
  note?: string;
}

const TRACK = "linear-gradient(90deg, rgb(255 255 255 / 0.06), rgb(255 255 255 / 0.22))";

export function ParamControl({ spec, lights, values, onChange, colorPicker: ColorPicker, note }: Props) {
  const all = (v: ParamValue | null) => onChange(lights.map((l) => [l.id, v]));
  const said = (shown: string) => [shown, note].filter(Boolean).join(" · ");
  const reset = values.some((v) => !sameValue(v, spec.default)) && (
    <button className="quiet param-default" onClick={() => all(null)} title="Back to what the sketch starts with">
      Default
    </button>
  );
  const head = (shown: string) => (
    <div className="field-head">
      <span className="label">{spec.label}</span>
      <span className="mono">{said(shown)}</span>
    </div>
  );

  if (spec.kind === "number") {
    const nums = values as number[];
    const [lo, hi] = [Math.min(...nums), Math.max(...nums)];
    const shown = lo === hi ? paramText(lo, spec.step) : `${paramText(lo, spec.step)}–${paramText(hi, spec.step)}`;
    return (
      <div className="param">
        <Slider
          label={spec.label}
          value={nums[0] ?? spec.default}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          track={TRACK}
          display={said(shown)}
          onChange={all}
          onCommit={all}
          marks={[{ at: spec.default, title: `Default: ${paramText(spec.default, spec.step)}` }]}
        />
        {reset}
      </div>
    );
  }

  if (spec.kind === "toggle") {
    const on = values.filter((v) => v === true).length;
    return (
      <div className="param">
        {head(on === 0 ? "all off" : on === values.length ? "all on" : `${on} of ${values.length} on`)}
        <Segmented
          className="stretch"
          label={spec.label}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          value={on === values.length ? "on" : on === 0 ? "off" : null}
          onChange={(v) => all(v === "on")}
        />
        {reset}
      </div>
    );
  }

  return (
    <div className="param">
      {head(values.every((v) => sameValue(v, values[0]!)) ? "" : "mixed")}
      <ColorPicker lights={lights} values={values as ColorValue[]} onChange={onChange} />
      {reset}
    </div>
  );
}
