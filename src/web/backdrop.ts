// The color editor's backdrops (the wheel, the strip of whites) on the GPU,
// fast enough to follow the brightness slider as it's dragged. At each
// place: whether the active lights' bulbs, at their brightness, make that
// color as asked, and what they make instead if not, from tables of what
// they make worked out ahead (cutoffs.ts), on a grid a little coarser than
// the screen; then each pixel is painted from it as ColorEditor paints them
// on the CPU: the color asked for where it's made, past the edge what's made
// instead, striped, with a border round the edge, outside it. (The bulb's
// solve itself ran here once, in a shader, which some drivers took half a
// minute to compile.)
//
// The edge is found as the CPU finds it: at each grid point, whether the
// color's made as asked; where that changes between points, the crossing,
// to a few halvings; and from crossing to crossing across each cell, a
// straight piece of edge (marching squares), each pixel near it knowing its
// true distance. Three passes: the points, the crossings, the pixels.
//
// One WebGL context, off the page, paints for every picker, and each
// picker's canvas copies what it paints. Its tables are fetched, and it's
// set up, as the page loads (prepareBackdrops), so nothing waits on them
// when a picker first opens; until they're in, the CPU paints.

import cutoffsUrl from "virtual:cutoffs";
import { CW_AB, WW_AB } from "../shared/bulb.ts";
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

// ---- what the bulbs make, from the tables (cutoffs.ts) -------------------------

const TABLES = `
uniform sampler2D u_cutWheel; // each place on the wheel's cutoff: the brightest the bulbs make it as asked, as the slider has it
uniform sampler2D u_cutStrip; // the same, for the strip of whites
uniform float u_bright; // the active lights' brightness as the slider has it, its cube root (0: off)
uniform bool u_solves; // whether their bulbs solve lemtones; if not, they make every color as asked
uniform vec2 u_whiteCool; // the bulbs' white line, cool end to warm, which a color they can't make pales toward
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

// Whether the active lights make the color at a place on this picker as asked:
// always, if they're off or their bulbs don't solve lemtones.
bool asked(vec2 at) {
  if (!u_solves || !(u_bright > 0.0)) return true;
  return (u_kind == 0 ? cutoffAt(u_cutWheel, at) : cutoffAt(u_cutStrip, at)) >= u_bright;
}

// Whether they make a color (a, b) as asked, from where it is on the wheel.
bool makes(vec2 p) {
  float c = length(p);
  vec2 at = vec2(0.5);
  if (c > 0.0) at += 0.5 * vec2(p.x, -p.y) / c * pow(c / ${glf(WHEEL_CHROMA)}, 1.0 / ${glf(CURVE)});
  return cutoffAt(u_cutWheel, at) >= u_bright;
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

// Each grid point: whether it's made as asked (1 or 0); if not, how far the
// bulbs move its color (in a, b), as bulb.ts's bulbOutput; and whether it's
// worked out at all (on the wheel, not far past the rim).
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
  if (asked(at)) {
    result = vec4(1.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 p = colorAt(at);
  // Its point on the bulbs' white line, which the solve pales it toward.
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
${PLACES}
${TABLES}
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
  // The tables (cutoffs.ts), on texture units of their own.
  private readonly cutWheel: WebGLTexture;
  private readonly cutStrip: WebGLTexture;
  private grid = { width: 0, height: 0 };
  lost = false;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, cutoffs: Cutoffs) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", () => (this.lost = true));
    const grid = ["u_grid", "u_bright", "u_solves", "u_kind", "u_whites", "u_cutWheel", "u_cutStrip", "u_whiteCool", "u_whiteWarm"];
    this.solve = program(gl, SOLVE_FS, grid);
    this.edges = program(gl, EDGE_FS, [...grid, "u_solved"]);
    this.paint = program(gl, PAINT_FS, ["u_solved", "u_edges", "u_grid", "u_size", "u_rgb", "u_look", "u_border", "u_kind", "u_whites"]);
    this.solved = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.crossed = { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.cutWheel = table(gl, cutoffs.wheel);
    this.cutStrip = table(gl, cutoffs.strip);
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
    // Off, as the solve has it, below a billionth of a lumen.
    const bright = job.brightness * LUMENS_PER_BRIGHTNESS > 1e-9 ? Math.cbrt(job.brightness) : 0;
    const gridUniforms = (u: Uniforms) => {
      gl.uniform2f(u.u_grid!, gx, gy);
      gl.uniform1f(u.u_bright!, bright);
      gl.uniform1i(u.u_solves!, job.solves ? 1 : 0);
      gl.uniform1i(u.u_kind!, kind);
      gl.uniform4f(u.u_whites!, kMin, kMax, tint, tintCurve);
      gl.uniform1i(u.u_cutWheel!, 2);
      gl.uniform1i(u.u_cutStrip!, 3);
      gl.uniform2f(u.u_whiteCool!, ...CW_AB);
      gl.uniform2f(u.u_whiteWarm!, ...WW_AB);
    };
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.cutWheel);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.cutStrip);

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
