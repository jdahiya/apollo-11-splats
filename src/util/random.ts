// Seeded randomness so every build of the scene is identical.

let state = 1;

export function reseed(seed: number): void {
  state = seed | 0;
}

/** mulberry32: fast, well-distributed 32-bit PRNG. Returns [0, 1). */
export function rng(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform in [a, b). */
export const rr = (a: number, b: number): number => a + (b - a) * rng();

export function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

/** Picks from [weight, value] pairs. */
export function wpick<T>(list: readonly (readonly [number, T])[]): T {
  let total = 0;
  for (const [w] of list) total += w;
  let r = rng() * total;
  for (const [w, v] of list) {
    r -= w;
    if (r <= 0) return v;
  }
  return list[list.length - 1]![1];
}

/** Stateless hash of three integers to [0, 1); used for stable per-panel variation. */
export function hash(a: number, b: number, c: number): number {
  let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, -1640531535);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
