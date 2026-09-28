import { HALF_ONE, toHalf } from '../util/half';
import { rng } from '../util/random';

/**
 * Structure-of-arrays storage for every splat in the scene.
 *
 *   pos  xyz position
 *   cov  upper triangle of the 3D covariance: xx xy xz yy yz zz
 *   col  RGBA8 colour
 *   em   half-float brightness gain; above 1 the splat is emissive and skips lighting
 *   nrm  octahedral surface normal (2 × 8 bits), 0 when the splat has no clear facing
 */
export class SplatStore {
  count = 0;
  capacity = 0;
  pos = new Float32Array(0);
  cov = new Float32Array(0);
  col = new Uint8Array(0);
  em = new Uint16Array(0);
  nrm = new Uint16Array(0);

  reserve(extra: number): void {
    const need = this.count + extra;
    if (need <= this.capacity) return;
    const cap = Math.max(this.capacity * 2, need, 1 << 17);
    const n = this.count;
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos.subarray(0, n * 3));
    const cov = new Float32Array(cap * 6);
    cov.set(this.cov.subarray(0, n * 6));
    const col = new Uint8Array(cap * 4);
    col.set(this.col.subarray(0, n * 4));
    const em = new Uint16Array(cap);
    em.set(this.em.subarray(0, n));
    const nrm = new Uint16Array(cap);
    nrm.set(this.nrm.subarray(0, n));
    this.pos = pos;
    this.cov = cov;
    this.col = col;
    this.em = em;
    this.nrm = nrm;
    this.capacity = cap;
  }
}

export const store = new SplatStore();

/** Removes the splats at the given (ascending) indices, keeping the rest in order. */
export function removeSplats(indices: readonly number[]): void {
  if (!indices.length) return;
  const s = store;
  let w = 0, r = 0;
  for (let i = 0; i < s.count; i++) {
    if (r < indices.length && indices[r] === i) {
      r++;
      continue;
    }
    if (w !== i) {
      s.pos.copyWithin(w * 3, i * 3, i * 3 + 3);
      s.cov.copyWithin(w * 6, i * 6, i * 6 + 6);
      s.col.copyWithin(w * 4, i * 4, i * 4 + 4);
      s.em[w] = s.em[i]!;
      s.nrm[w] = s.nrm[i]!;
    }
    w++;
  }
  s.count = w;
}

/** How a capture was trained to be filtered (Kerbl et al. 2024 update / Mip-Splatting). */
export type AntiAliasing = 'none' | 'aa' | 'mip';

/**
 * Per-asset rendering data that only loaded captures use; the generated scene leaves it at
 * its defaults.
 */
export interface AssetInfo {
  /** Degree of the view-dependent colour (spherical harmonics): 0 = base colour only, up to 3. */
  shDegree: number;
  /** Half-float coefficients beyond the base colour, RGB interleaved per coefficient, `shTexels` × 8 per splat. */
  sh: Uint16Array | null;
  shTexels: number;
  /** Rotation (column-major 3×3) taking world directions into the capture's own axes. */
  shRot: Float32Array;
  aa: AntiAliasing;
  /** Colours are linear (glTF lin_rec709_display) rather than display sRGB. */
  linear: boolean;
}

export const asset: AssetInfo = { shDegree: 0, sh: null, shTexels: 0, shRot: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), aa: 'none', linear: false };

export function resetAsset(): void {
  asset.shDegree = 0;
  asset.sh = null;
  asset.shTexels = 0;
  asset.shRot = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  asset.aa = 'none';
  asset.linear = false;
}

/** Coefficients per colour channel beyond the base colour, for degrees 0–3. */
export const SH_COEFFS = [0, 3, 8, 15] as const;

/** Allocates SH storage for `count` splats at `degree`: 512 splats per texture row. */
export function allocateSh(count: number, degree: number): void {
  asset.shDegree = degree;
  asset.shTexels = degree ? Math.ceil((SH_COEFFS[degree as 0 | 1 | 2 | 3] * 3) / 8) : 0;
  asset.sh = degree ? new Uint16Array(Math.max(1, Math.ceil(count / 512)) * 512 * asset.shTexels * 8) : null;
}

// Emission state, applied to every splat written until changed.
let gainBits = HALF_ONE;
let normalBits = 0;
let jitter = 0.07;

/** Sets the brightness gain for following splats. 1 is a lit surface; above 1 glows and blooms. */
export function glow(gain: number): void {
  gainBits = gain === 1 ? HALF_ONE : toHalf(gain);
}

/** Sets the random colour variation for following splats and returns the previous amount. */
export function setJitter(amount: number): number {
  const old = jitter;
  jitter = amount;
  return old;
}

export function setNormalBits(bits: number): void {
  normalBits = bits;
}

const byte = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/** Appends one splat from its covariance terms. Most code uses the shaped helpers in primitives.ts. */
export function put(
  x: number, y: number, z: number,
  xx: number, xy: number, xz: number, yy: number, yz: number, zz: number,
  r: number, g: number, b: number, a: number,
): void {
  const s = store;
  if (s.count >= s.capacity) s.reserve(1);
  const i = s.count++;
  const p = i * 3, c = i * 6, q = i * 4;
  s.pos[p] = x;
  s.pos[p + 1] = y;
  s.pos[p + 2] = z;
  s.cov[c] = xx;
  s.cov[c + 1] = xy;
  s.cov[c + 2] = xz;
  s.cov[c + 3] = yy;
  s.cov[c + 4] = yz;
  s.cov[c + 5] = zz;
  const j = 1 + (rng() - 0.5) * jitter;
  s.col[q] = byte(r * j);
  s.col[q + 1] = byte(g * j);
  s.col[q + 2] = byte(b * j);
  s.col[q + 3] = byte(a);
  s.em[i] = gainBits;
  s.nrm[i] = normalBits;
}
