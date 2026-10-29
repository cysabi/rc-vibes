// A field in a sidebar (Sidebar.tsx): its name on the left, what the lights
// in play have on the right (one value, or the lowest to the highest:
// rangeOf; or nothing; or something to do to it, a button), and its control
// under them. Its kinds, each the same wherever it's used (room tone's, a
// sketch's params, the base Tone's among them):
//
//   SliderField        a number: one knob, or a range (Slider.tsx)
//   ButtonSwitchField  on or off: Off · On (Segmented.tsx)
//   ColorField         a color: its picker, then its brightness and
//                      fidelity, each a SliderField (ColorField.tsx)

import type { ReactNode } from "react";
import { Segmented } from "./Segmented.tsx";
import { Slider } from "./Slider.tsx";

/** What the lights have, as one short text: the one value, or the lowest to the highest ("0.20–0.80"). */
export function rangeOf(values: readonly number[], text: (v: number) => string): string {
  if (values.length === 0) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? text(hi) : `${text(lo)}–${text(hi)}`;
}

/** On, off, or how many of each ("3 on / 2 off"), for lights that are only either. */
export function onOffOf(on: readonly boolean[]): string {
  if (on.length === 0) return "";
  const n = on.filter(Boolean).length;
  return n === on.length ? "on" : n === 0 ? "off" : `${n} on / ${on.length - n} off`;
}

/** A row of a sidebar's (Sidebar.tsx): its name, what the lights have (or what's done to it), and its control. */
export function Field({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span className="label">{label}</span>
        {typeof value === "string" ? <span className="mono">{value}</span> : value}
      </div>
      {children}
    </div>
  );
}

/** A number, for some lights: what they have, and a slider (one knob, or a range whose ends clamp the lights they pass). */
export function SliderField({
  label,
  value,
  values,
  min,
  max,
  step,
  track,
  ends,
  onChange,
}: {
  label: string;
  /** What they have, as words: in the head, and for assistive technology. */
  value: string;
  values: readonly number[];
  min: number;
  max: number;
  step: number;
  /** CSS background for the track. */
  track: string;
  ends?: [ReactNode, ReactNode];
  /** Some of the lights (`which`, indices into `values`) to `v`. */
  onChange: (v: number, which: number[]) => void;
}) {
  return (
    <Field label={label} value={value}>
      <Slider label={label} values={values} min={min} max={max} step={step} track={track} display={value} ends={ends} onChange={onChange} />
    </Field>
  );
}

/** On or off, for some lights: how many are which, and Off · On (neither lit while they're mixed). */
export function ButtonSwitchField({ label, values, onChange }: { label: string; values: readonly boolean[]; onChange: (on: boolean) => void }) {
  const on = values.filter(Boolean).length;
  return (
    <Field label={label} value={onOffOf(values)}>
      <Segmented
        className="stretch"
        label={label}
        options={[
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ]}
        value={on === values.length ? "on" : on === 0 ? "off" : null}
        onChange={(v) => onChange(v === "on")}
      />
    </Field>
  );
}
