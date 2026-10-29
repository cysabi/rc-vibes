// The color preview's dots as metaballs (and the color editor's, where its
// lights land, looking as its circles do: `lookOf`, `outline`, `halo`): each
// mark is a ball of goo, a black-rimmed blob in its lights' color. Balls that come near each other
// reach out and run together before they touch, as metaballs do, their colors
// running together where they meet (the bigger ball's winning, as if on top);
// counts are stiffer than single lights, keeping their shape more. Counts
// that joined (see dotsOf) show one number, in the middle of their blob. They
// glide, grow in and shrink away as the marks change, a frame at a time until
// they settle. Counts and hovers ride over the goo as plain elements.

import { useEffect, useLayoutEffect, useRef } from "react";
import { swatch, type Gamut, type Vec3 } from "../../shared/lemtone.ts";
import { sizeOf, totalOf, type Group } from "../marks.ts";

// How far a ball's field reaches, in its radii: a single light's a little past
// its rim, so it reaches for its neighbors just before they touch; a count's
// barely past, so it keeps its shape. Each ball's field is scaled to be EDGE
// at its rim, so the further it reaches, the gentler it is there, and the
// more its neighbors can pull it about.
const REACH_ONE = 1.6;
const REACH_COUNT = 1.15;
const reachOf = (r: number) => {
  const [one, count] = [sizeOf(1) / 2, sizeOf(2) / 2];
  return REACH_ONE + (REACH_COUNT - REACH_ONE) * clamp((r - one) / (count - one));
};
// The goo's edge is wherever the field is this.
const EDGE = 1;
// The black rim (px).
const RIM = 2.5;
// Room around the area for balls at its edge (px).
const PAD = 24;
// How quickly a ball closes the gap to where it should be (ms, to close most of it).
const EASE_MS = 70;
// Half a number's width per digit, and the space kept between numbers (px).
const LABEL_HALF_PX = 3.5;
const LABEL_GAP_PX = 3;

interface Look {
  x: number;
  y: number;
  r: number;
  rgb: Vec3;
  /** Its fill's opacity, under its own (alpha). */
  fill: number;
  /** Its rim's color, and how wide (CSS px). */
  rim: Vec3;
  rimPx: number;
  /** How far its halo reaches past its edge (CSS px; 0: none). */
  haloPx: number;
  alpha: number;
  /** How many lights its own dot holds. */
  n: number;
  /** For a count, the key of the count it's counted with: its own, or the one it joined. */
  cluster: string;
}

interface Ball extends Look {
  to: Look;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Props {
  /** The dots, bottom to top, `x` and `y` in px within the area. */
  marks: Group[];
  width: number;
  height: number;
  gamut: Gamut;
  /**
   * A mark's look, where it isn't the color preview's: its size (diameter,
   * CSS px), its fill (a color, gamma-encoded, 0 to 1, and how opaque), its
   * rim's color and width, and a class for its count.
   */
  lookOf?: (g: Group) => { size?: number; fill?: Vec3; fillAlpha?: number; rim?: Vec3; rimPx?: number; haloPx?: number; className?: string };
  /** A line round the goo, outside its rim: this wide (CSS px), this color, this opaque. None, without it. */
  outline?: { px: number; rgb: Vec3; alpha: number };
  /** The halos' color and opacity, round the balls that have one (lookOf's haloPx), outside the line round them. */
  halo?: { rgb: Vec3; alpha: number };
}

const BLACK: Vec3 = [0, 0, 0];

export function Goo({ marks, width, height, gamut, lookOf, outline, halo }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const balls = useRef(new Map<string, Ball>());
  const labels = useRef(new Map<string, HTMLSpanElement>());
  const kick = useRef(() => {});

  // The goo, redrawn each frame while anything moves.
  useLayoutEffect(() => {
    const c = canvas.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round((width + 2 * PAD) * dpr);
    const h = Math.round((height + 2 * PAD) * dpr);
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { colorSpace: gamut })!;
    const img = ctx.createImageData(w, h, { colorSpace: gamut });
    const data = img.data;
    // Per pixel (at its center): the field, the colors weighed into it, and
    // how far it is from the goo's edge, where that's near.
    const field = new Float32Array(w * h);
    // r, g, b, alpha, weight; the rim's r, g, b and width; the fill's opacity;
    // and the halo's width and its weight (reaching further than the field does).
    const sum = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(() => new Float32Array(w * h));
    const dist = new Float32Array(w * h);
    // The line round the goo, if it has one (device px).
    const linePx = (outline?.px ?? 0) * dpr;
    // As far from the edge as the widest rim, or the line round it (and its softening), reaches: worked out each frame.
    let band = RIM * dpr + 1.5;

    const rows = (box: Box, each: (start: number, end: number) => void) => {
      for (let y = box.y0; y <= box.y1; y++) each(y * w + box.x0, y * w + box.x1 + 1);
    };

    /** Every pixel within the band of the edge piece (x0, y0)–(x1, y1) learns how near it is (squared, in `dist`). */
    const near = (x0: number, y0: number, x1: number, y1: number) => {
      const ex = x1 - x0;
      const ey = y1 - y0;
      const len2 = ex * ex + ey * ey || 1e-12;
      const qx0 = Math.max(0, Math.floor(Math.min(x0, x1) - band));
      const qx1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + band));
      const qy0 = Math.max(0, Math.floor(Math.min(y0, y1) - band));
      const qy1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + band));
      for (let qy = qy0; qy <= qy1; qy++) {
        for (let qx = qx0; qx <= qx1; qx++) {
          const t = clamp(((qx - x0) * ex + (qy - y0) * ey) / len2);
          const dx = qx - x0 - t * ex;
          const dy = qy - y0 - t * ey;
          const d2 = dx * dx + dy * dy;
          const i = qy * w + qx;
          if (d2 < dist[i]!) dist[i] = d2;
        }
      }
    };

    // The area the last frame drew in, to clear.
    let was: Box = { x0: w, y0: h, x1: -1, y1: -1 };

    const draw = () => {
      let widest = 0;
      let haloMost = 0;
      for (const b of balls.current.values()) {
        widest = Math.max(widest, b.rimPx);
        haloMost = Math.max(haloMost, b.haloPx);
      }
      band = Math.max(widest * dpr, linePx + 1, haloMost * dpr + 1) + 1.5;
      // Where the goo can be this frame: around each ball, as far as its field and the edge's band reach.
      const box = { x0: w, y0: h, x1: -1, y1: -1 };
      for (const b of balls.current.values()) {
        if (b.r < 0.05) continue;
        const far = b.r * dpr * reachOf(b.r) + band + 1;
        box.x0 = Math.min(box.x0, Math.max(0, Math.floor(b.x * dpr - far)));
        box.x1 = Math.max(box.x1, Math.min(w - 1, Math.ceil(b.x * dpr + far)));
        box.y0 = Math.min(box.y0, Math.max(0, Math.floor(b.y * dpr - far)));
        box.y1 = Math.max(box.y1, Math.min(h - 1, Math.ceil(b.y * dpr + far)));
      }
      const all = { x0: Math.min(box.x0, was.x0), y0: Math.min(box.y0, was.y0), x1: Math.max(box.x1, was.x1), y1: Math.max(box.y1, was.y1) };
      was = box;
      rows(all, (s, e) => {
        field.fill(0, s, e);
        for (const a of sum) a.fill(0, s, e);
        dist.fill(Infinity, s, e);
        data.fill(0, s * 4, e * 4);
      });

      for (const b of balls.current.values()) {
        if (b.r < 0.05) continue;
        const cx = b.x * dpr;
        const cy = b.y * dpr;
        const reach = reachOf(b.r);
        const far = b.r * dpr * reach;
        // (distance / reach)², for each pixel; and the scale that puts a lone ball's edge on its rim.
        const inv = 1 / (far * far);
        const scale = 1 / (1 - 1 / (reach * reach)) ** 3;
        const big = b.r ** 4;
        // How far its say in the halo's width reaches: as far as any halo does past its rim.
        const edge = b.r * dpr;
        const outer = Math.max(far, edge + haloMost * dpr + 2);
        const x0 = Math.max(0, Math.floor(cx - outer));
        const x1 = Math.min(w - 1, Math.ceil(cx + outer));
        const y0 = Math.max(0, Math.floor(cy - outer));
        const y1 = Math.min(h - 1, Math.ceil(cy + outer));
        for (let py = y0; py <= y1; py++) {
          const dy = py + 0.5 - cy;
          for (let px = x0; px <= x1; px++) {
            const dx = px + 0.5 - cx;
            const d2 = dx * dx + dy * dy;
            const i = py * w + px;
            if (haloMost > 0) {
              // The halo's width here: each ball's, the nearer its edge, the more it counts.
              const off = Math.max(0, Math.sqrt(d2) - edge);
              const hw = 1 / (1 + off * off);
              sum[10]![i]! += hw * b.haloPx;
              sum[11]![i]! += hw;
            }
            const q = d2 * inv;
            if (q >= 1) continue;
            const k = 1 - q;
            const g = k * k * k;
            field[i]! += g * scale;
            const weight = g * g * g * g * big;
            sum[0]![i]! += weight * b.rgb[0];
            sum[1]![i]! += weight * b.rgb[1];
            sum[2]![i]! += weight * b.rgb[2];
            sum[3]![i]! += weight * b.alpha;
            sum[4]![i]! += weight;
            sum[5]![i]! += weight * b.rim[0];
            sum[6]![i]! += weight * b.rim[1];
            sum[7]![i]! += weight * b.rim[2];
            sum[8]![i]! += weight * b.rimPx;
            sum[9]![i]! += weight * b.fill;
          }
        }
      }

      // The edge, traced between pixel centers (marching squares), so every
      // pixel near it knows its true distance: the rim is as wide all round,
      // however the balls overlap.
      for (let py = box.y0; py < Math.min(box.y1, h - 1); py++) {
        for (let px = box.x0; px < Math.min(box.x1, w - 1); px++) {
          const i = py * w + px;
          const a = field[i]! - EDGE; // top left, then clockwise
          const b = field[i + 1]! - EDGE;
          const c = field[i + w + 1]! - EDGE;
          const d = field[i + w]! - EDGE;
          const inside = (a >= 0 ? 1 : 0) | (b >= 0 ? 2 : 0) | (c >= 0 ? 4 : 0) | (d >= 0 ? 8 : 0);
          if (inside === 0 || inside === 15) continue;
          // Where the edge crosses each side of the cell: top, right, bottom, left.
          const tx = px + a / (a - b);
          const ry = py + b / (b - c);
          const bx = px + d / (d - c);
          const ly = py + a / (a - d);
          if (inside === 5 || inside === 10) {
            // A saddle: the cell's middle says which corners join.
            if (a + b + c + d >= 0 === (inside === 5)) {
              near(tx, py, px + 1, ry);
              near(bx, py + 1, px, ly);
            } else {
              near(tx, py, px, ly);
              near(px + 1, ry, bx, py + 1);
            }
            continue;
          }
          // Otherwise the edge crosses just two sides.
          let [x0, y0] = [0, 0];
          let first = true;
          const cross = (x: number, y: number) => {
            if (first) [x0, y0, first] = [x, y, false];
            else near(x0, y0, x, y);
          };
          if (a >= 0 !== b >= 0) cross(tx, py);
          if (b >= 0 !== c >= 0) cross(px + 1, ry);
          if (d >= 0 !== c >= 0) cross(bx, py + 1);
          if (a >= 0 !== d >= 0) cross(px, ly);
        }
      }

      rows(box, (s, e) => {
        for (let i = s; i < e; i++) {
          const f = field[i]!;
          // Outside the goo and away from its edge: nothing.
          if (f <= 0 && !(dist[i]! < Infinity)) continue;
          // How far inside the edge (device px); out past the band, as good as forever.
          const depth = (f >= EDGE ? 1 : -1) * Math.sqrt(dist[i]!);
          const haloW = sum[11]![i]!;
          const haloPx = haloW > 0 ? (sum[10]![i]! / haloW) * dpr : 0;
          if (depth < -(Math.max(linePx, haloPx) + 1)) continue;
          // How much of the pixel is inside the edge, how much the line round it, and how much the halo past that.
          const aIn = clamp(depth + 0.5);
          const aLine = linePx > 0 ? clamp(depth + linePx + 0.5) - aIn : 0;
          const aHalo = haloPx > linePx ? clamp(depth + haloPx + 0.5) - clamp(depth + linePx + 0.5) : 0;
          if (aIn <= 0 && aLine <= 0 && aHalo <= 0) continue;
          const weight = sum[4]![i]!;
          const per = weight > 0 ? 1 / weight : 0;
          // The rim (as wide as the balls here have it) and the fill inside it, anti-aliased.
          const rimPx = weight > 0 ? sum[8]![i]! * per * dpr : RIM * dpr;
          const aFill = clamp(depth - rimPx + 0.5);
          const aRim = aIn - aFill;
          const fill = (weight > 0 ? sum[9]![i]! * per : 1) * aFill;
          const line = aLine * (outline?.alpha ?? 0);
          const glow = aHalo * (halo?.alpha ?? 0);
          const cover = fill + aRim + line + glow;
          if (cover <= 0) continue;
          const o = i * 4;
          // Fill, rim, line and halo, premultiplied, then back out of their coverage.
          for (let c = 0; c < 3; c++) {
            const sums = sum[c]![i]! * per * fill + sum[5 + c]![i]! * per * aRim;
            data[o + c] = ((sums + (outline?.rgb[c] ?? 0) * line + (halo?.rgb[c] ?? 0) * glow) / cover) * 255;
          }
          data[o + 3] = cover * (weight > 0 ? sum[3]![i]! * per : 1) * 255;
        }
      });
      if (all.x1 >= all.x0 && all.y1 >= all.y0) ctx.putImageData(img, 0, 0, all.x0, all.y0, all.x1 - all.x0 + 1, all.y1 - all.y0 + 1);
    };

    let frame = 0;
    let running = false;
    let last = 0;
    const step = (now: number) => {
      const t = 1 - Math.exp(-Math.min(100, Math.max(0, now - last)) / EASE_MS);
      last = now;
      let moving = false;
      for (const [key, b] of balls.current) {
        const to = b.to;
        b.x += (to.x - b.x) * t;
        b.y += (to.y - b.y) * t;
        b.r += (to.r - b.r) * t;
        b.alpha += (to.alpha - b.alpha) * t;
        b.fill += (to.fill - b.fill) * t;
        b.rimPx += (to.rimPx - b.rimPx) * t;
        b.haloPx += (to.haloPx - b.haloPx) * t;
        b.rgb = b.rgb.map((v, i) => v + (to.rgb[i]! - v) * t) as Vec3;
        b.rim = b.rim.map((v, i) => v + (to.rim[i]! - v) * t) as Vec3;
        if (to.r === 0 && b.r < 0.05) {
          balls.current.delete(key);
        } else if (Math.abs(to.x - b.x) + Math.abs(to.y - b.y) + Math.abs(to.r - b.r) > 0.02) {
          moving = true;
        } else {
          Object.assign(b, { ...to, to });
        }
      }
      draw();

      // Each count's number on its ball, or for counts that joined, in the
      // middle of their blob (weighed by size); then nudged apart where
      // numbers would print over each other.
      const byCluster = new Map<string, Ball[]>();
      for (const b of balls.current.values()) {
        if (b.to.n > 1 && b.r >= 0.05) byCluster.set(b.to.cluster, [...(byCluster.get(b.to.cluster) ?? []), b]);
      }
      const spots: { el: HTMLSpanElement; x: number; y: number; half: number }[] = [];
      for (const [key, el] of labels.current) {
        const b = balls.current.get(key);
        // No number without its ball: none yet (growing in), or going.
        if (!b || b.to.r === 0 || b.r < b.to.r * 0.5) {
          el.style.visibility = "hidden";
          continue;
        }
        let [x, y] = [b.x, b.y];
        const members = b.to.n > 1 && key === b.to.cluster ? byCluster.get(key) : undefined;
        if (members && members.length > 1) {
          const weight = members.reduce((sum, m) => sum + m.r * m.r, 0) || 1;
          x = members.reduce((sum, m) => sum + m.x * m.r * m.r, 0) / weight;
          y = members.reduce((sum, m) => sum + m.y * m.r * m.r, 0) / weight;
        }
        spots.push({ el, x, y, half: (el.textContent?.length ?? 0) * LABEL_HALF_PX });
      }
      for (let round = 0; round < 4; round++) {
        for (const [i, a] of spots.entries()) {
          for (const b of spots.slice(i + 1)) {
            if (!a.half || !b.half) continue;
            const need = a.half + b.half + LABEL_GAP_PX;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.hypot(dx, dy);
            if (d >= need) continue;
            const [ux, uy] = d > 0.01 ? [dx / d, dy / d] : [1, 0];
            const push = (need - d) / 2;
            a.x -= ux * push;
            a.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
          }
        }
      }
      for (const s of spots) {
        s.el.style.transform = `translate(${s.x - PAD}px, ${s.y - PAD}px) translate(-50%, -50%)`;
        s.el.style.visibility = "visible";
      }
      if (moving) frame = requestAnimationFrame(step);
      else running = false;
    };
    kick.current = () => {
      if (running) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(step);
    };
    kick.current();
    return () => {
      cancelAnimationFrame(frame);
      kick.current = () => {};
    };
  }, [width, height, gamut]);

  // Where each ball should be: new ones grow in where they are, gone ones
  // shrink away. This runs with every frame of the room, so the goo is drawn
  // again only when a ball has somewhere new to go.
  useEffect(() => {
    const here = new Set<string>();
    let changed = false;
    for (const g of marks) {
      here.add(g.key);
      const n = g.ids.length;
      // A count that joined another is counted with it.
      const cluster = n > 1 && g.into ? g.into.key : g.key;
      const look = lookOf?.(g);
      const to = {
        x: g.x + PAD,
        y: g.y + PAD,
        r: (look?.size ?? sizeOf(n)) / 2,
        rgb: look?.fill ?? swatch(g.t.a, g.t.b, gamut),
        fill: look?.fillAlpha ?? 1,
        rim: look?.rim ?? BLACK,
        rimPx: look?.rimPx ?? RIM,
        haloPx: look?.haloPx ?? 0,
        alpha: g.dim ? 0.5 : 1,
        n,
        cluster,
      };
      const b = balls.current.get(g.key);
      if (!b) balls.current.set(g.key, { ...to, r: 0, to });
      else if (!sameLook(b.to, to)) b.to = to;
      else continue;
      changed = true;
    }
    for (const [key, b] of balls.current) {
      if (here.has(key) || b.to.r === 0) continue;
      b.to = { ...b.to, r: 0 };
      changed = true;
    }
    if (changed) kick.current();
  });

  return (
    <>
      <canvas key={gamut} ref={canvas} className="goo" style={{ left: -PAD, top: -PAD, width: width + 2 * PAD, height: height + 2 * PAD }} aria-hidden="true" />
      {marks.map((g) => {
        const n = g.ids.length;
        const look = lookOf?.(g);
        const [r, gr, b] = look?.fill ?? swatch(g.t.a, g.t.b, gamut);
        const light = 0.2126 * r + 0.7152 * gr + 0.0722 * b > 0.6;
        const size = look?.size ?? sizeOf(n);
        return (
          <span
            key={g.key}
            ref={(el) => {
              if (el) labels.current.set(g.key, el);
              else labels.current.delete(g.key);
            }}
            className={look?.className ? `goo-mark ${look.className}` : "goo-mark"}
            style={{ width: size, height: size, color: light ? "#0d0b09" : "#fff" }}
          >
            {/* Counts that joined another are counted there; single lights carry no number. */}
            {!g.into && n > 1 && totalOf(g)}
          </span>
        );
      })}
    </>
  );
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

const sameLook = (a: Look, b: Look) =>
  a.x === b.x &&
  a.y === b.y &&
  a.r === b.r &&
  a.alpha === b.alpha &&
  a.fill === b.fill &&
  a.rimPx === b.rimPx &&
  a.haloPx === b.haloPx &&
  a.n === b.n &&
  a.cluster === b.cluster &&
  a.rgb.every((v, i) => v === b.rgb[i]) &&
  a.rim.every((v, i) => v === b.rim[i]);
