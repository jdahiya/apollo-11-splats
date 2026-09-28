// Web Worker that orders splats back to front. Uses the WebAssembly module built from
// assembly/sort.ts, with a JavaScript fallback that runs the same 20-bit counting sort.
import type { Rigid, SortReply, SortRequest } from './protocol';

const BUCKETS = 1 << 20;

interface SortModule {
  memory: WebAssembly.Memory;
  heapBase(): number;
  sort(n: number, pos: number, keys: number, counts: number, out: number, a: number, b: number, c: number, d: number): void;
  sortDistance(n: number, pos: number, keys: number, counts: number, out: number, cx: number, cy: number, cz: number): void;
}

interface WorkerScope {
  postMessage(message: SortReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SortRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

let wasm: SortModule | null = null;
let booting: Promise<void> = Promise.resolve();
let n = 0;
let posPtr = 0, keysPtr = 0, countsPtr = 0, outPtr = 0;
let jsPositions: Float32Array | null = null;
/** The positions the rigid range had when loaded, so each sort can move them from rest. */
let rest: { start: number; end: number; pos: Float32Array } | null = null;
let moved = false;

async function boot(url: string): Promise<void> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { abort: () => { throw new Error('sort.wasm aborted'); } },
    });
    wasm = instance.exports as unknown as SortModule;
  } catch (err) {
    console.warn('WebAssembly sort unavailable; using JavaScript.', err);
    wasm = null;
  }
}

function load(count: number, positions: Float32Array): void {
  n = count;
  rest = null;
  moved = false;
  if (!wasm) {
    jsPositions = positions;
    return;
  }
  posPtr = (wasm.heapBase() + 15) & ~15;
  keysPtr = posPtr + n * 12;
  countsPtr = keysPtr + n * 4;
  outPtr = countsPtr + BUCKETS * 4;
  const need = outPtr + n * 4, have = wasm.memory.buffer.byteLength;
  if (need > have) wasm.memory.grow(Math.ceil((need - have) / 65536));
  new Float32Array(wasm.memory.buffer, posPtr, n * 3).set(positions.subarray(0, n * 3));
}

/** JavaScript fallback: same keys and counting sort as the WebAssembly module. */
function sortJs(keyOf: (x: number, y: number, z: number) => number): Uint32Array {
  const p = jsPositions!;
  const key = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = keyOf(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
    key[i] = k;
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  const scale = hi > lo ? (BUCKETS - 1) / (hi - lo) : 0;
  const counts = new Uint32Array(BUCKETS), bucket = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const b = ((key[i]! - lo) * scale) | 0;
    bucket[i] = b;
    counts[b]!++;
  }
  let sum = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const size = counts[i]!;
    counts[i] = sum;
    sum += size;
  }
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[counts[bucket[i]!]!++] = i;
  return out;
}

/** The positions buffer the sort reads (in WebAssembly memory, or the JavaScript copy). */
function positions(): Float32Array {
  return wasm ? new Float32Array(wasm.memory.buffer, posPtr, n * 3) : jsPositions!;
}

/** Moves the rigid range to where it is now (or back to rest), before sorting. */
function placeRigid(rigid: Rigid | null): void {
  if (!rigid && !moved) return;
  const p = positions();
  if (rigid && (!rest || rest.start !== rigid.start || rest.end !== rigid.end)) {
    rest = { start: rigid.start, end: rigid.end, pos: p.slice(rigid.start * 3, rigid.end * 3) };
  }
  if (!rest) return;
  const r = rest.pos, base = rest.start * 3;
  if (!rigid) {
    p.set(r, base);
    moved = false;
    return;
  }
  const m = rigid.m;
  for (let i = 0; i < r.length; i += 3) {
    const x = r[i]!, y = r[i + 1]!, z = r[i + 2]!;
    p[base + i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    p[base + i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    p[base + i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  moved = true;
}

scope.onmessage = async (event) => {
  const m = event.data;
  if (m.type === 'boot') {
    booting = boot(m.wasmUrl);
    await booting;
    scope.postMessage({ type: 'booted', wasm: !!wasm });
    return;
  }
  await booting;
  if (m.type === 'init') {
    load(m.n, m.pos);
    return;
  }
  const t0 = performance.now();
  placeRigid(m.rigid);
  const [a, b, c, d] = m.row, [cx, cy, cz] = m.eye;
  let order: Uint32Array;
  if (wasm) {
    if (m.mode === 'distance') wasm.sortDistance(n, posPtr, keysPtr, countsPtr, outPtr, cx, cy, cz);
    else wasm.sort(n, posPtr, keysPtr, countsPtr, outPtr, a, b, c, d);
    order = new Uint32Array(wasm.memory.buffer, outPtr, n).slice();
  } else if (m.mode === 'distance') {
    order = sortJs((x, y, z) => -Math.hypot(x - cx, y - cy, z - cz));
  } else {
    order = sortJs((x, y, z) => a * x + b * y + c * z + d);
  }
  scope.postMessage({ type: 'sorted', order, ms: performance.now() - t0, n, gen: m.gen }, [order.buffer]);
};
