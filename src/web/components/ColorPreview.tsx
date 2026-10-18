// What the selected lights look like right now (as the bulbs make what
// they're asked for), the way Hue shows a room,
// gathered in the bottom left of the map (on a wide screen; a phone hasn't
// the room) with no card, like a car's
// instruments: their colors as dots on a color wheel, or, for the whites, on
// a field of color temperature across and tint up and down (Color · White
// under it); beside it, brightness and fidelity as a tick per light along a
// track, in the color it's showing, and old bulbs as one bar, on from the
// left and off to the right. Lights at exactly the same value share one dot
// (with a count) or tick. Nothing here is a handle: it's a readout. It
// follows the live room (or the preview, while there are pending edits) a
// few times a second.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { isBinary, isOn, madeOf, requestedOf } from "../../shared/fixtures.ts";
import { cssColor, kelvinOf, lemtoneCss, lookOf, lumensText, swatch, whiteAB, type Gamut, type Lemtone, type Vec3 } from "../../shared/lemtone.ts";
import { screenGamut } from "../gamut.ts";
import { latestFrame } from "../live.ts";
import { dotsOf, exact, gather, titleOf, type Placed } from "../marks.ts";
import { wheelColor, wheelSpot } from "../wheel.ts";
import { Goo } from "./Goo.tsx";

// The wheel (and the white field) this wide, and the tracks beside it this
// wide, this far off. Short of room for both side by side, the tracks go
// under the wheel (narrow.ts keeps a wide screen wide enough for that).
const LOOK_PX = 152;
const TRACKS_PX = 220;
const GAP_PX = 18;
// Stacked, it's at most this share of the screen's height, the wheel shrinking (to no smaller than LOOK_MIN) to fit.
const STACKED_SHARE = 0.5;
const LOOK_MIN = 88;
// The white field: color temperature across, tint up and down. A light this
// far off the line (in OKLab a, b), about Duv ±0.05, well into pastels, is a
// white; further off, it isn't on the field.
const K_MIN = 2000;
const K_MAX = 6500;
const TINT_MAX = 0.1;
// The field shows less tint than that, about Duv ±0.02, so it reads as
// whites; a white tinted further sits at its top or bottom edge.
const TINT_SHOWN = 0.04;
const tintAt = (y: number) => y * TINT_SHOWN;
const heightOf = (tint: number) => Math.max(-1, Math.min(1, tint / TINT_SHOWN));
const TICK_MS = 250;

interface Props {
  /** The selected lights. */
  lights: LightInfo[];
}

interface Spot {
  id: number;
  t: Lemtone;
}

export function ColorPreview({ lights }: Props) {
  // A fresh look at the room a few times a second.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  const gamut = screenGamut();
  const frame = latestFrame();

  const colored: Spot[] = [];
  let oldOn = 0;
  let oldCount = 0;
  for (const l of lights) {
    const ch = frame?.lights.get(l.id);
    if (isBinary(l.type)) {
      oldCount++;
      if (isOn(ch)) oldOn++;
      continue;
    }
    // As the light makes it: a color asked for brighter than it can glow shows paler, or dimmer.
    const t = requestedOf(ch, l.type);
    if (t) colored.push({ id: l.id, t: madeOf(t, l.type).light });
  }
  const whites: WhiteSpot[] = colored.flatMap((s) => {
    const white = whiteSpot(s.t);
    return white ? [{ ...s, white }] : [];
  });
  const allWhite = colored.length > 0 && whites.length === colored.length;
  const [chosen, setView] = useState<"color" | "white" | null>(null);
  const view = chosen ?? (allWhite ? "white" : "color");
  const [full, tracks, gap] = [LOOK_PX, TRACKS_PX, GAP_PX];
  // As wide as the wheel and tracks side by side, at most; as wide as the
  // wider of them, stacked, at least, which is what the row wraps by. In
  // between, it takes what room the row has, and stacks.
  const look = colored.length > 0;
  const side = look ? full + gap + tracks : tracks;
  const least = look ? Math.max(full, tracks) : tracks;
  const [stacked, setStacked] = useState(false);
  // Stacked, the wheel as big as fits in its share of the screen's height.
  const [room, setRoom] = useState<number | null>(null);
  const size = stacked && room !== null ? Math.min(full, room) : full;
  const now = useRef({ side, size, look });
  now.current = { side, size, look };

  // Its height, so the map's fit leaves room for it (--preview-h); its width,
  // for whether it stacks; and the screen's height, for how big the wheel is
  // then. Measured as it renders too, not only when the browser says it's
  // resized, so a fit right after the selection changes has its new height.
  const root = useRef<HTMLElement>(null);
  const measure = () => {
    const el = root.current;
    const app = el?.closest<HTMLElement>(".app");
    if (!el) return;
    const { side, size, look } = now.current;
    setStacked(el.clientWidth < side - 0.5);
    if (!app) return;
    const rest = el.offsetHeight - (look ? size : 0);
    setRoom(Math.max(LOOK_MIN, Math.floor(app.clientHeight * STACKED_SHARE - rest)));
    app.style.setProperty("--preview-h", `${el.offsetHeight}px`);
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => measureRef.current());
  useLayoutEffect(() => {
    const el = root.current!;
    const app = el.closest<HTMLElement>(".app");
    const watch = new ResizeObserver(() => measureRef.current());
    watch.observe(el);
    if (app) watch.observe(app);
    return () => {
      watch.disconnect();
      app?.style.removeProperty("--preview-h");
    };
  }, []);

  const style = { flex: `100 1 ${least}px`, maxWidth: side, gap, "--tracks": `${tracks}px`, "--look": `${size}px` } as CSSProperties;
  const rows = (look ? 2 : 0) + (oldCount > 0 ? 1 : 0);
  return (
    <section
      className={["color-preview", look && "has-look", stacked && "stacked"].filter(Boolean).join(" ")}
      ref={root}
      style={style}
      aria-label="What they look like"
    >
      {look && (
        <div className="preview-look">
          <div className="preview-tabs" role="tablist" aria-label="Show">
            {(["color", "white"] as const).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "tab on" : "tab"} onClick={() => setView(v)}>
                {v === "color" ? "Color" : "White"}
              </button>
            ))}
          </div>
          {view === "color" ? (
            <Wheel spots={colored} gamut={gamut} size={size} />
          ) : (
            <WhiteField spots={whites} gamut={gamut} size={size} hidden={colored.length - whites.length} />
          )}
        </div>
      )}
      {/* Rows alike, spread over the wheel's height: the first label at its top, the last bar at its bottom. */}
      <div className={rows === 2 ? "preview-tracks two" : "preview-tracks"}>
        {look && <Brightness spots={colored} gamut={gamut} />}
        {look && <Fidelity spots={colored} gamut={gamut} />}
        {oldCount > 0 && <OnOff on={oldOn} count={oldCount} gamut={gamut} />}
      </div>
    </section>
  );
}

// ---- marks ----------------------------------------------------------------------

/** Lights along a track (`x` from 0 to 1) painted `track`: a tick each, in the color it's showing, as bright as it looks. */
function Ticks({ placed, track, gamut, title }: { placed: Placed[]; track: string; gamut: Gamut; title?: string }) {
  return (
    <div className="ticks" style={{ "--track": track } as CSSProperties} title={title}>
      {gather(placed).map((g) => (
        <span key={g.key} className="tick" style={{ left: `${g.x * 100}%`, background: lemtoneCss(g.t, gamut) }} title={titleOf(g)} />
      ))}
    </div>
  );
}

// ---- the color wheel ----------------------------------------------------------------

function Wheel({ spots, gamut, size }: { spots: Spot[]; gamut: Gamut; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    paint(canvas.current!, size, size, gamut, (dx, dy) => {
      // dx, dy from -1 to 1 across the canvas; outside the disc is clear.
      const d = Math.hypot(dx, dy);
      if (d > 1) return null;
      return { rgb: swatch(...wheelColor(dx, dy), gamut), alpha: Math.min(1, (1 - d) * size * 0.45 + 0.1) };
    });
  }, [gamut, size]);

  const r = size / 2;
  const placed = spots.map(({ id, t }) => {
    const { dx, dy } = wheelSpot(t.a, t.b);
    return { id, same: exact(t.a, t.b), x: r + dx * r, y: r - dy * r, t, label: colorLabel(t) };
  });
  return (
    <div className="wheel" style={{ width: size, height: size }}>
      <canvas ref={canvas} style={{ width: size, height: size }} aria-hidden="true" />
      <Goo marks={dotsOf(placed)} width={size} height={size} gamut={gamut} />
    </div>
  );
}

// ---- the white field --------------------------------------------------------------

interface WhiteSpot extends Spot {
  white: { kelvin: number; tint: number };
}

/** Where on the black-body line a color is, and how far off it (tint), or null if it isn't a white in range. */
const whiteCache = new Map<string, { kelvin: number; tint: number } | null>();
function whiteSpot(t: Lemtone): { kelvin: number; tint: number } | null {
  const key = `${t.a.toFixed(4)},${t.b.toFixed(4)}`;
  if (whiteCache.has(key)) return whiteCache.get(key)!;
  if (whiteCache.size > 4000) whiteCache.clear();
  const kelvin = kelvinOf(t.a, t.b, TINT_MAX);
  const spot = kelvin === null || kelvin < K_MIN - 200 || kelvin > K_MAX + 500 ? null : { kelvin, tint: tintOf(t.a, t.b, kelvin) };
  whiteCache.set(key, spot);
  return spot;
}

/** The direction across the black-body line at `kelvin`, in OKLab a, b. */
function across(kelvin: number): [number, number] {
  const [a0, b0] = whiteAB(kelvin - 20);
  const [a1, b1] = whiteAB(kelvin + 20);
  const len = Math.hypot(a1 - a0, b1 - b0) || 1;
  return [-(b1 - b0) / len, (a1 - a0) / len];
}

const tintOf = (a: number, b: number, kelvin: number) => {
  const [wa, wb] = whiteAB(kelvin);
  const [na, nb] = across(kelvin);
  return (a - wa) * na + (b - wb) * nb;
};

/** The whites, square as the wheel: color temperature across, tint up and down. */
function WhiteField({ spots, gamut, size, hidden }: { spots: WhiteSpot[]; gamut: Gamut; size: number; hidden: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const columns = new Map<number, { w: [number, number]; n: [number, number] }>();
    paint(canvas.current!, size, size, gamut, (dx, dy, px) => {
      let col = columns.get(px);
      if (!col) {
        const k = K_MIN + ((dx + 1) / 2) * (K_MAX - K_MIN);
        columns.set(px, (col = { w: whiteAB(k), n: across(k) }));
      }
      const tint = tintAt(dy);
      return { rgb: swatch(col.w[0] + col.n[0] * tint, col.w[1] + col.n[1] * tint, gamut), alpha: 1 };
    });
  }, [gamut, size]);

  const placed = spots.map(({ id, t, white }) => ({
    id,
    same: exact(t.a, t.b),
    x: clamp((white.kelvin - K_MIN) / (K_MAX - K_MIN)) * size,
    // Tint up is up, as the field is painted.
    y: ((1 - heightOf(white.tint)) / 2) * size,
    t,
    label: `${Math.round(white.kelvin / 50) * 50} K`,
  }));
  return (
    // Its scale, and the lights it leaves out, written small in its own corners, under the dots.
    <div className="white-view">
      <div className="white-strip" style={{ width: size, height: size }}>
        <canvas ref={canvas} aria-hidden="true" />
        <span className="field-note warm">warm</span>
        <span className="field-note cool">cool</span>
        {hidden > 0 && (
          <span className="field-note left-out" title={`${hidden} of the lights aren't whites, so aren't shown here`}>
            +{hidden} not white
          </span>
        )}
        <Goo marks={dotsOf(placed)} width={size} height={size} gamut={gamut} />
      </div>
    </div>
  );
}

// ---- brightness and fidelity --------------------------------------------------------

/** From off to full, as bright as it looks. Off is off, whatever the color. */
function Brightness({ spots, gamut }: { spots: Spot[]; gamut: Gamut }) {
  const placed = spots.map(({ id, t }) => ({
    id,
    same: t.brightness > 0 ? exact(t.brightness, t.a, t.b) : "off",
    x: lookOf(t.brightness),
    y: 0,
    t,
    label: t.brightness > 0 ? `${lumensText(t.brightness)}, ${colorLabel(t)}` : "off",
  }));
  const levels = spots.map((s) => s.t.brightness);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  // "101–450 lm": one unit, so it fits on one line beside its label.
  const range = lo === hi ? (hi > 0 ? lumensText(hi) : "off") : `${lo > 0 ? lumensText(lo).replace(" lm", "") : "off"}–${lumensText(hi)}`;
  return (
    <div className="track-view">
      <div className="field-head">
        <span className="label">Brightness</span>
        <span className="mono">{range}</span>
      </div>
      {/* Off to full, the off end lifted just off the dark so the track's whole length shows. */}
      <Ticks placed={placed} track="linear-gradient(90deg, #2a2520, #fff6e8)" gamut={gamut} />
    </div>
  );
}

/** From pale colors built from the RGB LEDs (vivid) to built from the white ones (natural). */
function Fidelity({ spots, gamut }: { spots: Spot[]; gamut: Gamut }) {
  const placed = spots.map(({ id, t }) => ({
    id,
    same: exact(t.fidelity, t.brightness, t.a, t.b),
    x: clamp(t.fidelity),
    y: 0,
    t,
    label: `F${t.fidelity.toFixed(2)}, ${colorLabel(t)}`,
  }));
  const levels = spots.map((s) => s.t.fidelity);
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  return (
    <div className="track-view">
      <div className="field-head">
        <span className="label">Fidelity</span>
        <span className="mono">{lo === hi ? `F${hi.toFixed(2)}` : `F${lo.toFixed(2)}–${hi.toFixed(2)}`}</span>
      </div>
      {/* As the picker's fidelity slider, a little lifted off the dark. */}
      <Ticks
        placed={placed}
        track="linear-gradient(90deg, #5b4c92, #8a7352 60%, #b49c75)"
        gamut={gamut}
        title="Fidelity: vivid (pale colors from the RGB LEDs) to natural (from the white ones)"
      />
    </div>
  );
}

// ---- old bulbs ----------------------------------------------------------------------

function OnOff({ on, count, gamut }: { on: number; count: number; gamut: Gamut }) {
  // An old bulb on: a 2700 K filament.
  const [a, b] = whiteAB(2700);
  const style = { "--on": `${(on / count) * 100}%`, "--filament": cssColor(swatch(a, b, gamut), gamut) } as CSSProperties;
  // Just one: whether it's on, and no bar.
  if (count === 1) {
    return (
      <div className="onoff-view one" style={style}>
        <div className="field-head">
          <span className="label">Old bulb</span>
          <span className="mono">
            {/* Lit, or just its outline. */}
            <span className={on > 0 ? "onoff-lamp" : "onoff-lamp off"} aria-hidden="true" />
            {on > 0 ? "On" : "Off"}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="onoff-view">
      <div className="field-head">
        <span className="label">Old bulbs</span>
        <span className="mono">
          {on} on · {count - on} off
        </span>
      </div>
      <div className="onoff-bar" style={style} role="img" aria-label={`${on} of ${count} old bulbs on`}>
        <span className="onoff-on" />
      </div>
    </div>
  );
}

// ---- helpers ------------------------------------------------------------------------

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** A color, as the pin's hover says it: a temperature for whites (on the line, not just on the strip), else hue and chroma. */
function colorLabel(t: Lemtone): string {
  const kelvin = kelvinOf(t.a, t.b);
  if (kelvin !== null) return `${Math.round(kelvin / 50) * 50} K`;
  const hue = Math.round(((Math.atan2(t.b, t.a) * 180) / Math.PI + 360) % 360);
  return `${hue}° C${Math.hypot(t.a, t.b).toFixed(2)}`;
}

/**
 * Fill a canvas pixel by pixel in the screen's gamut. `at` gets the pixel's
 * place as -1 to 1 across and up (and its column), and gives its color, or
 * null to leave it clear.
 */
function paint(
  c: HTMLCanvasElement,
  width: number,
  height: number,
  gamut: Gamut,
  at: (dx: number, dy: number, px: number) => { rgb: Vec3; alpha: number } | null,
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { colorSpace: gamut })!;
  const img = ctx.createImageData(w, h, { colorSpace: gamut });
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const v = at(((px + 0.5) / w) * 2 - 1, 1 - ((py + 0.5) / h) * 2, px);
      if (!v) continue;
      const i = (py * w + px) * 4;
      img.data[i] = v.rgb[0] * 255;
      img.data[i + 1] = v.rgb[1] * 255;
      img.data[i + 2] = v.rgb[2] * 255;
      img.data[i + 3] = 255 * v.alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
}
