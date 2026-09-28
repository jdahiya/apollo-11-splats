// Checks both orderings in dist/sort.wasm against plain JavaScript: every index must appear
// exactly once, and keys must be non-decreasing to within one bucket (plus f32 rounding).
// Usage: npm run build && npm test
import { readFile } from 'node:fs/promises';

const BUCKETS = 1 << 20;
const bytes = await readFile(new URL('../dist/sort.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, { env: { abort: () => { throw new Error('abort'); } } });
const { memory, sort, sortDistance, heapBase } = instance.exports;

const n = 400_000;
const base = (heapBase() + 15) & ~15;
const pos = base, keys = pos + n * 12, counts = keys + n * 4, out = counts + BUCKETS * 4;
const need = out + n * 4;
if (need > memory.buffer.byteLength) memory.grow(Math.ceil((need - memory.buffer.byteLength) / 65536));
const P = new Float32Array(memory.buffer, pos, n * 3);
for (let i = 0; i < P.length; i++) P[i] = Math.random() * 1600 - 800;

function check(name, run, keyOf) {
  const t0 = performance.now();
  run();
  const ms = performance.now() - t0;
  const order = new Uint32Array(memory.buffer, out, n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    lo = Math.min(lo, k);
    hi = Math.max(hi, k);
  }
  const bucket = (hi - lo) / (BUCKETS - 1), slack = Math.max(Math.abs(lo), Math.abs(hi)) * 1e-6;
  const seen = new Uint8Array(n);
  let prev = -Infinity, worst = 0, missing = 0;
  for (let j = 0; j < n; j++) {
    const i = order[j];
    seen[i]++;
    const k = keyOf(i);
    if (k < prev) worst = Math.max(worst, prev - k);
    prev = Math.max(prev, k);
  }
  for (let i = 0; i < n; i++) if (seen[i] !== 1) missing++;
  const ok = !missing && worst <= bucket + slack;
  console.log(`${name}: ${n.toLocaleString()} splats in ${ms.toFixed(1)} ms, index errors ${missing}, worst inversion ${worst.toFixed(5)} (bucket ${bucket.toFixed(5)} + f32 slack ${slack.toFixed(5)}) ${ok ? 'ok' : 'FAILED'}`);
  return ok;
}

const row = [0.3, -0.5, 0.81, 12.5];
const eye = [12, 30, -40];
const depthOk = check('view depth', () => sort(n, pos, keys, counts, out, ...row), (i) => row[0] * P[i * 3] + row[1] * P[i * 3 + 1] + row[2] * P[i * 3 + 2] + row[3]);
const distOk = check('camera distance', () => sortDistance(n, pos, keys, counts, out, ...eye), (i) => -Math.hypot(P[i * 3] - eye[0], P[i * 3 + 1] - eye[1], P[i * 3 + 2] - eye[2]));
if (!depthOk || !distOk) {
  console.error('sort check failed');
  process.exit(1);
}
console.log('sort check passed');
