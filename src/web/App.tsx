import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Rail } from "../shared/arclamp.ts";
import type { SceneNode } from "../shared/vibes.ts";
import { useLights, useMe } from "./api.ts";
import { usePendingInstances, useScene } from "./scene.ts";
import { applyDraft, layerOf, layersOf, pendingCount, reachOf, templateOf, useDraft, type LayerKey } from "./draft.ts";
import { Banners } from "./components/Banners.tsx";
import { ColorPreview } from "./components/ColorPreview.tsx";
import { Login } from "./components/Login.tsx";
import { Pending } from "./components/Pending.tsx";
import { RoomMap, type SelectMode } from "./components/RoomMap.tsx";
import { SelectionPanel } from "./components/SelectionPanel.tsx";
import { TagChips } from "./components/TagChips.tsx";
import { UserMenu } from "./components/UserMenu.tsx";
import { FLOORS } from "./floors.ts";
import { useLiveStream } from "./live.ts";
import { useNarrow } from "./narrow.ts";
import { usePeek } from "./peek.ts";
import { savedFloor, saveFloor, useLiveMode } from "./settings.ts";
import { useSimulation } from "./sim.ts";
import { usePath } from "./route.ts";
import { SketchesLink, SketchPages } from "./sketches/SketchPages.tsx";

const NO_RAILS: Rail[] = [];
const NO_NODES: SceneNode[] = [];

export function App() {
  const me = useMe();
  const path = usePath();
  if (me.isPending) return <div className="splash" />;
  if (me.isError) return <div className="splash">Couldn't reach vibes: {me.error.message}</div>;
  if (!me.data) return <Login />;
  return path === "/sketches" || path.startsWith("/sketches/") ? <SketchPages path={path} /> : <Shell />;
}

function Shell() {
  const lights = useLights();
  const scene = useScene();
  useLiveStream(lights.data);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [floor, setFloor] = useState<number>(initialFloor);
  const all = useMemo(() => lights.data?.lights ?? [], [lights.data]);

  // Pending edits put vibes in simulated mode: the map shows the preview of
  // them until they're applied or discarded. So does peeking at the room
  // tone, with every shader set aside while it's held. In live mode there's
  // no preview: edits go to the room as they're made, one send at a time
  // (each as soon as the last lands), and only a failed send shows them as
  // pending, to try again or drop.
  const draft = useDraft();
  const live = scene.data ?? NO_NODES;
  const pending = scene.data ? pendingCount(live, draft) : 0;
  const peeking = usePeek();
  const liveMode = useLiveMode();
  const [liveError, setLiveError] = useState<string | null>(null);
  const sending = useRef(false);
  // Bumped as each send lands, to look again for what came in meanwhile.
  const [sent, setSent] = useState(0);
  useEffect(() => {
    // After a failed send, it waits for Apply or Discard rather than trying again and again.
    if (!liveMode || pending === 0 || sending.current || liveError) return;
    sending.current = true;
    applyDraft(live)
      .catch((err: Error) => setLiveError(err.message))
      .finally(() => {
        sending.current = false;
        setSent((n) => n + 1);
      });
  }, [liveMode, pending, draft, live, liveError, sent]);
  // Nothing pending, or live mode switched, starts clean.
  useEffect(() => {
    if (pending === 0) setLiveError(null);
  }, [pending]);
  useEffect(() => setLiveError(null), [liveMode]);
  const previewing = pending > 0 && (!liveMode || liveError !== null);
  const simulated = previewing || peeking;
  const simInputs = useMemo(() => {
    const layers = layersOf(live, draft);
    return { lights: all, layers: peeking ? layers.map((l) => ({ ...l, muted: true })) : layers, template: templateOf(live, draft) };
  }, [all, live, draft, peeking]);
  useSimulation(simulated, simInputs);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-simulated", simulated);
  }, [simulated]);

  // Only the lights on the floor you're looking at can be selected, and so
  // changed. Switching floors lets go of the selection.
  const here = useMemo(() => all.filter((l) => l.coords?.floor === floor), [all, floor]);
  // Lights on no floor's plan yet, waiting in the drawer.
  const anyUnplaced = useMemo(() => all.some((l) => !l.coords), [all]);
  const selectedHere = useMemo(() => {
    const ids = new Set(here.map((l) => l.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [here, selected]);

  // A shader opened from the selection panel, in its place: one in the room
  // ("#12"), or one on its way in ("i:" and its instance's id). The map rings
  // where it's on (of its home, or where its code's lit) instead of the
  // selection, which is kept, to go back to. Anything selected on the map
  // goes back to selecting lights. Gone (taken out, by you or anyone), it closes.
  const [shader, setShader] = useState<LayerKey | null>(null);
  const pendingInstances = usePendingInstances();
  const openLayer = shader?.startsWith("#") && selectedHere.size > 0 ? layerOf(live, draft, shader) : null;
  const openComing = shader?.startsWith("i:") && selectedHere.size > 0 ? (pendingInstances.find((i) => `i:${i.id}` === shader) ?? null) : null;
  const reach = useMemo(() => {
    let on: Set<number> | null = null;
    if (openLayer) {
      const masked = new Set(openLayer.mask);
      on = new Set(reachOf(openLayer).filter((id) => !masked.has(id)));
    } else if (openComing) {
      on = new Set(openComing.home);
    }
    return on && new Set(here.filter((l) => on.has(l.id)).map((l) => l.id));
  }, [openLayer, openComing, here]);

  const showFloor = (id: number) => {
    setFloor(id);
    setSelected(new Set());
    setShader(null);
    saveFloor(String(id));
  };

  const select = useCallback((ids: number[], mode: SelectMode) => {
    setShader(null);
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

  // Picking by tag also flies the map to what's picked.
  const [framing, setFraming] = useState(0);
  const selectByTag = useCallback(
    (ids: number[], mode: SelectMode) => {
      select(ids, mode);
      setFraming((n) => n + 1);
    },
    [select],
  );

  // With a shader open, picking on the map starts a new selection.
  const open = openLayer !== null || openComing !== null;
  const selectOnMap = useCallback((ids: number[], mode: SelectMode) => select(ids, open ? "replace" : mode), [select, open]);

  // Escape goes back from a shader to the selection, then lets go of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (open) setShader(null);
      else setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The map's own overlays (Move lights, the pending changes) sit under the
  // HUD, so it hands them its height as --hud-h; the selection panel sits
  // under just its banners (--banners-h). Measured before the first paint, so
  // the map's first fit already leaves room for it.
  const app = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const style = app.current!.style;
      style.setProperty("--hud-h", `${hud.current!.offsetHeight}px`);
      style.setProperty("--banners-h", `${hud.current!.offsetHeight - bar.current!.offsetHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(hud.current!);
    observer.observe(bar.current!);
    return () => observer.disconnect();
  }, []);

  // The map is the base of everything, always; all else floats over it. Along
  // the top, the HUD: banners about degraded states, then the tags to select
  // lights by (or, on a floor with no lights yet, a note saying so) on the
  // left and the account on the right. Floors, zoom and the rest are the
  // map's own. While anything's selected, a panel about it comes in along the
  // left edge (or up from the bottom, on a phone), and the tags move over;
  // what it looks like floats in the map's bottom left (not on a phone).
  const hasSelection = selectedHere.size > 0;
  const narrow = useNarrow();
  return (
    <div className={hasSelection ? "app has-selection" : "app"} ref={app}>
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
            selected={reach ?? selectedHere}
            onSelect={selectOnMap}
            dock={previewing && <Pending live={live} pending={pending} />}
            framing={framing}
            corner={hasSelection && !open && !narrow && <ColorPreview lights={here.filter((l) => selectedHere.has(l.id))} />}
          />
        )}
      </main>
      {hasSelection && (
        <SelectionPanel
          floor={floor}
          here={here}
          selected={selectedHere}
          previewing={previewing}
          shader={open ? shader : null}
          onShader={setShader}
          onClose={() => {
            setSelected(new Set());
            setShader(null);
          }}
        />
      )}
      <div className="hud" ref={hud}>
        <Banners />
        <div className="hud-bar" ref={bar}>
          {lights.data && here.length === 0 ? (
            <p className="map-note">
              No lights on floor {floor} yet.{anyUnplaced ? " Drag them in from the drawer." : ""}
            </p>
          ) : (
            <TagChips lights={here} selected={selectedHere} onSelect={selectByTag} />
          )}
          <SketchesLink />
          <UserMenu />
        </div>
      </div>
    </div>
  );
}

/** The floor to show until you pick another: the 4th, where the lights are. */
const DEFAULT_FLOOR = 4;

function initialFloor(): number {
  const n = Number(savedFloor());
  return FLOORS.some((f) => f.id === n) ? n : DEFAULT_FLOOR;
}
