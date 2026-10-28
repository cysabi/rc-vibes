// Room tone's parameter, its color, for the selected lights: a ColorField for
// the color lights (each change into the pending edits, for the lights it's
// for), and a ButtonSwitchField for the old bulbs (Field.tsx's kinds). (Shaders may draw over
// these lights; hovering room tone's stop on the rail shows the room tone
// alone: SelectionPanel's ToneNode.)

import type { Channels, LightInfo } from "../../shared/arclamp.ts";
import { isBinary, isOn, requestedOf, switchChannels } from "../../shared/fixtures.ts";
import type { Lemtone } from "../../shared/lemtone.ts";
import { drafts } from "../draft.ts";
import { ColorField } from "./ColorField.tsx";
import { ButtonSwitchField } from "./Field.tsx";

const DARK: Lemtone = { a: 0, b: 0, brightness: 0, fidelity: 1 };

interface Props {
  /** The selected lights. */
  lights: LightInfo[];
  /** The room tone, pending edits and all. */
  template: Record<string, Channels>;
}

export function RoomToneEditor({ lights, template }: Props) {
  const colors = lights.filter((l) => !isBinary(l.type));
  const olds = lights.filter((l) => isBinary(l.type));

  /** Set channels on each light `patch` gives some for, into the pending edits. */
  const set = (patch: (l: LightInfo) => Channels | null, code: string) => {
    const out: Record<string, Channels> = {};
    for (const l of lights) {
      const ch = patch(l);
      if (ch) out[String(l.id)] = ch;
    }
    drafts.setRoomtone(out, code);
  };
  // The color editor's values are the color lights', in order; a change is for some of them.
  const setColor = (patch: Partial<Lemtone>, code: string, which: number[]) => {
    const ch: Channels = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) ch[k] = v;
    const those = new Set(which.map((i) => colors[i]!.id));
    set((l) => (those.has(l.id) ? ch : null), code);
  };
  const setOn = (on: boolean) => set((l) => (isBinary(l.type) ? switchChannels(on) : null), on ? "on" : "off");

  return (
    <>
      {colors.length > 0 && <ColorField values={colors.map((l) => requestedOf(template[String(l.id)], l.type) ?? DARK)} onChange={setColor} types={colors.map((l) => l.type)} />}
      {olds.length > 0 && <ButtonSwitchField label="Old bulbs" values={olds.map((l) => isOn(template[String(l.id)]))} onChange={setOn} />}
    </>
  );
}
