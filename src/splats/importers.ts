// Loads trained Gaussian splat captures:
//   .ply         3D Gaussian Splatting output (Kerbl et al. 2023), with spherical harmonics up to degree 3
//   .splat       the compact 32-byte-per-splat format (no view-dependent colour)
//   .spz         Niantic's compressed format, versions 1–4 (gzip or per-stream zstd)
//   .glb/.gltf   glTF 2.0 with KHR_gaussian_splatting
// Everything is converted into the viewer's axes: x right, y up, z toward the viewer (RUB).
import { decompress as zstdDecompress } from 'fzstd';
import { fromHalf, toHalf } from '../util/half';
import { SH_COEFFS, allocateSh, asset, put, resetAsset, store } from './store';

const SH_C0 = 0.28209479177387814;

function covFromQuat(w: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, out: Float64Array): void {
  const l = Math.hypot(w, x, y, z) || 1;
  w /= l; x /= l; y /= l; z /= l;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  const a = r00 * sx, b = r01 * sy, c = r02 * sz, d = r10 * sx, e = r11 * sy, f = r12 * sz, g = r20 * sx, h = r21 * sy, i = r22 * sz;
  out[0] = a * a + b * b + c * c;
  out[1] = a * d + b * e + c * f;
  out[2] = a * g + b * h + c * i;
  out[3] = d * d + e * e + f * f;
  out[4] = d * g + e * h + f * i;
  out[5] = g * g + h * h + i * i;
}

/** Starts a fresh capture: clears the store and per-asset settings. */
function begin(count: number): void {
  store.count = 0;
  store.reserve(count);
  resetAsset();
}

function putSh(i: number, k: number, rgb: readonly [number, number, number]): void {
  const base = i * asset.shTexels * 8 + k * 3, sh = asset.sh!;
  sh[base] = toHalf(rgb[0]);
  sh[base + 1] = toHalf(rgb[1]);
  sh[base + 2] = toHalf(rgb[2]);
}

// ---- .ply ---------------------------------------------------------------------------------

const TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

export function parsePly(buf: ArrayBuffer): void {
  const bytes = new Uint8Array(buf), marker = 'end_header\n';
  let end = -1;
  for (let i = 0; i < Math.min(bytes.length, 65536) && end < 0; i++) {
    let hit = true;
    for (let j = 0; j < marker.length && hit; j++) hit = bytes[i + j] === marker.charCodeAt(j);
    if (hit) end = i + marker.length;
  }
  if (end < 0) throw new Error('This .ply has no readable header.');
  const header = new TextDecoder().decode(bytes.subarray(0, end));
  if (!/format binary_little_endian/.test(header)) throw new Error('Only binary little-endian .ply files are supported.');

  let count = 0, inVertex = false, stride = 0;
  const props = new Map<string, { off: number; type: string }>();
  for (const raw of header.split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === 'element') {
      inVertex = p[1] === 'vertex';
      if (inVertex) count = Number(p[2]);
    } else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list') throw new Error('List properties in the vertex element are not supported.');
      props.set(p[2]!, { off: stride, type: p[1]! });
      stride += TYPE_SIZE[p[1]!] ?? 4;
    }
  }
  if (!props.has('x')) throw new Error('This .ply has no vertex positions.');

  const dv = new DataView(buf, end);
  // One specialised reader per property, so the per-splat loop does no lookups.
  const field = (name: string): ((i: number) => number) => {
    const pr = props.get(name);
    if (!pr) return () => 0;
    const off = pr.off;
    switch (pr.type) {
      case 'float': case 'float32': return (i) => dv.getFloat32(i * stride + off, true);
      case 'double': case 'float64': return (i) => dv.getFloat64(i * stride + off, true);
      case 'uchar': case 'uint8': return (i) => dv.getUint8(i * stride + off);
      case 'char': case 'int8': return (i) => dv.getInt8(i * stride + off);
      case 'short': case 'int16': return (i) => dv.getInt16(i * stride + off, true);
      case 'ushort': case 'uint16': return (i) => dv.getUint16(i * stride + off, true);
      case 'int': case 'int32': return (i) => dv.getInt32(i * stride + off, true);
      default: return (i) => dv.getUint32(i * stride + off, true);
    }
  };
  const [x, y, z] = ['x', 'y', 'z'].map(field) as [(i: number) => number, (i: number) => number, (i: number) => number];
  const gaussian = props.has('f_dc_0') && props.has('scale_0') && props.has('rot_0');
  begin(count);
  const cov = new Float64Array(6);

  if (gaussian) {
    const [d0, d1, d2, s0, s1, s2, q0, q1, q2, q3, op] = ['f_dc_0', 'f_dc_1', 'f_dc_2', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity'].map(field) as ((i: number) => number)[];
    // f_rest is channel-major: all red coefficients, then green, then blue.
    let rest = 0;
    while (props.has(`f_rest_${rest}`)) rest++;
    const perChannel = rest / 3, fileDegree = [0, 3, 8, 15, 24].indexOf(perChannel);
    const degree = Math.min(3, Math.max(0, fileDegree));
    allocateSh(count, degree);
    const restFields = Array.from({ length: rest }, (_, k) => field(`f_rest_${k}`));
    const hasOpacity = props.has('opacity');
    for (let i = 0; i < count; i++) {
      covFromQuat(q0!(i), q1!(i), q2!(i), q3!(i), Math.exp(s0!(i)), Math.exp(s1!(i)), Math.exp(s2!(i)), cov);
      const a = hasOpacity ? 1 / (1 + Math.exp(-op!(i))) : 1;
      put(x(i), y(i), z(i), cov[0]!, cov[1]!, cov[2]!, cov[3]!, cov[4]!, cov[5]!,
        0.5 + SH_C0 * d0!(i), 0.5 + SH_C0 * d1!(i), 0.5 + SH_C0 * d2!(i), a);
      for (let k = 0; k < SH_COEFFS[degree as 0 | 1 | 2 | 3]; k++) {
        putSh(i, k, [restFields[k]!(i), restFields[perChannel + k]!(i), restFields[2 * perChannel + k]!(i)]);
      }
    }
  } else {
    const [r, g, b] = ['red', 'green', 'blue'].map((n) => (props.has(n) ? field(n) : () => 204)) as ((i: number) => number)[];
    for (let i = 0; i < count; i++) put(x(i), y(i), z(i), 0.0004, 0, 0, 0.0004, 0, 0.0004, r!(i) / 255, g!(i) / 255, b!(i) / 255, 1);
  }
  // 3DGS training data (COLMAP) is right-down-forward; turn it into our right-up-back axes.
  flipScene();
}

// ---- .splat -------------------------------------------------------------------------------

/** 32 bytes per splat: position f32×3, scale f32×3, RGBA u8×4, rotation u8×4 as (w, x, y, z). */
export function parseSplat(buf: ArrayBuffer): void {
  const n = Math.floor(buf.byteLength / 32);
  const f = new Float32Array(buf, 0, n * 8), u = new Uint8Array(buf), cov = new Float64Array(6);
  begin(n);
  for (let i = 0; i < n; i++) {
    const r = i * 32 + 28, c = i * 32 + 24;
    covFromQuat((u[r]! - 128) / 128, (u[r + 1]! - 128) / 128, (u[r + 2]! - 128) / 128, (u[r + 3]! - 128) / 128,
      f[i * 8 + 3]!, f[i * 8 + 4]!, f[i * 8 + 5]!, cov);
    put(f[i * 8]!, f[i * 8 + 1]!, f[i * 8 + 2]!, cov[0]!, cov[1]!, cov[2]!, cov[3]!, cov[4]!, cov[5]!,
      u[c]! / 255, u[c + 1]! / 255, u[c + 2]! / 255, u[c + 3]! / 255);
  }
}

// ---- .spz (Niantic) -------------------------------------------------------------------------

const SPZ_MAGIC = 0x5053474e; // "NGSP"
const SPZ_COLOR_SCALE = 0.15;

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * SPZ v1–3: gzip around a 16-byte header and the attribute arrays.
 * SPZ v4: a 32-byte header, then a table of contents of zstd-compressed streams.
 * Stored axes are right-up-back, the same as ours, so nothing is flipped.
 */
export async function parseSpz(buf: ArrayBuffer): Promise<void> {
  let bytes: Uint8Array = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== SPZ_MAGIC) throw new Error('This is not an SPZ file.');
  const version = dv.getUint32(4, true), n = dv.getUint32(8, true);
  const fileDegree = dv.getUint8(12), fractionalBits = dv.getUint8(13), flags = dv.getUint8(14);
  if (version < 1 || version > 4) throw new Error(`SPZ version ${version} isn't supported.`);
  const dim = [0, 3, 8, 15, 24][fileDegree];
  if (dim === undefined) throw new Error(`SPZ spherical-harmonic degree ${fileDegree} isn't supported.`);
  const smallestThree = version >= 3;
  const sizes = [n * (version === 1 ? 6 : 9), n, n * 3, n * 3, n * (smallestThree ? 4 : 3), n * dim * 3];

  let parts: Uint8Array[];
  if (version >= 4) {
    const streams = dv.getUint8(15), toc = dv.getUint32(16, true);
    let offset = toc + streams * 16;
    parts = [];
    for (let s = 0; s < streams; s++) {
      const compressed = Number(dv.getBigUint64(toc + s * 16, true));
      parts.push(zstdDecompress(bytes.subarray(offset, offset + compressed)));
      offset += compressed;
    }
  } else {
    let offset = 16;
    parts = sizes.map((size) => {
      const part = bytes.subarray(offset, offset + size);
      offset += size;
      return part;
    });
  }
  parts.forEach((part, s) => {
    if (s < sizes.length && part.length < sizes[s]!) throw new Error('This SPZ file is truncated.');
  });
  const [positions, alphas, colors, scales, rotations, shBytes] = parts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array | undefined];

  begin(n);
  const degree = Math.min(3, fileDegree);
  allocateSh(n, degree);
  asset.aa = flags & 0x1 ? 'aa' : 'none';
  const cov = new Float64Array(6), q = new Float64Array(4), pos = new Float64Array(3);
  const posView = new DataView(positions.buffer, positions.byteOffset, positions.byteLength);
  const fixed = 1 / (1 << fractionalBits);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      if (version === 1) pos[a] = fromHalf(posView.getUint16((i * 3 + a) * 2, true));
      else {
        const o = (i * 3 + a) * 3;
        let v = positions[o]! | (positions[o + 1]! << 8) | (positions[o + 2]! << 16);
        if (v & 0x800000) v |= 0xff000000;
        pos[a] = (v | 0) * fixed;
      }
    }
    if (smallestThree) {
      // Largest component index in the top 2 bits; the other three as 9-bit magnitude + sign.
      const r = i * 4;
      let comp = (rotations[r]! | (rotations[r + 1]! << 8) | (rotations[r + 2]! << 16) | (rotations[r + 3]! << 24)) >>> 0;
      const largest = comp >>> 30;
      let sum = 0;
      for (let k = 3; k >= 0; k--) {
        if (k === largest) continue;
        const mag = comp & 511, neg = (comp >>> 9) & 1;
        comp >>>= 10;
        const v = (Math.SQRT1_2 * mag) / 511;
        q[k] = neg ? -v : v;
        sum += v * v;
      }
      q[largest] = Math.sqrt(Math.max(0, 1 - sum));
    } else {
      const r = i * 3;
      q[0] = rotations[r]! / 127.5 - 1;
      q[1] = rotations[r + 1]! / 127.5 - 1;
      q[2] = rotations[r + 2]! / 127.5 - 1;
      q[3] = Math.sqrt(Math.max(0, 1 - q[0]! * q[0]! - q[1]! * q[1]! - q[2]! * q[2]!));
    }
    const sc = i * 3;
    covFromQuat(q[3]!, q[0]!, q[1]!, q[2]!, Math.exp(scales[sc]! / 16 - 10), Math.exp(scales[sc + 1]! / 16 - 10), Math.exp(scales[sc + 2]! / 16 - 10), cov);
    const dc = (b: number): number => 0.5 + SH_C0 * ((b / 255 - 0.5) / SPZ_COLOR_SCALE);
    put(pos[0]!, pos[1]!, pos[2]!, cov[0]!, cov[1]!, cov[2]!, cov[3]!, cov[4]!, cov[5]!,
      dc(colors[sc]!), dc(colors[sc + 1]!), dc(colors[sc + 2]!), alphas[i]! / 255);
    if (degree && shBytes) {
      // RGB interleaved per coefficient; bytes map to (b - 128) / 128.
      const base = i * dim * 3;
      for (let k = 0; k < SH_COEFFS[degree as 1 | 2 | 3]; k++) {
        const o = base + k * 3;
        putSh(i, k, [(shBytes[o]! - 128) / 128, (shBytes[o + 1]! - 128) / 128, (shBytes[o + 2]! - 128) / 128]);
      }
    }
  }
}

// ---- glTF 2.0 + KHR_gaussian_splatting --------------------------------------------------------

interface GltfAccessor { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string; sparse?: unknown }
interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface GltfPrimitive { attributes: Record<string, number>; mode?: number; extensions?: { KHR_gaussian_splatting?: { colorSpace?: string } } }
interface GltfNode { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface Gltf {
  buffers?: { uri?: string; byteLength: number }[];
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: { primitives: GltfPrimitive[] }[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  extensionsRequired?: string[];
}

const KHR = 'KHR_gaussian_splatting';
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readGltfContainer(buf: ArrayBuffer): { json: Gltf; bin: Uint8Array | null } {
  const dv = new DataView(buf);
  if (buf.byteLength >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    // .glb: 12-byte header, a JSON chunk, then an optional BIN chunk.
    let offset = 12, json: Gltf | null = null, bin: Uint8Array | null = null;
    while (offset + 8 <= buf.byteLength) {
      const length = dv.getUint32(offset, true), type = dv.getUint32(offset + 4, true);
      const chunk = new Uint8Array(buf, offset + 8, length);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
      else if (type === 0x004e4942) bin = chunk;
      offset += 8 + length;
    }
    if (!json) throw new Error('This .glb has no JSON chunk.');
    return { json, bin };
  }
  return { json: JSON.parse(new TextDecoder().decode(buf)) as Gltf, bin: null };
}

function gltfBuffers(json: Gltf, bin: Uint8Array | null): Uint8Array[] {
  return (json.buffers ?? []).map((b, i) => {
    if (!b.uri) {
      if (i === 0 && bin) return bin;
      throw new Error('This glTF references a binary buffer that is missing.');
    }
    const match = /^data:[^;]*;base64,(.*)$/.exec(b.uri);
    if (!match) throw new Error('This .gltf uses an external .bin file. Open the .glb version instead.');
    return Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0));
  });
}

/** Reads an accessor as floats, applying normalisation for integer types. */
function readAccessor(json: Gltf, buffers: Uint8Array[], index: number): { data: Float32Array; size: number; count: number } {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`Missing glTF accessor ${index}.`);
  if (acc.sparse) throw new Error('Sparse glTF accessors are not supported.');
  const size = COMPONENTS[acc.type] ?? 1, out = new Float32Array(acc.count * size);
  if (acc.bufferView === undefined) return { data: out, size, count: acc.count };
  const view = json.bufferViews![acc.bufferView]!, buffer = buffers[view.buffer]!;
  const bytesPer = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType as 5120];
  if (!bytesPer) throw new Error(`Unsupported glTF component type ${acc.componentType}.`);
  const stride = view.byteStride || bytesPer * size;
  const dv = new DataView(buffer.buffer, buffer.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0));
  const norm = !!acc.normalized;
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < size; c++) {
      const o = i * stride + c * bytesPer;
      let v: number;
      switch (acc.componentType) {
        case 5120: v = dv.getInt8(o); if (norm) v = Math.max(v / 127, -1); break;
        case 5121: v = dv.getUint8(o); if (norm) v /= 255; break;
        case 5122: v = dv.getInt16(o, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5123: v = dv.getUint16(o, true); if (norm) v /= 65535; break;
        case 5125: v = dv.getUint32(o, true); break;
        default: v = dv.getFloat32(o, true);
      }
      out[i * size + c] = v;
    }
  }
  return { data: out, size, count: acc.count };
}

type Mat4 = Float64Array;

function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x = qx!, y = qy!, z = qz!, w = qw!;
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx!, 2 * (x * y + w * z) * sx!, 2 * (x * z - w * y) * sx!, 0,
    2 * (x * y - w * z) * sy!, (1 - 2 * (x * x + z * z)) * sy!, 2 * (y * z + w * x) * sy!, 0,
    2 * (x * z + w * y) * sz!, 2 * (y * z - w * x) * sz!, (1 - 2 * (x * x + y * y)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ]);
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = s;
  }
  return out;
}

export function parseGltf(buf: ArrayBuffer): void {
  const { json, bin } = readGltfContainer(buf);
  const unsupported = (json.extensionsRequired ?? []).filter((e) => e !== KHR);
  if (unsupported.length) throw new Error(`This glTF requires ${unsupported.join(', ')}, which this viewer doesn't support.`);
  const buffers = gltfBuffers(json, bin);

  // Walk the scene graph to find every splat primitive and its world transform.
  const items: { prim: GltfPrimitive; m: Mat4 }[] = [];
  const visit = (index: number, parent: Mat4): void => {
    const node = json.nodes?.[index];
    if (!node) return;
    const m = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
        if (prim.extensions?.[KHR] || `${KHR}:SCALE` in prim.attributes) items.push({ prim, m });
      }
    }
    for (const child of node.children ?? []) visit(child, m);
  };
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ?? []).map((_, i) => i);
  for (const root of roots) visit(root, identity);
  if (!items.length) throw new Error('No KHR_gaussian_splatting primitives found in this glTF.');

  const attr = (prim: GltfPrimitive, name: string): { data: Float32Array; size: number } | null =>
    prim.attributes[name] === undefined ? null : readAccessor(json, buffers, prim.attributes[name]!);
  const total = items.reduce((n, { prim }) => n + (json.accessors?.[prim.attributes.POSITION!]?.count ?? 0), 0);

  // SH degree: the highest degree whose coefficients, and all lower ones, are present everywhere.
  let degree = 0;
  for (let l = 1; l <= 3; l++) {
    const complete = items.every(({ prim }) => Array.from({ length: 2 * l + 1 }, (_, m) => `${KHR}:SH_DEGREE_${l}_COEF_${m}`).every((n) => n in prim.attributes));
    if (!complete) break;
    degree = l;
  }

  begin(total);
  allocateSh(total, degree);
  asset.linear = items[0]!.prim.extensions?.[KHR]?.colorSpace === 'lin_rec709_display';
  const cov = new Float64Array(6);
  let index = 0;
  for (const { prim, m } of items) {
    const pos = attr(prim, 'POSITION');
    if (!pos) continue;
    const rot = attr(prim, `${KHR}:ROTATION`), scl = attr(prim, `${KHR}:SCALE`), opa = attr(prim, `${KHR}:OPACITY`);
    const dc = attr(prim, `${KHR}:SH_DEGREE_0_COEF_0`) ?? attr(prim, 'COLOR_0');
    const usesSh = !!prim.attributes[`${KHR}:SH_DEGREE_0_COEF_0`];
    const higher: Float32Array[] = [];
    for (let l = 1; l <= degree; l++) for (let c = 0; c < 2 * l + 1; c++) higher.push(attr(prim, `${KHR}:SH_DEGREE_${l}_COEF_${c}`)!.data);
    // Node transform: L is its linear part, applied to positions and covariances.
    const L = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
    for (let i = 0; i < pos.data.length / 3; i++) {
      const px = pos.data[i * 3]!, py = pos.data[i * 3 + 1]!, pz = pos.data[i * 3 + 2]!;
      const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
      const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
      const z = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
      // ROTATION is (x, y, z, w); SCALE and OPACITY are already linear.
      const q = rot ? [rot.data[i * 4 + 3]!, rot.data[i * 4]!, rot.data[i * 4 + 1]!, rot.data[i * 4 + 2]!] : [1, 0, 0, 0];
      const s = scl ? [scl.data[i * 3]!, scl.data[i * 3 + 1]!, scl.data[i * 3 + 2]!] : [0.01, 0.01, 0.01];
      covFromQuat(q[0]!, q[1]!, q[2]!, q[3]!, s[0]!, s[1]!, s[2]!, cov);
      const S = [cov[0]!, cov[1]!, cov[2]!, cov[1]!, cov[3]!, cov[4]!, cov[2]!, cov[4]!, cov[5]!];
      const T = (r: number, c: number): number => {
        let v = 0;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) v += L[a * 3 + r]! * S[a * 3 + b]! * L[b * 3 + c]!;
        return v;
      };
      const color = (c: number): number => (dc ? (usesSh ? 0.5 + SH_C0 * dc.data[i * dc.size + c]! : dc.data[i * dc.size + c]!) : 1);
      put(x, y, z, T(0, 0), T(0, 1), T(0, 2), T(1, 1), T(1, 2), T(2, 2), color(0), color(1), color(2), opa ? opa.data[i]! : 1);
      for (let k = 0; k < higher.length; k++) {
        const h = higher[k]!;
        putSh(index, k, [h[i * 3]!, h[i * 3 + 1]!, h[i * 3 + 2]!]);
      }
      index++;
    }
    // View-dependent colour is evaluated in the primitive's own axes.
    const len = (a: number, b: number, c: number): number => Math.hypot(a, b, c) || 1;
    const c0 = len(L[0]!, L[1]!, L[2]!), c1 = len(L[3]!, L[4]!, L[5]!), c2 = len(L[6]!, L[7]!, L[8]!);
    // Transpose of the rotation part, column-major.
    asset.shRot = new Float32Array([L[0]! / c0, L[3]! / c1, L[6]! / c2, L[1]! / c0, L[4]! / c1, L[7]! / c2, L[2]! / c0, L[5]! / c1, L[8]! / c2]);
  }
}

// ---- Shared -------------------------------------------------------------------------------

/**
 * Rotates the loaded capture 180° about x: converts right-down-forward data (COLMAP, .ply) to
 * right-up-back. View-dependent colour keeps using the capture's own axes.
 */
export function flipScene(): void {
  const s = store;
  for (let i = 0; i < s.count; i++) {
    s.pos[i * 3 + 1] = -s.pos[i * 3 + 1]!;
    s.pos[i * 3 + 2] = -s.pos[i * 3 + 2]!;
    s.cov[i * 6 + 1] = -s.cov[i * 6 + 1]!;
    s.cov[i * 6 + 2] = -s.cov[i * 6 + 2]!;
  }
  // world → capture directions: right-multiply by diag(1, -1, -1), i.e. negate columns 1 and 2.
  for (let i = 3; i < 9; i++) asset.shRot[i] = -asset.shRot[i]!;
}
