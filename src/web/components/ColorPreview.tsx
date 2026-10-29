// What the selected lights look like right now (as the bulbs make what
// they're asked for), the way Hue shows a room,
// gathered in the map's top left (on a wide screen; a phone hasn't
// the room) with no card, like a car's
// instruments: their colors as dots on a color wheel, or, for the whites, on
// a field of color temperature across and tint up and down (Color · White
// over it); under it, brightness and fidelity as a small metaball per light
// along a track, in the color it's showing. (Old bulbs, just on or off, aren't here.)
// Lights at exactly the same value share one dot (with a count) or ball.
// Every ball on the wheel has a thin rim, so the little card isn't all
// outline. Nothing here is a handle: it's a readout. It
// follows the live room (or the preview, while there are pending edits) a
// few times a second.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { isBinary, madeOf, requestedOf } from "../../shared/fixtures.ts";
import { kelvinOf, lookOf, lumensText, swatch, whiteAB, type Gamut, type Lemtone, type Vec3 } from "../../shared/lemtone.ts";
import { useGamut } from "../display.ts";
import { useFrames } from "../live.ts";
import { dotsOf, exact, type Group, type Placed } from "../marks.ts";
import { wheelColor, wheelSpot } from "../wheel.ts";
import { heightOf, tintAt, toneText } from "../whites.ts";
import { Goo } from "./Goo.tsx";

// The wheel (and the white field) this wide, the tracks under it as wide as
// its box, this far below it; with no wheel, the tracks this wide.
const LOOK_PX = 152;
const TRACKS_PX = 220;
const GAP_PX = 14;
// It's at most this share of the screen's height, the wheel shrinking (to no smaller than LOOK_MIN) to fit.
const STACKED_SHARE = 0.5;
const LOOK_MIN = 88;
// The box round the wheel, across: the box's padding (styles.css: .tone-box), the wheel filling its pane.
const LOOK_FRAME = 2 * 4;
// The white field: color temperature across, tint up and down. A light this
// far off the line (in OKLab a, b), about Duv ±0.05, well into pastels, is a
// white; further off, it isn't on the field.
const K_MIN = 2000;
const K_MAX = 6500;
const TINT_MAX = 0.1;
// The field's tint up and down is the color editor's strip of whites' (whites.ts):
// all but on the line through the middle, plainly tinted at the edges.

interface Props {
  /** The selected lights. */
  lights: LightInfo[];
}

interface Spot {
  id: number;
  t: Lemtone;
}

export function ColorPreview({ lights }: Props) {
  // The room as it changes: drawn again with each new frame, at most once a
  // frame on the screen.
  const frames = useFrames();
  const [, tick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const off = frames.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        tick((n) => n + 1);
      });
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [frames]);
  const gamut = useGamut();
  const frame = frames.latest();

  const colored: Spot[] = [];
  for (const l of lights) {
    const ch = frame?.lights.get(l.id);
    if (isBinary(l.type)) continue;
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
  // The tracks under the wheel, as wide as its box (to save room across).
  const look = colored.length > 0;
  // The wheel as big as fits in its share of the screen's height.
  const [room, setRoom] = useState<number | null>(null);
  const size = room !== null ? Math.min(full, room) : full;
  const width = look ? size + LOOK_FRAME : tracks;
  const now = useRef({ size, look });
  now.current = { size, look };

  // Its height, so the map's fit leaves room for it (--preview-h), and the
  // screen's height, for how big the wheel is. Measured as it renders too, not only when the browser says it's
  // resized, so a fit right after the selection changes has its new height.
  const root = useRef<HTMLElement>(null);
  const measure = () => {
    const el = root.current;
    const app = el?.closest<HTMLElement>(".app");
    if (!el) return;
    const { size, look } = now.current;
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

  const style = { flex: `100 1 ${width}px`, maxWidth: width, gap, "--tracks": `${width}px`, "--look": `${size}px` } as CSSProperties;
  return (
    <section
      className={["color-preview", look && "has-look"].filter(Boolean).join(" ")}
      ref={root}
      style={style}
      aria-label="What they look like"
    >
      {look && (
        // The color editor's box of tabs (ColorField.tsx), White · Color over the wheel or the field.
        <div className="preview-look tone-box">
          <div className="tone-tabs" role="tablist" aria-label="Show">
            {(["white", "color"] as const).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "tone-tab on" : "tone-tab"} onClick={() => setView(v)}>
                {v === "color" ? "Color" : "White"}
              </button>
            ))}
          </div>
          <div className="tone-pick">
            {view === "color" ? (
              <Wheel spots={colored} gamut={gamut} size={size} />
            ) : (
              <WhiteField spots={whites} gamut={gamut} size={size} hidden={colored.length - whites.length} />
            )}
          </div>
        </div>
      )}
      {/* Rows alike, under the wheel. */}
      <div className="preview-tracks">
        {look && <Brightness spots={colored} gamut={gamut} />}
        {look && <Fidelity spots={colored} gamut={gamut} />}
      </div>
    </section>
  );
}

// ---- marks ----------------------------------------------------------------------

// Every ball's rim in the look card (px): thinner than the goo's own, so a small card isn't all outline.
const THIN_RIM = 1.5;
// A ball on the wheel or the white field (px across): a light's, and a count's
// (room for its number), nearer alike than the picker's (marks.ts' sizeOf), so
// two lights together don't look so much more than one.
const lookSize = (n: number) => (n === 1 ? 16 : n < 100 ? 21 : 26);
const thinRim = (g: Group) => ({ size: lookSize(g.ids.length), rimPx: THIN_RIM });

// A ball on a track (px across): a light's small, a little wider than the
// track, so they sit on it rather than cover it; a count's room for its number,
// within the track's row.
const TRACK_BALL = 14;
const TRACK_COUNT_BALL = 17;
const trackSize = (n: number) => (n > 1 ? TRACK_COUNT_BALL : TRACK_BALL);
const trackBall = (g: Group) => ({ size: trackSize(g.ids.length), rimPx: THIN_RIM });
// Counts on a track join as soon as they overlap at all (marks.ts' dotsOf), so a blob has one number.
const TRACK_JOIN = 0.01;

/**
 * Lights along a track (`x` from 0 to 1) painted `track`: as the wheel's are,
 * metaballs in the colors they're showing, lights at exactly the same value
 * one ball (bigger, with how many), balls near each other running together:
 * a single light mostly under a count is counted there, and counts that
 * overlap are one blob with one number (marks.ts' dotsOf).
 */
function Ticks({ placed, track, gamut }: { placed: Placed[]; track: string; gamut: Gamut }) {
  const box = useRef<HTMLDivElement>(null);
  // How wide it is as it's laid out (the card's as wide as the wheel's box), for where the balls go on it.
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const marks = dotsOf(
    placed.map((p) => ({ ...p, x: p.x * size.w, y: size.h / 2 })),
    { size: trackSize, joinCover: TRACK_JOIN },
  );
  return (
    <div ref={box} className="ticks" style={{ "--track": track } as CSSProperties}>
      {size.w > 0 && <Goo marks={marks} width={size.w} height={size.h} gamut={gamut} lookOf={trackBall} />}
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
      <canvas key={gamut} ref={canvas} style={{ width: size, height: size }} aria-hidden="true" />
      <Goo marks={dotsOf(placed, { size: lookSize })} width={size} height={size} gamut={gamut} lookOf={thinRim} />
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
    label: toneText(t.a, t.b),
  }));
  return (
    // Its scale, and the lights it leaves out, written small in its own corners, under the dots.
    <div className="white-view">
      <div className="white-strip" style={{ width: size, height: size }}>
        <canvas key={gamut} ref={canvas} aria-hidden="true" />
        {hidden > 0 && (
          <span className="field-note left-out">
            +{hidden} not white
          </span>
        )}
        <Goo marks={dotsOf(placed, { size: lookSize })} width={size} height={size} gamut={gamut} lookOf={thinRim} />
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
      <Ticks placed={placed} track="linear-gradient(90deg, #5b4c92, #8a7352 60%, #b49c75)" gamut={gamut} />
    </div>
  );
}

// ---- helpers ------------------------------------------------------------------------

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** A color, as the pin's hover says it: as it's said everywhere (whites.ts). */
const colorLabel = (t: Lemtone): string => toneText(t.a, t.b);

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
