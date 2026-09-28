// Round-trip tests for the capture importers. Builds tiny .ply, .spz (v2, v3, v4) and .glb files
// with known splats, loads them, and checks positions, covariances, colours, opacity and SH.
// Run with: npm test
import { zstdCompressSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { parseGltf, parsePly, parseSpz } from '../src/splats/importers';
import { asset, store } from '../src/splats/store';
import { fromHalf } from '../src/util/half';

const SH_C0 = 0.28209479177387814;
let failures = 0;

function near(label: string, got: number, want: number, tol: number): void {
  if (!(Math.abs(got - want) <= tol)) {
    failures++;
    console.error(`  ✗ ${label}: got ${got}, want ${want} (±${tol})`);
  }
}

/** Two test splats: A is axis-aligned, B is turned 90° about z. */
const S = 1 / Math.SQRT2;
const splats = [
  { pos: [1, 2, 3], scale: [0.1, 0.2, 0.3], quat: [1, 0, 0, 0], alpha: 0.8, color: [0.25, 0.5, 0.75] }, // quat as w, x, y, z
  { pos: [-4, 0.5, 6], scale: [0.1, 0.2, 0.3], quat: [S, 0, 0, S], alpha: 0.5, color: [0.9, 0.1, 0.4] },
];
// Expected covariance (xx, xy, xz, yy, yz, zz) in the file's own axes.
const covA = [0.01, 0, 0, 0.04, 0, 0.09];
const covB = [0.04, 0, 0, 0.01, 0, 0.09];
const shValue = (i: number, k: number, c: number): number => 0.05 * (k + 1) * (c === 1 ? -1 : 1) * (i + 1) * 0.5;

function checkSplats(name: string, opts: { flip: boolean; offset?: number[]; tol: { pos: number; cov: number; color: number; alpha: number; sh: number }; shCoeffs: number }): void {
  console.log(`${name}: ${store.count} splats, SH degree ${asset.shDegree}`);
  near(`${name} count`, store.count, 2, 0);
  splats.forEach((sp, i) => {
    const off = opts.offset ?? [0, 0, 0];
    const f = opts.flip ? [1, -1, -1] : [1, 1, 1];
    for (let a = 0; a < 3; a++) near(`${name} splat ${i} pos[${a}]`, store.pos[i * 3 + a]!, sp.pos[a]! * f[a]! + off[a]!, opts.tol.pos);
    const want = i === 0 ? covA : covB;
    // A 180° turn about x negates the xy and xz terms.
    const sign = opts.flip ? [1, -1, -1, 1, 1, 1] : [1, 1, 1, 1, 1, 1];
    for (let c = 0; c < 6; c++) near(`${name} splat ${i} cov[${c}]`, store.cov[i * 6 + c]!, want[c]! * sign[c]!, opts.tol.cov);
    for (let c = 0; c < 3; c++) near(`${name} splat ${i} colour[${c}]`, store.col[i * 4 + c]! / 255, sp.color[c]!, opts.tol.color);
    near(`${name} splat ${i} alpha`, store.col[i * 4 + 3]! / 255, sp.alpha, opts.tol.alpha);
    for (let k = 0; k < opts.shCoeffs; k++) {
      for (let c = 0; c < 3; c++) {
        near(`${name} splat ${i} sh[${k}][${c}]`, fromHalf(asset.sh![i * asset.shTexels * 8 + k * 3 + c]!), shValue(i, k, c), opts.tol.sh);
      }
    }
  });
}

// ---- .ply (3DGS layout, SH degree 3) -------------------------------------------------------
function makePly(): ArrayBuffer {
  const names = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: 45 }, (_, k) => `f_rest_${k}`), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${names.map((n) => `property float ${n}`).join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const body = new Float32Array(splats.length * names.length);
  splats.forEach((sp, i) => {
    const row: number[] = [...sp.pos, 0, 0, 0, ...sp.color.map((c) => (c - 0.5) / SH_C0)];
    // f_rest is channel-major: 15 red, 15 green, 15 blue.
    for (let c = 0; c < 3; c++) for (let k = 0; k < 15; k++) row.push(shValue(i, k, c));
    row.push(Math.log(sp.alpha / (1 - sp.alpha)), ...sp.scale.map(Math.log), ...sp.quat);
    body.set(row, i * names.length);
  });
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head);
  out.set(new Uint8Array(body.buffer), head.length);
  return out.buffer;
}

// ---- .spz ----------------------------------------------------------------------------------
function spzArrays(version: number, shDegree: number): Uint8Array[] {
  const n = splats.length, dim = [0, 3, 8, 15][shDegree]!;
  const positions = new Uint8Array(n * 9), alphas = new Uint8Array(n), colors = new Uint8Array(n * 3), scales = new Uint8Array(n * 3);
  const rotations = new Uint8Array(n * (version >= 3 ? 4 : 3)), sh = new Uint8Array(n * dim * 3);
  const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  splats.forEach((sp, i) => {
    sp.pos.forEach((p, a) => {
      const v = Math.round(p * 4096) & 0xffffff;
      positions[i * 9 + a * 3] = v & 255;
      positions[i * 9 + a * 3 + 1] = (v >> 8) & 255;
      positions[i * 9 + a * 3 + 2] = (v >> 16) & 255;
    });
    alphas[i] = clampByte(sp.alpha * 255);
    sp.color.forEach((c, a) => (colors[i * 3 + a] = clampByte((((c - 0.5) / SH_C0) * 0.15 + 0.5) * 255)));
    sp.scale.forEach((s, a) => (scales[i * 3 + a] = clampByte((Math.log(s) + 10) * 16)));
    let [w, x, y, z] = sp.quat as [number, number, number, number];
    const xyzw = [x, y, z, w];
    if (version >= 3) {
      // Smallest three: largest |component| index in the top 2 bits; the rest as 9-bit magnitude + sign,
      // highest index in the lowest bits (the decoder walks indices 3 → 0 from bit 0 upward).
      let largest = 0;
      for (let k = 1; k < 4; k++) if (Math.abs(xyzw[k]!) > Math.abs(xyzw[largest]!)) largest = k;
      const sgn = xyzw[largest]! < 0 ? -1 : 1;
      let comp = largest << 30, shift = 0;
      for (let k = 3; k >= 0; k--) {
        if (k === largest) continue;
        const v = xyzw[k]! * sgn;
        const mag = Math.round((Math.abs(v) / Math.SQRT1_2) * 511);
        comp |= (mag | ((v < 0 ? 1 : 0) << 9)) << shift;
        shift += 10;
      }
      comp >>>= 0;
      for (let b = 0; b < 4; b++) rotations[i * 4 + b] = (comp >>> (8 * b)) & 255;
    } else {
      if (w < 0) [w, x, y, z] = [-w, -x, -y, -z];
      [x, y, z].forEach((q, a) => (rotations[i * 3 + a] = clampByte((q + 1) * 127.5)));
    }
    for (let k = 0; k < dim; k++) for (let c = 0; c < 3; c++) sh[(i * dim + k) * 3 + c] = clampByte(shValue(i, k, c) * 128 + 128);
  });
  return [positions, alphas, colors, scales, rotations, sh];
}

function spzHeader(version: number, shDegree: number, size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, version, true);
  view.setUint32(8, splats.length, true);
  view.setUint8(12, shDegree);
  view.setUint8(13, 12);
  return { bytes, view };
}

function makeSpzLegacy(version: 2 | 3, shDegree: number): ArrayBuffer {
  const parts = spzArrays(version, shDegree);
  const total = 16 + parts.reduce((n, p) => n + p.length, 0);
  const { bytes } = spzHeader(version, shDegree, total);
  let o = 16;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  const gz = gzipSync(bytes);
  return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
}

function makeSpzV4(shDegree: number): ArrayBuffer {
  const parts = spzArrays(4, shDegree).map((p) => new Uint8Array(zstdCompressSync(p)));
  const toc = 32, dataStart = toc + parts.length * 16;
  const { bytes, view } = spzHeader(4, shDegree, dataStart + parts.reduce((n, p) => n + p.length, 0));
  view.setUint8(15, parts.length);
  view.setUint32(16, toc, true);
  let o = dataStart;
  parts.forEach((p, s) => {
    view.setBigUint64(toc + s * 16, BigInt(p.length), true);
    view.setBigUint64(toc + s * 16 + 8, BigInt(spzArrays(4, shDegree)[s]!.length), true);
    bytes.set(p, o);
    o += p.length;
  });
  return bytes.buffer;
}

// ---- .glb with KHR_gaussian_splatting ---------------------------------------------------------
function makeGlb(): ArrayBuffer {
  const K = 'KHR_gaussian_splatting';
  const columns: [string, string, (sp: (typeof splats)[number], i: number) => number[]][] = [
    ['POSITION', 'VEC3', (sp) => sp.pos],
    [`${K}:ROTATION`, 'VEC4', (sp) => [sp.quat[1]!, sp.quat[2]!, sp.quat[3]!, sp.quat[0]!]], // x, y, z, w
    [`${K}:SCALE`, 'VEC3', (sp) => sp.scale],
    [`${K}:OPACITY`, 'SCALAR', (sp) => [sp.alpha]],
    [`${K}:SH_DEGREE_0_COEF_0`, 'VEC3', (sp) => sp.color.map((c) => (c - 0.5) / SH_C0)],
    ...[0, 1, 2].map((m) => [`${K}:SH_DEGREE_1_COEF_${m}`, 'VEC3', (_sp: unknown, i: number) => [0, 1, 2].map((c) => shValue(i, m, c))] as [string, string, (sp: (typeof splats)[number], i: number) => number[]]),
  ];
  const floats: number[] = [], bufferViews: object[] = [], accessors: object[] = [], attributes: Record<string, number> = {};
  columns.forEach(([name, type, get], a) => {
    const start = floats.length;
    splats.forEach((sp, i) => floats.push(...get(sp, i)));
    bufferViews.push({ buffer: 0, byteOffset: start * 4, byteLength: (floats.length - start) * 4 });
    accessors.push({ bufferView: a, componentType: 5126, count: splats.length, type });
    attributes[name] = a;
  });
  const bin = new Uint8Array(new Float32Array(floats).buffer);
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: [K],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [10, 0, 0] }],
    meshes: [{ primitives: [{ mode: 0, attributes, extensions: { [K]: { kernel: 'ellipse', colorSpace: 'srgb_rec709_display' } } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad).fill(0x20)]);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const b = 20 + jsonBytes.length;
  view.setUint32(b, bin.length, true);
  view.setUint32(b + 4, 0x004e4942, true);
  out.set(bin, b + 8);
  return out.buffer;
}

const exact = { pos: 1e-5, cov: 1e-5, color: 1 / 255, alpha: 1 / 255, sh: 2e-3 };
const quantised = { pos: 1 / 4096, cov: 0.004, color: 0.02, alpha: 1 / 255, sh: 1 / 128 };

parsePly(makePly());
checkSplats('ply', { flip: true, tol: exact, shCoeffs: 15 });
near('ply shRot[4]', asset.shRot[4]!, -1, 0);

await parseSpz(makeSpzLegacy(2, 1));
checkSplats('spz v2', { flip: false, tol: quantised, shCoeffs: 3 });

await parseSpz(makeSpzLegacy(3, 3));
checkSplats('spz v3', { flip: false, tol: quantised, shCoeffs: 15 });

await parseSpz(makeSpzV4(2));
checkSplats('spz v4', { flip: false, tol: quantised, shCoeffs: 8 });

parseGltf(makeGlb());
checkSplats('glb', { flip: false, offset: [10, 0, 0], tol: exact, shCoeffs: 3 });

if (failures) {
  console.error(`importer tests: ${failures} failures`);
  process.exit(1);
}
console.log('importer tests passed');
