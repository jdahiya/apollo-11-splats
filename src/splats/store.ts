/**
 * Structure-of-arrays storage for every splat in the scene.
 *
 *   pos  xyz position
 *   cov  upper triangle of the 3D covariance: xx xy xz yy yz zz
 *   col  RGBA8: the degree-0 colour (0.5 + C0 · f_dc) and opacity
 */
export class SplatStore {
  count = 0;
  capacity = 0;
  pos = new Float32Array(0);
  cov = new Float32Array(0);
  col = new Uint8Array(0);

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
    this.pos = pos;
    this.cov = cov;
    this.col = col;
    this.capacity = cap;
  }
}

export const store = new SplatStore();

/** How a capture was trained to be filtered (Kerbl et al. 2024 update / Mip-Splatting). */
export type AntiAliasing = 'none' | 'aa' | 'mip';

/** Per-capture rendering data. */
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

const byte = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/** Appends one splat from its covariance terms, colour and opacity. */
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
  s.col[q] = byte(r);
  s.col[q + 1] = byte(g);
  s.col[q + 2] = byte(b);
  s.col[q + 3] = byte(a);
}
