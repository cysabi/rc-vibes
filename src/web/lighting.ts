// The light on the floor, simulated. Each light hangs MOUNT_MM above the
// floor and lights it as real light does: brightest straight below, falling
// off with the inverse square of the distance and the angle it arrives at,
// and only where the light can see past the walls (shadows.ts).
//
// Light also bounces: off the floor to the ceiling and back down, and off
// the walls. That's approximated by spreading the light that lands directly
// (worked out on a 10 cm grid over the whole floor) a couple of meters
// around, the way light off a white ceiling spreads, without ever crossing a
// wall; so shadows fill in, and light finds its way through doorways and
// round corners. It's worked out again only when the lights change.
//
// Everything adds up in linear light in float buffers, which are then
// tone-mapped for the screen (in Display P3 where the screen shows it). This
// is WebGL, which stops at white; lighting-hdr.ts is the same on WebGPU,
// going past it.

import type { Gamut } from "../shared/lemtone.ts";
import { bucketsOf, reachOf, type Grid, type Segment } from "./shadows.ts";
import type { View } from "./viewport.ts";

/** How high the lights hang above the floor, in millimeters. */
export const MOUNT_MM = 2400;
/** How far a light's pool is drawn, in millimeters: by here it's under 0.5% of what's below it. */
export const REACH_MM = 5 * MOUNT_MM;
// Screen brightness per lux, before tone mapping.
export const EXPOSURE = 0.0012;
// Light that lands on the floor again after bouncing, as a share of what
// lands there directly (in a room that keeps it all in).
export const BOUNCE = 0.35;
// The bounce grid's cells (mm), and the strides (in cells) of the passes
// that spread light across it. Each pass along an axis spreads it by
// stride² / 2 cells² of variance: about 2.2 m in all, near the ceiling's
// height above the floor, where light off it lands.
const CELL_MM = 100;
export const STRIDES = [1, 2, 3, 4, 6, 8, 12, 16, 20];
// The bounce is read from at least CLEARANCE_MM off the nearest wall, so
// the cells it blends (up to 1.41 cells away, corner to corner) never reach
// across one or into one, which would leave a dark fringe along every wall.
// Each pixel finds that wall itself, exactly, among the walls filed under
// its BUCKET_MM square (see bucketsOf), so it's as sharp at any zoom. Inside
// walls, the plan's own filled wall shapes cover the light.
export const CLEARANCE_MM = 1.5 * CELL_MM;
const BUCKET_MM = 250;
// Lists (the walls, and which are in each bucket) go in textures this wide.
export const ROW = 1024;

/** One light (or a third of a panel) as the floor sees it. */
export interface Source {
  /** Where it is, in millimeters. */
  x: number;
  y: number;
  /** The part of the floor it lights, as a fan of x, y pairs in millimeters, starting at the light. */
  fan: Float32Array;
  /** A bare bulb shines every way; a reflector bulb or a panel shines down (Lambertian). */
  bare: boolean;
}

/** The plan's extent, in millimeters. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What draws the light on the floor: Lighting here, or HdrLighting (lighting-hdr.ts). */
export interface Renderer {
  /** Set once its context is lost: the map draws glows instead. */
  lost: boolean;
  setFloor(walls: Segment[], box: Box): void;
  setSources(sources: Source[]): void;
  render(view: View, width: number, height: number, flux: Float32Array, gamut: Gamut): void;
  dispose(): void;
}

/** What the bounce needs to know about a floor's walls (see setFloor). */
export interface Walls {
  /** The bounce grid, and the buckets the walls are filed under. */
  grid: Grid;
  buckets: Grid;
  /** How far light spreads from each cell before a wall (reachOf). */
  reach: Uint8Array;
  /** Each wall, as x1, y1, x2, y2; each bucket's first wall in `list` and how many; and the list. */
  segs: Float32Array;
  cells: Int32Array;
  list: Int32Array;
}

// Worked out once for each floor's walls (it takes a moment).
const wallData = new WeakMap<Segment[], Omit<Walls, "grid" | "buckets">>();

/** A floor's walls, for the bounce, on grids over its extent. */
export function wallsOf(walls: Segment[], box: Box): Walls {
  const grid: Grid = { x: box.x, y: box.y, cell: CELL_MM, width: Math.ceil(box.width / CELL_MM), height: Math.ceil(box.height / CELL_MM) };
  const buckets: Grid = { ...grid, cell: BUCKET_MM, width: Math.ceil(box.width / BUCKET_MM), height: Math.ceil(box.height / BUCKET_MM) };
  let data = wallData.get(walls);
  if (!data) {
    const { cells, list } = bucketsOf(walls, buckets, CLEARANCE_MM);
    const segs = new Float32Array(walls.length * 4);
    walls.forEach((w, n) => segs.set([w.x1, w.y1, w.x2, w.y2], n * 4));
    wallData.set(walls, (data = { reach: reachOf(walls, grid), segs, cells, list }));
  }
  return { grid, buckets, ...data };
}

// `u_flip` is 1 drawing to the screen (rows from the top) and -1 drawing to
// the bounce grid (rows from y = 0 up, as texture rows go).
const LIGHT_VS = `#version 300 es
in vec2 a_mm;
uniform vec3 u_view; // px per mm, offset x, offset y
uniform vec2 u_size; // px
uniform float u_flip;
out vec2 v_mm;
void main() {
  v_mm = a_mm;
  vec2 px = u_view.yz + a_mm * u_view.x;
  gl_Position = vec4(px.x / u_size.x * 2.0 - 1.0, u_flip * (1.0 - px.y / u_size.y * 2.0), 0.0, 1.0);
}`;

// Illuminance on the floor (lux per lumen) at horizontal distance r from a
// light h above it, with cos θ = h / √(r² + h²):
//   shining down (I = Φ/π · cos θ):    Φ/π  · cos⁴θ / h²
//   bare bulb    (I = Φ/4π):           Φ/4π · cos³θ / h²
// faded to nothing at the edge of its reach.
const LIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_mm;
uniform vec2 u_light; // mm
uniform vec3 u_flux;  // lumens, as linear RGB
uniform float u_bare;
uniform float u_height; // m
uniform float u_reach;  // m
out vec4 color;
void main() {
  vec2 d = (v_mm - u_light) / 1000.0;
  float r2 = dot(d, d);
  float h2 = u_height * u_height;
  float c2 = h2 / (r2 + h2);
  float e = mix(c2 * c2 / 3.14159265, c2 * sqrt(c2) / 12.5663706, u_bare) / h2;
  float fade = max(0.0, 1.0 - r2 / (u_reach * u_reach));
  color = vec4(u_flux * e * fade * fade, 1.0);
}`;

export const FULL_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// One pass of spreading the bounce: each cell takes a quarter from the cells
// `u_step` ahead and behind, if no wall is in the way (see reachOf), and
// otherwise keeps that quarter itself, so no light is lost at a wall.
export const SPREAD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_light;
uniform sampler2D u_reach;
uniform ivec2 u_step;
out vec4 color;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 reach = floor(texelFetch(u_reach, c, 0) * 255.0 + 0.5);
  float stride = float(u_step.x + u_step.y);
  float ahead = u_step.x > 0 ? reach.r : reach.b;
  float behind = u_step.x > 0 ? reach.g : reach.a;
  vec3 here = texelFetch(u_light, c, 0).rgb;
  vec3 next = ahead >= stride ? texelFetch(u_light, c + u_step, 0).rgb : here;
  vec3 prev = behind >= stride ? texelFetch(u_light, c - u_step, 0).rgb : here;
  color = vec4(0.5 * here + 0.25 * (next + prev), 1.0);
}`;

// The direct light plus the bounce under each pixel, then exposure, a soft
// shoulder (1 - e^-x, so bright pools never clip), and the sRGB curve
// (Display P3 uses the same one), dithered by under a step of 8-bit color so
// dim gradients don't band.
const SCREEN_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
in vec2 v_uv;
uniform sampler2D u_direct;
uniform sampler2D u_bounce;
uniform vec3 u_view;
uniform vec2 u_size;
uniform vec4 u_grid; // x, y, width, height in mm
uniform sampler2D u_segs;   // each wall: x1, y1, x2, y2 (mm)
uniform isampler2D u_cells; // each bucket: where its walls start in u_list, and how many
uniform isampler2D u_list;
uniform vec3 u_buckets;     // x, y, size (mm)
uniform ivec2 u_bucketCount;
uniform float u_clearance;
uniform float u_gain;
uniform float u_exposure;
out vec4 color;
ivec2 at(int n) {
  return ivec2(n % ${ROW}, n / ${ROW});
}
// p moved to u_clearance from the nearest wall, straight away from it.
vec2 clear(vec2 p) {
  ivec2 b = ivec2(floor((p - u_buckets.xy) / u_buckets.z));
  if (any(lessThan(b, ivec2(0))) || any(greaterThanEqual(b, u_bucketCount))) return p;
  ivec2 near = texelFetch(u_cells, b, 0).xy;
  float nearest = u_clearance;
  vec2 away = vec2(0.0);
  for (int k = 0; k < 256; k++) {
    if (k >= near.y) break;
    vec4 s = texelFetch(u_segs, at(texelFetch(u_list, at(near.x + k), 0).x), 0);
    vec2 d = s.zw - s.xy;
    vec2 v = p - (s.xy + clamp(dot(p - s.xy, d) / max(dot(d, d), 1e-6), 0.0, 1.0) * d);
    float dist = length(v);
    if (dist < nearest) {
      nearest = dist;
      away = dist > 1e-3 ? v / dist : vec2(0.0);
    }
  }
  return p + away * (u_clearance - nearest);
}
vec3 encode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec2 mm = (vec2(v_uv.x, 1.0 - v_uv.y) * u_size - u_view.yz) / u_view.x;
  // Twice, for corners: straight away from one wall can be toward another.
  mm = clear(clear(mm));
  vec2 g = (mm - u_grid.xy) / u_grid.zw;
  vec3 bounce = g == clamp(g, 0.0, 1.0) ? texture(u_bounce, g).rgb : vec3(0.0);
  vec3 c = 1.0 - exp(-(texture(u_direct, v_uv).rgb + u_gain * bounce) * u_exposure);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color = vec4(encode(c) + (noise - 0.5) / 255.0, 1.0);
}`;

export interface Target {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class Lighting implements Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly light: { program: WebGLProgram; u: Uniforms };
  private readonly spreader: { program: WebGLProgram; u: Uniforms };
  private readonly screen: { program: WebGLProgram; u: Uniforms };
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly direct: Target;
  private directSize = { width: 0, height: 0 };
  private ranges: { first: number; count: number; bare: boolean; x: number; y: number }[] = [];
  // The bounce grid for this floor: what stops light, and two buffers to spread it between.
  private floor: { grid: Grid; reach: WebGLTexture; buckets: Grid; walls: WallTextures; targets: [Target, Target]; result: number } | null = null;
  // Stand-ins while there's no floor, so every sampler has a texture of its kind.
  private readonly noWalls: WallTextures;
  // The light the bounce was last worked out for; null when it has to be again.
  private spreadFor: Float32Array | null = null;
  lost = false;

  /** A renderer for this canvas, or null where WebGL 2 or float buffers aren't there (the map falls back to drawn glows). */
  static create(canvas: HTMLCanvasElement): Lighting | null {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl || !(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"))) return null;
    try {
      return new Lighting(canvas, gl);
    } catch (err) {
      console.warn("no simulated light:", err);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", () => (this.lost = true));
    this.light = program(gl, LIGHT_VS, LIGHT_FS, ["u_view", "u_size", "u_flip", "u_light", "u_flux", "u_bare", "u_height", "u_reach"]);
    this.spreader = program(gl, FULL_VS, SPREAD_FS, ["u_light", "u_reach", "u_step"]);
    this.screen = program(gl, FULL_VS, SCREEN_FS, ["u_direct", "u_bounce", "u_segs", "u_cells", "u_list", "u_view", "u_size", "u_grid", "u_buckets", "u_bucketCount", "u_clearance", "u_gain", "u_exposure"]);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const at = gl.getAttribLocation(this.light.program, "a_mm");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.direct = target(gl);
    this.noWalls = wallTextures(gl, new Float32Array(4), new Int32Array(2), 1, 1, new Int32Array(1));
  }

  /** The floor's walls and extent, for the bounce. */
  setFloor(walls: Segment[], box: Box) {
    const gl = this.gl;
    this.dropFloor();
    const data = wallsOf(walls, box);
    const { grid, buckets } = data;
    const reach = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, reach);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, grid.width, grid.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data.reach);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const targets: [Target, Target] = [target(gl), target(gl)];
    for (const t of targets) size(gl, t, grid.width, grid.height);
    const textures = wallTextures(gl, data.segs, data.cells, buckets.width, buckets.height, data.list);
    this.floor = { grid, reach, buckets, walls: textures, targets, result: 0 };
    this.spreadFor = null;
  }

  /** Where the lights are and what each can see. Only called when that changes. */
  setSources(sources: Source[]) {
    const gl = this.gl;
    const data = new Float32Array(sources.reduce((n, s) => n + s.fan.length, 0));
    this.ranges = [];
    let at = 0;
    for (const s of sources) {
      data.set(s.fan, at);
      this.ranges.push({ first: at / 2, count: s.fan.length / 2, bare: s.bare, x: s.x, y: s.y });
      at += s.fan.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.spreadFor = null;
  }

  /**
   * Draw the floor's light for this view (`width` × `height` CSS pixels).
   * `flux` is each source's light in lumens as linear RGB in `gamut`, three
   * per source, in the order setSources had them.
   */
  render(view: View, width: number, height: number, flux: Float32Array, gamut: Gamut) {
    const gl = this.gl;
    if (this.lost) return;
    // In the gamut the flux is in, which changes as the window moves between
    // screens (or it's chosen). Changing it clears the drawing buffer, so
    // only when it does.
    if ("drawingBufferColorSpace" in gl && gl.drawingBufferColorSpace !== gamut) gl.drawingBufferColorSpace = gamut;
    if (this.floor && !(this.spreadFor && same(this.spreadFor, flux))) {
      this.spread(flux);
      this.spreadFor = flux.slice();
    }

    // The direct light, for this view.
    const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
    if (w !== this.directSize.width || h !== this.directSize.height) {
      size(gl, this.direct, w, h);
      this.directSize = { width: w, height: h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.direct.fbo);
    gl.viewport(0, 0, w, h);
    this.drawLights([view.scale, view.ox, view.oy], [width, height], 1, flux);

    // Plus the bounce, to the screen.
    const s = this.screen.u;
    const f = this.floor;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.screen.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.direct.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, f ? f.targets[f.result].texture : this.direct.texture);
    const walls = f ? f.walls : this.noWalls;
    walls.forEach((t, k) => {
      gl.activeTexture(gl.TEXTURE2 + k);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    gl.uniform1i(s.u_direct!, 0);
    gl.uniform1i(s.u_bounce!, 1);
    gl.uniform1i(s.u_segs!, 2);
    gl.uniform1i(s.u_cells!, 3);
    gl.uniform1i(s.u_list!, 4);
    gl.uniform3f(s.u_view!, view.scale, view.ox, view.oy);
    gl.uniform2f(s.u_size!, width, height);
    if (f) {
      gl.uniform4f(s.u_grid!, f.grid.x, f.grid.y, f.grid.width * f.grid.cell, f.grid.height * f.grid.cell);
      gl.uniform3f(s.u_buckets!, f.buckets.x, f.buckets.y, f.buckets.cell);
    }
    gl.uniform2i(s.u_bucketCount!, f?.buckets.width ?? 0, f?.buckets.height ?? 0);
    gl.uniform1f(s.u_clearance!, CLEARANCE_MM);
    gl.uniform1f(s.u_gain!, f ? BOUNCE : 0);
    gl.uniform1f(s.u_exposure!, EXPOSURE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Work out the bounce: the direct light on the grid, spread round the floor without crossing walls. */
  private spread(flux: Float32Array) {
    const gl = this.gl;
    const f = this.floor!;
    const { x, y, cell, width, height } = f.grid;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.targets[0].fbo);
    gl.viewport(0, 0, width, height);
    this.drawLights([1 / cell, -x / cell, -y / cell], [width, height], -1, flux);

    const u = this.spreader.u;
    gl.useProgram(this.spreader.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, f.reach);
    gl.uniform1i(u.u_light!, 0);
    gl.uniform1i(u.u_reach!, 1);
    gl.activeTexture(gl.TEXTURE0);
    let from = 0;
    for (const stride of STRIDES) {
      for (const [dx, dy] of [
        [stride, 0],
        [0, stride],
      ] as const) {
        const to = 1 - from;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.targets[to].fbo);
        gl.bindTexture(gl.TEXTURE_2D, f.targets[from].texture);
        gl.uniform2i(u.u_step!, dx, dy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        from = to;
      }
    }
    f.result = from;
  }

  /** Every light's pool, added up into the bound framebuffer. */
  private drawLights(view: [number, number, number], size: [number, number], flip: number, flux: Float32Array) {
    const gl = this.gl;
    const u = this.light.u;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.light.program);
    gl.uniform3f(u.u_view!, ...view);
    gl.uniform2f(u.u_size!, ...size);
    gl.uniform1f(u.u_flip!, flip);
    gl.uniform1f(u.u_height!, MOUNT_MM / 1000);
    gl.uniform1f(u.u_reach!, REACH_MM / 1000);
    gl.bindVertexArray(this.vao);
    this.ranges.forEach((r, i) => {
      const [red, green, blue] = [flux[i * 3]!, flux[i * 3 + 1]!, flux[i * 3 + 2]!];
      if (red + green + blue <= 0) return;
      gl.uniform2f(u.u_light!, r.x, r.y);
      gl.uniform3f(u.u_flux!, red, green, blue);
      gl.uniform1f(u.u_bare!, r.bare ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_FAN, r.first, r.count);
    });
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  private dropFloor() {
    const f = this.floor;
    if (!f) return;
    this.gl.deleteTexture(f.reach);
    for (const t of f.walls) this.gl.deleteTexture(t);
    for (const t of f.targets) drop(this.gl, t);
    this.floor = null;
  }

  dispose() {
    const gl = this.gl;
    this.dropFloor();
    for (const t of this.noWalls) gl.deleteTexture(t);
    for (const p of [this.light, this.spreader, this.screen]) gl.deleteProgram(p.program);
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    drop(gl, this.direct);
  }
}

export type Uniforms = Record<string, WebGLUniformLocation | null>;

export const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function program(gl: WebGL2RenderingContext, vs: string, fs: string, uniforms: string[]): { program: WebGLProgram; u: Uniforms } {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
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

/** A float buffer to draw light into and read it back from. */
export function target(gl: WebGL2RenderingContext): Target {
  return { texture: gl.createTexture()!, fbo: gl.createFramebuffer()! };
}

export function size(gl: WebGL2RenderingContext, t: Target, width: number, height: number) {
  gl.bindTexture(gl.TEXTURE_2D, t.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
}

/** The walls (u_segs), the buckets (u_cells, w × h) and their lists (u_list), as textures for the screen pass. */
export type WallTextures = [WebGLTexture, WebGLTexture, WebGLTexture];

export function wallTextures(gl: WebGL2RenderingContext, segs: Float32Array, cells: Int32Array, w: number, h: number, list: Int32Array): WallTextures {
  const rows = (n: number) => Math.max(1, Math.ceil(n / ROW));
  // Whole rows of `per` numbers to an item.
  const padded = <T extends Float32Array | Int32Array>(a: T, per: number): T => {
    const out = new (a.constructor as new (n: number) => T)(rows(a.length / per) * ROW * per);
    out.set(a);
    return out;
  };
  const texture = (internal: number, width: number, height: number, format: number, type: number, data: ArrayBufferView) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  };
  return [
    texture(gl.RGBA32F, ROW, rows(segs.length / 4), gl.RGBA, gl.FLOAT, padded(segs, 4)),
    texture(gl.RG32I, w, h, gl.RG_INTEGER, gl.INT, cells),
    texture(gl.R32I, ROW, rows(list.length), gl.RED_INTEGER, gl.INT, padded(list, 1)),
  ];
}

export function drop(gl: WebGL2RenderingContext, t: Target) {
  gl.deleteTexture(t.texture);
  gl.deleteFramebuffer(t.fbo);
}
