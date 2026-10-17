// The shader stack: the top row draws over everything beneath it. The room
// tone, underneath them all, has its own panel. Changes here are pending
// until applied: they show in the preview, marked on their rows.

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
import type { SceneNode } from "../../shared/vibes.ts";
import { useScene } from "../api.ts";
import { drafts, layersOf, useDraft, type Layer } from "../draft.ts";
import { EyeIcon, EyeOffIcon, GripIcon, PlusIcon } from "../icons.tsx";
import { useAdminMode } from "../settings.ts";
import { usePreviewErrors } from "../sim.ts";
import { ago } from "../time.ts";

const NO_NODES: SceneNode[] = [];

export function Stack({ onOpen }: { onOpen: (layer: Layer | "new") => void }) {
  const scene = useScene();
  const draft = useDraft();
  const admin = useAdminMode();
  const previewErrors = usePreviewErrors();
  const live = scene.data ?? NO_NODES;
  const layers = layersOf(live, draft);
  const showing = layers.filter((l) => l.status !== "deleted");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const keys = layers.map((l) => l.key);
    drafts.reorder(arrayMove(keys, keys.indexOf(String(active.id)), keys.indexOf(String(over.id))));
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Stack</h2>
        <span className="spacer" />
        <button className="text-button" onClick={() => onOpen("new")}>
          <PlusIcon /> New shader
        </button>
      </div>
      <p className="hint">Each shader draws over the ones below it, and all of them over the room tone.</p>
      {scene.error && <p className="error-text">{scene.error.message}</p>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={layers.map((l) => l.key)} strategy={verticalListSortingStrategy}>
          <ol className="stack">
            {layers.map((layer) => (
              <Row key={layer.key} layer={layer} previewError={previewErrors[layer.key] ?? null} onOpen={() => onOpen(layer)} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {scene.data && layers.length === 0 && <p className="empty">No shaders running, so the room shows its room tone.</p>}

      {admin && showing.length > 0 && (
        <div className="clear-all">
          <button className="text-button danger-text" onClick={() => drafts.clearAll(live)}>
            Clear all shaders
          </button>
        </div>
      )}
    </div>
  );
}

const BADGES: Record<Layer["status"], string | null> = { live: null, new: "new", edited: "edited", deleted: "deleted" };

function Row({ layer, previewError, onOpen }: { layer: Layer; previewError: string | null; onOpen: () => void }) {
  const deleted = layer.status === "deleted";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: layer.key, disabled: deleted });
  const { node, name } = layer;
  // A pending mute or unmute.
  const muteChanged = node !== null && layer.muted !== node.muted;
  // arclamp's errors are about the live script; once it's edited they're stale.
  const liveError =
    node && layer.status === "live" && node.error && node.error !== node.meta?.seenError ? node.error : null;
  const badge = BADGES[layer.status] ?? (muteChanged ? (layer.muted ? "muted" : "unmuted") : null);

  return (
    <li
      ref={setNodeRef}
      className={`row${layer.muted ? " muted" : ""}${deleted ? " deleted" : ""}${badge ? " changed" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="grip" aria-label={`Move ${name}`} disabled={deleted} {...attributes} {...listeners}>
        <GripIcon />
      </button>
      <button className="row-main" onClick={onOpen}>
        <span className="row-name">
          {name}
          {badge && <span className="row-badge">{badge}</span>}
        </span>
        <span className="row-meta">
          {layer.by}
          {node?.modified_at && ` · ${ago(node.modified_at)}`}
          {layer.muted && !muteChanged && " · muted"}
        </span>
        {!deleted && node?.state === "restarting" && <span className="row-warn">restarting…</span>}
        {!deleted && previewError ? (
          <span className="row-error">In the preview: {previewError}</span>
        ) : (
          liveError && (
            <span className="row-error">
              {node!.state === "running" ? "Recovered from " : ""}
              {liveError}
            </span>
          )
        )}
      </button>
      {deleted ? (
        <button className="text-button row-restore" onClick={() => drafts.restoreShader(layer.key)}>
          Restore
        </button>
      ) : (
        <button
          className="icon-button"
          aria-label={layer.muted ? `Unmute ${name}` : `Mute ${name}`}
          aria-pressed={layer.muted}
          title={layer.muted ? "Unmute" : "Mute"}
          onClick={() => drafts.patchShader(layer.key, { muted: !layer.muted })}
        >
          {layer.muted ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
    </li>
  );
}
