// The color editor's backdrops (the wheel, the strip of whites) on the GPU,
// fast enough to follow the brightness and fidelity sliders as they're
// dragged. At each place: whether the active lights' bulbs, at their
// brightness and fidelity, make that color as asked, and what they make
// instead if not. The bulb's solve (bulb.ts, Walter's lemtone_solve) runs in
// a shader, in float32 as the firmware does, on a grid a little coarser than
// the screen; then each pixel is painted from it as ColorEditor paints them
// on the CPU: the color asked for where it's made, past the edge what's made
// instead, striped, with a border round the edge, outside it.
//
// The edge is found as the CPU finds it: at each grid point, whether the
// color's made as asked; where that changes between points, the crossing,
// to a few halvings; and from crossing to crossing across each cell, a
// straight piece of edge (marching squares), each pixel near it knowing its
// true distance. Three passes: the points, the crossings, the pixels.
//
// One WebGL context, off the page, paints for every picker, and each
// picker's canvas copies what it paints.

import { MODEL } from "../shared/bulb.model.ts";
import { LMS_RGB, type Gamut, type Vec3 } from "../shared/lemtone.ts";
import { CURVE, WHEEL_CHROMA } from "./wheel.ts";

/** What a backdrop is painted for. */
export interface BackdropJob {
  kind: "wheel" | "whites";
  /** CSS pixels, and device pixels to each. */
  width: number;
  height: number;
  dpr: number;
  gamut: Gamut;
  /** The active lights' brightness (1.0 = 1000 lm) and fidelity. */
  brightness: number;
  fidelity: number;
  /** Whether their bulbs solve lemtones (bulb.ts); if not, they make every color as asked. */
  solves: boolean;
  /** The strip of whites' temperatures, end to end, and its tint at the edges and how steeply it grows. */
  whites: { kMin: number; kMax: number; tint: number; tintCurve: number };
  /** How it looks past the edge: stripes (the darker ones this much darker, a pair this wide), and the border (this wide, this color, this strong). */
  look: { stripeDark: number; stripePx: number; borderPx: number; borderRgb: Vec3; borderInk: number };
}

// Grid points every this many CSS pixels, and where the edge crosses between them found to this many halvings.
const GRID_PX = 2;
const EDGE_STEPS = 8;

const glf = (v: number) => {
  const s = String(v);
  return /[.e]/.test(s) ? s : `${s}.0`;
};
const vec3s = (vs: readonly (readonly number[])[]) => vs.map((v) => `vec3(${v.map(glf).join(", ")})`).join(", ");

// ---- color, as lemtone.ts has it ------------------------------------------------

const COLOR = `
// Matrices are written a row to a vec3; mul() multiplies by one that way.
vec3 mul(mat3 rows, vec3 v) { return vec3(dot(rows[0], v), dot(rows[1], v), dot(rows[2], v)); }

// XYZ -> LMS -> OKLab.
const mat3 XYZ_LMS = mat3(vec3(0.8189330101, 0.3618667424, -0.1288597137), vec3(0.0329845436, 0.9293118715, 0.0361456387), vec3(0.0482003018, 0.2643662691, 0.633851707));
const mat3 LMS_LAB = mat3(vec3(0.2104542553, 0.793617785, -0.0040720468), vec3(1.9779984951, -2.428592205, 0.4505937099), vec3(0.0259040371, 0.7827717662, -0.808675766));

vec3 xyzToOklab(vec3 X) {
  vec3 lms = mul(XYZ_LMS, X);
  return mul(LMS_LAB, sign(lms) * pow(abs(lms), vec3(1.0 / 3.0)));
}

vec2 xyzToAb(vec3 xyz) {
  vec3 lab = xyzToOklab(xyz);
  return lab.yz / lab.x;
}
`;

// ---- the bulb's solve, as bulb.ts has it -------------------------------------

const SOLVE = `
const int CH = 5;
const int WW = 3;
const int CW = 4;
const float DUTY_MAX = ${glf(MODEL.dutyMax)};
const float LM_PER_Y = ${glf(MODEL.lmPerY)};
const float KNOTS[25] = float[25](${MODEL.knots.flat().map(glf).join(", ")});
const vec3 XYZ[25] = vec3[25](${vec3s(MODEL.xyz.flat())});
const float THETA[90] = float[90](${MODEL.theta.flat().map(glf).join(", ")});
const float REF_DUTY = 0.4;
const int PHASE1_ROUNDS = 6;
const int FIX_ROUNDS = 12;
const float FIX_TOL = 2e-3;
const int BISECT_STEPS = 10;
const float EPS = 1e-6;

// OKLab -> LMS' -> XYZ.
const mat3 OK_M2_INV = mat3(vec3(1.0, 0.3963377774, 0.2158037573), vec3(1.0, -0.1055613458, -0.0638541728), vec3(1.0, -0.0894841775, -1.291485548));
const mat3 OK_M1_INV = mat3(vec3(1.2270138511, -0.5577999807, 0.281256149), vec3(-0.0405801784, 1.1122568696, -0.0716766787), vec3(-0.0763812845, -0.4214819784, 1.5861632204));

bool abToXyz(vec2 ab, out vec3 xyz) {
  vec3 l = mul(OK_M2_INV, vec3(1.0, ab));
  xyz = mul(OK_M1_INV, l * l * l);
  if (!(xyz.y > 1e-6)) return false;
  xyz /= xyz.y;
  return true;
}

vec2 xyOf(vec3 X) {
  float s = X.x + X.y + X.z;
  return s > 0.0 ? X.xy / s : vec2(0.0);
}

vec3 unitXyz(int i, float d) {
  int k = i * 5;
  if (d <= KNOTS[k]) return XYZ[k];
  if (d >= KNOTS[k + 4]) return XYZ[k + 4];
  int j = 1;
  while (d > KNOTS[k + j]) j++;
  float t = (d - KNOTS[k + j - 1]) / (KNOTS[k + j] - KNOTS[k + j - 1]);
  return XYZ[k + j - 1] + t * (XYZ[k + j] - XYZ[k + j - 1]);
}

float interaction(int i, float d[5]) {
  float o[4];
  int n = 0;
  for (int j = 0; j < 5; j++) {
    if (j != i) {
      o[n] = d[j];
      n++;
    }
  }
  int t = i * 18;
  float g = 1.0;
  for (int a = 0; a < 4; a++) g += THETA[t++] * o[a];
  for (int a = 0; a < 4; a++) g += THETA[t++] * o[a] * d[i];
  for (int a = 0; a < 4; a++) for (int b = a; b < 4; b++) g += THETA[t++] * o[a] * o[b];
  return g;
}

vec3 forward(float d[5]) {
  vec3 xyz = vec3(0.0);
  for (int i = 0; i < CH; i++) {
    if (d[i] <= 0.0) continue;
    xyz += d[i] * interaction(i, d) * unitXyz(i, d[i]);
  }
  return xyz;
}

float betaOn(vec2 cw, vec2 ww, vec2 p) {
  vec2 d = ww - cw;
  return clamp(dot(p - cw, d) / dot(d, d), 0.0, 1.0);
}

bool closedForm(vec3 P[5], vec3 tgt, vec2 p, float f, out float d[5]) {
  mat3 rgb = mat3(P[0], P[1], P[2]);
  if (abs(determinant(rgb)) < 1e-12) return false;
  mat3 inv = inverse(rgb);
  float beta = betaOn(xyOf(P[CW]), xyOf(P[WW]), p);
  vec3 wmix = (1.0 - beta) * P[CW] + beta * P[WW];
  vec3 a = inv * tgt;
  vec3 b = inv * wmix;
  float lo = 0.0;
  float hi = DUTY_MAX / max(max(beta, 1.0 - beta), EPS);
  float tol = EPS * DUTY_MAX;
  for (int k = 0; k < 3; k++) {
    if (abs(b[k]) < 1e-12) {
      if (a[k] < -tol || a[k] > DUTY_MAX + tol) return false;
      continue;
    }
    float l = (a[k] - DUTY_MAX) / b[k];
    float h = a[k] / b[k];
    if (b[k] < 0.0) {
      float s = l;
      l = h;
      h = s;
    }
    lo = max(lo, l);
    hi = min(hi, h);
  }
  if (hi < lo - tol) return false;
  float we = lo + f * max(0.0, hi - lo);
  for (int k = 0; k < 3; k++) d[k] = clamp(a[k] - we * b[k], 0.0, DUTY_MAX);
  d[WW] = clamp(we * beta, 0.0, DUTY_MAX);
  d[CW] = clamp(we * (1.0 - beta), 0.0, DUTY_MAX);
  return true;
}

void localPrimaries(float d[5], bool sag, out vec3 P[5]) {
  for (int i = 0; i < CH; i++) P[i] = unitXyz(i, d[i]) * (sag ? interaction(i, d) : 1.0);
}

// 0: infeasible; 1: feasible, not converged; 2: converged.
int rounds(vec3 tgt, vec2 p, float Y, float f, bool sag, int most, inout vec3 P[5], inout float d[5]) {
  for (int it = 0; it < most; it++) {
    float next[5];
    if (!closedForm(P, tgt, p, f, next)) return 0;
    d = next;
    localPrimaries(d, sag, P);
    vec3 made = vec3(0.0);
    for (int i = 0; i < CH; i++) made += d[i] * P[i];
    vec3 err = abs(tgt - made);
    if (max(err.x, max(err.y, err.z)) < FIX_TOL * Y) return 2;
  }
  return 1;
}

bool attempt(vec3 tgt, float f, out float d[5]) {
  float Y = tgt.y;
  for (int i = 0; i < CH; i++) d[i] = 0.0;
  if (!(Y > 0.0) || tgt.x < 0.0 || tgt.z < 0.0) return false;
  vec2 p = xyOf(tgt);
  vec3 P[5];
  for (int i = 0; i < CH; i++) P[i] = unitXyz(i, REF_DUTY);
  if (rounds(tgt, p, Y, f, false, PHASE1_ROUNDS, P, d) == 0) {
    for (int i = 0; i < CH; i++) P[i] = unitXyz(i, REF_DUTY);
  } else {
    localPrimaries(d, true, P);
  }
  return rounds(tgt, p, Y, f, true, FIX_ROUNDS, P, d) == 2;
}

bool attemptAb(vec2 ab, float Y, float f, out float d[5]) {
  vec3 xyz;
  if (!abToXyz(ab, xyz)) {
    for (int i = 0; i < CH; i++) d[i] = 0.0;
    return false;
  }
  return attempt(xyz * Y, f, d);
}

// Whether the active lights make a color as asked, at their brightness and
// fidelity: always, if they're off or their bulbs don't solve lemtones.
uniform float u_lumens;
uniform float u_fidelity;
uniform bool u_solves;
bool asked(vec2 p) {
  if (!u_solves || !(u_lumens > 1e-9)) return true;
  float d[5];
  return attemptAb(p, u_lumens / LM_PER_Y, clamp(u_fidelity, 0.0, 1.0), d);
}
`;

// ---- where each color is ------------------------------------------------------

const PLACES = `
uniform int u_kind; // 0: the wheel; 1: the strip of whites
uniform vec4 u_whites; // its temperatures end to end, its tint at the edges, and how steeply that grows

vec2 wheelColor(vec2 d) {
  float r = length(d);
  if (r == 0.0) return vec2(0.0);
  return d / r * ${glf(WHEEL_CHROMA)} * pow(r, ${glf(CURVE)});
}

// The Planckian locus, as lemtone.ts has it.
vec2 cctToXy(float kelvin) {
  float t = 1e3 / kelvin;
  float t2 = t * t;
  float t3 = t2 * t;
  float x = kelvin <= 4000.0
    ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  float x2 = x * x;
  float x3 = x2 * x;
  float y = kelvin <= 2222.0
    ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : kelvin <= 4000.0
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return vec2(x, y);
}

vec2 whiteAB(float kelvin) {
  vec2 xy = cctToXy(kelvin);
  return xyzToAb(vec3(xy.x / xy.y, 1.0, (1.0 - xy.x - xy.y) / xy.y));
}

// The color at a place (fractions across and down), as ColorEditor's paintWheel and paintWhites have it.
vec2 colorAt(vec2 at) {
  if (u_kind == 0) return wheelColor(vec2(at.x * 2.0 - 1.0, 1.0 - at.y * 2.0));
  float k = u_whites.x + at.x * (u_whites.y - u_whites.x);
  vec2 w = whiteAB(k);
  vec2 d = whiteAB(k + 20.0) - whiteAB(k - 20.0);
  float len = length(d);
  vec2 across = len > 0.0 ? vec2(-d.y, d.x) / len : vec2(-d.y, d.x);
  float h = 1.0 - 2.0 * at.y;
  float tint = sign(h) * u_whites.z * (exp(u_whites.w * min(1.0, abs(h))) - 1.0) / (exp(u_whites.w) - 1.0);
  return w + across * tint;
}

// How far from the wheel's middle, as a share of its rim.
float outOf(vec2 at) { return length(vec2(at.x * 2.0 - 1.0, 1.0 - at.y * 2.0)); }
`;

const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Each grid point: whether it's made as asked (1 or 0); if not, how far the
// bulbs move its color (in a, b), as bulb.ts's bulbOutput; and whether it's
// worked out at all (on the wheel, not far past the rim).
const SOLVE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_grid;
out vec4 result;
${COLOR}
${SOLVE}
${PLACES}
void main() {
  vec2 at = (gl_FragCoord.xy - 0.5) / (u_grid - 1.0);
  vec2 p = colorAt(at);
  // Past the rim, but for the points its pixels are spread from: not worked out.
  if (u_kind == 0 && outOf(at) > 1.08) {
    result = vec4(0.0);
    return;
  }
  if (asked(p)) {
    result = vec4(1.0, 0.0, 0.0, 1.0);
    return;
  }
  float Y = u_lumens / LM_PER_Y;
  float f = clamp(u_fidelity, 0.0, 1.0);
  // Its point on the bulbs' white line, which the solve pales it toward.
  vec2 cw = xyzToAb(unitXyz(CW, REF_DUTY));
  vec2 ww = xyzToAb(unitXyz(WW, REF_DUTY));
  vec2 w = cw + betaOn(cw, ww, p) * (ww - cw);
  float d[5];
  float e[5];
  if (attemptAb(w, Y, f, d)) {
    // Paled toward the white line, keeping the lumens (desat).
    float lo = 0.0;
    float hi = 1.0;
    for (int s = 0; s < BISECT_STEPS; s++) {
      float mid = 0.5 * (lo + hi);
      if (attemptAb(w + mid * (p - w), Y, f, e)) {
        lo = mid;
        d = e;
      } else {
        hi = mid;
      }
    }
    vec3 xyz = forward(d);
    result = vec4(0.0, xyz.y > 0.0 ? xyzToAb(xyz) - p : vec2(0.0), 1.0);
    return;
  }
  // Too bright for any color: the brightest white it can make (clamp).
  for (int i = 0; i < CH; i++) d[i] = 0.0;
  float lo = 0.0;
  float hi = 1.0;
  for (int s = 0; s < BISECT_STEPS + 2; s++) {
    float mid = 0.5 * (lo + hi);
    if (attemptAb(w, mid * Y, f, e)) {
      lo = mid;
      d = e;
    } else {
      hi = mid;
    }
  }
  vec3 xyz = forward(d);
  result = vec4(0.0, xyz.y > 0.0 ? xyzToAb(xyz) - p : vec2(0.0), 1.0);
}`;

// Each grid point: where the edge crosses to the next point across, and down
// (as a share of the way there, found to EDGE_STEPS halvings; -1 where it
// doesn't), and for a cell it crosses on all four sides, whether its middle
// is made as asked (which says which corners it cuts off).
const EDGE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_grid;
uniform sampler2D u_solved;
out vec4 result;
${COLOR}
${SOLVE}
${PLACES}
bool askedAt(ivec2 g) { return texelFetch(u_solved, g, 0).x > 0.5; }
bool liveAt(ivec2 g) { return all(lessThan(g, ivec2(u_grid))) && texelFetch(u_solved, g, 0).w > 0.5; }
float crossing(ivec2 g, ivec2 step) {
  ivec2 next = g + step;
  if (!liveAt(g) || !liveAt(next)) return -1.0;
  bool from = askedAt(g);
  if (askedAt(next) == from) return -1.0;
  float lo = 0.0;
  float hi = 1.0;
  for (int s = 0; s < ${EDGE_STEPS}; s++) {
    float t = 0.5 * (lo + hi);
    if (asked(colorAt((vec2(g) + t * vec2(step)) / (u_grid - 1.0))) == from) lo = t;
    else hi = t;
  }
  return 0.5 * (lo + hi);
}
void main() {
  ivec2 g = ivec2(gl_FragCoord.xy);
  float across = crossing(g, ivec2(1, 0));
  float down = crossing(g, ivec2(0, 1));
  float middle = 0.0;
  ivec2 x = g + ivec2(1, 0);
  ivec2 y = g + ivec2(0, 1);
  ivec2 xy = g + ivec2(1, 1);
  if (across >= 0.0 && down >= 0.0 && liveAt(xy) && askedAt(x) != askedAt(xy) && askedAt(y) != askedAt(xy)) {
    middle = asked(colorAt((vec2(g) + 0.5) / (u_grid - 1.0))) ? 1.0 : 0.0;
  }
  result = vec4(across, down, middle, 1.0);
}`;

// Each pixel, from the grid, as ColorEditor's paintBackdrop paints it.
const PAINT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_solved;
uniform sampler2D u_edges;
uniform vec2 u_grid;
uniform vec2 u_size; // device px
uniform mat3 u_rgb; // OKLab's LMS -> linear RGB in the screen's gamut, a row to a vec3
uniform vec4 u_look; // darker stripes' darkness, a pair's width (px), the border's width (px), its strength
uniform vec3 u_border;
out vec4 color;
${COLOR}
${PLACES}

// As lemtone.ts's swatch: the brightest color of this hue and chroma, gamma-encoded.
vec3 swatch(vec2 ab) {
  vec3 l = vec3(1.0 + 0.3963377774 * ab.x + 0.2158037573 * ab.y, 1.0 - 0.1055613458 * ab.x - 0.0638541728 * ab.y, 1.0 - 0.0894841775 * ab.x - 1.291485548 * ab.y);
  vec3 rgb = max(mul(u_rgb, l * l * l), 0.0);
  float top = max(rgb.r, max(rgb.g, rgb.b));
  rgb /= top > 0.0 ? top : 1.0;
  return mix(rgb * 12.92, 1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, rgb));
}

// Spread between grid points, as paintBackdrop's shiftAt.
vec4 solvedAt(vec2 at) {
  vec2 g = clamp(at * (u_grid - 1.0), vec2(0.0), u_grid - 1.0 - 1e-4);
  ivec2 i = ivec2(floor(g));
  vec2 t = g - vec2(i);
  vec4 a = texelFetch(u_solved, i, 0);
  vec4 b = texelFetch(u_solved, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(u_solved, i + ivec2(0, 1), 0);
  vec4 d = texelFetch(u_solved, i + ivec2(1, 1), 0);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// A grid point: whether it's made as asked, whether it was worked out at all, and where it is (device px).
bool asked(ivec2 g) { return texelFetch(u_solved, g, 0).x > 0.5; }
bool live(ivec2 g) { return texelFetch(u_solved, g, 0).w > 0.5; }
vec2 placeOf(ivec2 g) { return vec2(g) / (u_grid - 1.0) * u_size; }

// The edge's pieces in the cell from grid point c across and down (up to two, as x0, y0, x1, y1); how many.
int edgeIn(ivec2 c, out vec4 s0, out vec4 s1) {
  // Its corners: top left, then clockwise.
  ivec2 k[4] = ivec2[4](c, c + ivec2(1, 0), c + ivec2(1, 1), c + ivec2(0, 1));
  if (!live(k[0]) || !live(k[1]) || !live(k[2]) || !live(k[3])) return 0;
  bool f[4] = bool[4](asked(k[0]), asked(k[1]), asked(k[2]), asked(k[3]));
  // Crossings on the top, right, bottom and left sides.
  bool on[4] = bool[4](f[0] != f[1], f[1] != f[2], f[3] != f[2], f[0] != f[3]);
  vec4 top = texelFetch(u_edges, k[0], 0);
  vec2 x[4];
  x[0] = mix(placeOf(k[0]), placeOf(k[1]), top.x);
  x[1] = mix(placeOf(k[1]), placeOf(k[2]), texelFetch(u_edges, k[1], 0).y);
  x[2] = mix(placeOf(k[3]), placeOf(k[2]), texelFetch(u_edges, k[3], 0).x);
  x[3] = mix(placeOf(k[0]), placeOf(k[3]), top.y);
  int first = -1;
  int second = -1;
  int n = 0;
  for (int i = 0; i < 4; i++) {
    if (!on[i]) continue;
    if (first < 0) first = i;
    else if (second < 0) second = i;
    n++;
  }
  if (n == 0) return 0;
  if (n == 2) {
    s0 = vec4(x[first], x[second]);
    return 1;
  }
  // Crossed on all four sides: whether the middle is made as asked says which corners are cut off.
  bool middle = top.z > 0.5;
  if (middle == f[0]) {
    s0 = vec4(x[0], x[1]);
    s1 = vec4(x[2], x[3]);
  } else {
    s0 = vec4(x[3], x[0]);
    s1 = vec4(x[1], x[2]);
  }
  return 2;
}

float toSegment(vec2 p, vec4 s) {
  vec2 d = s.zw - s.xy;
  float t = clamp(dot(p - s.xy, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
  return length(p - s.xy - t * d);
}

bool sideOf(vec2 p, vec4 s) { return (s.z - s.x) * (p.y - s.y) - (s.w - s.y) * (p.x - s.x) > 0.0; }

void main() {
  // The pixel's middle, from the top left.
  vec2 px = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 at = px / u_size;
  vec4 s = solvedAt(at);
  ivec2 last = ivec2(u_grid) - 2;
  ivec2 cell = min(ivec2(at * (u_grid - 1.0)), last);
  // Made as asked: as its cell's first corner that no piece of the edge in the cell parts it from.
  vec4 e0;
  vec4 e1;
  int n = edgeIn(cell, e0, e1);
  ivec2 corners[4] = ivec2[4](cell, cell + ivec2(1, 0), cell + ivec2(1, 1), cell + ivec2(0, 1));
  bool inside = false;
  for (int c = 0; c < 4; c++) {
    vec2 q = placeOf(corners[c]);
    bool parted = (n > 0 && sideOf(px, e0) != sideOf(q, e0)) || (n > 1 && sideOf(px, e1) != sideOf(q, e1));
    if (!parted) {
      inside = asked(corners[c]);
      break;
    }
  }
  // How far from the edge (device px), in this cell and those round it; further is past the border.
  float dist = 1e9;
  for (int dj = -1; dj <= 1; dj++) {
    for (int di = -1; di <= 1; di++) {
      ivec2 c = cell + ivec2(di, dj);
      if (any(lessThan(c, ivec2(0))) || any(greaterThan(c, last))) continue;
      vec4 a;
      vec4 b;
      int m = edgeIn(c, a, b);
      if (m > 0) dist = min(dist, toSegment(px, a));
      if (m > 1) dist = min(dist, toSegment(px, b));
    }
  }
  float signedPx = inside ? dist : -dist;
  // The wheel, softened at the rim.
  float alpha = 1.0;
  if (u_kind == 0) {
    float out_ = outOf(at);
    alpha = out_ > 1.0 ? 0.0 : min(1.0, (1.0 - out_) * u_size.x * 0.5 * 0.9 + 0.1);
  }
  // How much of the pixel is a color made as asked, the border, and past it.
  vec2 ab = colorAt(at);
  float own = clamp(0.5 + signedPx, 0.0, 1.0);
  float past = clamp(0.5 - signedPx - u_look.z, 0.0, 1.0);
  float onBorder = 1.0 - own - past;
  vec3 rgb = own > 0.0 ? swatch(ab) * own : vec3(0.0);
  if (own < 1.0) {
    // Striped at 45 degrees: how much of the pixel is in a darker stripe.
    vec2 xy = px - 0.5;
    float stripe = u_look.y;
    float u = mod((xy.x + xy.y) / sqrt(2.0), stripe);
    float into = u < stripe / 2.0 ? min(u, stripe / 2.0 - u) : -min(u - stripe / 2.0, stripe - u);
    float shade = 1.0 - u_look.x * clamp(0.5 + into, 0.0, 1.0);
    vec3 under = swatch(ab + s.yz) * shade;
    rgb += under * past + mix(under, u_border, u_look.w) * onBorder;
  }
  color = vec4(rgb * alpha, alpha);
}`;

type Uniforms = Record<string, WebGLUniformLocation | null>;

/** A float buffer to draw into and read back from. */
interface Target {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
}

class Painter {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly solve: { program: WebGLProgram; u: Uniforms };
  private readonly edges: { program: WebGLProgram; u: Uniforms };
  private readonly paint: { program: WebGLProgram; u: Uniforms };
  // The grid: each point as it's made, and where the edge crosses to its neighbors.
  private readonly solved: Target;
  private readonly crossed: Target;
  private grid = { width: 0, height: 0 };
  lost = false;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", () => (this.lost = true));
    const grid = ["u_grid", "u_lumens", "u_fidelity", "u_solves", "u_kind", "u_whites"];
    this.solve = program(gl, SOLVE_FS, grid);
    this.edges = program(gl, EDGE_FS, [...grid, "u_solved"]);
    this.paint = program(gl, PAINT_FS, ["u_solved", "u_edges", "u_grid", "u_size", "u_rgb", "u_look", "u_border", "u_kind", "u_whites"]);
    this.solved = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.crossed = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
  }

  /** Paint `job` into `target` (a 2D canvas, sized to it). */
  draw(target: HTMLCanvasElement, job: BackdropJob) {
    const gl = this.gl;
    const w = Math.round(job.width * job.dpr);
    const h = Math.round(job.height * job.dpr);
    const gx = Math.round(job.width / GRID_PX) + 1;
    const gy = Math.round(job.height / GRID_PX) + 1;
    if (gx !== this.grid.width || gy !== this.grid.height) {
      for (const t of [this.solved, this.crossed]) {
        gl.bindTexture(gl.TEXTURE_2D, t.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gx, gy, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
      }
      this.grid = { width: gx, height: gy };
    }
    const kind = job.kind === "wheel" ? 0 : 1;
    const { kMin, kMax, tint, tintCurve } = job.whites;
    const gridUniforms = (u: Uniforms) => {
      gl.uniform2f(u.u_grid!, gx, gy);
      gl.uniform1f(u.u_lumens!, job.brightness * 1000);
      gl.uniform1f(u.u_fidelity!, job.fidelity);
      gl.uniform1i(u.u_solves!, job.solves ? 1 : 0);
      gl.uniform1i(u.u_kind!, kind);
      gl.uniform4f(u.u_whites!, kMin, kMax, tint, tintCurve);
    };

    // The grid's points, then where the edge crosses between them.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.solved.fbo);
    gl.viewport(0, 0, gx, gy);
    gl.useProgram(this.solve.program);
    gridUniforms(this.solve.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.crossed.fbo);
    gl.useProgram(this.edges.program);
    gridUniforms(this.edges.u);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.solved.texture);
    gl.uniform1i(this.edges.u.u_solved!, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Each pixel.
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if ("drawingBufferColorSpace" in gl && gl.drawingBufferColorSpace !== job.gamut) gl.drawingBufferColorSpace = job.gamut;
    const p = this.paint.u;
    const { stripeDark, stripePx, borderPx, borderRgb, borderInk } = job.look;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.paint.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.solved.texture);
    gl.uniform1i(p.u_solved!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.crossed.texture);
    gl.uniform1i(p.u_edges!, 1);
    gl.uniform2f(p.u_grid!, gx, gy);
    gl.uniform2f(p.u_size!, w, h);
    gl.uniformMatrix3fv(p.u_rgb!, false, LMS_RGB[job.gamut].flat());
    gl.uniform4f(p.u_look!, stripeDark, stripePx * job.dpr, borderPx * job.dpr, borderInk);
    gl.uniform3f(p.u_border!, ...borderRgb);
    gl.uniform1i(p.u_kind!, kind);
    gl.uniform4f(p.u_whites!, kMin, kMax, tint, tintCurve);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Into the picker's canvas, in place of what was there.
    if (target.width !== w || target.height !== h) {
      target.width = w;
      target.height = h;
    }
    const ctx = target.getContext("2d", { colorSpace: job.gamut })!;
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(this.canvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
}

let painter: Painter | null | undefined;

/** Paint a backdrop on the GPU. False where it can't (no WebGL 2, no float buffers to render to, or the context's lost): paint it some other way. */
export function paintOnGpu(target: HTMLCanvasElement, job: BackdropJob): boolean {
  if (painter === undefined) {
    painter = null;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (gl && (gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"))) {
      try {
        painter = new Painter(canvas, gl);
      } catch (err) {
        console.warn("no backdrops on the GPU:", err);
      }
    }
  }
  if (!painter || painter.lost) return false;
  painter.draw(target, job);
  return true;
}

function program(gl: WebGL2RenderingContext, fs: string, uniforms: string[]): { program: WebGLProgram; u: Uniforms } {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, FULL_VS],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader didn't compile");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program didn't link");
  return { program: p, u: Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(p, n)])) };
}
