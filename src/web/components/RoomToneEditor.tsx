// Room tone's parameter, its color, for the selected lights: the color
// editor for the color lights (each change into the pending edits, for the
// lights it's for), and old bulbs switched on or off. When shaders draw
// over these lights, it says so, and holding Peek shows the room tone alone.

import { useEffect, type KeyboardEvent, type PointerEvent } from "react";
import type { Channels, LightInfo } from "../../shared/arclamp.ts";
import { isBinary, isOn, requestedOf, switchChannels } from "../../shared/fixtures.ts";
import type { Lemtone } from "../../shared/lemtone.ts";
import { drafts } from "../draft.ts";
import { InfoIcon } from "../icons.tsx";
import { peek } from "../peek.ts";
import { ColorEditor } from "./ColorEditor.tsx";
import { Segmented } from "./Segmented.tsx";

const DARK: Lemtone = { a: 0, b: 0, brightness: 0, fidelity: 1 };

interface Props {
  /** The selected lights. */
  lights: LightInfo[];
  /** The room tone, pending edits and all. */
  template: Record<string, Channels>;
  /** The shaders drawing over these lights, bottom first. */
  over: string[];
}

export function RoomToneEditor({ lights, template, over }: Props) {
  const colors = lights.filter((l) => !isBinary(l.type));
  const olds = lights.filter((l) => isBinary(l.type));
  const oldOn = olds.filter((l) => isOn(template[String(l.id)])).length;

  // Stop peeking if this goes away mid-hold.
  useEffect(() => () => peek.set(false), []);

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
    <div className="tone-editor">
      {colors.length > 0 && (
        <ColorEditor
          values={colors.map((l) => requestedOf(template[String(l.id)], l.type) ?? DARK)}
          onChange={setColor}
          types={colors.map((l) => l.type)}
        />
      )}

      {olds.length > 0 && (
        <div className="tone-old">
          <div className="field-head">
            <span className="label">Old bulbs</span>
            <span className="mono">{oldOn === 0 ? "all off" : oldOn === olds.length ? "all on" : `${oldOn} of ${olds.length} on`}</span>
          </div>
          <Segmented
            className="stretch"
            label="Old bulbs"
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={oldOn === olds.length ? "on" : oldOn === 0 ? "off" : null}
            onChange={(v) => setOn(v === "on")}
          />
        </div>
      )}

      {over.length > 0 && (
        <div className="note tone-over">
          <InfoIcon />
          <span>{namesOf(over)} draw over these lights, so the room may not show all of this.</span>
          <button className="peek" {...hold} title="Show the room tone alone while you hold this">
            Hold to peek
          </button>
        </div>
      )}
    </div>
  );
}

/** Peeking for as long as it's pressed (or its key held). */
const hold = {
  onPointerDown: (e: PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    peek.set(true);
  },
  onPointerUp: () => peek.set(false),
  onPointerCancel: () => peek.set(false),
  onLostPointerCapture: () => peek.set(false),
  onKeyDown: (e: KeyboardEvent) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      peek.set(true);
    }
  },
  onKeyUp: (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") peek.set(false);
  },
  onBlur: () => peek.set(false),
};

/** "Couch glow", "Couch glow and Sparkle", "Couch glow, Sparkle and 2 more". */
function namesOf(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
