/**
 * A top-down check of a scene's object placement: each object's splats (seen from above, coloured
 * by height) over its blockout box (white outline, a tick on its front), in the scene file's frame.
 *
 *   npx tsx scenegen/eval/topdown.mts <outDir> <png> [objectsDir]
 *
 * `objectsDir` defaults to <outDir>/objects - point it at a copy to draw an earlier placement.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readSpzGaussians } from '../core/gaussians.ts';
import type { Layout } from '../core/types.ts';
import { encodePng } from '../server/png.ts';
import { shiftOf } from '../server/textScene.ts';

const [outDir, png, objDir = join(outDir!, 'objects')] = process.argv.slice(2);
const result = JSON.parse(await readFile(join(outDir!, 'result.json'), 'utf8')) as { objects: Array<{ id: string; file: string | null }>; envScale: number | null };
const layout = JSON.parse(await readFile(join(outDir!, 'layout.json'), 'utf8')) as Layout;
const cap = layout.capture!.position;
const k = shiftOf(result.envScale) ?? 1;
const W = 900, px = 110; // pixels per metre
const img = new Uint8Array(W * W * 3).fill(24);
const at = (x: number, z: number) => [Math.round(W / 2 + x * px), Math.round(W / 2 + z * px)] as const;
const dot = (u: number, v: number, c: [number, number, number]) => { if (u >= 0 && v >= 0 && u < W && v < W) img.set(c, (v * W + u) * 3); };
const line = (a: readonly [number, number], b: readonly [number, number], c: [number, number, number]) => {
  const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
  for (let i = 0; i <= n; i++) dot(Math.round(a[0] + ((b[0] - a[0]) * i) / n), Math.round(a[1] + ((b[1] - a[1]) * i) / n), c);
};
if (layout.room) {
  const { width: w, depth: d } = layout.room;
  const c = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => at((x! - cap[0]) * k, (z! - cap[2]) * k));
  for (let i = 0; i < 4; i++) line(c[i]!, c[(i + 1) % 4]!, [90, 90, 90]);
}
for (const o of result.objects) {
  const obj = layout.objects.find((x) => x.id === o.id);
  if (!o.file || !obj) continue;
  const g = readSpzGaussians(new Uint8Array(await readFile(join(objDir, o.file.replace(/^objects\//, '')))));
  for (let i = 0; i < g.count; i += 4) {
    if (g.alphas[i]! < 0.3) continue;
    const y = g.positions[i * 3 + 1]! + cap[1];
    const t = Math.max(0, Math.min(1, y / Math.max(0.3, obj.size[1] + obj.position[1])));
    const [u, v] = at(g.positions[i * 3]!, g.positions[i * 3 + 2]!);
    dot(u, v, [Math.round(60 + 195 * t), Math.round(120 + 60 * (1 - t)), Math.round(255 * (1 - t))]);
  }
  const [w, , d] = obj.size;
  const c = Math.cos((obj.yaw * Math.PI) / 180), s = Math.sin((obj.yaw * Math.PI) / 180);
  const cx = (obj.position[0] - cap[0]) * k, cz = (obj.position[2] - cap[2]) * k;
  const P = (lx: number, lz: number) => at(cx + c * lx + s * lz, cz - s * lx + c * lz);
  const q = [P(-w / 2, -d / 2), P(w / 2, -d / 2), P(w / 2, d / 2), P(-w / 2, d / 2)];
  for (let i = 0; i < 4; i++) line(q[i]!, q[(i + 1) % 4]!, [255, 255, 255]);
  line(P(0, d / 2), P(0, d / 2 + 0.25), [255, 80, 80]);
}
const [u0, v0] = at(0, 0);
for (let i = -6; i <= 6; i++) { dot(u0 + i, v0, [255, 220, 0]); dot(u0, v0 + i, [255, 220, 0]); }
await writeFile(png!, encodePng(img, W, W));
console.log(png);
