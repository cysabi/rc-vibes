// One param's control, for some lights, as one of Field.tsx's kinds: a
// SliderField for a number, a ButtonSwitchField for a toggle, and for a color
// whatever picker it's given (a ColorField in vibes: ColorParam.tsx; the
// editor's preview has something lighter, as a ColorField can't go there). With `resettable`, "Set to default" under it puts
// them all back (in vibes, it's for all of a shader's params at once, by its
// name: SelectionPanel.tsx).

import type { ComponentType } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { paramText, sameValue, type ColorValue, type ParamSpec, type ParamValue } from "../../shared/params.ts";
import { ButtonSwitchField, rangeOf, SliderField } from "./Field.tsx";

/** New values (null: back to the default), each with its light. */
export type ParamChanges = (changes: [number, ParamValue | null][]) => void;

export interface ColorPickerProps {
  /** The param's name, for its field. */
  label: string;
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
  /** Whether it has its own "Set to default". */
  resettable?: boolean;
}

const TRACK = "linear-gradient(90deg, rgb(255 255 255 / 0.06), rgb(255 255 255 / 0.22))";

export function ParamControl({ spec, lights, values, onChange, colorPicker: ColorPicker, resettable = false }: Props) {
  const all = (v: ParamValue | null) => onChange(lights.map((l) => [l.id, v]));
  const reset = resettable && values.some((v) => !sameValue(v, spec.default)) && (
    <button className="param-default" onClick={() => all(null)}>
      Set to default
    </button>
  );

  if (spec.kind === "number") {
    const nums = values as number[];
    const shown = rangeOf(nums, (v) => paramText(v, spec.step));
    return (
      <div className="param">
        <SliderField
          label={spec.label}
          value={shown}
          values={nums}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          track={TRACK}
          onChange={(v, which) => onChange(which.map((i) => [lights[i]!.id, v]))}
        />
        {reset}
      </div>
    );
  }

  if (spec.kind === "toggle") {
    return (
      <div className="param">
        <ButtonSwitchField label={spec.label} values={values.map((v) => v === true)} onChange={(on) => all(on)} />
        {reset}
      </div>
    );
  }

  // A color's several fields (its picker, brightness, fidelity), spaced as fields are.
  return (
    <div className="param fields">
      <ColorPicker label={spec.label} lights={lights} values={values as ColorValue[]} onChange={onChange} />
      {reset}
    </div>
  );
}
