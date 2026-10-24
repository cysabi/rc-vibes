// Streetview: the room as a camera saw it, relit with the lights as they are
// now, beside the map (side by side, or above it on a tall screen). It shows
// a size the device can redraw every frame while the lights change (720p- or
// 1080p-class), and once they've held still a moment, the next size up, if
// the device can hold that too.

import { useEffect, useRef, useState, type RefObject } from "react";
import { useStreetViews } from "../api.ts";
import { CloseIcon } from "../icons.tsx";
import { useFrames } from "../live.ts";
import { useLights } from "../scene.ts";
import { loadBasis, pickEncoding, pickTiers, type Basis, type Manifest, type Tier } from "../streetview/basis.ts";
import { Relighter, type Look } from "../streetview/render.ts";
import { bulbsOf, sameWeights, weightsOf } from "../streetview/weights.ts";

// How long the lights hold still before the larger size takes over.
const SETTLE_MS = 400;

const sizeName = (t: Tier) => (t.height >= 2000 ? "4K" : t.height >= 1000 ? "1080p" : "720p");

export function StreetView({ id, onClose }: { id: string; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frames = useFrames();
  const lights = useLights();
  const views = useStreetViews();
  const known = views.data?.some((v) => v.id === id);
  const [status, setStatus] = useState("Loading the photographs…");
  const [error, setError] = useState<string | null>(null);
  const [ev, setEv] = useState(0);
  const evRef = useRef(ev);
  evRef.current = ev;
  const types = useRef(new Map<number, string>());
  types.current = new Map((lights.data?.lights ?? []).map((l) => [l.id, l.type]));

  // Escape goes back to the map, before anything under this hears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    const stop = new AbortController();
    const base = `/api/streetview/${encodeURIComponent(id)}/`;
    const bases: Basis[] = [];
    let relighter: Relighter | null = null;
    let raf = 0;
    let gone = false;

    (async () => {
      const [m, look] = await Promise.all(
        ["manifest.json", "look.json"].map(async (f) => {
          const res = await fetch(base + f, { signal: stop.signal });
          if (!res.ok) throw new Error(res.status === 404 ? "There are no photographs from here." : `Couldn't load the photographs (${res.status}).`);
          return res.json();
        }),
      ) as [Manifest, Look];
      const made = await Relighter.create(canvas.current!, look);
      if (gone) return typeof made === "string" ? undefined : made.destroy();
      if (typeof made === "string") throw new Error(made);
      relighter = made;
      const small = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 900;
      const { live, settle } = pickTiers(m, made.keeping, small, made.maxSide);
      const livePick = await pickEncoding(live);
      if (!livePick) throw new Error("This browser can't decode the photographs (it needs AV1 or H.264).");

      const liveBasis = await loadBasis(made.device, base, m, live, livePick, made.keeping, stop.signal, (p) =>
        setStatus(`Loading the photographs… ${Math.round(p * 100)}%`),
      );
      if (gone) return liveBasis.destroy();
      bases.push(liveBasis);
      const bulbs = bulbsOf(liveBasis.layers.keys());
      let settled: Basis | null = null;
      let weights = weightsOf(frames.latest(), bulbs, types.current);
      let changedAt = performance.now();
      let drawn: { basis: Basis; ev: number } | null = null;
      const unsubscribe = frames.subscribe((f) => {
        const w = weightsOf(f, bulbs, types.current);
        if (sameWeights(w, weights)) return;
        weights = w;
        changedAt = performance.now();
        drawn = null;
      });
      stop.signal.addEventListener("abort", unsubscribe);

      const label = (b: Basis) => `${sizeName(b === liveBasis ? live : settle!)} · ${b === liveBasis ? "live" : "settled"}`;
      const loop = (now: number) => {
        const still = now - changedAt > SETTLE_MS;
        const basis = still && settled ? settled : liveBasis;
        if (!drawn || drawn.basis !== basis || drawn.ev !== evRef.current) {
          made.draw(basis, weights, m.gamma, evRef.current);
          if (drawn?.basis !== basis) setStatus(label(basis));
          drawn = { basis, ev: evRef.current };
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      // The larger size, in the background, for when the lights hold still.
      if (settle) {
        const pick = await pickEncoding(settle);
        if (pick) {
          try {
            const b = await loadBasis(made.device, base, m, settle, pick, made.keeping, stop.signal, () => {});
            if (gone) return b.destroy();
            bases.push(b);
            settled = b;
          } catch (err) {
            if (!stop.signal.aborted) console.warn("streetview: keeping to the live size:", err);
          }
        }
      }
    })().catch((err: unknown) => {
      if (stop.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      gone = true;
      stop.abort();
      cancelAnimationFrame(raf);
      for (const b of bases) b.destroy();
      relighter?.destroy();
    };
  }, [id, frames]);

  return (
    <div className="streetview" role="dialog" aria-label={`The room from camera ${id}`}>
      <canvas ref={canvas} className="streetview-canvas" />
      <div className="streetview-top">
        <p className="streetview-title">
          From camera <span className="mono">{id}</span>
        </p>
        <button className="glass-button streetview-close" onClick={onClose} title="Close streetview (Esc)" aria-label="Close streetview">
          <CloseIcon />
        </button>
      </div>
      <div className="streetview-bottom">
        {error || (views.data && !known) ? (
          <p className="map-note bad">{error ?? "There's no camera by that name."}</p>
        ) : (
          <p className="map-note mono">{status}</p>
        )}
        <label className="streetview-exposure map-note">
          Exposure
          <input type="range" min={-4} max={4} step={0.1} value={ev} onChange={(e) => setEv(Number(e.target.value))} />
          <span className="mono">{ev > 0 ? "+" : ""}{ev.toFixed(1)}</span>
        </label>
      </div>
    </div>
  );
}

const SPLIT_MIN = 0.25;
const SPLIT_MAX = 0.8;
const tall = () => matchMedia("(orientation: portrait)").matches;
// Remembered for each way round. Side by side the photograph gets a bit more
// than half; above the map, about what a 3:2 photograph needs across a phone.
const SPLIT_KEY = () => (tall() ? "vibes.streetviewSplitTall" : "vibes.streetviewSplit");
const SPLIT_DEFAULT = () => (tall() ? 0.4 : 0.56);

/**
 * The line between streetview and the map: drag it to give either more room
 * (remembered here), double-click it for the usual split. It sets the app's
 * --split straight away, so the map just resizes, without React redrawing it.
 */
export function SplitHandle({ app }: { app: RefObject<HTMLDivElement | null> }) {
  const set = (f: number) => app.current?.style.setProperty("--split", `${(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, f)) * 100).toFixed(2)}%`);
  const saved = () => {
    try {
      const f = Number(localStorage.getItem(SPLIT_KEY()));
      return f >= SPLIT_MIN && f <= SPLIT_MAX ? f : SPLIT_DEFAULT();
    } catch {
      return SPLIT_DEFAULT();
    }
  };
  const save = (f: number | null) => {
    try {
      if (f === null) localStorage.removeItem(SPLIT_KEY());
      else localStorage.setItem(SPLIT_KEY(), String(f));
    } catch {
      // Not remembered, then.
    }
  };
  const at = useRef<number | null>(null);
  useEffect(() => {
    set(saved());
    const el = app.current;
    return () => {
      el?.style.removeProperty("--split");
    };
    // Once, for the app it splits.
  }, [app]);
  const fraction = (e: { clientX: number; clientY: number }) => {
    const r = app.current!.getBoundingClientRect();
    return tall() ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  };
  return (
    <div
      className="split-handle"
      role="separator"
      aria-orientation={tall() ? "horizontal" : "vertical"}
      aria-label="Resize streetview"
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        at.current = fraction(e);
      }}
      onPointerMove={(e) => {
        if (at.current === null) return;
        at.current = fraction(e);
        set(at.current);
      }}
      onPointerUp={() => {
        if (at.current !== null) save(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, at.current)));
        at.current = null;
      }}
      onDoubleClick={() => {
        set(SPLIT_DEFAULT());
        save(null);
      }}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -0.04 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 0.04 : 0;
        if (!step) return;
        e.preventDefault();
        const f = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, saved() + step));
        set(f);
        save(f);
      }}
    />
  );
}
