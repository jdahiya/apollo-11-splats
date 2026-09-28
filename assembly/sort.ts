// Depth sort for Gaussian splats, compiled to WebAssembly with AssemblyScript.
//
// Splats are blended back to front, so they are re-ordered whenever the camera moves.
// A 20-bit counting sort does this in four linear passes, which keeps a million-splat sort
// to a few milliseconds. Two orderings are offered:
//   sortDistance - by distance from the camera (the glTF KHR_gaussian_splatting default);
//                  turning the camera doesn't change it, only moving does.
//   sort         - by view-space depth (the original 3DGS rasteriser's ordering).

const BUCKETS: u32 = 1 << 20;

/** First free byte after the module's static data. The host lays out its buffers from here. */
export function heapBase(): usize {
  return __heap_base;
}

/**
 * Orders by view-space depth, farthest first.
 * depth = a·x + b·y + c·z + d is the view matrix's z row; the camera looks down -z.
 *
 * pos: n × (x, y, z) f32 · keys: n × 4 bytes scratch · counts: BUCKETS × 4 bytes scratch · out: n × u32
 */
export function sort(n: u32, pos: usize, keys: usize, counts: usize, out: usize, a: f32, b: f32, c: f32, d: f32): void {
  let lo = f32.MAX_VALUE;
  let hi = -f32.MAX_VALUE;
  for (let i: u32 = 0; i < n; i++) {
    const p = pos + <usize>i * 12;
    const z = a * load<f32>(p) + b * load<f32>(p, 4) + c * load<f32>(p, 8) + d;
    store<f32>(keys + (<usize>i << 2), z);
    lo = min(lo, z);
    hi = max(hi, z);
  }
  bucketSort(n, keys, counts, out, lo, hi);
}

/** Orders by distance from the camera at (cx, cy, cz), farthest first. Same buffers as sort(). */
export function sortDistance(n: u32, pos: usize, keys: usize, counts: usize, out: usize, cx: f32, cy: f32, cz: f32): void {
  let lo = f32.MAX_VALUE;
  let hi = -f32.MAX_VALUE;
  for (let i: u32 = 0; i < n; i++) {
    const p = pos + <usize>i * 12;
    const dx = load<f32>(p) - cx, dy = load<f32>(p, 4) - cy, dz = load<f32>(p, 8) - cz;
    const key = -sqrt<f32>(dx * dx + dy * dy + dz * dz); // negated so the farthest sorts first
    store<f32>(keys + (<usize>i << 2), key);
    lo = min(lo, key);
    hi = max(hi, key);
  }
  bucketSort(n, keys, counts, out, lo, hi);
}

/** Counting sort of the f32 keys in `keys` (ascending) into splat indices in `out`. */
function bucketSort(n: u32, keys: usize, counts: usize, out: usize, lo: f32, hi: f32): void {
  const scale: f32 = hi > lo ? <f32>(BUCKETS - 1) / (hi - lo) : 0;
  memory.fill(counts, 0, <usize>BUCKETS << 2);

  // Quantise each key to a bucket and count bucket sizes.
  for (let i: u32 = 0; i < n; i++) {
    const at = keys + (<usize>i << 2);
    const bucket = <u32>((load<f32>(at) - lo) * scale);
    store<u32>(at, bucket);
    const slot = counts + (<usize>bucket << 2);
    store<u32>(slot, load<u32>(slot) + 1);
  }

  // Exclusive prefix sum turns counts into each bucket's first output slot.
  let sum: u32 = 0;
  for (let i: u32 = 0; i < BUCKETS; i++) {
    const slot = counts + (<usize>i << 2);
    const size = load<u32>(slot);
    store<u32>(slot, sum);
    sum += size;
  }

  // Scatter indices into place; equal buckets keep their original order.
  for (let i: u32 = 0; i < n; i++) {
    const bucket = load<u32>(keys + (<usize>i << 2));
    const slot = counts + (<usize>bucket << 2);
    const at = load<u32>(slot);
    store<u32>(out + (<usize>at << 2), i);
    store<u32>(slot, at + 1);
  }
}
