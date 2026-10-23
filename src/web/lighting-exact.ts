// The light on the floor (lighting.ts), worked out a pixel at a time. Each
// pixel adds up the lights that reach it, from the lists pools.ts makes, and
// is written once: nothing is drawn light by light and blended, so the work
// is the same however many lights change at once. Shadows are exact at any
// zoom: wherever the edge of a light's fan crosses a pixel's square, the
// pixel tests which side of it it's on.
//
// The bounce is lighting.ts's, on its 10 cm grid, the direct light at each
// of the grid's cells worked out the same way as at each pixel.

import type { Gamut } from "../shared/lemtone.ts";
import {
  BOUNCE,
  CLEARANCE_MM,
  drop,
  EXPOSURE,
  FULL_VS,
  MOUNT_MM,
  program,
  REACH_MM,
  ROW,
  same,
  size,
  SPREAD_FS,
  STRIDES,
  target,
  wallsOf,
  wallTextures,
  type Box,
  type Renderer,
  type Source,
  type Target,
  type Uniforms,
  type WallTextures,
} from "./lighting.ts";
import { BINS, poolsOf } from "./pools.ts";
import type { Grid, Segment } from "./shadows.ts";
import type { View } from "./viewport.ts";

// Illuminance at `mm` from every light that reaches it, as lighting.ts's
// LIGHT_FS works it out for one. sees() is pools.ts's.
const DIRECT = `
precision highp float;
precision highp int;
precision highp isampler2D;
uniform isampler2D u_poolCells; // each square: where its lights start in u_poolList, and how many
uniform isampler2D u_poolList;  // each light × 2, plus 1 if it lights only some of the square
uniform vec3 u_pools;           // the squares: x, y, size (mm)
uniform ivec2 u_poolCount;
uniform sampler2D u_lights;     // each light: x, y (mm), 1 if bare
uniform sampler2D u_flux;       // each light: lumens, as linear RGB
uniform sampler2D u_edges;      // each fan's edges: x1, y1, x2, y2 from its light (mm)
uniform isampler2D u_bins;      // a row for each light: each bin's first edge in u_binList, and how many
uniform isampler2D u_binList;
uniform float u_height; // m
uniform float u_reach;  // m
ivec2 at(int n) {
  return ivec2(n % ${ROW}, n / ${ROW});
}
float diamond(vec2 d) {
  if (d.y >= 0.0) return d.x >= 0.0 ? (d.x + d.y > 0.0 ? d.y / (d.x + d.y) : 0.0) : 1.0 - d.x / (d.y - d.x);
  return d.x < 0.0 ? 2.0 - d.y / (-d.x - d.y) : 3.0 + d.x / (d.x - d.y);
}
float cross2(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}
bool sees(int n, vec2 d) {
  int bin = clamp(int(floor(diamond(d) * ${BINS}.0 / 4.0)), 0, ${BINS - 1});
  ivec2 run = texelFetch(u_bins, ivec2(bin, n), 0).xy;
  for (int j = 0; j < 4096; j++) {
    if (j >= run.y) break;
    vec4 e = texelFetch(u_edges, at(texelFetch(u_binList, at(run.x + j), 0).x), 0);
    if (cross2(e.xy, d) >= 0.0 && cross2(d, e.zw) >= 0.0) return cross2(e.zw - e.xy, d - e.xy) * cross2(e.xy, e.zw) >= 0.0;
  }
  return true;
}
vec3 direct(vec2 mm) {
  ivec2 sq = ivec2(floor((mm - u_pools.xy) / u_pools.z));
  if (any(lessThan(sq, ivec2(0))) || any(greaterThanEqual(sq, u_poolCount))) return vec3(0.0);
  ivec2 run = texelFetch(u_poolCells, sq, 0).xy;
  float h2 = u_height * u_height;
  float reach2 = u_reach * u_reach;
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 4096; k++) {
    if (k >= run.y) break;
    int entry = texelFetch(u_poolList, at(run.x + k), 0).x;
    int n = entry >> 1;
    vec3 flux = texelFetch(u_flux, at(n), 0).rgb;
    if (flux == vec3(0.0)) continue;
    vec4 light = texelFetch(u_lights, at(n), 0);
    vec2 d = mm - light.xy;
    if ((entry & 1) == 1 && !sees(n, d)) continue;
    vec2 m = d / 1000.0;
    float r2 = dot(m, m);
    float c2 = h2 / (r2 + h2);
    float e = mix(c2 * c2 / 3.14159265, c2 * sqrt(c2) / 12.5663706, light.z) / h2;
    float fade = max(0.0, 1.0 - r2 / reach2);
    sum += flux * e * fade * fade;
  }
  return sum;
}`;

const POOL_UNIFORMS = ["u_poolCells", "u_poolList", "u_pools", "u_poolCount", "u_lights", "u_flux", "u_edges", "u_bins", "u_binList", "u_height", "u_reach"];

// The direct light at each cell of the bounce grid (rows from y = 0 up, as in lighting.ts).
const CELLS_FS = `#version 300 es
${DIRECT}
uniform vec3 u_cellAt; // the grid: x, y, cell (mm)
out vec4 color;
void main() {
  color = vec4(direct(u_cellAt.xy + gl_FragCoord.xy * u_cellAt.z), 1.0);
}`;

// lighting.ts's SCREEN_FS, with the direct light worked out here rather than read back.
const SCREEN_FS = `#version 300 es
${DIRECT}
in vec2 v_uv;
uniform sampler2D u_bounce;
uniform vec3 u_view;
uniform vec2 u_size;
uniform vec4 u_grid; // x, y, width, height in mm
uniform sampler2D u_segs;
uniform isampler2D u_cells;
uniform isampler2D u_list;
uniform vec3 u_buckets;
uniform ivec2 u_bucketCount;
uniform float u_clearance;
uniform float u_gain;
uniform float u_exposure;
out vec4 color;
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
  vec3 lit = direct(mm);
  vec2 g = (clear(clear(mm)) - u_grid.xy) / u_grid.zw;
  vec3 bounce = g == clamp(g, 0.0, 1.0) ? texture(u_bounce, g).rgb : vec3(0.0);
  vec3 c = 1.0 - exp(-(lit + u_gain * bounce) * u_exposure);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color = vec4(encode(c) + (noise - 0.5) / 255.0, 1.0);
}`;

/** pools.ts's lists, and each light's place and light, on the GPU. */
interface PoolTextures {
  grid: Grid;
  count: number;
  cells: WebGLTexture;
  list: WebGLTexture;
  lights: WebGLTexture;
  flux: WebGLTexture;
  edges: WebGLTexture;
  bins: WebGLTexture;
  binList: WebGLTexture;
}

export class ExactLighting implements Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly cells: { program: WebGLProgram; u: Uniforms };
  private readonly spreader: { program: WebGLProgram; u: Uniforms };
  private readonly screen: { program: WebGLProgram; u: Uniforms };
  private readonly noWalls: WallTextures;
  /** Bounce where there's no floor: none. */
  private readonly dark: WebGLTexture;
  private pools: PoolTextures | null = null;
  private fluxData = new Float32Array(0);
  private floor: { grid: Grid; reach: WebGLTexture; buckets: Grid; walls: WallTextures; targets: [Target, Target]; result: number } | null = null;
  private fluxFor: Float32Array | null = null;
  lost = false;

  /** A renderer for this canvas, or null where WebGL 2 or float buffers aren't there (the map falls back to drawn glows). */
  static create(canvas: HTMLCanvasElement): ExactLighting | null {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl || !(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"))) return null;
    try {
      return new ExactLighting(canvas, gl);
    } catch (err) {
      console.warn("no simulated light:", err);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", () => (this.lost = true));
    this.cells = program(gl, FULL_VS, CELLS_FS, [...POOL_UNIFORMS, "u_cellAt"]);
    this.spreader = program(gl, FULL_VS, SPREAD_FS, ["u_light", "u_reach", "u_step"]);
    this.screen = program(gl, FULL_VS, SCREEN_FS, [
      ...POOL_UNIFORMS,
      "u_bounce",
      "u_segs",
      "u_cells",
      "u_list",
      "u_view",
      "u_size",
      "u_grid",
      "u_buckets",
      "u_bucketCount",
      "u_clearance",
      "u_gain",
      "u_exposure",
    ]);
    this.noWalls = wallTextures(gl, new Float32Array(4), new Int32Array(2), 1, 1, new Int32Array(1));
    this.dark = texture(gl, gl.RGBA16F, 1, 1, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(4));
    this.setSources([]);
  }

  /** The floor's walls and extent, for the bounce. */
  setFloor(walls: Segment[], box: Box) {
    const gl = this.gl;
    this.dropFloor();
    const data = wallsOf(walls, box);
    const { grid, buckets } = data;
    const reach = texture(gl, gl.RGBA8, grid.width, grid.height, gl.RGBA, gl.UNSIGNED_BYTE, data.reach);
    const targets: [Target, Target] = [target(gl), target(gl)];
    for (const t of targets) size(gl, t, grid.width, grid.height);
    const textures = wallTextures(gl, data.segs, data.cells, buckets.width, buckets.height, data.list);
    this.floor = { grid, reach, buckets, walls: textures, targets, result: 0 };
    this.fluxFor = null;
  }

  /** Where the lights are and what each can see. Only called when that changes. */
  setSources(sources: Source[]) {
    const gl = this.gl;
    this.dropPools();
    const p = poolsOf(sources);
    const places = new Float32Array(sources.length * 4);
    sources.forEach((s, n) => places.set([s.x, s.y, s.bare ? 1 : 0, 0], n * 4));
    this.fluxData = new Float32Array(rowsOf(sources.length) * ROW * 4);
    this.pools = {
      grid: p.grid,
      count: sources.length,
      cells: texture(gl, gl.RG32I, p.grid.width, p.grid.height, gl.RG_INTEGER, gl.INT, p.cells),
      list: listTexture(gl, gl.R32I, gl.RED_INTEGER, gl.INT, p.list, 1),
      lights: listTexture(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT, places, 4),
      flux: listTexture(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT, this.fluxData, 4),
      edges: listTexture(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT, p.edges, 4),
      bins: texture(gl, gl.RG32I, BINS, Math.max(1, sources.length), gl.RG_INTEGER, gl.INT, sources.length > 0 ? p.bins : new Int32Array(BINS * 2)),
      binList: listTexture(gl, gl.R32I, gl.RED_INTEGER, gl.INT, p.binList, 1),
    };
    this.fluxFor = null;
  }

  /**
   * Draw the floor's light for this view (`width` × `height` CSS pixels).
   * `flux` is each source's light in lumens as linear RGB in `gamut`, three
   * per source, in the order setSources had them.
   */
  render(view: View, width: number, height: number, flux: Float32Array, gamut: Gamut) {
    const gl = this.gl;
    if (this.lost) return;
    // As in lighting.ts: changing it clears the drawing buffer, so only when it changes.
    if ("drawingBufferColorSpace" in gl && gl.drawingBufferColorSpace !== gamut) gl.drawingBufferColorSpace = gamut;
    if (!(this.fluxFor && same(this.fluxFor, flux))) {
      this.setFlux(flux);
      if (this.floor) this.spread();
      this.fluxFor = flux.slice();
    }

    const s = this.screen.u;
    const f = this.floor;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.screen.program);
    const walls = f ? f.walls : this.noWalls;
    [f ? f.targets[f.result].texture : this.dark, ...walls].forEach((t, k) => {
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    gl.uniform1i(s.u_bounce!, 0);
    gl.uniform1i(s.u_segs!, 1);
    gl.uniform1i(s.u_cells!, 2);
    gl.uniform1i(s.u_list!, 3);
    this.bindPools(s, 4);
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

  /** Each light's light, three per source, into its texture. */
  private setFlux(flux: Float32Array) {
    const gl = this.gl;
    const p = this.pools!;
    for (let n = 0; n < p.count; n++) this.fluxData.set([flux[n * 3] ?? 0, flux[n * 3 + 1] ?? 0, flux[n * 3 + 2] ?? 0], n * 4);
    gl.bindTexture(gl.TEXTURE_2D, p.flux);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROW, rowsOf(p.count), gl.RGBA, gl.FLOAT, this.fluxData);
  }

  /** Work out the bounce, as lighting.ts does: the direct light on the grid, spread round the floor without crossing walls. */
  private spread() {
    const gl = this.gl;
    const f = this.floor!;
    const { x, y, cell, width, height } = f.grid;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.targets[0].fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.cells.program);
    this.bindPools(this.cells.u, 0);
    gl.uniform3f(this.cells.u.u_cellAt!, x, y, cell);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

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

  /** The lists and lights for a program that works out direct(), on texture units from `first`. */
  private bindPools(u: Uniforms, first: number) {
    const gl = this.gl;
    const p = this.pools!;
    const textures = [p.cells, p.list, p.lights, p.flux, p.edges, p.bins, p.binList];
    ["u_poolCells", "u_poolList", "u_lights", "u_flux", "u_edges", "u_bins", "u_binList"].forEach((name, k) => {
      gl.activeTexture(gl.TEXTURE0 + first + k);
      gl.bindTexture(gl.TEXTURE_2D, textures[k]!);
      gl.uniform1i(u[name]!, first + k);
    });
    gl.uniform3f(u.u_pools!, p.grid.x, p.grid.y, p.grid.cell);
    gl.uniform2i(u.u_poolCount!, p.grid.width, p.grid.height);
    gl.uniform1f(u.u_height!, MOUNT_MM / 1000);
    gl.uniform1f(u.u_reach!, REACH_MM / 1000);
  }

  private dropPools() {
    const p = this.pools;
    if (!p) return;
    for (const t of [p.cells, p.list, p.lights, p.flux, p.edges, p.bins, p.binList]) this.gl.deleteTexture(t);
    this.pools = null;
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
    this.dropPools();
    for (const t of [...this.noWalls, this.dark]) gl.deleteTexture(t);
    for (const p of [this.cells, this.spreader, this.screen]) gl.deleteProgram(p.program);
  }
}

/** Rows of ROW items needed for `n` items (at least one). */
const rowsOf = (n: number) => Math.max(1, Math.ceil(n / ROW));

/** A texture read with texelFetch (never filtered). */
function texture(gl: WebGL2RenderingContext, internal: number, width: number, height: number, format: number, type: number, data: ArrayBufferView): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}

/** A list of items, `per` numbers each, as rows of ROW items (read with at() in DIRECT). */
function listTexture(gl: WebGL2RenderingContext, internal: number, format: number, type: number, data: Float32Array | Int32Array, per: number): WebGLTexture {
  const rows = rowsOf(data.length / per);
  const padded = new (data.constructor as new (n: number) => Float32Array | Int32Array)(rows * ROW * per);
  padded.set(data);
  return texture(gl, internal, ROW, rows, format, type, padded);
}
