// Entry point: loads the splat model of Tranquility Base trained from the Apollo 11 photographs,
// runs the frame loop and wires up the interface.
import { Camera } from './camera/camera';
import { Controls } from './camera/controls';
import { Flight, STATIONS, TOUR, type StationName } from './camera/stations';
import { Governor, type Knobs } from './perf/governor';
import { PerfPanel } from './perf/panel';
import { PowerModel } from './perf/power';
import { PerfStats } from './perf/stats';
import { GpuTimer } from './perf/timer';
import { Renderer } from './render/renderer';
import { Sorter } from './sort/sorter';
import { flipScene, parseGltf, parsePly, parseSplat, parseSpz } from './splats/importers';
import { asset, store, type AntiAliasing } from './splats/store';
import { byId, nextPaint, toast } from './util/dom';
import type { Vec3 } from './util/math';

const IS_PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const FONT = '"Saira Condensed", "Arial Narrow", sans-serif';

/**
 * The trained model, and how many of its splats (ordered by importance) each detail level draws.
 * The light level also comes as a file of its own, so phones needn't download the rest.
 */
const SITE_URL = 'tranquility.spz';
const SITE_MANIFEST = 'tranquility.json';
interface Manifest {
  splats: number;
  levels: { light: number; standard: number; full: number };
  lightFile?: string;
}
type Level = keyof Manifest['levels'];

/** Starting points per device class; the governor adapts from here to hold 60 fps or more. */
const PROFILE = IS_PHONE
  ? { knobs: { scale: 0.75, minScale: 0.5, maxScale: 1, dpr: 2, minPx: 0 }, level: 'light' as Level }
  : { knobs: { scale: 1, minScale: 0.5, maxScale: 1, dpr: 2, minPx: 0 }, level: 'full' as Level };

const canvas = byId<HTMLCanvasElement>('view');
const renderer = createRenderer();
const gl = renderer.gl;
const camera = new Camera();
const flight = new Flight();
const timer = new GpuTimer(gl);
const power = new PowerModel(IS_PHONE);
const governor = new Governor({ ...PROFILE.knobs } satisfies Knobs);
const stats = new PerfStats(power);

let manifest: Manifest | null = null;
let level: Level = PROFILE.level;
/** Whether the whole model is loaded, or only the light level's file; and whether the rest is on its way. */
let loadedFull = false;
let loadingFull = false;
/** A capture the visitor opened, instead of the site. */
let custom = false;
/** Tangential projection (RealityKit's default) or the 3DGS perspective projection the site was trained with. */
let tangential = false;
/** Vertical field of view: photo stations use the Hasselblad's. Eases toward fovTo. */
let fovTo = 0;
let station: StationName | null = null;
/** The tour: which stop it's on, and when to leave it (0 while flying there). */
let tour: { stop: number; leaveAt: number } | null = null;
const TOUR_PAUSE_MS = 5500;
let running = false;
let idleFrames = 0;
let lastRaf = 0;
let lastRender = 0;
let forceRender = true;
let sortArrived = false;
/** The loading overlay stays up until the first sorted frame, so a new scene never flashes in half-drawn. */
let awaitingSort = false;
/** The sub-pixel cutoff eases toward the governor's setting rather than switching (no popping). */
let minPxLevel = 0;
let idleSampler = 0;
let sceneW = 1;
let sceneH = 1;
const lastView = new Float64Array(8).fill(NaN);

function createRenderer(): Renderer {
  try {
    return new Renderer(canvas);
  } catch (err) {
    byId('loading-msg').textContent = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

const sorter = new Sorter(
  (order, ms) => {
    renderer.setOrder(order);
    stats.sortResult(ms);
    sortArrived = true;
    if (awaitingSort) revealScene();
    wake();
  },
  () => {
    byId('st-sortlabel').textContent = sorter.backend === 'wasm' ? 'Sort · wasm' : 'Sort · js';
  },
);

const controls = new Controls(canvas, camera, { interact: userTookOver, wake });

const panel = new PerfPanel(
  stats,
  governor,
  power,
  timer,
  () => ({
    drawn: renderer.drawCount,
    sceneW,
    sceneH,
    sort: `${sorter.mode === 'distance' ? 'Distance' : 'Depth'} · ${sorter.backend === 'wasm' ? 'WebAssembly' : sorter.backend === 'js' ? 'JavaScript' : 'Starting'} · ${sorter.lastMs.toFixed(1)} ms`,
  }),
  {
    pacing: (p) => {
      governor.pacing = p;
      wake();
    },
    sortMode: (mode) => {
      sorter.setMode(mode);
      forceRender = true;
      wake();
    },
    projection: (on) => {
      tangential = on;
      forceRender = true;
      wake();
    },
    adaptive: (on) => {
      governor.adaptive = on;
      if (!on) Object.assign(governor.knobs, PROFILE.knobs);
      forceRender = true;
      wake();
    },
    opened: (open) => {
      if (open) wake();
      else window.clearInterval(idleSampler);
    },
  },
);

// ---- Frame loop ---------------------------------------------------------------------

/** Starts the loop if it's asleep. Anything that changes the picture calls this. */
function wake(): void {
  idleFrames = 0;
  if (running) return;
  running = true;
  lastRaf = 0;
  window.clearInterval(idleSampler);
  requestAnimationFrame(frame);
}

/** Nothing is changing: stop drawing so the GPU (and battery) can rest. */
function sleep(): void {
  running = false;
  if (panel.open) idleSampler = window.setInterval(() => sample(performance.now()), 250);
}

function sample(now: number): void {
  if (!stats.tick(now)) return;
  const s = stats.latest;
  byId('st-fps').textContent = s.idle ? 'idle' : Number.isFinite(s.fps) ? `${Math.round(s.fps)} fps` : '–';
  byId('st-sort').textContent = sorter.lastMs ? `${sorter.lastMs.toFixed(1)} ms` : '–';
  panel.update();
}

/** The field of view away from photo stations: wider on portrait screens. */
function baseFov(): number {
  return canvas.clientWidth < canvas.clientHeight ? (72 * Math.PI) / 180 : Math.PI / 3;
}

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, governor.knobs.dpr);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    forceRender = true;
  }
}

function frame(now: number): void {
  if (!running) return;
  if (lastRaf) governor.noteRaf(now - lastRaf);
  const dt = lastRaf ? Math.min(0.1, (now - lastRaf) / 1000) : 1 / 60;
  lastRaf = now;
  const cpuStart = performance.now();

  resizeCanvas();
  const wantFov = fovTo || baseFov();
  const zooming = Math.abs(wantFov - camera.fov) > 1e-4;
  camera.fov = zooming ? camera.fov + (wantFov - camera.fov) * (1 - Math.exp(-dt * 4)) : wantFov;
  const flying = flight.update(camera, now);
  if (tour && !flying) {
    // Arrived: pause on the photo, then fly on (or stop after the last one).
    if (!tour.leaveAt) {
      tour.leaveAt = now + TOUR_PAUSE_MS;
      window.setTimeout(wake, TOUR_PAUSE_MS + 20);
    } else if (now >= tour.leaveAt) {
      if (++tour.stop < TOUR.length) {
        tour.leaveAt = 0;
        goTo(TOUR[tour.stop]!);
      } else {
        setTour(false);
      }
    }
  }
  const keyMoved = controls.update(dt);

  const k = governor.knobs;
  sceneW = Math.max(1, Math.round(canvas.width * k.scale));
  sceneH = Math.max(1, Math.round(canvas.height * k.scale));
  const v = camera.compute(sceneW, sceneH);
  sorter.request(v.depthRow, v.eye);

  const key = [v.eye[0], v.eye[1], v.eye[2], v.fwd[0], v.fwd[1], v.fwd[2], sceneW, sceneH];
  let moved = false, camMoved = false;
  for (let i = 0; i < 8 && !moved; i++) {
    moved = !(Math.abs(key[i]! - lastView[i]!) < 1e-6);
    camMoved = moved && i < 6;
  }
  // The sub-pixel cutoff fades over about a quarter of a second.
  minPxLevel += (k.minPx - minPxLevel) * (1 - Math.exp(-dt * 8));
  if (Math.abs(k.minPx - minPxLevel) < 0.01) minPxLevel = k.minPx;
  const fading = minPxLevel !== k.minPx;
  const busy = forceRender || moved || sortArrived || fading || zooming || flying || keyMoved;
  if (!busy) {
    sample(now);
    if (++idleFrames > 45) sleep();
    else requestAnimationFrame(frame);
    return;
  }
  idleFrames = 0;
  // The photo only lines up from the station itself.
  if (camMoved && !flying) hidePhoto();
  if (!governor.shouldRender(now, lastRender)) {
    requestAnimationFrame(frame);
    return;
  }

  timer.begin();
  renderer.render(
    { view: v.view, proj: v.proj, focal: v.focal, eye: v.eye, tanHalf: v.tanHalf, aspect: v.aspect, minPx: minPxLevel, tangential },
    sceneW, sceneH, canvas.width, canvas.height,
  );
  timer.end();
  timer.poll((ms) => {
    stats.gpuResult(ms);
    governor.gpuSample(ms);
  });

  // Only back-to-back frames count toward frame time; a pause is not a slow frame.
  const gap = now - lastRender;
  const interval = lastRender && gap < 70 ? gap : NaN;
  lastRender = now;
  stats.frameRendered(interval, performance.now() - cpuStart, power.estimateGpuMs(renderer.drawCount, sceneW * sceneH));
  if (Number.isFinite(interval)) governor.record(interval);
  governor.evaluate(now);
  sample(now);
  for (let i = 0; i < 8; i++) lastView[i] = key[i]!;
  forceRender = false;
  sortArrived = false;
  requestAnimationFrame(frame);
}

// ---- Scenes ---------------------------------------------------------------------------

/** Takes the loading overlay down once the new scene can be drawn in order. */
function revealScene(): void {
  awaitingSort = false;
  byId('loading').hidden = true;
}

/** Holds the overlay until the first sorted frame (or three seconds at most). */
function awaitFirstSort(): void {
  awaitingSort = true;
  window.setTimeout(() => {
    if (awaitingSort) revealScene();
  }, 3000);
}

function showLoading(title: string, message: string): void {
  byId('loading-title').textContent = title;
  byId('loading-msg').textContent = message;
  byId('loading').hidden = false;
}

/** Downloads a file, showing progress in the loading overlay. */
async function download(url: string, what: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${what}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader(), parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    // (A server may report the compressed size; then just count up.)
    byId('loading-msg').textContent = total >= got
      ? `${what} · ${(got / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`
      : `${what} · ${(got / 1048576).toFixed(0)} MB`;
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

/** Hands the first `count` splats to the GPU and the sort. */
function showSplats(count: number): void {
  renderer.upload(store, count);
  sorter.load(store.pos.slice(0, count * 3), count);
  byId('st-n').textContent = count.toLocaleString('en-CA');
}

/** Downloads and unpacks the model: the whole of it, or just the light level's own file. */
async function fetchModel(full: boolean): Promise<void> {
  const whole = full || !manifest!.lightFile;
  const buf = await download(whole ? SITE_URL : manifest!.lightFile!, 'Splat model');
  byId('loading-msg').textContent = 'Unpacking splats…';
  await nextPaint();
  await parseSpz(buf);
  loadedFull = whole;
}

async function loadSite(): Promise<void> {
  showLoading('Loading Tranquility Base', 'Trained from the Apollo 11 photographs…');
  await nextPaint();
  const t0 = performance.now();
  try {
    manifest = (await (await fetch(SITE_MANIFEST)).json()) as Manifest;
    await fetchModel(level !== 'light');
  } catch (err) {
    showLoading('Could not load the model', err instanceof Error ? err.message : String(err));
    return;
  }
  custom = false;
  setCustomUi(false);
  setProjection(false);
  showSplats(manifest.levels[level]);
  syncLevel();
  awaitFirstSort();
  forceRender = true;
  wake();
  toast(`${manifest.levels[level].toLocaleString('en-CA')} splats in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 3000);
}

const CAPTURE_TYPES = ['.ply', '.splat', '.spz', '.glb', '.gltf'];

async function loadCapture(file: File): Promise<void> {
  const name = file.name.toLowerCase();
  const ext = CAPTURE_TYPES.find((e) => name.endsWith(e));
  if (!ext) {
    toast('Open a .ply, .splat, .spz, .glb or .gltf capture.');
    return;
  }
  showLoading('Loading capture', `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`);
  await nextPaint();
  try {
    const buf = await file.arrayBuffer();
    if (ext === '.ply') parsePly(buf);
    else if (ext === '.splat') parseSplat(buf);
    else if (ext === '.spz') await parseSpz(buf);
    else parseGltf(buf);
    if (!store.count) throw new Error('No splats found in that file.');
    custom = true;
    setCustomUi(true);
    setProjection(false);
    showSplats(store.count);
    frameCapture();
    byId<HTMLSelectElement>('aa-mode').value = asset.aa;
    const colour = asset.shDegree ? `, view-dependent colour (degree ${asset.shDegree})` : '';
    toast(`${store.count.toLocaleString('en-CA')} splats loaded${colour}. Use Flip if it looks upside down.`, 5000);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'That file could not be read.', 5000);
    await loadSite();
    return;
  }
  awaitFirstSort();
  forceRender = true;
  wake();
}

/** Points the camera at the middle of a loaded capture, ignoring stray outliers. */
function frameCapture(): void {
  const n = Math.min(store.count, 20000), axes: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const j = Math.floor((i / n) * store.count);
    for (let a = 0; a < 3; a++) axes[a]!.push(store.pos[j * 3 + a]!);
  }
  const q = (a: number[], p: number): number => a[Math.floor(p * (a.length - 1))]!;
  for (const a of axes) a.sort((x, y) => x - y);
  const centre: Vec3 = [q(axes[0]!, 0.5), q(axes[1]!, 0.5), q(axes[2]!, 0.5)];
  const extent = Math.max(...axes.map((a) => q(a, 0.95) - q(a, 0.05))) || 5;
  userTookOver();
  camera.target = centre;
  camera.dist = extent * 1.2;
  camera.pitch = -0.3;
  camera.yaw = -Math.PI / 2;
}

// ---- Interface --------------------------------------------------------------------------

function userTookOver(): void {
  if (tour) setTour(false);
  flight.stop();
  setStation(null);
  fovTo = 0;
  hidePhoto();
}

function setStation(name: StationName | null): void {
  station = name;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
  const photo = name ? STATIONS[name].photo : undefined;
  const compare = byId<HTMLButtonElement>('compare');
  compare.hidden = !photo;
  compare.setAttribute('aria-pressed', 'false');
  byId('caption').textContent = name ? STATIONS[name].caption : '';
  byId('caption').hidden = !name;
}

/** Flies to a station; photo stations also take on the Hasselblad's field of view. */
function goTo(name: StationName): void {
  hidePhoto();
  flight.goTo(camera, name, performance.now());
  const fov = STATIONS[name].fov;
  fovTo = fov ? (fov * Math.PI) / 180 : 0;
  setStation(name);
  wake();
}

/** The original photograph over the view, turned to the camera's roll so the two line up. */
function showPhoto(): void {
  const photo = station ? STATIONS[station].photo : undefined;
  if (!photo) return;
  const fig = byId('photo'), img = byId<HTMLImageElement>('photo-img');
  img.src = `photos/${photo.id}.jpg`;
  img.alt = `NASA photograph ${photo.id}`;
  img.style.transform = `rotate(${photo.roll}deg)`;
  byId('photo-id').textContent = `${photo.id} · NASA`;
  fig.hidden = false;
  byId('compare').setAttribute('aria-pressed', 'true');
}

function hidePhoto(): void {
  byId('photo').hidden = true;
  byId('compare').setAttribute('aria-pressed', 'false');
}

function setTour(on: boolean): void {
  tour = on ? { stop: 0, leaveAt: 0 } : null;
  const b = byId('tour');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Stop tour' : 'Play tour';
}

function setCustomUi(on: boolean): void {
  byId('stations').hidden = on;
  byId('levels').hidden = on;
  byId('flip').hidden = !on;
  byId('back').hidden = !on;
  byId('aa-mode').hidden = !on;
  byId('subtitle').textContent = on ? 'Your capture' : 'Gaussian splats · trained from the mission photographs';
  if (on) {
    setStation(null);
    fovTo = 0;
  }
}

function setProjection(on: boolean): void {
  tangential = on;
  byId<HTMLSelectElement>('pf-proj').value = on ? 'tangential' : 'perspective';
}

function syncLevel(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.level === level)));
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    setTour(false);
    goTo(b.dataset.view as StationName);
  }),
);

byId('tour').addEventListener('click', () => {
  if (tour) {
    flight.stop();
    setTour(false);
  } else {
    setTour(true);
    goTo(TOUR[0]!);
  }
  wake();
});

byId('compare').addEventListener('click', () => {
  if (byId('photo').hidden) showPhoto();
  else hidePhoto();
});

document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!manifest || custom) return;
    level = b.dataset.level as Level;
    syncLevel();
    if (level !== 'light' && !loadedFull) {
      // A load already under way will show whichever level is chosen when it finishes.
      if (loadingFull) return;
      loadingFull = true;
      showLoading('Loading more detail', 'The rest of the splats…');
      await nextPaint();
      try {
        await fetchModel(true);
      } catch (err) {
        byId('loading').hidden = true;
        toast(err instanceof Error ? err.message : String(err), 5000);
        return;
      } finally {
        loadingFull = false;
      }
      awaitFirstSort();
    }
    showSplats(manifest.levels[level]);
    forceRender = true;
    wake();
  }),
);

byId<HTMLInputElement>('file').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement, file = input.files?.[0];
  if (file) void loadCapture(file);
  input.value = '';
});

byId<HTMLSelectElement>('aa-mode').addEventListener('change', (e) => {
  asset.aa = (e.target as HTMLSelectElement).value as AntiAliasing;
  forceRender = true;
  wake();
});

byId('flip').addEventListener('click', () => {
  flipScene();
  showSplats(store.count);
  forceRender = true;
  wake();
});

byId('back').addEventListener('click', () => {
  void loadSite().then(() => goTo('ladder'));
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  byId('drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    byId('drop').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  byId('drop').hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) void loadCapture(file);
});

window.addEventListener('resize', () => {
  forceRender = true;
  wake();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    forceRender = true;
    wake();
  }
});

/** Parses "x,y,z" from a URL parameter. */
function vec3Param(value: string | null): Vec3 | null {
  const v = value?.split(',').map(Number);
  return v && v.length === 3 && v.every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : null;
}

async function start(): Promise<void> {
  // ?eye=x,y,z&look=x,y,z opens at a particular viewpoint and ?station=name at a station, so a
  // view can be shared as a link.
  const params = new URLSearchParams(location.search);
  const eye = vec3Param(params.get('eye')), look = vec3Param(params.get('look'));
  const named = params.get('station');
  const first: StationName = named && named in STATIONS ? (named as StationName) : 'ladder';
  if (eye && look) {
    camera.setEyeLook(eye, look);
    setStation(null);
  } else {
    camera.setEyeLook(STATIONS[first].eye, STATIONS[first].look);
    const fov = STATIONS[first].fov;
    fovTo = fov ? (fov * Math.PI) / 180 : 0;
    camera.fov = fovTo || baseFov();
    setStation(first);
  }
  void power.connectBattery();
  wake();
  try {
    await Promise.race([document.fonts.load(`800 40px ${FONT}`), new Promise((resolve) => setTimeout(resolve, 2500))]);
  } catch {
    // Fall back to the system font.
  }
  // ?capture=<url> opens a capture straight away (the server must allow cross-origin reads).
  const link = params.get('capture');
  if (link) {
    try {
      const url = new URL(link, location.href);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await loadCapture(new File([await res.blob()], url.pathname.split('/').pop() || 'capture'));
      if (eye && look) camera.setEyeLook(eye, look);
      return;
    } catch (err) {
      toast(`Couldn't open that capture link: ${err instanceof Error ? err.message : String(err)}`, 5000);
    }
  }
  await loadSite();
}

void start();
