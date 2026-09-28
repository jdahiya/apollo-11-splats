const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

/** Half-float bits for 1.0: the default brightness gain of a splat. */
export const HALF_ONE = 0x3c00;

/** Converts a number to IEEE 754 binary16 bits, matching unpackHalf2x16 on the GPU. */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = i32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | ((m + 0x1000) >> 13);
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 31;
  const m = h & 1023;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * 2 ** (e - 15) * (1 + m / 1024);
}
