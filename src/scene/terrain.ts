// The Sea of Tranquility round Tranquility Base: fine grey regolith pocked with craters of every
// size, scattered rocks, Little West crater 60 m east of Eagle, the big West crater that Eagle
// flew over on the way in, and the ground under Eagle scoured by its engine. x is east, z south.
import { clamp, type RGB } from '../util/math';
import { hash, reseed, rng, rr } from '../util/random';
import { S } from '../splats/primitives';

interface Crater { x: number; z: number; r: number; depth: number; rim: number }

/** Craters up to 12 m across are bucketed on a grid; bigger ones are few and checked directly. */
const CELL = 16;
const small = new Map<number, Crater[]>();
let big: Crater[] = [];

const cellKey = (ix: number, iz: number): number => (ix + 4096) * 8192 + (iz + 4096);

/** Places that should stay flat and clear: where Eagle stands, and where the moonwalk's things go. */
const CLEAR: [number, number, number][] = [[0, 0, 8], [-8, -8, 2.5], [-6, -20, 2], [-4, 16, 5], [-6.5, -6, 1.5]];

export const LITTLE_WEST = { x: 60, z: 0, r: 15 };

function add(c: Crater): void {
  if (c.r > 6) {
    big.push(c);
    return;
  }
  const reach = c.r * 2.2;
  for (let ix = Math.floor((c.x - reach) / CELL); ix <= Math.floor((c.x + reach) / CELL); ix++) {
    for (let iz = Math.floor((c.z - reach) / CELL); iz <= Math.floor((c.z + reach) / CELL); iz++) {
      const k = cellKey(ix, iz);
      const list = small.get(k);
      if (list) list.push(c);
      else small.set(k, [c]);
    }
  }
}

/** Lays out the craters (deterministically). Call before anything asks for the ground height. */
export function makeCraters(): void {
  reseed(1969);
  small.clear();
  big = [];
  add({ ...LITTLE_WEST, depth: 4, rim: 0.7 });
  add({ x: 400, z: 30, r: 92, depth: 18, rim: 3 }); // West crater
  const clear = (x: number, z: number, r: number): boolean => CLEAR.every(([cx, cz, cr]) => Math.hypot(x - cx, z - cz) > cr + r * 1.4);
  // Power-law sizes: many small craters near the site, fewer and bigger ones further out.
  const scatter = (count: number, radius: number, rMin: number, rMax: number): void => {
    for (let i = 0; i < count; i++) {
      const a = rng() * 2 * Math.PI, d = Math.sqrt(rng()) * radius, x = Math.cos(a) * d, z = Math.sin(a) * d;
      const r = Math.min(rMax, rMin / Math.pow(rng(), 0.55));
      if (!clear(x, z, r) || Math.hypot(x - LITTLE_WEST.x, z - LITTLE_WEST.z) < LITTLE_WEST.r + r) continue;
      const fresh = rng() < 0.3; // fresh craters are deep with sharp rims; old ones are worn shallow
      add({ x, z, r, depth: r * (fresh ? 0.42 : rr(0.12, 0.25)), rim: r * (fresh ? 0.1 : 0.04) });
    }
  };
  scatter(1600, 70, 0.15, 1.5);
  scatter(420, 420, 1.2, 6);
  scatter(90, 1600, 6, 40);
}

/** Gentle swells of the mare surface. */
function swell(x: number, z: number): [number, number, number] {
  const a = 0.35, fx = 1 / 47, fz = 1 / 61, gx2 = 1 / 23, gz2 = 1 / 29;
  const h = a * Math.sin(x * fx + 1.3) * Math.cos(z * fz - 0.4) + 0.12 * Math.sin(x * gx2 + z * gz2 * 0.7);
  const dx = a * fx * Math.cos(x * fx + 1.3) * Math.cos(z * fz - 0.4) + 0.12 * gx2 * Math.cos(x * gx2 + z * gz2 * 0.7);
  const dz = -a * fz * Math.sin(x * fx + 1.3) * Math.sin(z * fz - 0.4) + 0.12 * gz2 * 0.7 * Math.cos(x * gx2 + z * gz2 * 0.7);
  return [h, dx, dz];
}

function craterTerm(c: Crater, x: number, z: number, out: [number, number, number]): void {
  const dx = x - c.x, dz = z - c.z, dist = Math.hypot(dx, dz), d = dist / c.r;
  if (d > 2.2) return;
  // A bowl inside the rim and a raised rim that fades into the ejecta outside it.
  let h = 0, dh = 0;
  if (d < 1) {
    h -= c.depth * (1 - d * d);
    dh += (2 * c.depth * d) / c.r;
  }
  const w = 0.3, e = Math.exp(-(((d - 1) / w) ** 2));
  h += c.rim * e;
  dh += (c.rim * e * (-2 * (d - 1))) / (w * w * c.r);
  out[0] += h;
  if (dist > 1e-6) {
    out[1] += (dh * dx) / dist;
    out[2] += (dh * dz) / dist;
  }
}

/** Ground height at (x, z) and its slope (dh/dx, dh/dz). The site round Eagle is kept level. */
export function groundFrame(x: number, z: number): [number, number, number] {
  const out = swell(x, z);
  const list = small.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (list) for (const c of list) craterTerm(c, x, z, out);
  for (const c of big) craterTerm(c, x, z, out);
  // Level where Eagle stands.
  const r = Math.hypot(x, z), flat = clamp((r - 5) / 5, 0, 1), f = flat * flat * (3 - 2 * flat);
  return [out[0] * f, out[1] * f, out[2] * f];
}

export const groundAt = (x: number, z: number): number => groundFrame(x, z)[0];

/** The Moon's curvature: the ground drops away toward the close horizon. */
const drop = (r: number): number => (r * r) / (2 * 1737400);

const SOIL: RGB = [0.58, 0.56, 0.52];

function soilColor(x: number, z: number, r: number): RGB {
  // Broad patches of slightly lighter and darker soil, and fine grain.
  const patch = 0.92 + 0.08 * Math.sin(x * 0.071 + Math.sin(z * 0.053) * 2) * Math.cos(z * 0.067 - x * 0.021);
  let b = patch * (0.88 + 0.24 * hash(Math.floor(x * 7.3), Math.floor(z * 7.3), 3));
  // Under Eagle the engine blew the top dust away in streaks.
  if (r < 11) {
    const streak = Math.sin(Math.atan2(z, x) * 23 + r * 0.8) * 0.5 + 0.5;
    b *= 1 + (0.05 + 0.12 * streak) * (1 - clamp((r - 3) / 8, 0, 1));
  }
  return [SOIL[0] * b, SOIL[1] * b, SOIL[2] * b * 0.98];
}

/** One ring of ground splats between radii r0 and r1, spaced sp metres. */
function ring(r0: number, r1: number, sp: number, tilt: number): void {
  for (let x = -r1 + sp / 2; x < r1; x += sp) {
    for (let z = -r1 + sp / 2; z < r1; z += sp) {
      const px = x + (rng() - 0.5) * sp * 0.3, pz = z + (rng() - 0.5) * sp * 0.3, r = Math.hypot(px, pz);
      if (r < r0 || r >= r1) continue;
      const [h, gx0, gz0] = groundFrame(px, pz);
      // Clods and pits too small to model tip each splat a little, which roughens the light.
      const gx = gx0 + (rng() - 0.5) * tilt, gz = gz0 + (rng() - 0.5) * tilt;
      // u along z and v along x, so the normal u × v points up.
      const ul = Math.hypot(gz, 1), ux = 0, uy = gz / ul, uz = 1 / ul;
      const dot = gx * uy / Math.hypot(1, gx);
      let vx = 1 / Math.hypot(1, gx), vy = gx / Math.hypot(1, gx), vz = 0;
      vx -= dot * ux;
      vy -= dot * uy;
      vz -= dot * uz;
      const vl = Math.hypot(vx, vy, vz);
      const c = soilColor(px, pz, r);
      S(px, h - drop(r), pz, ux, uy, uz, vx / vl, vy / vl, vz / vl, sp * 0.72, sp * 0.72, Math.min(0.03, sp * 0.1), c[0], c[1], c[2]);
    }
  }
}

/** The ground out to the horizon, finest round the site. k scales splat spacing. */
export function buildGround(k: number): void {
  reseed(7);
  ring(0, 26, 0.14 * k, 0.16);
  ring(26, 72, 0.3 * k, 0.12);
  ring(72, 220, 0.8 * k, 0.08);
  ring(220, 700, 2.4 * k, 0.05);
  ring(700, 2200, 8 * k, 0.03);
}

/** Rocks from pebbles to boulders, half buried; more round Little West and in West crater's ejecta. */
export function buildRocks(k: number): void {
  reseed(33);
  const rock = (x: number, z: number, size: number): void => {
    const h = groundAt(x, z) - drop(Math.hypot(x, z)), shade = rr(0.72, 1.02);
    const c: RGB = [0.44 * shade, 0.42 * shade, 0.39 * shade];
    const n = size > 0.25 ? 3 : size > 0.08 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI, ox = (rng() - 0.5) * size * 0.8, oz = (rng() - 0.5) * size * 0.8;
      const su = size * rr(0.6, 1), sv = size * rr(0.45, 0.8), sn = size * rr(0.35, 0.6);
      S(x + ox, h + sn * 0.5, z + oz, Math.cos(a), 0, Math.sin(a), 0, 1, 0, su, sn, sv, c[0], c[1], c[2]);
    }
  };
  const clearOf = (x: number, z: number): boolean => CLEAR.every(([cx, cz, cr]) => Math.hypot(x - cx, z - cz) > cr + 0.6);
  for (let i = 0; i < Math.round(3200 / k); i++) {
    const a = rng() * 2 * Math.PI, d = 4 + Math.pow(rng(), 1.8) * 420, x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (clearOf(x, z)) rock(x, z, 0.02 + Math.pow(rng(), 3.2) * 0.45);
  }
  for (let i = 0; i < 260; i++) {
    const a = rng() * 2 * Math.PI, d = LITTLE_WEST.r * rr(0.9, 1.8);
    rock(LITTLE_WEST.x + Math.cos(a) * d, LITTLE_WEST.z + Math.sin(a) * d, 0.04 + Math.pow(rng(), 2.5) * 0.6);
  }
  for (let i = 0; i < 380; i++) {
    const a = rng() * 2 * Math.PI, d = 92 * rr(0.95, 1.7);
    rock(400 + Math.cos(a) * d, 30 + Math.sin(a) * d, 0.2 + Math.pow(rng(), 2) * 2.2);
  }
}
