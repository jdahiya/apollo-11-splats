// Shaped splat helpers: oriented discs, blobs, lines, rectangles and rasterised canvases.
import type { Vec3 } from '../util/math';
import { rng } from '../util/random';
import { glow, put, removeSplats, setJitter, setNormalBits, store } from './store';

/** [r, g, b], [r, g, b, a] or [r, g, b, a, gain]. */
export type Color = readonly number[];
export type Draw2D = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

/** Octahedral normal encoding into 2 × 8 bits; 0 is reserved for "no normal". */
export function octNormal(nx: number, ny: number, nz: number): number {
  const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
  let x = nx / l;
  let y = ny / l;
  if (nz < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const qx = 1 + Math.round((x * 0.5 + 0.5) * 254);
  const qy = 1 + Math.round((y * 0.5 + 0.5) * 254);
  return qx | (qy << 8);
}

/**
 * Oriented splat: unit axes u (sigma su) and v (sigma sv); the normal u×v gets sigma sn.
 * Flat splats (sn well below su and sv) record their normal for lighting.
 */
export function S(
  x: number, y: number, z: number,
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
  su: number, sv: number, sn: number,
  r: number, g: number, b: number, a = 1,
): void {
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const A = su * su, B = sv * sv, C = sn * sn;
  setNormalBits(sn < 0.45 * Math.min(su, sv) ? octNormal(nx, ny, nz) : 0);
  put(
    x, y, z,
    A * ux * ux + B * vx * vx + C * nx * nx,
    A * ux * uy + B * vx * vy + C * nx * ny,
    A * ux * uz + B * vx * vz + C * nx * nz,
    A * uy * uy + B * vy * vy + C * ny * ny,
    A * uy * uz + B * vy * vz + C * ny * nz,
    A * uz * uz + B * vz * vz + C * nz * nz,
    r, g, b, a,
  );
  setNormalBits(0);
}

/** S() with a Color, honouring its optional alpha and gain. */
export function SC(
  x: number, y: number, z: number,
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
  su: number, sv: number, sn: number,
  c: Color,
): void {
  const gain = c[4] ?? 1;
  if (gain !== 1) glow(gain);
  S(x, y, z, ux, uy, uz, vx, vy, vz, su, sv, sn, c[0]!, c[1]!, c[2]!, c[3] ?? 1);
  if (gain !== 1) glow(1);
}

/** Round splat. */
export function blob(x: number, y: number, z: number, s: number, r: number, g: number, b: number, a = 1): void {
  const q = s * s;
  put(x, y, z, q, 0, 0, q, 0, q, r, g, b, a);
}

/** Axis-aligned ellipsoid. */
export function ell(x: number, y: number, z: number, sx: number, sy: number, sz: number, c: Color, a = 1): void {
  put(x, y, z, sx * sx, 0, 0, sy * sy, 0, sz * sz, c[0]!, c[1]!, c[2]!, a);
}

/** A light source: bright emissive core plus a faint halo. */
export function lightBlob(x: number, y: number, z: number, s: number, r: number, g: number, b: number, gain = 3, halo = 4): void {
  glow(gain);
  blob(x, y, z, s, r, g, b);
  glow(gain * 0.6);
  blob(x, y, z, s * halo, r, g, b, 0.1);
  glow(1);
}

/** Chain of elongated splats from one point to another; w is the thickness sigma. */
export function line(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  w: number, step: number,
  r: number, g: number, b: number, a = 1,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, L = Math.hypot(dx, dy, dz);
  if (L < 1e-6) return;
  const n = Math.max(1, Math.round(L / step));
  const ux = dx / L, uy = dy / L, uz = dz / L;
  let px: number, py: number, pz: number;
  if (Math.abs(uy) < 0.9) {
    px = -uz; py = 0; pz = ux;
  } else {
    px = 0; py = uz; pz = -uy;
  }
  const pl = Math.hypot(px, py, pz);
  px /= pl; py /= pl; pz /= pl;
  const s = L / n;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    S(x0 + dx * t, y0 + dy * t, z0 + dz * t, ux, uy, uz, px, py, pz, s * 0.6, w, w, r, g, b, a);
  }
}

/** Grid of splats over a rectangle from corner o along unit axes u and v. fn returns a Color or null to skip. */
export function panel(
  ox: number, oy: number, oz: number,
  ux: number, uy: number, uz: number,
  vx: number, vy: number, vz: number,
  w: number, h: number, sp: number,
  fn: (fu: number, fv: number, x: number, y: number, z: number) => Color | null,
  sn = 0.02,
): void {
  const nu = Math.max(1, Math.round(w / sp)), nv = Math.max(1, Math.round(h / sp));
  const su = w / nu, sv = h / nv;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const fu = (i + 0.5 + (rng() - 0.5) * 0.25) / nu;
      const fv = (j + 0.5 + (rng() - 0.5) * 0.25) / nv;
      const x = ox + ux * fu * w + vx * fv * h;
      const y = oy + uy * fu * w + vy * fv * h;
      const z = oz + uz * fu * w + vz * fv * h;
      const c = fn(fu, fv, x, y, z);
      if (c) SC(x, y, z, ux, uy, uz, vx, vy, vz, su * 0.66, sv * 0.66, sn, c);
    }
  }
}

// ---- 2D drawings -------------------------------------------------------------

/**
 * A rectangle of a drawing, in the drawing's own pixels, that wants finer splats than the rest:
 * px is the resolution it wants across its height (an image's own pixel count, say).
 */
export interface Detail { x: number; y: number; w: number; h: number; px: number }

let marks: Detail[] | null = null;
let imageSpacing = 0;

/** Called by a drawing while it's rasterised: asks for this rectangle at px pixels tall. */
export function markDetail(x: number, y: number, w: number, h: number, px: number): void {
  marks?.push({ x, y, w, h, px });
}

/**
 * Closest spacing (metres) detail rectangles are splatted at. 0 gives images their own pixel
 * count everywhere; above 0, small images stop where finer splats couldn't be seen anyway.
 */
export function setImageSpacing(metres: number): void {
  imageSpacing = metres;
}

export interface Raster {
  px: Uint8ClampedArray;
  /** Rectangles the drawing marked for finer splats. */
  detail: Detail[];
}

function context(width: number, height: number): CanvasRenderingContext2D {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable.');
  return ctx;
}

/** Draws into an offscreen canvas and returns its RGBA pixels and the rectangles it marked for detail. */
export function rasterize(width: number, height: number, draw: Draw2D): Raster {
  const ctx = context(width, height), detail: Detail[] = [];
  marks = detail;
  try {
    draw(ctx, width, height);
  } finally {
    marks = null;
  }
  return { px: ctx.getImageData(0, 0, width, height).data, detail };
}

/** Pixel bounds of a detail rectangle (grown by a pixel) and how many times finer it's redrawn. */
interface Tile { x0: number; y0: number; x1: number; y1: number; f: number }

/** pxSize is the height of one of the drawing's pixels in metres. */
function planTiles(detail: Detail[], W: number, H: number, pxSize: number): Tile[] {
  const tiles: Tile[] = [];
  for (const d of detail) {
    const x0 = Math.max(0, Math.floor(d.x) - 1), y0 = Math.max(0, Math.floor(d.y) - 1);
    const x1 = Math.min(W, Math.ceil(d.x + d.w) + 1), y1 = Math.min(H, Math.ceil(d.y + d.h) + 1);
    if (x1 <= x0 || y1 <= y0) continue; // drawn off the edge of the canvas
    const px = imageSpacing > 0 ? Math.min(d.px, (d.h * pxSize) / imageSpacing) : d.px;
    tiles.push({ x0, y0, x1, y1, f: Math.max(1, Math.round(px / d.h)) });
  }
  return tiles;
}

type Emit = (x: number, y: number, size: number, r: number, g: number, b: number, a: number) => void;

/**
 * Redraws one tile of a drawing f times finer and turns it into splats. Flat areas merge into
 * larger splats, so edges get fine splats without paying for them everywhere: a block merges
 * when it and a margin of half its size around it are one colour, so the larger splat's soft
 * edge only ever lies over that same colour. emit gets centres and sizes in the drawing's pixels.
 */
function tileSplats(W: number, H: number, draw: Draw2D, t: Tile, emit: Emit): void {
  const tw = (t.x1 - t.x0) * t.f, th = (t.y1 - t.y0) * t.f, ctx = context(tw, th);
  ctx.setTransform(t.f, 0, 0, t.f, -t.x0 * t.f, -t.y0 * t.f);
  draw(ctx, W, H);
  const px = ctx.getImageData(0, 0, tw, th).data, TOL = 4, MAX = 32;
  const flat = (bx: number, by: number, b: number): boolean => {
    const m = b >> 1, q0 = (by * tw + bx) * 4, r0 = px[q0]!, g0 = px[q0 + 1]!, b0 = px[q0 + 2]!, a0 = px[q0 + 3]!;
    const xa = Math.max(0, bx - m), xb = Math.min(tw, bx + b + m), ya = Math.max(0, by - m), yb = Math.min(th, by + b + m);
    for (let y = ya; y < yb; y++) {
      for (let x = xa, q = (y * tw + xa) * 4; x < xb; x++, q += 4) {
        if (Math.abs(px[q]! - r0) > TOL || Math.abs(px[q + 1]! - g0) > TOL || Math.abs(px[q + 2]! - b0) > TOL || Math.abs(px[q + 3]! - a0) > TOL) return false;
      }
    }
    return true;
  };
  const visit = (bx: number, by: number, b: number): void => {
    if (bx >= tw || by >= th) return;
    if (b > 1 && (bx + b > tw || by + b > th || !flat(bx, by, b))) {
      const hb = b >> 1;
      visit(bx, by, hb);
      visit(bx + hb, by, hb);
      visit(bx, by + hb, hb);
      visit(bx + hb, by + hb, hb);
      return;
    }
    const q = (by * tw + bx) * 4;
    if (px[q + 3]! < 10) return;
    emit(t.x0 + (bx + b / 2) / t.f, t.y0 + (by + b / 2) / t.f, b / t.f, px[q]! / 255, px[q + 1]! / 255, px[q + 2]! / 255, px[q + 3]! / 255);
  };
  for (let by = 0; by < th; by += MAX) for (let bx = 0; bx < tw; bx += MAX) visit(bx, by, MAX);
}

/**
 * Places one splat of a drawing: its centre (X, Y) and size in the drawing's own pixels, how far
 * behind the drawing's face it sits (metres), and its colour.
 */
export type Placer = (X: number, Y: number, size: number, back: number, r: number, g: number, b: number, a: number) => void;

/**
 * Turns a rasterised drawing into splats: one per pixel, except over the rectangles it marked for
 * detail, which are redrawn finer. Inside a mirror-floor reflection range, those rectangles also keep
 * their coarse pixels for the reflection to copy (buildReflections then removes them), and the
 * fine splats stay out of the reflection. pxSize is the height of one of the drawing's pixels in
 * metres.
 */
export function splatDrawing(raster: Raster, W: number, H: number, pxSize: number, draw: Draw2D, place: Placer): void {
  const { px, detail } = raster, tiles = planTiles(detail, W, H, pxSize), proxies = reflecting > 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const q = (j * W + i) * 4;
      if (px[q + 3]! < 10) continue;
      const tiled = tiles.some((t) => i >= t.x0 && i < t.x1 && j >= t.y0 && j < t.y1);
      if (tiled && !proxies) continue;
      place(i + 0.5, j + 0.5, 1, tiled ? 0.03 : 0, px[q]! / 255, px[q + 1]! / 255, px[q + 2]! / 255, px[q + 3]! / 255);
      if (tiled) standIns.push(store.count - 1);
    }
  }
  if (!tiles.length) return;
  const old = setJitter(0), start = store.count;
  tiles.forEach((t, ti) => {
    // Where a finer tile sits inside this one (a logo on a sharpened screen), it wins.
    const finer = tiles.filter((o, oi) => oi !== ti && o.f > t.f);
    tileSplats(W, H, draw, t, (X, Y, size, r, g, b, a) => {
      if (!finer.some((o) => X >= o.x0 && X < o.x1 && Y >= o.y0 && Y < o.y1)) place(X, Y, size, 0, r, g, b, a);
    });
  });
  setJitter(old);
  if (proxies) noMirror.push([start, store.count]);
}

/**
 * A 2D drawing laid on a rectangle (origin = bottom-left corner): a splat per pixel, plus its
 * detail. detail > 1 splats the whole drawing that many times finer (sharper lettering), with
 * flat areas merged as for images.
 */
export function canvasPanel(o: Vec3, u: Vec3, v: Vec3, w: number, h: number, sp: number, draw: Draw2D, gain = 1, alpha = 1, detail = 1): void {
  const nu = Math.max(2, Math.round(w / sp)), nv = Math.max(2, Math.round(h / sp));
  const su = w / nu, sv = h / nv;
  // The side the drawing reads correctly from.
  const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
  const old = setJitter(0.02);
  glow(gain);
  const raster = rasterize(nu, nv, draw);
  if (detail > 1) raster.detail.unshift({ x: 0, y: 0, w: nu, h: nv, px: nv * detail });
  splatDrawing(raster, nu, nv, sv, draw, (X, Y, size, back, r, g, b, a) => {
    const fu = X / nu, fv = 1 - Y / nv;
    S(
      o[0] + u[0] * fu * w + v[0] * fv * h - nx * back,
      o[1] + u[1] * fu * w + v[1] * fv * h - ny * back,
      o[2] + u[2] * fu * w + v[2] * fv * h - nz * back,
      u[0], u[1], u[2], v[0], v[1], v[2],
      su * 0.64 * size, sv * 0.64 * size, 0.02,
      r, g, b, alpha * a,
    );
  });
  glow(1);
  setJitter(old);
}

// ---- Mirror-floor reflections -----------------------------------------------

const mirrorRanges: [number, number][] = [];
/** Splats inside mirrored ranges that stay out of the reflection (fine detail with coarse stand-ins). */
const noMirror: [number, number][] = [];
/** The coarse stand-ins themselves: the reflection copies them, then they're removed. */
const standIns: number[] = [];
let reflecting = 0;

export function resetReflections(): void {
  mirrorRanges.length = 0;
  noMirror.length = 0;
  standIns.length = 0;
  reflecting = 0;
}

/** Marks the start of splats that should also appear mirrored in a glossy floor at y = 0; call the result to close the range. */
export function reflectFrom(): () => void {
  const start = store.count;
  reflecting++;
  return () => {
    reflecting--;
    mirrorRanges.push([start, store.count]);
  };
}

/** Appends a blurred, faded mirror image (y → -y) of every marked splat above the floor. */
export function buildReflections(fade: number, blur: number): void {
  for (const [start, end] of mirrorRanges) {
    const skip = noMirror.filter(([a, b]) => a < end && b > start);
    for (let i = start; i < end; i++) {
      if (store.pos[i * 3 + 1]! > 0.05 && !skip.some(([a, b]) => i >= a && i < b)) mirror(i, fade, blur);
    }
  }
  // The coarse stand-ins behind fine detail have done their job; drawing them too would be waste.
  removeSplats(standIns);
  standIns.length = 0;
}

function mirror(i: number, fade: number, blur: number): void {
  const s = store;
  if (s.count >= s.capacity) s.reserve(1);
  const j = s.count++;
  const a = i * 3, b = j * 3, c = i * 6, d = j * 6;
  s.pos[b] = s.pos[a]!;
  s.pos[b + 1] = -s.pos[a + 1]!;
  s.pos[b + 2] = s.pos[a + 2]!;
  // Reflecting y flips the sign of the xy and yz covariance terms.
  s.cov[d] = s.cov[c]! * blur;
  s.cov[d + 1] = -s.cov[c + 1]! * blur;
  s.cov[d + 2] = s.cov[c + 2]! * blur;
  s.cov[d + 3] = s.cov[c + 3]! * blur;
  s.cov[d + 4] = -s.cov[c + 4]! * blur;
  s.cov[d + 5] = s.cov[c + 5]! * blur;
  for (let k = 0; k < 3; k++) s.col[j * 4 + k] = (s.col[i * 4 + k]! * 0.85) | 0;
  s.col[j * 4 + 3] = (s.col[i * 4 + 3]! * fade) | 0;
  s.em[j] = s.em[i]!;
  s.nrm[j] = s.nrm[i]!;
}
