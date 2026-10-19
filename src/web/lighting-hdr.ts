// The light on the floor (lighting.ts) on WebGPU, for screens that show HDR.
// The simulation is the same, pass for pass; what changes is the end.
// lighting.ts rolls the light off just under white, as WebGL has to; here
// the same curve rolls off at PEAK times white instead, so bright pools glow
// past the page's white the way the lights do past a white wall. Dim light
// looks as it does there: the two curves start out the same.
//
// The canvas is opaque. lighting.ts screens its light over the floor, but
// browsers aren't held to keeping what's past white through a blend, so this
// paints the floor under the light itself, in the canvas's CSS background
// color.
//
// Browsers draw past white with WebGPU's "extended" tone mapping (Chrome and
// Edge, for now). Where it isn't there, create() gives null and the map
// uses lighting.ts.

import { fromSrgb, type Gamut, type Vec3 } from "../shared/lemtone.ts";
import { BOUNCE, CLEARANCE_MM, EXPOSURE, MOUNT_MM, REACH_MM, STRIDES, wallsOf, type Box, type Renderer, type Source, type Walls } from "./lighting.ts";
import type { Segment } from "./shadows.ts";
import type { View } from "./viewport.ts";

// WebGPU's usage flags (the browser's own), which TypeScript's DOM types don't have yet.
declare const GPUBufferUsage: { readonly COPY_DST: number; readonly INDEX: number; readonly VERTEX: number; readonly UNIFORM: number; readonly STORAGE: number };
declare const GPUTextureUsage: { readonly COPY_DST: number; readonly TEXTURE_BINDING: number; readonly RENDER_ATTACHMENT: number };

// How far past white the brightest light goes, as a multiple of it. Screens
// show from about 2× (an HDR monitor with SDR set bright) to 16× (a MacBook
// Pro's, dimmed), and the light clips at whatever this one shows; browsers
// don't say which, so this aims low.
const PEAK = 3;

// Every pixel, from one triangle over the whole target.
const FULL = /* wgsl */ `
@vertex fn full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(select(-1.0, 3.0, i == 1u), select(-1.0, 3.0, i == 2u), 0.0, 1.0);
}`;

// Each light's pool, as lighting.ts's LIGHT_FS works it out, drawn over the
// part of the floor it can see (its fan, as triangles). Target rows go from
// the top, so on the bounce grid row 0 is y = 0, as in lighting.ts.
const LIGHT = /* wgsl */ `
struct Place {
  view: vec4f, // px per mm, offset x, offset y
  size: vec2f, // px
  height: f32, // m
  reach: f32,  // m
}
struct Light {
  at: vec2f,   // mm
  bare: f32,
  flux: vec3f, // lumens, as linear RGB
}
@group(0) @binding(0) var<uniform> u: Place;
@group(0) @binding(1) var<storage, read> lights: array<Light>;

struct Corner {
  @builtin(position) position: vec4f,
  @location(0) mm: vec2f,
  @location(1) @interpolate(flat) light: u32,
}

@vertex fn vs(@location(0) mm: vec2f, @location(1) light: u32) -> Corner {
  var c: Corner;
  let px = u.view.yz + mm * u.view.x;
  c.position = vec4f(px.x / u.size.x * 2.0 - 1.0, 1.0 - px.y / u.size.y * 2.0, 0.0, 1.0);
  // A light that's off draws nothing: its fan folds up off the target.
  let f = lights[light].flux;
  if (f.r + f.g + f.b <= 0.0) {
    c.position = vec4f(2.0, 2.0, 0.0, 1.0);
  }
  c.mm = mm;
  c.light = light;
  return c;
}

@fragment fn fs(c: Corner) -> @location(0) vec4f {
  let l = lights[c.light];
  let d = (c.mm - l.at) / 1000.0;
  let r2 = dot(d, d);
  let h2 = u.height * u.height;
  let c2 = h2 / (r2 + h2);
  let e = mix(c2 * c2 / 3.14159265, c2 * sqrt(c2) / 12.5663706, l.bare) / h2;
  let fade = max(0.0, 1.0 - r2 / (u.reach * u.reach));
  return vec4f(l.flux * e * fade * fade, 1.0);
}`;

// One pass of spreading the bounce, as lighting.ts's SPREAD_FS.
const SPREAD = /* wgsl */ `
@group(0) @binding(0) var light: texture_2d<f32>;
@group(0) @binding(1) var reach: texture_2d<u32>;
@group(0) @binding(2) var<uniform> stride: vec4i; // x, y
${FULL}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = vec2i(p.xy);
  let r = vec4f(textureLoad(reach, c, 0));
  let s = stride.xy;
  let far = f32(s.x + s.y);
  let ahead = select(r.b, r.r, s.x > 0);
  let behind = select(r.a, r.g, s.x > 0);
  let here = textureLoad(light, c, 0).rgb;
  let next = select(here, textureLoad(light, c + s, 0).rgb, ahead >= far);
  let prev = select(here, textureLoad(light, c - s, 0).rgb, behind >= far);
  return vec4f(0.5 * here + 0.25 * (next + prev), 1.0);
}`;

// The direct light plus the bounce under each pixel, as lighting.ts's
// SCREEN_FS, but rolled off at PEAK; then over the floor, as screen blending
// puts it there (past white, just the light).
const SCREEN = /* wgsl */ `
struct Screen {
  view: vec4f,    // px per mm, offset x, offset y
  size: vec2f,    // CSS px
  clearance: f32, // mm
  gain: f32,
  grid: vec4f,    // the bounce grid's x, y, width, height (mm)
  buckets: vec4f, // the wall buckets' x, y and size (mm)
  bucketCount: vec2i,
  exposure: f32,
  peak: f32,
  ground: vec4f,  // the floor, gamma-encoded in the canvas's gamut
}
@group(0) @binding(0) var<uniform> u: Screen;
@group(0) @binding(1) var direct: texture_2d<f32>;
@group(0) @binding(2) var bounce: texture_2d<f32>;
@group(0) @binding(3) var bilinear: sampler;
@group(0) @binding(4) var<storage, read> segs: array<vec4f>;  // each wall: x1, y1, x2, y2 (mm)
@group(0) @binding(5) var<storage, read> cells: array<vec2i>; // each bucket: where its walls start in list, and how many
@group(0) @binding(6) var<storage, read> list: array<i32>;
${FULL}
// p moved to the clearance from the nearest wall, straight away from it.
fn clear(p: vec2f) -> vec2f {
  if (u.bucketCount.x == 0) {
    return p;
  }
  let b = vec2i(floor((p - u.buckets.xy) / u.buckets.z));
  if (any(b < vec2i(0)) || any(b >= u.bucketCount)) {
    return p;
  }
  let near = cells[b.y * u.bucketCount.x + b.x];
  var nearest = u.clearance;
  var away = vec2f(0.0);
  for (var k = 0; k < min(near.y, 256); k++) {
    let s = segs[list[near.x + k]];
    let d = s.zw - s.xy;
    let v = p - (s.xy + clamp(dot(p - s.xy, d) / max(dot(d, d), 1e-6), 0.0, 1.0) * d);
    let dist = length(v);
    if (dist < nearest) {
      nearest = dist;
      away = select(vec2f(0.0), v / dist, dist > 1e-3);
    }
  }
  return p + away * (u.clearance - nearest);
}
// sRGB's curve (Display P3 uses the same one), carried on past 1 as CSS
// carries it, which is how the browser reads it back.
fn encode(c: vec3f) -> vec3f {
  let a = abs(c);
  return sign(c) * select(1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, a * 12.92, a <= vec3f(0.0031308));
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let at = p.xy / vec2f(textureDimensions(direct));
  // Twice, for corners: straight away from one wall can be toward another.
  let mm = clear(clear((at * u.size - u.view.yz) / u.view.x));
  let g = (mm - u.grid.xy) / u.grid.zw;
  var bounced = vec3f(0.0);
  if (u.gain > 0.0 && all(g == clamp(g, vec2f(0.0), vec2f(1.0)))) {
    bounced = textureSampleLevel(bounce, bilinear, g, 0.0).rgb;
  }
  let x = (textureLoad(direct, vec2i(p.xy), 0).rgb + u.gain * bounced) * u.exposure;
  let lit = encode(u.peak * (1.0 - exp(-x / u.peak)));
  let shown = lit + u.ground.rgb * max(vec3f(0.0), 1.0 - lit);
  let noise = fract(52.9829189 * fract(dot(p.xy, vec2f(0.06711056, 0.00583715))));
  return vec4f(max(vec3f(0.0), shown + (noise - 0.5) / 255.0), 1.0);
}`;

// Each light, as LIGHT's Light: x, y, bare, (pad), then its flux r, g, b, (pad).
const PER_LIGHT = 8;

/** The bounce grid for a floor: what stops light, two textures to spread it between, and the walls. */
interface Floor {
  walls: Walls;
  reach: GPUTexture;
  targets: [GPUTexture, GPUTexture];
  /** Each spreading pass's bindings, and which target the last one leaves the bounce in. */
  passes: GPUBindGroup[];
  result: number;
  /** The walls, each bucket's, and their list, for the screen pass. */
  buffers: GPUBuffer[];
}

export class HdrLighting implements Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private gamut: Gamut;
  private readonly lightPipeline: GPURenderPipeline;
  private readonly spreadPipeline: GPURenderPipeline;
  private readonly screenPipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  // Where the light pass draws: on the screen, and on the bounce grid.
  private readonly screenPlace: GPUBuffer;
  private readonly gridPlace: GPUBuffer;
  private readonly screenUniforms: GPUBuffer;
  // Each spreading pass's step, as STRIDES has them, across then down.
  private readonly strides: GPUBuffer[];
  // The lights (as PER_LIGHT), their fans as triangles, and the light pass's bindings for each place.
  private lights: Float32Array = new Float32Array(PER_LIGHT);
  private lightBuffer: GPUBuffer;
  private vertices: GPUBuffer | null = null;
  private indices: GPUBuffer | null = null;
  private indexCount = 0;
  private lightGroups: [GPUBindGroup, GPUBindGroup];
  private direct: GPUTexture | null = null;
  private floor: Floor | null = null;
  // Stand-ins while there's no floor, so every binding has a buffer.
  private readonly noWalls: GPUBuffer[];
  private screenGroup: { group: GPUBindGroup; direct: GPUTexture; floor: Floor | null } | null = null;
  // The light the bounce was last worked out for; null when it has to be again.
  private spreadFor: Float32Array | null = null;
  // The floor's color as CSS has it, and as the shader takes it.
  private ground = { css: "", gamut: "srgb" as Gamut, rgb: [0, 0, 0] as Vec3 };
  lost = false;

  /** A renderer for this canvas, or null where the browser can't draw past white on one. */
  static async create(canvas: HTMLCanvasElement, gamut: Gamut): Promise<HdrLighting | null> {
    if (!("gpu" in navigator)) return null;
    let device: GPUDevice | null = null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
      const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
      if (!context) throw new Error("no WebGPU context");
      device.pushErrorScope("validation");
      const lighting = new HdrLighting(canvas, device, context, gamut);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      // A browser that doesn't know tone mapping leaves it out of what it was configured with.
      if (context.getConfiguration?.()?.toneMapping?.mode !== "extended") {
        lighting.dispose();
        return null;
      }
      return lighting;
    } catch (err) {
      console.warn("no HDR light:", err);
      device?.destroy();
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, context: GPUCanvasContext, gamut: Gamut) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.gamut = gamut;
    void device.lost.then(() => (this.lost = true));
    this.configure();

    const light = device.createShaderModule({ code: LIGHT });
    this.lightPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: light,
        entryPoint: "vs",
        // Each corner: where it is (mm), and which light it's from.
        buffers: [
          {
            arrayStride: 12,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "uint32" },
            ],
          },
        ],
      },
      // Added up, as light does.
      fragment: { module: light, entryPoint: "fs", targets: [{ format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } } }] },
    });
    const spread = device.createShaderModule({ code: SPREAD });
    this.spreadPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: spread, entryPoint: "full" },
      fragment: { module: spread, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    });
    const screen = device.createShaderModule({ code: SCREEN });
    this.screenPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: screen, entryPoint: "full" },
      fragment: { module: screen, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

    const uniform = (size: number) => device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.screenPlace = uniform(32);
    this.gridPlace = uniform(32);
    this.screenUniforms = uniform(96);
    this.strides = STRIDES.flatMap((s) => [
      [s, 0],
      [0, s],
    ]).map((step) => {
      const b = uniform(16);
      device.queue.writeBuffer(b, 0, new Int32Array([...step, 0, 0]));
      return b;
    });
    this.lightBuffer = this.storage(this.lights);
    this.lightGroups = this.placeGroups();
    this.noWalls = [this.storage(new Float32Array(4)), this.storage(new Int32Array(2)), this.storage(new Int32Array(1))];
  }

  // A canvas has one WebGPU context, whoever asks for it, so another renderer
  // on this canvas (React makes and drops one in development) may have
  // configured it since: whoever draws configures it for itself.
  private configure() {
    const now = this.context.getConfiguration();
    if (now?.device === this.device && now.colorSpace === this.gamut) return;
    this.context.configure({ device: this.device, format: "rgba16float", colorSpace: this.gamut, toneMapping: { mode: "extended" }, alphaMode: "opaque" });
  }

  /** The floor's walls and extent, for the bounce. */
  setFloor(walls: Segment[], box: Box) {
    const device = this.device;
    this.dropFloor();
    const w = wallsOf(walls, box);
    const { grid } = w;
    const reach = device.createTexture({ size: [grid.width, grid.height], format: "rgba8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: reach }, w.reach, { bytesPerRow: grid.width * 4 }, [grid.width, grid.height]);
    const targets: [GPUTexture, GPUTexture] = [this.target(grid.width, grid.height), this.target(grid.width, grid.height)];
    // Each pass reads one target and draws into the other, in turn.
    const passes = this.strides.map((stride, n) =>
      device.createBindGroup({
        layout: this.spreadPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: targets[n % 2]!.createView() },
          { binding: 1, resource: reach.createView() },
          { binding: 2, resource: { buffer: stride } },
        ],
      }),
    );
    device.queue.writeBuffer(this.gridPlace, 0, new Float32Array([1 / grid.cell, -grid.x / grid.cell, -grid.y / grid.cell, 0, grid.width, grid.height, MOUNT_MM / 1000, REACH_MM / 1000]));
    const buffers = [this.storage(w.segs), this.storage(w.cells), this.storage(w.list)];
    this.floor = { walls: w, reach, targets, passes, buffers, result: passes.length % 2 };
    this.spreadFor = null;
  }

  /** Where the lights are and what each can see. Only called when that changes. */
  setSources(sources: Source[]) {
    const device = this.device;
    const corners = sources.reduce((n, s) => n + s.fan.length / 2, 0);
    const vertices = new ArrayBuffer(Math.max(1, corners) * 12);
    const mm = new Float32Array(vertices);
    const which = new Uint32Array(vertices);
    const indices: number[] = [];
    this.lights = new Float32Array(Math.max(1, sources.length) * PER_LIGHT);
    let at = 0;
    sources.forEach((s, i) => {
      const n = s.fan.length / 2;
      for (let k = 0; k < n; k++) {
        mm[(at + k) * 3] = s.fan[k * 2]!;
        mm[(at + k) * 3 + 1] = s.fan[k * 2 + 1]!;
        which[(at + k) * 3 + 2] = i;
      }
      // WebGPU has no fans: each is triangles from its first corner.
      for (let k = 1; k < n - 1; k++) indices.push(at, at + k, at + k + 1);
      this.lights.set([s.x, s.y, s.bare ? 1 : 0], i * PER_LIGHT);
      at += n;
    });
    this.vertices?.destroy();
    this.indices?.destroy();
    this.vertices = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertices, 0, vertices);
    const index = new Uint32Array(Math.max(1, indices.length));
    index.set(indices);
    this.indices = device.createBuffer({ size: index.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indices, 0, index);
    this.indexCount = indices.length;
    this.lightBuffer.destroy();
    this.lightBuffer = this.storage(this.lights);
    this.lightGroups = this.placeGroups();
    this.spreadFor = null;
  }

  /**
   * Draw the floor's light for this view (`width` × `height` CSS pixels).
   * `flux` is each source's light in lumens as linear RGB in `gamut`, three
   * per source, in the order setSources had them.
   */
  render(view: View, width: number, height: number, flux: Float32Array, gamut: Gamut) {
    if (this.lost) return;
    try {
      this.draw(view, width, height, flux, gamut);
    } catch (err) {
      // As if the context were lost: the map draws glows instead.
      console.warn("HDR light stopped:", err);
      this.lost = true;
    }
  }

  private draw(view: View, width: number, height: number, flux: Float32Array, gamut: Gamut) {
    const device = this.device;
    this.gamut = gamut;
    this.configure();
    const { width: w, height: h } = this.canvas;
    if (!this.direct || this.direct.width !== w || this.direct.height !== h) {
      this.direct?.destroy();
      this.direct = this.target(w, h);
    }
    for (let i = 0; i * 3 < flux.length; i++) this.lights.set(flux.subarray(i * 3, i * 3 + 3), i * PER_LIGHT + 4);
    device.queue.writeBuffer(this.lightBuffer, 0, this.lights);

    const encoder = device.createCommandEncoder();
    if (this.floor && !(this.spreadFor && same(this.spreadFor, flux))) {
      this.spread(encoder);
      this.spreadFor = flux.slice();
    }

    // The direct light, for this view.
    device.queue.writeBuffer(this.screenPlace, 0, new Float32Array([view.scale, view.ox, view.oy, 0, width, height, MOUNT_MM / 1000, REACH_MM / 1000]));
    this.drawLights(encoder, this.direct, this.lightGroups[0]);

    // Plus the bounce, over the floor, to the screen.
    const f = this.floor;
    const data = new ArrayBuffer(96);
    const floats = new Float32Array(data);
    const ints = new Int32Array(data);
    floats.set([view.scale, view.ox, view.oy, 0, width, height, CLEARANCE_MM, f ? BOUNCE : 0], 0);
    if (f) {
      const { grid, buckets } = f.walls;
      floats.set([grid.x, grid.y, grid.width * grid.cell, grid.height * grid.cell, buckets.x, buckets.y, buckets.cell, 0], 8);
      ints.set([buckets.width, buckets.height], 16);
    }
    floats.set([EXPOSURE, PEAK, ...this.groundIn(gamut), 0], 18);
    device.queue.writeBuffer(this.screenUniforms, 0, data);
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }] });
    pass.setPipeline(this.screenPipeline);
    pass.setBindGroup(0, this.screenBindings(this.direct));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Work out the bounce: the direct light on the grid, spread round the floor without crossing walls. */
  private spread(encoder: GPUCommandEncoder) {
    const f = this.floor!;
    this.drawLights(encoder, f.targets[0], this.lightGroups[1]);
    f.passes.forEach((group, n) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: f.targets[(n + 1) % 2]!.createView(), loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }] });
      pass.setPipeline(this.spreadPipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    });
  }

  /** Every light's pool, added up into `target`. */
  private drawLights(encoder: GPUCommandEncoder, target: GPUTexture, group: GPUBindGroup) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }] });
    if (this.indexCount && this.vertices && this.indices) {
      pass.setPipeline(this.lightPipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, this.vertices);
      pass.setIndexBuffer(this.indices, "uint32");
      pass.drawIndexed(this.indexCount);
    }
    pass.end();
  }

  /** The light pass's bindings, drawing on the screen and on the bounce grid. */
  private placeGroups(): [GPUBindGroup, GPUBindGroup] {
    const group = (place: GPUBuffer) =>
      this.device.createBindGroup({
        layout: this.lightPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: place } },
          { binding: 1, resource: { buffer: this.lightBuffer } },
        ],
      });
    return [group(this.screenPlace), group(this.gridPlace)];
  }

  /** The screen pass's bindings, made again when the direct light's target or the floor changes. */
  private screenBindings(direct: GPUTexture): GPUBindGroup {
    const f = this.floor;
    const s = this.screenGroup;
    if (s && s.direct === direct && s.floor === f) return s.group;
    const [segs, cells, list] = f ? f.buffers : this.noWalls;
    const group = this.device.createBindGroup({
      layout: this.screenPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.screenUniforms } },
        { binding: 1, resource: direct.createView() },
        { binding: 2, resource: (f ? f.targets[f.result] : direct).createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: segs! } },
        { binding: 5, resource: { buffer: cells! } },
        { binding: 6, resource: { buffer: list! } },
      ],
    });
    this.screenGroup = { group, direct, floor: f };
    return group;
  }

  /** The floor under the light (the canvas's CSS background), gamma-encoded in `gamut`. */
  private groundIn(gamut: Gamut): Vec3 {
    const css = getComputedStyle(this.canvas).backgroundColor;
    const g = this.ground;
    if (css !== g.css || gamut !== g.gamut) {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
      const srgb: Vec3 = m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] : [0, 0, 0];
      this.ground = { css, gamut, rgb: fromSrgb(srgb, gamut) };
    }
    return this.ground.rgb;
  }

  /** A float texture to draw light into and read it back from. */
  private target(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      size: [Math.max(1, width), Math.max(1, height)],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  /** A storage buffer holding `data` (at least one element's worth, as bindings need). */
  private storage(data: Float32Array | Int32Array): GPUBuffer {
    const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    if (data.byteLength) this.device.queue.writeBuffer(b, 0, data);
    return b;
  }

  private dropFloor() {
    const f = this.floor;
    if (!f) return;
    f.reach.destroy();
    for (const t of f.targets) t.destroy();
    for (const b of f.buffers) b.destroy();
    this.floor = null;
  }

  dispose() {
    // Everything it made goes with it. The context stays as it is: by now it may be another's.
    this.device.destroy();
  }
}

const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
