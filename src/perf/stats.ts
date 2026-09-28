// Rolls per-frame measurements up into 100 ms samples for the readouts and charts.
import { clamp } from '../util/math';
import type { PowerModel } from './power';

export const SAMPLE_MS = 100;
export const HISTORY = 120; // 12 seconds

/** Fixed-size history; NaN marks a gap (no frames drawn). */
export class Ring {
  readonly data: Float32Array;
  head = 0;

  constructor(readonly size: number) {
    this.data = new Float32Array(size).fill(NaN);
  }

  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.size;
  }

  /** k = 0 is the oldest sample, size - 1 the newest. */
  at(k: number): number {
    return this.data[(this.head + k) % this.size]!;
  }

  max(): number {
    let m = 0;
    for (const v of this.data) if (Number.isFinite(v) && v > m) m = v;
    return m;
  }
}

export interface Sample {
  fps: number;
  frameMs: number;
  gpuMs: number;
  watts: number;
  drainPerHour: number | null;
  idle: boolean;
}

export class PerfStats {
  readonly frameMs = new Ring(HISTORY);
  readonly gpuMs = new Ring(HISTORY);
  readonly watts = new Ring(HISTORY);
  latest: Sample = { fps: 0, frameMs: NaN, gpuMs: NaN, watts: 0, drainPerHour: null, idle: true };

  private t0 = performance.now();
  private frames = 0;
  private intervalSum = 0;
  private intervalN = 0;
  private gpuSum = 0;
  private gpuN = 0;
  private cpuMs = 0;
  private sortMs = 0;
  private modelledGpuMs = 0;
  private readonly recent: number[] = [];
  private smoothWatts = NaN;

  constructor(private readonly power: PowerModel) {}

  /**
   * interval is the time since the previous frame when frames are back to back, or NaN after an
   * idle gap, so pauses don't read as slow frames.
   */
  frameRendered(interval: number, cpuMs: number, modelledGpuMs: number): void {
    this.frames++;
    if (Number.isFinite(interval)) {
      this.intervalSum += interval;
      this.intervalN++;
    }
    this.cpuMs += cpuMs;
    this.modelledGpuMs += modelledGpuMs;
  }

  gpuResult(ms: number): void {
    this.gpuSum += ms;
    this.gpuN++;
  }

  sortResult(ms: number): void {
    this.sortMs += ms;
  }

  /** Closes the current sample if it's due. Returns true when a new sample was recorded. */
  tick(now: number): boolean {
    const dt = now - this.t0;
    if (dt < SAMPLE_MS) return false;
    const idle = this.frames === 0;
    const frameMs = this.intervalN ? this.intervalSum / this.intervalN : NaN;
    const gpuMs = this.gpuN ? this.gpuSum / this.gpuN : NaN;
    // Measured GPU time when the timer exists, the cost model otherwise.
    const gpuBusy = clamp((this.gpuN ? gpuMs * this.frames : this.modelledGpuMs) / dt, 0, 1);
    const cpuBusy = clamp((this.cpuMs + this.sortMs) / dt / 2, 0, 1);
    const watts = this.power.watts(gpuBusy, cpuBusy);
    this.smoothWatts = Number.isFinite(this.smoothWatts) ? this.smoothWatts * 0.8 + watts * 0.2 : watts;

    // Frame rate while animating, over the last second of samples that had continuous frames.
    if (Number.isFinite(frameMs)) this.recent.push(frameMs);
    else if (idle) this.recent.length = 0;
    if (this.recent.length > 10) this.recent.shift();
    const avgMs = this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : NaN;

    this.frameMs.push(frameMs);
    this.gpuMs.push(gpuMs);
    this.watts.push(watts);
    this.latest = {
      fps: 1000 / avgMs,
      frameMs,
      gpuMs,
      watts: this.smoothWatts,
      drainPerHour: this.power.drainPerHour(this.smoothWatts),
      idle,
    };
    this.frames = 0;
    this.intervalSum = 0;
    this.intervalN = 0;
    this.gpuSum = 0;
    this.gpuN = 0;
    this.cpuMs = 0;
    this.sortMs = 0;
    this.modelledGpuMs = 0;
    this.t0 = now;
    return true;
  }
}
