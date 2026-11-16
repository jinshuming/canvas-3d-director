/**
 * Place a finished generated scene's objects again with the current placement (seatScene.placeScene),
 * from their SAM 3D sources, and rewrite scene.spz, the objects and the result. No credits.
 *
 *   npx tsx scenegen/eval/replace.mts <projectId> [<projectId> ...]
 *
 * The dev server keeps projects in memory: restart it afterwards to see the new placement.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Layout } from '../core/types.ts';
import type { ObjectAsset } from '../server/objects.ts';
import { composeScene, shiftOf } from '../server/textScene.ts';

const root = join(import.meta.dirname, '../../.data/scenegen/projects');
for (const id of process.argv.slice(2)) {
  const dir = join(root, id, 'out');
  const projFile = join(root, id, 'project.json');
  const proj = JSON.parse(await readFile(projFile, 'utf8')) as { title: string; result: Record<string, unknown> };
  const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { objects: ObjectAsset[]; envScale: number | null; files: { environment: string } };
  const layout = JSON.parse(await readFile(join(dir, 'layout.json'), 'utf8')) as Layout;
  const env = new Uint8Array(await readFile(join(dir, result.files.environment)));
  const t0 = Date.now();
  await composeScene(dir, layout, layout.capture!, env, result.objects, shiftOf(result.envScale));
  console.log(`${proj.title} (${id}): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const o of result.objects) {
    const p = o.place, s = o.seat;
    if (!p) { console.log(`  ${o.id}: not placed${o.error ? ` (${o.error})` : ''}`); continue; }
    console.log(`  ${o.id.padEnd(14)} up ${p.up.padEnd(4)} levelled ${p.tiltDeg.toFixed(1).padStart(4)}°  turned ${p.yawDeg.toFixed(1).padStart(6)}°  shape ×${p.spread.toFixed(2)}  silhouette ${p.iou === null ? '  - ' : p.iou.toFixed(2)}  cleaned ${(p.removed * 100).toFixed(0).padStart(2)}%  pushed ${p.pushed.toFixed(2)} m  seat ${s?.support} ${s?.dy.toFixed(2)} m${p.suspect ? '  ← suspect' : ''}`);
  }
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  proj.result = { ...proj.result, objects: result.objects };
  await writeFile(projFile, JSON.stringify(proj, null, 2));
}
