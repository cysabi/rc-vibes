// A color editor, for one light's color or many at once, the way Hue's
// picker works. Values at exactly the same color are one circle on a color
// wheel (or along a strip of whites), with a count, and one circle is active:
// tap another to make it so. Dragging a circle (or tapping elsewhere, which
// takes the active one there) sets the color of just its lights; let go on
// another circle and it takes that one's color, so the two become one. ⌥-drag
// pulls a single light off on its own. Brightness and fidelity set the
// active circle's lights alike, and Apply all gives every light its color.
// Where the values come from, and where a change goes, is up to whoever
// uses it.
//
// The wheel is OKLCh at L = 1, the canonical Lemtone plane: hue goes round,
// chroma goes out from white, as far as the bulbs' bluest blue (wheel.ts).
// Brightness is absolute (1.0 = 1000 lm) on a cube-root track, roughly how
// bright it looks, so the dim end, where saturated colors live, gets room. The
// track tops out at the active lights' rated output: 1000 lm for color bulbs,
// 4000 lm for 4×1 panels (the brighter, if they're mixed).
// Where the active lights, at their brightness, can't make colors as asked,
// the wheel and the strip show what they make instead, striped, bordered
// round what they can. A circle asked for there sits where its light lands,
// in its color, with a ghost of it where it's asked for, and it says how far
// short the lights fall. Circles whose lights land in the same spot are one
// circle there, counting them all: tapping it makes them all active, and
// dragging it takes them all, which makes them one; each one's ghost still
// picks up just it.

import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { Output } from "../../shared/bulb.ts";
import { madeOf, ratedBrightnessOf, solvesLemtones } from "../../shared/fixtures.ts";
import { abOf, colorName, cssColor, hueChroma, kelvinOf, lemtoneCode, lookOf, lumensText, swatch, whiteAB, type Gamut, type Lemtone, type Vec3 } from "../../shared/lemtone.ts";
import { paintOnGpu } from "../backdrop.ts";
import { useGamut } from "../display.ts";
import { exact } from "../marks.ts";
import { chromaAt, WHEEL_CHROMA, wheelColor, wheelSpot } from "../wheel.ts";
import { across, heightOf, K_MAX, K_MIN, TINT, TINT_CURVE, tintAt, whiteAt } from "../whites.ts";
import { count, listOf } from "../words.ts";
import { Segmented } from "./Segmented.tsx";
import { Slider } from "./Slider.tsx";

/** The top of the brightness track where the lights' types aren't known: a color bulb's rated output. */
const B_MAX = 1;
const WHEEL = 224;
const STRIP_H = 96;
// The strip's usual width (it's as wide as there's room): near enough, for which lights land in one spot.
const STRIP_W = 320;
/** Let go this near (px) another circle, and it takes that one's color. */
const SNAP_PX = 14;
// How near (px) a finger has to land to a circle to pick it.
const FINGER_PX = 24;
/** Circles whose lights land this near (px) each other are one circle there. */
const SAME_PX = 4;
/** A press that moves less than this (px) is a tap: it only picks. */
const TAP_PX = 4;

interface Props {
  /** The colors being edited: one, or many (one per light, say). */
  values: Lemtone[];
  /**
   * Set `patch` on the values at `which` (indices into `values`), leaving the
   * rest of each as it is. `code` names the change shortly, for the history.
   */
  onChange: (patch: Partial<Lemtone>, code: string, which: number[]) => void;
  /** Each value's light's type, for what it makes of a color, to show it as it'll look (madeOf); each makes it as asked if not given. */
  types?: string[];
}

/** Values at exactly the same color: one circle. */
interface Circle {
  a: number;
  b: number;
  /** Indices into the values. */
  members: number[];
  /** The light its bulbs make (of its most common brightness): what it's shown in. */
  seen: Lemtone;
}

export function ColorEditor({ values, onChange, types }: Props) {
  const made = (t: Lemtone, i: number) => (types ? madeOf(t, types[i]!) : asked(t));
  const gamut = useGamut();
  const circles = circlesOf(values, made);
  // The active circles, each known by one of its values, so they stay themselves as they
  // move and merge: one, or all of those whose lights land in a spot, picked up there.
  const [activeAt, setActiveAt] = useState<number[]>([]);
  // Which picker shows; until you choose, whichever suits the active circles.
  const [chosenMode, setMode] = useState<"white" | "color" | null>(null);
  // The values being dragged, from the press to the letting go.
  const moving = useRef<number[] | null>(null);
  const picked = circles.filter((c) => c.members.some((i) => activeAt.includes(i)));
  const lead = picked[0] ?? circles[0];
  if (!lead) return null;

  const mode = chosenMode ?? (isWhite(lead.a, lead.b) ? "white" : "color");
  const spots = mode === "white" ? spotsOf(circles, stripPlace, STRIP_W, STRIP_H) : spotsOf(circles, wheelPlace, WHEEL, WHEEL);
  // Until any are picked, the biggest circle, and every one landing with it.
  const chosen = picked.length > 0 ? picked : spots.find((s) => s.circles.includes(lead))!.circles;
  const active = chosen.length > 1 ? together(chosen) : chosen[0]!;
  const many = values.length > 1;
  const all = values.map((_, i) => i);
  const css = (a: number, b: number) => cssColor(swatch(a, b, gamut), gamut);
  const group = active.members.map((i) => values[i]!);
  const common = valuesOf(group)[0]!;
  // What the active circle's lights would make of each color, at their brightness: the
  // backdrops show it. They're painted again when that or the gamut changes (lightKey).
  const sample = active.members[0]!;
  const lightAt = (a: number, b: number) => made({ a, b, brightness: common.brightness, fidelity: common.fidelity }, sample);
  const lightKey = `${common.brightness} ${common.fidelity} ${sample} ${gamut}`;
  const light = { brightness: common.brightness, solves: !!types && solvesLemtones(types[sample]!) };
  const limit = limitText(active.members.map((i) => ({ asked: values[i]!, out: made(values[i]!, i) })));
  // The top of the brightness track: the brightest the active lights are rated for.
  const top = types ? Math.max(...active.members.map((i) => ratedBrightnessOf(types[i]!))) : B_MAX;

  // Pressing a circle makes it active and picks up its values (just one, with ⌥),
  // and pressing where several land, all of theirs; pressing elsewhere picks up
  // the active ones', to bring them there.
  const pick = (pressed: Circle[] | null, alone: boolean) => {
    const cs = pressed ?? chosen;
    const taken = alone ? [cs[cs.length - 1]!.members.at(-1)!] : cs.flatMap((c) => c.members);
    moving.current = taken;
    setActiveAt(alone ? taken : cs.map((c) => c.members[0]!));
  };
  const move = (a: number, b: number) => moving.current && onChange({ a, b }, nameOf(a, b), moving.current);
  const drop = (a: number, b: number, onto: Circle | null) => {
    if (moving.current) {
      const [ta, tb] = onto ? [onto.a, onto.b] : [a, b];
      onChange({ a: ta, b: tb }, nameOf(ta, tb), moving.current);
    }
    moving.current = null;
  };
  const picker = { circles, spots, active, gamut, css, lightAt, lightKey, light, onPick: pick, onMove: move, onDrop: drop };

  return (
    <div className="color-editor">
      <Segmented
        className="stretch"
        label="Kind of light"
        options={[
          { value: "white", label: "White" },
          { value: "color", label: "Color" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === "white" ? <WhiteStrip {...picker} /> : <Wheel {...picker} />}

      {many && (
        <div className="color-active">
          <span className="color-swatch" style={{ background: css(active.seen.a, active.seen.b) }} />
          <span className="color-active-name">{nameOf(active.a, active.b)}</span>
          <span className="color-count">
            {active.members.length} of {values.length}
          </span>
          {circles.length > 1 && (
            <button
              className="color-all"
              title={`Give all ${values.length} this color`}
              onClick={() => onChange({ a: active.a, b: active.b }, nameOf(active.a, active.b), all)}
            >
              Apply all
            </button>
          )}
        </div>
      )}

      <Slider
        label="Brightness"
        value={lookOf(Math.min(top, common.brightness) / top)}
        min={0}
        max={1}
        step={0.005}
        track={brightnessTrack(active.a, active.b, common.fidelity, top, gamut, (t) => made(t, sample).light)}
        display={rangeText(
          group.map((t) => t.brightness),
          (b) => (b > 0 ? lumensText(b) : "off"),
          " lm",
        )}
        marks={marksOf(group.map((t) => ({ at: lookOf(t.brightness / top), key: exact(t.brightness), title: t.brightness > 0 ? lumensText(t.brightness) : "off" })))}
        onChange={(look) => onChange({ brightness: brightnessAt(look, top) }, lumensText(brightnessAt(look, top)), active.members)}
        onCommit={(look) => onChange({ brightness: brightnessAt(look, top) }, lumensText(brightnessAt(look, top)), active.members)}
      />
      {limit && <p className="hint color-limit">{limit}</p>}
      <Slider
        label="Fidelity"
        value={common.fidelity}
        min={0}
        max={1}
        step={0.01}
        track="linear-gradient(90deg, #5b4c92, #8a7352 60%, #b49c75)"
        display={rangeText(
          group.map((t) => t.fidelity),
          (f) => `F${f.toFixed(2)}`,
        )}
        marks={marksOf(group.map((t) => ({ at: t.fidelity, key: exact(t.fidelity), title: `F${t.fidelity.toFixed(2)}` })))}
        ends={["vivid", "natural"]}
        onChange={(f) => onChange({ fidelity: f }, `F${f.toFixed(2)}`, active.members)}
        onCommit={(f) => onChange({ fidelity: f }, `F${f.toFixed(2)}`, active.members)}
      />
    </div>
  );
}

interface PickerProps {
  circles: Circle[];
  /** Where the circles' lights land: one circle at each. */
  spots: Spot[];
  active: Circle;
  gamut: Gamut;
  css: (a: number, b: number) => string;
  /** What the active lights make of a color, which the backdrop shows; painted again when `lightKey` changes. */
  lightAt: (a: number, b: number) => Output;
  lightKey: string;
  /** The same, for the GPU to work out: the active lights' brightness, and whether their bulbs solve lemtones. */
  light: Light;
  /** Pick up these circles (just one light of them, `alone`), or with none, the active ones. */
  onPick: (picked: Circle[] | null, alone: boolean) => void;
  onMove: (a: number, b: number) => void;
  onDrop: (a: number, b: number, onto: Circle | null) => void;
}

/** The colors round a wheel, each circle at its color. */
function Wheel(props: PickerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  usePaint(canvas, props.lightKey, (c) => paintWheel(c, props.lightAt, props.light, props.gamut));
  // A color at a place on the wheel (fractions across and down), the other way from wheelPlace, kept inside the rim.
  const colorAt = (x: number, y: number): [number, number] => {
    const dx = x * 2 - 1;
    const dy = 1 - y * 2;
    let hue = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    return abOf(Math.round(hue) % 360, round(chromaAt(Math.min(1, Math.hypot(dx, dy))), 0.005));
  };
  const step = (a: number, b: number, key: string, big: boolean): [number, number] | null => {
    const { hue, chroma } = hueChroma(a, b);
    const s = big ? 10 : 1;
    if (key === "ArrowLeft") return abOf((hue + s) % 360, chroma);
    if (key === "ArrowRight") return abOf((hue - s + 360) % 360, chroma);
    if (key === "ArrowUp") return abOf(hue, Math.min(WHEEL_CHROMA, chroma + 0.005 * s));
    if (key === "ArrowDown") return abOf(hue, Math.max(0, chroma - 0.005 * s));
    return null;
  };
  return (
    <Picker {...props} className="wheel-picker" width={WHEEL} height={WHEEL} at={wheelPlace} colorAt={colorAt} step={step} label="Color">
      <canvas key={props.gamut} ref={canvas} style={{ width: WHEEL, height: WHEEL }} aria-hidden="true" />
    </Picker>
  );
}

/**
 * The whites, warm to cool across, with a little tint up (pinker) and down
 * (greener) of the black-body line. Each circle sits at its temperature and
 * tint; a color tinted past the edge, or not a white at all, sits hollow at
 * the nearest place.
 */
function WhiteStrip(props: PickerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  usePaint(canvas, props.lightKey, (c) => paintWhites(c, props.lightAt, props.light, props.gamut));
  const colorAt = (x: number, y: number) => whiteAt(round(K_MIN + x * (K_MAX - K_MIN), 50), tintAt(1 - 2 * y));
  const step = (a: number, b: number, key: string, big: boolean): [number, number] | null => {
    const { k, tint } = whiteSpot(a, b);
    if (key === "ArrowRight" || key === "ArrowLeft") return whiteAt(clampK(round(k + (key === "ArrowRight" ? 50 : -50) * (big ? 10 : 1), 50)), tint);
    if (key !== "ArrowUp" && key !== "ArrowDown") return null;
    const h = Math.max(-1, Math.min(1, heightOf(tint) + (key === "ArrowUp" ? 0.05 : -0.05) * (big ? 4 : 1)));
    return whiteAt(k, tintAt(h));
  };
  return (
    <div className="white-picker-wrap">
      <Picker
        {...props}
        className="white-picker"
        width={null}
        height={STRIP_H}
        at={stripPlace}
        colorAt={colorAt}
        step={step}
        outside={(a, b) => !isWhite(a, b)}
        label="Color temperature and tint"
      >
        <canvas key={props.gamut} ref={canvas} className="white-picker-field" aria-hidden="true" />
      </Picker>
      <div className="white-picker-scale mono">
        {[2700, 4000, 5000, 6500].map((k) => (
          <span key={k} style={{ left: `${((k - K_MIN) / (K_MAX - K_MIN)) * 100}%` }}>
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The circles over a backdrop (a wheel, a strip), and pressing, dragging and
 * letting go of them: `at` places a color (as fractions across and down),
 * `colorAt` reads one back, `step` moves one by a key.
 */
function Picker({
  circles,
  spots,
  active,
  css,
  onPick,
  onMove,
  onDrop,
  className,
  width,
  height,
  at,
  colorAt,
  step,
  outside,
  label,
  children,
}: PickerProps & {
  className: string;
  /** null: as wide as there's room. */
  width: number | null;
  height: number;
  at: (a: number, b: number) => { x: number; y: number };
  colorAt: (x: number, y: number) => [number, number];
  step: (a: number, b: number, key: string, big: boolean) => [number, number] | null;
  /** Colors it can't show where they are: drawn hollow, at the nearest place. */
  outside?: (a: number, b: number) => boolean;
  label: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The links' mask, by an id of this picker's own (useId's colons don't belong in url()).
  const maskId = `picker-links-${useId().replace(/[^\w-]/g, "")}`;
  // From the press to the letting go: where it was pressed, and whether it's gone far enough since to be a drag.
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const on = new Set(active.members);
  const isOn = (c: Circle) => on.has(c.members[0]!);

  const fraction = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))] as const;
  };
  /** The circle (other than those being dragged) within SNAP_PX of where it's let go: of it, or of its ghost. */
  const near = (e: PointerEvent): Circle | null => {
    const r = box.current!.getBoundingClientRect();
    let best: Circle | null = null;
    let bestD = SNAP_PX;
    for (const c of circles) {
      if (isOn(c)) continue;
      for (const p of [at(c.a, c.b), at(c.seen.a, c.seen.b)]) {
        const d = Math.hypot(r.left + p.x * r.width - e.clientX, r.top + p.y * r.height - e.clientY);
        if (d < bestD) [best, bestD] = [c, d];
      }
    }
    return best;
  };

  /** The circle or ghost nearest a finger, within FINGER_PX of its middle. */
  const nearest = (e: PointerEvent): HTMLElement | null => {
    let best: HTMLElement | null = null;
    let bestD = FINGER_PX;
    for (const el of box.current!.querySelectorAll<HTMLElement>("[data-ghost], [data-spot]")) {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - e.clientX, r.top + r.height / 2 - e.clientY);
      if (d < bestD) [best, bestD] = [el, d];
    }
    return best;
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    // A ghost is its circle's alone; a circle, every one landing there. A
    // finger is less exact than a mouse: landing near one picks it, rather
    // than moving the active ones there (which, live, goes to the room).
    const hit = (e.target as Element).closest<HTMLElement>("[data-ghost], [data-spot]") ?? (e.pointerType === "touch" ? nearest(e) : null);
    const picked = !hit ? null : hit.dataset.spot !== undefined ? spots[Number(hit.dataset.spot)]!.circles : [circles[Number(hit.dataset.ghost)]!];
    onPick(picked, e.altKey);
    // Pressing off the circles takes the active ones there at once.
    press.current = { x: e.clientX, y: e.clientY, moved: !picked };
    box.current!.setPointerCapture(e.pointerId);
    if (!picked) onMove(...colorAt(...fraction(e)));
  };
  const drag = (e: PointerEvent) => {
    const p = press.current;
    if (!p || (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < TAP_PX)) return;
    p.moved = true;
    onMove(...colorAt(...fraction(e)));
  };
  const up = (e: PointerEvent) => {
    const p = press.current;
    press.current = null;
    // A tap only picks: nothing moves.
    if (p?.moved) onDrop(...colorAt(...fraction(e)), near(e));
  };
  const key = (e: KeyboardEvent) => {
    const next = step(active.a, active.b, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    onPick(null, false);
    onDrop(next[0], next[1], null);
  };

  // Each circle the lights can't make as asked, from its ghost to the spot where its light lands.
  const spotOf = new Map(spots.flatMap((s) => s.circles.map((c) => [c, s] as const)));
  const links = circles.flatMap((c, i) => {
    if (!fallsShort(c)) return [];
    const to = spotOf.get(c)!;
    return [{ i, from: at(c.a, c.b), to, rFrom: isOn(c) ? 15 : 10, rTo: to.circles.some(isOn) ? 15 : 10 }];
  });
  const pct = (v: number) => `${v * 100}%`;

  return (
    <div
      ref={box}
      className={`picker ${className}`}
      style={{ width: width ?? undefined, height }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={`${nameOf(active.a, active.b)}, ${active.members.length} ${active.members.length === 1 ? "light" : "lights"}`}
      onPointerDown={down}
      onPointerMove={drag}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      {children}
      {links.length > 0 && (
        // A line from each ghost to its circle, stopping at their edges (so it doesn't show through the ghost).
        <svg className="picker-links" aria-hidden="true">
          <defs>
            <mask id={maskId}>
              <rect width="100%" height="100%" fill="#fff" />
              {links.map((l) => (
                <Fragment key={l.i}>
                  <circle cx={pct(l.from.x)} cy={pct(l.from.y)} r={l.rFrom} fill="#000" />
                  <circle cx={pct(l.to.x)} cy={pct(l.to.y)} r={l.rTo} fill="#000" />
                </Fragment>
              ))}
            </mask>
          </defs>
          <g mask={`url(#${maskId})`}>
            {links.map((l) => (
              <Fragment key={l.i}>
                <line className="picker-link-shade" x1={pct(l.from.x)} y1={pct(l.from.y)} x2={pct(l.to.x)} y2={pct(l.to.y)} />
                <line className="picker-link" x1={pct(l.from.x)} y1={pct(l.from.y)} x2={pct(l.to.x)} y2={pct(l.to.y)} />
              </Fragment>
            ))}
          </g>
        </svg>
      )}
      {/* Where a color the lights can't make is asked for: a ghost of its circle, which sits where its light lands. */}
      {circles.map((c, i) => {
        if (!fallsShort(c)) return null;
        const p = at(c.a, c.b);
        return (
          <span
            key={c.members[0]}
            data-ghost={i}
            className={isOn(c) ? "picker-ghost on" : "picker-ghost"}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            title={`${nameOf(c.a, c.b)}, asked for: ${count(c.members.length, "light")}`}
          />
        );
      })}
      {spots.map((s, k) => {
        // Where the light lands, in its color: one circle for all that land here.
        const first = s.circles[0]!;
        // A color it can't show where it is (on the strip of whites, one that isn't one) is just an outline.
        const hollow = outside?.(first.seen.a, first.seen.b) ?? false;
        const n = s.circles.reduce((sum, c) => sum + c.members.length, 0);
        const [r, g, b] = swatch(first.seen.a, first.seen.b) as Vec3;
        const light = hollow || 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
        const cls = ["picker-circle", s.circles.some(isOn) && "on", hollow && "hollow"].filter(Boolean).join(" ");
        const names = listOf(s.circles.map((c) => (s.circles.length > 1 ? `${nameOf(c.a, c.b)} (${count(c.members.length, "light")})` : nameOf(c.a, c.b))));
        const title = s.circles.some(fallsShort) ? `${names}, coming out ${nameOf(first.seen.a, first.seen.b)}` : names;
        return (
          <span
            key={first.members[0]}
            data-spot={k}
            className={cls}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, background: hollow ? undefined : css(first.seen.a, first.seen.b), color: light ? "#1a1612" : "#fff" }}
            title={`${title}: ${count(n, "light")}`}
          >
            {n > 1 && n}
          </span>
        );
      })}
    </div>
  );
}

/** Values at the same color, the circles: the most first. */
function circlesOf(values: Lemtone[], made: (t: Lemtone, i: number) => Output): Circle[] {
  const by = new Map<string, Circle>();
  values.forEach((t, i) => {
    const key = exact(t.a, t.b);
    const c = by.get(key);
    if (c) c.members.push(i);
    else by.set(key, { a: t.a, b: t.b, members: [i], seen: t });
  });
  for (const c of by.values()) {
    const usual = valuesOf(c.members.map((i) => values[i]!))[0]!;
    c.seen = made(usual, c.members.find((i) => values[i] === usual)!).light;
  }
  return [...by.values()].sort((x, y) => y.members.length - x.members.length || x.members[0]! - y.members[0]!);
}

/** Whether a circle's lights can't make its color as asked, so they land elsewhere. */
const fallsShort = (c: Circle) => c.seen.a !== c.a || c.seen.b !== c.b;

/** Circles whose lights land in one spot (within SAME_PX of each other), most lights first, and where (fractions across and down). */
interface Spot {
  circles: Circle[];
  x: number;
  y: number;
}

/** The spots the circles' lights land in, on a picker this size (CSS px) that places colors with `at`. */
function spotsOf(circles: Circle[], at: (a: number, b: number) => { x: number; y: number }, width: number, height: number): Spot[] {
  const spots: Spot[] = [];
  for (const c of circles) {
    const q = at(c.seen.a, c.seen.b);
    const spot = spots.find((s) => Math.hypot((s.x - q.x) * width, (s.y - q.y) * height) < SAME_PX);
    if (spot) spot.circles.push(c);
    else spots.push({ circles: [c], x: q.x, y: q.y });
  }
  return spots;
}

/** Circles picked up together where their lights land: as one, of all their lights, at the color they land at. */
function together(circles: Circle[]): Circle {
  const { seen } = circles[0]!;
  return { a: seen.a, b: seen.b, members: circles.flatMap((c) => c.members), seen };
}

/** A light taken at its word: what it makes is what's asked. */
const asked = (t: Lemtone): Output => ({ light: t, mode: t.brightness > 0 ? "exact" : "off", desat: 0 });

/**
 * What to say when lights can't make what they're asked for: how much
 * saturation they give up (the most, if it's not the same for all), or, past
 * their brightest, how bright they get. Null when they make it all.
 */
function limitText(lights: { asked: Lemtone; out: Output }[]): string | null {
  const short = lights.filter((l) => l.out.mode === "desat" || l.out.mode === "clamp");
  if (short.length === 0) return null;
  const clamped = short.find((l) => l.out.mode === "clamp");
  if (clamped) {
    const lm = lumensText(clamped.out.light.brightness);
    // A white past its brightest only dims (its tint shifts a touch); a color goes all the way to white.
    if (isWhite(clamped.asked.a, clamped.asked.b)) return `Dimmed to ${lm}: Bulb cannot reach commanded brightness`;
    return `Desaturated by 100% and dimmed to ${lm}: Bulb cannot show commanded color`;
  }
  const most = Math.max(...short.map((l) => l.out.desat));
  const some = short.length < lights.length || short.some((l) => l.out.desat !== most);
  const pct = most < 0.005 ? "<1%" : `${Math.round(most * 100)}%`;
  return `Desaturated by ${some ? "up to " : ""}${pct}: Bulb cannot show commanded color`;
}

/** The values set (exactly, at float32), most first. */
function valuesOf(values: Lemtone[]): Lemtone[] {
  const by = new Map<string, { t: Lemtone; n: number }>();
  for (const t of values) {
    const key = exact(t.brightness, t.fidelity);
    const v = by.get(key);
    if (v) v.n++;
    else by.set(key, { t, n: 1 });
  }
  return [...by.values()].sort((a, b) => b.n - a.n).map((v) => v.t);
}

/** One mark per place on a track, saying how many are at it; none when they're all at one. */
function marksOf(marks: { at: number; key: string; title: string }[]) {
  const by = new Map<string, { at: number; title: string; n: number }>();
  for (const m of marks) {
    const v = by.get(m.key);
    if (v) v.n++;
    else by.set(m.key, { ...m, n: 1 });
  }
  if (by.size < 2) return undefined;
  return [...by.values()].map(({ at, title, n }) => ({ at, title: n > 1 ? `${title} ×${n}` : title }));
}

/** "208–700 lm", or just "700 lm" when they're all one; the unit, if given, said once. */
function rangeText(values: number[], text: (v: number) => string, unit = ""): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return text(hi);
  const strip = (s: string) => (unit && s.endsWith(unit) ? s.slice(0, -unit.length) : s);
  return `${strip(text(lo))}–${text(hi)}`;
}

/** The brightness at a place on a track up to `top`, which runs on how bright it looks (cube root). */
const brightnessAt = (look: number, top: number) => Math.round(look ** 3 * top * 10000) / 10000;

// The brightness track's dark end, and how many places along it are worked out.
const TRACK_DARK: Vec3 = [0x1c / 255, 0x19 / 255, 0x16 / 255];
const TRACK_STOPS = 32;

/**
 * The brightness track for a color: at each place, the light `made` of it at
 * that brightness, from dark up. Past what a bulb can make of it, a
 * saturated color pales toward white, and past its brightest it gets no
 * brighter.
 */
function brightnessTrack(a: number, b: number, fidelity: number, top: number, gamut: Gamut, made: (t: Lemtone) => Lemtone): string {
  const stops: string[] = [];
  for (let i = 0; i <= TRACK_STOPS; i++) {
    const x = i / TRACK_STOPS;
    const out = made({ a, b, brightness: brightnessAt(x, top), fidelity });
    const k = lookOf(out.brightness / top);
    const rgb = swatch(out.a, out.b, gamut).map((v, c) => TRACK_DARK[c]! + (v - TRACK_DARK[c]!) * k) as Vec3;
    stops.push(`${cssColor(rgb, gamut)} ${+(x * 100).toFixed(2)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const clampK = (k: number) => Math.min(K_MAX, Math.max(K_MIN, k));

/** Where a color is on the wheel (fractions across and down), kept inside the rim. */
function wheelPlace(a: number, b: number) {
  const { dx, dy } = wheelSpot(a, b);
  return { x: 0.5 + 0.5 * dx, y: 0.5 - 0.5 * dy };
}

/** Where a color is on the strip of whites (fractions across and down): at its nearest temperature, its tint kept on the strip. */
function stripPlace(a: number, b: number) {
  const { k, tint } = whiteSpot(a, b);
  return { x: (k - K_MIN) / (K_MAX - K_MIN), y: (1 - heightOf(Math.max(-TINT, Math.min(TINT, tint)))) / 2 };
}

/** Where a color is among the whites: the nearest temperature on the strip, and how far off the line. */
function whiteSpot(a: number, b: number): { k: number; tint: number } {
  const k = clampK(kelvinOf(a, b, Infinity) ?? 3000);
  const [wa, wb] = whiteAB(k);
  const [na, nb] = across(k);
  return { k, tint: (a - wa) * na + (b - wb) * nb };
}

/** A color's name: on the strip of whites, its temperature and any tint ("3000 K +0.020 tint"); else its hue and chroma. */
function nameOf(a: number, b: number): string {
  if (!isWhite(a, b)) return colorName(a, b);
  const { k, tint } = whiteSpot(a, b);
  const t = Math.abs(tint) < 0.0005 ? "" : ` ${tint > 0 ? "+" : "−"}${Math.abs(tint).toFixed(3)} tint`;
  return `${Math.round(k / 50) * 50} K${t}`;
}

/** Whether a color is on the strip of whites: in its temperatures, its tint within it. */
function isWhite(a: number, b: number): boolean {
  const k = kelvinOf(a, b, Infinity);
  if (k === null || k < K_MIN - 50 || k > K_MAX + 50) return false;
  return Math.abs(whiteSpot(a, b).tint) <= TINT + 1e-6;
}

/**
 * Paint a canvas now, and again (at most once a frame) whenever `key`
 * changes: a frame asked for paints whatever's latest by then, so a key that
 * changes every frame still paints every frame.
 */
function usePaint(canvas: RefObject<HTMLCanvasElement | null>, key: string, paint: (c: HTMLCanvasElement) => void) {
  const latest = useRef(paint);
  latest.current = paint;
  const painted = useRef(false);
  const frame = useRef(0);
  useEffect(() => {
    if (!painted.current) {
      painted.current = true;
      latest.current(canvas.current!);
      return;
    }
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (canvas.current) latest.current(canvas.current);
    });
  }, [canvas, key]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
}

// A backdrop is worked out on a grid this fine (points across and down):
// at each point, whether the lights make that color as asked, and what they
// make if not. Where that changes between points, the edge is found to this
// many halvings, and runs straight from crossing to crossing (marching
// squares), so it takes any shape. Past the edge, the colors are what the
// lights make, spread between points, striped at 45° (every other stripe
// this much darker, a pair of them this wide, CSS px). Round the edge,
// outside it, a border this wide (CSS px), this color, this strong. That's
// on the CPU, where the GPU can't paint them or before its tables are in
// (backdrop.ts paints them the same way, from tables of what the bulbs make
// worked out ahead, fast enough to follow a slider as it's dragged).
const WHEEL_GRID = 56;
const STRIP_GRID = [81, 21] as const;
const EDGE_STEPS = 8;
const STRIPE_DARK = 0.1;
const STRIPE_PX = 6;
const BORDER_PX = 2;
const BORDER_RGB: Vec3 = [26 / 255, 22 / 255, 18 / 255];
const BORDER_INK = 0.75;
// The same, and the strip of whites' shape, for the GPU.
const LOOK = { stripeDark: STRIPE_DARK, stripePx: STRIPE_PX, borderPx: BORDER_PX, borderRgb: BORDER_RGB, borderInk: BORDER_INK };
const WHITES = { kMin: K_MIN, kMax: K_MAX, tint: TINT, tintCurve: TINT_CURVE };

/** What the GPU needs to know about the active lights to paint a backdrop: their brightness, and whether their bulbs solve lemtones (not their fidelity, which its tables leave out). */
interface Light {
  brightness: number;
  solves: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Distance from (x, y) to the segment (x0, y0)–(x1, y1). */
function toSegment(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const [dx, dy] = [x1 - x0, y1 - y0];
  const t = clamp01(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
}

/** Which side of the line through (x0, y0)–(x1, y1) (x, y) is on. */
const sideOf = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0) > 0;

/**
 * Paint a picker's backdrop into `img`: each pixel the color asked for there
 * (`colorAt`, by fractions across and down) where the lights make it as
 * asked. Past that, what they make instead (paler), striped, with a border
 * round the edge, outside it, so it never covers a color they make; a pixel
 * the edge crosses is shared out by how much of it is on either side.
 * `alphaAt` shapes it (0: not drawn); grid points `skip` says no drawn pixel
 * is spread from aren't worked out.
 */
function paintBackdrop(
  img: ImageData,
  dpr: number,
  gamut: Gamut,
  colorAt: (x: number, y: number) => [number, number],
  lightAt: (a: number, b: number) => Output,
  [gx, gy]: readonly [number, number],
  alphaAt: (x: number, y: number) => number = () => 1,
  skip: (x: number, y: number) => boolean = () => false,
) {
  const { width: w, height: h, data } = img;
  const at = (i: number, j: number) => j * gx + i;
  const makes = (x: number, y: number) => {
    const m = lightAt(...colorAt(x, y)).mode;
    return m === "exact" || m === "off";
  };

  // At each grid point: whether it's worked out, whether it's made as asked,
  // and, if not, how far the lights move the color.
  const live = new Uint8Array(gx * gy);
  const asked = new Uint8Array(gx * gy);
  const shift = new Float32Array(gx * gy * 2);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const [x, y] = [i / (gx - 1), j / (gy - 1)];
      if (skip(x, y)) continue;
      const [a, b] = colorAt(x, y);
      const out = lightAt(a, b);
      const k = at(i, j);
      live[k] = 1;
      if (out.mode === "exact" || out.mode === "off") {
        asked[k] = 1;
      } else {
        shift[2 * k] = out.light.a - a;
        shift[2 * k + 1] = out.light.b - b;
      }
    }
  }

  // Where the edge crosses from grid point (i, j) to the next one across
  // (or down), in pixels; each crossing worked out once.
  const crossings = new Map<number, [number, number]>();
  const crossing = (i: number, j: number, down: boolean): [number, number] => {
    const key = 2 * at(i, j) + (down ? 1 : 0);
    const known = crossings.get(key);
    if (known) return known;
    const from = asked[at(i, j)] === 1;
    const along = (t: number): [number, number] => (down ? [i / (gx - 1), (j + t) / (gy - 1)] : [(i + t) / (gx - 1), j / (gy - 1)]);
    let [lo, hi] = [0, 1];
    for (let s = 0; s < EDGE_STEPS; s++) {
      const t = (lo + hi) / 2;
      if (makes(...along(t)) === from) lo = t;
      else hi = t;
    }
    const [x, y] = along((lo + hi) / 2);
    const p: [number, number] = [x * w, y * h];
    crossings.set(key, p);
    return p;
  };
  // The edge's segments in each cell (up to two: x0, y0, x1, y1 each).
  const cells = (gx - 1) * (gy - 1);
  const segs = new Float32Array(cells * 8);
  const nsegs = new Uint8Array(cells);
  for (let j = 0; j < gy - 1; j++) {
    for (let i = 0; i < gx - 1; i++) {
      const corners = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (!corners.every((k) => live[k])) continue;
      const f = corners.map((k) => asked[k]!);
      // Crossings on the top, right, bottom and left sides.
      const sides = [
        f[0] !== f[1] && crossing(i, j, false),
        f[1] !== f[2] && crossing(i + 1, j, true),
        f[3] !== f[2] && crossing(i, j + 1, false),
        f[0] !== f[3] && crossing(i, j, true),
      ];
      const on = [0, 1, 2, 3].filter((s) => sides[s]);
      if (on.length === 0) continue;
      // Crossed on all four sides: whether the middle is made as asked says which corners are cut off.
      const pairs =
        on.length === 2
          ? [[on[0]!, on[1]!]]
          : (makes((i + 0.5) / (gx - 1), (j + 0.5) / (gy - 1)) ? 1 : 0) === f[0]
            ? [
                [0, 1],
                [2, 3],
              ]
            : [
                [3, 0],
                [1, 2],
              ];
      const cell = j * (gx - 1) + i;
      for (const [s0, s1] of pairs) {
        const [p, q] = [sides[s0!] as [number, number], sides[s1!] as [number, number]];
        segs.set([p[0], p[1], q[0], q[1]], cell * 8 + nsegs[cell]! * 4);
        nsegs[cell]!++;
      }
    }
  }

  const shiftAt = (x: number, y: number): [number, number] => {
    const fx = Math.min(gx - 1 - 1e-9, Math.max(0, x * (gx - 1)));
    const fy = Math.min(gy - 1 - 1e-9, Math.max(0, y * (gy - 1)));
    const [i, j] = [Math.floor(fx), Math.floor(fy)];
    const [u, v] = [fx - i, fy - j];
    const k = 2 * (j * gx + i);
    const row = 2 * gx;
    const lerp = (c: number) =>
      (1 - v) * ((1 - u) * shift[k + c]! + u * shift[k + 2 + c]!) + v * ((1 - u) * shift[k + row + c]! + u * shift[k + row + 2 + c]!);
    return [lerp(0), lerp(1)];
  };

  const border = BORDER_PX * dpr;
  const stripe = STRIPE_PX * dpr;
  // Down each column, so a backdrop that works out colors by column can keep them.
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const [fx, fy] = [(x + 0.5) / w, (y + 0.5) / h];
      const alpha = alphaAt(fx, fy);
      if (alpha <= 0) continue;
      const k = y * w + x;
      const [a, b] = colorAt(fx, fy);
      const [px, py] = [x + 0.5, y + 0.5];
      const gi = Math.min(gx - 2, Math.floor(fx * (gx - 1)));
      const gj = Math.min(gy - 2, Math.floor(fy * (gy - 1)));
      // Made as asked: as its cell's first corner that no segment in the cell parts it from.
      const cell = gj * (gx - 1) + gi;
      let inside = false;
      for (let c = 0; c < 4; c++) {
        const [ci, cj] = [gi + (c === 1 || c === 2 ? 1 : 0), gj + (c >= 2 ? 1 : 0)];
        const [cx, cy] = [(ci / (gx - 1)) * w, (cj / (gy - 1)) * h];
        let parted = false;
        for (let s = 0; s < nsegs[cell]! && !parted; s++) {
          const o = cell * 8 + s * 4;
          const [x0, y0, x1, y1] = [segs[o]!, segs[o + 1]!, segs[o + 2]!, segs[o + 3]!];
          parted = sideOf(px, py, x0, y0, x1, y1) !== sideOf(cx, cy, x0, y0, x1, y1);
        }
        if (!parted) {
          inside = asked[at(ci, cj)] === 1;
          break;
        }
      }
      // How far from the edge (in this cell and those round it; further is past the border).
      let dist = Infinity;
      for (let nj = Math.max(0, gj - 1); nj <= Math.min(gy - 2, gj + 1); nj++) {
        for (let ni = Math.max(0, gi - 1); ni <= Math.min(gx - 2, gi + 1); ni++) {
          const nc = nj * (gx - 1) + ni;
          for (let s = 0; s < nsegs[nc]!; s++) {
            const o = nc * 8 + s * 4;
            dist = Math.min(dist, toSegment(px, py, segs[o]!, segs[o + 1]!, segs[o + 2]!, segs[o + 3]!));
          }
        }
      }
      // How much of the pixel is a color made as asked, the border, and past it.
      const signed = inside ? dist : -dist;
      const own = clamp01(0.5 + signed);
      const past = clamp01(0.5 - signed - border);
      const onBorder = 1 - own - past;
      let rgb: number[] = own > 0 ? swatch(a, b, gamut).map((c) => c * own) : [0, 0, 0];
      if (own < 1) {
        const [sa, sb] = shiftAt(fx, fy);
        // Striped at 45°: how much of the pixel is in a darker stripe.
        const u = ((((x + y) / Math.SQRT2) % stripe) + stripe) % stripe;
        const into = u < stripe / 2 ? Math.min(u, stripe / 2 - u) : -Math.min(u - stripe / 2, stripe - u);
        const shade = 1 - STRIPE_DARK * clamp01(0.5 + into);
        const made = swatch(a + sa, b + sb, gamut);
        rgb = rgb.map((c, i) => {
          const under = made[i]! * shade;
          return c + under * past + (under + (BORDER_RGB[i]! - under) * BORDER_INK) * onBorder;
        });
      }
      const i = k * 4;
      data[i] = rgb[0]! * 255;
      data[i + 1] = rgb[1]! * 255;
      data[i + 2] = rgb[2]! * 255;
      data[i + 3] = 255 * alpha;
    }
  }
}

/**
 * The strip of whites' colors, temperature across and tint (as it goes with
 * height) up and down, at the strip's size (so the stripes stay at 45°); as
 * the lights make them past what they make as asked. On the GPU if it can.
 */
function paintWhites(c: HTMLCanvasElement, lightAt: (a: number, b: number) => Output, light: Light, gamut: Gamut) {
  const [w, h] = [c.clientWidth || 320, STRIP_H];
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (paintOnGpu(c, { kind: "whites", width: w, height: h, dpr, gamut, ...light, whites: WHITES, look: LOOK })) return;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d", { colorSpace: gamut })!;
  const img = ctx.createImageData(c.width, c.height, { colorSpace: gamut });
  // A column's white, and the way across the black-body line there, kept while it's painted.
  let column = NaN;
  let [wa, wb, na, nb] = [0, 0, 0, 0];
  const colorAt = (x: number, y: number): [number, number] => {
    if (x !== column) {
      column = x;
      const k = K_MIN + x * (K_MAX - K_MIN);
      [wa, wb] = whiteAB(k);
      [na, nb] = across(k);
    }
    const tint = tintAt(1 - 2 * y);
    return [wa + na * tint, wb + nb * tint];
  };
  paintBackdrop(img, dpr, gamut, colorAt, lightAt, STRIP_GRID);
  ctx.putImageData(img, 0, 0);
}

/**
 * The wheel's colors, softened at the rim so it doesn't look clipped; as the
 * lights make them past what they make as asked. On the GPU if it can.
 */
function paintWheel(c: HTMLCanvasElement, lightAt: (a: number, b: number) => Output, light: Light, gamut: Gamut) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (paintOnGpu(c, { kind: "wheel", width: WHEEL, height: WHEEL, dpr, gamut, ...light, whites: WHITES, look: LOOK })) return;
  const size = Math.round(WHEEL * dpr);
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { colorSpace: gamut })!;
  const img = ctx.createImageData(size, size, { colorSpace: gamut });
  const r = size / 2;
  // How far from the middle, as a share of the rim.
  const out = (x: number, y: number) => Math.hypot(x * 2 - 1, 1 - y * 2);
  paintBackdrop(
    img,
    dpr,
    gamut,
    (x, y) => wheelColor(x * 2 - 1, 1 - y * 2),
    lightAt,
    [WHEEL_GRID, WHEEL_GRID],
    (x, y) => (out(x, y) > 1 ? 0 : Math.min(1, (1 - out(x, y)) * r * 0.9 + 0.1)),
    // Past the rim, but for the points its pixels are spread from.
    (x, y) => out(x, y) > 1.08,
  );
  ctx.putImageData(img, 0, 0);
}
