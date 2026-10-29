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
// Changes to the scenes themselves are the room's, made at once. While a
// show's on, the show's row (Transport.tsx) sits above the scenes.

import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { pathOf, type Op } from "../../shared/live.ts";
import { isBase, knobsOf, onScene, type Scene as SavedScene, type Scenes } from "../../shared/scenes.ts";
import { drafts } from "../draft.ts";
import { MoreIcon } from "../icons.tsx";
import { sendScenes, useScene, useScenes, useShowOn, type Scene } from "../scene.ts";
import { Menu } from "./Menu.tsx";
import { Transport } from "./Transport.tsx";

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
  const lit = room ? onScene(scenes, room.shaders, room.pools) : null;
  const [error, setError] = useState<string | null>(null);
  const send = (ops: Op[]) =>
    void sendScenes(ops).then(
      () => setError(null),
      (err: Error) => setError(err.message),
    );

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
      <div className="scenes" role="group" aria-label="Scenes">
        {scenes.order.map((id, i) => {
          const scene = scenes.list[id];
          return scene && room ? <SceneChip key={id} id={id} n={i + 1} scene={scene} lit={lit === id} room={room} send={send} /> : null;
        })}
        {scenes.order.length === 0 && <span className="scenes-empty">No scenes yet: + Scene keeps the room as one.</span>}
      </div>
      {error && (
        <span className="dock-error" role="alert" title={error}>
          {error}
        </span>
      )}
      <button className="scene-add" onClick={create} disabled={!room} title="A new scene: the room as it is, if one sketch is on">
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
  room: Scene;
  send: (ops: Op[]) => void;
}

function SceneChip({ id, n, scene, lit, room, send }: ChipProps) {
  const [deleting, setDeleting] = useState(false);
  const keys = Object.keys(scene.shaders);
  const sketch = room.shaders.find((s) => keys.includes(s.key));
  const path = (...more: string[]) => pathOf("scenes", "list", id, ...more);

  const rename = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const name = e.currentTarget.value.trim();
    if (e.key === "Enter" && name && name !== scene.name) send([[path("name"), name]]);
  };

  const what = sketch ? sketch.name : keys.length > 0 ? "a sketch that's left the room" : "no sketch yet";
  return (
    <span className={`scene-chip${lit ? " lit" : ""}`}>
      <button className="scene-apply" onClick={() => drafts.applyScene(scene, room)} disabled={!sketch} title={sketch ? `Apply ${scene.name}: ${what}` : `${scene.name} has ${what}`}>
        <small className="mono">{n}</small>
        {scene.name}
      </button>
      <Menu align="start" side="above" className="transport-button" title={`${scene.name}: its name, its sketch`} label={<MoreIcon />}>
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
          <button className="menu-item" onClick={() => send([[path("shaders", sketch.key), knobsOf(sketch, room.pools)]])} title="Keep its sketch's knobs as the room has them now">
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
