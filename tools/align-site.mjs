// Works out where the reconstruction sits in the site frame and writes align.json for
// ply-to-spz.mjs and stations.mjs: metres, x east, y up, z south, Eagle's base at the origin.
//   up:     the normal of the ground plane round the anchor photos (RANSAC, then least squares)
//   scale:  the Hasselblad was chest-mounted, CAMERA_HEIGHT above the ground in the anchor photos
//           (the photos Aldrin took through Eagle's window then come out 5 m up, as they should)
//   Eagle:  the middle of the gold-foil points on its descent stage
//   north:  TURN degrees round from the model's own axes. Lens flares and shadows in several
//           photos (5863-5865, 5872-5875, 5902, 5903) put the sun at azimuth 89°, and with this
//           turn Eagle's long shadow falls over the places its photographers stood in it.
//
// Usage: node tools/align-site.mjs <COLMAP text model folder> <out align.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [modelDir, out] = process.argv.slice(2);
if (!modelDir || !out) {
  console.error('Usage: node tools/align-site.mjs <COLMAP text model folder> <out align.json>');
  process.exit(1);
}
const ANCHORS = ['5862', '5863', '5866', '5867', '5868', '5869', '5901', '5902', '5903', '5963', '5964', '5967', '5968', '5969', '5892', '5893', '5894', '5895'];
const CAMERA_HEIGHT = 1.4;
const TURN = -182.5;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => mul(v, 1 / (Math.hypot(...v) || 1));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- The model -------------------------------------------------------------------------------
const cameras = [];
const lines = readFileSync(join(modelDir, 'images.txt'), 'utf8').split('\n').filter((l) => !l.startsWith('#'));
for (let i = 0; i + 1 < lines.length; i += 2) {
  const p = lines[i].trim().split(/\s+/);
  if (p.length < 10) continue;
  const [w, x, y, z] = p.slice(1, 5).map(Number), t = p.slice(5, 8).map(Number);
  const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  const centre = [0, 1, 2].map((k) => -(R[0][k] * t[0] + R[1][k] * t[1] + R[2][k] * t[2]));
  cameras.push({ id: p[9].replace(/^AS11-40-|HR\.jpg$/g, ''), centre, up: mul(R[1], -1) });
}
const points = [];
for (const line of readFileSync(join(modelDir, 'points3D.txt'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const p = line.trim().split(/\s+/);
  points.push({ p: [Number(p[1]), Number(p[2]), Number(p[3])], rgb: [Number(p[4]), Number(p[5]), Number(p[6])] });
}
const anchors = cameras.filter((c) => ANCHORS.includes(c.id));
console.log(`${cameras.length} cameras, ${points.length} points, ${anchors.length} anchors`);

// ---- Ground plane under the anchors ---------------------------------------------------------------
const upCam = unit(anchors.reduce((a, c) => add(a, c.up), [0, 0, 0]));
const mid = mul(anchors.reduce((a, c) => add(a, c.centre), [0, 0, 0]), 1 / anchors.length);
const spread = anchors.map((c) => dist(c.centre, mid)).sort((a, b) => a - b)[anchors.length >> 1];
const near = points.filter((q) => dist(q.p, mid) < 4 * spread);
let seed = 5;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
let best = null;
for (let it = 0; it < 3000; it++) {
  const [a, b, c] = [0, 1, 2].map(() => near[Math.floor(rand() * near.length)].p);
  let n = cross(sub(b, a), sub(c, a));
  if (dot(n, n) < 1e-24) continue;
  n = unit(n);
  if (Math.abs(dot(n, upCam)) < 0.8) continue;
  const inliers = near.filter((q) => Math.abs(dot(sub(q.p, a), n)) < 0.05 * spread);
  if (!best || inliers.length > best.length) best = inliers;
}
// Least squares through the inliers: the covariance's smallest axis (Jacobi eigen-decomposition).
const m = mul(best.reduce((a, q) => add(a, q.p), [0, 0, 0]), 1 / best.length);
const C = [0, 1, 2].map((i) => [0, 1, 2].map((j) => best.reduce((s, q) => s + (q.p[i] - m[i]) * (q.p[j] - m[j]), 0)));
const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
for (let sweep = 0; sweep < 50; sweep++) {
  for (let p = 0; p < 3; p++) {
    for (let q = p + 1; q < 3; q++) {
      if (Math.abs(C[p][q]) < 1e-30) continue;
      const th = (C[q][q] - C[p][p]) / (2 * C[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) [C[k][p], C[k][q]] = [c * C[k][p] - s * C[k][q], s * C[k][p] + c * C[k][q]];
      for (let k = 0; k < 3; k++) [C[p][k], C[q][k]] = [c * C[p][k] - s * C[q][k], s * C[p][k] + c * C[q][k]];
      for (let k = 0; k < 3; k++) [V[k][p], V[k][q]] = [c * V[k][p] - s * V[k][q], s * V[k][p] + c * V[k][q]];
    }
  }
}
const kMin = [0, 1, 2].reduce((a, b) => (C[b][b] < C[a][a] ? b : a));
let up = unit([V[0][kMin], V[1][kMin], V[2][kMin]]);
if (dot(up, upCam) < 0) up = mul(up, -1);
const heights = anchors.map((c) => dot(sub(c.centre, m), up)).sort((a, b) => a - b);
const scale = CAMERA_HEIGHT / heights[anchors.length >> 1];
console.log(`ground plane from ${best.length} points, ${((Math.acos(Math.min(1, dot(up, upCam))) * 180) / Math.PI).toFixed(1)}° from the anchors' up; ${scale.toFixed(3)} m per unit`);

// ---- Eagle: gold foil 0.3-3.5 m up within 20 m of the anchors ------------------------------------------
const X0 = unit(cross(Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], up)), Z0 = cross(X0, up);
const flat = (p) => { const d = sub(p, m); return [dot(d, X0) * scale, dot(d, up) * scale, dot(d, Z0) * scale]; };
const ax = anchors.reduce((a, c) => a + flat(c.centre)[0], 0) / anchors.length, az = anchors.reduce((a, c) => a + flat(c.centre)[2], 0) / anchors.length;
const gold = points.map((q) => ({ f: flat(q.p), rgb: q.rgb })).filter(({ f, rgb: [r, g, b] }) =>
  f[1] > 0.3 && f[1] < 3.5 && Math.hypot(f[0] - ax, f[2] - az) < 20 && r > 70 && r > 1.25 * g && g > 1.15 * b);
const median = (a) => a.sort((x, y) => x - y)[a.length >> 1];
const gx = median(gold.map((g) => g.f[0])), gz = median(gold.map((g) => g.f[2]));
const eagle = add(add(m, mul(X0, gx / scale)), mul(Z0, gz / scale));
console.log(`${gold.length} gold points; Eagle at (${gx.toFixed(2)}, ${gz.toFixed(2)}) m in the model's own ground axes`);

// ---- North: provisional azimuth a (clockwise from -Z0) becomes a + TURN --------------------------------------
const turn = (TURN * Math.PI) / 180;
const east = sub(mul(X0, Math.cos(turn)), mul(Z0, Math.sin(turn))), south = cross(east, up);
const rotation = [...east, ...up, ...south];
const translation = [east, up, south].map((axis) => -scale * dot(axis, eagle));
writeFileSync(out, JSON.stringify({ scale, rotation, translation }, null, 1));

for (const c of cameras.filter((c) => ['5847', '5869', '5875', '5886'].includes(c.id))) {
  const d = sub(c.centre, eagle);
  console.log(`  ${c.id}: (${[east, up, south].map((a) => (scale * dot(d, a)).toFixed(1)).join(', ')}) m`);
}
console.log(`wrote ${out}`);
