// Adaptive quality. 60 fps is the floor; the display's refresh rate is the ceiling.
// Every half second it looks at recent frames. Above 60 fps it only trades the ray budget, which
// the eye can't see, to reach a faster display's refresh rate. The render scale, fine splats and
// bloom only give way when frames stay under 60 fps, one step at a time: after two slow windows
// in a row, and a scale that proved too slow isn't tried again for 20 seconds. Hunting back and
// forth would make the whole picture pop.

export type Pacing = 'display' | 'floor' | 'saver';

export interface Knobs {
  /** Render-target scale relative to the canvas. */
  scale: number;
  minScale: number;
  maxScale: number;
  /** Device-pixel-ratio cap for the canvas. */
  dpr: number;
  /** Rows of 1024 splats re-lit per frame while lighting refines. */
  rtRows: number;
  rtMin: number;
  rtMax: number;
  /** Splats smaller than this many pixels are skipped. */
  minPx: number;
  bloom: boolean;
}

const COMMON_HZ = [48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];
const FLOOR_FPS = 60;

export class Governor {
  pacing: Pacing = 'display';
  adaptive = true;
  bloomWanted = true;
  refreshHz = 60;
  lastChange = 'Starting up';

  private readonly deltas: number[] = [];
  private intervals: number[] = [];
  private gpuSum = 0;
  private gpuN = 0;
  private windowStart = 0;
  private coolUntil = 0;
  /** Consecutive windows under 60 fps, and with room to spare. */
  private slow = 0;
  private easy = 0;
  /** A render scale that ran under 60 fps, and until when not to try it again. */
  private tooSlowScale = Infinity;
  private tooSlowUntil = 0;

  constructor(readonly knobs: Knobs) {}

  /** Target frame rate: the refresh rate when matching the display, otherwise 60. */
  get targetFps(): number {
    return this.pacing === 'display' ? Math.max(FLOOR_FPS, this.refreshHz) : FLOOR_FPS;
  }

  /** Every requestAnimationFrame delta, rendered or not, to learn the refresh rate. */
  noteRaf(delta: number): void {
    if (delta < 2 || delta > 60) return;
    this.deltas.push(delta);
    if (this.deltas.length > 120) this.deltas.shift();
    if (this.deltas.length >= 30 && this.deltas.length % 10 === 0) this.refreshHz = estimateHz(this.deltas);
  }

  /** Battery saver renders at most 60 frames a second, even on faster displays. */
  shouldRender(now: number, lastRender: number): boolean {
    if (this.pacing !== 'saver' || this.refreshHz <= 65) return true;
    return now - lastRender >= 1000 / FLOOR_FPS - 1.5;
  }

  record(interval: number): void {
    if (interval > 0 && interval < 250) this.intervals.push(interval);
  }

  gpuSample(ms: number): void {
    this.gpuSum += ms;
    this.gpuN++;
  }

  evaluate(now: number, rtActive: boolean): void {
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart < 450 || this.intervals.length < 12) return;
    const sorted = this.intervals.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
    const gpu = this.gpuN ? this.gpuSum / this.gpuN : NaN;
    this.intervals = [];
    this.gpuSum = 0;
    this.gpuN = 0;
    this.windowStart = now;
    if (!this.adaptive) return;

    const floorMs = 1000 / FLOOR_FPS, targetMs = 1000 / this.targetFps;
    const timed = Number.isFinite(gpu);
    const belowFloor = median > floorMs * 1.06 || p90 > floorMs * 1.25;
    const belowTarget = timed ? gpu > targetMs * 0.9 : median > targetMs * 1.12;
    const roomy = timed ? gpu < targetMs * 0.55 && median < targetMs * 1.05 : median < targetMs * 1.04 && p90 < targetMs * 1.3;

    if (belowFloor) {
      this.easy = 0;
      this.slow++;
      // The ray budget goes first and at once; what you can see only after a second slow window.
      if (!this.lowerBudget(rtActive) && this.slow >= 2) {
        this.lowerVisible(now);
        this.slow = 0;
      }
      this.coolUntil = now + 3000;
    } else if (belowTarget && this.pacing === 'display' && this.targetFps > FLOOR_FPS) {
      this.slow = this.easy = 0;
      this.lowerBudget(rtActive);
      this.coolUntil = now + 3000;
    } else if (roomy && now > this.coolUntil) {
      this.slow = 0;
      if (++this.easy >= 3) {
        this.raise(now, rtActive);
        this.easy = 0;
        this.coolUntil = now + 1200;
      }
    } else {
      this.slow = this.easy = 0;
    }
  }

  /** Halves the ray budget; false when it's already at the minimum (or nothing is being traced). */
  private lowerBudget(rtActive: boolean): boolean {
    const k = this.knobs;
    if (!rtActive || k.rtRows <= k.rtMin) return false;
    k.rtRows = Math.max(k.rtMin, Math.floor(k.rtRows / 2));
    this.lastChange = 'Lowered ray budget';
    return true;
  }

  /** Only when under 60 fps: render scale, then sub-pixel splats (which fade), then bloom (which fades). */
  private lowerVisible(now: number): void {
    const k = this.knobs;
    if (k.scale > k.minScale + 1e-3) {
      this.tooSlowScale = k.scale;
      this.tooSlowUntil = now + 20000;
      k.scale = Math.max(k.minScale, round2(k.scale - 0.1));
      this.lastChange = 'Lowered render scale';
    } else if (k.minPx < 2) {
      k.minPx += 0.5;
      this.lastChange = 'Fading out sub-pixel splats';
    } else if (k.bloom) {
      k.bloom = false;
      this.lastChange = 'Bloom off';
    }
  }

  private raise(now: number, rtActive: boolean): void {
    const k = this.knobs, next = round2(k.scale + 0.1);
    if (!k.bloom && this.bloomWanted) {
      k.bloom = true;
      this.lastChange = 'Bloom back on';
    } else if (k.minPx > 0) {
      k.minPx = Math.max(0, k.minPx - 0.5);
      this.lastChange = 'Restored fine splats';
    } else if (k.scale < k.maxScale - 1e-3 && (next < this.tooSlowScale - 1e-3 || now > this.tooSlowUntil)) {
      k.scale = Math.min(k.maxScale, next);
      this.lastChange = 'Raised render scale';
    } else if (rtActive && k.rtRows < k.rtMax) {
      k.rtRows = Math.min(k.rtMax, k.rtRows * 2);
      this.lastChange = 'Raised ray budget';
    }
  }
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Refresh rate from the fastest quarter of frame deltas, snapped to common rates. */
function estimateHz(deltas: readonly number[]): number {
  const sorted = [...deltas].sort((a, b) => a - b);
  const hz = 1000 / sorted[Math.floor(sorted.length * 0.25)]!;
  for (const c of COMMON_HZ) if (Math.abs(hz - c) / c < 0.07) return c;
  return Math.round(hz);
}
