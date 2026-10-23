// A color param picked with room tone's color editor: its change is for some
// of the lights, leaving the rest of each as it is (ParamControl.tsx).

import type { Lemtone } from "../../shared/lemtone.ts";
import { colorOfLemtone, lemtoneOf } from "../../shared/params.ts";
import { ColorEditor } from "./ColorEditor.tsx";
import type { ColorPickerProps } from "./ParamControl.tsx";

export function ColorParam({ lights, values, onChange }: ColorPickerProps) {
  const tones = values.map(lemtoneOf);
  const set = (patch: Partial<Lemtone>, _code: string, which: number[]) => {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Lemtone>;
    onChange(which.map((i) => [lights[i]!.id, colorOfLemtone({ ...tones[i]!, ...given })]));
  };
  return <ColorEditor values={tones} onChange={set} types={lights.map((l) => l.type)} />;
}
