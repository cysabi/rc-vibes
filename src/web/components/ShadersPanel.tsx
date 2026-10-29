// The layers in the room (its shaders), in a panel along the left of the
// map: the bottom of the stack first, as the selection's rows read (each
// draws over what's above it), dragged by their chevrons to reorder the
// stack, on the same rail as the selection's: a stop each, in the light it
// makes on its lights (hollow while it's off, or not in yet). Last on the
// rail, the library (AddSketch.tsx): adding another, on every light. The
// library also opens from the code button in the panel's head.
//
// Under its name, how many lights it's on, of each kind; after it, with
// changes to it not saved yet, its own pink asterisk (as the selection's
// title has for the whole room's), which selects the lights they change on
// this floor. Clicking a layer
// selects the lights it's on (on this floor; shift adds them, or, all of
// them selected already, lets go of them; alt lets go of them, or, none of
// them selected, adds them), or, on none
// here, lets go of the selection, and does nothing else (the map stays put);
// under the pointer, its lights are ringed, dashed, on the map (hint.ts, as
// its asterisk's are). Its chevron (also the handle to drag it by)
// opens it, under its row, to the lights it's on, each kind on a line in
// their colors (LightsSummary.tsx, as the map's tooltip says them), and what
// can be done to it: opening its
// code, editing its domain on the map (layer-mode.ts: the map becomes a shader
// selector), cloning it, updating it, and deleting it (or keeping it, once
// it's going).

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { layerMode, useLayerMode } from "../layer-mode.ts";
import { queryClient, request, useBranchHead, useSketchChanges, useStatus } from "../api.ts";
import { invalidateScene } from "../scene.ts";
import { useOpened } from "../opened.ts";
import { focusLayer } from "../focus.ts";
import { useStuckHeads } from "../stuck.ts";
import { changeable, changesByLayer, domainOf, drafts, layerOf, layersOf, removedOf, reorderWithin, useDraft, type Layer } from "../draft.ts";
import { ChevronUpIcon, CodeIcon, DomainIcon, FocusIcon, PlusIcon } from "../icons.tsx";
import { useLights, useScene, type Scene } from "../scene.ts";
import { isBaseColor } from "../../shared/base-color.ts";
import { defaultSketch } from "../../shared/default-sketches.ts";
import { baseType, isBinary } from "../../shared/fixtures.ts";
import { count } from "../words.ts";
import { AddSketch } from "./AddSketch.tsx";
import { Sidebar, SidebarDetails, SidebarSection } from "./Sidebar.tsx";
import { LightsSummary } from "./LightsSummary.tsx";
import { AddingActions, CloneShader, ComingActions, OpenCode, RemoveShader } from "./ShaderPanel.tsx";
import { Reveal } from "./Reveal.tsx";
import { keyedMode, type SelectMode } from "../selection.ts";
import { ChangesMark, inPreview, ShaderNode, withGoing } from "./SelectionPanel.tsx";
import { useShowUnsaved } from "../unsaved.ts";
import { usePointsOut } from "../hint.ts";

const NO_SCENE: Scene = { shaders: [], roomtone: null, pools: {} };
const NO_CHANGES: ReadonlyMap<string, number[]> = new Map();

interface Props {
  /** The lights on this floor. */
  here: LightInfo[];
  /** The selected ones among them. */
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], mode: SelectMode) => void;
}


export function ShadersPanel({ here, selected, onSelect }: Props) {
  const scene = useScene();
  const lights = useLights();
  const draft = useDraft();
  const status = useStatus();
  const live = scene.data ?? NO_SCENE;
  const stack = layersOf(live, draft);
  const going = new Set(removedOf(live, draft));
  // Bottom of the stack first, as the selection's rows read: in the order the light builds up.
  const shown = withGoing(
    stack,
    [...going].flatMap((key) => layerOf(live, draft, key) ?? []),
    live,
  ).reverse();
  const all = lights.data?.lights ?? [];
  // What each layer has that isn't saved yet: the lights it changes.
  // Not in live mode, where they're sent as they're made (unsaved.ts).
  const showUnsaved = useShowUnsaved();
  const changes = showUnsaved ? changesByLayer(live, draft) : NO_CHANGES;
  const opened = useOpened();
  // The layer the map's about (in focus, or its domain being edited): its row says so.
  const mode = useLayerMode();
  const body = useRef<HTMLDivElement>(null);
  useStuckHeads(body);

  // Adding one, on every light in the room, whatever's selected (from main,
  // for now: there's no picking a branch yet). Narrow it afterwards from the
  // selection's switches.
  const [picking, setPicking] = useState(false);
  const add = (sketch: { id: string; name: string }) => {
    setPicking(false);
    drafts.add({
      sketchId: sketch.id,
      sketchName: sketch.name,
      branch: "main",
      home: all.map((l) => l.id),
      mask: [],
    });
  };
  const sketches = status.data?.sketches === true;

  // Dragging a sketch by its chevron moves it in the stack (the room's order, for every light).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  // The base Tone stays at the bottom (shared/base-color.ts): it's no place among them to move to.
  const listed = shown.filter((l) => changeable(l) && !going.has(l.key) && !isBaseColor(l.key)).map((l) => l.key);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const moved = arrayMove(listed, listed.indexOf(String(active.id)), listed.indexOf(String(over.id)));
    // The list is bottom first; the stack's order is top first.
    drafts.reorder(
      reorderWithin(
        stack.map((l) => l.key),
        moved.reverse(),
      ),
    );
  };

  return (
    <Sidebar
      side="left"
      label="Layers"
      head="Layers"
      bodyRef={body}
      actions={
        // The sketches library, as the last row's Add opens it: an icon button, as the selection's head has.
        sketches && (
          <button className="icon-button library-button" onClick={() => setPicking(true)} aria-label="Sketches library">
            <CodeIcon />
          </button>
        )
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={listed} strategy={verticalListSortingStrategy}>
          <ol className="layers">
            {shown.map((layer) => {
              const open = opened.isOpen(layer.key);
              const props: RowProps = {
                layer,
                going: going.has(layer.key),
                changed: changes.get(layer.key) ?? null,
                here,
                all,
                scene: live,
                editing: mode?.kind === "edit" && mode.key === layer.key,
                active: mode?.key === layer.key,
                open,
                onToggle: () => opened.toggle(layer.key),
                onPick: (mode) => {
                  // The selection panel shuts every row but this one's.
                  focusLayer(layer.key);
                  const onFloor = new Set(here.map((l) => l.id));
                  const mine = domainOf(layer).filter((id) => onFloor.has(id));
                  // Shift adds them (or, all selected already, lets go of them); alt always lets go of them: keyedMode.
                  if (mine.length > 0) onSelect(mine, mode === "add" || mode === "remove" ? keyedMode(mode, mine, selected) : mode);
                  else if (mode === "replace") onSelect([], "replace");
                },
                onSelect,
                onCloned: (key) => {
                  if (!opened.isOpen(key)) opened.toggle(key);
                },
              };
              return listed.includes(layer.key) ? <SortableShaderRow key={layer.key} {...props} /> : <ShaderRow key={layer.key} {...props} />;
            })}
            {/* Last on the rail, another, on every light. */}
            {sketches && (
              <li className="layer add-row" onClick={() => setPicking(true)}>
                <div className="layer-rail">
                  <span className="layer-node add" aria-hidden="true">
                    <PlusIcon />
                  </span>
                </div>
                <button className="layer-head">
                  <span className="layer-name">Add or view a sketch</span>
                </button>
              </li>
            )}
          </ol>
        </SortableContext>
      </DndContext>
      <AddSketch open={picking} onPick={add} onClose={() => setPicking(false)} />
    </Sidebar>
  );
}

interface RowProps {
  layer: Layer;
  /** Coming out of the room when you save. */
  going: boolean;
  /** With changes to it not saved yet, the lights they change; else null. */
  changed: readonly number[] | null;
  here: LightInfo[];
  all: LightInfo[];
  scene: Scene;
  /** Its domain's being edited on the map. */
  editing: boolean;
  /** The map's about it: in focus, or its domain being edited. */
  active: boolean;
  open: boolean;
  onToggle: () => void;
  /** Its row clicked: its lights on this floor selected (shift: added; alt: taken out), or, with none here, nothing selected. */
  onPick: (mode: SelectMode) => void;
  /** Lights selected from its asterisk. */
  onSelect: (ids: number[], mode: SelectMode) => void;
  onCloned: (key: string) => void;
  /** Moving it: its chevron is the handle to drag it by (useSortable's), and how it's carried. */
  drag?: {
    handle: ButtonHTMLAttributes<HTMLButtonElement>;
    ref: (el: HTMLElement | null) => void;
    style: CSSProperties;
    dragging: boolean;
  };
}

/** A sketch that can be moved: dragged by its chevron to another place in the stack. */
function SortableShaderRow(props: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.layer.key });
  const drag = {
    handle: {
      ...attributes,
      ...listeners,
    } as ButtonHTMLAttributes<HTMLButtonElement>,
    ref: setNodeRef,
    // Up and down only (the stack's one way), and never stretched to the size of the row it's over.
    style: { transform: CSS.Translate.toString(transform && { ...transform, x: 0 }), transition },
    dragging: isDragging,
  };
  return <ShaderRow {...props} drag={drag} />;
}

function ShaderRow({ layer, going, changed, here, all, scene, editing, active, open, onToggle, onPick, onSelect, onCloned, drag }: RowProps) {
  const on = domainOf(layer);
  // Under the pointer, its lights pointed out on the map.
  const pointsOut = usePointsOut(() => domainOf(layer));
  return (
    <li
      ref={drag?.ref}
      style={drag?.style}
      className={["layer shader-row", open && "open", going && "going", layer.muted && "off", active && "active", drag?.dragging && "dragging"]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="layer-rail">
        <ShaderNode layer={layer} lights={all} hollow={on.length === 0 || going || !inPreview(layer)} />
      </div>
      <div
        className="layer-head toggle"
        onClick={(e: MouseEvent) => !(e.target as Element).closest("button") && onPick(e.altKey ? "remove" : e.shiftKey ? "add" : "replace")}
        {...pointsOut}
      >
        <span className="layer-text">
          <span className="layer-name">
            {layer.name}
            {changed && <ChangesMark changed={changed} here={here} onSelect={onSelect} />}
          </span>
          <span className="layer-meta">{kindsText(on, all)}</span>
        </span>
        {/* The map's about it: which way, by its button's icon, filled as the button is while it's on, just before its chevron.
            Pressed, it's off: the edit discarded (as the pill's × does, back to focus if it came from there), or the focus let go of. */}
        {active && (
          <button
            className="layer-mode-icon"
            aria-label={editing ? "Stop editing its domain" : "Exit focus"}
            onClick={() => (editing ? layerMode.endEdit() : layerMode.exit())}
          >
            {editing ? <DomainIcon /> : <FocusIcon />}
          </button>
        )}
        <button
          className={drag ? "layer-chevron layer-handle" : "layer-chevron"}
          {...drag?.handle}
          aria-expanded={open}
          aria-label={drag ? `${layer.name}'s details (drag to move it)` : `${layer.name}'s details`}
          onClick={onToggle}
        >
          <ChevronUpIcon />
        </button>
      </div>
      <Reveal open={open}>
        <SidebarDetails>
          <Sections layer={layer} on={on} going={going} scene={scene} all={all} editing={editing} onCloned={onCloned} />
        </SidebarDetails>
      </Reveal>
    </li>
  );
}

/** How many of these lights there are of each kind, color bulbs, old bulbs, then panels ("12 color · 3 old · 4 panels"); none, "0 lights". */
function kindsText(ids: readonly number[], all: LightInfo[]): string {
  const of = new Set(ids);
  let color = 0;
  let old = 0;
  let panels = 0;
  for (const l of all) {
    if (!of.has(l.id)) continue;
    if (isBinary(l.type)) old++;
    else if (baseType(l.type) === "4x1") panels++;
    else color++;
  }
  const parts = [color > 0 && `${color} color`, old > 0 && `${old} old`, panels > 0 && count(panels, "panel")].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : "0 lights";
}

/** The lights with these ids, of all of them. */
function lightsOf(ids: readonly number[], all: LightInfo[]): LightInfo[] {
  const of = new Set(ids);
  return all.filter((l) => of.has(l.id));
}

/**
 * The commit a sketch's layer runs (or will, once it's in): "head" while that's
 * its branch's latest, else its short hash. Nothing, before there's a build.
 */
function SketchCommit({ layer }: { layer: Layer }) {
  const sketchId = layer.instance?.sketchId ?? layer.adding?.sketchId ?? layer.sketch?.id ?? "";
  const branch = layer.instance?.branch ?? layer.adding?.branch ?? "main";
  const latest = useBranchHead(sketchId, branch);
  const commit = layer.adding ? (layer.adding.build?.commit ?? "") : (layer.instance?.commit ?? layer.sketch?.commit ?? "");
  if (!commit) return null;
  // An instance knows its branch's head; one you're adding (or any other), the sketch's main as last fetched.
  const head = layer.instance ? layer.instance.head : latest;
  return <span className="mono">{head === commit ? "head" : commit.slice(0, 7)}</span>;
}

/** A layer's lights alone on the map (layer-mode.ts), lit while they are; pressed again, every light back. */
function FocusLayer({ layer }: { layer: Layer }) {
  const mode = useLayerMode();
  const on = mode?.kind === "focus" && mode.key === layer.key;
  return (
    <button className={on ? "quiet shader-action layer-focus on" : "quiet shader-action layer-focus"} aria-pressed={on} onClick={() => layerMode.focus(on ? null : layer.key)}>
      <FocusIcon /> Focus
    </button>
  );
}

/**
 * A sketch's layer that's behind, over its actions: your editor has changes
 * main hasn't (files not committed, commits not pushed), and/or its branch
 * has commits it isn't running. One callout either way, and one Update doing
 * all of it: your changes committed and pushed to main (POST …/publish, as
 * adding a sketch with them does), then, for one in the room, its branch's
 * latest built and put in (POST /api/instances/<id>/update). While that new
 * build's on its way, it says so.
 */
function NewChanges({ layer }: { layer: Layer }) {
  const sketchId = layer.instance?.sketchId ?? layer.adding?.sketchId ?? layer.sketch?.id ?? null;
  const changes = useSketchChanges(sketchId).data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instance = layer.adding ? null : layer.instance;
  const unpushed = !!changes && !("unknown" in changes) && (changes.files > 0 || changes.commits > 0);
  const updating = instance?.next?.state === "building";
  const behind = !!instance && instance.head !== null && instance.head !== instance.commit && !updating;
  if (!sketchId || (!unpushed && !behind && !updating)) return null;
  const update = async () => {
    setBusy(true);
    setError(null);
    try {
      if (unpushed) {
        await request("POST", `/api/sketches/${encodeURIComponent(sketchId)}/publish`, {});
        // Main's head and your changes, both changed.
        await queryClient.invalidateQueries({ queryKey: ["sketches", sketchId] });
      }
      if (instance) await request("POST", `/api/instances/${instance.id}/update`, {});
      await invalidateScene();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const text = error ? `Couldn't update: ${error}` : updating ? `Updating to ${instance!.next!.commit.slice(0, 7)}…` : "This sketch is behind";
  return (
    <div className="sketch-behind" role="note">
      <span className="sketch-behind-text">{text}</span>
      {!updating && (
        <button className="quiet shader-action" disabled={busy} onClick={() => void update()}>
          {busy ? "Updating…" : "Update"}
        </button>
      )}
    </div>
  );
}

/** Editing a layer's domain on the map (layer-mode.ts), lit while it is; pressed again, done. */
function EditDomain({ layer, editing }: { layer: Layer; editing: boolean }) {
  return (
    <button
      className={editing ? "quiet shader-action domain-edit on" : "quiet shader-action domain-edit"}
      aria-pressed={editing}
      onClick={() => (editing ? layerMode.endEdit() : layerMode.edit(layer.key, domainOf(layer)))}
    >
      <DomainIcon /> Edit
    </button>
  );
}

/**
 * What a layer opens to: its Domain (the lights it's on, editing them on
 * the map on the right of its title), then, if it's a sketch's, its Sketch (opening it, cloning
 * it, updating it, and deleting it). The base Tone is vibes' own: it has no Sketch
 * section (just a note that it's always there), and can't be deleted or
 * moved; a shader made outside vibes has none either,
 * its Delete under its domain. One
 * you're taking out can only be kept; one on its way in, opened or let go.
 */
function Sections({
  layer,
  on,
  going,
  scene,
  all,
  editing,
  onCloned,
}: {
  layer: Layer;
  on: number[];
  going: boolean;
  scene: Scene;
  all: LightInfo[];
  editing: boolean;
  onCloned: (key: string) => void;
}) {
  const ids = all.map((l) => l.id);
  if (going) {
    return (
      <div className="shader-actions">
        <button className="quiet shader-action" onClick={() => drafts.keep(layer.key)}>
          Keep it
        </button>
      </div>
    );
  }
  const coming = (layer.stage === "building" || layer.stage === "failed") && layer.instance;
  // One of vibes' own (shared/default-sketches.ts: a Tone, a Transition): its code's vibes', so nothing to open or update, just clone or take out.
  // The base Tone's always in and at the bottom: the layers panel won't take it out (or move it).
  const base = isBaseColor(layer.key);
  const builtIn = defaultSketch(layer.adding?.sketchId ?? layer.instance?.sketchId ?? layer.sketch?.id);
  // A sketch's (in the room, on its way, or being added): it has a Sketch section. One of vibes' own, or a shader made outside vibes, hasn't.
  const isSketch = !builtIn && (layer.sketch !== null || layer.adding !== null || coming);
  // One made outside vibes can still be deleted: with no Sketch section, under its domain.
  const outside = !isSketch && !builtIn;
  return (
    <>
      {/* Above its Domain, the map about it: Focus and Edit, side by side, the whole width between them. */}
      <div className="layer-modes">
        <FocusLayer layer={layer} />
        {changeable(layer) && <EditDomain layer={layer} editing={editing} />}
      </div>
      <SidebarSection title="Domain">
        {on.length > 0 ? <LightsSummary lights={lightsOf(on, all)} /> : <span className="domain-empty">No domain</span>}
        {outside && (
          <div className="shader-actions">
            <RemoveShader layer={layer} />
          </div>
        )}
      </SidebarSection>
      {/* One of vibes' own sketches: its own section, by its name (cloning it, taking it out). Not the base Tone's, which is just its Domain. */}
      {builtIn && !base && (
        <SidebarSection title={builtIn.name}>
          <div className="shader-actions">
            <CloneShader layer={layer} scene={scene} all={ids} onCloned={onCloned} />
            {layer.adding ? <AddingActions adding={layer.adding} /> : coming ? <ComingActions instance={layer.instance!} /> : <RemoveShader layer={layer} />}
          </div>
        </SidebarSection>
      )}
      {isSketch && (
        <SidebarSection title="Sketch" actions={<SketchCommit layer={layer} />}>
          {/* One field: whether it's behind, then what's done to the sketch, together. */}
          <div className="sketch-field">
            <NewChanges layer={layer} />
            <div className="shader-actions">
              {layer.adding ? (
                <>
                  <CloneShader layer={layer} scene={scene} all={ids} onCloned={onCloned} />
                  <AddingActions adding={layer.adding} />
                </>
              ) : coming ? (
                <ComingActions instance={layer.instance!} />
              ) : (
                <>
                  {layer.sketch && <OpenCode sketch={layer.sketch} />}
                  <CloneShader layer={layer} scene={scene} all={ids} onCloned={onCloned} />
                  <RemoveShader layer={layer} />
                </>
              )}
            </div>
          </div>
        </SidebarSection>
      )}
    </>
  );
}
