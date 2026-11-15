/**
 * Equirectangular renders of the blockout from a camera pose, on the CPU:
 * per pixel the ray distance, the hit object and class, and the normal. From
 * that: the depth map (inverted log, like Atlas), the semantic map and its
 * legend, a shaded preview, and a per-object pixel count for the capture
 * search. Runs in Node (server) and in the page.
 */
import { basis, equirectDir } from './frame.ts';
import type { CameraPose, Vec3 } from './frame.ts';
import { cast, classColor } from './geometry.ts';
import type { Scene } from './geometry.ts';

export interface EquirectBuffers {
  width: number;
  height: number;
  /** Ray distance in metres; Infinity = sky. */
  dist: Float32Array;
  /** Object index, -1 room shell / ground, -2 sky. */
  obj: Int16Array;
  /** Class name index into `classes`. */
  cls: Uint16Array;
  classes: string[];
  normal: Float32Array;
}

export function renderEquirect(scene: Scene, pose: CameraPose, width: number, height: number): EquirectBuffers {
  const b = basis(pose);
  const n = width * height;
  const dist = new Float32Array(n), obj = new Int16Array(n), cls = new Uint16Array(n), normal = new Float32Array(n * 3);
  const classes: string[] = [];
  const idx = new Map<string, number>();
  const o = pose.position;
  for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) {
    const d = equirectDir(u, v, width, height, b);
    const h = cast(scene, o, d);
    const i = v * width + u;
    dist[i] = h.t;
    obj[i] = h.obj;
    let c = idx.get(h.cls);
    if (c === undefined) { c = classes.length; classes.push(h.cls); idx.set(h.cls, c); }
    cls[i] = c;
    normal[i * 3] = h.n[0]; normal[i * 3 + 1] = h.n[1]; normal[i * 3 + 2] = h.n[2];
  }
  return { width, height, dist, obj, cls, classes, normal };
}

/** A depth range that fits the render: the nearest and the 99th-percentile farthest surface. */
export function depthRange(r: EquirectBuffers): { zMin: number; zMax: number } {
  const v: number[] = [];
  for (let i = 0; i < r.dist.length; i += 7) if (Number.isFinite(r.dist[i]!)) v.push(r.dist[i]!);
  v.sort((a, b) => a - b);
  const zMin = Math.max(0.1, (v[0] ?? 0.3) * 0.9);
  const zMax = Math.max(zMin * 2, (v[Math.floor(v.length * 0.99)] ?? 60) * 1.1);
  return { zMin: Math.round(zMin * 100) / 100, zMax: Math.round(zMax * 100) / 100 };
}

/** Inverted log depth, 8-bit grey: brighter = nearer, 0 = no surface (sky). Same encoding Atlas uses. */
export function depthImage(r: EquirectBuffers, zMin = 0.3, zMax = 60): Uint8Array {
  const out = new Uint8Array(r.width * r.height * 3);
  const lmin = Math.log(zMin), span = Math.log(zMax) - lmin;
  for (let i = 0; i < r.dist.length; i++) {
    const t = r.dist[i]!;
    const v = Number.isFinite(t) ? Math.round(255 * Math.max(1 / 255, Math.min(1, 1 - (Math.log(Math.max(t, zMin)) - lmin) / span))) : 0;
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v;
  }
  return out;
}

export function semanticImage(r: EquirectBuffers): { rgb: Uint8Array; legend: Array<{ cls: string; color: [number, number, number]; share: number }> } {
  const out = new Uint8Array(r.width * r.height * 3);
  const counts = new Map<number, number>();
  for (let i = 0; i < r.cls.length; i++) {
    const c = r.cls[i]!;
    counts.set(c, (counts.get(c) ?? 0) + 1);
    const col = classColor(r.classes[c]!);
    out[i * 3] = col[0]; out[i * 3 + 1] = col[1]; out[i * 3 + 2] = col[2];
  }
  const total = r.cls.length;
  const legend = [...counts.entries()].map(([c, n]) => ({ cls: r.classes[c]!, color: classColor(r.classes[c]!), share: n / total })).sort((a, b) => b.share - a.share);
  return { rgb: out, legend };
}

/** A clay render: semantic colour lit by a sun and an ambient term, edges darkened. For people and for image models. */
export function shadedImage(r: EquirectBuffers, sun: Vec3 = [0.4, 0.8, 0.45]): Uint8Array {
  const out = new Uint8Array(r.width * r.height * 3);
  const l = Math.hypot(...sun);
  const s: Vec3 = [sun[0] / l, sun[1] / l, sun[2] / l];
  const { width: w, height: h } = r;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const i = v * w + u;
    const name = r.classes[r.cls[i]!]!;
    if (name === 'sky') { const k = 1 - v / h; out[i * 3] = 150 + 60 * k; out[i * 3 + 1] = 180 + 50 * k; out[i * 3 + 2] = 230; continue; }
    const base = classColor(name);
    const nd = Math.max(0, r.normal[i * 3]! * s[0] + r.normal[i * 3 + 1]! * s[1] + r.normal[i * 3 + 2]! * s[2]);
    let k = 0.45 + 0.55 * nd;
    // Edge: a neighbour belongs to another object or is much farther.
    const right = v * w + ((u + 1) % w), down = Math.min(h - 1, v + 1) * w + u;
    for (const j of [right, down]) {
      if (r.obj[j] !== r.obj[i] || Math.abs((r.dist[j]! - r.dist[i]!) / Math.max(r.dist[i]!, 0.1)) > 0.08) { k *= 0.55; break; }
    }
    // Soft mix towards a neutral clay so the colours read as materials, not labels.
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round((base[c]! * 0.55 + 200 * 0.45) * k)));
  }
  return out;
}

/** Pixel-area weights of an equirect row: cos(latitude). */
export function rowWeights(height: number): Float32Array {
  const w = new Float32Array(height);
  for (let v = 0; v < height; v++) w[v] = Math.cos(Math.PI / 2 - ((v + 0.5) / height) * Math.PI);
  return w;
}

/** Solid angle (steradians) and mean distance each object covers in a render. */
export function objectCoverage(r: EquirectBuffers, count: number): Array<{ sr: number; meanDist: number }> {
  const out = Array.from({ length: count }, () => ({ sr: 0, meanDist: 0 }));
  const rw = rowWeights(r.height);
  const px = (2 * Math.PI / r.width) * (Math.PI / r.height);
  for (let v = 0; v < r.height; v++) for (let u = 0; u < r.width; u++) {
    const i = v * r.width + u;
    const o = r.obj[i]!;
    if (o < 0) continue;
    const a = rw[v]! * px;
    out[o]!.sr += a;
    out[o]!.meanDist += a * r.dist[i]!;
  }
  for (const c of out) if (c.sr > 0) c.meanDist /= c.sr;
  return out;
}
