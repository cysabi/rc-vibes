// A color editor, for one light's color or many at once. Values at exactly
// the same color are one circle on a color wheel (or a square of whites):
// with one color among the lights, one big circle; with several, a small one
// each, so the picker shows the whole range of them. Pressing the picker
// anywhere takes every light to that color (on a circle, exactly its color),
// and dragging takes them all along. The keys step each color from where it
// is. Brightness and fidelity are a knob with every light at one value, or a
// range from the lowest to the highest, whose ends clamp the lights they pass
// (Slider.tsx). Where the values come from, and where a change goes, is up
// to whoever uses it.
//
// The wheel is OKLCh at L = 1, the canonical Lemtone plane: hue goes round,
// chroma goes out from white, as far as the bulbs' bluest blue (wheel.ts).
// Brightness is absolute (1.0 = 1000 lm) on a cube-root track, roughly how
// bright it looks, so the dim end, where saturated colors live, gets room. The
// track tops out at the lights' rated output: 1000 lm for color bulbs,
// 4000 lm for 4×1 panels (the brighter, if they're mixed).
// Where the lights, each at its own brightness, can't make colors as asked,
// the wheel and the strip show what they make instead, striped, bordered
// round what they can. With both kinds of light among them (color bulbs and
// panels each make their own), there are two edges: round what at least one
// of them makes as asked (bordered), and, dotted, round what every one does;
// and the stripes are of what the least capable of them makes and of what
// the most capable does. A circle asked for there sits where its lights land,
// in their color (one for each kind of light, which each land somewhere of
// their own), with a ghost of it where it's asked for. Circles whose lights
// land in the same spot are one circle there, counting them all. Under the
// pointer, a ball (or a ghost) says its color (hue and chroma on the wheel,
// temperature and tint on the whites), and, where the lights fall short,
// what each kind of them makes of it instead.

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { DEVICES, SOLVERS, type Device } from "../../shared/devices.ts";
import { deviceOf, madeOf, ratedBrightnessOf } from "../../shared/fixtures.ts";
import {
  abOf,
  cssColor,
  hueChroma,
  lookOf,
  LUMENS_PER_BRIGHTNESS,
  lumensText,
  swatch,
  whiteAB,
  type Gamut,
  type Lemtone,
  type Vec3,
} from "../../shared/lemtone.ts";
import type { Output } from "../../shared/solver.ts";
import { paintOnGpu } from "../backdrop.ts";
import { dotsAlong, type Piece } from "../edge-dots.ts";
import { useGamut } from "../display.ts";
import { dotsOf, exact, type Group, type Placed } from "../marks.ts";
import { chromaAt, WHEEL_CHROMA, wheelColor, wheelSpot } from "../wheel.ts";
import { across, heightOf, isWhite, K_MAX, K_MIN, TINT, TINT_CURVE, TINT_STEPS, tintAt, toneText, whiteAt, whiteSpot } from "../whites.ts";
import { count } from "../words.ts";
import { Field, rangeOf, SliderField } from "./Field.tsx";
import { Goo } from "./Goo.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** The top of the brightness track where the lights' types aren't known: a color bulb's rated output. */
const B_MAX = 1;
// The wheel, and the whites' square as big: as wide as their pane (measured,
// usePaneSize), so the picker's the same height whichever tab is showing.
// This big until the pane's measured.
const WHEEL = 224;
const STRIP_W = WHEEL;
// How near (px) a finger has to land to a circle to pick it.
const FINGER_PX = 24;
/** A press that moves less than this (px) is a tap: it only picks. */
const TAP_PX = 4;

interface Props {
  /** The colors being edited: one, or many (one per light). */
  values: Lemtone[];
  /**
   * Set `patch` on the values at `which` (indices into `values`), leaving the
   * rest of each as it is. `code` names the change shortly, for the history.
   */
  onChange: (patch: Partial<Lemtone>, code: string, which: number[]) => void;
  /** Each value's light's type, for what it makes of a color, to show it as it'll look (madeOf); each makes it as asked if not given. */
  types?: string[];
  /** What its picker's field is called: Color, or a color param's name. */
  label?: string;
}

/** Values at exactly the same color: one circle. */
interface Circle {
  a: number;
  b: number;
  /** Indices into the values. */
  members: number[];
  /** What its most common value's light makes of it. */
  seen: Lemtone;
  /** Whether some of its lights (each on its own calibration) don't make its color as asked. */
  short: boolean;
}

/** A color, for some lights (Field.tsx's kinds): its picker, then its brightness and fidelity, each a SliderField. A fragment, laid out by what it's in. */
export function ColorField({ values, onChange, types, label = "Color" }: Props) {
  const made = (t: Lemtone, i: number) => (types ? madeOf(t, types[i]!) : asked(t));
  const gamut = useGamut();
  // Where each light lands: what it makes of what it's asked for (and how: exactly, paler, or dimmer).
  const outputs = values.map((t, i) => made(t, i));
  const landings = outputs.map((o) => o.light);
  // On the picker, with more than one light, only those that are on: one
  // that's off has no color to show, and picking still takes it along (setAll).
  // With every one off, they all show, so there's something to pick from.
  const anyOn = values.some((t) => t.brightness > 0);
  const circles = circlesOf(values, landings, values.length > 1 && anyOn ? (t) => t.brightness > 0 : undefined);
  // Which picker shows; until you choose (or touch the picker, which keeps it), whichever suits the lights.
  const [chosenMode, setMode] = useState<"white" | "color" | null>(null);
  // Switching tabs, the picker's rounding eases from one to the other: the
  // wheel's circle (half its width) out to the whites' rounded corners, and
  // back (--pick-tl/tr/br/bl on .tone-pick, transitioned in styles.css).
  const morphTo = (m: "white" | "color") => setMode(m);
  const [pane, size] = usePaneSize();
  const every = values.map((_, i) => i);
  const lead = circles[0];
  if (!lead) return null;

  const mode = chosenMode ?? (isWhite(lead.a, lead.b) ? "white" : "color");
  const css = (a: number, b: number) => cssColor(swatch(a, b, gamut), gamut);
  const common = valuesOf(values)[0]!;
  // The backdrop's worked out for every light at its own brightness: each kind of light among
  // them, from the dimmest of its lights that's on to the brightest. Where every one makes a
  // color as asked, it's clear; where only some do, it's between the two edges; where none
  // do, past the outer one. Painted again when that or the gamut changes (lightKey).
  const devices = types ? DEVICES.filter((d) => types.some((t) => deviceOf(t) === d)) : [];
  const weights = devices.map((d) => types!.filter((t) => deviceOf(t) === d).length);
  const ranges = devices.map((d): [number, number] => {
    const on = values.filter((t, i) => deviceOf(types![i]!) === d && t.brightness > 0).map((t) => t.brightness);
    return on.length === 0 ? [0, 0] : [Math.min(...on), Math.max(...on)];
  });
  const light: Light = { devices, weights, ranges };
  // Where none of them make a color as asked, how far they typically move it: each kind's
  // shift as its dimmest light makes it (the nearest any of its lights gets), weighed by
  // how many of its lights there are.
  const typicalAt = (a: number, b: number): [number, number] => {
    const total = weights.reduce((s, w) => s + w, 0);
    if (total === 0) return [0, 0];
    return devices.reduce<[number, number]>(
      ([sa, sb], d, k) => {
        const out = SOLVERS[d].output({ a, b, brightness: ranges[k]![0], fidelity: common.fidelity }).light;
        return [sa + (weights[k]! * (out.a - a)) / total, sb + (weights[k]! * (out.b - b)) / total];
      },
      [0, 0],
    );
  };
  const madeAt = (a: number, b: number) => madeLevel(a, b, light, common.fidelity);
  const lightKey = `${ranges.join(";")} ${common.fidelity} ${devices.join()} ${weights.join()} ${gamut} ${size}`;
  // The brightness track: as the most common color's first light makes it.
  const sample = lead.members[0]!;
  // The top of the brightness track: the brightest any of the lights is rated for.
  const top = types ? Math.max(...types.map((t) => ratedBrightnessOf(t))) : B_MAX;

  // Pressing the picker (anywhere, a circle or not) takes every light to that color, and
  // dragging takes them along; the picker keeps the tab it's on from then.
  const setAll = (a: number, b: number) => {
    if (chosenMode === null) setMode(mode);
    onChange({ a, b }, nameOf(a, b), every);
  };
  // A key steps each color by a step from where it is, so colors that differ still do.
  // The lights left off the picker (off, among lights that are on) step with the most common color's.
  const unshown = every.filter((i) => !circles.some((c) => c.members.includes(i)));
  const stepBy = (step: StepFn, key: string, big: boolean): boolean => {
    let any = false;
    for (const c of circles) {
      const next = step(c.a, c.b, key, big);
      if (!next) continue;
      any = true;
      onChange({ a: next[0], b: next[1] }, nameOf(next[0], next[1]), c === circles[0] ? [...c.members, ...unshown] : c.members);
    }
    if (any && chosenMode === null) setMode(mode);
    return any;
  };
  const picker = { circles, landings, outputs, lead, gamut, css, typicalAt, madeAt, lightKey, light, size, onSet: setAll, onStep: stepBy };

  // The sliders: one knob, with every light at one value; else a range, its ends the lowest
  // and the highest, each pulled to clamp every light it passes (Slider.tsx).
  const looks = values.map((t) => lookOf(Math.min(top, t.brightness) / top));
  const fidelities = values.map((t) => t.fidelity);
  // What the lights have, for the fields: the one value, or the lowest to the highest.
  const brightness = brightnessRange(values.map((t) => t.brightness));
  const fidelity = `F${rangeOf(fidelities, (f) => f.toFixed(2))}`;

  return (
    <>
      {/* The tone: one box of two tabs (whites, or every color) over the picker for the one showing. */}
      <Field label={label} value={toneRange(values)}>
        <div className="tone-box">
          <div className="tone-tabs" role="tablist" aria-label="Kind of light">
            {(["white", "color"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "tone-tab on" : "tone-tab"} onClick={() => morphTo(m)}>
                {m === "white" ? "White" : "Hue"}
              </button>
            ))}
          </div>
          <div className={mode === "white" ? "tone-pick white" : "tone-pick hue"} ref={pane} style={{ "--pick-circle": `${size / 2}px` } as CSSProperties}>
            {mode === "white" ? <WhiteStrip {...picker} /> : <Wheel {...picker} />}
          </div>
        </div>
      </Field>

      <SliderField
        label="Brightness"
        value={brightness}
        values={looks}
        min={0}
        max={1}
        step={0.005}
        track={brightnessTrack(lead.a, lead.b, common.fidelity, top, gamut, (t) => made(t, sample).light)}
        onChange={(look, which) => onChange({ brightness: brightnessAt(look, top) }, lumensText(brightnessAt(look, top)), which)}
      />
      <SliderField
        label="Fidelity"
        value={fidelity}
        values={fidelities}
        min={0}
        max={1}
        step={0.01}
        track="linear-gradient(90deg, #5b4c92, #8a7352 60%, #b49c75)"
        ends={["vivid", "natural"]}
        onChange={(f, which) => onChange({ fidelity: f }, `F${f.toFixed(2)}`, which)}
      />
    </>
  );
}

/** Brightnesses as a field says them: "450 lm", "off", "101–450 lm" (one unit, so it fits beside its label), "off–450 lm". */
function brightnessRange(levels: readonly number[]): string {
  if (levels.length === 0) return "";
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  if (lo === hi) return hi > 0 ? lumensText(hi) : "off";
  return `${lo > 0 ? lumensText(lo).replace(" lm", "") : "off"}–${lumensText(hi)}`;
}

/** Colors as a field says them: the one ("3000K (+2 tint)"), whites by their temperatures ("2700–4000K"), or how many. */
function toneRange(tones: readonly Lemtone[]): string {
  const names = new Set(tones.map((t) => nameOf(t.a, t.b)));
  if (names.size <= 1) return [...names][0] ?? "";
  if (tones.every((t) => isWhite(t.a, t.b))) {
    return `${rangeOf(
      tones.map((t) => Math.round(whiteSpot(t.a, t.b).k / 50) * 50),
      String,
    )}K`;
  }
  return `${names.size} colors`;
}

/** A key's step from a color on a picker, if it's one of its keys. */
type StepFn = (a: number, b: number, key: string, big: boolean) => [number, number] | null;

interface PickerProps {
  circles: Circle[];
  /** Where each value's light lands: what it makes of it. */
  landings: Lemtone[];
  /** The same, with how: exactly, paler (desaturated), or dimmer (clamped). */
  outputs: Output[];
  /** The circle it says it's at (for assistive text): the biggest. */
  lead: Circle;
  gamut: Gamut;
  css: (a: number, b: number) => string;
  /** How far the active lights typically move a color (in a, b), which the backdrop shows; painted again when `lightKey` changes. */
  typicalAt: (a: number, b: number) => [number, number];
  /** How many of the active kinds of light make a color as asked: 2 every one, 1 some, 0 none. */
  madeAt: (a: number, b: number) => number;
  lightKey: string;
  /** How big it is, across and down (CSS px). */
  size: number;
  /** The same, for the GPU to work out: the active lights' brightness, and the kinds of light among them. */
  light: Light;
  /** Every light to this color: pressed, or dragged to. */
  onSet: (a: number, b: number) => void;
  /** A key, on the picker: each color by a step; whether it was one of its keys. */
  onStep: (step: StepFn, key: string, big: boolean) => boolean;
}

/** The colors round a wheel, each circle at its color. */
function Wheel(props: PickerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  usePaint(canvas, props.lightKey, (c) => paintWheel(c, props.size, props.typicalAt, props.madeAt, props.light, props.gamut));
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
    <Picker {...props} className="wheel-picker" width={props.size} height={props.size} at={wheelPlace} colorAt={colorAt} step={step} label="Color">
      <canvas key={props.gamut} ref={canvas} style={{ width: props.size, height: props.size }} aria-hidden="true" />
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
  usePaint(canvas, props.lightKey, (c) => paintWhites(c, props.size, props.typicalAt, props.madeAt, props.light, props.gamut));
  const colorAt = (x: number, y: number) => whiteAt(round(K_MIN + x * (K_MAX - K_MIN), 50), tintAt(1 - 2 * y));
  const step = (a: number, b: number, key: string, big: boolean): [number, number] | null => {
    const { k, tint } = whiteSpot(a, b);
    if (key === "ArrowRight" || key === "ArrowLeft") return whiteAt(clampK(round(k + (key === "ArrowRight" ? 50 : -50) * (big ? 10 : 1), 50)), tint);
    if (key !== "ArrowUp" && key !== "ArrowDown") return null;
    const h = Math.max(-1, Math.min(1, heightOf(tint) + ((key === "ArrowUp" ? 1 : -1) / TINT_STEPS) * (big ? 4 : 1)));
    return whiteAt(k, tintAt(h));
  };
  return (
    <div className="white-picker-wrap">
      <Picker
        {...props}
        className="white-picker"
        width={props.size}
        height={props.size}
        at={stripPlace}
        colorAt={colorAt}
        step={step}
        outside={(a, b) => !isWhite(a, b)}
        label="Color temperature and tint"
      >
        <canvas key={props.gamut} ref={canvas} className="white-picker-field" aria-hidden="true" />
        {/* The scale, small along the square's bottom, inside it, under the circles. */}
        <div className="white-picker-scale mono" aria-hidden="true">
          {[2700, 4000, 5000, 6500].map((k) => (
            <span key={k} style={{ left: `${((k - K_MIN) / (K_MAX - K_MIN)) * 100}%` }}>
              {k}
            </span>
          ))}
        </div>
      </Picker>
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
  landings,
  outputs,
  lead,
  gamut,
  onSet,
  onStep,
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
  step: StepFn;
  /** Colors it can't show where they are: drawn faint, at the nearest place. */
  outside?: (a: number, b: number) => boolean;
  label: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The links' mask, by an id of this picker's own (useId's colons don't belong in url()).
  const maskId = `picker-links-${useId().replace(/[^\w-]/g, "")}`;
  // From the press to the letting go: where it was pressed, and whether it's gone far enough since to be a drag.
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // One color among them: its circle's drawn big and haloed; several, each small.
  const one = circles.length === 1;
  // The ball (or ghost) under the pointer: just the lights it stands for, and where to say so (over it, on the screen).
  const [tip, setTip] = useState<{ x: number; y: number; lights: number[] } | null>(null);
  const hover = (el: HTMLElement, lights: number[]) => {
    if (press.current) return;
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top - 6, lights });
  };

  // Its size as it's laid out (the strip of whites is as wide as there's room), for where the lights go on it.
  const [size, setSize] = useState<readonly [number, number]>([width ?? STRIP_W, height]);
  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setSize((s) => (s[0] === el.clientWidth && s[1] === el.clientHeight ? s : [el.clientWidth, el.clientHeight]));
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const [w, h] = size;

  // Each light where it lands, in what it makes there, as the color preview has
  // them (marks.ts, Goo.tsx): lights landing together share a ball, with a count,
  // and balls near each other run together, so lights that land apart (made on
  // calibrations of their own) are a blob as long as they're spread.
  const circleOf = new Map(circles.flatMap((c) => c.members.map((i) => [i, c] as const)));
  // Lights it can't show where they land (on the strip of whites, one that isn't a white): hollow, at the nearest place.
  const hollow = new Set<number>();
  const placed: Placed[] = circles.flatMap((c) =>
    c.members.map((i) => {
      const l = landings[i]!;
      const p = at(l.a, l.b);
      if (outside?.(l.a, l.b)) hollow.add(i);
      const said = fallsShort(c) ? `${nameOf(c.a, c.b)}, coming out ${nameOf(l.a, l.b)}` : nameOf(c.a, c.b);
      return { id: i, same: exact(l.a, l.b), x: p.x * w, y: p.y * h, t: { ...l, brightness: 1 }, label: said };
    }),
  );
  const marks = dotsOf(placed);
  // Each mark white-rimmed, the hollow ones see-through; one color's big and haloed.
  const lookOf = (g: Group) => {
    const big = one;
    const empty = g.ids.every((i) => hollow.has(i));
    return {
      size: big ? 30 : 20,
      rim: WHITE,
      rimPx: big ? 3 : 2,
      haloPx: big ? 5 : 0,
      ...(empty ? { fill: WHITE, fillAlpha: 0.25 } : {}),
      className: big ? "on" : undefined,
    };
  };
  // The halo's in the accent color while the picker has the keyboard's focus.
  const [focused, setFocused] = useState(false);
  // Each mark drawn as its own, a handle: pressing it takes every light to the color of the (most common) circle in it.
  const handles = marks.filter((g) => !(g.into && g.ids.length === 1));
  const circlesIn = (g: Group) => [...new Set(g.ids.map((i) => circleOf.get(i)!))];
  // Where a circle's lights land, all told (a ghost's line goes there).
  const centerOf = (c: Circle) => {
    const ps = c.members.map((i) => at(landings[i]!.a, landings[i]!.b));
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  };
  const ghosts = circles.filter(fallsShort);

  const fraction = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))] as const;
  };
  /** The mark or ghost nearest a finger, within FINGER_PX of its middle. */
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
    // On a circle (its mark, or its ghost), every light takes its color exactly;
    // elsewhere, the color under the pointer. A finger is less exact than a
    // mouse: landing near one counts as on it.
    const hit = (e.target as Element).closest<HTMLElement>("[data-ghost], [data-spot]") ?? (e.pointerType === "touch" ? nearest(e) : null);
    const on = !hit ? null : hit.dataset.spot !== undefined ? circlesIn(handles[Number(hit.dataset.spot)]!).sort((x, y) => y.members.length - x.members.length)[0]! : ghosts[Number(hit.dataset.ghost)]!;
    press.current = { x: e.clientX, y: e.clientY, moved: false };
    setTip(null);
    box.current!.setPointerCapture(e.pointerId);
    if (on) onSet(on.a, on.b);
    else onSet(...colorAt(...fraction(e)));
  };
  const drag = (e: PointerEvent) => {
    const p = press.current;
    if (!p || (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < TAP_PX)) return;
    p.moved = true;
    onSet(...colorAt(...fraction(e)));
  };
  const up = () => {
    press.current = null;
  };
  const key = (e: KeyboardEvent) => {
    if (onStep(step, e.key, e.shiftKey)) e.preventDefault();
  };

  // From each ghost to where its lights land.
  const links = ghosts.map((c, i) => ({ i, from: at(c.a, c.b), to: centerOf(c), rFrom: one ? 15 : 10 }));
  const pct = (v: number) => `${v * 100}%`;

  return (
    <div
      ref={box}
      className={`picker ${className}`}
      style={{ width: width ?? undefined, height }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={`${nameOf(lead.a, lead.b)}, ${count(lead.members.length, "light")}`}
      onPointerDown={down}
      onPointerMove={drag}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setFocused(false)}
    >
      {children}
      {links.length > 0 && (
        // A line from each ghost to where its lights land, stopping at the ghost (so it doesn't show through it); the goo covers the other end.
        <svg className="picker-links" aria-hidden="true">
          <defs>
            <mask id={maskId}>
              <rect width="100%" height="100%" fill="#fff" />
              {links.map((l) => (
                <circle key={l.i} cx={pct(l.from.x)} cy={pct(l.from.y)} r={l.rFrom} fill="#000" />
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
      {/* Where the lights land, as goo. */}
      <div className="picker-goo">
        <Goo marks={marks} width={w} height={h} gamut={gamut} lookOf={lookOf} outline={OUTLINE} halo={focused ? FOCUS_HALO : HALO} />
      </div>
      {/* Where a color the lights can't make is asked for: a ghost of its circle. */}
      {ghosts.map((c, i) => {
        const p = at(c.a, c.b);
        return (
          <span
            key={c.members[0]}
            data-ghost={i}
            className={one ? "picker-ghost on" : "picker-ghost"}
            style={{ left: pct(p.x), top: pct(p.y) }}
            onPointerEnter={(e) => hover(e.currentTarget, c.members)}
            onPointerLeave={() => setTip(null)}
          />
        );
      })}
      {/* Each mark, to pick (the goo can't be). */}
      {handles.map((g, k) => (
        <span
          key={g.key}
          data-spot={k}
          className="picker-handle"
          style={{ left: pct(g.x / w), top: pct(g.y / h), width: lookOf(g).size + 4, height: lookOf(g).size + 4 }}
          onPointerEnter={(e) => hover(e.currentTarget, [g, ...g.joined].flatMap((j) => j.ids))}
          onPointerLeave={() => setTip(null)}
        />
      ))}
      {tip && (
        <Tooltip x={tip.x} y={tip.y} side="above" fixed className="picker-tip">
          <ToneTip lights={tip.lights} values={circles} outputs={outputs} />
        </Tooltip>
      )}
    </div>
  );
}

// The most colors one tooltip lists (a ball where several have run together).
const TIP_TARGETS = 3;

/** A color asked for, in a tooltip: what it's called, and what the lights make of it instead, if anything. */
interface TipRow {
  target: string;
  /** No light here makes it as asked: it's struck through. */
  missed: boolean;
  /** What they make instead, each said once. */
  made: string[];
}

/**
 * What the tooltip says about these lights (a ball's, or a ghost's): each
 * color they're asked for, said once, and what they make of it instead,
 * each said once too. Kept to these lights, so a ball and a ghost say
 * different things: a ghost, every place its color lands; a ball, just
 * what lands there.
 */
function tipRows(lights: readonly number[], circles: Circle[], outputs: Output[]): TipRow[] {
  const circleOf = new Map(circles.flatMap((c) => c.members.map((i) => [i, c] as const)));
  const rows = new Map<string, TipRow & { n: number }>();
  for (const i of lights) {
    const c = circleOf.get(i);
    if (!c) continue;
    const target = toneText(c.a, c.b);
    let row = rows.get(target);
    if (!row) rows.set(target, (row = { target, missed: true, made: [], n: 0 }));
    row.n++;
    const out = outputs[i]!;
    const short = out.mode === "desat" || out.mode === "clamp";
    const text = short ? `${toneText(out.light.a, out.light.b)}${out.mode === "clamp" ? ` at ${lumensText(out.light.brightness)}` : ""}` : target;
    if (!short || text === target) {
      row.missed = false;
      continue;
    }
    if (!row.made.includes(text)) row.made.push(text);
  }
  return [...rows.values()].sort((x, y) => y.n - x.n);
}

/**
 * The tooltip, as a table: each color asked for on the left (struck through
 * where none of these lights make it), and on the right, stacked beside it,
 * what they make of it instead; the next color starts on the row after its
 * last.
 */
function ToneTip({ lights, values, outputs }: { lights: readonly number[]; values: Circle[]; outputs: Output[] }) {
  const rows = tipRows(lights, values, outputs);
  const shown = rows.slice(0, TIP_TARGETS);
  return (
    <div className="picker-tip-table">
      {shown.map((row) => (
          <Fragment key={row.target}>
            <span
              className={row.missed ? "picker-tip-target missed" : "picker-tip-target"}
              style={row.made.length > 0 ? { gridColumn: 1, gridRow: `span ${row.made.length}` } : { gridColumn: "1 / -1" }}
            >
              {row.missed ? <s>{row.target}</s> : row.target}
            </span>
            {row.made.map((m) => (
              <span key={m} className="picker-tip-made" style={{ gridColumn: 2 }}>
                {m}
              </span>
            ))}
          </Fragment>
      ))}
      {rows.length > TIP_TARGETS && <span className="picker-tip-more">and {count(rows.length - TIP_TARGETS, "more color")}</span>}
    </div>
  );
}



const WHITE: Vec3 = [1, 1, 1];
// The accent (styles.css's --focus): the halo with the keyboard's focus.
const ACCENT: Vec3 = [0x8f / 255, 0xb9 / 255, 1];
// The faint dark line round the circles, outside their rims; and the active ones' halo past it (the accent's, with the keyboard's focus).
const OUTLINE = { px: 1, rgb: [0, 0, 0] as Vec3, alpha: 0.45 };
const HALO = { rgb: WHITE, alpha: 0.22 };
const FOCUS_HALO = { rgb: ACCENT, alpha: 1 };

/** Values at the same color, the circles: the most first. `landings` says what each value's light makes of it; `shown`, which to leave out (all, by default). */
function circlesOf(values: Lemtone[], landings: Lemtone[], shown?: (t: Lemtone) => boolean): Circle[] {
  const by = new Map<string, Circle>();
  values.forEach((t, i) => {
    if (shown && !shown(t)) return;
    const key = exact(t.a, t.b);
    const c = by.get(key);
    if (c) c.members.push(i);
    else by.set(key, { a: t.a, b: t.b, members: [i], seen: t, short: false });
  });
  for (const c of by.values()) {
    const usual = valuesOf(c.members.map((i) => values[i]!))[0]!;
    c.seen = landings[c.members.find((i) => values[i] === usual)!]!;
    c.short = c.members.some((i) => landings[i]!.a !== c.a || landings[i]!.b !== c.b);
  }
  return [...by.values()].sort((x, y) => y.members.length - x.members.length || x.members[0]! - y.members[0]!);
}

/** Whether a circle's lights (some of them, at least) can't make its color as asked, so they land elsewhere. */
const fallsShort = (c: Circle) => c.short;

/** A light taken at its word: what it makes is what's asked. */
const asked = (t: Lemtone): Output => ({ light: t, mode: t.brightness > 0 ? "exact" : "off", desat: 0 });

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
/** A color's name, as it's said everywhere (whites.ts). */
const nameOf = toneText;

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

/**
 * The pane the pickers fill, and how wide it is (CSS px, whole): the wheel's
 * and the whites' size. Its ref goes on the pane; measured as it's laid out,
 * and again whenever it's resized.
 */
function usePaneSize(): [(el: HTMLElement | null) => void, number] {
  const [size, setSize] = useState(WHEEL);
  const watch = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    watch.current?.disconnect();
    watch.current = null;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setSize(w);
    };
    measure();
    watch.current = new ResizeObserver(measure);
    watch.current.observe(el);
  }, []);
  return [ref, size];
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
const STRIP_GRID = [57, 57] as const;
const EDGE_STEPS = 8;
const STRIPE_DARK = 0.1;
const STRIPE_PX = 6;
const BORDER_PX = 2;
const BORDER_RGB: Vec3 = [26 / 255, 22 / 255, 18 / 255];
const BORDER_INK = 0.75;
// The inner edge's dots: this big across, about this far apart along it (edge-dots.ts).
const DOT_PX = 2.4;
const DOT_GAP_PX = 6;
// The same, and the strip of whites' shape, for the GPU.
const LOOK = { stripeDark: STRIPE_DARK, stripePx: STRIPE_PX, borderPx: BORDER_PX, borderRgb: BORDER_RGB, borderInk: BORDER_INK, dotPx: DOT_PX, dotGapPx: DOT_GAP_PX };
const WHITES = { kMin: K_MIN, kMax: K_MAX, tint: TINT, tintCurve: TINT_CURVE };

/**
 * What the GPU needs to know about the active lights to paint a backdrop: their
 * brightness, and the kinds of light among them that solve lemtones (not their
 * fidelity, which its tables leave out).
 */
interface Light {
  devices: Device[];
  /** How many of the lights are each of those kinds. */
  weights: number[];
  /** Each kind's lights that are on: the dimmest's brightness and the brightest's ([0, 0] with none on). */
  ranges: [number, number][];
}

/** Whether there are two edges: more than one kind of light, or a kind's lights at different brightnesses. */
const twoEdges = (light: Light) => light.devices.length > 1 || light.ranges.some(([lo, hi]) => lo !== hi);

/**
 * How many of the lights in `light`, each at its brightness, make (a, b) as
 * asked at this fidelity: 2 every one (or there are none), 1 some, 0 none.
 * A kind's dimmer lights make as asked whatever its brightest does, so it's
 * every one of a kind where its brightest does, and some where its dimmest does.
 */
function madeLevel(a: number, b: number, light: Light, fidelity: number): number {
  if (light.devices.length === 0) return 2;
  const makes = (k: number, brightness: number) => {
    const lm = brightness * LUMENS_PER_BRIGHTNESS;
    return !(lm > 1e-9) || SOLVERS[light.devices[k]!].makesExactly(a, b, lm, fidelity);
  };
  if (light.ranges.every(([, hi], k) => makes(k, hi))) return 2;
  return light.ranges.some(([lo], k) => makes(k, lo)) ? 1 : 0;
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

/** An edge's pieces in each grid cell (up to two: x0, y0, x1, y1 each), in pixels; and, dotted, its dots in each cell (x, y each). */
interface Edge {
  segs: Float32Array;
  nsegs: Uint8Array;
  dots: number[][];
}

/**
 * Paint a picker's backdrop into `img`: each pixel the color asked for there
 * (`colorAt`, by fractions across and down) where every light makes it as
 * asked (`madeAt` 2); where only some do (1), still the color asked for, as
 * those make it, striped darker; where none do (0), what they typically make
 * instead (`typicalAt`), striped darker, with a border outside the outer
 * edge, so it never covers a color made as asked, and the inner edge dotted.
 * With one edge (one kind of light, all at one brightness), the edges are one. A pixel an edge crosses
 * is shared out by how much of it is on either side.
 * `alphaAt` shapes it (0: not drawn); grid points `skip` says no drawn pixel
 * is spread from aren't worked out.
 */
function paintBackdrop(
  img: ImageData,
  dpr: number,
  gamut: Gamut,
  colorAt: (x: number, y: number) => [number, number],
  typicalAt: (a: number, b: number) => [number, number],
  madeAt: (a: number, b: number) => number,
  two: boolean,
  [gx, gy]: readonly [number, number],
  alphaAt: (x: number, y: number) => number = () => 1,
  skip: (x: number, y: number) => boolean = () => false,
) {
  const { width: w, height: h, data } = img;
  const at = (i: number, j: number) => j * gx + i;
  const made = (x: number, y: number) => madeAt(...colorAt(x, y));

  // At each grid point: whether it's worked out, how many of the lights make it
  // as asked, and, if none do, how far they typically move the color.
  const live = new Uint8Array(gx * gy);
  const level = new Uint8Array(gx * gy);
  const shift = new Float32Array(gx * gy * 2);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const [x, y] = [i / (gx - 1), j / (gy - 1)];
      if (skip(x, y)) continue;
      const [a, b] = colorAt(x, y);
      const k = at(i, j);
      live[k] = 1;
      level[k] = madeAt(a, b);
      if (level[k] > 0) continue;
      [shift[2 * k], shift[2 * k + 1]] = typicalAt(a, b);
    }
  }

  /** The edge round what at least `least` (2: every kind of light, 1: at least one) make as asked; dotted, with its dots. */
  const edgeOf = (least: number, dotted: boolean): Edge => {
    const asked = (k: number) => level[k]! >= least;
    // Where the edge crosses from grid point (i, j) to the next one across
    // (or down), in pixels; each crossing worked out once.
    const crossings = new Map<number, [number, number]>();
    const keyOf = (i: number, j: number, down: boolean) => 2 * at(i, j) + (down ? 1 : 0);
    const crossing = (i: number, j: number, down: boolean): [number, number] => {
      const key = keyOf(i, j, down);
      const known = crossings.get(key);
      if (known) return known;
      const from = asked(at(i, j));
      const along = (t: number): [number, number] => (down ? [i / (gx - 1), (j + t) / (gy - 1)] : [(i + t) / (gx - 1), j / (gy - 1)]);
      let [lo, hi] = [0, 1];
      for (let s = 0; s < EDGE_STEPS; s++) {
        const t = (lo + hi) / 2;
        if (made(...along(t)) >= least === from) lo = t;
        else hi = t;
      }
      const [x, y] = along((lo + hi) / 2);
      const p: [number, number] = [x * w, y * h];
      crossings.set(key, p);
      return p;
    };
    const cells = (gx - 1) * (gy - 1);
    const segs = new Float32Array(cells * 8);
    const nsegs = new Uint8Array(cells);
    // Each piece by the crossings it joins, for the dots.
    const pieces: Piece[] = [];
    for (let j = 0; j < gy - 1; j++) {
      for (let i = 0; i < gx - 1; i++) {
        const corners = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        if (!corners.every((k) => live[k])) continue;
        const f = corners.map(asked);
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
            : made((i + 0.5) / (gx - 1), (j + 0.5) / (gy - 1)) >= least === f[0]
              ? [
                  [0, 1],
                  [2, 3],
                ]
              : [
                  [3, 0],
                  [1, 2],
                ];
        const cell = j * (gx - 1) + i;
        const keys = [keyOf(i, j, false), keyOf(i + 1, j, true), keyOf(i, j + 1, false), keyOf(i, j, true)];
        for (const [s0, s1] of pairs) {
          const [p, q] = [sides[s0!] as [number, number], sides[s1!] as [number, number]];
          segs.set([p[0], p[1], q[0], q[1]], cell * 8 + nsegs[cell]! * 4);
          nsegs[cell]!++;
          pieces.push({ from: keys[s0!]!, to: keys[s1!]! });
        }
      }
    }
    // Its dots, if it's dotted, evenly along it, each in the cell it's in.
    const dots: number[][] = Array.from({ length: cells }, () => []);
    if (dotted) {
      const along = dotsAlong(pieces, crossings, DOT_GAP_PX * dpr);
      for (let k = 0; k < along.length; k += 2) {
        const [x, y] = [along[k]!, along[k + 1]!];
        const gi = Math.min(gx - 2, Math.max(0, Math.floor((x / w) * (gx - 1))));
        const gj = Math.min(gy - 2, Math.max(0, Math.floor((y / h) * (gy - 1))));
        dots[gj * (gx - 1) + gi]!.push(x, y);
      }
    }
    return { segs, nsegs, dots };
  };
  const anyEdge = edgeOf(1, false);
  const allEdge = two ? edgeOf(2, true) : anyEdge;
  const dotR = (DOT_PX / 2) * dpr;
  /** How much of pixel (px, py), in grid cell (gi, gj), is one of the inner edge's dots. */
  const dotted = (px: number, py: number, gi: number, gj: number): number => {
    let cover = 0;
    for (let nj = Math.max(0, gj - 1); nj <= Math.min(gy - 2, gj + 1); nj++) {
      for (let ni = Math.max(0, gi - 1); ni <= Math.min(gx - 2, gi + 1); ni++) {
        const d = allEdge.dots[nj * (gx - 1) + ni]!;
        for (let s = 0; s < d.length; s += 2) cover = Math.max(cover, clamp01(dotR + 0.5 - Math.hypot(px - d[s]!, py - d[s + 1]!)));
      }
    }
    return cover;
  };

  /** How far pixel (px, py), in grid cell (gi, gj), is inside an edge (pixels; negative outside it). */
  const signedTo = ({ segs, nsegs }: Edge, least: number, px: number, py: number, gi: number, gj: number): number => {
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
        inside = level[at(ci, cj)]! >= least;
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
    return inside ? dist : -dist;
  };

  const shiftAt = (x: number, y: number): [number, number] => {
    const fx = Math.min(gx - 1 - 1e-9, Math.max(0, x * (gx - 1)));
    const fy = Math.min(gy - 1 - 1e-9, Math.max(0, y * (gy - 1)));
    const [i, j] = [Math.floor(fx), Math.floor(fy)];
    const [u, v] = [fx - i, fy - j];
    const k = 2 * (j * gx + i);
    const row = 2 * gx;
    const lerp = (c: number) => (1 - v) * ((1 - u) * shift[k + c]! + u * shift[k + 2 + c]!) + v * ((1 - u) * shift[k + row + c]! + u * shift[k + row + 2 + c]!);
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
      const anyPx = signedTo(anyEdge, 1, px, py, gi, gj);
      const allPx = two ? signedTo(allEdge, 2, px, py, gi, gj) : anyPx;
      // How much of the pixel every kind of light makes as asked, how much at least one
      // does, and how much is the outer edge's border (outside it).
      const inAny = clamp01(0.5 + anyPx);
      const inAll = Math.min(inAny, clamp01(0.5 + allPx));
      const onAny = clamp01(0.5 - anyPx) - clamp01(0.5 - anyPx - border);
      const asked = swatch(a, b, gamut);
      let rgb: number[] = asked.map((c) => c * inAll);
      if (inAll < 1) {
        // Striped at 45°: how much of the pixel is in a darker stripe.
        const u = ((((x + y) / Math.SQRT2) % stripe) + stripe) % stripe;
        const into = u < stripe / 2 ? Math.min(u, stripe / 2 - u) : -Math.min(u - stripe / 2, stripe - u);
        // Between the edges (some make it), half as many stripes: every other one of those past
        // the outer edge (none do), in line with them; shared out by how much of the pixel is in each.
        const u2 = ((((x + y) / Math.SQRT2) % (2 * stripe)) + 2 * stripe) % (2 * stripe);
        const into2 = u2 < stripe / 2 ? Math.min(u2, stripe / 2 - u2) : -Math.min(u2 - stripe / 2, 2 * stripe - u2);
        const dark = ((inAny - inAll) * clamp01(0.5 + into2) + (1 - inAny) * clamp01(0.5 + into)) / (1 - inAll);
        // What they typically make instead, striped darker, bordered past the outer edge.
        const [sa, sb] = shiftAt(fx, fy);
        const made = swatch(a + sa, b + sb, gamut);
        rgb = rgb.map((c, i) => {
          const under = made[i]! * (1 - STRIPE_DARK * dark);
          return c + under * (1 - inAll) + (BORDER_RGB[i]! - under) * BORDER_INK * onAny;
        });
      }
      // The inner edge, dotted, over whatever's there.
      if (two) {
        const dot = dotted(px, py, gi, gj);
        if (dot > 0) rgb = rgb.map((c, i) => c + (BORDER_RGB[i]! - c) * BORDER_INK * dot);
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
function paintWhites(
  c: HTMLCanvasElement,
  size: number,
  typicalAt: (a: number, b: number) => [number, number],
  madeAt: (a: number, b: number) => number,
  light: Light,
  gamut: Gamut,
) {
  const [w, h] = [size, size];
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
  paintBackdrop(img, dpr, gamut, colorAt, typicalAt, madeAt, twoEdges(light), STRIP_GRID);
  ctx.putImageData(img, 0, 0);
}

/**
 * The wheel's colors, softened at the rim so it doesn't look clipped; as the
 * lights make them past what they make as asked. On the GPU if it can.
 */
function paintWheel(
  c: HTMLCanvasElement,
  css: number,
  typicalAt: (a: number, b: number) => [number, number],
  madeAt: (a: number, b: number) => number,
  light: Light,
  gamut: Gamut,
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (paintOnGpu(c, { kind: "wheel", width: css, height: css, dpr, gamut, ...light, whites: WHITES, look: LOOK })) return;
  const size = Math.round(css * dpr);
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { colorSpace: gamut })!;
  const img = ctx.createImageData(size, size, { colorSpace: gamut });
  // Its whole square, past the rim as within it (as on the GPU: backdrop.ts).
  // Its canvas is clipped to the disc (border-radius), so that's only seen
  // while the picker morphs to and from the whites' square.
  paintBackdrop(img, dpr, gamut, (x, y) => wheelColor(x * 2 - 1, 1 - y * 2), typicalAt, madeAt, twoEdges(light), [WHEEL_GRID, WHEEL_GRID]);
  ctx.putImageData(img, 0, 0);
}
