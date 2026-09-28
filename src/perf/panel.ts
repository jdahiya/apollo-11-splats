// The Performance panel: live readouts, frame-time and power charts, and the quality controls.
import { byId } from '../util/dom';
import { LineChart } from './charts';
import type { Governor, Pacing } from './governor';
import type { PowerModel } from './power';
import type { PerfStats } from './stats';
import type { GpuTimer } from './timer';
import type { SortMode } from '../sort/protocol';

export interface PanelInfo {
  lighting: string;
  rays: string;
  drawn: number;
  sceneW: number;
  sceneH: number;
  sort: string;
}

export interface PanelHandlers {
  pacing(p: Pacing): void;
  sortMode(mode: SortMode): void;
  projection(tangential: boolean): void;
  adaptive(on: boolean): void;
  lighting(on: boolean): void;
  bloom(on: boolean): void;
  opened(open: boolean): void;
}

const ROWS = [
  ['display', 'Display'],
  ['scale', 'Render scale'],
  ['budget', 'Ray budget'],
  ['rays', 'Rays per splat'],
  ['lighting', 'Lighting'],
  ['cutoff', 'Detail cutoff'],
  ['bloom', 'Bloom'],
  ['drawn', 'Splats drawn'],
  ['sort', 'Depth sort'],
  ['change', 'Last adjustment'],
  ['battery', 'Battery'],
  ['basis', 'Estimates from'],
] as const;

type Row = (typeof ROWS)[number][0];

const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const watts = (w: number): string => `${w.toFixed(w < 10 ? 1 : 0)} W`;

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export class PerfPanel {
  open = false;
  private readonly frameChart: LineChart;
  private readonly powerChart: LineChart;
  private readonly cells = new Map<Row, HTMLElement>();

  constructor(
    private readonly stats: PerfStats,
    private readonly governor: Governor,
    private readonly power: PowerModel,
    private readonly timer: GpuTimer,
    private readonly info: () => PanelInfo,
    handlers: PanelHandlers,
  ) {
    const css = getComputedStyle(document.documentElement);
    const s1 = css.getPropertyValue('--s1').trim(), s2 = css.getPropertyValue('--s2').trim();
    const tipFor = (id: string): HTMLElement => byId(id).parentElement!.querySelector<HTMLElement>('.tip')!;

    this.frameChart = new LineChart(
      byId<HTMLCanvasElement>('pf-frame'),
      tipFor('pf-frame'),
      [
        { label: 'Frame interval', color: s1, ring: stats.frameMs, format: (v) => `${v.toFixed(1)} ms` },
        { label: 'GPU time', color: s2, ring: stats.gpuMs, shown: () => timer.available, format: (v) => `${v.toFixed(1)} ms` },
      ],
      { max: () => 40, ticks: () => [0, 10, 20, 30, 40], tick: (v) => String(v), reference: { value: 1000 / 60, label: '60 fps · 16.7 ms' } },
    );
    this.powerChart = new LineChart(
      byId<HTMLCanvasElement>('pf-power'),
      tipFor('pf-power'),
      [{ label: 'Estimated power', color: s1, ring: stats.watts, area: true, format: watts }],
      { max: () => niceMax(stats.watts.max() * 1.15), ticks: (m) => [0, m / 2, m], tick: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}` },
    );
    if (!timer.available) byId('pf-key-gpu').hidden = true;

    const list = byId('pf-knobs');
    for (const [key, label] of ROWS) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      list.append(dt, dd);
      this.cells.set(key, dd);
    }

    const toggle = byId<HTMLButtonElement>('perf-toggle'), panel = byId('perf');
    toggle.addEventListener('click', () => {
      this.open = !this.open;
      panel.hidden = !this.open;
      toggle.setAttribute('aria-expanded', String(this.open));
      handlers.opened(this.open);
      this.update();
    });
    const pacing = byId<HTMLSelectElement>('pf-pacing');
    pacing.value = governor.pacing;
    pacing.addEventListener('change', () => handlers.pacing(pacing.value as Pacing));
    const sort = byId<HTMLSelectElement>('pf-sort');
    sort.addEventListener('change', () => handlers.sortMode(sort.value as SortMode));
    const proj = byId<HTMLSelectElement>('pf-proj');
    proj.addEventListener('change', () => handlers.projection(proj.value === 'tangential'));
    const bind = (id: string, on: boolean, fn: (v: boolean) => void): void => {
      const box = byId<HTMLInputElement>(id);
      box.checked = on;
      box.addEventListener('change', () => fn(box.checked));
    };
    bind('pf-adaptive', governor.adaptive, handlers.adaptive);
    bind('pf-rt', true, handlers.lighting);
    bind('pf-bloom', governor.bloomWanted, handlers.bloom);
  }

  update(): void {
    if (!this.open) return;
    const s = this.stats.latest, g = this.governor, k = g.knobs, info = this.info(), p = this.power;
    byId('pf-fps').textContent = s.idle ? 'Idle' : Number.isFinite(s.fps) ? `${Math.round(s.fps)} fps` : '–';
    byId('pf-gpu').textContent = !this.timer.available ? 'n/a' : Number.isFinite(s.gpuMs) ? `${s.gpuMs.toFixed(1)} ms` : '–';
    byId('pf-watts').textContent = `≈ ${watts(s.watts)}`;
    byId('pf-drain').textContent = s.drainPerHour !== null ? `≈ ${Math.round(s.drainPerHour)} %/h` : p.profile.batteryWh ? 'Charging' : 'Mains';

    const chip = byId('pf-state');
    let state: 'idle' | 'good' | 'warn', label: string;
    if (s.idle) {
      state = 'idle';
      label = 'Idle · GPU resting';
    } else if (s.fps >= 57) {
      state = 'good';
      label = s.fps >= g.targetFps * 0.95 ? `On target · ${g.targetFps} fps` : '60 fps or better';
    } else {
      state = 'warn';
      label = 'Below 60 fps';
    }
    chip.dataset.state = state;
    chip.querySelector('span')!.textContent = label;

    const set = (row: Row, text: string): void => {
      this.cells.get(row)!.textContent = text;
    };
    set('display', `${g.refreshHz} Hz · target ${g.targetFps} fps`);
    set('scale', `${Math.round(k.scale * 100)} % · ${info.sceneW}×${info.sceneH}`);
    set('budget', `${k.rtRows} rows · ${compact(k.rtRows * 1024)} splats/frame`);
    set('rays', info.rays);
    set('lighting', info.lighting);
    set('cutoff', k.minPx ? `Under ${k.minPx} px skipped` : 'Off');
    set('bloom', k.bloom ? 'On' : 'Off');
    set('drawn', compact(info.drawn));
    set('sort', info.sort);
    set('change', g.lastChange);
    set('battery', p.batteryLevel === null
      ? 'Not reported by this browser'
      : `${Math.round(p.batteryLevel * 100)} %${p.charging ? ', charging' : ''}${p.measuredPerHour !== null ? `, measured ${p.measuredPerHour.toFixed(0)} %/h` : ''}`);
    set('basis', `${p.profile.label} profile, ${this.timer.available ? 'GPU timer' : 'modelled GPU load'}`);

    this.frameChart.draw();
    this.powerChart.draw();
  }
}
