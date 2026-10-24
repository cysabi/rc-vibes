// A camera's photographs, as one map per bulb channel (plus the room with
// every bulb off), held on the GPU: the "basis" the room is relit from. They
// come as video, one stream per channel, each frame a map scaled to its own
// peak and gamma-coded; a device picks the sizes it can hold and a codec it
// decodes, and keeps them block-compressed (encode.ts).
//
// The video's colour has to arrive exactly. A browser's own conversion (a
// frame drawn or copied into a texture) rounds to 8 bits, and down: in the
// darks of each map, after the gamma, that's a cast (warm light goes green)
// and blotches. So where the decoder will hand over its planes (VideoFrame
// copyTo: always in software, and for 8-bit in hardware too) they're
// converted here, BT.709 full range, in float, straight into the block
// encoder. 10-bit AV1 is decoded in software for that (fast: about 250 maps
// a second at 4K on an M5 Pro); only frames that can't be read (a 10-bit
// hardware frame) go through the browser's conversion. Chrome's WebGPU
// copies from the frame itself; Firefox's only from an image (an ImageBitmap,
// an <img>, a canvas), so there the frame's made one first.

import { ENCODE_WGSL, KEEPING, type Keeping } from "./encode.ts";

// WebGPU's usage flags (the browser's own), which TypeScript's DOM types don't have yet.
declare const GPUBufferUsage: { readonly COPY_DST: number; readonly COPY_SRC: number; readonly UNIFORM: number; readonly STORAGE: number };
declare const GPUTextureUsage: {
  readonly COPY_DST: number;
  readonly COPY_SRC: number;
  readonly TEXTURE_BINDING: number;
  readonly STORAGE_BINDING: number;
  readonly RENDER_ATTACHMENT: number;
};

export interface Stream {
  file: string;
  /** The map each frame is, e.g. "b07-WW". */
  order: string[];
  packets: number[];
  keyframes: number[];
  /** Each map's peak: a frame's value v stands for scale · v^gamma. */
  scales: number[];
  bytes: number;
}

export interface Encoding {
  codec: "av1" | "hevc" | "h264";
  codec_string: string;
  crf: number;
  /** Bits per sample: 10 for AV1 and HEVC, 8 for H.264 (and builds from before 10-bit). */
  bits?: number;
  bytes: number;
  streams: Record<string, Stream>;
}

export interface Tier {
  width: number;
  height: number;
  encodings: Encoding[];
}

export interface Manifest {
  id: string;
  made: string;
  gamma: number;
  /** The bulb channels, e.g. R, G, B, CW, WW. */
  channels: string[];
  /** The map of the room with every bulb off. */
  ambient: string;
  tiers: Tier[];
}

export interface Basis {
  width: number;
  height: number;
  texture: GPUTexture;
  /** Each map's layer in the texture, and its peak. */
  layers: Map<string, { layer: number; scale: number }>;
  /** How many of its maps (of `maps`) went through the browser's own conversion, at 8 bits: their colour's only near. */
  copied: number;
  maps: number;
  destroy(): void;
}

const mapCount = (t: Tier) => Object.values(t.encodings[0]!.streams).reduce((n, s) => n + s.order.length, 0);

/** The GPU memory a tier takes, kept this way. */
export const bytesOf = (t: Tier, keeping: Keeping) => t.width * t.height * mapCount(t) * KEEPING[keeping].bytesPerPixel;

/**
 * The tier to show while the lights change, and the larger one to settle to
 * when they're still, if the device can hold both: a phone keeps to the
 * small ones, everything else goes as big as fits.
 */
export function pickTiers(m: Manifest, keeping: Keeping, small: boolean, maxSide: number): { live: Tier; settle: Tier | null } {
  // A phone holds 720p- and 1080p-class (0.9 GiB block-compressed); a computer 1080p- and 4K-class (3.5 GiB).
  const budget = small ? 2 ** 30 : keeping === "rgba8" ? 3 * 2 ** 30 : 4 * 2 ** 30;
  const tiers = m.tiers.filter((t) => t.width <= maxSide && t.height <= maxSide).sort((a, b) => a.width - b.width);
  if (tiers.length === 0) throw new Error("no size of these photographs fits this device");
  const liveMax = small ? 1100 : 2100;
  const fits = tiers.filter((t) => t.width <= liveMax && bytesOf(t, keeping) <= budget);
  const live = fits[fits.length - 1] ?? tiers[0]!;
  const bigger = tiers.find((t) => t.width > live.width);
  const settle = bigger && bytesOf(live, keeping) + bytesOf(bigger, keeping) <= budget ? bigger : null;
  return { live, settle };
}

async function supported(e: Encoding, t: Tier, hw: HardwareAcceleration): Promise<boolean> {
  try {
    const r = await VideoDecoder.isConfigSupported({ codec: e.codec_string, codedWidth: t.width, codedHeight: t.height, hardwareAcceleration: hw });
    return !!r.supported;
  } catch {
    return false;
  }
}

/**
 * AV1 (the smallest to send), then HEVC, then H.264. 10-bit AV1 is decoded
 * in software, where its planes can be read; anything else in hardware if it
 * can be, in software if not.
 */
export async function pickEncoding(t: Tier): Promise<{ encoding: Encoding; hw: HardwareAcceleration } | null> {
  const order = ["av1", "hevc", "h264"].map((c) => t.encodings.find((e) => e.codec === c)).filter((e): e is Encoding => !!e);
  for (const e of order) {
    const ways: HardwareAcceleration[] = e.codec === "av1" && (e.bits ?? 8) > 8 ? ["prefer-software", "prefer-hardware"] : ["prefer-hardware", "prefer-software"];
    for (const hw of ways) if (await supported(e, t, hw)) return { encoding: e, hw };
  }
  return null;
}

/** Decode one stream, handing each frame on in order; the frame is closed once its handling's done. */
function decode(
  e: Encoding,
  t: Tier,
  s: Stream,
  data: Uint8Array,
  hw: HardwareAcceleration,
  signal: AbortSignal,
  onFrame: (f: VideoFrame, i: number) => Promise<void>,
) {
  return new Promise<void>((resolve, reject) => {
    let chain = Promise.resolve();
    const dec = new VideoDecoder({
      output: (f) => {
        chain = chain.then(() => (signal.aborted ? undefined : onFrame(f, Number(f.timestamp) / 1000))).finally(() => f.close());
      },
      error: reject,
    });
    const stop = () => {
      if (dec.state !== "closed") dec.close();
      reject(new DOMException("stopped", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
    dec.configure({ codec: e.codec_string, codedWidth: t.width, codedHeight: t.height, hardwareAcceleration: hw });
    let at = 0;
    s.packets.forEach((len, i) => {
      dec.decode(new EncodedVideoChunk({ type: s.keyframes[i] ? "key" : "delta", timestamp: i * 1000, data: data.subarray(at, at + len) }));
      at += len;
    });
    dec.flush().then(
      () =>
        chain.then(() => {
          signal.removeEventListener("abort", stop);
          dec.close();
          resolve();
        }, reject),
      reject,
    );
  });
}

// ---- YUV to RGB, exactly ------------------------------------------------------

/**
 * BT.709, the way the encoder made it (encode side: ffmpeg's 4:2:0, chroma
 * sited with the even columns and between rows), at the frame's own range:
 * the streams are full range, but a hardware decoder may hand back video
 * range (macOS's does, and says so in the frame's colour space). Writes the
 * video's own gamma-coded RGB to `out`, for the block encoder or a plain copy.
 */
const convertWGSL = (out: "rgba16float" | "rgba8unorm") => /* wgsl */ `
struct C { w: u32, h: u32, yOff: f32, ySpan: f32, cOff: f32, cSpan: f32, nv12: u32, pad: u32 };
@group(0) @binding(0) var yT: texture_2d<u32>;
@group(0) @binding(1) var uT: texture_2d<u32>;   // U, or UV interleaved (NV12)
@group(0) @binding(2) var vT: texture_2d<u32>;
@group(0) @binding(3) var dst: texture_storage_2d<${out}, write>;
@group(0) @binding(4) var<uniform> c: C;
fn chroma(p: vec2i) -> vec2f {
  let q = clamp(p, vec2i(0), vec2i(i32(c.w / 2u) - 1, i32(c.h / 2u) - 1));
  if (c.nv12 == 1u) { return vec2f(textureLoad(uT, q, 0).rg); }
  return vec2f(f32(textureLoad(uT, q, 0).r), f32(textureLoad(vT, q, 0).r));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= c.w || id.y >= c.h) { return; }
  let Y = (f32(textureLoad(yT, vec2i(id.xy), 0).r) - c.yOff) / c.ySpan;
  let fx = f32(id.x) * 0.5;
  let fy = (f32(id.y) + 0.5) * 0.5 - 0.5;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let tx = fx - f32(x0); let ty = fy - f32(y0);
  let top = mix(chroma(vec2i(x0, y0)), chroma(vec2i(x0 + 1, y0)), tx);
  let bottom = mix(chroma(vec2i(x0, y0 + 1)), chroma(vec2i(x0 + 1, y0 + 1)), tx);
  let cc = (mix(top, bottom, ty) - vec2f(c.cOff)) / c.cSpan;
  let r = Y + 1.5748 * cc.y;
  let b = Y + 1.8556 * cc.x;
  let g = (Y - 0.2126 * r - 0.0722 * b) / 0.7152;
  textureStore(dst, vec2i(id.xy), vec4f(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)), 1.0));
}`;

const PLANAR: Record<string, { bits: number; nv12: boolean }> = {
  I420: { bits: 8, nv12: false },
  I420P10: { bits: 10, nv12: false },
  NV12: { bits: 8, nv12: true },
};

// Whether this browser's WebGPU copies from a VideoFrame itself (Chrome's does; Firefox's
// only from an image): found out from the first one it's given.
let copiesFrames = true;

/** A frame as an image the browser can copy from: an ImageBitmap, or (where it won't make one of a frame) a canvas it's drawn on. */
async function imageOf(f: VideoFrame, w: number, h: number): Promise<ImageBitmap | OffscreenCanvas> {
  try {
    return await createImageBitmap(f);
  } catch {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.drawImage(f, 0, 0, w, h);
    return canvas;
  }
}

/** Puts frames into a staging texture: by their planes where they can be read, else by the browser's copy. */
function makeStaging(device: GPUDevice, w: number, h: number, format: "rgba16float" | "rgba8unorm") {
  const staging = device.createTexture({
    size: [w, h],
    format,
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: convertWGSL(format) }), entryPoint: "main" } });
  const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const planes = new Map<string, { y: GPUTexture; u: GPUTexture; v: GPUTexture; bind: GPUBindGroup }>();
  const planesFor = (fmt: string) => {
    let p = planes.get(fmt);
    if (!p) {
      const { bits, nv12 } = PLANAR[fmt]!;
      const one: GPUTextureFormat = bits > 8 ? "r16uint" : "r8uint";
      const tex = (f: GPUTextureFormat, tw: number, th: number) =>
        device.createTexture({ size: [tw, th], format: f, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      const y = tex(one, w, h);
      const u = tex(nv12 ? (bits > 8 ? "rg16uint" : "rg8uint") : one, w / 2, h / 2);
      const v = nv12 ? u : tex(one, w / 2, h / 2);
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: y.createView() },
          { binding: 1, resource: u.createView() },
          { binding: 2, resource: v.createView() },
          { binding: 3, resource: staging.createView() },
          { binding: 4, resource: { buffer: params } },
        ],
      });
      p = { y, u, v, bind };
      planes.set(fmt, p);
    }
    return p;
  };
  let exact = 0;
  let copied = 0;
  return {
    staging,
    get exact() {
      return exact;
    },
    get copied() {
      return copied;
    },
    /** Fill the staging texture from a frame; `enc` then carries on from it (encode, or copy out). */
    async put(f: VideoFrame, buf: { data: Uint8Array | null }, then: (enc: GPUCommandEncoder) => void) {
      const fmt = f.format && PLANAR[f.format] ? f.format : null;
      if (!fmt) {
        copied++;
        const into = { texture: staging, colorSpace: "srgb", premultipliedAlpha: false } as const;
        let done = false;
        if (copiesFrames) {
          try {
            device.queue.copyExternalImageToTexture({ source: f }, into, [w, h]);
            done = true;
          } catch (err) {
            // Not a source it takes (Firefox): an image of it, from now on.
            if (!(err instanceof TypeError)) throw err;
            copiesFrames = false;
          }
        }
        if (!done) {
          const image = await imageOf(f, w, h);
          // From here to the submit runs without a break, as below.
          device.queue.copyExternalImageToTexture({ source: image }, into, [w, h]);
          if (image instanceof ImageBitmap) image.close();
        }
        const enc = device.createCommandEncoder();
        then(enc);
        device.queue.submit([enc.finish()]);
        return;
      }
      exact++;
      const size = f.allocationSize();
      if (!buf.data || buf.data.byteLength < size) buf.data = new Uint8Array(size);
      const layout = await f.copyTo(buf.data);
      // From here to the submit runs without a break, so frames from other streams can't get between.
      const { bits, nv12 } = PLANAR[fmt]!;
      const p = planesFor(fmt);
      const put = (tex: GPUTexture, plane: PlaneLayout, tw: number, th: number) =>
        device.queue.writeTexture({ texture: tex }, buf.data!, { offset: plane.offset, bytesPerRow: plane.stride, rowsPerImage: th }, [tw, th]);
      put(p.y, layout[0]!, w, h);
      put(p.u, layout[1]!, w / 2, h / 2);
      if (!nv12) put(p.v, layout[2]!, w / 2, h / 2);
      // Full range unless the frame says otherwise; video range is 16–235 (luma) and 16–240 (chroma) at 8 bits.
      const s = 2 ** (bits - 8);
      const full = f.colorSpace.fullRange !== false;
      const top = 2 ** bits - 1;
      const u = new ArrayBuffer(32);
      const dv = new DataView(u);
      dv.setUint32(0, w, true);
      dv.setUint32(4, h, true);
      dv.setFloat32(8, full ? 0 : 16 * s, true);
      dv.setFloat32(12, full ? top : 219 * s, true);
      dv.setFloat32(16, full ? (top + 1) / 2 : 128 * s, true);
      dv.setFloat32(20, full ? top : 224 * s, true);
      dv.setUint32(24, nv12 ? 1 : 0, true);
      device.queue.writeBuffer(params, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, p.bind);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
      then(enc);
      device.queue.submit([enc.finish()]);
    },
    destroy() {
      staging.destroy();
      params.destroy();
      for (const p of planes.values()) {
        p.y.destroy();
        p.u.destroy();
        if (p.v !== p.u) p.v.destroy();
      }
    },
  };
}

/**
 * Fetch, decode and keep a tier: each frame goes from the decoder into a
 * staging texture, through the block encoder (or straight across, for plain
 * RGBA), into its layer. Progress is the share of maps done.
 */
export async function loadBasis(
  device: GPUDevice,
  base: string,
  m: Manifest,
  t: Tier,
  pick: { encoding: Encoding; hw: HardwareAcceleration },
  keeping: Keeping,
  signal: AbortSignal,
  onProgress: (done: number) => void,
): Promise<Basis> {
  const { encoding: e, hw } = pick;
  const names = Object.keys(e.streams);
  const data = new Map<string, Uint8Array>();
  // Named by the build they're from, so the browser keeps them without asking again (streetview.ts).
  const version = `?v=${encodeURIComponent(m.made)}`;
  await Promise.all(
    names.map(async (n) => {
      const res = await fetch(base + e.streams[n]!.file + version, { signal });
      if (!res.ok) throw new Error(`couldn't fetch ${e.streams[n]!.file} (${res.status})`);
      data.set(n, new Uint8Array(await res.arrayBuffer()));
    }),
  );

  const layers = new Map<string, { layer: number; scale: number }>();
  const first = new Map<string, number>();
  let count = 0;
  for (const n of names) {
    const s = e.streams[n]!;
    first.set(n, count);
    s.order.forEach((map, i) => layers.set(map, { layer: count + i, scale: s.scales[i]! }));
    count += s.order.length;
  }

  const k = KEEPING[keeping];
  device.pushErrorScope("out-of-memory");
  const texture = device.createTexture({
    size: [t.width, t.height, count],
    format: k.format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
  const oom = await device.popErrorScope();
  if (oom) {
    texture.destroy();
    throw new Error(`not enough GPU memory for the ${t.width}×${t.height} photographs`);
  }

  const extra: { destroy(): void }[] = [];
  const stage = makeStaging(device, t.width, t.height, keeping === "rgba8" ? "rgba8unorm" : "rgba16float");
  extra.push(stage);
  let carry: (enc: GPUCommandEncoder, layer: number) => void;
  if (keeping === "rgba8") {
    carry = (enc, layer) => enc.copyTextureToTexture({ texture: stage.staging }, { texture, origin: [0, 0, layer] }, [t.width, t.height, 1]);
  } else {
    const rowBlocks = t.width / 4;
    const colBlocks = t.height / 4;
    // copyBufferToTexture wants rows in multiples of 256 bytes: 16 blocks.
    const padRow = Math.ceil(rowBlocks / 16) * 16;
    const blocks = device.createBuffer({ size: padRow * colBlocks * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, new Uint32Array([rowBlocks, colBlocks, padRow, k.mode]));
    const pipeline = encoderPipeline(device);
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: stage.staging.createView() },
        { binding: 1, resource: { buffer: blocks } },
        { binding: 2, resource: { buffer: params } },
      ],
    });
    extra.push(blocks, params);
    carry = (enc, layer) => {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(rowBlocks / 8), Math.ceil(colBlocks / 8));
      pass.end();
      enc.copyBufferToTexture({ buffer: blocks, bytesPerRow: padRow * 16, rowsPerImage: colBlocks }, { texture, origin: [0, 0, layer] }, [t.width, t.height, 1]);
    };
  }

  let done = 0;
  try {
    await Promise.all(
      names.map((n) => {
        const buf = { data: null as Uint8Array | null };
        return decode(e, t, e.streams[n]!, data.get(n)!, hw, signal, async (f, i) => {
          await stage.put(f, buf, (enc) => carry(enc, first.get(n)! + i));
          onProgress(++done / count);
        });
      }),
    );
    await device.queue.onSubmittedWorkDone();
  } catch (err) {
    texture.destroy();
    throw err;
  } finally {
    for (const x of extra) x.destroy();
  }
  if (stage.copied > 0) console.warn(`streetview: ${stage.copied} of ${count} maps went through the browser's own colour conversion (${e.codec}, ${hw})`);
  return { width: t.width, height: t.height, texture, layers, copied: stage.copied, maps: count, destroy: () => texture.destroy() };
}

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();
function encoderPipeline(device: GPUDevice): GPUComputePipeline {
  let p = pipelines.get(device);
  if (!p) {
    p = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: ENCODE_WGSL }), entryPoint: "main" } });
    pipelines.set(device, p);
  }
  return p;
}
