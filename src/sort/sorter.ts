// Main-thread side of the sort worker: asks for a new order when the camera has moved enough to
// change it, and hands back each finished order.
import type { Rigid, SortMode, SortReply, SortRequest } from './protocol';
import type { Vec3 } from '../util/math';

export type DepthRow = readonly [number, number, number, number];

export class Sorter {
  backend: 'loading' | 'wasm' | 'js' = 'loading';
  lastMs = 0;
  /** Camera-distance order is the glTF KHR_gaussian_splatting default. */
  mode: SortMode = 'distance';

  private readonly worker: Worker;
  private busy = false;
  private gen = 0;
  private count = 0;
  private readonly sentRow = new Float64Array(4).fill(NaN);
  private readonly sentEye = new Float64Array(3).fill(NaN);
  /** A range of splats moving as one rigid body (Eagle during the landing), or null. */
  private rigid: Rigid | null = null;
  private rigidChanged = false;

  constructor(
    private readonly onSorted: (order: Uint32Array, ms: number) => void,
    private readonly onBackend: () => void,
  ) {
    this.worker = new Worker(new URL('./sort-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<SortReply>) => {
      const m = event.data;
      if (m.type === 'booted') {
        this.backend = m.wasm ? 'wasm' : 'js';
        this.onBackend();
        return;
      }
      this.busy = false;
      if (m.gen !== this.gen || m.n !== this.count) return; // stale: the scene changed meanwhile
      this.lastMs = m.ms;
      this.onSorted(m.order, m.ms);
    };
    this.post({ type: 'boot', wasmUrl: new URL('./sort.wasm', import.meta.url).href });
  }

  /** Hands the worker a new scene's positions (the buffer is transferred). */
  load(positions: Float32Array, count: number): void {
    this.gen++;
    this.count = count;
    this.invalidate();
    this.post({ type: 'init', n: count, pos: positions }, [positions.buffer]);
  }

  /** Tells the sort where a rigid range has moved to; null puts it back at rest. */
  setRigid(rigid: Rigid | null): void {
    if (!rigid && !this.rigid) return;
    this.rigid = rigid;
    this.rigidChanged = true;
  }

  setMode(mode: SortMode): void {
    this.mode = mode;
    this.invalidate();
  }

  /** Requests a re-sort if the view moved enough to change the order and no sort is in flight. */
  request(row: DepthRow, eye: Vec3): void {
    if (this.busy || !this.count) return;
    if (this.rigidChanged) {
      this.rigidChanged = false;
    } else if (this.mode === 'distance') {
      const e = this.sentEye;
      // Rotation alone never changes a distance order; only moving the camera does.
      if (Math.hypot(eye[0] - e[0]!, eye[1] - e[1]!, eye[2] - e[2]!) <= 0.02) return;
    } else {
      const s = this.sentRow;
      const still = Math.abs(row[0] - s[0]!) <= 0.002 && Math.abs(row[1] - s[1]!) <= 0.002 && Math.abs(row[2] - s[2]!) <= 0.002 && Math.abs(row[3] - s[3]!) <= 0.05;
      if (still) return;
    }
    this.sentRow.set(row);
    this.sentEye.set(eye);
    this.busy = true;
    this.post({ type: 'sort', mode: this.mode, row: [row[0], row[1], row[2], row[3]], eye: [eye[0], eye[1], eye[2]], gen: this.gen, rigid: this.rigid });
  }

  private invalidate(): void {
    this.sentRow.fill(NaN);
    this.sentEye.fill(NaN);
  }

  private post(message: SortRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }
}
