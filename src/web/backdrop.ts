// The color editor's backdrops (the wheel, the strip of whites) on the GPU,
// fast enough to follow the brightness slider as it's dragged. At each
// place: whether the active lights, at their brightness, make that color as
// asked (every kind of light among them, some, or none: the color bulbs and
// the 4×1 panels each make their own), and what one of them makes instead if
// none do, from tables of what each kind makes worked out ahead (cutoffs.ts),
// on a grid a little coarser than the screen; then each pixel is painted
// from it as ColorEditor paints them on the CPU: the color asked for where
// every one makes it; where only some do, the same, lightly striped; past
// that, what's made instead, striped; with a border round each edge,
// outside it. With one kind of light, the two edges are one. (The bulb's
// solve itself ran here once, in a shader, which some drivers took half a
// minute to compile.)
//
// The edges are found as the CPU finds them: at each grid point, whether the
// color's made as asked; where that changes between points, the crossing,
// to a few halvings; and from crossing to crossing across each cell, a
// straight piece of edge (marching squares), each pixel near it knowing its
// true distance. Three passes: the points, the crossings (each edge's), the
// pixels.
//
// One WebGL context, off the page, paints for every picker, and each
// picker's canvas copies what it paints. Its tables are fetched, and it's
// set up, as the page loads (prepareBackdrops), so nothing waits on them
// when a picker first opens; until they're in, the CPU paints.

import cutoffsUrl from "virtual:cutoffs";
import { SOLVERS, type Device } from "../shared/devices.ts";
import { LMS_RGB, LUMENS_PER_BRIGHTNESS, type Gamut, type Vec3 } from "../shared/lemtone.ts";
import { gunzip, unpack, type Cutoffs, type Table } from "./cutoffs.ts";
import { CURVE, WHEEL_CHROMA } from "./wheel.ts";

/** What a backdrop is painted for. */
export interface BackdropJob {
  kind: "wheel" | "whites";
  /** CSS pixels, and device pixels to each. */
  width: number;
  height: number;
  dpr: number;
  gamut: Gamut;
  /** The active lights' brightness (1.0 = 1000 lm). */
  brightness: number;
  /** The kinds of light among them that solve lemtones (devices.ts); with none, they make every color as asked. */
  devices: Device[];
  /** The kind whose light shows where none make a color as asked (what it makes instead), if any. */
  shown: Device | null;
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

// ---- what the lights make, from the tables (cutoffs.ts) -------------------------

const TABLES = `
uniform sampler2D u_cutWheel0; // the color bulbs': each place on the wheel's cutoff, the brightest they make it as asked, as the slider has it
uniform sampler2D u_cutStrip0; // the same, for the strip of whites
uniform sampler2D u_cutWheel1; // the 4×1 panels'
uniform sampler2D u_cutStrip1;
uniform float u_bright; // the active lights' brightness as the slider has it, its cube root (0: off)
uniform bvec2 u_active; // which kinds of light are among them: the color bulbs, the panels
uniform int u_shown; // the kind whose light shows where none make a color as asked (0, 1)
uniform vec2 u_whiteCool; // its white line, cool end to warm, which a color it can't make pales toward
uniform vec2 u_whiteWarm;
const int BISECT_STEPS = 10;

// A table's cutoff at a place (fractions across and down), spread between its points.
float cutoffAt(sampler2D table, vec2 at) {
  vec2 last = vec2(textureSize(table, 0) - 1);
  vec2 g = clamp(at * last, vec2(0.0), last - 1e-4);
  ivec2 i = ivec2(floor(g));
  vec2 t = g - vec2(i);
  float a = texelFetch(table, i, 0).r;
  float b = texelFetch(table, i + ivec2(1, 0), 0).r;
  float c = texelFetch(table, i + ivec2(0, 1), 0).r;
  float d = texelFetch(table, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// A kind of light's cutoff at a place on this picker.
float cutoffOf(int device, vec2 at) {
  if (device == 0) return u_kind == 0 ? cutoffAt(u_cutWheel0, at) : cutoffAt(u_cutStrip0, at);
  return u_kind == 0 ? cutoffAt(u_cutWheel1, at) : cutoffAt(u_cutStrip1, at);
}

// How many of the active kinds of light make the color at a place on this
// picker as asked: 2 every one, 1 some, 0 none. Every one, if they're off or
// none of them solve lemtones.
int madeAt(vec2 at) {
  if (!(u_bright > 0.0) || !(u_active.x || u_active.y)) return 2;
  bool bulb = u_active.x && cutoffOf(0, at) >= u_bright;
  bool panel = u_active.y && cutoffOf(1, at) >= u_bright;
  if ((bulb || !u_active.x) && (panel || !u_active.y)) return 2;
  return bulb || panel ? 1 : 0;
}

// Whether the shown kind makes a color (a, b) as asked, from where it is on the wheel.
bool makes(vec2 p) {
  float c = length(p);
  vec2 at = vec2(0.5);
  if (c > 0.0) at += 0.5 * vec2(p.x, -p.y) / c * pow(c / ${glf(WHEEL_CHROMA)}, 1.0 / ${glf(CURVE)});
  return (u_shown == 0 ? cutoffAt(u_cutWheel0, at) : cutoffAt(u_cutWheel1, at)) >= u_bright;
}

// Where p projects onto the white line from cw to ww: 0 at cw, 1 at ww.
float betaOn(vec2 cw, vec2 ww, vec2 p) {
  vec2 d = ww - cw;
  return clamp(dot(p - cw, d) / dot(d, d), 0.0, 1.0);
}
`;

const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Each grid point: whether it's made as asked by every kind of light (1), some
// (0.5) or none (0); if none, how far the shown kind moves its color (in a,
// b), as solver.ts's output does; and whether it's worked out at all (on the
// wheel, not far past the rim).
const SOLVE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_grid;
out vec4 result;
${COLOR}
${PLACES}
${TABLES}
void main() {
  vec2 at = (gl_FragCoord.xy - 0.5) / (u_grid - 1.0);
  // Past the rim, but for the points its pixels are spread from: not worked out.
  if (u_kind == 0 && outOf(at) > 1.08) {
    result = vec4(0.0);
    return;
  }
  int made = madeAt(at);
  if (made > 0) {
    result = vec4(made == 2 ? 1.0 : 0.5, 0.0, 0.0, 1.0);
    return;
  }
  vec2 p = colorAt(at);
  // Its point on the light's white line, which the solve pales it toward.
  vec2 w = u_whiteCool + betaOn(u_whiteCool, u_whiteWarm, p) * (u_whiteWarm - u_whiteCool);
  // Too bright for any color: the brightest white it can make there (clamp), that white, dimmer.
  if (!makes(w)) {
    result = vec4(0.0, w - p, 1.0);
    return;
  }
  // Paled toward the white line, keeping the lumens (desat), as far as it still makes it.
  float lo = 0.0;
  float hi = 1.0;
  for (int s = 0; s < BISECT_STEPS; s++) {
    float mid = 0.5 * (lo + hi);
    if (makes(w + mid * (p - w))) lo = mid;
    else hi = mid;
  }
  result = vec4(0.0, (lo - 1.0) * (p - w), 1.0);
}`;

// One edge's crossings (u_least: 2 for every kind of light's, 1 for at least
// one's): at each grid point, where it crosses to the next point across, and
// down (as a share of the way there, found to EDGE_STEPS halvings; -1 where
// it doesn't), and for a cell it crosses on all four sides, whether its
// middle is made as asked (which says which corners it cuts off).
const EDGE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_grid;
uniform sampler2D u_solved;
uniform int u_least;
out vec4 result;
${COLOR}
${PLACES}
${TABLES}
bool asked(vec2 at) { return madeAt(at) >= u_least; }
bool askedAt(ivec2 g) { return texelFetch(u_solved, g, 0).x > (u_least == 2 ? 0.75 : 0.25); }
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
    if (asked((vec2(g) + t * vec2(step)) / (u_grid - 1.0)) == from) lo = t;
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
    middle = asked((vec2(g) + 0.5) / (u_grid - 1.0)) ? 1.0 : 0.0;
  }
  result = vec4(across, down, middle, 1.0);
}`;

// Each pixel, from the grid, as ColorEditor's paintBackdrop paints it.
const PAINT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_solved;
uniform sampler2D u_edgesAny; // the edge round what at least one kind of light makes as asked
uniform sampler2D u_edgesAll; // round what every one does
uniform bool u_two; // whether there are two edges (more than one kind of light), or one
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

// A grid point: whether it's made as asked (by every kind of light, least 2, or
// at least one, least 1), whether it was worked out at all, and where it is (device px).
bool asked(ivec2 g, int least) { return texelFetch(u_solved, g, 0).x > (least == 2 ? 0.75 : 0.25); }
bool live(ivec2 g) { return texelFetch(u_solved, g, 0).w > 0.5; }
vec2 placeOf(ivec2 g) { return vec2(g) / (u_grid - 1.0) * u_size; }

// An edge's pieces in the cell from grid point c across and down (up to two, as x0, y0, x1, y1); how many.
int edgeIn(ivec2 c, sampler2D edges, int least, out vec4 s0, out vec4 s1) {
  // Its corners: top left, then clockwise.
  ivec2 k[4] = ivec2[4](c, c + ivec2(1, 0), c + ivec2(1, 1), c + ivec2(0, 1));
  if (!live(k[0]) || !live(k[1]) || !live(k[2]) || !live(k[3])) return 0;
  bool f[4] = bool[4](asked(k[0], least), asked(k[1], least), asked(k[2], least), asked(k[3], least));
  // Crossings on the top, right, bottom and left sides.
  bool on[4] = bool[4](f[0] != f[1], f[1] != f[2], f[3] != f[2], f[0] != f[3]);
  vec4 top = texelFetch(edges, k[0], 0);
  vec2 x[4];
  x[0] = mix(placeOf(k[0]), placeOf(k[1]), top.x);
  x[1] = mix(placeOf(k[1]), placeOf(k[2]), texelFetch(edges, k[1], 0).y);
  x[2] = mix(placeOf(k[3]), placeOf(k[2]), texelFetch(edges, k[3], 0).x);
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

// How far the pixel at px (at, as fractions) is inside an edge (device px; negative outside it).
float signedTo(vec2 px, vec2 at, sampler2D edges, int least) {
  ivec2 last = ivec2(u_grid) - 2;
  ivec2 cell = min(ivec2(at * (u_grid - 1.0)), last);
  // Made as asked: as its cell's first corner that no piece of the edge in the cell parts it from.
  vec4 e0;
  vec4 e1;
  int n = edgeIn(cell, edges, least, e0, e1);
  ivec2 corners[4] = ivec2[4](cell, cell + ivec2(1, 0), cell + ivec2(1, 1), cell + ivec2(0, 1));
  bool inside = false;
  for (int c = 0; c < 4; c++) {
    vec2 q = placeOf(corners[c]);
    bool parted = (n > 0 && sideOf(px, e0) != sideOf(q, e0)) || (n > 1 && sideOf(px, e1) != sideOf(q, e1));
    if (!parted) {
      inside = asked(corners[c], least);
      break;
    }
  }
  // How far from the edge, in this cell and those round it; further is past the border.
  float dist = 1e9;
  for (int dj = -1; dj <= 1; dj++) {
    for (int di = -1; di <= 1; di++) {
      ivec2 c = cell + ivec2(di, dj);
      if (any(lessThan(c, ivec2(0))) || any(greaterThan(c, last))) continue;
      vec4 a;
      vec4 b;
      int m = edgeIn(c, edges, least, a, b);
      if (m > 0) dist = min(dist, toSegment(px, a));
      if (m > 1) dist = min(dist, toSegment(px, b));
    }
  }
  return inside ? dist : -dist;
}

void main() {
  // The pixel's middle, from the top left.
  vec2 px = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 at = px / u_size;
  vec4 s = solvedAt(at);
  float anyPx = signedTo(px, at, u_edgesAny, 1);
  float allPx = u_two ? signedTo(px, at, u_edgesAll, 2) : anyPx;
  // The wheel, softened at the rim.
  float alpha = 1.0;
  if (u_kind == 0) {
    float out_ = outOf(at);
    alpha = out_ > 1.0 ? 0.0 : min(1.0, (1.0 - out_) * u_size.x * 0.5 * 0.9 + 0.1);
  }
  // How much of the pixel every kind of light makes as asked, how much at least one does,
  // and how much is each edge's border (outside it: the inner one's, inside the outer).
  vec2 ab = colorAt(at);
  float inAny = clamp(0.5 + anyPx, 0.0, 1.0);
  float inAll = min(inAny, clamp(0.5 + allPx, 0.0, 1.0));
  float onAny = clamp(0.5 - anyPx, 0.0, 1.0) - clamp(0.5 - anyPx - u_look.z, 0.0, 1.0);
  float onAll = u_two ? min(inAny - inAll, clamp(0.5 - allPx, 0.0, 1.0) - clamp(0.5 - allPx - u_look.z, 0.0, 1.0)) : 0.0;
  vec3 asked = swatch(ab);
  vec3 rgb = asked * inAll;
  if (inAll < 1.0) {
    // Striped at 45 degrees: how much of the pixel is in a darker stripe.
    vec2 xy = px - 0.5;
    float stripe = u_look.y;
    float u = mod((xy.x + xy.y) / sqrt(2.0), stripe);
    float into = u < stripe / 2.0 ? min(u, stripe / 2.0 - u) : -min(u - stripe / 2.0, stripe - u);
    float dark = clamp(0.5 + into, 0.0, 1.0);
    // Made by some: as asked, lightly striped. By none: what the shown kind makes instead, striped.
    vec3 some = asked * (1.0 - 0.5 * u_look.x * dark);
    vec3 under = swatch(ab + s.yz) * (1.0 - u_look.x * dark);
    rgb += some * (inAny - inAll) + under * (1.0 - inAny) + (u_border - some) * u_look.w * onAll + (u_border - under) * u_look.w * onAny;
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
  // The grid: each point as it's made, and where each edge crosses to its neighbors.
  private readonly solved: Target;
  private readonly crossedAny: Target;
  private readonly crossedAll: Target;
  // The tables (cutoffs.ts), each kind of light's, on texture units of their own.
  private readonly cuts: WebGLTexture[];
  private grid = { width: 0, height: 0 };
  lost = false;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, cutoffs: Cutoffs) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", () => (this.lost = true));
    const grid = ["u_grid", "u_bright", "u_active", "u_shown", "u_kind", "u_whites", "u_cutWheel0", "u_cutStrip0", "u_cutWheel1", "u_cutStrip1", "u_whiteCool", "u_whiteWarm"];
    this.solve = program(gl, SOLVE_FS, grid);
    this.edges = program(gl, EDGE_FS, [...grid, "u_solved", "u_least"]);
    this.paint = program(gl, PAINT_FS, ["u_solved", "u_edgesAny", "u_edgesAll", "u_two", "u_grid", "u_size", "u_rgb", "u_look", "u_border", "u_kind", "u_whites"]);
    this.solved = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.crossedAny = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.crossedAll = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.cuts = [cutoffs.bulb.wheel, cutoffs.bulb.strip, cutoffs.panel.wheel, cutoffs.panel.strip].map((t) => table(gl, t));
  }

  /** Paint `job` into `target` (a 2D canvas, sized to it). */
  draw(target: HTMLCanvasElement, job: BackdropJob) {
    const gl = this.gl;
    const w = Math.round(job.width * job.dpr);
    const h = Math.round(job.height * job.dpr);
    const gx = Math.round(job.width / GRID_PX) + 1;
    const gy = Math.round(job.height / GRID_PX) + 1;
    if (gx !== this.grid.width || gy !== this.grid.height) {
      for (const t of [this.solved, this.crossedAny, this.crossedAll]) {
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
    // Off, as the solve has it, below a billionth of a lumen.
    const bright = job.brightness * LUMENS_PER_BRIGHTNESS > 1e-9 ? Math.cbrt(job.brightness) : 0;
    const shown = job.shown ?? job.devices[0] ?? "bulb";
    const two = job.devices.length > 1;
    const gridUniforms = (u: Uniforms) => {
      gl.uniform2f(u.u_grid!, gx, gy);
      gl.uniform1f(u.u_bright!, bright);
      gl.uniform2i(u.u_active!, job.devices.includes("bulb") ? 1 : 0, job.devices.includes("panel") ? 1 : 0);
      gl.uniform1i(u.u_shown!, shown === "bulb" ? 0 : 1);
      gl.uniform1i(u.u_kind!, kind);
      gl.uniform4f(u.u_whites!, kMin, kMax, tint, tintCurve);
      ["u_cutWheel0", "u_cutStrip0", "u_cutWheel1", "u_cutStrip1"].forEach((name, i) => gl.uniform1i(u[name]!, 2 + i));
      gl.uniform2f(u.u_whiteCool!, ...SOLVERS[shown].cwAb);
      gl.uniform2f(u.u_whiteWarm!, ...SOLVERS[shown].wwAb);
    };
    this.cuts.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });

    // The grid's points, then where each edge crosses between them (the one, with one kind of light).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.solved.fbo);
    gl.viewport(0, 0, gx, gy);
    gl.useProgram(this.solve.program);
    gridUniforms(this.solve.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.edges.program);
    gridUniforms(this.edges.u);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.solved.texture);
    gl.uniform1i(this.edges.u.u_solved!, 0);
    for (const [target, least] of two ? ([[this.crossedAny, 1], [this.crossedAll, 2]] as const) : ([[this.crossedAny, 1]] as const)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.uniform1i(this.edges.u.u_least!, least);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

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
    gl.bindTexture(gl.TEXTURE_2D, this.crossedAny.texture);
    gl.uniform1i(p.u_edgesAny!, 1);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.crossedAll.texture);
    gl.uniform1i(p.u_edgesAll!, 6);
    gl.uniform1i(p.u_two!, two ? 1 : 0);
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

let cutoffs: Cutoffs | null = null;
let painter: Painter | null | undefined;

/**
 * Fetch the tables and get the GPU ready to paint with them, as the page
 * loads, so a picker opening doesn't wait on either. Without them, the
 * backdrops are painted on the CPU.
 */
export async function prepareBackdrops(): Promise<void> {
  try {
    const res = await fetch(cutoffsUrl);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    cutoffs = unpack(await gunzip(new Uint8Array(await res.arrayBuffer())));
    if (!cutoffs) throw new Error("they aren't the size they should be");
  } catch (err) {
    console.warn("no backdrop tables, so backdrops are painted on the CPU:", err);
    return;
  }
  // Setting it up compiles shaders: once the page has settled.
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => painterNow());
  else setTimeout(() => painterNow(), 0);
}

/** The painter, set up if it isn't yet; null where it can't paint (no tables yet, no WebGL 2, no float buffers to render to, or the context's lost). */
function painterNow(): Painter | null {
  if (!cutoffs) return null;
  if (painter === undefined) {
    painter = null;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (gl && (gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"))) {
      try {
        painter = new Painter(canvas, gl, cutoffs);
      } catch (err) {
        console.warn("no backdrops on the GPU:", err);
      }
    }
  }
  return painter && !painter.lost ? painter : null;
}

/** Paint a backdrop on the GPU. False where it can't (painterNow): paint it some other way. */
export function paintOnGpu(target: HTMLCanvasElement, job: BackdropJob): boolean {
  const p = painterNow();
  if (!p) return false;
  p.draw(target, job);
  return true;
}

/** A table, as a texture of float cutoffs, read a point at a time. */
function table(gl: WebGL2RenderingContext, t: Table): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, t.width, t.height, 0, gl.RED, gl.FLOAT, t.cutoffs);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
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
