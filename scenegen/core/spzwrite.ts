/**
 * Write a version-2 SPZ (one gzip stream) from coloured points: round, small,
 * opaque splats. Used by the posed-images mock to hand back a preview scene
 * built from the video's sparse point cloud until JST-2 has the endpoint.
 */
import { gzipSync } from 'node:zlib';

export function writeSpz(positions: Float32Array, colors: Uint8Array, opts: { radius?: number | Float32Array; fractionalBits?: number } = {}): Uint8Array {
  const n = positions.length / 3;
  const fb = opts.fractionalBits ?? 12;
  const head = new Uint8Array(16);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, 0x5053474e, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, n, true);
  head[12] = 0; head[13] = fb; head[14] = 0; head[15] = 0;
  const pos = new Uint8Array(n * 9);
  const lim = (1 << 23) - 1;
  for (let i = 0; i < n * 3; i++) {
    let v = Math.round(positions[i]! * (1 << fb));
    v = Math.max(-lim, Math.min(lim, v));
    pos[i * 3] = v & 0xff; pos[i * 3 + 1] = (v >> 8) & 0xff; pos[i * 3 + 2] = (v >> 16) & 0xff;
  }
  const alphas = new Uint8Array(n).fill(235);
  const col = new Uint8Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    // colour = 0.5 + 0.282 * dc; byte = dc * 0.15 + 0.5 (scaled to 0-255)
    const dc = (colors[i]! / 255 - 0.5) / 0.28209479;
    col[i] = Math.max(0, Math.min(255, Math.round((dc * 0.15 + 0.5) * 255)));
  }
  const scales = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = typeof opts.radius === 'object' ? opts.radius[i]! : (opts.radius ?? 0.02);
    const b = Math.max(0, Math.min(255, Math.round((Math.log(r) + 10) * 16)));
    scales[i * 3] = scales[i * 3 + 1] = scales[i * 3 + 2] = b;
  }
  // v2 rotations: xyz of a unit quaternion as signed bytes; identity = (0, 0, 0) with w derived.
  const rot = new Uint8Array(n * 3).fill(128);
  const body = new Uint8Array(16 + pos.length + alphas.length + col.length + scales.length + rot.length);
  let at = 0;
  for (const p of [head, pos, alphas, col, scales, rot]) { body.set(p, at); at += p.length; }
  return gzipSync(body);
}

/** Read a binary little-endian PLY with float x y z and uchar red green blue (what the video pipeline writes). */
export function readPointsPly(buf: Uint8Array): { positions: Float32Array; colors: Uint8Array } {
  const text = new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 2048)));
  const end = text.indexOf('end_header\n');
  if (!text.startsWith('ply') || end < 0) throw new Error('Not a PLY file.');
  const n = Number(/element vertex (\d+)/.exec(text)?.[1] ?? 0);
  const props = [...text.slice(0, end).matchAll(/property (\w+) (\w+)/g)].map((m) => ({ type: m[1]!, name: m[2]! }));
  const size = (t: string) => (t === 'float' || t === 'float32' || t === 'int' ? 4 : t === 'double' ? 8 : t === 'uchar' || t === 'uint8' ? 1 : 2);
  const stride = props.reduce((s, p) => s + size(p.type), 0);
  const base = new TextEncoder().encode(text.slice(0, end + 'end_header\n'.length)).length;
  const dv = new DataView(buf.buffer, buf.byteOffset + base, n * stride);
  const positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3);
  const off: Record<string, number> = {};
  let o = 0;
  for (const p of props) { off[p.name] = o; o += size(p.type); }
  for (let i = 0; i < n; i++) {
    const b = i * stride;
    positions[i * 3] = dv.getFloat32(b + off.x!, true);
    positions[i * 3 + 1] = dv.getFloat32(b + off.y!, true);
    positions[i * 3 + 2] = dv.getFloat32(b + off.z!, true);
    colors[i * 3] = dv.getUint8(b + off.red!);
    colors[i * 3 + 1] = dv.getUint8(b + off.green!);
    colors[i * 3 + 2] = dv.getUint8(b + off.blue!);
  }
  return { positions, colors };
}
