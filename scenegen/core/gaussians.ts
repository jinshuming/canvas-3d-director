/**
 * Gaussian splats as plain arrays, in Node: read a 3DGS PLY (what SAM 3D
 * writes) or an SPZ (what JST-2 writes), move / turn / scale them, thin them,
 * put several together, and write one SPZ (version 3, one gzip stream) that the
 * director and the viewer load.
 *
 * Conventions: positions xyz; scales are LOG scales; rotations are unit
 * quaternions stored x, y, z, w; alphas 0-1; colours are the SH DC term
 * (colour = 0.5 + 0.2821 * dc). Higher SH bands are dropped.
 */
import { gunzipSync, gzipSync, zstdDecompressSync } from 'node:zlib';

export interface Gaussians {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  alphas: Float32Array;
  colors: Float32Array;
}

const SH_DIM = [0, 3, 8, 15, 24];
const COLOR_SCALE = 0.15;

function alloc(n: number): Gaussians {
  return { count: n, positions: new Float32Array(n * 3), scales: new Float32Array(n * 3), rotations: new Float32Array(n * 4), alphas: new Float32Array(n), colors: new Float32Array(n * 3) };
}

// ── PLY (3DGS) ─────────────────────────────────────────────────────────────

export function readPlyGaussians(buf: Uint8Array): Gaussians {
  const headText = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 4096)));
  const end = headText.indexOf('end_header\n');
  if (!headText.startsWith('ply') || end < 0) throw new Error('Not a PLY file.');
  if (!headText.includes('binary_little_endian')) throw new Error('Only binary little-endian PLY is supported.');
  const n = Number(/element vertex (\d+)/.exec(headText)?.[1] ?? 0);
  const props = [...headText.slice(0, end).matchAll(/property (\w+) (\w+)/g)].map((m) => ({ type: m[1]!, name: m[2]! }));
  const size = (t: string) => (t === 'double' ? 8 : t === 'uchar' || t === 'uint8' || t === 'char' ? 1 : t === 'short' || t === 'ushort' ? 2 : 4);
  const off: Record<string, number> = {};
  let stride = 0;
  for (const p of props) { off[p.name] = stride; stride += size(p.type); }
  for (const need of ['x', 'y', 'z', 'f_dc_0', 'opacity', 'scale_0', 'rot_0']) if (off[need] === undefined) throw new Error(`PLY lacks ${need}: not a Gaussian splat.`);
  const base = new TextEncoder().encode(headText.slice(0, end + 'end_header\n'.length)).length;
  const dv = new DataView(buf.buffer, buf.byteOffset + base, n * stride);
  const g = alloc(n);
  const f = (i: number, name: string) => dv.getFloat32(i * stride + off[name]!, true);
  for (let i = 0; i < n; i++) {
    g.positions[i * 3] = f(i, 'x'); g.positions[i * 3 + 1] = f(i, 'y'); g.positions[i * 3 + 2] = f(i, 'z');
    for (let k = 0; k < 3; k++) { g.scales[i * 3 + k] = f(i, `scale_${k}`); g.colors[i * 3 + k] = f(i, `f_dc_${k}`); }
    g.alphas[i] = 1 / (1 + Math.exp(-f(i, 'opacity')));
    // PLY stores w, x, y, z (rot_0 = w).
    const w = f(i, 'rot_0'), x = f(i, 'rot_1'), y = f(i, 'rot_2'), z = f(i, 'rot_3');
    const l = Math.hypot(w, x, y, z) || 1;
    g.rotations[i * 4] = x / l; g.rotations[i * 4 + 1] = y / l; g.rotations[i * 4 + 2] = z / l; g.rotations[i * 4 + 3] = w / l;
  }
  return g;
}

// ── SPZ ────────────────────────────────────────────────────────────────────

function inflate(b: Uint8Array): Uint8Array {
  if (b[0] === 0x1f && b[1] === 0x8b) return gunzipSync(b);
  if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return zstdDecompressSync(b);
  return b;
}

export function readSpzGaussians(input: Uint8Array): Gaussians {
  let file = input;
  if (file[0] === 0x1f && file[1] === 0x8b) file = gunzipSync(file);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== 0x5053474e) throw new Error('Not an SPZ file (no NGSP header).');
  const version = view.getUint32(4, true), n = view.getUint32(8, true), shDegree = file[12]!, fb = file[13]!;
  if (shDegree > 4 || !(n > 0) || n > 2e7) throw new Error(`Implausible SPZ header (v${version}, ${n} points).`);
  const want = { positions: version >= 2 ? 9 : 6, alphas: 1, colors: 3, scales: 3, rotations: version >= 3 ? 4 : 3, sh: SH_DIM[shDegree]! * 3 };
  const names = (['positions', 'alphas', 'colors', 'scales', 'rotations', 'sh'] as const).filter((k) => want[k] > 0);
  const s: Record<string, Uint8Array> = {};
  if (version >= 4) {
    const toc = view.getUint32(16, true);
    let at = toc + names.length * 16;
    for (const [i, name] of names.entries()) {
      const compressed = Number(view.getBigUint64(toc + i * 16, true));
      s[name] = inflate(file.subarray(at, at + compressed));
      at += compressed;
    }
  } else {
    let at = 16;
    for (const name of names) { s[name] = file.subarray(at, at + want[name] * n); at += want[name] * n; }
  }
  const g = alloc(n);
  const p = s.positions!;
  if (version >= 2) {
    const k = 1 / (1 << fb);
    for (let i = 0; i < n * 3; i++) { let v = p[i * 3]! | (p[i * 3 + 1]! << 8) | (p[i * 3 + 2]! << 16); if (v & 0x800000) v |= 0xff000000; g.positions[i] = v * k; }
  } else {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let i = 0; i < n * 3; i++) g.positions[i] = half(dv.getUint16(i * 2, true));
  }
  for (let i = 0; i < n; i++) g.alphas[i] = s.alphas![i]! / 255;
  for (let i = 0; i < n * 3; i++) { g.colors[i] = (s.colors![i]! / 255 - 0.5) / COLOR_SCALE; g.scales[i] = s.scales![i]! / 16 - 10; }
  const r = s.rotations!;
  if (version >= 3) {
    const rv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    for (let i = 0; i < n; i++) {
      const bits = rv.getUint32(i * 4, true), largest = (bits >>> 30) & 3;
      let sum = 0, shift = 20;
      for (let c = 0; c < 4; c++) {
        if (c === largest) continue;
        const field = (bits >>> shift) & 1023, mag = ((field & 511) / 511) * Math.SQRT1_2, v = field & 512 ? -mag : mag;
        g.rotations[i * 4 + c] = v; sum += v * v; shift -= 10;
      }
      g.rotations[i * 4 + largest] = Math.sqrt(Math.max(0, 1 - sum));
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = r[i * 3]! / 127.5 - 1, y = r[i * 3 + 1]! / 127.5 - 1, z = r[i * 3 + 2]! / 127.5 - 1;
      g.rotations.set([x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))], i * 4);
    }
  }
  return g;
}

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * (m + 1024) * 2 ** (e - 25);
}

/** SPZ version 3 (gzip, smallest-three rotations), SH degree 0. */
export function writeSpzGaussians(g: Gaussians, fractionalBits = 12): Uint8Array {
  const n = g.count;
  const head = new Uint8Array(16);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, 3, true); dv.setUint32(8, n, true);
  head[12] = 0; head[13] = fractionalBits;
  const pos = new Uint8Array(n * 9), alphas = new Uint8Array(n), cols = new Uint8Array(n * 3), scl = new Uint8Array(n * 3), rot = new Uint8Array(n * 4);
  const lim = (1 << 23) - 1, k = 1 << fractionalBits;
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < n * 3; i++) {
    const v = Math.max(-lim, Math.min(lim, Math.round(g.positions[i]! * k)));
    pos[i * 3] = v & 0xff; pos[i * 3 + 1] = (v >> 8) & 0xff; pos[i * 3 + 2] = (v >> 16) & 0xff;
    cols[i] = byte((g.colors[i]! * COLOR_SCALE + 0.5) * 255);
    scl[i] = byte((g.scales[i]! + 10) * 16);
  }
  const rv = new DataView(rot.buffer);
  for (let i = 0; i < n; i++) {
    alphas[i] = byte(g.alphas[i]! * 255);
    const q = [g.rotations[i * 4]!, g.rotations[i * 4 + 1]!, g.rotations[i * 4 + 2]!, g.rotations[i * 4 + 3]!];
    let largest = 0;
    for (let c = 1; c < 4; c++) if (Math.abs(q[c]!) > Math.abs(q[largest]!)) largest = c;
    const sign = q[largest]! < 0 ? -1 : 1;
    let bits = largest << 30, shift = 20;
    for (let c = 0; c < 4; c++) {
      if (c === largest) continue;
      const v = q[c]! * sign;
      const mag = Math.min(511, Math.round((Math.abs(v) / Math.SQRT1_2) * 511));
      bits |= ((v < 0 ? 512 : 0) | mag) << shift;
      shift -= 10;
    }
    rv.setUint32(i * 4, bits >>> 0, true);
  }
  const body = new Uint8Array(16 + pos.length + alphas.length + cols.length + scl.length + rot.length);
  let at = 0;
  for (const part of [head, pos, alphas, cols, scl, rot]) { body.set(part, at); at += part.length; }
  return gzipSync(body);
}

// ── Editing ────────────────────────────────────────────────────────────────

export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

export const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export const mul = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r]![0]! * b[0]![c]! + a[r]![1]! * b[1]![c]! + a[r]![2]! * b[2]![c]!)) as Mat3;

/** Turn about +Y by `deg` (x towards -z for positive angles, like the blockout's yaw turning the front from +Z to +X). */
export function rotY(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

function quatOf(m: Mat3): [number, number, number, number] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const tr = a + e + i;
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (h - f) / s; y = (c - g) / s; z = (d - b) / s; }
  else if (a > e && a > i) { const s = Math.sqrt(1 + a - e - i) * 2; w = (h - f) / s; x = s / 4; y = (b + d) / s; z = (c + g) / s; }
  else if (e > i) { const s = Math.sqrt(1 + e - a - i) * 2; w = (c - g) / s; x = (b + d) / s; y = s / 4; z = (f + h) / s; }
  else { const s = Math.sqrt(1 + i - a - e) * 2; w = (d - b) / s; x = (c + g) / s; y = (f + h) / s; z = s / 4; }
  return [x, y, z, w];
}

/** p' = s · R · p + t, every Gaussian's orientation turned by R and its size scaled by s. In place. */
export function transformGaussians(g: Gaussians, R: Mat3, s: number, t: [number, number, number]): Gaussians {
  const [qx, qy, qz, qw] = quatOf(R);
  const ls = Math.log(s);
  for (let i = 0; i < g.count; i++) {
    const x = g.positions[i * 3]!, y = g.positions[i * 3 + 1]!, z = g.positions[i * 3 + 2]!;
    g.positions[i * 3] = s * (R[0][0] * x + R[0][1] * y + R[0][2] * z) + t[0];
    g.positions[i * 3 + 1] = s * (R[1][0] * x + R[1][1] * y + R[1][2] * z) + t[1];
    g.positions[i * 3 + 2] = s * (R[2][0] * x + R[2][1] * y + R[2][2] * z) + t[2];
    for (let k = 0; k < 3; k++) g.scales[i * 3 + k]! += ls;
    // q' = qR · q
    const bx = g.rotations[i * 4]!, by = g.rotations[i * 4 + 1]!, bz = g.rotations[i * 4 + 2]!, bw = g.rotations[i * 4 + 3]!;
    g.rotations[i * 4] = qw * bx + qx * bw + qy * bz - qz * by;
    g.rotations[i * 4 + 1] = qw * by - qx * bz + qy * bw + qz * bx;
    g.rotations[i * 4 + 2] = qw * bz + qx * by - qy * bx + qz * bw;
    g.rotations[i * 4 + 3] = qw * bw - qx * bx - qy * by - qz * bz;
  }
  return g;
}

export const translateGaussians = (g: Gaussians, t: [number, number, number]): Gaussians => transformGaussians(g, IDENTITY, 1, t);

/**
 * Keep the `max` most opaque Gaussians; the faintest go first. NOT by size: a SAM 3D object's
 * surfaces are its many small opaque Gaussians, and keeping the largest (tried: 570k → 150k) left a
 * see-through smear where a solid counter should be.
 */
export function thinGaussians(g: Gaussians, max: number): Gaussians {
  if (g.count <= max) return g;
  const idx = Array.from({ length: g.count }, (_, i) => i).sort((a, b) => g.alphas[b]! - g.alphas[a]!).slice(0, max);
  return pick(g, idx);
}

export function pick(g: Gaussians, idx: number[]): Gaussians {
  const o = alloc(idx.length);
  idx.forEach((j, i) => {
    o.positions.set(g.positions.subarray(j * 3, j * 3 + 3), i * 3);
    o.scales.set(g.scales.subarray(j * 3, j * 3 + 3), i * 3);
    o.rotations.set(g.rotations.subarray(j * 4, j * 4 + 4), i * 4);
    o.colors.set(g.colors.subarray(j * 3, j * 3 + 3), i * 3);
    o.alphas[i] = g.alphas[j]!;
  });
  return o;
}

export function concatGaussians(parts: Gaussians[]): Gaussians {
  const o = alloc(parts.reduce((n, p) => n + p.count, 0));
  let at = 0;
  for (const p of parts) {
    o.positions.set(p.positions, at * 3); o.scales.set(p.scales, at * 3); o.rotations.set(p.rotations, at * 4);
    o.colors.set(p.colors, at * 3); o.alphas.set(p.alphas, at);
    at += p.count;
  }
  return o;
}

/** The value at share `q` (0-1) of an ascending-sorted, non-empty array. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))]!;
}

/** Per-axis percentile bounds of the opaque Gaussians (outliers trimmed). */
export function bounds(g: Gaussians, q = 0.02, minAlpha = 0.3): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [0, 0, 0];
  const step = Math.max(1, Math.floor(g.count / 100000));
  for (let a = 0; a < 3; a++) {
    const v: number[] = [];
    for (let i = 0; i < g.count; i += step) if (g.alphas[i]! >= minAlpha) v.push(g.positions[i * 3 + a]!);
    if (!v.length) continue;
    v.sort((x, y) => x - y);
    min[a] = quantile(v, q);
    max[a] = quantile(v, 1 - q);
  }
  return { min, max };
}

/** About `max` positions of the opaque Gaussians (every k-th Gaussian), minus `origin`, as flat xyz. */
export function opaqueSample(g: Gaussians, max: number, origin: [number, number, number] = [0, 0, 0]): Float32Array {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(g.count / max));
  for (let i = 0; i < g.count; i += step) if (g.alphas[i]! >= 0.3) out.push(g.positions[i * 3]! - origin[0], g.positions[i * 3 + 1]! - origin[1], g.positions[i * 3 + 2]! - origin[2]);
  return new Float32Array(out);
}

/**
 * A splat file scaled uniformly about its origin (positions and sizes), e.g. a scene JST-2 built at
 * 1 unit = 1 into metres. Lossless for what JST-2 writes (SH degree 0); the file is rewritten as v3.
 */
export function scaleSpz(bytes: Uint8Array, k: number): Uint8Array {
  if (k === 1) return bytes;
  const g = readSpzGaussians(bytes);
  transformGaussians(g, IDENTITY, k, [0, 0, 0]);
  return writeSpzGaussians(g);
}
