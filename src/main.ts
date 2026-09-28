// Entry point: builds the landing site, runs the frame loop and wires up the interface.
import { Camera } from './camera/camera';
import { Controls } from './camera/controls';
import { Flight, VIEWS, type ViewName } from './camera/stations';
import { Governor, type Knobs } from './perf/governor';
import { PerfPanel } from './perf/panel';
import { PowerModel } from './perf/power';
import { PerfStats } from './perf/stats';
import { GpuTimer } from './perf/timer';
import { Lighting } from './render/lighting';
import { Renderer } from './render/renderer';
import { buildVoxelGrids } from './render/voxels';
import { buildScene } from './scene/build';
import { Sorter } from './sort/sorter';
import { flipScene, parseGltf, parsePly, parseSplat, parseSpz } from './splats/importers';
import { asset, store, type AntiAliasing } from './splats/store';
import { byId, nextPaint, toast } from './util/dom';
import type { Vec3 } from './util/math';
import { Landing, LightRig, TOUCHDOWN } from './world/landing';
import { EVA_ELEVATION, sunAt, sunLabel } from './world/sun';

const IS_PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const FONT = '"Saira Condensed", "Arial Narrow", sans-serif';

/** Starting points per device class; the governor adapts from here to hold 60 fps or more. */
const PROFILE = IS_PHONE
  ? {
      knobs: { scale: 0.75, minScale: 0.5, maxScale: 1, dpr: 2, rtRows: 16, rtMin: 2, rtMax: 64, minPx: 0, bloom: true },
      rays: { rays: 2, cacheRays: 2, lightSamples: 1, steps: 32 },
      voxel: { fine: 0.8, coarse: 8 },
      cycles: 8,
      density: 0.5,
    }
  : {
      knobs: { scale: 1, minScale: 0.5, maxScale: 1, dpr: 2, rtRows: 96, rtMin: 8, rtMax: 512, minPx: 0, bloom: true },
      rays: { rays: 3, cacheRays: 3, lightSamples: 1, steps: 64 },
      voxel: { fine: 0.4, coarse: 4 },
      cycles: 12,
      density: 1,
    };

const canvas = byId<HTMLCanvasElement>('view');
const renderer = createRenderer();
const gl = renderer.gl;
const lighting = new Lighting(gl, renderer.hdr);
const camera = new Camera();
const flight = new Flight();
const landing = new Landing();
const rig = new LightRig();
const timer = new GpuTimer(gl);
const power = new PowerModel(IS_PHONE);
const governor = new Governor({ ...PROFILE.knobs } satisfies Knobs);
const stats = new PerfStats(power);

let sun = sunAt(EVA_ELEVATION);
let density = PROFILE.density;
let custom = false;
let rtEnabled = true;
/** Tangential projection (RealityKit's default) for the site; captures use the perspective one they were trained with. */
let tangential = true;
let autoSpin = !IS_PHONE;
/** Splat index layers of the scene on screen (see renderer.ts). */
let layers: [number, number, number, number] = [0, 0, 0, 0];
/** The camera follows the landing replay until the user takes over. */
let followLanding = false;
/** Lens zoom: the Earth station uses a longer lens. Eases toward zoomTo. */
let zoom = 1;
let zoomTo = 1;
let announced = 0;
let running = false;
let idleFrames = 0;
let lastRaf = 0;
let lastRender = 0;
let forceRender = true;
let sortArrived = false;
/** The loading overlay stays up until the first sorted frame, so a new scene never flashes in half-drawn. */
let awaitingSort = false;
/** What's on screen eases toward the governor's settings rather than switching (no popping). */
let bloomLevel = 1;
let lightLevel = 0;
let minPxLevel = 0;
let frameSeed = 0;
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
    lighting: !rtEnabled
      ? 'Off'
      : !lighting.ready
        ? custom ? 'Off for captures (their lighting is baked in)' : 'Preparing'
        : lighting.status,
    rays: `${PROFILE.rays.rays} bounce + ${PROFILE.rays.lightSamples} shadow per splat, ${PROFILE.rays.cacheRays} bounce per voxel`,
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
      if (!on) Object.assign(governor.knobs, PROFILE.knobs, { bloom: governor.bloomWanted });
      forceRender = true;
      wake();
    },
    lighting: (on) => {
      rtEnabled = on;
      if (on) lighting.kick('all', PROFILE.cycles);
      forceRender = true;
      wake();
    },
    bloom: (on) => {
      governor.bloomWanted = on;
      governor.knobs.bloom = on;
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

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, governor.knobs.dpr);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    forceRender = true;
  }
  camera.fov = (canvas.clientWidth < canvas.clientHeight ? (72 * Math.PI) / 180 : Math.PI / 3) / zoom;
}

function frame(now: number): void {
  if (!running) return;
  if (lastRaf) governor.noteRaf(now - lastRaf);
  const dt = lastRaf ? Math.min(0.1, (now - lastRaf) / 1000) : 1 / 60;
  lastRaf = now;
  const cpuStart = performance.now();

  const zooming = Math.abs(zoomTo - zoom) > 0.001;
  zoom = zooming ? zoom + (zoomTo - zoom) * (1 - Math.exp(-dt * 3)) : zoomTo;
  resizeCanvas();
  const flying = flight.update(camera, now);
  if (flying === 'ended') {
    setTour(false);
    setStation('earth');
  }
  if (flying === 'idle' && autoSpin) camera.yaw += dt * 0.04;
  const keyMoved = controls.update(dt);

  // The landing replay: Eagle's pose, dust and engine, and the chase camera.
  const replaying = landing.active;
  const lf = landing.frame(now);
  if (replaying) {
    if (followLanding && landing.active) camera.setEyeLook(...landing.camera(now));
    const t = landing.time(now);
    if (announced === 0 && t >= TOUCHDOWN) {
      announced = 1;
      toast('“Houston, Tranquility Base here. The Eagle has landed.”', 4200);
    } else if (announced === 1 && t >= TOUCHDOWN + 3.2) {
      announced = 2;
      toast('Six and a half hours later: the moonwalk', 3000);
    }
    if (!landing.active) {
      byId('land').textContent = 'Landing';
      followLanding = false;
    }
  }
  sorter.setRigid(landing.active ? { start: layers[2], end: layers[3], m: Array.from(lf.eagle) } : null);

  const k = governor.knobs;
  sceneW = Math.max(1, Math.round(canvas.width * k.scale));
  sceneH = Math.max(1, Math.round(canvas.height * k.scale));
  const v = camera.compute(sceneW, sceneH);
  sorter.request(v.depthRow, v.eye);

  const key = [v.eye[0], v.eye[1], v.eye[2], v.fwd[0], v.fwd[1], v.fwd[2], sceneW, sceneH];
  let moved = false;
  for (let i = 0; i < 8 && !moved; i++) moved = !(Math.abs(key[i]! - lastView[i]!) < 1e-6);
  const relighting = rtEnabled && lighting.active;
  // Bloom, the ray-traced lighting and the sub-pixel cutoff fade over about a quarter of a second.
  const ease = 1 - Math.exp(-dt * 8);
  const bloomTo = k.bloom ? 1 : 0, lightTo = rtEnabled && lighting.ready ? 1 : 0;
  bloomLevel += (bloomTo - bloomLevel) * ease;
  lightLevel += (lightTo - lightLevel) * ease;
  minPxLevel += (k.minPx - minPxLevel) * ease;
  if (Math.abs(bloomTo - bloomLevel) < 0.002) bloomLevel = bloomTo;
  if (Math.abs(lightTo - lightLevel) < 0.002) lightLevel = lightTo;
  if (Math.abs(k.minPx - minPxLevel) < 0.01) minPxLevel = k.minPx;
  const fading = bloomLevel !== bloomTo || lightLevel !== lightTo || minPxLevel !== k.minPx;
  const busy = forceRender || moved || sortArrived || relighting || fading || replaying || zooming || flying === 'moving' || autoSpin || keyMoved;
  if (!busy) {
    sample(now);
    if (++idleFrames > 45) sleep();
    else requestAnimationFrame(frame);
    return;
  }
  idleFrames = 0;
  if (!governor.shouldRender(now, lastRender)) {
    requestAnimationFrame(frame);
    return;
  }

  timer.begin();
  let relit = 0;
  if (relighting) {
    relit = lighting.step(
      renderer.dataTex,
      {
        rows: k.rtRows,
        cacheSlices: Math.max(2, Math.round(k.rtRows / 6)),
        rays: PROFILE.rays.rays,
        cacheRays: PROFILE.rays.cacheRays,
        lightSamples: PROFILE.rays.lightSamples,
        steps: PROFILE.rays.steps,
      },
      sun,
      rig,
      0.08,
      0.08,
    );
  }
  frameSeed = (frameSeed + 1) % 997;
  renderer.render(
    {
      view: v.view, proj: v.proj, focal: v.focal, right: v.right, up: v.up, fwd: v.fwd, eye: v.eye, tanHalf: v.tanHalf, aspect: v.aspect,
      look: !custom,
      sun: sun.dir,
      fogColor: [0, 0, 0], fogDensity: 0,
      lightTex: lighting.ready && lightLevel > 0 ? lighting.tex : null, lightMix: lightLevel, lightLayout: lighting.lightLayout,
      minPx: minPxLevel, bloom: bloomLevel, seed: frameSeed, tangential,
      layers, eagle: lf.eagle, eagleInv: lf.eagleInv, evaVis: lf.eva, dust: lf.dust, engine: lf.engine, time: now / 1000,
    },
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
  stats.frameRendered(interval, performance.now() - cpuStart, power.estimateGpuMs(renderer.drawCount, sceneW * sceneH, relit));
  if (Number.isFinite(interval)) governor.record(interval);
  governor.evaluate(now, relighting);
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

async function buildSite(): Promise<void> {
  showLoading('Placing splats', 'Building Tranquility Base…');
  await nextPaint();
  const t0 = performance.now();
  const scene = buildScene(density);
  custom = false;
  setCustomUi(false);
  layers = scene.layers;
  renderer.upload(store);
  lighting.reset(store.count, 0);
  lighting.setLayers(scene.layers, scene.eagleBox);
  byId('loading-msg').textContent = 'Voxelising the site for ray tracing…';
  await nextPaint();
  const grids = buildVoxelGrids(store, scene.layers[3], scene.solids, PROFILE.voxel.fine, PROFILE.voxel.coarse, gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number);
  lighting.setGrids(grids.fine, grids.coarse);
  lighting.kick('all', PROFILE.cycles, true);
  sorter.load(store.pos.slice(0, store.count * 3), store.count);
  byId('st-n').textContent = store.count.toLocaleString('en-CA');
  awaitFirstSort();
  forceRender = true;
  wake();
  toast(`${store.count.toLocaleString('en-CA')} splats in ${((performance.now() - t0) / 1000).toFixed(1)} s. Lighting refines over the next few seconds.`, 4200);
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
    layers = [0, store.count, store.count, store.count];
    renderer.upload(store);
    lighting.reset(store.count, 0);
    sorter.load(store.pos.slice(0, store.count * 3), store.count);
    frameCapture();
    byId('st-n').textContent = store.count.toLocaleString('en-CA');
    byId<HTMLSelectElement>('aa-mode').value = asset.aa;
    const colour = asset.shDegree ? `, view-dependent colour (degree ${asset.shDegree})` : '';
    toast(`${store.count.toLocaleString('en-CA')} splats loaded${colour}. Use Flip if it looks upside down.`, 5000);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'That file could not be read.', 5000);
    await buildSite();
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
  autoSpin = false;
  followLanding = false;
  if (flight.touring) setTour(false);
  flight.stop();
  setStation(null);
}

function setStation(name: ViewName | null): void {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
}

function setTour(on: boolean): void {
  const b = byId('tour');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Stop tour' : 'Play tour';
}

function setCustomUi(on: boolean): void {
  byId('stations').hidden = on;
  byId('flip').hidden = !on;
  byId('back').hidden = !on;
  byId('aa-mode').hidden = !on;
  byId('subtitle').textContent = on ? 'Your capture' : 'Gaussian splats · Tranquility Base';
}

function setProjection(on: boolean): void {
  tangential = on;
  byId<HTMLSelectElement>('pf-proj').value = on ? 'tangential' : 'perspective';
}

function syncDensity(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.q) === density)));
}

const sunInput = byId<HTMLInputElement>('sun');

function updateSun(): void {
  const label = sunLabel(sun.elevation);
  byId('sun-out').textContent = label;
  sunInput.setAttribute('aria-valuetext', `Sun ${label} above the horizon`);
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    const name = b.dataset.view as ViewName;
    autoSpin = name === 'overview' && !IS_PHONE;
    zoomTo = name === 'earth' ? 1.6 : 1;
    followLanding = false;
    setTour(false);
    flight.goTo(camera, name, performance.now());
    setStation(name);
    wake();
  }),
);

byId('tour').addEventListener('click', () => {
  if (flight.touring) {
    flight.stop();
    setTour(false);
  } else {
    autoSpin = false;
    followLanding = false;
    flight.startTour(performance.now());
    zoomTo = 1;
    setTour(true);
    setStation(null);
  }
  wake();
});

byId('land').addEventListener('click', () => {
  if (custom) return;
  autoSpin = false;
  flight.stop();
  setTour(false);
  setStation(null);
  landing.trigger(performance.now());
  followLanding = true;
  zoomTo = 1;
  announced = 0;
  byId('land').textContent = 'Replaying…';
  toast('Eagle, 150 m up and 460 m east of the landing site', 3000);
  wake();
});

sunInput.addEventListener('input', () => {
  sun = sunAt(Number(sunInput.value));
  updateSun();
  lighting.kick('all', PROFILE.cycles);
  forceRender = true;
  wake();
});

document.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) =>
  b.addEventListener('click', () => {
    density = Number(b.dataset.q);
    syncDensity();
    void buildSite();
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
  renderer.upload(store);
  sorter.load(store.pos.slice(0, store.count * 3), store.count);
  forceRender = true;
  wake();
});

byId('back').addEventListener('click', () => {
  setProjection(true);
  void buildSite().then(() => {
    flight.goTo(camera, 'overview', performance.now());
    setStation('overview');
    wake();
  });
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
  if (IS_PHONE) byId('q-ultra').hidden = true;
  syncDensity();
  // ?eye=x,y,z&look=x,y,z opens at a particular viewpoint and ?sun=degrees sets the sun's height,
  // so a view can be shared as a link.
  const params = new URLSearchParams(location.search);
  const eye = vec3Param(params.get('eye')), look = vec3Param(params.get('look'));
  if (eye && look) {
    camera.setEyeLook(eye, look);
    setStation(null);
    autoSpin = false;
  } else {
    camera.setEyeLook(...VIEWS.overview);
    setStation('overview');
  }
  const elevation = Number(params.get('sun'));
  if (params.has('sun') && Number.isFinite(elevation)) {
    sunInput.value = String(elevation);
    sun = sunAt(Number(sunInput.value));
  }
  updateSun();
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
      return;
    } catch (err) {
      toast(`Couldn't open that capture link: ${err instanceof Error ? err.message : String(err)}`, 5000);
    }
  }
  await buildSite();
}

void start();
