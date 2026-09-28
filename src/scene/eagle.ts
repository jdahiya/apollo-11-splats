// Eagle, the Apollo 11 lunar module, as it stood at Tranquility Base: the octagonal descent stage
// wrapped in gold and black foil on four legs, the ladder and porch on the front leg with the
// plaque, and the grey-and-black ascent stage on top with its windows, hatch, propellant tanks,
// thruster quads and antennas. It faces west: its front, with the ladder, toward -x.
//
// Parts are laid out in Eagle's own frame (a right, b up, c forward) and mapped to the world.
import { PI, type RGB, type Vec3 } from '../util/math';
import { hash } from '../util/random';
import { SC, blob, canvasPanel, line, lightBlob, type Color } from '../splats/primitives';
import { glow } from '../splats/store';

type L3 = [number, number, number];

/** Eagle's frame to the world: forward is west, right is north. */
const W = (p: L3): Vec3 => [-p[2], p[1], -p[0]];

interface Mat {
  c: RGB;
  /** Gain: 1 plain, negative for reflective foil and metal (see splat.vert). */
  gain: number;
  /** How far each crinkle tips the normal, and the crinkles' size in metres. */
  tilt: number;
  cell: number;
}

const GOLD: Mat = { c: [0.86, 0.62, 0.26], gain: -1.3, tilt: 0.3, cell: 0.07 };
const AMBER: Mat = { c: [0.7, 0.44, 0.16], gain: -1.25, tilt: 0.28, cell: 0.08 };
const BLACK: Mat = { c: [0.05, 0.05, 0.06], gain: -0.1, tilt: 0.1, cell: 0.22 };
const SILVER: Mat = { c: [0.74, 0.75, 0.77], gain: -1.5, tilt: 0.26, cell: 0.08 };
const GREY: Mat = { c: [0.33, 0.34, 0.36], gain: -1.12, tilt: 0.03, cell: 0.6 };
const DARK: Mat = { c: [0.13, 0.13, 0.14], gain: 1, tilt: 0.02, cell: 0.6 };
const GLASS: Mat = { c: [0.03, 0.035, 0.05], gain: -0.3, tilt: 0, cell: 1 };

const cross = (a: L3, b: L3): L3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: L3): L3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

let seedBase = 0;

/**
 * A rectangle of surface from corner o along unit axes u and v (Eagle's frame), one splat every sp
 * metres, the material picked per spot (null leaves a hole). Foil is crinkled: each crinkle tips the
 * splats' normal its own way, so glints break up as they do on the real blankets.
 */
function sheet(o: L3, u: L3, v: L3, w: number, h: number, sp: number, pick: (fu: number, fv: number) => Mat | null): void {
  const nu = Math.max(1, Math.round(w / sp)), nv = Math.max(1, Math.round(h / sp)), su = w / nu, sv = h / nv;
  const n = cross(u, v), seed = ++seedBase * 17;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const fu = (i + 0.5) / nu, fv = (j + 0.5) / nv, m = pick(fu, fv);
      if (!m) continue;
      const ci = Math.floor((fu * w) / m.cell), cj = Math.floor((fv * h) / m.cell);
      const t1 = (hash(ci, cj, seed) - 0.5) * m.tilt, t2 = (hash(ci, cj, seed + 1) - 0.5) * m.tilt;
      const nn = norm([n[0] + u[0] * t1 + v[0] * t2, n[1] + u[1] * t1 + v[1] * t2, n[2] + u[2] * t1 + v[2] * t2]);
      const d = u[0] * nn[0] + u[1] * nn[1] + u[2] * nn[2];
      const uu = norm([u[0] - d * nn[0], u[1] - d * nn[1], u[2] - d * nn[2]]), vv = cross(nn, uu);
      const shade = 0.92 + 0.16 * hash(ci, cj, seed + 2);
      const p: L3 = [o[0] + u[0] * fu * w + v[0] * fv * h, o[1] + u[1] * fu * w + v[1] * fv * h, o[2] + u[2] * fu * w + v[2] * fv * h];
      const col: Color = [m.c[0] * shade, m.c[1] * shade, m.c[2] * shade, 1, m.gain];
      SC(...W(p), ...W(uu), ...W(vv), su * 0.7, sv * 0.7, 0.01, col);
    }
  }
}

/** A tube from p to q (Eagle's frame): radius r, with an optional reflective gain. */
function tube(p: L3, q: L3, r: number, c: RGB, gain = 1): void {
  glow(gain);
  line(...W(p), ...W(q), r, Math.max(0.03, r * 0.9), c[0], c[1], c[2]);
  glow(1);
}

/** Points on a sphere (centre, radius) facing within `cap` radians of axis, as splats; pick by height. */
function sphere(centre: L3, r: number, sp: number, pick: (y: number) => Mat, keep: (p: L3) => boolean = () => true): void {
  const rings = Math.max(4, Math.round((PI * r) / sp));
  for (let i = 0; i < rings; i++) {
    const th = ((i + 0.5) / rings) * PI, y = Math.cos(th), rr = Math.sin(th);
    const around = Math.max(3, Math.round((2 * PI * r * rr) / sp));
    for (let j = 0; j < around; j++) {
      const ph = ((j + 0.5) / around) * 2 * PI, n: L3 = [rr * Math.cos(ph), y, rr * Math.sin(ph)];
      const p: L3 = [centre[0] + n[0] * r, centre[1] + n[1] * r, centre[2] + n[2] * r];
      if (!keep(p)) continue;
      const m = pick(y), t: L3 = norm(Math.abs(n[1]) < 0.9 ? cross([0, 1, 0], n) : cross([1, 0, 0], n)), b = cross(n, t);
      const shade = 0.88 + 0.24 * hash(i, j, 91);
      SC(...W(p), ...W(t), ...W(b), sp * 0.7, sp * 0.7, 0.01, [m.c[0] * shade, m.c[1] * shade, m.c[2] * shade, 1, m.gain]);
    }
  }
}

/** A dish (antenna or footpad): radius r at centre, facing axis, curving back by depth at its rim. */
function dish(centre: L3, axis: L3, r: number, depth: number, sp: number, m: Mat): void {
  const n = norm(axis), t = norm(Math.abs(n[1]) < 0.9 ? cross([0, 1, 0], n) : cross([1, 0, 0], n)), b = cross(n, t);
  for (let x = -r + sp / 2; x < r; x += sp) {
    for (let y = -r + sp / 2; y < r; y += sp) {
      const q = Math.hypot(x, y) / r;
      if (q > 1) continue;
      const back = depth * q * q;
      const p: L3 = [centre[0] + t[0] * x + b[0] * y - n[0] * back, centre[1] + t[1] * x + b[1] * y - n[1] * back, centre[2] + t[2] * x + b[2] * y - n[2] * back];
      SC(...W(p), ...W(t), ...W(b), sp * 0.7, sp * 0.7, 0.01, [...m.c, 1, m.gain]);
    }
  }
}

// ---- Descent stage ----------------------------------------------------------------------------

const APO = 2.05; // the octagon's apothem
const HALF = APO * Math.tan(PI / 8);
const DS_BOTTOM = 1.05, DS_TOP = 2.72;

const inOctagon = (a: number, c: number, apo: number): boolean =>
  Math.abs(a) <= apo && Math.abs(c) <= apo && (Math.abs(a) + Math.abs(c)) / Math.SQRT2 <= apo;

function descentStage(sp: number): void {
  for (let i = 0; i < 8; i++) {
    const th = (i * PI) / 4, n: L3 = [Math.cos(th), 0, Math.sin(th)], t: L3 = [-Math.sin(th), 0, Math.cos(th)];
    const o: L3 = [n[0] * APO - t[0] * HALF, DS_BOTTOM, n[2] * APO - t[2] * HALF];
    const main = i % 2 === 0;
    sheet(o, t, [0, 1, 0], 2 * HALF, DS_TOP - DS_BOTTOM, sp, (fu, fv) => {
      if (fv > 0.9 || fv < 0.06) return BLACK; // black bands round the top and bottom edges
      if (main) return Math.abs(fu - 0.5) < 0.1 && fv > 0.55 ? BLACK : fv < 0.3 ? AMBER : GOLD; // strut attach
      return fv < 0.42 ? BLACK : Math.abs(fv - 0.62) < 0.05 ? SILVER : GOLD;
    });
  }
  // Top deck (mostly under the ascent stage) and the underside's heat blanket.
  for (const [b, pick] of [[DS_TOP, (a: number, c: number) => (inOctagon(a, c, 1.3) ? BLACK : SILVER)], [DS_BOTTOM, (a: number, c: number) => (Math.hypot(a, c) < 0.9 ? BLACK : hash(Math.round(a * 3), Math.round(c * 3), 5) < 0.4 ? GOLD : BLACK)]] as const) {
    sheet([-APO, b, -APO], [1, 0, 0], [0, 0, 1], 2 * APO, 2 * APO, sp, (fu, fv) => {
      const a = -APO + fu * 2 * APO, c = -APO + fv * 2 * APO;
      return inOctagon(a, c, APO) ? pick(a, c) : null;
    });
  }
  // The descent engine's bell, and its glow (gain 5 marks it: it only shows during the landing).
  const rings = Math.round(0.7 / sp);
  for (let i = 0; i < rings; i++) {
    const f = (i + 0.5) / rings, b = DS_BOTTOM - f * 0.62, r = 0.42 + f * 0.34, around = Math.round((2 * PI * r) / sp);
    for (let j = 0; j < around; j++) {
      const ph = (j / around) * 2 * PI, n: L3 = [Math.cos(ph), -0.45, Math.sin(ph)], t: L3 = [-Math.sin(ph), 0, Math.cos(ph)];
      SC(...W([n[0] * r, b, n[2] * r]), ...W(t), ...W(norm(cross(n, t))), sp * 0.7, sp * 0.7, 0.01, [0.2, 0.19, 0.18, 1, -1.2]);
    }
  }
  glow(5);
  for (let j = 0; j < 24; j++) {
    const ph = (j / 24) * 2 * PI;
    blob(...W([Math.cos(ph) * 0.45, 0.42, Math.sin(ph) * 0.45]), 0.12, 1, 0.86, 0.62);
  }
  for (let y = 0.35; y > -0.05; y -= 0.1) blob(...W([0, y, 0]), 0.55 + (0.35 - y), 0.55, 0.65, 1, 0.12);
  glow(1);
}

// ---- Legs, ladder and porch -----------------------------------------------------------------------

const FOOT_R = 4.55, FOOT_B = 0.42, STRUT_TOP: [number, number] = [2.1, 2.45];

function legs(sp: number): void {
  for (let i = 0; i < 4; i++) {
    const th = (i * PI) / 2, d: L3 = [Math.cos(th), 0, Math.sin(th)], t: L3 = [-Math.sin(th), 0, Math.cos(th)];
    const top: L3 = [d[0] * STRUT_TOP[0], STRUT_TOP[1], d[2] * STRUT_TOP[0]], foot: L3 = [d[0] * FOOT_R, FOOT_B, d[2] * FOOT_R];
    const at = (f: number): L3 => [top[0] + (foot[0] - top[0]) * f, top[1] + (foot[1] - top[1]) * f, top[2] + (foot[2] - top[2]) * f];
    // Primary strut: the foil-wrapped upper cylinder and the bare lower piston.
    tube(top, at(0.55), 0.1, GOLD.c, -1.4);
    tube(at(0.5), foot, 0.065, SILVER.c, -1.5);
    // Secondary struts from the lower corners of the stage.
    for (const s of [-1, 1]) tube([d[0] * APO + t[0] * 0.75 * s, DS_BOTTOM + 0.1, d[2] * APO + t[2] * 0.75 * s], at(0.62), 0.04, [0.6, 0.6, 0.62]);
    // The footpad: a shallow dish, pressed a little into the soil.
    dish([d[0] * (FOOT_R + 0.05), 0.2, d[2] * (FOOT_R + 0.05)], [0, 1, 0], 0.47, 0.12, sp, SILVER);
  }
  // Ladder rails and rungs on the front leg, up to the porch.
  const bottom: L3 = [0, 0.95, 3.95], topL: L3 = [0, 2.66, 2.62];
  for (const s of [-1, 1]) tube([bottom[0] + 0.23 * s, bottom[1], bottom[2]], [topL[0] + 0.23 * s, topL[1], topL[2]], 0.022, [0.62, 0.62, 0.6]);
  for (let r = 0; r < 9; r++) {
    const f = (r + 0.5) / 9, b = bottom[1] + (topL[1] - bottom[1]) * f, c = bottom[2] + (topL[2] - bottom[2]) * f;
    tube([-0.23, b, c], [0.23, b, c], 0.016, [0.64, 0.64, 0.62]);
  }
  // The porch in front of the hatch, and its handrails.
  sheet([-0.45, DS_TOP + 0.02, 2.05], [1, 0, 0], [0, 0, 1], 0.9, 0.95, sp, (fu, fv) => (Math.floor(fu * 9) % 2 && Math.floor(fv * 8) % 2 ? null : GREY));
  for (const s of [-1, 1]) {
    tube([0.45 * s, DS_TOP + 0.05, 2.1], [0.45 * s, DS_TOP + 0.85, 2.15], 0.018, [0.6, 0.6, 0.6]);
    tube([0.45 * s, DS_TOP + 0.85, 2.15], [0.45 * s, DS_TOP + 0.6, 2.95], 0.018, [0.6, 0.6, 0.6]);
  }
}

// ---- Ascent stage -----------------------------------------------------------------------------------

const CAB = { b: 4.0, r: 1.18, c0: -0.95, c1: 1.25 };

function ascentStage(sp: number): void {
  // The crew cabin: a drum lying along the forward axis.
  const around = Math.round((2 * PI * CAB.r) / sp), along = Math.round((CAB.c1 - CAB.c0) / sp);
  for (let i = 0; i < around; i++) {
    const ph = ((i + 0.5) / around) * 2 * PI, a = Math.cos(ph) * CAB.r, b = CAB.b + Math.sin(ph) * CAB.r;
    if (b < DS_TOP + 0.05) continue;
    const n: L3 = [Math.cos(ph), Math.sin(ph), 0], t: L3 = [0, 0, 1];
    for (let j = 0; j < along; j++) {
      const c = CAB.c0 + ((j + 0.5) / along) * (CAB.c1 - CAB.c0);
      const cell = hash(Math.floor(ph * 3), Math.floor(c * 2.2), 21);
      const m = Math.sin(ph) > 0.55 ? (cell < 0.5 ? SILVER : GREY) : Math.sin(ph) < -0.3 ? BLACK : cell < 0.25 ? BLACK : GREY;
      const shade = 0.9 + 0.2 * hash(i, j, 22);
      SC(...W([a, b, c]), ...W(t), ...W(cross(n, t)), sp * 0.7, sp * 0.7, 0.01, [m.c[0] * shade, m.c[1] * shade, m.c[2] * shade, 1, m.gain]);
    }
  }
  // The front face: black, with the square hatch low down and two triangular windows.
  const win = (a: number, b: number): boolean => {
    const x = Math.abs(a), y = b - 4.28;
    return x > 0.2 && x < 0.8 && y > 0 && y < 0.68 && y < ((0.8 - x) / 0.6) * 0.68;
  };
  sheet([-CAB.r, DS_TOP + 0.08, CAB.c1], [1, 0, 0], [0, 1, 0], 2 * CAB.r, 2.45, sp, (fu, fv) => {
    const a = -CAB.r + fu * 2 * CAB.r, b = DS_TOP + 0.08 + fv * 2.45;
    if (Math.hypot(a, b - CAB.b) > CAB.r) return null;
    if (Math.abs(a) < 0.41 && b > 2.95 && b < 3.76) return Math.abs(a) > 0.34 || b < 3.02 || b > 3.69 ? SILVER : DARK;
    return win(a, b) ? GLASS : BLACK;
  });
  // Aft equipment bay behind the cabin.
  const aft = { a: 1.0, b0: 3.25, b1: 5.0, c0: -2.15, c1: CAB.c0 };
  sheet([-aft.a, aft.b0, aft.c0], [1, 0, 0], [0, 1, 0], 2 * aft.a, aft.b1 - aft.b0, sp, (fu, fv) => (fv > 0.7 ? SILVER : hash(Math.floor(fu * 5), Math.floor(fv * 4), 31) < 0.5 ? DARK : BLACK));
  for (const s of [-1, 1]) sheet([aft.a * s, aft.b0, aft.c0], [0, 0, 1], [0, 1, 0], aft.c1 - aft.c0, aft.b1 - aft.b0, sp, (_fu, fv) => (fv > 0.5 ? SILVER : GREY));
  sheet([-aft.a, aft.b1, aft.c0], [1, 0, 0], [0, 0, 1], 2 * aft.a, aft.c1 - aft.c0 + 0.4, sp, () => SILVER);
  // The ascent engine's propellant tanks, bulging out on both sides.
  for (const s of [-1, 1]) sphere([1.5 * s, 3.62, -0.85], 0.6, sp, (y) => (y > -0.2 ? SILVER : BLACK), (p) => Math.abs(p[0]) > 1.05);
  // Docking tunnel on top, with the drogue.
  const tr = 0.42, ta = Math.round((2 * PI * tr) / sp);
  for (let i = 0; i < ta; i++) {
    const ph = (i / ta) * 2 * PI;
    for (let b = CAB.b + CAB.r - 0.05; b < 5.78; b += sp) {
      SC(...W([Math.cos(ph) * tr, b, -0.15 + Math.sin(ph) * tr]), ...W([-Math.sin(ph), 0, Math.cos(ph)]), 0, 1, 0, sp * 0.7, sp * 0.7, 0.01, [...GREY.c, 1, GREY.gain]);
    }
  }
  dish([0, 5.8, -0.15], [0, 1, 0], tr, 0.02, sp, DARK);
  // Thruster quads at the four corners: a housing and four nozzles.
  for (const sa of [-1, 1]) {
    for (const sc of [-1, 1]) {
      const q: L3 = [1.32 * sa, 4.35, sc > 0 ? 0.95 : -1.45];
      sheet([q[0] - 0.16, q[1] - 0.16, q[2] - 0.16], [1, 0, 0], [0, 1, 0], 0.32, 0.32, sp * 0.6, () => DARK);
      sheet([q[0] - 0.16, q[1] - 0.16, q[2] + 0.16], [1, 0, 0], [0, 1, 0], 0.32, 0.32, sp * 0.6, () => DARK);
      for (const off of [[0, 0.28, 0], [0, -0.28, 0], [0.28 * sa, 0, 0], [0, 0, 0.28 * sc]] as L3[]) {
        blob(...W([q[0] + off[0], q[1] + off[1], q[2] + off[2]]), 0.06, 0.2, 0.2, 0.21);
      }
      // Plume deflector under the lower thruster.
      sheet([q[0] - 0.2, q[1] - 0.42, q[2] - 0.2], [1, 0, 0], [0, 0, 1], 0.4, 0.4, sp * 0.6, () => SILVER);
    }
  }
  // Antennas: the steerable S-band dish on its boom, the rendezvous radar and two VHF whips.
  tube([0.7, 5.05, -0.7], [1.0, 5.55, -0.75], 0.03, [0.55, 0.55, 0.56]);
  dish([1.0, 5.72, -0.75], [0.4, 0.7, 0.55], 0.33, 0.08, sp * 0.7, { c: [0.82, 0.82, 0.8], gain: 1, tilt: 0, cell: 1 });
  tube([0, 5.1, 0.95], [0, 5.3, 1.1], 0.05, [0.3, 0.3, 0.31]);
  dish([0, 5.38, 1.2], [0, 0.6, 0.8], 0.3, 0.07, sp * 0.7, { c: [0.8, 0.8, 0.78], gain: 1, tilt: 0, cell: 1 });
  for (const s of [-1, 1]) tube([0.75 * s, 5.0, -1.6], [0.75 * s, 6.25, -1.6], 0.012, [0.7, 0.7, 0.7]);
  // Docking lights: small lamps on the cabin.
  lightBlob(...W([0.9, 5.05, 1.1]), 0.03, 1, 0.95, 0.85, 1.4, 1.5);
}

// ---- Markings, the MESA and the plaque ----------------------------------------------------------

/** The Stars and Stripes, drawn into a w × h canvas. */
export function drawFlag(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  for (let i = 0; i < 13; i++) {
    ctx.fillStyle = i % 2 ? '#f4f4f0' : '#b22234';
    ctx.fillRect(0, (i * h) / 13, w, h / 13 + 1);
  }
  ctx.fillStyle = '#3c3b6e';
  ctx.fillRect(0, 0, w * 0.4, (h * 7) / 13);
  ctx.fillStyle = '#f4f4f0';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < (r % 2 ? 5 : 6); c++) {
      const x = w * 0.4 * ((c * 2 + (r % 2 ? 2 : 1)) / 12), y = ((h * 7) / 13) * ((r + 1) / 10);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.6, h * 0.018), 0, 2 * PI);
      ctx.fill();
    }
  }
}

function drawUnitedStates(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-PI / 2);
  ctx.fillStyle = '#f2f2ee';
  ctx.font = `700 ${Math.round(w * 0.78)}px "Arial Narrow", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('UNITED STATES', 0, 0, h * 0.96);
  ctx.restore();
}

/** The plaque on the ladder leg, in brushed steel. */
function drawPlaque(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#bfc3c7';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#6d7277';
  ctx.lineWidth = Math.max(1, w * 0.012);
  for (const cx of [0.3, 0.7]) {
    ctx.beginPath();
    ctx.arc(w * cx, h * 0.2, h * 0.14, 0, 2 * PI);
    ctx.stroke();
  }
  ctx.fillStyle = '#3b3f44';
  ctx.textAlign = 'center';
  const lines = ['HERE MEN FROM THE PLANET EARTH', 'FIRST SET FOOT UPON THE MOON', 'JULY 1969, A.D.', 'WE CAME IN PEACE FOR ALL MANKIND'];
  ctx.font = `700 ${Math.max(4, Math.round(h * 0.055))}px Arial, sans-serif`;
  lines.forEach((t, i) => ctx.fillText(t, w / 2, h * (0.46 + i * 0.075)));
  ctx.font = `600 ${Math.max(3, Math.round(h * 0.035))}px Arial, sans-serif`;
  ['NEIL A. ARMSTRONG', 'MICHAEL COLLINS', 'EDWIN E. ALDRIN, JR.'].forEach((t, i) => ctx.fillText(t, w * (0.2 + i * 0.3), h * 0.84));
  ctx.fillText('RICHARD NIXON', w / 2, h * 0.95);
}

function markings(): void {
  // On the front face beside the ladder leg (it faces west, so "right" as you face it is south).
  canvasPanel([-APO - 0.012, 1.95, 0.34], [0, 0, 1], [0, 1, 0], 0.52, 0.28, 0.012, drawFlag, 1);
  canvasPanel([-APO - 0.012, 1.12, 0.46], [0, 0, 1], [0, 1, 0], 0.16, 0.72, 0.012, drawUnitedStates, 1);
  // The plaque, on the ladder leg's strut behind the rungs, tilted with the strut.
  const up: Vec3 = [0.77, 0.638, 0], centre: Vec3 = [-3.26, 1.52, 0], w = 0.23, h = 0.19;
  canvasPanel([centre[0] - up[0] * h * 0.5, centre[1] - up[1] * h * 0.5, centre[2] - w / 2], [0, 0, 1], up, w, h, 0.0035, drawPlaque, 1);
}

/** The equipment stowage bay on the front-left, folded down, with the TV camera that filmed the first step. */
function mesa(sp: number): void {
  const th = (3 * PI) / 4, n: L3 = [Math.cos(th), 0, Math.sin(th)], t: L3 = [-Math.sin(th), 0, Math.cos(th)];
  const hinge: L3 = [n[0] * (APO + 0.05), 1.25, n[2] * (APO + 0.05)];
  const out: L3 = norm([n[0] * 0.8, -0.6, n[2] * 0.8]);
  sheet([hinge[0] - t[0] * 0.6, hinge[1], hinge[2] - t[2] * 0.6], t, out, 1.2, 0.95, sp, (fu, fv) => (fv > 0.85 || fu < 0.05 || fu > 0.95 ? SILVER : GOLD));
  const cam: L3 = [hinge[0] + out[0] * 0.2 + t[0] * 0.45, hinge[1] + 0.35, hinge[2] + out[2] * 0.2 + t[2] * 0.45];
  sheet([cam[0] - 0.1, cam[1], cam[2] - 0.05], [1, 0, 0], [0, 1, 0], 0.2, 0.12, sp * 0.5, () => DARK);
}

/** Solid inside Eagle's two stages (rest pose, world coordinates), for the voxel grids. */
export function insideEagle(x: number, y: number, z: number): boolean {
  const a = -z, c = -x;
  if (y > DS_BOTTOM + 0.12 && y < DS_TOP - 0.1 && inOctagon(a, c, APO - 0.2)) return true;
  if (y > DS_TOP + 0.2 && y < CAB.b + CAB.r - 0.2 && Math.abs(a) < 0.95 && c > -2.0 && c < CAB.c1 - 0.2) return true;
  return false;
}

/** Eagle's bounding box (world), which the lighting of everything else leaves out. */
export const EAGLE_BOX: [number, number, number, number, number, number] = [-5.2, 0.32, -5.2, 5.2, 6.4, 5.2];

/** Builds Eagle. k scales splat spacing. */
export function buildEagle(k: number): void {
  seedBase = 0;
  const sp = 0.05 * k;
  descentStage(sp);
  legs(sp);
  ascentStage(sp);
  mesa(sp);
  markings();
}
