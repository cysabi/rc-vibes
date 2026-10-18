// What a bulb makes of a lemtone: Walter's lemtone_solve (rc-bulb-firmware
// lemtone/lemtone.c), ported line for line, on the same calibration. The bulb
// is five channels, r, g, b, warm white and cool white, and the model says
// what light any duties give: XYZ(d) = Σ dᵢ · gᵢ(d) · Tᵢ(dᵢ), each channel's
// color per unit duty T (it shifts a little with duty) times an interaction
// g (the supply sagging as more channels draw).
//
// The solve: a closed form on a linear model (whites split along the CW–WW
// line, r, g, b from the 3×3 inverse, fidelity picking the white level in its
// feasible range), redone with the true local primaries until it lands. A
// color too saturated for its lumens desaturates along the OKLab line toward
// its point on the white line, keeping the lumens (desat); if even white
// can't reach them, the brightest white instead (clamp). The firmware runs
// it in float32; this runs float64, as the reference its test vectors come
// from does.
//
// It works in place, on the calibration as flat arrays and one set of buffers
// every solve shares, so a solve (up to 13 attempts of up to 18 rounds each)
// makes no arrays but its answer: a room solves a bulb again each time its
// lemtone changes, every frame while a scene moves. Keep each sum and product
// in the order written: float addition isn't associative, and a last-bit
// change near FIX_TOL can change how many rounds a solve takes, and with it
// the duties.

import { MODEL } from "./bulb.model.ts";
import { LUMENS_PER_BRIGHTNESS, xyzToOklab, type Lemtone, type Vec3 } from "./lemtone.ts";

const CH = 5;
const WW = 3;
const CW = 4;

const REF_DUTY = 0.4; // where the closed form's primaries are taken
const PHASE1_ROUNDS = 6; // rounds without the interaction term
const FIX_ROUNDS = 12; // rounds with it
const FIX_TOL = 2e-3; // converged when every XYZ error < FIX_TOL * Y
const BISECT_STEPS = 10;
const EPS = 1e-6;
const DUTY_MAX = MODEL.dutyMax;

type XY = [number, number];
type Duty = number[];

export type SolveMode = "off" | "exact" | "desat" | "clamp";

export interface Solution {
  /** Light-equivalent duty per channel (r, g, b, ww, cw), 0 to the duty cap. */
  duty: Duty;
  mode: SolveMode;
  /** Saturation given up: 0 (none) to 1 (all). */
  desat: number;
  /** Lumens the duties deliver, per the model. */
  lm: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---- forward model ----------------------------------------------------------

// Per channel: its knots, its XYZ at each (x, y, z after x, y, z), and each
// segment's width and XYZ step, worked out once.
const KNOTS = MODEL.knots.map((k) => Float64Array.from(k));
const WIDTHS = MODEL.knots.map((k) => Float64Array.from(k.slice(1), (v, j) => v - k[j]!));
const XYZ = MODEL.xyz.map((pts) => Float64Array.from(pts.flat()));
const STEPS = MODEL.xyz.map((pts) =>
  Float64Array.from(pts.slice(1).flatMap((hi, j) => hi.map((v, c) => v - pts[j]![c]!))),
);
const THETA = MODEL.theta.map((th) => Float64Array.from(th));

/** Channel i's color per unit duty at duty d, Tᵢ(d) (linear between knots), into out[o], out[o + 1], out[o + 2]. */
function unitXyz(i: number, d: number, out: Float64Array, o: number) {
  const k = KNOTS[i]!;
  const xyz = XYZ[i]!;
  const n = k.length;
  let q: number; // past either end, that end's XYZ
  if (d <= k[0]! || n === 1) q = 0;
  else if (d >= k[n - 1]!) q = 3 * (n - 1);
  else {
    let j = 1;
    while (d > k[j]!) j++;
    const t = (d - k[j - 1]!) / WIDTHS[i]![j - 1]!;
    const step = STEPS[i]!;
    q = 3 * (j - 1);
    out[o] = xyz[q]! + t * step[q]!;
    out[o + 1] = xyz[q + 1]! + t * step[q + 1]!;
    out[o + 2] = xyz[q + 2]! + t * step[q + 2]!;
    return;
  }
  out[o] = xyz[q]!;
  out[o + 1] = xyz[q + 1]!;
  out[o + 2] = xyz[q + 2]!;
}

/** Channel i's interaction factor gᵢ(d), 1 = no sag: the other four duties, them times dᵢ, then each pair of them. */
function interaction(i: number, d: Float64Array): number {
  const th = THETA[i]!;
  const di = d[i]!;
  // The other four, in channel order.
  const o0 = d[i < 1 ? 1 : 0]!;
  const o1 = d[i < 2 ? 2 : 1]!;
  const o2 = d[i < 3 ? 3 : 2]!;
  const o3 = d[i < 4 ? 4 : 3]!;
  return 1 +
    th[0]! * o0 + th[1]! * o1 + th[2]! * o2 + th[3]! * o3 +
    th[4]! * o0 * di + th[5]! * o1 * di + th[6]! * o2 * di + th[7]! * o3 * di +
    th[8]! * o0 * o0 + th[9]! * o0 * o1 + th[10]! * o0 * o2 + th[11]! * o0 * o3 +
    th[12]! * o1 * o1 + th[13]! * o1 * o2 + th[14]! * o1 * o3 +
    th[15]! * o2 * o2 + th[16]! * o2 * o3 +
    th[17]! * o3 * o3;
}

const fwdDuty = new Float64Array(CH);
const fwdUnit = new Float64Array(3);

/** The light (XYZ, in model units) that duties d give. */
export function forward(d: Duty): Vec3 {
  fwdDuty.set(d);
  const xyz: Vec3 = [0, 0, 0];
  for (let i = 0; i < CH; i++) {
    const di = fwdDuty[i]!;
    if (di <= 0) continue;
    unitXyz(i, di, fwdUnit, 0);
    const s = di * interaction(i, fwdDuty);
    for (let c = 0; c < 3; c++) xyz[c] += s * fwdUnit[c]!;
  }
  return xyz;
}

// ---- color space --------------------------------------------------------------

// OKLab -> LMS' and LMS -> XYZ (Ottosson's inverses).
const OK_M2_INV = [
  [1.0, 0.3963377774, 0.2158037573],
  [1.0, -0.1055613458, -0.0638541728],
  [1.0, -0.0894841775, -1.291485548],
];
const OK_M1_INV = [
  [1.2270138511, -0.5577999807, 0.281256149],
  [-0.0405801784, 1.1122568696, -0.0716766787],
  [-0.0763812845, -0.4214819784, 1.5861632204],
];

/** Row r of m times (x, y, z). */
const dot3 = (m: number[][], r: number, x: number, y: number, z: number) => m[r]![0]! * x + m[r]![1]! * y + m[r]![2]! * z;
const cube = (v: number) => v * v * v;

/** A lemtone color as XYZ with luminance Y, into out; false if it has no positive luminance (far outside the real colors). */
function abToXyz(a: number, b: number, Y: number, out: Float64Array): boolean {
  const l = cube(dot3(OK_M2_INV, 0, 1, a, b));
  const m = cube(dot3(OK_M2_INV, 1, 1, a, b));
  const s = cube(dot3(OK_M2_INV, 2, 1, a, b));
  const x = dot3(OK_M1_INV, 0, l, m, s);
  const y = dot3(OK_M1_INV, 1, l, m, s);
  const z = dot3(OK_M1_INV, 2, l, m, s);
  if (!(y > 1e-6)) return false;
  out[0] = (x / y) * Y;
  out[1] = (y / y) * Y;
  out[2] = (z / y) * Y;
  return true;
}

/** XYZ (Y > 0) -> lemtone color (OKLab a and b at L = 1). */
function xyzToAb(xyz: Vec3): XY {
  const [L, a, b] = xyzToOklab(xyz);
  return [a / L, b / L];
}

// ---- init ---------------------------------------------------------------------

/** The primaries at REF_DUTY (r, g, b, ww, cw; x, y, z each), where every attempt starts. */
const PRIM = new Float64Array(3 * CH);
for (let i = 0; i < CH; i++) unitXyz(i, REF_DUTY, PRIM, 3 * i);
const CW_AB = xyzToAb([PRIM[3 * CW]!, PRIM[3 * CW + 1]!, PRIM[3 * CW + 2]!]);
const WW_AB = xyzToAb([PRIM[3 * WW]!, PRIM[3 * WW + 1]!, PRIM[3 * WW + 2]!]);

// ---- solve --------------------------------------------------------------------

// The solve's working state, shared: a solve runs start to finish without
// yielding. P: the primaries the closed form works from, laid out as PRIM.
// INV: the inverse of P's r, g, b. RGB0 and RGB_PER_W: r, g, b as the white
// level we goes, rgb(we) = RGB0 - we * RGB_PER_W. D: the duties. TGT: the
// XYZ being made. BEST: the duties of the last attempt that made it.
const P = new Float64Array(3 * CH);
const INV = new Float64Array(9);
const RGB0 = new Float64Array(3);
const RGB_PER_W = new Float64Array(3);
const D = new Float64Array(CH);
const TGT = new Float64Array(3);
const BEST = new Float64Array(CH);

/** Where (px, py) projects onto the line (cx, cy) -> (wx, wy): 0 = all CW, 1 = all WW. */
function betaOn(cx: number, cy: number, wx: number, wy: number, px: number, py: number): number {
  const dx = wx - cx;
  const dy = wy - cy;
  return clamp(((px - cx) * dx + (py - cy) * dy) / (dx * dx + dy * dy), 0, 1);
}

/** Inverts the matrix whose columns are P's r, g, b primaries, into INV; false if it's singular. */
function invRgb(): boolean {
  const a = P[0]!, d = P[1]!, g = P[2]!;
  const b = P[3]!, e = P[4]!, h = P[5]!;
  const c = P[6]!, f = P[7]!, k = P[8]!;
  const A = e * k - f * h;
  const B = -(d * k - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return false;
  INV[0] = A / det;
  INV[1] = -(b * k - c * h) / det;
  INV[2] = (b * f - c * e) / det;
  INV[3] = B / det;
  INV[4] = (a * k - c * g) / det;
  INV[5] = -(a * f - c * d) / det;
  INV[6] = C / det;
  INV[7] = -(a * h - b * g) / det;
  INV[8] = (a * e - b * d) / det;
  return true;
}

/**
 * Closed form for the linear model XYZ = Σ dᵢ P[i]: duties, into D, giving `tgt`
 * (chromaticity px, py), whites split by where it projects onto this model's CW–WW
 * line, white level at fraction f of its feasible range. False if no white level
 * keeps every duty in [0, duty cap].
 */
function closedForm(tgt: Float64Array, px: number, py: number, f: number): boolean {
  if (!invRgb()) return false;
  const cw = 3 * CW;
  const ww = 3 * WW;
  // Their chromaticities (x, y), and the white mix there.
  const cs = P[cw]! + P[cw + 1]! + P[cw + 2]!;
  const ws = P[ww]! + P[ww + 1]! + P[ww + 2]!;
  const beta = betaOn(
    cs > 0 ? P[cw]! / cs : 0,
    cs > 0 ? P[cw + 1]! / cs : 0,
    ws > 0 ? P[ww]! / ws : 0,
    ws > 0 ? P[ww + 1]! / ws : 0,
    px,
    py,
  );
  const mx = (1 - beta) * P[cw]! + beta * P[ww]!;
  const my = (1 - beta) * P[cw + 1]! + beta * P[ww + 1]!;
  const mz = (1 - beta) * P[cw + 2]! + beta * P[ww + 2]!;

  let lo = 0;
  let hi = DUTY_MAX / Math.max(Math.max(beta, 1 - beta), EPS);
  const tol = EPS * DUTY_MAX;
  for (let k = 0; k < 3; k++) {
    const r = 3 * k;
    const a = INV[r]! * tgt[0]! + INV[r + 1]! * tgt[1]! + INV[r + 2]! * tgt[2]!;
    const b = INV[r]! * mx + INV[r + 1]! * my + INV[r + 2]! * mz;
    RGB0[k] = a;
    RGB_PER_W[k] = b;
    if (Math.abs(b) < 1e-12) {
      if (a < -tol || a > DUTY_MAX + tol) return false;
      continue;
    }
    const l = (a - DUTY_MAX) / b;
    const h = a / b;
    lo = Math.max(lo, b < 0 ? h : l);
    hi = Math.min(hi, b < 0 ? l : h);
  }
  if (hi < lo - tol) return false;

  const we = lo + f * Math.max(0, hi - lo);
  for (let k = 0; k < 3; k++) D[k] = clamp(RGB0[k]! - we * RGB_PER_W[k]!, 0, DUTY_MAX);
  D[WW] = clamp(we * beta, 0, DUTY_MAX);
  D[CW] = clamp(we * (1 - beta), 0, DUTY_MAX);
  return true;
}

/** Per-unit-duty output of every channel at duties D, interaction included, into P: so that XYZ(D) = Σ Dᵢ P[i] exactly. */
function localPrimaries(withSag: boolean) {
  for (let i = 0; i < CH; i++) {
    const o = 3 * i;
    unitXyz(i, D[i]!, P, o);
    if (!withSag) continue;
    const g = interaction(i, D);
    P[o] *= g;
    P[o + 1] *= g;
    P[o + 2] *= g;
  }
}

/**
 * Frozen-coefficient rounds: closed form with P, P re-evaluated at the new duties,
 * until Σ dᵢ Pᵢ(d) lands on tgt. Leaves the last duties in D and their primaries in
 * P (unless it stopped at an infeasible round, which leaves both as they were).
 */
function rounds(tgt: Float64Array, px: number, py: number, f: number, withSag: boolean, maxRounds: number) {
  const Y = tgt[1]!;
  for (let it = 0; it < maxRounds; it++) {
    if (!closedForm(tgt, px, py, f)) return "infeasible";
    localPrimaries(withSag);
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      let out = 0;
      for (let i = 0; i < CH; i++) out += D[i]! * P[3 * i + c]!;
      worst = Math.max(worst, Math.abs(tgt[c]! - out));
    }
    if (worst < FIX_TOL * Y) return "converged";
  }
  return "unconverged";
}

/**
 * Duties for XYZ target tgt, into D, in two phases of rounds: without the interaction
 * term (settling the white/RGB split where fidelity puts it), then with it, starting
 * from there (correcting for the sag). Going straight to the second can lock onto a
 * worse fixed point. False if it can't be made.
 */
function attempt(tgt: Float64Array, f: number): boolean {
  const Y = tgt[1]!;
  if (!(Y > 0) || tgt[0]! < 0 || tgt[2]! < 0) return false; // not a real color
  const s = tgt[0]! + tgt[1]! + tgt[2]!;
  const px = s > 0 ? tgt[0]! / s : 0;
  const py = s > 0 ? tgt[1]! / s : 0;
  P.set(PRIM);
  const one = rounds(tgt, px, py, f, false, PHASE1_ROUNDS);
  // Infeasible without sag: start the second phase from scratch rather than give up.
  if (one === "infeasible") P.set(PRIM);
  else localPrimaries(true);
  return rounds(tgt, px, py, f, true, FIX_ROUNDS) === "converged";
}

/** Duties for lemtone color (a, b) at luminance Y (model units), into D; false if it can't be made. */
function attemptAb(a: number, b: number, Y: number, f: number): boolean {
  return abToXyz(a, b, Y, TGT) && attempt(TGT, f);
}

/** The bulb's duties for a lemtone color (a, b), lumens and fidelity. */
export function solve(a: number, b: number, lm: number, fidelity: number): Solution {
  if (!(lm > 1e-9) || Number.isNaN(a) || Number.isNaN(b)) {
    return { duty: new Array<number>(CH).fill(0), mode: "off", desat: 0, lm: 0 };
  }
  const f = clamp(fidelity, 0, 1);
  const Y = lm / MODEL.lmPerY;

  if (attemptAb(a, b, Y, f)) return { duty: Array.from(D), mode: "exact", desat: 0, lm };

  // Desaturate along the OKLab line toward the target's own point on the white line.
  const beta = betaOn(CW_AB[0], CW_AB[1], WW_AB[0], WW_AB[1], a, b);
  const wa = CW_AB[0] + beta * (WW_AB[0] - CW_AB[0]);
  const wb = CW_AB[1] + beta * (WW_AB[1] - CW_AB[1]);
  if (attemptAb(wa, wb, Y, f)) {
    BEST.set(D);
    let lo = 0; // saturation kept: lo feasible, hi not
    let hi = 1;
    for (let s = 0; s < BISECT_STEPS; s++) {
      const mid = 0.5 * (lo + hi);
      if (attemptAb(wa + mid * (a - wa), wb + mid * (b - wb), Y, f)) {
        lo = mid;
        BEST.set(D);
      } else {
        hi = mid;
      }
    }
    return { duty: Array.from(BEST), mode: "desat", desat: 1 - lo, lm };
  }

  // Too bright for any color: the brightest white-line point it can make.
  BEST.fill(0);
  let lo = 0;
  let hi = 1;
  for (let s = 0; s < BISECT_STEPS + 2; s++) {
    const mid = 0.5 * (lo + hi);
    if (attemptAb(wa, wb, mid * Y, f)) {
      lo = mid;
      BEST.set(D);
    } else {
      hi = mid;
    }
  }
  return { duty: Array.from(BEST), mode: "clamp", desat: 1, lm: lo * lm };
}

/** What a bulb gives for a lemtone. */
export interface Output {
  /**
   * The light it makes, as a lemtone: the color and brightness asked for, or,
   * past what it can, paler (or dimmer), with the fidelity asked for.
   */
  light: Lemtone;
  mode: SolveMode;
  /** Saturation given up, 0 (none) to 1 (all): how far toward its point on the bulb's white line. */
  desat: number;
}

// Outputs worked out already: a room shows the same few lemtones frame after frame.
const outputs = new Map<string, Output>();

/** The light a bulb gives for a lemtone, and how it fell short, if it did. */
export function bulbOutput(t: Lemtone): Output {
  const key = `${t.a} ${t.b} ${t.brightness} ${t.fidelity}`;
  const known = outputs.get(key);
  if (known) return known;
  if (outputs.size > 16384) outputs.clear();
  const out = outputOf(t);
  outputs.set(key, out);
  return out;
}

function outputOf(t: Lemtone): Output {
  const s = solve(t.a, t.b, t.brightness * LUMENS_PER_BRIGHTNESS, t.fidelity);
  if (s.mode === "off") return { light: { ...t, brightness: 0 }, mode: "off", desat: 0 };
  if (s.mode === "exact") return { light: t, mode: "exact", desat: 0 };
  const xyz = forward(s.duty);
  if (!(xyz[1] > 0)) return { light: { ...t, brightness: 0 }, mode: s.mode, desat: s.desat };
  const [a, b] = xyzToAb(xyz);
  const light = { a, b, brightness: (xyz[1] * MODEL.lmPerY) / LUMENS_PER_BRIGHTNESS, fidelity: t.fidelity };
  return { light, mode: s.mode, desat: s.desat };
}
