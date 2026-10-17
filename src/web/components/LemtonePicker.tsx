// A picker for lemtones: a white by color temperature, or a color from a
// disc, plus brightness and fidelity.
//
// The disc is OKLCh at L = 1, the canonical Lemtone plane: hue goes round,
// chroma goes out from white. Brightness is absolute (1.0 = 1000 lm) on a
// cube-root track, roughly how bright it looks, so the dim end, where
// saturated colors live, gets room.

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { abOf, hueChroma, kelvinOf, lemtoneCode, lumensText, swatch, whiteAB, type Lemtone } from "../../shared/lemtone.ts";
import { Segmented } from "./Segmented.tsx";
import { Slider } from "./Slider.tsx";

export interface PickerValue {
  mode: "white" | "color";
  kelvin: number;
  /** The color on the disc: hue in degrees, and chroma (OKLCh at L = 1). */
  hue: number;
  chroma: number;
  /** 1.0 = 1000 lm. */
  brightness: number;
  fidelity: number;
}

const K_MIN = 2000;
const K_MAX = 6500;
/** The disc's rim: about as saturated as the bulbs' primaries. */
const C_MAX = 0.4;
/** The top of the brightness track: the bulbs' rated output. */
const B_MAX = 1;

// arclamp's boot room tone (rclamp room.Default): 3000 K at 700 lm.
export const DEFAULT_PICK: PickerValue = { mode: "white", kelvin: 3000, hue: 30, chroma: 0.2, brightness: 0.7, fidelity: 1 };

export function abOfPick(v: PickerValue): [number, number] {
  return v.mode === "white" ? whiteAB(v.kelvin) : abOf(v.hue, v.chroma);
}

export function toLemtone(v: PickerValue): Lemtone {
  const [a, b] = abOfPick(v);
  return { a, b, brightness: v.brightness, fidelity: v.fidelity };
}

export function fromLemtone(t: Lemtone): PickerValue {
  // Exact, not rounded: rounding moves a white off the white line.
  const { hue, chroma } = hueChroma(t.a, t.b);
  const rest = { hue, chroma, brightness: t.brightness, fidelity: t.fidelity };
  const k = kelvinOf(t.a, t.b);
  if (k !== null && k >= K_MIN && k <= K_MAX) return { mode: "white", kelvin: round(k, 50), ...rest };
  return { mode: "color", kelvin: DEFAULT_PICK.kelvin, ...rest };
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const css = ([r, g, b]: number[]) => `rgb(${Math.round(r! * 255)} ${Math.round(g! * 255)} ${Math.round(b! * 255)})`;

interface Props {
  value: PickerValue;
  onChange: (v: PickerValue) => void;
  onCommit: (v: PickerValue) => void;
}

export function LemtonePicker({ value, onChange, onCommit }: Props) {
  const [a, b] = abOfPick(value);
  const color = css(swatch(a, b));
  const code = lemtoneCode(toLemtone(value));

  const set = (patch: Partial<PickerValue>, commit = false) => {
    const next = { ...value, ...patch };
    onChange(next);
    if (commit) onCommit(next);
  };
  // The brightness track runs on how bright it looks (cube root), 0–1.
  const toBrightness = (look: number) => Math.round(look ** 3 * B_MAX * 10000) / 10000;

  return (
    <div className="picker">
      <Segmented
        label="Kind of light"
        options={[
          { value: "white", label: "White" },
          { value: "color", label: "Color" },
        ]}
        value={value.mode}
        onChange={(mode) => set(modeSwitch(value, mode), true)}
      />

      {value.mode === "white" ? (
        <TemperatureStrip
          kelvin={value.kelvin}
          onChange={(kelvin) => set({ kelvin })}
          onCommit={(kelvin) => set({ kelvin }, true)}
        />
      ) : (
        <ColorDisc
          hue={value.hue}
          chroma={value.chroma}
          code={code}
          onChange={(hue, chroma) => set({ hue, chroma })}
          onCommit={(hue, chroma) => set({ hue, chroma }, true)}
        />
      )}

      <div className="readout">
        <span className="swatch" style={{ background: color }} />
        <span className="readout-main">{code.split(" · ")[0]}</span>
        <span className="mono readout-code" title="Lemtone: color, brightness, fidelity">
          {code}
        </span>
      </div>

      <Slider
        label="Brightness"
        value={Math.cbrt(Math.min(B_MAX, value.brightness) / B_MAX)}
        min={0}
        max={1}
        step={0.005}
        track={`linear-gradient(90deg, #000, ${color})`}
        display={lumensText(value.brightness)}
        onChange={(look) => set({ brightness: toBrightness(look) })}
        onCommit={(look) => set({ brightness: toBrightness(look) }, true)}
      />
      {value.mode === "color" && kelvinOf(a, b, 0.03) === null && (
        <p className="hint">Saturated colors are dim on these bulbs: past a few dozen lumens they fade toward white.</p>
      )}

      <Slider
        label="Fidelity"
        value={value.fidelity}
        min={0}
        max={1}
        step={0.01}
        track="linear-gradient(90deg, #3a2f55, #6b5a3e 60%, #8d7a5c)"
        display={`F${value.fidelity.toFixed(2)}`}
        ends={["vivid", "natural"]}
        onChange={(fidelity) => set({ fidelity })}
        onCommit={(fidelity) => set({ fidelity }, true)}
      />
    </div>
  );
}

/** Keep the same light when switching modes, as near as each mode can express it. */
function modeSwitch(v: PickerValue, mode: PickerValue["mode"]): Partial<PickerValue> {
  if (mode === "color") return { mode, ...hueChroma(...whiteAB(v.kelvin)) };
  const k = kelvinOf(...abOf(v.hue, v.chroma), Infinity)!;
  return { mode, kelvin: round(Math.min(K_MAX, Math.max(K_MIN, k)), 50) };
}

function useDrag<T>(read: (e: PointerEvent) => T, onChange: (v: T) => void, onCommit: (v: T) => void) {
  const dragging = useRef(false);
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      onChange(read(e));
    },
    onPointerMove: (e: PointerEvent) => dragging.current && onChange(read(e)),
    onPointerUp: (e: PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      onCommit(read(e));
    },
  };
}

function TemperatureStrip({
  kelvin,
  onChange,
  onCommit,
}: {
  kelvin: number;
  onChange: (k: number) => void;
  onCommit: (k: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stops: string[] = [];
  for (let k = K_MIN; k <= K_MAX; k += 250) stops.push(`${css(swatch(...whiteAB(k)))} ${pct(k)}%`);
  const gradient = `linear-gradient(90deg, ${stops.join(", ")})`;
  const read = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return round(K_MIN + f * (K_MAX - K_MIN), 50);
  };
  const drag = useDrag(read, onChange, onCommit);
  const key = (e: KeyboardEvent) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 50 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -50 : 0;
    if (!d) return;
    e.preventDefault();
    const next = Math.min(K_MAX, Math.max(K_MIN, kelvin + d * (e.shiftKey ? 10 : 1)));
    onChange(next);
    onCommit(next);
  };

  return (
    <div className="temp">
      <div
        ref={ref}
        className="temp-strip"
        style={{ background: gradient }}
        role="slider"
        tabIndex={0}
        aria-label="Color temperature"
        aria-valuemin={K_MIN}
        aria-valuemax={K_MAX}
        aria-valuenow={kelvin}
        aria-valuetext={`${kelvin} kelvin`}
        onKeyDown={key}
        {...drag}
      >
        <span className="temp-thumb" style={{ left: `${pct(kelvin)}%` }} />
      </div>
      <div className="temp-scale mono">
        {[2700, 4000, 5000, 6500].map((k) => (
          <span key={k} style={{ left: `${pct(k)}%` }}>
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

const pct = (k: number) => ((k - K_MIN) / (K_MAX - K_MIN)) * 100;

const DISC = 208;

function ColorDisc({
  hue,
  chroma,
  code,
  onChange,
  onCommit,
}: {
  hue: number;
  chroma: number;
  code: string;
  onChange: (hue: number, chroma: number) => void;
  onCommit: (hue: number, chroma: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.round(DISC * dpr);
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(size, size);
    const r = size / 2;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const dx = (px + 0.5 - r) / r;
        const dy = (r - py - 0.5) / r;
        const d = Math.hypot(dx, dy);
        const i = (py * size + px) * 4;
        if (d > 1) continue;
        const [R, G, B] = swatch(dx * C_MAX, dy * C_MAX);
        img.data[i] = R * 255;
        img.data[i + 1] = G * 255;
        img.data[i + 2] = B * 255;
        // Soften the rim so the disc doesn't look clipped.
        img.data[i + 3] = 255 * Math.min(1, (1 - d) * r * 0.9 + 0.1);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);

  const read = (e: PointerEvent): [number, number] => {
    const rect = canvas.current!.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const dy = (rect.top + rect.height / 2 - e.clientY) / (rect.height / 2);
    let h = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (h < 0) h += 360;
    return [Math.round(h) % 360, round(Math.min(1, Math.hypot(dx, dy)) * C_MAX, 0.005)];
  };
  const drag = useDrag(read, (v) => onChange(...v), (v) => onCommit(...v));
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    let h = hue;
    let c = chroma;
    if (e.key === "ArrowLeft") h = (hue + step) % 360;
    else if (e.key === "ArrowRight") h = (hue - step + 360) % 360;
    else if (e.key === "ArrowUp") c = Math.min(C_MAX, chroma + 0.005 * step);
    else if (e.key === "ArrowDown") c = Math.max(0, chroma - 0.005 * step);
    else return;
    e.preventDefault();
    onChange(h, round(c, 0.005));
    onCommit(h, round(c, 0.005));
  };

  const rad = (hue * Math.PI) / 180;
  const r = Math.min(1, chroma / C_MAX);
  const thumb = { left: `${50 + 50 * r * Math.cos(rad)}%`, top: `${50 - 50 * r * Math.sin(rad)}%` };
  return (
    <div className="disc">
      <canvas
        ref={canvas}
        style={{ width: DISC, height: DISC }}
        role="slider"
        tabIndex={0}
        aria-label="Color"
        aria-valuetext={code}
        onKeyDown={key}
        {...drag}
      />
      <span className="disc-thumb" style={thumb} />
    </div>
  );
}
