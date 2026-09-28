// What Armstrong and Aldrin set out during the moonwalk, laid out roughly as NASA's site map and
// the TV footage show it: the flag north-west of Eagle, the TV camera about 20 m north looking
// back at Eagle, the solar-wind foil, the seismometer and laser reflector to the south, footprints
// everywhere they walked, and the two astronauts. x is east, z south; Eagle's ladder faces west.
import { PI, type RGB, type Vec3 } from '../util/math';
import { hash, reseed, rng, rr } from '../util/random';
import { S, SC, blob, canvasPanel, line, rasterize } from '../splats/primitives';
import { drawFlag } from './eagle';
import { groundAt } from './terrain';

export const FLAG: [number, number] = [-8, -8];
export const TV_CAMERA: [number, number] = [-6, -20];
export const SEISMOMETER: [number, number] = [-3, 17];
export const REFLECTOR: [number, number] = [-6.5, 14.5];
export const FOIL: [number, number] = [-5.5, -3.2];
const LADDER: [number, number] = [-4.9, 0];

type Frame = { o: Vec3; f: Vec3; r: Vec3 };

/** A point in a local frame: a to the right, b up, c forward. */
const at = (fr: Frame, a: number, b: number, c: number): Vec3 => [fr.o[0] + fr.r[0] * a + fr.f[0] * c, fr.o[1] + b, fr.o[2] + fr.r[2] * a + fr.f[2] * c];

/** An ellipsoid in a local frame with half-widths along right, up and forward. */
function ellipsoid(fr: Frame, a: number, b: number, c: number, sr: number, su: number, sf: number, col: RGB, gain = 1): void {
  SC(...at(fr, a, b, c), ...fr.r, 0, 1, 0, sr, su, sf, [...col, 1, gain]);
}

/** A box in a local frame from thin panels, spaced sp. */
function box(fr: Frame, a: number, b: number, c: number, w: number, h: number, d: number, col: RGB, sp: number): void {
  const faces: [number, number, number, number, number, 'x' | 'y' | 'z'][] = [
    [a - w / 2, b, c, d, h, 'x'], [a + w / 2, b, c, d, h, 'x'],
    [a, b - h / 2, c, w, d, 'y'], [a, b + h / 2, c, w, d, 'y'],
    [a, b, c - d / 2, w, h, 'z'], [a, b, c + d / 2, w, h, 'z'],
  ];
  for (const [fa, fb, fc, s1, s2, axis] of faces) {
    const n1 = Math.max(1, Math.round(s1 / sp)), n2 = Math.max(1, Math.round(s2 / sp));
    for (let i = 0; i < n1; i++) {
      for (let j = 0; j < n2; j++) {
        const u = ((i + 0.5) / n1 - 0.5) * s1, v = ((j + 0.5) / n2 - 0.5) * s2;
        const shade = 0.93 + 0.1 * hash(i, j, 77);
        const c3: RGB = [col[0] * shade, col[1] * shade, col[2] * shade];
        if (axis === 'x') S(...at(fr, fa, fb + v, fc + u), ...fr.f, 0, 1, 0, (s1 / n1) * 0.7, (s2 / n2) * 0.7, 0.01, ...c3);
        else if (axis === 'y') S(...at(fr, fa + u, fb, fc + v), ...fr.r, ...fr.f, (s1 / n1) * 0.7, (s2 / n2) * 0.7, 0.01, ...c3);
        else S(...at(fr, fa + u, fb + v, fc), ...fr.r, 0, 1, 0, (s1 / n1) * 0.7, (s2 / n2) * 0.7, 0.01, ...c3);
      }
    }
  }
}

const SUIT: RGB = [0.86, 0.86, 0.84];
const DUSTY: RGB = [0.62, 0.6, 0.56];
const GLOVE: RGB = [0.42, 0.47, 0.56];
const BOOT: RGB = [0.58, 0.6, 0.63];
const VISOR: RGB = [0.95, 0.72, 0.3];

/** An astronaut in the A7L suit and backpack, visor down, facing `face` radians (0 = east). */
function astronaut(x: number, z: number, face: number, pose: 'salute' | 'camera'): void {
  const f: Vec3 = [Math.cos(face), 0, Math.sin(face)], r: Vec3 = [-f[2], 0, f[0]];
  const fr: Frame = { o: [x, groundAt(x, z), z], f, r };
  for (const s of [-1, 1]) {
    // Overshoes, legs grey with dust below the knee, thighs.
    ellipsoid(fr, 0.13 * s, 0.08, 0.05, 0.085, 0.075, 0.16, BOOT);
    ellipsoid(fr, 0.13 * s, 0.4, 0, 0.085, 0.22, 0.09, DUSTY);
    ellipsoid(fr, 0.12 * s, 0.78, 0.01, 0.095, 0.2, 0.1, SUIT);
  }
  ellipsoid(fr, 0, 1.2, 0, 0.24, 0.3, 0.17, SUIT); // torso
  ellipsoid(fr, 0, 1.03, 0, 0.21, 0.08, 0.15, SUIT); // waist
  box(fr, 0, 1.3, 0.2, 0.2, 0.12, 0.08, [0.46, 0.47, 0.5], 0.03); // chest controls
  box(fr, 0, 1.22, -0.3, 0.5, 0.66, 0.24, [0.84, 0.84, 0.82], 0.04); // backpack
  box(fr, 0, 1.64, -0.3, 0.47, 0.18, 0.24, [0.8, 0.8, 0.78], 0.04); // oxygen purge unit
  // Helmet: a white shell, with the gold visor down over the front.
  const hc = at(fr, 0, 1.7, 0.04), hr = 0.19, sp = 0.028;
  const rings = Math.round((PI * hr) / sp);
  for (let i = 0; i < rings; i++) {
    const th = ((i + 0.5) / rings) * PI, y = Math.cos(th), rr0 = Math.sin(th), around = Math.max(4, Math.round((2 * PI * hr * rr0) / sp));
    for (let j = 0; j < around; j++) {
      const ph = ((j + 0.5) / around) * 2 * PI;
      const n: Vec3 = [rr0 * Math.cos(ph), y, rr0 * Math.sin(ph)];
      const facing = n[0] * f[0] + n[2] * f[2];
      const t: Vec3 = [-Math.sin(ph), 0, Math.cos(ph)], b: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
      const visor = facing > 0.25 && y < 0.72 && y > -0.55;
      SC(hc[0] + n[0] * hr, hc[1] + n[1] * hr, hc[2] + n[2] * hr, ...t, ...b, sp * 0.75, sp * 0.75, 0.008, visor ? [...VISOR, 1, -1.88] : [0.9, 0.9, 0.88]);
    }
  }
  // Arms, and the camera on Armstrong's chest.
  for (const s of [-1, 1]) {
    const shoulder = at(fr, 0.27 * s, 1.4, 0);
    let elbow: Vec3, hand: Vec3;
    if (pose === 'salute' && s > 0) {
      elbow = at(fr, 0.42, 1.44, 0.2);
      hand = at(fr, 0.16, 1.64, 0.2);
    } else if (pose === 'camera') {
      elbow = at(fr, 0.3 * s, 1.1, 0.15);
      hand = at(fr, 0.1 * s, 1.27, 0.32);
    } else {
      elbow = at(fr, 0.31 * s, 1.08, 0.04);
      hand = at(fr, 0.31 * s, 0.84, 0.1);
    }
    line(...shoulder, ...elbow, 0.078, 0.06, ...SUIT);
    line(...elbow, ...hand, 0.07, 0.06, ...SUIT);
    blob(...hand, 0.065, ...GLOVE);
  }
  if (pose === 'camera') box(fr, 0, 1.3, 0.32, 0.12, 0.12, 0.1, [0.72, 0.73, 0.75], 0.02);
}

/** The flag, hung from its crossbar, facing north toward the TV camera. */
function flag(): void {
  const [px, pz] = FLAG, h = groundAt(px, pz);
  line(px, h - 0.05, pz, px, h + 2.06, pz, 0.018, 0.05, 0.86, 0.86, 0.83);
  line(px, h + 2.03, pz, px - 1.36, h + 2.03, pz, 0.012, 0.05, 0.86, 0.86, 0.83);
  // The crossbar never fully extended, so the nylon hung in the ripples seen in every photo.
  const W = 1.36, H = 0.91, sp = 0.012, nu = Math.round(W / sp), nv = Math.round(H / sp);
  const { px: img } = rasterize(nu, nv, drawFlag);
  const ripple = (fu: number, fv: number): [number, number] => {
    const k = 2 * PI * 2.3, a = 0.05 * (0.25 + fu);
    const z = a * Math.sin(fu * k + 0.4) + 0.015 * Math.sin(fv * 9 + fu * 5);
    const dzdx = (-(a * k * Math.cos(fu * k + 0.4)) - 0.05 * Math.sin(fu * k + 0.4) - 0.075 * Math.cos(fv * 9 + fu * 5)) / W;
    return [z, dzdx];
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const q = (j * nu + i) * 4, fu = (i + 0.5) / nu, fv = (j + 0.5) / nv;
      const [dz, slope] = ripple(fu, fv), ul = Math.hypot(1, slope);
      S(px - fu * W, h + 2.02 - fv * H, pz + dz, -1 / ul, 0, -slope / ul, 0, 1, 0, sp * 0.7, sp * 0.7, 0.006, img[q]! / 255, img[q + 1]! / 255, img[q + 2]! / 255);
    }
  }
}

/** The Passive Seismic Experiment: a foil-wrapped core, a thermal skirt and two solar panel wings. */
function seismometer(): void {
  const [x, z] = SEISMOMETER, h = groundAt(x, z), sp = 0.035;
  for (let a = -0.65; a < 0.65; a += sp) for (let c = -0.65; c < 0.65; c += sp) SC(x + a, h + 0.03, z + c, 1, 0, 0, 0, 0, 1, sp * 0.7, sp * 0.7, 0.005, [0.72, 0.73, 0.75, 1, -1.6]);
  const fr: Frame = { o: [x, h, z], f: [0, 0, 1], r: [-1, 0, 0] };
  box(fr, 0, 0.42, 0, 0.45, 0.62, 0.45, [0.85, 0.6, 0.24], 0.03);
  box(fr, 0, 0.76, 0, 0.48, 0.05, 0.48, [0.78, 0.79, 0.8], 0.03);
  line(x, h + 0.78, z, x, h + 1.1, z, 0.01, 0.03, 0.7, 0.7, 0.7);
  for (const s of [-1, 1]) {
    for (let a = 0.3; a < 1.2; a += sp) {
      for (let c = -0.62; c < 0.62; c += sp) {
        const grid = Math.abs(((a * 8) % 1) - 0.5) > 0.44 || Math.abs(((c * 6) % 1) - 0.5) > 0.44;
        SC(x + a * s, h + 0.64, z + c, 1, 0, 0, 0, 0, 1, sp * 0.7, sp * 0.7, 0.005, grid ? [0.7, 0.7, 0.72, 1, -1.5] : [0.07, 0.09, 0.2, 1, -0.3]);
      }
    }
  }
}

/** The Laser Ranging Retro-Reflector: a panel of 100 corner cubes tilted toward Earth. */
function reflector(): void {
  const [x, z] = REFLECTOR, h = groundAt(x, z);
  const fr: Frame = { o: [x, h, z], f: [1, 0, 0], r: [0, 0, 1] };
  box(fr, 0, 0.08, 0, 0.62, 0.12, 0.5, [0.8, 0.62, 0.3], 0.03);
  const draw = (ctx: CanvasRenderingContext2D, w: number, hh: number): void => {
    ctx.fillStyle = '#9a9ea3';
    ctx.fillRect(0, 0, w, hh);
    ctx.fillStyle = '#16181c';
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
      ctx.beginPath();
      ctx.arc(((i + 0.5) / 10) * w, ((j + 0.5) / 10) * hh, w * 0.038, 0, 2 * PI);
      ctx.fill();
    }
  };
  // Tilted up toward the west, where Earth hangs in the sky.
  const up: Vec3 = [0.4, 0.917, 0];
  canvasPanel([x - up[0] * 0.23, h + 0.3 - up[1] * 0.23, z - 0.23], [0, 0, 1], up, 0.46, 0.46, 0.008, draw, 1);
}

/** The Solar Wind Composition foil: a sheet of aluminium on a pole, turned to the sun. */
function solarWindFoil(): void {
  const [x, z] = FOIL, h = groundAt(x, z), sp = 0.025;
  line(x, h - 0.05, z, x, h + 1.45, z, 0.012, 0.04, 0.8, 0.8, 0.8);
  for (let y = 0.1; y < 1.4; y += sp) {
    for (let c = -0.15; c < 0.15; c += sp) {
      const t = (hash(Math.floor(y * 12), Math.floor(c * 12), 5) - 0.5) * 0.25;
      SC(x + 0.02, h + y, z + c, 0, t, 1, 0, 1, 0, sp * 0.7, sp * 0.7, 0.004, [0.82, 0.83, 0.85, 1, -1.75]);
    }
  }
}

/** The black-and-white TV camera on its tripod, looking south at Eagle, and its cable. */
function tvCamera(): void {
  const [x, z] = TV_CAMERA, h = groundAt(x, z), head: Vec3 = [x, h + 1.28, z];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * 2 * PI + 0.4;
    line(...head, x + Math.cos(a) * 0.5, groundAt(x + Math.cos(a) * 0.5, z + Math.sin(a) * 0.5), z + Math.sin(a) * 0.5, 0.012, 0.04, 0.3, 0.3, 0.31);
  }
  const fr: Frame = { o: [x, h, z], f: [0.2, 0, 0.98], r: [-0.98, 0, 0.2] };
  box(fr, 0, 1.36, 0.02, 0.1, 0.1, 0.27, [0.16, 0.16, 0.17], 0.02);
  blob(...at(fr, 0, 1.36, 0.17), 0.035, 0.05, 0.05, 0.06);
  // The cable back to Eagle, lying in loose curves on the ground.
  let px = x, pz = z;
  for (let i = 1; i <= 60; i++) {
    const f = i / 60, nx = x + (-2.2 - x) * f + Math.sin(f * 11) * 0.8, nz = z + (1.8 - z) * f + Math.cos(f * 7) * 0.5;
    line(px, groundAt(px, pz) + 0.015, pz, nx, groundAt(nx, nz) + 0.015, nz, 0.008, 0.05, 0.08, 0.08, 0.09);
    px = nx;
    pz = nz;
  }
}

// ---- Footprints ---------------------------------------------------------------------------------

const PRINT: RGB = [0.34, 0.325, 0.31];

/** One bootprint pressed into the soil: darker, with a hint of the sole's ridges. */
function print(x: number, z: number, dir: number): void {
  const h = groundAt(x, z) + 0.012, dx = Math.cos(dir), dz = Math.sin(dir);
  S(x, h, z, dx, 0, dz, -dz, 0, dx, 0.13, 0.055, 0.004, ...PRINT, 0.85);
  S(x + dx * 0.08, h + 0.001, z + dz * 0.08, dx, 0, dz, -dz, 0, dx, 0.05, 0.05, 0.004, ...PRINT, 0.7);
}

/** Footprints along a path of (x, z) points: a step every 0.7 m, left and right. */
function trail(points: [number, number][], wander = 0.12): void {
  let side = 1;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!, [bx, bz] = points[i + 1]!, len = Math.hypot(bx - ax, bz - az), dir = Math.atan2(bz - az, bx - ax);
    for (let s = 0; s < len; s += 0.7) {
      const px = ax + ((bx - ax) * s) / len, pz = az + ((bz - az) * s) / len;
      side = -side;
      print(px - Math.sin(dir) * 0.15 * side + rr(-wander, wander), pz + Math.cos(dir) * 0.15 * side + rr(-wander, wander), dir + rr(-0.25, 0.25));
    }
  }
}

/** Ground walked over again and again: prints every which way. */
function trample(x: number, z: number, radius: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = rng() * 2 * PI, d = Math.sqrt(rng()) * radius;
    print(x + Math.cos(a) * d, z + Math.sin(a) * d, rng() * 2 * PI);
  }
}

/** The famous bootprint (photographed as AS11-40-5878): a crisp sole with its ridges. */
function famousPrint(x: number, z: number, dir: number): void {
  const h = groundAt(x, z) + 0.013, dx = Math.cos(dir), dz = Math.sin(dir);
  for (let i = 0; i < 14; i++) {
    const t = (i / 13 - 0.5) * 0.3, w = 0.055 * Math.sqrt(1 - (2 * t / 0.32) ** 2);
    const shade = i % 2 ? 0.3 : 0.4;
    S(x + dx * t, h, z + dz * t, -dz, 0, dx, dx, 0, dz, Math.max(0.01, w), 0.009, 0.003, shade, shade * 0.96, shade * 0.9);
  }
}

/** Everything from the moonwalk. */
export function buildMoonwalk(): void {
  reseed(20);
  flag();
  seismometer();
  reflector();
  solarWindFoil();
  tvCamera();
  trample(...LADDER, 2.2, 90);
  trample(FLAG[0], FLAG[1], 1.5, 40);
  trample(SEISMOMETER[0] - 1.5, SEISMOMETER[1] - 1, 2.8, 70);
  trample(TV_CAMERA[0], TV_CAMERA[1] + 0.8, 1.0, 16);
  trail([LADDER, [-6.5, -4], FLAG, [-7.5, -14], [TV_CAMERA[0], TV_CAMERA[1] + 1]]);
  trail([[TV_CAMERA[0] + 0.5, TV_CAMERA[1] + 1], [-5, -12], [-4.5, -4], LADDER]);
  trail([LADDER, FOIL]);
  trail([LADDER, [-5.8, 5], [-5.5, 11], [SEISMOMETER[0] - 1, SEISMOMETER[1] - 1.5]]);
  trail([[-4.5, 2], [-1, 6], [3, 6.2], [6, 3], [6.2, -3], [2, -6.3], [-3, -6], [-5, -2]]);
  trail([[-1, 6], [20, 7], [34, 6], [45, 4]], 0.2);
  famousPrint(-6.4, 1.9, 0.4);
  // Aldrin saluting the flag, and Armstrong off to one side with the camera.
  astronaut(FLAG[0] - 1.1, FLAG[1] + 0.9, -2.2, 'salute');
  astronaut(FLAG[0] - 6.6, FLAG[1] - 1.4, 0.4, 'camera');
}
