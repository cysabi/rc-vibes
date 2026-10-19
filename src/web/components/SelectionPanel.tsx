// What's selected, in a panel that comes in while anything is: over the left
// of the map on a wide screen, and up from the bottom as a sheet on a narrow
// one, as Google Maps does with a place. The sheet rests at one of three
// heights (just its head, most of what's in it, or the whole screen), and its
// head drags it between them, settling where it's let go. It names
// the selection (the floor, when it's every light on it; its tags, when it's
// exactly whole tags) and says what kinds of light are in it. Then what's
// making their light, as the room builds it: room tone, then each shader up
// the stack that's changing any of them (as arclamp reports, or the preview
// while there are pending edits), joined by a rail as the light builds up
// through them. Each has a switch for whether it's on for these lights (off
// masks it from them) and a handle to drag it to another place among them;
// both are pending edits. Below, off the rail, the shaders that are trying
// to change them but are switched off here (masked, or muted).

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { Channels, LightInfo } from "../../shared/arclamp.ts";
import { baseType, isBinary, isOn, lemtoneOf, requestedOf } from "../../shared/fixtures.ts";
import { colorName, lemtoneCode, lumensText } from "../../shared/lemtone.ts";
import { tagLabel } from "../../shared/tags.ts";
import type { SceneNode, ShaderSketch } from "../../shared/vibes.ts";
import { useLights, useScene } from "../api.ts";
import { drafts, layersOf, reorderWithin, templateOf, useDraft, type Layer } from "../draft.ts";
import { ChevronUpIcon, CloseIcon, GripIcon, OpenIcon } from "../icons.tsx";
import { useFrames } from "../live.ts";
import { useNarrow } from "../narrow.ts";
import { navigate } from "../route.ts";
import { useLayerEffects } from "../sim.ts";
import { RoomToneEditor } from "./RoomToneEditor.tsx";

const NO_NODES: SceneNode[] = [];

const KINDS: Record<string, { one: string; many: string }> = {
  br30: { one: "color bulb", many: "color bulbs" },
  "4x1": { one: "4×1 panel", many: "4×1 panels" },
  relay: { one: "old bulb", many: "old bulbs" },
};

// The sheet's middle height, at most, as a share of the screen.
const HALF = 0.6;
// A sheet let go faster than this (px per ms) was flicked: it goes on to the
// next height that way. Slower, or after a pause this long (ms), it settles at the nearest.
const FLICK = 0.4;
const PAUSE_MS = 100;
// A press on the head that moves less than this (px) is a tap.
const TAP_PX = 4;

/** The heights a sheet rests at: just its head, most of what's in it, the whole screen. */
type Rest = "peek" | "half" | "full";

interface Props {
  /** The floor being shown. */
  floor: number;
  /** The lights on this floor. */
  here: LightInfo[];
  /** The selected ones among them. */
  selected: ReadonlySet<number>;
  /** Whether the map shows the preview of pending edits, rather than the room. */
  previewing: boolean;
  onClose: () => void;
}

export function SelectionPanel({ floor, here, selected, previewing, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);
  const chosen = here.filter((l) => selected.has(l.id));
  const n = chosen.length;

  // What's making these lights' light, bottom of the stack first. A shader's
  // `changing` is what it's trying to change, before its mask (a muted shader
  // is masked from everything). Among the selected lights, what it's
  // actually lighting is that less its mask, and the rest is kept off.
  // Lighting any of them, it's in "Lit by"; trying but kept off them all,
  // it's in "Switched off here"; otherwise it isn't listed.
  const scene = useScene();
  const lights = useLights();
  const draft = useDraft();
  const previewEffects = useLayerEffects();
  const live = scene.data ?? NO_NODES;
  const template = templateOf(live, draft);
  const ids = chosen.map((l) => l.id);
  const stack = layersOf(live, draft);
  const rows: Row[] = [...stack]
    .reverse()
    .map((layer) => {
      const trying = previewing ? previewEffects.get(layer.key) : new Set(layer.node?.changing ?? []);
      const mask = new Set(layer.mask);
      const kept = (id: number) => layer.muted || mask.has(id);
      const aimed = ids.filter((id) => trying?.has(id));
      const lighting = aimed.filter((id) => !kept(id)).length;
      const keptOff = aimed.length - lighting;
      const allKept = ids.every(kept);
      const state: SwitchState =
        aimed.length === 0 ? (allKept ? "off" : "on") : keptOff === 0 ? "on" : lighting === 0 ? "off" : "mixed";
      return { layer, aimed: aimed.length, lighting, keptOff, state, section: lighting > 0 ? "lit" : keptOff > 0 ? "off" : null };
    });

  // A row stays in its section while you preview, so flipping its switch
  // doesn't send it jumping to the other one. Once the pending edits are
  // applied (or discarded), or the selection changes, each goes where it
  // now belongs.
  const selection = ids.join(",");
  const [pins, setPins] = useState<{ selection: string; at: ReadonlyMap<string, Section> }>({ selection: "", at: new Map() });
  const [wasPreviewing, setWasPreviewing] = useState(previewing);
  if (wasPreviewing !== previewing) {
    setWasPreviewing(previewing);
    if (!previewing) setPins({ selection: "", at: new Map() });
  }
  const pinned = pins.selection === selection ? pins.at : NO_PINS;
  const placed = rows.map((r) => ({ ...r, section: pinned.get(r.layer.key) ?? r.section }));

  // The layer whose parameters are open under it, one at a time: room tone's, to start with.
  const [opened, setOpened] = useState<string | null>("roomtone");
  const lit = placed.filter((r) => r.section === "lit");
  const off = placed.filter((r) => r.section === "off");

  /**
   * Switch a shader off for the selected lights (mask them), or back on
   * (unmask them; a muted one is unmuted and masked from every other light,
   * so it's on just here). Pending edits, like a mute.
   */
  const setOn = (row: Row, on: boolean) => {
    if (row.section) setPins({ selection, at: new Map(pinned).set(row.layer.key, row.section) });
    const { layer } = row;
    if (on && layer.muted) {
      const rest = (lights.data?.lights ?? []).map((l) => l.id).filter((id) => !selected.has(id));
      drafts.patchShader(layer.key, { muted: false, mask: rest.sort((a, b) => a - b) });
      return;
    }
    const mask = new Set(layer.mask);
    for (const id of ids) {
      if (on) mask.delete(id);
      else mask.add(id);
    }
    drafts.patchShader(layer.key, { mask: [...mask].sort((a, b) => a - b) });
  };

  // Dragging a shader rearranges just the ones lighting these lights, among their places in the stack.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const listed = lit.map((r) => r.layer.key);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const moved = arrayMove(listed, listed.indexOf(String(active.id)), listed.indexOf(String(over.id)));
    // The list is bottom first; the stack's order is top first.
    drafts.reorder(reorderWithin(stack.map((l) => l.key), moved.reverse()));
  };

  // Whole tags: every light here with the tag is selected.
  const byTag = new Map<string, number[]>();
  for (const l of here) for (const t of l.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), l.id]);
  const whole = [...byTag].filter(([, ids]) => ids.every((id) => selected.has(id)));
  const covered = new Set(whole.flatMap(([, ids]) => ids));
  const exactlyTags = whole.length > 0 && chosen.every((l) => covered.has(l.id));
  const title =
    n === here.length
      ? `${ordinal(floor)} Floor`
      : exactlyTags
        ? listOf(whole.map(([t]) => tagLabel(t)).sort((a, b) => a.localeCompare(b)))
        : n === 1
      ? `${capitalized(kindOf(chosen[0]!).one)} ${chosen[0]!.id}`
      : `${n} lights`;

  const kinds = new Map<string, number>();
  for (const l of chosen) kinds.set(baseType(l.type), (kinds.get(baseType(l.type)) ?? 0) + 1);
  const breakdown = [...kinds].map(([type, count]) => {
    const kind = KINDS[type] ?? { one: type, many: type };
    return `${count} ${count === 1 ? kind.one : kind.many}`;
  });


  // As a sheet, the heights it rests at: its head (and the safe area under
  // it); up to HALF the screen, or less when that's all of it; the screen.
  const narrow = useNarrow();
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<Record<Rest, number> | null>(null);
  useLayoutEffect(() => {
    if (!narrow) return;
    const el = panel.current!;
    const app = el.parentElement!;
    const measure = () => {
      const peek = head.current!.offsetHeight + (parseFloat(getComputedStyle(el).paddingBottom) || 0);
      const full = app.clientHeight;
      const half = Math.max(peek, Math.min(peek + body.current!.scrollHeight, full * HALF));
      setHeights((h) => (h && h.peek === peek && h.half === half && h.full === full ? h : { peek, half, full }));
    };
    measure();
    // Its head and what's in it change size as the selection (or what they look like) does.
    const watch = new ResizeObserver(measure);
    watch.observe(app);
    watch.observe(head.current!);
    for (const child of body.current!.children) watch.observe(child);
    return () => watch.disconnect();
  });

  // It opens at its head; its head drags it, following the finger. Let go,
  // it settles at the nearest of its heights, or flicked, at the next one
  // the way it was flicked. A tap on its head, resting there, opens it to the
  // middle. The height mid-drag is kept in a ref too, as a quick flick can
  // let go before React re-renders.
  const [rest, setRest] = useState<Rest>("peek");
  const [dragged, setDragged] = useState<number | null>(null);
  const grip = useRef<{ y: number; from: number; at: number; lastY: number; lastT: number; speed: number; moved: boolean } | null>(null);
  const grab = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!narrow || !heights || (e.target as Element).closest("button")) return;
      const from = panel.current!.offsetHeight;
      grip.current = { y: e.clientY, from, at: from, lastY: e.clientY, lastT: e.timeStamp, speed: 0, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      // A drag, not a text selection.
      e.preventDefault();
    },
    onPointerMove: (e: PointerEvent) => {
      const g = grip.current;
      if (!g || !heights) return;
      if (Math.abs(e.clientY - g.y) > TAP_PX) g.moved = true;
      if (!g.moved) return;
      // Upward is taller; px per ms, eased so one jittery move doesn't decide a flick.
      const dt = Math.max(1, e.timeStamp - g.lastT);
      g.speed = 0.6 * ((g.lastY - e.clientY) / dt) + 0.4 * g.speed;
      [g.lastY, g.lastT] = [e.clientY, e.timeStamp];
      g.at = Math.min(heights.full, Math.max(heights.peek, g.from - (e.clientY - g.y)));
      setDragged(g.at);
    },
    onPointerUp: (e: PointerEvent) => {
      const g = grip.current;
      grip.current = null;
      setDragged(null);
      if (!g || !heights) return;
      if (!g.moved) {
        if (rest === "peek") setRest("half");
        return;
      }
      const speed = e.timeStamp - g.lastT > PAUSE_MS ? 0 : g.speed;
      // Shortest first.
      const rests = (["peek", "half", "full"] as const).filter((r, i, all) => i === 0 || heights[r] > heights[all[i - 1]!]);
      const nearest = rests.reduce((best, r) => (Math.abs(heights[r] - g.at) < Math.abs(heights[best] - g.at) ? r : best));
      if (speed > FLICK) setRest(rests.find((r) => heights[r] > g.at) ?? "full");
      else if (speed < -FLICK) setRest([...rests].reverse().find((r) => heights[r] < g.at) ?? "peek");
      else setRest(nearest);
    },
    onPointerCancel: () => {
      grip.current = null;
      setDragged(null);
    },
  };
  const sheet = narrow && heights;

  // As a sheet, its height lifts the map's bottom controls clear of it
  // (--sheet-h), up to its middle height: taller, they stay put and it rises over them.
  const lift = sheet ? heights.half : Infinity;
  useLayoutEffect(() => {
    const el = panel.current!;
    const app = el.parentElement!;
    const measure = () => app.style.setProperty("--sheet-h", `${Math.min(el.offsetHeight, lift)}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      app.style.removeProperty("--sheet-h");
    };
  }, [lift]);

  return (
    <section
      ref={panel}
      className={["selection-panel", sheet && dragged !== null && "dragging", sheet && rest === "full" && dragged === null && "full"].filter(Boolean).join(" ")}
      aria-label="Selection"
      style={sheet ? { height: dragged ?? heights[rest] } : undefined}
    >
      <div className="selection-head" ref={head} {...grab}>
        <span className="selection-grabber" aria-hidden="true" />
        <div className="selection-title">
          <h2>{title}</h2>
          {/* One light: its title already says what it is, so here, its tags and what it's showing. */}
          <p className="muted">{n === 1 ? <LightNow light={chosen[0]!} /> : breakdown.join(" · ")}</p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Let go of the selection" title="Let go of the selection">
          <CloseIcon />
        </button>
      </div>
      <div className="selection-body" ref={body}>
        <section className="selection-section">
          {/* The rows read in the order light builds up: room tone, then each shader over what's above it. */}
          <h3 className="lit-by">Lit by</h3>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={listed} strategy={verticalListSortingStrategy}>
              <ol className="layers">
                {/* Always the base, the rail's source: it can't move or be switched off. Its
                    parameter, the color, opens under it (open to start with). */}
                <li className={opened === "roomtone" ? "layer base open" : "layer base"}>
                  {/* All of its head (what lights up) opens and closes it; the button's for the keyboard. */}
                  <div className="layer-head" onClick={() => setOpened(opened === "roomtone" ? null : "roomtone")}>
                    <span className="layer-grip" aria-hidden="true" />
                    <span className="layer-node" aria-hidden="true" />
                    <button className="layer-text layer-toggle" aria-expanded={opened === "roomtone"}>
                      <span className="layer-name">Room tone</span>
                      <span className="layer-meta">{toneSummary(chosen, template)}</span>
                    </button>
                    <span className="layer-chevron" aria-hidden="true">
                      <ChevronUpIcon />
                    </span>
                  </div>
                  {opened === "roomtone" && <RoomToneEditor lights={chosen} template={template} over={lit.map((r) => r.layer.name)} />}
                </li>
                {lit.map((row) => (
                  <SortableRow key={row.layer.key} row={row} n={n} onSwitch={(on) => setOn(row, on)} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </section>
        {off.length > 0 && (
          // Bypassed for these lights, so off the rail.
          <section className="selection-section">
            <h3 className="lit-by">Switched off here</h3>
            <ol className="layers bypassed">
              {off.map((row) => (
                <li key={row.layer.key} className={row.state === "off" ? "layer off" : "layer"}>
                  <span className="layer-grip" aria-hidden="true" />
                  <RowParts row={row} n={n} onSwitch={(on) => setOn(row, on)} />
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </section>
  );
}

type Section = "lit" | "off";
type SwitchState = "on" | "off" | "mixed";
const NO_PINS: ReadonlyMap<string, Section> = new Map();

/** A shader as the selection sees it. */
interface Row {
  layer: Layer;
  /** Of the selected lights: how many it's trying to change, and of those, how many it's lighting and how many it's kept off. */
  aimed: number;
  lighting: number;
  keptOff: number;
  /** Its switch: on for these lights, off, or off for some of them. */
  state: SwitchState;
  section: Section | null;
}

interface RowProps {
  row: Row;
  /** How many lights are selected. */
  n: number;
  onSwitch: (on: boolean) => void;
}

/** A shader lighting the selection: draggable by its handle to another place among them. */
function SortableRow({ row, n, onSwitch }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.layer.key });
  return (
    <li
      ref={setNodeRef}
      className={`layer${row.state === "off" ? " off" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="layer-grip" aria-label={`Move ${row.layer.name}`} {...attributes} {...listeners}>
        <GripIcon />
      </button>
      <RowParts row={row} n={n} onSwitch={onSwitch} />
    </li>
  );
}

/**
 * A shader's stop on the rail, who wrote it and what it's doing here, and a
 * switch for whether it's on for these lights: off masks it from them (the
 * rest of the room is untouched); on unmasks them, or for a muted shader,
 * unmutes it and masks it from everywhere else.
 */
function RowParts({ row, n, onSwitch }: RowProps) {
  const { layer, state } = row;
  const tip =
    state === "on"
      ? `${layer.name} is on for these lights. Switch it off to keep it off them; the rest of the room isn't affected.`
      : layer.muted
        ? `${layer.name} is muted everywhere. Switch it on to unmute it just for these lights; it stays off everywhere else.`
        : state === "off"
          ? `${layer.name} is kept off these lights. Switch it back on for them.`
          : `${layer.name} is kept off ${row.keptOff} of the ${row.aimed} lights here it's trying to change. Switch it on for all of them.`;
  const sketch = layer.node.sketch;
  return (
    <>
      <span className="layer-node" aria-hidden="true" />
      <span className="layer-text">
        <span className="layer-name">
          {layer.name}
          {sketch?.deleted && <span className="layer-badge">deleted</span>}
          {sketch?.edited && (
            <span className="layer-badge" title="Changed since vibes built it, so it isn't what its sketch's commit says">
              edited
            </span>
          )}
        </span>
        <span className="layer-meta">{layerMeta(row, n)}</span>
      </span>
      {sketch?.name != null && <OpenSketch sketch={sketch} />}
      <button
        className={`switch ${state}`}
        role="switch"
        aria-checked={state === "on" ? true : state === "off" ? false : "mixed"}
        aria-label={`${layer.name}, on these lights`}
        title={tip}
        onClick={() => onSwitch(state !== "on")}
      >
        <span className="switch-knob" />
      </button>
    </>
  );
}

/** What room tone sets these lights to: one lemtone (or on/off, for old bulbs) when they're alike, else "mixed". */
function toneSummary(lights: LightInfo[], template: Record<string, Channels>): string {
  const colors = new Set<string>();
  const oldBulbs = new Set<string>();
  for (const l of lights) {
    const ch = template[String(l.id)];
    if (isBinary(l.type)) {
      oldBulbs.add(isOn(ch) ? "on" : "off");
    } else {
      const t = requestedOf(ch, l.type);
      colors.add(t && t.brightness > 0 ? lemtoneCode(t) : "off");
    }
  }
  const one = (set: Set<string>) => (set.size === 1 ? [...set][0]! : "mixed");
  const parts: string[] = [];
  if (colors.size > 0) parts.push(one(colors));
  if (oldBulbs.size > 0) parts.push(colors.size > 0 ? `old bulbs ${one(oldBulbs)}` : one(oldBulbs));
  return parts.join(" · ");
}

/** Who wrote a shader, and what it's doing to the selection: changing some of it, or what it would change if it weren't kept off. */
/**
 * The sketch a shader was built from, opened: at the commit it was built
 * from, or, deleted, among the deleted ones in the library, to restore.
 */
function OpenSketch({ sketch }: { sketch: ShaderSketch }) {
  const label = sketch.deleted ? `Find ${sketch.name} among the deleted sketches` : `Open ${sketch.name} at ${sketch.commit.slice(0, 7)}, the commit this was built from`;
  return (
    <button
      className="icon-button layer-open"
      aria-label={label}
      title={label}
      onClick={() => navigate(sketch.deleted ? `/sketches?deleted=${sketch.id}` : `/sketches/${sketch.id}?commit=${sketch.commit}`)}
    >
      <OpenIcon />
    </button>
  );
}

function layerMeta({ layer, aimed, lighting, keptOff }: Row, n: number): string {
  // Built from a sketch: which commit first.
  const parts = layer.node.sketch ? [layer.node.sketch.commit.slice(0, 7), layer.by] : [layer.by];
  if (layer.muted) parts.push("muted");
  // Out of the whole selection, which the head already counts.
  const of = (k: number, verb: string) => (k === n ? (n === 1 ? `${verb} this light` : `${verb} all ${n}`) : `${verb} ${k}`);
  if (lighting > 0) {
    parts.push(of(lighting, "changing"));
    if (keptOff > 0) parts.push(`kept off ${keptOff}`);
  } else if (aimed > 0) {
    parts.push(of(aimed, "would change"));
  } else {
    parts.push(n === 1 ? "kept off this light" : "kept off these lights");
  }
  return parts.join(" · ");
}

/** A light's tags and what it's showing right now ("Couches · 2700 K · 207 lm", "Couches · off"), kept up a few times a second. */
function LightNow({ light }: { light: LightInfo }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, []);
  const channels = useFrames().latest()?.lights.get(light.id);
  let state: string;
  if (isBinary(light.type)) state = isOn(channels) ? "on" : "off";
  else {
    const t = lemtoneOf(channels, light.type);
    state = t && t.brightness > 0 ? `${colorName(t.a, t.b)} · ${lumensText(t.brightness)}` : "off";
  }
  const tags = (light.tags ?? []).map(tagLabel).sort((a, b) => a.localeCompare(b));
  return [...tags, state].join(" · ");
}

function kindOf(l: LightInfo) {
  return KINDS[baseType(l.type)] ?? { one: l.type, many: l.type };
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** "Couches", "Couches & Lobby", "Couches, Kitchen & Lobby", "Couches, Kitchen & 3 more". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} & ${names.length - 2} more`;
}
