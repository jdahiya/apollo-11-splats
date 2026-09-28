// Voxel grids for the ray tracer. Each voxel stores how much of it the splats cover (alpha)
// and how much light emissive splats give off inside it (RGB). The ground is solid below its
// surface and Eagle's two stages are solid inside, so light can't leak through either.
import type { SplatStore } from '../splats/store';
import { fromHalf } from '../util/half';

export interface GridData {
  x0: number;
  y0: number;
  z0: number;
  /** Voxel edge length in metres. */
  v: number;
  nx: number;
  ny: number;
  nz: number;
  /** nx × ny × nz voxels, x fastest; RGB = emitted light, A = occupancy. */
  geo: Uint8Array;
  /** RGB = average surface colour of the splats in the voxel, A = their coverage (0 for solid fill). */
  alb: Uint8Array;
}

/** What the scene tells the voxeliser about solid matter the splats only skin. */
export interface Solids {
  /** Height of the ground at (x, z). */
  ground(x: number, z: number): number;
  /** Whether (x, y, z) is inside something solid above the ground. */
  inside(x: number, y: number, z: number): boolean;
}

/** The fine grid covers the landing site; the coarse grid the plain around it. */
const FINE: [number, number, number, number, number, number] = [-48, -4, -48, 48, 12, 48];
const COARSE: [number, number, number, number, number, number] = [-420, -24, -420, 420, 36, 420];

interface Accum {
  x0: number; y0: number; z0: number; v: number; nx: number; ny: number; nz: number;
  occ: Float32Array; er: Float32Array; eg: Float32Array; eb: Float32Array;
  ar: Float32Array; ag: Float32Array; ab: Float32Array; solid: Uint8Array;
}

function makeGrid(bounds: readonly number[], voxel: number, maxDim: number): Accum {
  const [x0, y0, z0, x1, y1, z1] = bounds as [number, number, number, number, number, number];
  let v = voxel;
  while (Math.max((x1 - x0) / v, (y1 - y0) / v, (z1 - z0) / v) > maxDim) v *= 1.25;
  const nx = Math.ceil((x1 - x0) / v), ny = Math.ceil((y1 - y0) / v), nz = Math.ceil((z1 - z0) / v), n = nx * ny * nz;
  const f = (): Float32Array => new Float32Array(n);
  return { x0, y0, z0, v, nx, ny, nz, occ: f(), er: f(), eg: f(), eb: f(), ar: f(), ag: f(), ab: f(), solid: new Uint8Array(n) };
}

const contains = (g: Accum, x: number, y: number, z: number): boolean =>
  x >= g.x0 && y >= g.y0 && z >= g.z0 && x < g.x0 + g.nx * g.v && y < g.y0 + g.ny * g.v && z < g.z0 + g.nz * g.v;

function index(g: Accum, x: number, y: number, z: number): number {
  const ix = Math.floor((x - g.x0) / g.v), iy = Math.floor((y - g.y0) / g.v), iz = Math.floor((z - g.z0) / g.v);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) return -1;
  return ix + g.nx * (iy + g.ny * iz);
}

/** Splats [0, end) go into the grids; the ones after it (the landing dust) don't. */
function splat(s: SplatStore, end: number, fine: Accum, coarse: Accum): void {
  for (let i = 0; i < end; i++) {
    const x = s.pos[i * 3]!, y = s.pos[i * 3 + 1]!, z = s.pos[i * 3 + 2]!;
    const g = contains(fine, x, y, z) ? fine : coarse;
    if (g === coarse && !contains(coarse, x, y, z)) continue;
    const c = i * 6;
    const xx = s.cov[c]!, xy = s.cov[c + 1]!, xz = s.cov[c + 2]!, yy = s.cov[c + 3]!, yz = s.cov[c + 4]!, zz = s.cov[c + 5]!;
    // Sum of the covariance's 2×2 principal minors ≈ (σ1σ2)² for a flat splat: its area.
    const area = 4 * Math.sqrt(Math.max(xx * yy - xy * xy + xx * zz - xz * xz + yy * zz - yz * yz, 0));
    const w = ((s.col[i * 4 + 3]! / 255) * area) / (g.v * g.v);
    if (w <= 0) continue;
    const gain = fromHalf(s.em[i]!);
    const emit = gain > 1.05 ? gain : 0;
    const r = s.col[i * 4]! / 255, gr = s.col[i * 4 + 1]! / 255, b = s.col[i * 4 + 2]! / 255;
    const er = emit * r, eg = emit * gr, eb = emit * b;
    const ra = emit ? 0.1 : r, ga = emit ? 0.1 : gr, ba = emit ? 0.1 : b;
    // Large splats spread over the voxels they span.
    const sx = Math.sqrt(xx), sy = Math.sqrt(yy), sz = Math.sqrt(zz);
    const mx = Math.min(3, Math.ceil((2 * sx) / g.v)), my = Math.min(3, Math.ceil((2 * sy) / g.v)), mz = Math.min(3, Math.ceil((2 * sz) / g.v));
    const share = w / (mx * my * mz);
    for (let a = 0; a < mx; a++) {
      for (let b = 0; b < my; b++) {
        for (let q = 0; q < mz; q++) {
          const k = index(g, x + ((a + 0.5) / mx - 0.5) * 2 * sx, y + ((b + 0.5) / my - 0.5) * 2 * sy, z + ((q + 0.5) / mz - 0.5) * 2 * sz);
          if (k < 0) continue;
          g.occ[k]! += share;
          g.ar[k]! += ra * share;
          g.ag[k]! += ga * share;
          g.ab[k]! += ba * share;
          if (emit) {
            g.er[k]! += er * share;
            g.eg[k]! += eg * share;
            g.eb[k]! += eb * share;
          }
        }
      }
    }
  }
}

/** Marks voxels solid below the ground's surface and inside solid things. */
function fillSolids(g: Accum, solids: Solids): void {
  for (let iz = 0; iz < g.nz; iz++) {
    const z = g.z0 + (iz + 0.5) * g.v;
    for (let ix = 0; ix < g.nx; ix++) {
      const x = g.x0 + (ix + 0.5) * g.v, top = solids.ground(x, z) - 0.6 * g.v;
      for (let iy = 0; iy < g.ny; iy++) {
        const y = g.y0 + (iy + 0.5) * g.v;
        if (y < top || solids.inside(x, y, z)) g.solid[ix + g.nx * (iy + g.ny * iz)] = 1;
      }
    }
  }
}

function pack(g: Accum): GridData {
  const n = g.nx * g.ny * g.nz, geo = new Uint8Array(n * 4), alb = new Uint8Array(n * 4);
  const byte = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);
  for (let k = 0; k < n; k++) {
    const occ = g.occ[k]!;
    geo[k * 4] = byte(g.er[k]! * 0.4);
    geo[k * 4 + 1] = byte(g.eg[k]! * 0.4);
    geo[k * 4 + 2] = byte(g.eb[k]! * 0.4);
    geo[k * 4 + 3] = g.solid[k] ? 255 : byte(1 - Math.exp(-1.4 * occ));
    if (occ > 0) {
      alb[k * 4] = byte(g.ar[k]! / occ);
      alb[k * 4 + 1] = byte(g.ag[k]! / occ);
      alb[k * 4 + 2] = byte(g.ab[k]! / occ);
      alb[k * 4 + 3] = byte(occ);
    }
  }
  return { x0: g.x0, y0: g.y0, z0: g.z0, v: g.v, nx: g.nx, ny: g.ny, nz: g.nz, geo, alb };
}

/** Voxelises splats [0, end) with the given voxel sizes, keeping each dimension within max3D. */
export function buildVoxelGrids(s: SplatStore, end: number, solids: Solids, fineVoxel: number, coarseVoxel: number, max3D: number): { fine: GridData; coarse: GridData } {
  const fine = makeGrid(FINE, fineVoxel, max3D), coarse = makeGrid(COARSE, coarseVoxel, max3D);
  splat(s, end, fine, coarse);
  fillSolids(fine, solids);
  fillSolids(coarse, solids);
  return { fine: pack(fine), coarse: pack(coarse) };
}
