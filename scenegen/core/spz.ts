/**
 * Read the centres, colours and opacities of an `.spz` Gaussian splat, in Node.
 * Enough to measure a scene (where its floor is, how big it is, whether it lines
 * up with a blockout) without a renderer. Versions 2-3 are one gzip stream;
 * version 4 is a 32-byte header, a table of contents, and one zstd (or gzip)
 * stream per attribute.
 */
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

export interface SpzPoints {
  version: number;
  count: number;
  /** x, y, z per point, in the file's own frame and units. */
  positions: Float32Array;
  /** r, g, b per point, 0-255 (DC colour only). */
  colors: Uint8Array;
  /** 0-1 per point. */
  alphas: Float32Array;
}

const MAGIC = 0x5053474e; // "NGSP"
const SH_DIM = [0, 3, 8, 15, 24];
const COLOR_SCALE = 0.15;

function inflate(buf: Uint8Array): Uint8Array {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) return zstdDecompressSync(buf);
  return buf;
}

function strides(version: number, shDegree: number) {
  return { positions: version >= 2 ? 9 : 6, alphas: 1, colors: 3, scales: 3, rotations: version >= 3 ? 4 : 3, sh: SH_DIM[shDegree]! * 3 };
}

export function readSpz(input: Uint8Array): SpzPoints {
  let file = input;
  if (file[0] === 0x1f && file[1] === 0x8b) file = gunzipSync(file);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Not an SPZ file (no NGSP header).');
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const shDegree = file[12]!;
  const fractionalBits = file[13]!;
  if (shDegree > 4 || !(count > 0) || count > 2e7) throw new Error(`Implausible SPZ header (v${version}, ${count} points, SH ${shDegree}).`);
  const want = strides(version, shDegree);
  const streams: Record<string, Uint8Array> = {};
  if (version >= 4) {
    const toc = view.getUint32(16, true);
    const names = (['positions', 'alphas', 'colors', 'scales', 'rotations', 'sh'] as const).filter((n) => want[n] > 0);
    let at = toc + names.length * 16;
    for (const [i, name] of names.entries()) {
      const compressed = Number(view.getBigUint64(toc + i * 16, true));
      const raw = inflate(file.subarray(at, at + compressed));
      at += compressed;
      if (raw.byteLength !== want[name] * count) throw new Error(`SPZ ${name} stream is ${raw.byteLength} bytes, expected ${want[name] * count}.`);
      streams[name] = raw;
    }
  } else {
    let at = 16;
    for (const name of ['positions', 'alphas', 'colors', 'scales', 'rotations', 'sh'] as const) {
      const n = want[name] * count;
      streams[name] = file.subarray(at, at + n);
      at += n;
    }
  }
  const pos = streams.positions!;
  const positions = new Float32Array(count * 3);
  if (version >= 2) {
    const s = 1 / (1 << fractionalBits);
    for (let i = 0; i < count * 3; i++) {
      let v = pos[i * 3]! | (pos[i * 3 + 1]! << 8) | (pos[i * 3 + 2]! << 16);
      if (v & 0x800000) v |= 0xff000000;
      positions[i] = v * s;
    }
  } else {
    const dv = new DataView(pos.buffer, pos.byteOffset, pos.byteLength);
    for (let i = 0; i < count * 3; i++) positions[i] = half(dv.getUint16(i * 2, true));
  }
  const colors = new Uint8Array(count * 3);
  const c = streams.colors!;
  for (let i = 0; i < count * 3; i++) {
    // Stored as SH DC: colour = 0.5 + 0.282 * dc, dc = (byte/255 - 0.5) / COLOR_SCALE.
    const dc = (c[i]! / 255 - 0.5) / COLOR_SCALE;
    colors[i] = Math.max(0, Math.min(255, Math.round((0.5 + 0.28209479 * dc) * 255)));
  }
  const alphas = new Float32Array(count);
  const a = streams.alphas!;
  for (let i = 0; i < count; i++) alphas[i] = a[i]! / 255;
  return { version, count, positions, colors, alphas };
}

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 31;
  const m = bits & 1023;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * (m + 1024) * 2 ** (e - 25);
}

/**
 * Which way is up in this file. PINOC's rule: an SPZ of version 4 or more from
 * the provider stores +Y up; older files (and .ply) are Y down.
 */
export function spzUp(version: number): 1 | -1 {
  return version >= 4 ? 1 : -1;
}

/**
 * Distance from a point straight down to the nearest dense, opaque surface: march a thin
 * column of the cloud along `down` and return the first bin that holds enough points.
 * Used to read a scene's scale off its file (a capture point is ~1.5 m above the floor).
 */
export function distanceToFloor(p: SpzPoints, origin: [number, number, number], down: [number, number, number], opts: { radius?: number; maxDistance?: number } = {}): number | null {
  const radius = opts.radius ?? 0.25;
  const max = opts.maxDistance ?? 50;
  const bins = new Uint32Array(500);
  const binSize = max / bins.length;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = down;
  for (let i = 0; i < p.count; i++) {
    if (p.alphas[i]! < 0.3) continue;
    const x = p.positions[i * 3]! - ox, y = p.positions[i * 3 + 1]! - oy, z = p.positions[i * 3 + 2]! - oz;
    const t = x * dx + y * dy + z * dz;
    if (t <= 0 || t >= max) continue;
    const rx = x - t * dx, ry = y - t * dy, rz = z - t * dz;
    if (rx * rx + ry * ry + rz * rz > radius * radius * Math.max(1, t)) continue;
    bins[Math.floor(t / binSize)]!++;
  }
  let peak = 0;
  for (const b of bins) peak = Math.max(peak, b);
  if (peak < 20) return null;
  // The floor is the LAST dense layer below the point: a table or a rug sits above it.
  for (let i = bins.length - 1; i >= 0; i--) if (bins[i]! >= peak * 0.25) return (i + 0.5) * binSize;
  return null;
}

/** Axis-aligned bounds of the opaque points, trimmed to the 1st-99th percentile per axis. */
export function robustBounds(p: SpzPoints, q = 0.01): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const v: number[] = [];
    for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 200000))) if (p.alphas[i]! >= 0.3) v.push(p.positions[i * 3 + axis]!);
    v.sort((a, b) => a - b);
    min[axis] = v[Math.floor(v.length * q)] ?? 0;
    max[axis] = v[Math.floor(v.length * (1 - q))] ?? 0;
  }
  return { min, max };
}
