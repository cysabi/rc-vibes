import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { Rail } from "../shared/arclamp.ts";
import type { SceneNode } from "../shared/vibes.ts";
import { useLights, useMe, useScene } from "./api.ts";
import { layersOf, pendingCount, templateOf, useDraft, type Layer } from "./draft.ts";
import { History } from "./components/History.tsx";
import { Login } from "./components/Login.tsx";
import { RoomMap, type SelectMode } from "./components/RoomMap.tsx";
import { RoomTone } from "./components/RoomTone.tsx";
import { Stack } from "./components/Stack.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { FLOORS } from "./floors.ts";
import { useLiveStream } from "./live.ts";
import { savedFloor, saveFloor } from "./settings.ts";
import { useSimulation } from "./sim.ts";

const NO_RAILS: Rail[] = [];
const NO_NODES: SceneNode[] = [];

// The code editor is most of the bundle; load it the first time it opens.
const ShaderSheet = lazy(() => import("./components/ShaderSheet.tsx").then((m) => ({ default: m.ShaderSheet })));

export function App() {
  const me = useMe();
  if (me.isPending) return <div className="splash" />;
  if (me.isError) return <div className="splash">Couldn't reach vibes: {me.error.message}</div>;
  if (!me.data) return <Login />;
  return <Shell />;
}

function Shell() {
  const lights = useLights();
  const scene = useScene();
  useLiveStream(lights.data);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [side, setSide] = useState<"stack" | "history">("stack");
  const [editing, setEditing] = useState<Layer | "new" | null>(null);
  const [floor, setFloor] = useState<number>(initialFloor);
  const all = useMemo(() => lights.data?.lights ?? [], [lights.data]);

  // Pending edits put vibes in simulated mode: the map shows the preview of
  // them until they're applied or discarded.
  const draft = useDraft();
  const live = scene.data ?? NO_NODES;
  const pending = scene.data ? pendingCount(live, draft) : 0;
  const simulated = pending > 0;
  const simInputs = useMemo(
    () => ({ lights: all, layers: layersOf(live, draft), template: templateOf(live, draft) }),
    [all, live, draft],
  );
  useSimulation(simulated, simInputs);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-simulated", simulated);
  }, [simulated]);

  const showFloor = (id: number) => {
    setFloor(id);
    saveFloor(String(id));
  };

  const select = useCallback((ids: number[], mode: SelectMode) => {
    setSelected((prev) => {
      if (mode === "replace") return new Set(ids);
      const next = new Set(prev);
      for (const id of ids) {
        if (mode === "toggle" && next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // A fresh room tone panel per selection, so its picker starts from those
  // lights, and again once its pending changes are discarded or applied.
  const toneDrafted = Object.keys(draft.roomtone).length > 0;
  const [toneEpoch, setToneEpoch] = useState(0);
  const [wasDrafted, setWasDrafted] = useState(toneDrafted);
  if (wasDrafted !== toneDrafted) {
    setWasDrafted(toneDrafted);
    if (!toneDrafted) setToneEpoch((n) => n + 1);
  }
  const selectionKey = `${[...selected].sort((a, b) => a - b).join(",") || "room"}#${toneEpoch}`;

  return (
    <div className="app">
      <TopBar lights={all} live={live} pending={pending} onHistory={() => setSide(side === "history" ? "stack" : "history")} />
      <aside className="tone" aria-label="Room tone">
        {/* Mounted once the scene is in, so the picker opens on the room's actual tone. */}
        {lights.data && scene.data && <RoomTone key={selectionKey} lights={all} selected={selected} onSelect={select} />}
      </aside>
      <main className="stage">
        {lights.error ? (
          <p className="map-error">Couldn't load the lights: {lights.error.message}</p>
        ) : (
          <RoomMap
            lights={all}
            rails={lights.data?.rails ?? NO_RAILS}
            floor={floor}
            onFloor={showFloor}
            changed={lights.data?.changed ?? 0}
            selected={selected}
            onSelect={select}
          />
        )}
      </main>
      <aside className="side" aria-label={side === "history" ? "History" : "Shaders"}>
        {side === "history" ? <History onBack={() => setSide("stack")} /> : <Stack onOpen={setEditing} />}
      </aside>
      {editing && (
        <Suspense fallback={null}>
          <ShaderSheet layer={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </div>
  );
}

function initialFloor(): number {
  const n = Number(savedFloor());
  return FLOORS.some((f) => f.id === n) ? n : FLOORS[FLOORS.length - 1]!.id;
}
