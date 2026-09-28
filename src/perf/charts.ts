// Small canvas line charts for the performance panel, with a hover crosshair and tooltip.
import { clamp } from '../util/math';
import { HISTORY, SAMPLE_MS, type Ring } from './stats';

export interface ChartSeries {
  label: string;
  color: string;
  ring: Ring;
  area?: boolean;
  shown?: () => boolean;
  format: (v: number) => string;
}

export interface ChartConfig {
  max: () => number;
  ticks: (max: number) => number[];
  tick: (v: number) => string;
  reference?: { value: number; label: string };
}

const PAD = { l: 34, r: 10, t: 12, b: 18 };

export class LineChart {
  private hover: number | null = null;
  private hoverX = 0;
  private readonly ink: { grid: string; muted: string; text: string; surface: string };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly tip: HTMLElement,
    private readonly series: ChartSeries[],
    private readonly cfg: ChartConfig,
  ) {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string): string => css.getPropertyValue(name).trim();
    this.ink = { grid: v('--grid'), muted: v('--muted'), text: v('--text'), surface: v('--surface') };
    canvas.addEventListener('pointermove', (e) => {
      const w = canvas.clientWidth - PAD.l - PAD.r;
      this.hover = Math.round(clamp((e.offsetX - PAD.l) / w, 0, 1) * (HISTORY - 1));
      this.hoverX = e.offsetX;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
  }

  draw(): void {
    const cv = this.canvas, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b, max = this.cfg.max();
    const xAt = (k: number): number => PAD.l + (k / (HISTORY - 1)) * pw;
    const yAt = (v: number): number => PAD.t + ph - (Math.min(v, max) / max) * ph;

    // Grid and axis labels.
    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.ink.grid;
    ctx.fillStyle = this.ink.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of this.cfg.ticks(max)) {
      const y = Math.round(yAt(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(W - PAD.r, y);
      ctx.stroke();
      ctx.fillText(this.cfg.tick(t), PAD.l - 6, y);
    }
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`${(HISTORY * SAMPLE_MS) / 1000} s ago`, PAD.l, PAD.t + ph + 5);
    ctx.textAlign = 'right';
    ctx.fillText('now', W - PAD.r, PAD.t + ph + 5);

    const ref = this.cfg.reference;
    if (ref && ref.value <= max) {
      const y = Math.round(yAt(ref.value)) + 0.5;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = this.ink.text;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(W - PAD.r, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.ink.text;
      ctx.textBaseline = 'bottom';
      ctx.fillText(ref.label, W - PAD.r, y - 3);
    }

    for (const s of this.series) {
      if (s.shown && !s.shown()) continue;
      if (s.area) this.area(ctx, s.ring, s.color, xAt, yAt(0), yAt);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < HISTORY; k++) {
        const v = s.ring.at(k);
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(xAt(k), yAt(v));
        else ctx.moveTo(xAt(k), yAt(v));
        pen = true;
      }
      ctx.stroke();
      for (let k = HISTORY - 1; k >= 0; k--) {
        const v = s.ring.at(k);
        if (Number.isFinite(v)) {
          this.dot(ctx, xAt(k), yAt(v), s.color);
          break;
        }
      }
    }

    if (this.hover !== null) {
      const x = Math.round(xAt(this.hover)) + 0.5;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = this.ink.text;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + ph);
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const s of this.series) {
        if (s.shown && !s.shown()) continue;
        const v = s.ring.at(this.hover);
        if (Number.isFinite(v)) this.dot(ctx, x, yAt(v), s.color);
      }
      this.showTip();
    }
  }

  private area(ctx: CanvasRenderingContext2D, ring: Ring, color: string, xAt: (k: number) => number, base: number, yAt: (v: number) => number): void {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1;
    let start = -1;
    for (let k = 0; k <= HISTORY; k++) {
      const ok = k < HISTORY && Number.isFinite(ring.at(k));
      if (ok && start < 0) start = k;
      if (!ok && start >= 0) {
        ctx.beginPath();
        ctx.moveTo(xAt(start), base);
        for (let j = start; j < k; j++) ctx.lineTo(xAt(j), yAt(ring.at(j)));
        ctx.lineTo(xAt(k - 1), base);
        ctx.closePath();
        ctx.fill();
        start = -1;
      }
    }
    ctx.globalAlpha = 1;
  }

  private dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.ink.surface;
    ctx.stroke();
  }

  private showTip(): void {
    const k = this.hover;
    if (k === null) return;
    const tip = this.tip;
    tip.replaceChildren();
    const when = document.createElement('div');
    when.className = 'tip-when';
    const ago = ((HISTORY - 1 - k) * SAMPLE_MS) / 1000;
    when.textContent = ago < 0.05 ? 'Now' : `${ago.toFixed(1)} s ago`;
    tip.append(when);
    for (const s of this.series) {
      if (s.shown && !s.shown()) continue;
      const v = s.ring.at(k);
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('i');
      key.style.background = s.color;
      const value = document.createElement('strong');
      value.textContent = Number.isFinite(v) ? s.format(v) : 'Idle';
      const label = document.createElement('span');
      label.textContent = s.label;
      row.append(key, value, label);
      tip.append(row);
    }
    tip.hidden = false;
    const W = this.canvas.clientWidth;
    tip.style.left = `${this.hoverX > W / 2 ? Math.max(0, this.hoverX - tip.offsetWidth - 12) : this.hoverX + 12}px`;
  }
}
