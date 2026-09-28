// Converts a trained 3D Gaussian Splatting .ply into the site's .spz (Niantic's compressed format,
// version 3). On the way it moves the capture into the site frame (metres, x east, y up, z south,
// Eagle at the origin), rotating each splat and its view-dependent colour to match, drops splats
// too faint to see or outside the site, and keeps spherical harmonics up to a chosen degree.
//
// Usage: node tools/ply-to-spz.mjs <in.ply> <out.spz> [--align align.json] [--sh 0-3] [--radius metres]
//                                   [--keep count] [--levels light,standard] [--manifest out.json] [--zstd]
//                                   [--fraction bits] [--cameras COLMAP text model folder] [--light-out light.spz]
//
// align.json maps the capture's own (COLMAP) axes to the site: site = scale * rotation * p + translation,
// with rotation a row-major 3x3 matrix.
//
// Splats are ranked by importance so the least important can be dropped (--keep) and the rest
// written in detail tiers, most important first: the viewer's lighter levels draw just the first
// tiers. --levels gives the tiers' shares of the total, and --manifest writes their sizes for the
// viewer; --light-out also writes the lightest level as a file of its own. With --cameras (the COLMAP text model the capture was trained from), importance is
// opacity times the largest footprint the splat had in any training photo, in pixels: a small
// splat right in front of a camera outranks a big one too far off to cover a pixel. Without it,
// importance is opacity times a weak power of the splat's size.
//
// The output is SPZ version 3 (one gzip stream), or version 4 with --zstd (each attribute
// array compressed separately with zstd). Positions are 24-bit fixed point with --fraction bits
// after the point (default 12, a quarter of a millimetre); fewer bits compress better.
import { readFileSync, writeFileSync } from 'node:fs';
import { constants, gzipSync, zstdCompressSync } from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const [input, output] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!input || !output) {
  console.error('Usage: node tools/ply-to-spz.mjs <in.ply> <out.spz> [--align align.json] [--sh 0-3] [--radius metres]');
  process.exit(1);
}
const align = flag('--align') ? JSON.parse(readFileSync(flag('--align'), 'utf8')) : { scale: 1, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };
const shOut = Number(flag('--sh', '3'));
const radius = Number(flag('--radius', 'Infinity'));
const keepMax = Number(flag('--keep', 'Infinity'));
const levels = flag('--levels', '1,1').split(',').map(Number);
const manifestPath = flag('--manifest');
const zstd = argv.includes('--zstd');
const camerasDir = flag('--cameras');
const lightOut = flag('--light-out');

// ---- Read the .ply ---------------------------------------------------------------------------
const buf = readFileSync(input);
const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const header = buf.subarray(0, headerEnd).toString('latin1');
if (!/binary_little_endian/.test(header)) throw new Error('Only binary little-endian .ply files are supported.');
let count = 0, stride = 0, inVertex = false;
const props = new Map();
const SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
for (const line of header.split('\n')) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'element') {
    inVertex = p[1] === 'vertex';
    if (inVertex) count = Number(p[2]);
  } else if (p[0] === 'property' && inVertex) {
    if (!['float', 'float32'].includes(p[1])) throw new Error(`Expected float properties, got ${p[1]} ${p[2]}.`);
    props.set(p[2], stride);
    stride += SIZE[p[1]];
  }
}
const dv = new DataView(buf.buffer, buf.byteOffset + headerEnd);
const f = (name) => {
  const off = props.get(name);
  if (off === undefined) throw new Error(`The .ply has no ${name}.`);
  return (i) => dv.getFloat32(i * stride + off, true);
};
let rest = 0;
while (props.has(`f_rest_${rest}`)) rest++;
const perChannel = rest / 3, shIn = [0, 3, 8, 15].indexOf(perChannel);
if (shIn < 0) throw new Error(`Unexpected number of SH coefficients: ${rest}.`);
const degree = Math.min(shIn, shOut), coeffs = [0, 3, 8, 15][degree];
const X = f('x'), Y = f('y'), Z = f('z'), OP = f('opacity');
const DC = [0, 1, 2].map((c) => f(`f_dc_${c}`)), SC = [0, 1, 2].map((c) => f(`scale_${c}`)), ROT = [0, 1, 2, 3].map((c) => f(`rot_${c}`));
const REST = Array.from({ length: rest }, (_, k) => f(`f_rest_${k}`));

// ---- The alignment -----------------------------------------------------------------------------
const R = align.rotation, s = align.scale, T = align.translation;
const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
if (Math.abs(det - 1) > 1e-3) throw new Error(`The alignment's rotation has determinant ${det.toFixed(4)}; it must be a proper rotation.`);

/** The rotation matrix as a unit quaternion (w, x, y, z). */
function matToQuat(m) {
  const tr = m[0] + m[4] + m[8];
  let w, x, y, z;
  if (tr > 0) {
    const k = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / k; x = (m[7] - m[5]) * k; y = (m[2] - m[6]) * k; z = (m[3] - m[1]) * k;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const k = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);
    w = (m[7] - m[5]) / k; x = 0.25 * k; y = (m[1] + m[3]) / k; z = (m[2] + m[6]) / k;
  } else if (m[4] > m[8]) {
    const k = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);
    w = (m[2] - m[6]) / k; x = (m[1] + m[3]) / k; y = 0.25 * k; z = (m[5] + m[7]) / k;
  } else {
    const k = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);
    w = (m[3] - m[1]) / k; x = (m[2] + m[6]) / k; y = (m[5] + m[7]) / k; z = 0.25 * k;
  }
  const l = Math.hypot(w, x, y, z);
  return [w / l, x / l, y / l, z / l];
}
const qa = matToQuat(R);

// Spherical-harmonic basis per band (graphdeco-inria/gaussian-splatting, sh_utils.py), for a unit direction.
function band(l, [x, y, z]) {
  const xx = x * x, yy = y * y, zz = z * z;
  if (l === 1) return [-0.4886025119029199 * y, 0.4886025119029199 * z, -0.4886025119029199 * x];
  if (l === 2) return [1.0925484305920792 * x * y, -1.0925484305920792 * y * z, 0.31539156525252005 * (2 * zz - xx - yy), -1.0925484305920792 * x * z, 0.5462742152960396 * (xx - yy)];
  return [-0.5900435899266435 * y * (3 * xx - yy), 2.890611442640554 * x * y * z, -0.4570457994644658 * y * (4 * zz - xx - yy),
    0.3731763325901154 * z * (2 * zz - 3 * xx - 3 * yy), -0.4570457994644658 * x * (4 * zz - xx - yy), 1.445305721320277 * z * (xx - yy),
    -0.5900435899266435 * x * (xx - 3 * yy)];
}

/** Solves A x = b for a small dense system (Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Per band, the matrix taking coefficients in the capture's axes to coefficients in the site's:
// the colour seen along site direction d must equal the colour the capture had along R^T d.
// Fitted by least squares over many directions (it's exact: each band rotates within itself).
const shRot = [null];
for (let l = 1; l <= 3; l++) {
  const n = 2 * l + 1, dirs = [];
  for (let k = 0; k < 96; k++) {
    const u = (k + 0.5) / 96, phi = k * 2.399963229728653;
    const r = Math.sqrt(1 - (1 - 2 * u) ** 2);
    dirs.push([r * Math.cos(phi), 1 - 2 * u, r * Math.sin(phi)]);
  }
  const A = dirs.map((d) => band(l, d));
  const B = dirs.map((d) => band(l, [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]]));
  // Normal equations: (A^T A) M = A^T B, so Y(R^T d) = Y(d) M and the new coefficients are M old.
  const AtA = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => A.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const col = solve(AtA, Array.from({ length: n }, (_, i) => A.reduce((sum, row, k) => sum + row[i] * B[k][j], 0)));
    for (let i = 0; i < n; i++) M[i][j] = col[i];
  }
  shRot.push(M);
}

// ---- The training cameras, in the site frame ---------------------------------------------------------
let views = null;
if (camerasDir) {
  const intrinsics = new Map();
  for (const line of readFileSync(`${camerasDir}/cameras.txt`, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const q = line.trim().split(/\s+/);
    intrinsics.set(q[0], { w: Number(q[2]), h: Number(q[3]), f: Number(q[4]) });
  }
  views = [];
  const lines = readFileSync(`${camerasDir}/images.txt`, 'utf8').split('\n').filter((l) => !l.startsWith('#'));
  for (let k = 0; k + 1 < lines.length; k += 2) {
    const q = lines[k].trim().split(/\s+/);
    if (q.length < 10) continue;
    const [w, x, y, z] = q.slice(1, 5).map(Number), t = q.slice(5, 8).map(Number), cam = intrinsics.get(q[8]);
    const M = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
    const c = [0, 1, 2].map((j) => -(M[0][j] * t[0] + M[1][j] * t[1] + M[2][j] * t[2]));
    const toSite = (v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
    views.push({ c: toSite(c).map((v, j) => s * v + T[j]), right: toSite(M[0]), down: toSite(M[1]), fwd: toSite(M[2]), f: cam.f, hx: (cam.w / 2 / cam.f) * 1.05, hy: (cam.h / 2 / cam.f) * 1.05 });
  }
}

/** The largest area (pixels², capped at a 24-pixel radius) a splat covered in any training photo it was in. */
function footprint(p, area) {
  let best = 0;
  for (const v of views) {
    const d = [p[0] - v.c[0], p[1] - v.c[1], p[2] - v.c[2]];
    const z = d[0] * v.fwd[0] + d[1] * v.fwd[1] + d[2] * v.fwd[2];
    if (z < 0.2) continue;
    if (Math.abs(d[0] * v.right[0] + d[1] * v.right[1] + d[2] * v.right[2]) > v.hx * z) continue;
    if (Math.abs(d[0] * v.down[0] + d[1] * v.down[1] + d[2] * v.down[2]) > v.hy * z) continue;
    best = Math.max(best, (v.f * v.f * area) / (z * z));
  }
  return Math.min(best, 24 * 24 * Math.PI);
}

// ---- Select, transform and pack ------------------------------------------------------------------
const sigmoid = (v) => 1 / (1 + Math.exp(-v));
let keep = [];
for (let i = 0; i < count; i++) {
  const alpha = sigmoid(OP(i));
  if (alpha < 1.5 / 255) continue;
  const x = X(i), y = Y(i), z = Z(i);
  const p = [s * (R[0] * x + R[1] * y + R[2] * z) + T[0], s * (R[3] * x + R[4] * y + R[5] * z) + T[1], s * (R[6] * x + R[7] * y + R[8] * z) + T[2]];
  if (Math.hypot(p[0], p[2]) > radius) continue;
  // Footprint area from the scales: sqrt(s1²s2² + s1²s3² + s2²s3²), the area of the largest
  // cross-section for flat splats.
  const [a2, b2, c2] = SC.map((f) => Math.exp(2 * f(i)));
  const area = s * s * Math.sqrt(a2 * b2 + a2 * c2 + b2 * c2);
  keep.push({ i, p, importance: views ? alpha * footprint(p, area) : alpha * Math.pow(area, 0.25) });
}
keep.sort((a, b) => b.importance - a.importance);
if (keep.length > keepMax) keep = keep.slice(0, keepMax);

// Morton order within each tier, so neighbouring splats sit together and the arrays compress better.
const FRACTION = Number(flag('--fraction', '12')), LIMIT = (1 << 23) - 1;
const quant = (v) => Math.max(-LIMIT, Math.min(LIMIT, Math.round(v * (1 << FRACTION))));
const spread = (v) => {
  let x = BigInt(v & 0x1fffff);
  x = (x | (x << 32n)) & 0x1f00000000ffffn;
  x = (x | (x << 16n)) & 0x1f0000ff0000ffn;
  x = (x | (x << 8n)) & 0x100f00f00f00f00fn;
  x = (x | (x << 4n)) & 0x10c30c30c30c30c3n;
  x = (x | (x << 2n)) & 0x1249249249249249n;
  return x;
};
for (const k of keep) {
  const q = k.p.map((v) => (Math.round(v * 64) + (1 << 20)) & 0x1fffff); // 1.6 cm cells for the order only
  k.code = spread(q[0]) | (spread(q[1]) << 1n) | (spread(q[2]) << 2n);
}
const tiers = [...levels.map((f) => Math.round(Math.min(1, f) * keep.length)), keep.length];
const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
keep = tiers.flatMap((end, t) => keep.slice(t ? tiers[t - 1] : 0, end).sort(byCode));

const n = keep.length;
const positions = Buffer.alloc(n * 9), alphas = Buffer.alloc(n), colors = Buffer.alloc(n * 3), scales = Buffer.alloc(n * 3);
const rotations = Buffer.alloc(n * 4), sh = Buffer.alloc(n * coeffs * 3);
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const logS = Math.log(s);
keep.forEach(({ i, p }, j) => {
  for (let a = 0; a < 3; a++) {
    const v = quant(p[a]) & 0xffffff;
    positions[j * 9 + a * 3] = v & 255;
    positions[j * 9 + a * 3 + 1] = (v >> 8) & 255;
    positions[j * 9 + a * 3 + 2] = (v >> 16) & 255;
  }
  alphas[j] = byte(sigmoid(OP(i)) * 255);
  for (let c = 0; c < 3; c++) {
    colors[j * 3 + c] = byte((DC[c](i) * 0.15 + 0.5) * 255);
    scales[j * 3 + c] = byte((SC[c](i) + logS + 10) * 16);
  }
  // Splat rotation: the alignment's rotation after the splat's own (w, x, y, z).
  const [bw, bx, by, bz] = [ROT[0](i), ROT[1](i), ROT[2](i), ROT[3](i)];
  const [aw, ax, ay, az] = qa;
  let q = [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  const l = Math.hypot(...q) || 1;
  q = q.map((v) => v / l); // (x, y, z, w)
  let largest = 0;
  for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[largest])) largest = k;
  if (q[largest] < 0) q = q.map((v) => -v);
  let comp = 0;
  for (let k = 0; k < 4; k++) {
    if (k === largest) continue;
    const mag = Math.min(511, Math.round((Math.abs(q[k]) / Math.SQRT1_2) * 511));
    comp = (comp << 10) | ((q[k] < 0 ? 1 : 0) << 9) | mag;
  }
  rotations.writeUInt32LE((comp | (largest << 30)) >>> 0, j * 4);
  // View-dependent colour, rotated band by band, quantised like Niantic's encoder (5 bits for the
  // first band, 4 for the rest; the reader maps a byte b to (b - 128) / 128).
  for (let lvl = 1, k0 = 0; lvl <= degree; k0 += 2 * lvl + 1, lvl++) {
    const nb = 2 * lvl + 1, M = shRot[lvl], step = lvl === 1 ? 8 : 16;
    for (let c = 0; c < 3; c++) {
      const old = Array.from({ length: nb }, (_, m) => REST[c * perChannel + k0 + m](i));
      for (let m = 0; m < nb; m++) {
        let v = 0;
        for (let k = 0; k < nb; k++) v += M[m][k] * old[k];
        sh[(j * coeffs + k0 + m) * 3 + c] = byte(Math.round((v * 128 + 128) / step) * step);
      }
    }
  }
});

/** The file for the first `m` splats: SPZ v4 (zstd per stream) or v3 (gzip). */
function encode(m) {
  const cut = (a, per) => a.subarray(0, m * per);
  const streams = [cut(positions, 9), cut(alphas, 1), cut(colors, 3), cut(scales, 3), cut(rotations, 4)];
  if (degree) streams.push(cut(sh, coeffs * 3));
  const head = Buffer.alloc(zstd ? 32 : 16);
  head.writeUInt32LE(0x5053474e, 0); // "NGSP"
  head.writeUInt32LE(zstd ? 4 : 3, 4);
  head.writeUInt32LE(m, 8);
  head[12] = degree;
  head[13] = FRACTION;
  head[14] = 0; // flags: not trained with antialiasing
  if (!zstd) return gzipSync(Buffer.concat([head, ...streams]), { level: 9 });
  // Version 4: the header, a table of contents (compressed and raw size per stream), then the streams.
  const packed = streams.map((a) => zstdCompressSync(a, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }));
  head[15] = packed.length;
  head.writeUInt32LE(32, 16);
  const toc = Buffer.alloc(packed.length * 16);
  packed.forEach((p, k) => {
    toc.writeBigUInt64LE(BigInt(p.length), k * 16);
    toc.writeBigUInt64LE(BigInt(streams[k].length), k * 16 + 8);
  });
  return Buffer.concat([head, toc, ...packed]);
}

const body = encode(n);
writeFileSync(output, body);
// The lightest level on its own, so phones needn't download the rest.
const light = lightOut ? encode(tiers[0]) : null;
if (light) writeFileSync(lightOut, light);
if (manifestPath) {
  const manifest = { splats: n, levels: { light: tiers[0], standard: tiers[1], full: n } };
  if (lightOut) manifest.lightFile = lightOut.split(/[\\/]/).pop();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`${n.toLocaleString('en-CA')} of ${count.toLocaleString('en-CA')} splats, SH degree ${degree}, ${(body.length / 1048576).toFixed(1)} MB` +
  `${light ? ` (light level alone ${(light.length / 1048576).toFixed(1)} MB)` : ''}; tiers ${tiers.join(' / ')}`);