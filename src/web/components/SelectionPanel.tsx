// What's selected, in a panel that comes in while anything is: over the left
// of the map on a wide screen, and up from the bottom as a sheet on a narrow
// one, as Google Maps does with a place. The sheet rests at one of three
// heights (just its head, most of what's in it, or the whole screen), and its
// head drags it between them, settling where it's let go. It names
// the selection (the floor, when it's every light on it; its tags, when it's
// exactly whole tags) and says what kinds of light are in it. Then what's on
// these lights, as the room builds their light: room tone, then each shader
// up the stack that's about any of them (its home, or where its code's lit),
// joined by a rail as the light builds up through them: in the room, on its
// way in, or one you're adding. Each has a switch for whether it's on for
// these lights and a handle to drag it to another place among them; both are
// pending edits. (One that couldn't go in has neither.)
// Each shader's ⋯ opens it in the panel in place of the selection
// (ShaderPanel.tsx).

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
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { Channels, LightInfo } from "../../shared/arclamp.ts";
import { baseType, isBinary, isOn, lemtoneOf, requestedOf } from "../../shared/fixtures.ts";
import { colorName, lemtoneCode, lumensText } from "../../shared/lemtone.ts";
import { tagLabel } from "../../shared/tags.ts";

import { useBranchHead, useLights, useStatus } from "../api.ts";
import {
  changeable,
  drafts,
  layerOf,
  layersOf,
  reachOf,
  removedOf,
  reorderWithin,
  statusOf,
  switchFor,
  switchState,
  templateOf,
  useDraft,
  type Adding,
  type Layer,
  type LayerKey,
  type SwitchState,
} from "../draft.ts";
import { ChevronUpIcon, CloseIcon, GripIcon, MoreIcon, PlusIcon } from "../icons.tsx";
import { useFrames } from "../live.ts";
import { useNarrow } from "../narrow.ts";
import { useScene, type Scene } from "../scene.ts";
import { commitName, listOf, ordinal } from "../words.ts";
import { AddSketch } from "./AddSketch.tsx";
import { Reveal } from "./Reveal.tsx";
import { RoomToneEditor } from "./RoomToneEditor.tsx";
import { AddingBody, AddingTitle, ComingBody, ComingTitle, ShaderBody, ShaderTitle } from "./ShaderPanel.tsx";

const NO_SCENE: Scene = { shaders: [], roomtone: null };

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
  /** The shader open in place of the selection, if one is. */
  shader: LayerKey | null;
  onShader: (key: LayerKey | null) => void;
  onClose: () => void;
}

export function SelectionPanel({ floor, here, selected, shader, onShader, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);
  const chosen = here.filter((l) => selected.has(l.id));
  const n = chosen.length;

  // What's on these lights, bottom of the stack first: each shader whose
  // home (or, with none, where its code has lit: reachOf) takes in any of
  // them. A row only moves if you move it. Its switch is whether it's on for
  // these lights.
  const scene = useScene();
  const lights = useLights();
  const draft = useDraft();
  const live = scene.data ?? NO_SCENE;
  const template = templateOf(live, draft);
  const ids = chosen.map((l) => l.id);
  const all = (lights.data?.lights ?? []).map((l) => l.id);
  const stack = layersOf(live, draft);
  // And the ones you're taking out (when you apply), where they are, to keep after all.
  const going = new Set(removedOf(live, draft));
  const shown = withGoing(stack, [...going].flatMap((key) => layerOf(live, draft, key) ?? []), live);
  const onThese = [...shown].reverse().filter((layer) => reachOf(layer).some((id) => selected.has(id)));
  const rows: Row[] = onThese.map((layer) => ({ layer, state: switchState(layer, ids) }));

  // The layer whose parameters are open under it, one at a time: room tone's, to start with.
  const [opened, setOpened] = useState<string | null>("roomtone");
  // Picking a sketch to add to these lights.
  const [picking, setPicking] = useState(false);
  const status = useStatus();
  const add = (sketch: { id: string; name: string }) => {
    setPicking(false);
    const home = new Set(ids);
    // From main, for now: there's no picking a branch yet.
    drafts.add({ sketchId: sketch.id, sketchName: sketch.name, branch: "main", home: ids, mask: all.filter((id) => !home.has(id)) });
  };

  // The shader open in place of the selection: one in the room, one on its way in, or one you're adding.
  const inPanel = shader ? layerOf(live, draft, shader) : null;
  const openLayer = inPanel?.stage === "live" ? inPanel : null;
  const openComing = inPanel?.stage === "building" || inPanel?.stage === "failed" ? inPanel.instance : null;
  const openAdding = inPanel?.adding ?? null;

  /** A shader switched off for these lights, or on: pending edits, like a mute. */
  const setOn = (row: Row, on: boolean) => drafts.patchShader(row.layer.key, switchFor(row.layer, ids, on, all));

  // Dragging a shader rearranges just the ones on these lights, among their places in the stack.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const listed = rows.filter((r) => changeable(r.layer) && !going.has(r.layer.key)).map((r) => r.layer.key);
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
        {openLayer ? (
          <ShaderTitle layer={openLayer} onBack={() => onShader(null)} />
        ) : openComing ? (
          <ComingTitle instance={openComing} onBack={() => onShader(null)} />
        ) : openAdding ? (
          <AddingTitle adding={openAdding} onBack={() => onShader(null)} />
        ) : (
          <div className="selection-title">
            <h2>{title}</h2>
            {/* One light: its title already says what it is, so here, its tags and what it's showing. */}
            <p className="muted">{n === 1 ? <LightNow light={chosen[0]!} /> : breakdown.join(" · ")}</p>
          </div>
        )}
        <button className="icon-button" onClick={onClose} aria-label="Let go of the selection" title="Let go of the selection">
          <CloseIcon />
        </button>
      </div>
      <div className="selection-body" ref={body}>
        {openLayer ? (
          <ShaderBody
            layer={openLayer}
            stack={stack}
            removing={draft.removed.includes(openLayer.key)}
            lights={lights.data?.lights ?? []}
            selected={ids}
            onGone={() => onShader(null)}
          />
        ) : openComing ? (
          <ComingBody instance={openComing} lights={lights.data?.lights ?? []} onRetried={onShader} />
        ) : openAdding ? (
          <AddingBody adding={openAdding} lights={lights.data?.lights ?? []} onGone={() => onShader(null)} />
        ) : (
          <>
            <section className="selection-section">
              {/* The rows read in the order light builds up: room tone, then each shader over what's above it. */}
              <h3 className="lit-by">On these lights</h3>
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
                      <Reveal open={opened === "roomtone"}>
                        <RoomToneEditor lights={chosen} template={template} over={rows.filter((r) => r.state !== "off" && r.layer.script !== "" && !going.has(r.layer.key)).map((r) => r.layer.name)} />
                      </Reveal>
                    </li>
                    {rows.map((row) =>
                      going.has(row.layer.key) ? (
                        <GoingRow key={row.layer.key} layer={row.layer} />
                      ) : changeable(row.layer) ? (
                        <SortableRow
                          key={row.layer.key}
                          row={row}
                          onSwitch={(on) => setOn(row, on)}
                          onOpen={() => onShader(row.layer.key)}
                          details={detailsOf(row.layer)}
                          opened={opened === row.layer.key}
                          onToggle={() => setOpened(opened === row.layer.key ? null : row.layer.key)}
                        />
                      ) : (
                        <FailedRow key={row.layer.key} layer={row.layer} onOpen={() => onShader(row.layer.key)} />
                      ),
                    )}
                    {/* And, last, room for another (while sketches are on). */}
                    {status.data?.sketches && (
                      <li className="layer add-row">
                        <button className="add-row-button" onClick={() => setPicking(true)}>
                          <span className="layer-grip" aria-hidden="true" />
                          <span className="layer-node" aria-hidden="true">
                            <PlusIcon />
                          </span>
                          <span className="layer-name">Add sketch</span>
                        </button>
                      </li>
                    )}
                  </ol>
                </SortableContext>
              </DndContext>
            </section>
            <AddSketch open={picking} lights={n} onPick={add} onClose={() => setPicking(false)} />
          </>
        )}
      </div>
    </section>
  );
}

/** A shader as the selection sees it. */
interface Row {
  layer: Layer;
  /** Its switch: on for these lights, off, or on for some of them. */
  state: SwitchState;
}

interface RowProps {
  row: Row;
  /** Its switch, for these lights. */
  onSwitch: (on: boolean) => void;
  /** Open it, in place of the selection. */
  onOpen: () => void;
  /** What it shows under its row when that's opened (detailsOf), if anything. */
  details: ReactNode | null;
  opened: boolean;
  onToggle: () => void;
}

/**
 * What a shader shows under its row, opened, as room tone shows its color:
 * its parameters, once shaders have any. Nothing yet, for any of them.
 */
function detailsOf(_layer: Layer): ReactNode | null {
  return null;
}

/**
 * A shader on these lights: draggable by its handle to another place among
 * them. One with something to show opens and closes it from anywhere on its
 * head, as room tone's does (its buttons still do their own things).
 */
function SortableRow(props: RowProps) {
  const { row, details, opened, onToggle } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.layer.key });
  const expandable = details !== null;
  const open = opened && expandable;
  // Not in the room yet: on its way in, or yours to add (previewed once it's built).
  const { stage, adding } = row.layer;
  const coming = stage === "live" ? "" : stage === "adding" ? (adding?.build?.state === "built" ? " coming adding built" : " coming adding") : " coming";
  const head = (
    <>
      <button className="layer-grip" aria-label={`Move ${row.layer.name}`} {...attributes} {...listeners}>
        <GripIcon />
      </button>
      <RowParts {...props} />
    </>
  );
  return (
    <li
      ref={setNodeRef}
      className={`layer${coming}${row.state === "off" ? " off" : ""}${expandable ? " expandable" : ""}${open ? " open" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {expandable ? (
        <div className="layer-head" onClick={(e) => !(e.target as Element).closest("button") && onToggle()}>
          {head}
        </div>
      ) : (
        head
      )}
      {expandable && (
        <Reveal open={open}>
          <div className="layer-details">{details}</div>
        </Reveal>
      )}
    </li>
  );
}

/**
 * A shader's stop on the rail: its name, what's become of it, its ⋯ to
 * open it, a switch for whether it's on for these lights (off here leaves the
 * rest of the room as it is; on, for one that's off everywhere, is on for
 * just these), and, at the end, under room tone's chevron, a toggle for what
 * it shows under its row, or, if it shows nothing, a quiet dot in its place,
 * so every row ends in the same column.
 */
function RowParts({ row, onSwitch, onOpen, details, opened, onToggle }: RowProps) {
  const { layer, state } = row;
  const tip =
    state === "on"
      ? `${layer.name} is on for these lights. Switch it off here; the rest of the room isn't affected.`
      : layer.muted
        ? `${layer.name} is off. Switch it on for just these lights.`
        : state === "off"
          ? `${layer.name} is off for these lights. Switch it back on for them.`
          : `${layer.name} is on for some of these lights. Switch it on for all of them.`;
  const sketch = layer.sketch;
  const meta = metaOf(row);
  return (
    <>
      <span className="layer-node" aria-hidden="true" />
      <span className="layer-text">
        <span className="layer-name">
          {layer.name}
          {/* Not built by vibes (no stamp): made in rclamp some other way. */}
          {!sketch && (
            <span className="layer-badge external" title="Made outside vibes, not from a sketch">
              external
            </span>
          )}
          {sketch?.deleted && <span className="layer-badge">deleted</span>}
          {sketch?.edited && (
            <span className="layer-badge" title="Changed since vibes built it, so it isn't what its sketch's commit says">
              edited
            </span>
          )}
        </span>
        {layer.adding ? <AddingMeta adding={layer.adding} row={row} /> : meta && <span className="layer-meta">{meta}</span>}
      </span>
      <button className="icon-button layer-open" aria-label={`More for ${layer.name}`} title={`More for ${layer.name}`} onClick={onOpen}>
        <MoreIcon />
      </button>
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
      {details !== null ? (
        <button className="layer-chevron" aria-expanded={opened} aria-label={`${layer.name}'s details`} title={opened ? "Hide" : "Show more"} onClick={onToggle}>
          <ChevronUpIcon />
        </button>
      ) : (
        <span className="layer-chevron layer-end" aria-hidden="true" />
      )}
    </>
  );
}

/** What its switch says, if it's not just on: on for some of these, or off (here, or everywhere). */
const switchNote = ({ layer, state }: Row) => (state === "mixed" ? "on for some of these" : state === "off" ? (layer.muted ? "off" : "off here") : null);

/** Under a shader's name: its commit (or branch), if it's a sketch's, and anything that's become of it. */
function metaOf(row: Row): string | null {
  const { layer } = row;
  const parts: string[] = [];
  const sketch = layer.sketch;
  const instance = layer.instance;
  if (sketch) parts.push(instance ? commitName(sketch.commit, instance.branch, instance.head) : sketch.commit.slice(0, 7));
  if (layer.stage === "building") parts.push("building…");
  const status = statusOf(layer) ?? switchNote(row);
  if (status) parts.push(status);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Under one you're adding: its build (building on the server, built, or why it couldn't), and its switch. */
function AddingMeta({ adding, row }: { adding: Adding; row: Row }) {
  const build = adding.build;
  const head = useBranchHead(adding.sketchId, adding.branch);
  const parts = [
    build?.state === "failed"
      ? `${adding.branch} · couldn't build`
      : build?.state === "built"
        ? `${commitName(build.commit, adding.branch, head)} · new here`
        : `building ${adding.branch}…`,
  ];
  const note = switchNote(row);
  if (note) parts.push(note);
  return <span className={build?.state === "failed" ? "layer-meta bad" : "layer-meta"}>{parts.join(" · ")}</span>;
}

/** One that couldn't go in, homed on some of these lights, and why: nothing to switch or move. */
function FailedRow({ layer, onOpen }: { layer: Layer; onOpen: () => void }) {
  const { name, instance } = layer;
  return (
    <li className="layer coming">
      <span className="layer-grip" aria-hidden="true" />
      <span className="layer-node" aria-hidden="true" />
      <span className="layer-text">
        <span className="layer-name">{name}</span>
        <span className="layer-meta bad">
          {instance ? `${commitName(instance.commit, instance.branch, instance.head)} · ` : ""}
          couldn't go in
        </span>
      </span>
      <button className="icon-button layer-open" aria-label={`More for ${name}`} title={`More for ${name}`} onClick={onOpen}>
        <MoreIcon />
      </button>
      <RowEnd />
    </li>
  );
}

/** One you're taking out, when you apply: where it is, crossed out, to keep after all. */
function GoingRow({ layer }: { layer: Layer }) {
  return (
    <li className="layer coming going">
      <span className="layer-grip" aria-hidden="true" />
      <span className="layer-node" aria-hidden="true" />
      <span className="layer-text">
        <span className="layer-name">{layer.name}</span>
        <span className="layer-meta">comes out when you apply</span>
      </span>
      <button className="quiet layer-keep" onClick={() => drafts.keep(layer.key)} title={`Keep ${layer.name} in the room`}>
        Keep
      </button>
      <span className="layer-chevron layer-end" aria-hidden="true" />
    </li>
  );
}

/**
 * The stack (top first) with the shaders the draft takes out back in it,
 * each just above the one under it in the room (the lowest first, so one
 * over another going too goes above it).
 */
function withGoing(stack: Layer[], going: Layer[], scene: Scene): Layer[] {
  const keys = scene.shaders.map((s) => s.key);
  const all = [...stack];
  for (const layer of [...going].sort((a, b) => keys.indexOf(b.key) - keys.indexOf(a.key))) {
    const under = keys.slice(keys.indexOf(layer.key) + 1).find((k) => all.some((l) => l.key === k));
    all.splice(under === undefined ? all.length : all.findIndex((l) => l.key === under), 0, layer);
  }
  return all;
}

/** A row's end with no switch yet: room for one, then the quiet dot. */
const RowEnd = () => (
  <>
    <span className="layer-no-switch" aria-hidden="true" />
    <span className="layer-chevron layer-end" aria-hidden="true" />
  </>
);

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
