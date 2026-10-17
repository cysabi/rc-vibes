// The left panel: the room tone, the base light under every shader. With
// lights selected on the map it edits just those; otherwise the whole room.
// Changes are pending until applied: the map previews them as you drag.

import { useState } from "react";
import type { Channels, LightInfo, RoomTemplate } from "../../shared/arclamp.ts";
import { baseType, channelsFor, isBinary, isOn, lemtoneOf, requestedOf, switchChannels } from "../../shared/fixtures.ts";
import { lemtoneCode, lemtoneCss, type Lemtone } from "../../shared/lemtone.ts";
import type { SceneNode } from "../../shared/vibes.ts";
import { useScene } from "../api.ts";
import { drafts, layersOf, templateOf, useDraft } from "../draft.ts";
import { FLOORS } from "../floors.ts";
import { DEFAULT_PICK, fromLemtone, LemtonePicker, toLemtone, type PickerValue } from "./LemtonePicker.tsx";
import { Segmented } from "./Segmented.tsx";
import type { SelectMode } from "./RoomMap.tsx";

const GROUPS: { type: string; one: string; many: string; title: string }[] = [
  { type: "br30", one: "color bulb", many: "color bulbs", title: "Color bulbs" },
  { type: "4x1", one: "4×1 panel", many: "4×1 panels", title: "4×1 panels" },
  { type: "relay", one: "old bulb", many: "old bulbs", title: "Old bulbs" },
];

const count = (n: number, g: { one: string; many: string }) => `${n} ${n === 1 ? g.one : g.many}`;

const NO_NODES: SceneNode[] = [];

interface Props {
  lights: LightInfo[];
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], mode: SelectMode) => void;
}

export function RoomTone({ lights, selected, onSelect }: Props) {
  const scene = useScene();
  const draft = useDraft();
  const live = scene.data ?? NO_NODES;
  const template = templateOf(live, draft);
  const shadersAbove = layersOf(live, draft).filter((l) => !l.muted && l.status !== "deleted").length;
  const scoped = selected.size > 0;
  const chosen = scoped ? lights.filter((l) => selected.has(l.id)) : lights;
  const byType = new Map<string, LightInfo[]>();
  for (const l of chosen) byType.set(baseType(l.type), [...(byType.get(baseType(l.type)) ?? []), l]);
  // Color lights take the picker; old bulbs only switch, so they get On/Off.
  const colorLights = chosen.filter((l) => !isBinary(l.type));
  const oldBulbs = chosen.filter((l) => isBinary(l.type));

  // Open on whatever the first color light in scope is set to.
  const [pick, setPick] = useState<PickerValue>(() => {
    const first = chosen.find((l) => !isBinary(l.type));
    const t = first && requestedOf(template[String(first.id)], first.type);
    return t ? fromLemtone(t) : DEFAULT_PICK;
  });
  const edit = roomtoneEdit(chosen);

  const ids = (keep: (l: LightInfo) => boolean) => lights.filter(keep).map((l) => l.id);
  // Quick ways to choose what to change: everything, a floor, or a kind of light.
  const scopes = [
    { key: "all", title: "All lights", ids: [] as number[] },
    ...FLOORS.map((f) => ({ key: `floor-${f.id}`, title: f.name, ids: ids((l) => l.coords?.floor === f.id) })).filter(
      (s) => s.ids.length > 0,
    ),
    ...GROUPS.map((g) => ({ key: g.type, title: g.title, ids: ids((l) => baseType(l.type) === g.type) })),
  ];
  // The current scope, or null for a hand-picked selection.
  const current = !scoped
    ? "all"
    : (scopes.find((s) => s.ids.length === selected.size && s.ids.every((id) => selected.has(id)))?.key ?? null);
  const breakdown = GROUPS.filter((g) => byType.has(g.type))
    .map((g) => count(byType.get(g.type)!.length, g))
    .join(", ");

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Room tone</h2>
      </div>
      <p className="hint">The base light under every shader.</p>

      <div className="scope">
        <p className="scope-nav">
          {scopes.map((s, i) => (
            <span key={s.key}>
              {i > 0 && <span className="muted"> · </span>}
              {current === s.key ? (
                <strong aria-current="true">{s.title}</strong>
              ) : (
                <button className="link" onClick={() => onSelect(s.ids, "replace")}>
                  {s.title}
                </button>
              )}
            </span>
          ))}
        </p>
        <Palette lights={chosen} template={template} />
        <p className="hint">
          {current === null
            ? `${chosen.length} selected on the map: ${breakdown}.`
            : current === "all"
              ? `${breakdown}. Click or drag on the map to choose particular lights.`
              : `${chosen.length} lights.`}
        </p>
        {isMixed(chosen, template) && <p className="hint">These lights are set differently; a change here sets them all alike.</p>}
      </div>

      {colorLights.length > 0 && (
        <LemtonePicker
          value={pick}
          onChange={(v) => {
            setPick(v);
            edit.apply(toLemtone(v));
          }}
          onCommit={(v) => edit.apply(toLemtone(v))}
        />
      )}
      {oldBulbs.length > 0 && <OnOff chosen={oldBulbs} template={template} onSet={edit.setOn} />}

      <div className="tone-foot">
        {shadersAbove > 0 && (
          <p className="hint">
            {shadersAbove === 1 ? "A shader draws" : `${shadersAbove} shaders draw`} over the room tone, so the room may not show
            all of this.
          </p>
        )}
      </div>
    </div>
  );
}

/** The room tone's colors as a strip, one sliver per light in id order. */
function Palette({ lights, template }: { lights: LightInfo[]; template: RoomTemplate["lights"] }) {
  return (
    <span className="palette" aria-hidden="true">
      {lights.map((l) => (
        <span key={l.id} style={{ background: lemtoneCss(lemtoneOf(template[String(l.id)], l.type)) }} />
      ))}
    </span>
  );
}

/** Whether lights of the same kind are set to visibly different room tones. */
function isMixed(lights: LightInfo[], template: RoomTemplate["lights"]): boolean {
  const firstOf = new Map<string, Channels | undefined>();
  for (const l of lights) {
    const ch = template[String(l.id)];
    if (!firstOf.has(l.type)) {
      firstOf.set(l.type, ch);
      continue;
    }
    const ref = firstOf.get(l.type);
    if (isBinary(l.type)) {
      if (isOn(ch) !== isOn(ref)) return true;
      continue;
    }
    const dark: Lemtone = { a: 0, b: 0, brightness: 0, fidelity: 1 };
    const a = requestedOf(ch, l.type) ?? dark;
    const b = requestedOf(ref, l.type) ?? dark;
    if (
      Math.abs(a.a - b.a) + Math.abs(a.b - b.b) > 0.01 ||
      Math.abs(a.brightness - b.brightness) > 0.01 * Math.max(a.brightness, b.brightness, 0.01) ||
      Math.abs(a.fidelity - b.fidelity) > 0.02
    )
      return true;
  }
  return false;
}

function OnOff({
  chosen,
  template,
  onSet,
}: {
  chosen: LightInfo[];
  template: RoomTemplate["lights"];
  onSet: (on: boolean) => void;
}) {
  const on = chosen.filter((l) => isOn(template[String(l.id)])).length;
  return (
    <div className="onoff">
      <p className="hint">Old bulbs only switch on and off. {on === 0 ? "All off." : on === chosen.length ? "All on." : `${on} on.`}</p>
      <Segmented
        label="Old bulbs"
        options={[
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
        value={on === chosen.length ? "on" : on === 0 ? "off" : null}
        onChange={(v) => onSet(v === "on")}
      />
    </div>
  );
}

/** Room tone changes for a set of lights, into the pending edits. */
function roomtoneEdit(chosen: LightInfo[]) {
  return {
    apply(t: Lemtone) {
      const lights: Record<string, Channels> = {};
      for (const l of chosen) {
        const ch = channelsFor(t, l.type);
        if (ch) lights[String(l.id)] = ch;
      }
      drafts.setRoomtone(lights, lemtoneCode(t));
    },
    setOn(on: boolean) {
      const lights: Record<string, Channels> = {};
      for (const l of chosen) if (isBinary(l.type)) lights[String(l.id)] = switchChannels(on);
      drafts.setRoomtone(lights, on ? "on" : "off");
    },
  };
}
