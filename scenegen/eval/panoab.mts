/**
 * Panorama A/B: which way of asking GPT-image-2 keeps the blockout's layout best.
 * Reuses the blockouts (conditions, caption, reference picture) of finished
 * projects, paints `n` panoramas per variant, and scores each with
 * scenegen/py/videoscene/panoalign.py (blockout edges vs panorama edges, above chance).
 * Spends OpenAI image calls only - no JST-2 credits.
 *
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... npx tsx scenegen/eval/panoab.mts <out> <projectId:label> ... [--n 3]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { compileCaption } from '../core/caption.ts';
import type { Layout } from '../core/types.ts';
import { openaiImageProvider } from '../server/pano.ts';
import { geometryNote } from '../server/textScene.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const VARIANTS = {
  base: { label: '现状：深度图 + 参考照片', photo: true, clay: false },
  A: { label: 'A：只给深度图（不带参考照片）', photo: false, clay: false },
  AB: { label: 'A+B：深度图 + 白模渲染图', photo: false, clay: true },
} as const;
type Variant = keyof typeof VARIANTS;

const args = process.argv.slice(2);
const out = resolve(args[0]!);
const nIdx = args.indexOf('--n');
const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 3;
const cases = args.slice(1).filter((a, i, all) => a !== '--n' && all[i - 1] !== '--n').map((a) => { const [pid, label] = a.split(':'); return { pid: pid!, label: label ?? pid! }; });

const provider = openaiImageProvider({ apiKey: env.OPENAI_API_KEY });

interface Job { label: string; variant: Variant; i: number; file: string; run: () => Promise<void> }
const jobs: Job[] = [];
for (const c of cases) {
  const proj = join(ROOT, '.data/scenegen/projects', c.pid);
  const dir = join(proj, 'out');
  const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as Layout & { capture: NonNullable<Layout['capture']> };
  const meta = JSON.parse(readFileSync(join(proj, 'project.json'), 'utf8')) as { reference?: { file: string; mime: string } | null };
  const photo = meta.reference ? { bytes: new Uint8Array(readFileSync(join(proj, meta.reference.file))), mime: meta.reference.mime } : undefined;
  const cdir = join(out, c.label);
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'semantic.png'), readFileSync(join(dir, 'semantic.png')));
  const depth = new Uint8Array(readFileSync(join(dir, 'depth.png')));
  const shaded = new Uint8Array(readFileSync(join(dir, 'shaded.png')));
  const prompt = compileCaption(layout, layout.capture);
  const geometry = geometryNote(layout, layout.capture);
  for (const v of Object.keys(VARIANTS) as Variant[]) {
    const spec = VARIANTS[v];
    // Without a picture, "base" and "A" are the same request: paint it once.
    if (v === 'base' && !photo) continue;
    for (let i = 0; i < n; i++) {
      const file = join(cdir, `${v}-${i}.png`);
      jobs.push({ label: c.label, variant: v, i, file, run: async () => {
        if (existsSync(file)) return;
        const r = await provider.generate({ prompt, depth, semantic: depth, shaded, geometry, withClay: spec.clay, styleImage: spec.photo ? photo : undefined });
        writeFileSync(file, r.bytes);
      } });
    }
  }
}

console.log(`${jobs.length} panoramas to paint`);
let done = 0;
const queue = [...jobs];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let j = queue.shift(); j; j = queue.shift()) {
    const t = Date.now();
    try { await j.run(); console.log(`[${++done}/${jobs.length}] ${j.label} ${j.variant}-${j.i} ${((Date.now() - t) / 1000).toFixed(0)}s`); } catch (e) { console.log(`FAILED ${j.label} ${j.variant}-${j.i}: ${(e as Error).message}`); }
  }
}));

// Score.
const py = join(ROOT, 'scenegen/py/.venv/bin/python');
const results: Record<string, Record<string, Array<{ i: number; objects: number; shell: number }>>> = {};
for (const c of cases) {
  const cdir = join(out, c.label);
  const files = jobs.filter((j) => j.label === c.label && existsSync(j.file));
  const r = spawnSync(py, ['-m', 'videoscene.panoalign', join(cdir, 'semantic.png'), ...files.map((f) => f.file)], { cwd: join(ROOT, 'scenegen/py'), encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  const scores = JSON.parse(r.stdout) as Record<string, { objects: { lift: number }; shell: { lift: number } }>;
  results[c.label] = {};
  for (const f of files) (results[c.label]![f.variant] ??= []).push({ i: f.i, objects: scores[f.file]!.objects.lift, shell: scores[f.file]!.shell.lift });
}
writeFileSync(join(out, 'scores.json'), JSON.stringify({ variants: VARIANTS, results }, null, 2));
for (const [label, vs] of Object.entries(results)) {
  console.log(`\n${label}`);
  for (const [v, s] of Object.entries(vs)) {
    const mean = (k: 'objects' | 'shell') => s.reduce((a, x) => a + x[k], 0) / s.length;
    const best = s.reduce((a, x) => (x.objects > a.objects ? x : a));
    console.log(`  ${v.padEnd(5)} objects mean ${mean('objects').toFixed(2)} (best ${best.objects.toFixed(2)} = #${best.i})  shell mean ${mean('shell').toFixed(2)}  all ${s.map((x) => x.objects.toFixed(2)).join(' ')}`);
  }
}
