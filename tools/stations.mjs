// Writes the photo stations: for each chosen photograph, where the camera stood, where it pointed,
// its field of view and how far it was rolled from level, all from the structure-from-motion
// model the site was trained on, moved into the site frame with align.json. Updates
// src/camera/stations.ts (stations and tour) and the station buttons in index.html.
//
// Usage: node tools/stations.mjs <COLMAP text model folder> <align.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [modelDir, alignPath] = process.argv.slice(2);
if (!modelDir || !alignPath) {
  console.error('Usage: node tools/stations.mjs <COLMAP text model folder> <align.json>');
  process.exit(1);
}

// The stations, in tour order, with what each photograph shows.
const PICKS = [
  ['ladder', 'Ladder', 'AS11-40-5869', 'AS11-40-5869 · Aldrin climbs down to the surface. He moved from photo to photo, so he was masked out of training; the ladder behind him comes from the other frames.'],
  ['hatch', 'Hatch', 'AS11-40-5863', 'AS11-40-5863 · Aldrin backs out of the hatch onto the porch, the start of his climb down.'],
  ['window', 'Window', 'AS11-40-5847', 'AS11-40-5847 · Taken through one of Eagle’s windows, about 5 m up, before the moonwalk.'],
  ['eagle', 'Eagle', 'AS11-40-5915', 'AS11-40-5915 · Eagle’s descent stage from 13 m north: its gold and black foil and two of its four footpads.'],
  ['wind', 'Solar wind', 'AS11-40-5872', 'AS11-40-5872 · Aldrin by the solar-wind collector, a sheet of foil set out to catch particles streaming from the Sun.'],
  ['flag', 'Flag', 'AS11-40-5875', 'AS11-40-5875 · Aldrin beside the flag. Its crossbar never fully extended, so it hung rippled, as it does here.'],
  ['shadow', 'Shadow', 'AS11-40-5886', 'AS11-40-5886 · From 13 m west of Eagle, inside its long shadow, with the flag and the solar-wind collector beyond.'],
  ['footpad', 'Footpad', 'AS11-40-5902', 'AS11-40-5902 · One of Eagle’s footpads, and the ground the astronauts trampled round it.'],
  ['portrait', 'Portrait', 'AS11-40-5903', 'AS11-40-5903 · Where Armstrong stood for his portrait of Aldrin. Aldrin is masked out, and no other photo saw the ground behind him clearly, so that patch is soft; the footprints round it are from the film.'],
];

const cams = new Map();
for (const line of readFileSync(join(modelDir, 'cameras.txt'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const p = line.trim().split(/\s+/);
  cams.set(p[0], { w: Number(p[2]), h: Number(p[3]), params: p.slice(4).map(Number) });
}
const images = new Map();
const lines = readFileSync(join(modelDir, 'images.txt'), 'utf8').split('\n').filter((l) => !l.startsWith('#'));
for (let i = 0; i + 1 < lines.length; i += 2) {
  const p = lines[i].trim().split(/\s+/);
  if (p.length < 10) continue;
  images.set(p[9].replace(/HR\.jpg$/, ''), { q: p.slice(1, 5).map(Number), t: p.slice(5, 8).map(Number), cam: p[8] });
}

const align = JSON.parse(readFileSync(alignPath, 'utf8'));
const A = align.rotation, s = align.scale, T = align.translation;
const rot = (v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** World-from-camera rotation (columns are the camera's x right, y down, z forward in COLMAP world). */
function camAxes(q) {
  const [w, x, y, z] = q;
  const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  // R maps world to camera; its rows are the camera axes in world coordinates.
  return { right: R[0], down: R[1], fwd: R[2], R };
}

const r2 = (v) => Math.round(v * 100) / 100;
const stations = [];
for (const [key, label, id, caption] of PICKS) {
  const im = images.get(id);
  if (!im) throw new Error(`${id} isn't in the model.`);
  const { right, down, fwd, R } = camAxes(im.q);
  // Camera centre: -R^T t.
  const c = [0, 1, 2].map((k) => -(R[0][k] * im.t[0] + R[1][k] * im.t[1] + R[2][k] * im.t[2]));
  const eye = rot(c).map((v, k) => s * v + T[k]);
  const f = unit(rot(fwd)), up = unit(rot(down).map((v) => -v));
  const look = eye.map((v, k) => v + 10 * f[k]);
  // The viewer's level camera for this aim (camera.ts basis), and the photo's roll against it.
  const r0 = unit([-f[2], 0, f[0]]), u0 = cross(r0, f);
  const roll = (Math.atan2(dot(up, r0), dot(up, u0)) * 180) / Math.PI;
  const cam = cams.get(im.cam);
  const fov = (2 * Math.atan(cam.h / 2 / cam.params[0]) * 180) / Math.PI;
  stations.push({ key, label, id, caption, eye: eye.map(r2), look: look.map(r2), fov: Math.round(fov * 10) / 10, roll: Math.round(roll * 10) / 10 });
  console.log(`${key}: ${id} at (${eye.map((v) => v.toFixed(1)).join(', ')}), fov ${fov.toFixed(1)}, roll ${roll.toFixed(1)}`);
}

const q = (v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const vec = (v) => `[${v.join(', ')}]`;
const stationLines = stations.map((st) =>
  `  ${st.key}: {\n    eye: ${vec(st.eye)}, look: ${vec(st.look)}, fov: ${st.fov},\n    caption: ${q(st.caption)},\n    photo: { id: '${st.id}', roll: ${st.roll} },\n  },`);
// The tour skips the window: flying into the cabin would pass through Eagle.
const legs = stations.filter((st) => st.key !== 'window');
const tourLines = [`  ${legs.map((st) => `'${st.key}'`).join(', ')},`];

/** Replaces the lines between the marker lines. */
const replaceBetween = (text, begin, end, body) => {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`Markers ${begin} / ${end} not found.`);
  return text.slice(0, text.indexOf('\n', a) + 1) + body + '\n' + text.slice(text.lastIndexOf('\n', b) + 1);
};

const stationsTs = join(root, 'src/camera/stations.ts');
let ts = readFileSync(stationsTs, 'utf8');
ts = replaceBetween(ts, '// STATIONS:BEGIN', '// STATIONS:END', stationLines.join('\n'));
ts = replaceBetween(ts, '// TOUR:BEGIN', '// TOUR:END', tourLines.join('\n'));
writeFileSync(stationsTs, ts);

const indexHtml = join(root, 'index.html');
let html = readFileSync(indexHtml, 'utf8');
html = replaceBetween(html, '<!-- STATION-BUTTONS:BEGIN', '<!-- STATION-BUTTONS:END', stations.map((st) => `    <button data-view="${st.key}">${st.label}</button>`).join('\n'));
writeFileSync(indexHtml, html);
console.log(`${stations.length} stations written; photos to export: ${stations.map((st) => st.id).join(' ')}`);
