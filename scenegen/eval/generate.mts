/**
 * Headless text / picture → 3DGS scene, against a running dev server (`npm run dev`).
 * The same calls the canvas's 场景生成 node makes (web/runner.ts `generateScene`), without a browser:
 *
 *   npx tsx scenegen/eval/generate.mts --text "a Nordic living room ..." --out out/room
 *   npx tsx scenegen/eval/generate.mts --image ref.jpg --text "build this place" --out out/room
 *   npx tsx scenegen/eval/generate.mts --text "..." --stop-after layout --out out/room   # blockout only, one cheap model call
 *   npx tsx scenegen/eval/generate.mts --text "..." --no-objects --max-fills 0 ...       # fewer paid calls
 *
 * Flags: --text, --image <file>, --out <dir> (required), --stop-after layout, --no-objects,
 * --max-fills <0-4|auto>, --provider <openai-image|jst2-reference|fal-flux-depth>.
 * SCENEGEN_BASE overrides the server (default http://localhost:5193).
 *
 * Without --stop-after this SPENDS CREDITS (GPT-image-2 panoramas, JST-2, SAM 3D). Writes
 * <out>/: layout.json, blockout-*.png (the conditions), panorama.*, environment.spz, scene.spz,
 * objects/*.spz, result.json, job-log.txt. See scenegen/PIPELINE.md for what each file is.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { api, file as fileUrl } from '../web/api.ts';

const BASE = process.env.SCENEGEN_BASE ?? 'http://localhost:5193';
// web/api.ts uses page-relative URLs: resolve them against the dev server.
const nodeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => nodeFetch(typeof input === 'string' && input.startsWith('/') ? `${BASE}${input}` : input, init)) as typeof fetch;

const { values: a } = parseArgs({
  options: {
    text: { type: 'string', default: '' }, image: { type: 'string' }, out: { type: 'string' },
    'stop-after': { type: 'string' }, 'no-objects': { type: 'boolean', default: false },
    'max-fills': { type: 'string' }, provider: { type: 'string' },
  },
});
if (!a.out || (!a.text && !a.image)) {
  console.error('Usage: generate.mts --out <dir> (--text "<description>" and/or --image <file>) [--stop-after layout] [--no-objects] [--max-fills N] [--provider id]');
  process.exit(2);
}
const out = a.out;
const save = (rel: string, bytes: Uint8Array | string) => { const f = join(out, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes); };
const download = async (id: string, rel: string, as = rel) => {
  const res = await fetch(fileUrl(id, rel));
  if (!res.ok) return false;
  save(as, new Uint8Array(await res.arrayBuffer()));
  return true;
};

const cfg = await api.config();
console.log(`server ${BASE}: panorama providers ${cfg.providers.map((p) => `${p.id}${p.available ? '' : ' (no key)'}`).join(', ')}; agent model ${cfg.agent?.model ?? 'none (no OPENAI_API_KEY)'}`);

// 1. A project, the picture as its reference, then the blockout from text + picture (one model call).
const proj = await api.create('text', { title: a.text!.slice(0, 40) || 'Scene from a picture' });
if (a.image) {
  const bytes = readFileSync(a.image);
  const type = /\.png$/i.test(a.image) ? 'image/png' : /\.webp$/i.test(a.image) ? 'image/webp' : 'image/jpeg';
  await api.reference(proj.id, new Blob([bytes], { type }), type);
}
const q = await api.quickLayout(proj.id, { text: a.text!, useReference: Boolean(a.image) });
if (!q.layout.objects.length) throw new Error('The model placed no objects: describe the place differently.');
console.log(`blockout: ${q.layout.objects.length} objects (${q.keys.length} key), ${(q.seconds.model + q.seconds.place).toFixed(0)} s -> project ${proj.id}`);
save('layout.json', JSON.stringify(q.layout, null, 2));
const cond = await api.conditions(proj.id);
for (const [k, u] of Object.entries(cond.files)) await download(proj.id, u.replace(`/scenegen/files/${proj.id}/`, '').replace(/\?.*$/, ''), `blockout-${k}.png`);
if (a['stop-after'] === 'layout') { console.log(`stopped after the blockout; files in ${out}`); process.exit(0); }

// 2. Panorama -> JST-2 environment -> SAM 3D objects -> composed scene.
const maxFills = a['max-fills'] === undefined ? undefined : a['max-fills'] === 'auto' ? 'auto' as const : Number(a['max-fills']);
await api.generate(proj.id, { ...(a.provider ? { provider: a.provider } : {}), ...(maxFills === undefined ? {} : { maxFills }), ...(a['no-objects'] ? { objects: false } : {}), useReference: Boolean(a.image) });
let shown = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const p = await api.get(proj.id);
  const job = p.job;
  for (const line of (job?.log ?? []).slice(shown)) console.log(line);
  shown = job?.log.length ?? shown;
  if (job?.status === 'done') { save('job-log.txt', job.log.join('\n')); break; }
  if (job?.status === 'failed') { save('job-log.txt', job.log.join('\n')); console.error(`FAILED: ${job.error}`); process.exit(1); }
}

// 3. Collect what was made.
const done = await api.get(proj.id);
const r = done.result as { files: Record<string, string | null>; objects?: Array<{ file: string | null; crop: string }>; credits: number; metersPerUnit: number } | null;
if (!r) throw new Error('The job finished without a result.');
for (const rel of Object.values(r.files)) if (rel) await download(proj.id, `out/${rel}`, rel);
for (const o of r.objects ?? []) for (const rel of [o.file, o.crop]) if (rel) await download(proj.id, `out/${rel}`, rel);
save('result.json', JSON.stringify(done.result, null, 2));
console.log(`done: scene.spz in ${out} (1 JST-2 unit = ${r.metersPerUnit} m, ${r.credits} Viggle credits). View it in the page: ${BASE}/scenegen/ (project ${proj.id}).`);
