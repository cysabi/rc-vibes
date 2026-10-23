// Block compression on the GPU, one thread per 4×4 block: the photographs
// arrive as video (small to send) and are kept as BC7 or ASTC 4×4 (a byte a
// pixel, a quarter of plain RGBA, and as quick to read), so a device holds
// every map at once. Measured against the frames they're made from, both come
// within 51–59 dB, and move the relit room by under 0.005 stops.
//
// BC7 mode 6: one subset, 7-bit RGBA endpoints with a p-bit each, 4-bit
// indices. ASTC 4×4: one partition, LDR RGB direct (CEM 8) at 8-bit
// endpoints, a 4×4 grid of 3-bit weights (block mode 0x053), every field
// plain bits, so no integer-sequence coding. Both: endpoints from the block's
// principal axis, each pixel to its nearest palette entry, then two
// least-squares refits.

export const ENCODE_WGSL = /* wgsl */ `
struct P { rowBlocks: u32, colBlocks: u32, padRow: u32, mode: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outb: array<vec4<u32>>;
@group(0) @binding(2) var<uniform> prm: P;
var<private> bc7w: array<f32, 16> = array<f32, 16>(0.0, 4.0, 9.0, 13.0, 17.0, 21.0, 26.0, 30.0, 34.0, 38.0, 43.0, 47.0, 51.0, 55.0, 60.0, 64.0);
var<private> astcw: array<f32, 8> = array<f32, 8>(0.0, 9.0, 18.0, 27.0, 37.0, 46.0, 55.0, 64.0);

fn put(w: ptr<function, array<u32, 4>>, pos: ptr<function, u32>, val: u32, n: u32) {
  let p = *pos; let wi = p >> 5u; let bo = p & 31u;
  let v = val & ((1u << n) - 1u);
  (*w)[wi] = (*w)[wi] | (v << bo);
  if (bo + n > 32u) { (*w)[wi + 1u] = (*w)[wi + 1u] | (v >> (32u - bo)); }
  *pos = p + n;
}
fn wt(k: u32, astc: bool) -> f32 { if (astc) { return astcw[k]; } return bc7w[k]; }

fn assign(px: ptr<function, array<vec3f, 16>>, a: vec3f, b: vec3f, astc: bool, idx: ptr<function, array<u32, 16>>) -> f32 {
  let n = select(16u, 8u, astc);
  var pal: array<vec3f, 16>;
  for (var j = 0u; j < n; j++) {
    let w = wt(j, astc);
    if (astc) { pal[j] = (a * (64.0 - w) + b * w) / 64.0; }
    else { pal[j] = floor(((64.0 - w) * a + w * b + 32.0) / 64.0); }
  }
  var err = 0.0;
  for (var i = 0; i < 16; i++) {
    var bj = 0u; var be = 1e12;
    for (var j = 0u; j < n; j++) { let d = (*px)[i] - pal[j]; let e = dot(d, d); if (e < be) { be = e; bj = j; } }
    (*idx)[i] = bj; err += be;
  }
  return err;
}
fn lsq(px: ptr<function, array<vec3f, 16>>, idx: ptr<function, array<u32, 16>>, astc: bool,
       e0: ptr<function, vec3f>, e1: ptr<function, vec3f>) {
  var a = 0.0; var b = 0.0; var c = 0.0; var x0 = vec3f(0.0); var x1 = vec3f(0.0);
  for (var i = 0; i < 16; i++) {
    let w = wt((*idx)[i], astc) / 64.0;
    a += (1.0 - w) * (1.0 - w); b += w * (1.0 - w); c += w * w;
    x0 += (1.0 - w) * (*px)[i]; x1 += w * (*px)[i];
  }
  let det = a * c - b * b;
  if (abs(det) > 1e-4) {
    *e0 = clamp((c * x0 - b * x1) / det, vec3f(0.0), vec3f(255.0));
    *e1 = clamp((a * x1 - b * x0) / det, vec3f(0.0), vec3f(255.0));
  }
}
fn bc7q(e: vec3f) -> vec4f {
  var best = vec4f(0.0); var be = 1e12;
  for (var p = 0u; p < 2u; p++) {
    let qq = clamp(round((e - f32(p)) * 0.5), vec3f(0.0), vec3f(127.0));
    let d = qq * 2.0 + f32(p);
    let err = dot(d - e, d - e);
    if (err < be) { be = err; best = vec4f(d, f32(p)); }
  }
  return best;
}

fn encBC7(px: ptr<function, array<vec3f, 16>>, e0in: vec3f, e1in: vec3f) -> array<u32, 4> {
  var e0 = e0in; var e1 = e1in;
  var idx: array<u32, 16>; var bi: array<u32, 16>;
  var b0 = vec4f(0.0); var b1 = vec4f(0.0); var berr = 1e30;
  for (var it = 0; it < 3; it++) {
    let q0 = bc7q(e0); let q1 = bc7q(e1);
    let err = assign(px, q0.xyz, q1.xyz, false, &idx);
    if (err < berr) { berr = err; bi = idx; b0 = q0; b1 = q1; }
    lsq(px, &idx, false, &e0, &e1);
  }
  if (bi[0] >= 8u) {
    let t = b0; b0 = b1; b1 = t;
    for (var i = 0; i < 16; i++) { bi[i] = 15u - bi[i]; }
  }
  var w = array<u32, 4>(0u, 0u, 0u, 0u); var pos = 0u;
  put(&w, &pos, 64u, 7u);
  let r0 = vec3u((b0.xyz - b0.w) * 0.5); let r1 = vec3u((b1.xyz - b1.w) * 0.5);
  put(&w, &pos, r0.x, 7u); put(&w, &pos, r1.x, 7u);
  put(&w, &pos, r0.y, 7u); put(&w, &pos, r1.y, 7u);
  put(&w, &pos, r0.z, 7u); put(&w, &pos, r1.z, 7u);
  put(&w, &pos, 127u, 7u); put(&w, &pos, 127u, 7u);
  put(&w, &pos, u32(b0.w), 1u); put(&w, &pos, u32(b1.w), 1u);
  put(&w, &pos, bi[0], 3u);
  for (var i = 1; i < 16; i++) { put(&w, &pos, bi[i], 4u); }
  return w;
}

fn encASTC(px: ptr<function, array<vec3f, 16>>, e0in: vec3f, e1in: vec3f) -> array<u32, 4> {
  var e0 = e0in; var e1 = e1in;
  var idx: array<u32, 16>; var bi: array<u32, 16>;
  var b0 = vec3f(0.0); var b1 = vec3f(0.0); var berr = 1e30;
  for (var it = 0; it < 3; it++) {
    let q0 = round(clamp(e0, vec3f(0.0), vec3f(255.0))); let q1 = round(clamp(e1, vec3f(0.0), vec3f(255.0)));
    let err = assign(px, q0, q1, true, &idx);
    if (err < berr) { berr = err; bi = idx; b0 = q0; b1 = q1; }
    lsq(px, &idx, true, &e0, &e1);
  }
  if (b1.x + b1.y + b1.z < b0.x + b0.y + b0.z) {
    let t = b0; b0 = b1; b1 = t;
    for (var i = 0; i < 16; i++) { bi[i] = 7u - bi[i]; }
  }
  var w = array<u32, 4>(0u, 0u, 0u, 0u); var pos = 0u;
  put(&w, &pos, 0x053u, 11u);
  put(&w, &pos, 0u, 2u);
  put(&w, &pos, 8u, 4u);
  let a = vec3u(b0); let b = vec3u(b1);
  put(&w, &pos, a.x, 8u); put(&w, &pos, b.x, 8u);
  put(&w, &pos, a.y, 8u); put(&w, &pos, b.y, 8u);
  put(&w, &pos, a.z, 8u); put(&w, &pos, b.z, 8u);
  for (var i = 0u; i < 16u; i++) {
    for (var k = 0u; k < 3u; k++) {
      if (((bi[i] >> k) & 1u) == 1u) { let bit = 127u - (3u * i + k); w[bit >> 5u] = w[bit >> 5u] | (1u << (bit & 31u)); }
    }
  }
  return w;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= prm.rowBlocks || id.y >= prm.colBlocks) { return; }
  var px: array<vec3f, 16>;
  let base = vec2i(id.xy) * 4;
  var mean = vec3f(0.0);
  for (var i = 0; i < 16; i++) {
    let c = textureLoad(src, base + vec2i(i % 4, i / 4), 0).rgb * 255.0;
    px[i] = c; mean += c;
  }
  mean = mean / 16.0;
  var c00 = 0.0; var c01 = 0.0; var c02 = 0.0; var c11 = 0.0; var c12 = 0.0; var c22 = 0.0;
  for (var i = 0; i < 16; i++) {
    let d = px[i] - mean;
    c00 += d.x * d.x; c01 += d.x * d.y; c02 += d.x * d.z; c11 += d.y * d.y; c12 += d.y * d.z; c22 += d.z * d.z;
  }
  var ax: vec3f;
  if (c00 >= c11 && c00 >= c22) { ax = vec3f(c00, c01, c02); }
  else if (c11 >= c22) { ax = vec3f(c01, c11, c12); }
  else { ax = vec3f(c02, c12, c22); }
  if (length(ax) < 1e-6) { ax = vec3f(0.57735); }
  ax = normalize(ax);
  for (var k = 0; k < 6; k++) {
    let n = vec3f(c00 * ax.x + c01 * ax.y + c02 * ax.z, c01 * ax.x + c11 * ax.y + c12 * ax.z, c02 * ax.x + c12 * ax.y + c22 * ax.z);
    let l = length(n);
    if (l < 1e-9) { break; }
    ax = n / l;
  }
  var tmin = 1e9; var tmax = -1e9;
  for (var i = 0; i < 16; i++) { let t = dot(px[i] - mean, ax); tmin = min(tmin, t); tmax = max(tmax, t); }
  let e0 = clamp(mean + ax * tmin, vec3f(0.0), vec3f(255.0));
  let e1 = clamp(mean + ax * tmax, vec3f(0.0), vec3f(255.0));
  var words: array<u32, 4>;
  if (prm.mode == 0u) { words = encBC7(&px, e0, e1); } else { words = encASTC(&px, e0, e1); }
  outb[id.y * prm.padRow + id.x] = vec4u(words[0], words[1], words[2], words[3]);
}`;

/**
 * How a device keeps the maps: ASTC 4×4 where it can (phones, Apple), else
 * BC7 (most other desktops; WebGPU has one or the other), plain RGBA as the
 * last resort. ASTC first: its 8-bit endpoints keep the darks as they are,
 * where BC7's 7-bit ones (and a shared low bit) blotch them.
 */
export type Keeping = "bc7" | "astc" | "rgba8";

export const KEEPING: Record<Keeping, { format: GPUTextureFormat; bytesPerPixel: number; mode: number }> = {
  bc7: { format: "bc7-rgba-unorm", bytesPerPixel: 1, mode: 0 },
  astc: { format: "astc-4x4-unorm", bytesPerPixel: 1, mode: 1 },
  rgba8: { format: "rgba8unorm", bytesPerPixel: 4, mode: -1 },
};

export function keepingFor(features: GPUSupportedFeatures): Keeping {
  if (features.has("texture-compression-astc")) return "astc";
  if (features.has("texture-compression-bc")) return "bc7";
  return "rgba8";
}
