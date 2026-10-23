// Relighting: a pixel of the room is every map at that pixel, each times how
// strongly its bulb channel is on now, added up in linear light, then put
// through the camera's own tone curves (look.json) for the screen. Only the
// maps with any light in them are read, so the work is how many channels are
// on times the pixels drawn.

import { keepingFor, type Keeping } from "./encode.ts";
import type { Basis } from "./basis.ts";

/** The camera's look: its color matrix (ProPhoto to linear sRGB) and a tone curve per channel over log2 radiance. */
export interface Look {
  matrix_PP_to_linsRGB: number[][];
  curves: number[][];
}

// WebGPU's usage flags (the browser's own), which TypeScript's DOM types don't have yet.
declare const GPUBufferUsage: { readonly COPY_DST: number; readonly UNIFORM: number; readonly STORAGE: number };

const CURVE_POINTS = 96;
const MAX_MAPS = 2048;

const sumWGSL = (m: number[][]) => /* wgsl */ `
struct U { gain: f32, n: u32, gamma: f32, pad: f32 };
@group(0) @binding(0) var maps: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read> on: array<vec2f>;  // weight × peak, layer
@group(0) @binding(2) var<storage, read> curve: array<f32>;
@group(0) @binding(3) var<uniform> u: U;
const M = mat3x3f(
  ${m[0]![0]}, ${m[1]![0]}, ${m[2]![0]},
  ${m[0]![1]}, ${m[1]![1]}, ${m[2]![1]},
  ${m[0]![2]}, ${m[1]![2]}, ${m[2]![2]});
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var q = array(vec2f(-1, -3), vec2f(-1, 1), vec2f(3, 1));
  return vec4f(q[i], 0, 1);
}
fn curveAt(ch: i32, x: f32) -> f32 {
  let lx = clamp(log2(max(x, 1e-9)), -14.0, 4.0);
  let t = (lx + 14.0) / 18.0 * ${CURVE_POINTS}.0 - 0.5;
  let i0 = clamp(i32(floor(t)), 0, ${CURVE_POINTS - 2});
  let f = clamp(t - f32(i0), 0.0, 1.0);
  return mix(curve[ch * ${CURVE_POINTS} + i0], curve[ch * ${CURVE_POINTS} + i0 + 1], f);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let xy = vec2i(p.xy);
  var acc = vec3f(0.0);
  for (var i = 0u; i < u.n; i++) {
    let a = on[i];
    acc += a.x * pow(max(textureLoad(maps, xy, i32(a.y), 0).rgb, vec3f(0.0)), vec3f(u.gamma));
  }
  let lin = M * (acc * u.gain);
  return vec4f(curveAt(0, lin.r), curveAt(1, lin.g), curveAt(2, lin.b), 1.0);
}`;

export class Relighter {
  readonly device: GPUDevice;
  readonly keeping: Keeping;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly pipeline: GPURenderPipeline;
  private readonly on: GPUBuffer;
  private readonly uniforms: GPUBuffer;
  private readonly curves: GPUBuffer;
  private readonly binds = new WeakMap<Basis, GPUBindGroup>();
  private readonly list = new Float32Array(MAX_MAPS * 2);
  private configured = false;

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, look: Look) {
    this.device = device;
    this.canvas = canvas;
    this.keeping = keepingFor(device.features);
    this.context = canvas.getContext("webgpu") as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    const module = device.createShaderModule({ code: sumWGSL(look.matrix_PP_to_linsRGB) });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
    this.on = device.createBuffer({ size: MAX_MAPS * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.curves = device.createBuffer({ size: 3 * CURVE_POINTS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.curves, 0, new Float32Array(look.curves.flat()));
  }

  /** A relighter drawing into this canvas, or why there can't be one here. */
  static async create(canvas: HTMLCanvasElement, look: Look): Promise<Relighter | string> {
    if (!("gpu" in navigator) || !navigator.gpu) return "Streetview needs WebGPU, which this browser doesn't have.";
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return "Streetview needs WebGPU, which this device can't run.";
    const want = (["texture-compression-bc", "texture-compression-astc"] as const).filter((f) => adapter.features.has(f));
    const device = await adapter.requestDevice({
      requiredFeatures: want,
      requiredLimits: { maxTextureArrayLayers: Math.min(adapter.limits.maxTextureArrayLayers, MAX_MAPS) },
    });
    return new Relighter(device, canvas, look);
  }

  get maxSide(): number {
    return this.device.limits.maxTextureDimension2D;
  }

  /** Draw the room from a basis, each map weighted (maps not named are off), `ev` stops brighter. */
  draw(basis: Basis, weights: Map<string, number>, gamma: number, ev: number) {
    let n = 0;
    for (const [name, w] of weights) {
      const m = basis.layers.get(name);
      if (!m || !(w > 0)) continue;
      this.list[n * 2] = w * m.scale;
      this.list[n * 2 + 1] = m.layer;
      n++;
    }
    const d = this.device;
    d.queue.writeBuffer(this.on, 0, this.list, 0, Math.max(2, n * 2));
    const u = new ArrayBuffer(16);
    const v = new DataView(u);
    v.setFloat32(0, 2 ** ev, true);
    v.setUint32(4, n, true);
    v.setFloat32(8, gamma, true);
    d.queue.writeBuffer(this.uniforms, 0, u);

    // Drawn at the basis's own size, a map's pixel to a pixel; the page scales the canvas.
    if (!this.configured || this.canvas.width !== basis.width || this.canvas.height !== basis.height) {
      this.canvas.width = basis.width;
      this.canvas.height = basis.height;
      this.context.configure({ device: d, format: this.format, alphaMode: "opaque" });
      this.configured = true;
    }
    let bind = this.binds.get(basis);
    if (!bind) {
      bind = d.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: basis.texture.createView({ dimension: "2d-array" }) },
          { binding: 1, resource: { buffer: this.on } },
          { binding: 2, resource: { buffer: this.curves } },
          { binding: 3, resource: { buffer: this.uniforms } },
        ],
      });
      this.binds.set(basis, bind);
    }
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  destroy() {
    this.on.destroy();
    this.uniforms.destroy();
    this.curves.destroy();
    this.device.destroy();
  }
}
