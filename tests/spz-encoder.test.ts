// Checks tools/ply-to-spz.mjs against the viewer's own SPZ reader: writes a .ply of random splats,
// converts it with a random alignment (rotation, scale, translation), loads the result with
// parseSpz and compares every splat's position, shape and view-dependent colour with the source
// moved by hand. Run with: npm test
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpz } from '../src/splats/importers';
import { asset, store } from '../src/splats/store';
import { fromHalf } from '../src/util/half';

const dir = mkdtempSync(join(tmpdir(), 'spz-encoder-'));
const N = 40;
let seed = 11;
const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: 45 }, (_, k) => `f_rest_${k}`), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const rows = Array.from({ length: N }, () => {
  const r: Record<string, number> = {};
  for (const n of names) r[n] = (rnd() - 0.5) * 2;
  r.x! *= 20; r.y! *= 20; r.z! *= 20;
  r.opacity = 2 + rnd();
  r.scale_0 = -3 + rnd(); r.scale_1 = -2 - rnd(); r.scale_2 = -4 + rnd();
  for (let k = 0; k < 45; k++) r[`f_rest_${k}`]! *= 0.3;
  return r;
});
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${N}\n${names.map((n) => `property float ${n}`).join('\n')}\nend_header\n`;
const body = Buffer.alloc(N * names.length * 4);
rows.forEach((r, i) => names.forEach((n, j) => body.writeFloatLE(r[n]!, (i * names.length + j) * 4)));
writeFileSync(join(dir, 'in.ply'), Buffer.concat([Buffer.from(header, 'latin1'), body]));

const q0 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], ql = Math.hypot(...q0);
const [w, x, y, z] = q0.map((v) => v / ql) as [number, number, number, number];
const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
const scale = 1.7, T = [3, -1, 2];
writeFileSync(join(dir, 'align.json'), JSON.stringify({ scale, rotation: R, translation: T }));
const C1 = 0.4886025119029199;
function basis([x, y, z]: number[]): number[] {
  const xx = x! * x!, yy = y! * y!, zz = z! * z!;
  return [-C1 * y!, C1 * z!, -C1 * x!, 1.0925484305920792 * x! * y!, -1.0925484305920792 * y! * z!, 0.31539156525252005 * (2 * zz - xx - yy), -1.0925484305920792 * x! * z!, 0.5462742152960396 * (xx - yy),
    -0.5900435899266435 * y! * (3 * xx - yy), 2.890611442640554 * x! * y! * z!, -0.4570457994644658 * y! * (4 * zz - xx - yy), 0.3731763325901154 * z! * (2 * zz - 3 * xx - 3 * yy), -0.4570457994644658 * x! * (4 * zz - xx - yy), 1.445305721320277 * z! * (xx - yy), -0.5900435899266435 * x! * (xx - 3 * yy)];
}
const rot = (m: number[], v: number[]): number[] => [0, 1, 2].map((i) => m[i * 3]! * v[0]! + m[i * 3 + 1]! * v[1]! + m[i * 3 + 2]! * v[2]!);
const rotT = (m: number[], v: number[]): number[] => [0, 1, 2].map((i) => m[i]! * v[0]! + m[3 + i]! * v[1]! + m[6 + i]! * v[2]!);

/** Converts with the given format flags, loads the result and returns how many checks failed. */
async function check(format: string, flags: string[]): Promise<number> {
  execFileSync(process.execPath, ['tools/ply-to-spz.mjs', join(dir, 'in.ply'), join(dir, 'out.spz'), '--align', join(dir, 'align.json'), '--sh', '3', '--levels', '0.5,0.75', ...flags], { stdio: 'ignore' });
  const buf = readFileSync(join(dir, 'out.spz'));
  await parseSpz(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let failures = 0, worstPos = 0, worstCov = 0, worstSh = 0;
  if (store.count !== N) failures++;
  for (let j = 0; j < store.count; j++) {
    const p = [0, 1, 2].map((a) => store.pos[j * 3 + a]!);
    // The encoder reorders splats; match each to its source by position.
    let src = rows[0]!, bd = Infinity;
    for (const r of rows) {
      const t = rot(R, [r.x!, r.y!, r.z!]).map((v, a) => scale * v + T[a]!);
      const d = Math.hypot(t[0]! - p[0]!, t[1]! - p[1]!, t[2]! - p[2]!);
      if (d < bd) { bd = d; src = r; }
    }
    worstPos = Math.max(worstPos, bd);
    // Shape: R Σ Rᵀ scaled, against the loaded covariance.
    const ql2 = Math.hypot(src.rot_0!, src.rot_1!, src.rot_2!, src.rot_3!);
    const [qw, qx, qy, qz] = [src.rot_0!, src.rot_1!, src.rot_2!, src.rot_3!].map((v) => v / ql2) as [number, number, number, number];
    const Q = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy), 2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx), 2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)];
    const sc = [src.scale_0!, src.scale_1!, src.scale_2!].map((v) => scale * Math.exp(v));
    const M = [0, 1, 2].flatMap((i) => [0, 1, 2].map((k) => (R[i * 3]! * Q[k]! + R[i * 3 + 1]! * Q[3 + k]! + R[i * 3 + 2]! * Q[6 + k]!) * sc[k]!));
    const cov = (i: number, k: number): number => M[i * 3]! * M[k * 3]! + M[i * 3 + 1]! * M[k * 3 + 1]! + M[i * 3 + 2]! * M[k * 3 + 2]!;
    const want = [cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2)];
    const got = [0, 1, 2, 3, 4, 5].map((c) => store.cov[j * 6 + c]!);
    worstCov = Math.max(worstCov, Math.hypot(...want.map((v, c) => v - got[c]!)) / Math.hypot(...want));
    // View-dependent colour: seen along site direction d, it must match the source along Rᵀ d.
    for (let t = 0; t < 30; t++) {
      const d0 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], dl = Math.hypot(...d0), d = d0.map((v) => v / dl);
      const yd = basis(d), ys = basis(rotT(R, d));
      for (let c = 0; c < 3; c++) {
        let dec = 0, ref = 0;
        for (let k = 0; k < 15; k++) {
          dec += yd[k]! * fromHalf(asset.sh![j * asset.shTexels * 8 + k * 3 + c]!);
          ref += ys[k]! * src[`f_rest_${c * 15 + k}`]!;
        }
        worstSh = Math.max(worstSh, Math.abs(dec - ref));
      }
    }
  }
  console.log(`spz encoder, ${format}: ${store.count} splats; worst position error ${(worstPos * 1000).toFixed(2)} mm, covariance ${(worstCov * 100).toFixed(1)} %, SH colour ${worstSh.toFixed(3)}`);
  // Limits from SPZ's quantisation: 1/4096 m positions, log scales in 1/16 steps, 4-5 bit SH.
  if (worstPos > 0.001) failures++;
  if (worstCov > 0.1) failures++;
  if (worstSh > 0.2) failures++;
  return failures;
}

let failures = (await check('SPZ v3 (gzip)', [])) + (await check('SPZ v4 (zstd)', ['--zstd']));

// The light level's own file must hold exactly the first splats of the full one.
execFileSync(process.execPath, ['tools/ply-to-spz.mjs', join(dir, 'in.ply'), join(dir, 'full.spz'), '--levels', '0.25,0.5', '--zstd',
  '--light-out', join(dir, 'light.spz'), '--manifest', join(dir, 'levels.json')], { stdio: 'ignore' });
const levels = JSON.parse(readFileSync(join(dir, 'levels.json'), 'utf8')) as { splats: number; levels: { light: number; standard: number; full: number }; lightFile: string };
const load = async (name: string): Promise<Float32Array> => {
  const b = readFileSync(join(dir, name));
  await parseSpz(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return store.pos.slice(0, store.count * 3);
};
const full = await load('full.spz'), light = await load('light.spz');
const sameStart = light.length === levels.levels.light * 3 && light.every((v, i) => v === full[i]);
console.log(`spz encoder, light file: ${light.length / 3} of ${full.length / 3} splats, ${levels.lightFile}, ${sameStart ? 'matches' : 'does not match'} the full file's first splats`);
if (!sameStart || levels.lightFile !== 'light.spz' || levels.levels.full !== N || levels.levels.light !== N / 4) failures++;
if (failures) {
  console.error('spz encoder test failed');
  process.exit(1);
}
console.log('spz encoder test passed');
