// The scenes drawer, along the bottom of the map, always: the room's scenes
// (shared/scenes.ts), each a button that applies it, lit while the room
// looks like it; and, in each one's menu, its name, its sketch (one in the
// room, with its knobs as they are), its knobs taken from the room again,
// and taking it away. "+ Scene" keeps the room as a scene: its one sketch on
// (but Base Color), with its knobs; with none on, or more than one, a scene
// to give one to.
//
// Applying one outside a show is an edit to the room, as any other
// (draft.ts): previewed till it's applied, or straight in, in live mode.
// Changes to the scenes themselves are the room's, made at once.
//
// While a show's on, the show's row (Transport.tsx) sits above the scenes,
// and a scene applied goes on the show's clock, for everyone, whatever the
// mode (server/show-apply.ts): now, or on the next beat or bar's first, as
// the show's cue mode (beside them) says. The press is put in arclamp's time
// as the finger comes down (rtime.ts), as Tap's is. One waiting for its
// frame is marked so; and the number keys apply them, 1 to 9, away from
// anything typed in.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { pathOf, type Op } from "../../shared/live.ts";
import { isBase, knobsOf, onScene, type Scene as SavedScene, type Scenes } from "../../shared/scenes.ts";
import type { CueMode } from "../../shared/show.ts";
import { drafts } from "../draft.ts";
import { MoreIcon } from "../icons.tsx";
import { rOfEvent } from "../rtime.ts";
import { sendApply, sendScenes, sendTransport, useScene, useScenes, useShowCue, useShowOn, useShowQueued, type Scene } from "../scene.ts";
import { Menu } from "./Menu.tsx";
import { Segmented } from "./Segmented.tsx";
import { press, Transport } from "./Transport.tsx";

const CUES: { value: CueMode; label: string }[] = [
  { value: "now", label: "Now" },
  { value: "beat", label: "Beat" },
  { value: "bar", label: "Bar" },
];

/** The first "Scene n" not taken. */
function nextName(scenes: Scenes): string {
  const taken = new Set(Object.values(scenes.list).map((s) => s.name));
  let n = 1;
  while (taken.has(`Scene ${n}`)) n++;
  return `Scene ${n}`;
}

/** The shaders a scene could have as its sketch: every one in the room but Base Color, and any that failed. */
const choosable = (room: Scene) => room.shaders.filter((s) => s.stage !== "failed" && !isBase(s));

export function ScenesDrawer({ onHeight }: { onHeight: (px: number) => void }) {
  const showOn = useShowOn();
  const dock = useRef<HTMLDivElement>(null);

  // As tall as it is, for the map to keep its own along the bottom above it.
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const measure = () => onHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  return (
    <div className="show-dock" ref={dock}>
      {showOn && <Transport />}
      <ScenesBar />
    </div>
  );
}

function ScenesBar() {
  const scenes = useScenes();
  const room = useScene().data;
  const showOn = useShowOn();
  const cue = useShowCue();
  const queued = useShowQueued();
  const lit = room ? onScene(scenes, room.shaders, room.pools) : null;
  const [error, setError] = useState<string | null>(null);
  const said = (sent: Promise<unknown>) =>
    void sent.then(
      () => setError(null),
      (err: Error) => setError(err.message),
    );
  const send = (ops: Op[]) => said(sendScenes(ops));

  // A scene applied: on the show's clock, as the press came down, in a show; else an edit, as any other.
  const apply = (id: string, e: { timeStamp: number }) => {
    const scene = scenes.list[id];
    if (!scene || !room) return;
    if (showOn) said(sendApply(id, rOfEvent(e)));
    else drafts.applyScene(scene, room);
  };

  // In a show, 1 to 9 apply the scenes in order, away from anything typed in.
  const keys = useRef({ apply, order: scenes.order });
  keys.current = { apply, order: scenes.order };
  useEffect(() => {
    if (!showOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !/^[1-9]$/.test(e.key)) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable], .cm-editor")) return;
      const id = keys.current.order[Number(e.key) - 1];
      if (!id) return;
      keys.current.apply(id, e);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showOn]);

  const create = () => {
    if (!room) return;
    const id = crypto.randomUUID();
    const ops: Op[] = [[pathOf("scenes", "list", id), { name: nextName(scenes) }]];
    const on = choosable(room).filter((s) => !s.muted);
    if (on.length === 1) ops.push([pathOf("scenes", "list", id, "shaders", on[0]!.key), knobsOf(on[0]!, room.pools)]);
    send(ops);
  };

  return (
    <div className="dock-bar scenes-bar">
      {showOn && (
        <Segmented
          className="scene-cue"
          label="How scenes come in"
          options={CUES}
          value={cue}
          onChange={(mode) => said(sendTransport({ do: "cue", mode }))}
        />
      )}
      <div className="scenes" role="group" aria-label="Scenes">
        {scenes.order.map((id, i) => {
          const scene = scenes.list[id];
          return scene && room ? (
            <SceneChip key={id} id={id} n={i + 1} scene={scene} lit={lit === id} queued={queued?.scene === id} show={showOn} room={room} apply={apply} send={send} />
          ) : null;
        })}
        {scenes.order.length === 0 && <span className="scenes-empty">No scenes yet: + Scene keeps the room as one.</span>}
      </div>
      {error && (
        <span className="dock-error" role="alert">
          {error}
        </span>
      )}
      <button className="scene-add" onClick={create} disabled={!room} aria-label="New scene: the room as it is, if one sketch is on">
        + Scene
      </button>
    </div>
  );
}

interface ChipProps {
  id: string;
  n: number;
  scene: SavedScene;
  lit: boolean;
  /** Applied, waiting for its frame. */
  queued: boolean;
  /** A show's on: applied on its clock, as the press comes down. */
  show: boolean;
  room: Scene;
  apply: (id: string, e: { timeStamp: number }) => void;
  send: (ops: Op[]) => void;
}

function SceneChip({ id, n, scene, lit, queued, show, room, apply, send }: ChipProps) {
  const [deleting, setDeleting] = useState(false);
  const keys = Object.keys(scene.shaders);
  const sketch = room.shaders.find((s) => keys.includes(s.key));
  const path = (...more: string[]) => pathOf("scenes", "list", id, ...more);

  const rename = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const name = e.currentTarget.value.trim();
    if (e.key === "Enter" && name && name !== scene.name) send([[path("name"), name]]);
  };

  const what = sketch ? sketch.name : keys.length > 0 ? "a sketch that's left the room" : "no sketch yet";
  const applying = show ? press((e) => apply(id, e)) : { onClick: (e: { timeStamp: number }) => apply(id, e) };
  const label = !sketch ? `${n} ${scene.name}: it has ${what}` : show && n <= 9 ? `${n} ${scene.name}: apply it (${n}), ${what}` : `${n} ${scene.name}: apply it, ${what}`;
  return (
    <span className={`scene-chip${lit ? " lit" : ""}${queued ? " queued" : ""}`}>
      <button className="scene-apply" {...applying} disabled={!sketch} aria-label={label}>
        <small className="mono">{n}</small>
        {scene.name}
      </button>
      <Menu align="start" side="above" className="transport-button" name={`${scene.name}: its name, its sketch`} label={<MoreIcon />}>
        <p className="menu-heading">{scene.name}</p>
        <label className="menu-field">
          <span>Name</span>
          <input className="scene-name" defaultValue={scene.name} maxLength={60} onKeyDown={rename} aria-label="The scene's name (Enter to keep it)" />
        </label>
        <div className="menu-field">
          <span>
            Sketch
            <small>Its knobs come with it, as they are now. {keys.length > 0 && !sketch ? "Its last one has left the room." : ""}</small>
          </span>
        </div>
        {choosable(room).map((s) => (
          <button key={s.key} className={`menu-item${keys.includes(s.key) ? " chosen" : ""}`} onClick={() => send([[path("shaders", s.key), knobsOf(s, room.pools)]])}>
            {s.name}
            {keys.includes(s.key) && " ✓"}
          </button>
        ))}
        {sketch && (
          <button className="menu-item" onClick={() => send([[path("shaders", sketch.key), knobsOf(sketch, room.pools)]])} aria-label="Take knobs from the room: keep its sketch's knobs as the room has them now">
            Take knobs from the room
          </button>
        )}
        {deleting ? (
          <button className="menu-item bad" onClick={() => send([[path()]])}>
            Delete {scene.name}: sure?
          </button>
        ) : (
          <button className="menu-item" onClick={() => setDeleting(true)}>
            Delete…
          </button>
        )}
      </Menu>
    </span>
  );
}
