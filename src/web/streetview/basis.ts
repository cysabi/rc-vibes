// A camera's photographs, as one map per bulb channel (plus the room with
// every bulb off), held on the GPU: the "basis" the room is relit from. They
// come as video, one stream per channel, each frame a map scaled to its own
// peak and gamma-coded; a device picks the sizes it can hold and the codec it
// decodes in hardware, and keeps them block-compressed (encode.ts).

import { ENCODE_WGSL, KEEPING, type Keeping } from "./encode.ts";

// WebGPU's usage flags (the browser's own), which TypeScript's DOM types don't have yet.
declare const GPUBufferUsage: { readonly COPY_DST: number; readonly COPY_SRC: number; readonly UNIFORM: number; readonly STORAGE: number };
declare const GPUTextureUsage: { readonly COPY_DST: number; readonly TEXTURE_BINDING: number; readonly RENDER_ATTACHMENT: number };

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
  codec: "av1" | "h264";
  codec_string: string;
  crf: number;
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

/** AV1 where it's decoded in hardware (the smallest to send), else H.264, else whatever decodes at all. */
export async function pickEncoding(t: Tier): Promise<{ encoding: Encoding; hw: HardwareAcceleration } | null> {
  const order = ["av1", "h264"].map((c) => t.encodings.find((e) => e.codec === c)).filter((e): e is Encoding => !!e);
  for (const e of order) if (await supported(e, t, "prefer-hardware")) return { encoding: e, hw: "prefer-hardware" };
  for (const e of order) if (await supported(e, t, "prefer-software")) return { encoding: e, hw: "prefer-software" };
  return null;
}

function decode(e: Encoding, t: Tier, s: Stream, data: Uint8Array, hw: HardwareAcceleration, signal: AbortSignal, onFrame: (f: VideoFrame, i: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const dec = new VideoDecoder({
      output: (f) => {
        try {
          if (!signal.aborted) onFrame(f, Number(f.timestamp) / 1000);
        } finally {
          f.close();
        }
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
      () => {
        signal.removeEventListener("abort", stop);
        dec.close();
        resolve();
      },
      (err) => reject(err),
    );
  });
}

/**
 * Fetch, decode and keep a tier: each frame goes from the decoder into a
 * staging texture, through the block encoder, into its layer. Progress is
 * the share of maps done.
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
  await Promise.all(
    names.map(async (n) => {
      const res = await fetch(base + e.streams[n]!.file, { signal });
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
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (keeping === "rgba8" ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
  });
  const oom = await device.popErrorScope();
  if (oom) {
    texture.destroy();
    throw new Error(`not enough GPU memory for the ${t.width}×${t.height} photographs`);
  }

  const extra: { destroy(): void }[] = [];
  let put: (f: VideoFrame, layer: number) => void;
  if (keeping === "rgba8") {
    put = (f, layer) =>
      device.queue.copyExternalImageToTexture({ source: f }, { texture, origin: [0, 0, layer], colorSpace: "srgb", premultipliedAlpha: false }, [t.width, t.height]);
  } else {
    const rowBlocks = t.width / 4;
    const colBlocks = t.height / 4;
    // copyBufferToTexture wants rows in multiples of 256 bytes: 16 blocks.
    const padRow = Math.ceil(rowBlocks / 16) * 16;
    const staging = device.createTexture({
      size: [t.width, t.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const blocks = device.createBuffer({ size: padRow * colBlocks * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, new Uint32Array([rowBlocks, colBlocks, padRow, k.mode]));
    const pipeline = encoderPipeline(device);
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: staging.createView() },
        { binding: 1, resource: { buffer: blocks } },
        { binding: 2, resource: { buffer: params } },
      ],
    });
    extra.push(staging, blocks, params);
    // One staging texture and buffer serve every stream: the queue runs each
    // frame's copy, encode and copy-out in order before the next frame's.
    put = (f, layer) => {
      device.queue.copyExternalImageToTexture({ source: f }, { texture: staging, colorSpace: "srgb", premultipliedAlpha: false }, [t.width, t.height]);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(rowBlocks / 8), Math.ceil(colBlocks / 8));
      pass.end();
      enc.copyBufferToTexture({ buffer: blocks, bytesPerRow: padRow * 16, rowsPerImage: colBlocks }, { texture, origin: [0, 0, layer] }, [t.width, t.height, 1]);
      device.queue.submit([enc.finish()]);
    };
  }

  let done = 0;
  try {
    await Promise.all(
      names.map((n) =>
        decode(e, t, e.streams[n]!, data.get(n)!, hw, signal, (f, i) => {
          put(f, first.get(n)! + i);
          onProgress(++done / count);
        }),
      ),
    );
    await device.queue.onSubmittedWorkDone();
  } catch (err) {
    texture.destroy();
    throw err;
  } finally {
    for (const x of extra) x.destroy();
  }
  return { width: t.width, height: t.height, texture, layers, destroy: () => texture.destroy() };
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
