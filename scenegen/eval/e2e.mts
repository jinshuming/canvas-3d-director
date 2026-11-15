/**
 * End-to-end runs of the scene generator against a running dev server
 * (npm run dev). Each case goes through the real pipeline and spends real
 * credits: the layout agent (OpenAI), the panorama (GPT-image-2), JST-2.
 *
 *   npx tsx scenegen/eval/e2e.mts <out-dir> [case-id ...]
 *
 * Kinds:
 *   text          prompt → agent → blockout → panorama → JST-2 → gap fill
 *   image         picture → agent → ... (same)
 *   video-layout  video keyframes → agent → ... (same)
 *   video-poses   video → COLMAP poses → posed-images (mock until JST-2 has it) → scene
 *
 * Writes <out-dir>/<case-id>/ (images, result.json) and <out-dir>/results.json.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAgentTurn } from '../agent/loop.ts';
import type { ChatItem, TurnStats } from '../agent/loop.ts';
import type { AgentHost } from '../agent/tools.ts';
import type { CaptureResult } from '../core/capture.ts';
import { checkLayout } from '../core/layout.ts';
import type { Layout } from '../core/types.ts';

const BASE = process.env.SCENEGEN_BASE ?? 'http://localhost:5193';
const VIDEOS = '/Users/chenmo/Desktop/Dev/P.I.N.O.C./handoff/explore-videos';

interface Case { id: string; kind: 'text' | 'image' | 'video-layout' | 'video-poses'; title: string; prompt?: string; image?: string; imageAt?: number; video?: string }

export const CASES: Case[] = [
  { id: 'text-1', kind: 'text', title: '北欧客厅', prompt: '一间北欧风客厅：靠北墙一张浅灰色三人沙发，前面一张橡木矮茶几和一块米色地毯，东墙一扇大窗，西墙一个白色书架，窗边一盆琴叶榕，沙发对面是电视柜和电视。午后阳光。' },
  { id: 'text-2', kind: 'text', title: '欧洲小镇广场', prompt: '一个欧洲小镇的石板广场：中央一座石头喷泉，北边和东西两侧是三四层的彩色老房子，广场上几棵梧桐树、两张长椅朝向喷泉、一盏铸铁路灯。晴朗的上午。' },
  { id: 'text-3', kind: 'text', title: '工业风咖啡馆', prompt: '一家工业风小咖啡馆：一条靠墙的长吧台带三把高脚凳，吧台后面是放咖啡器具的柜子，店里三张小圆桌各配两把椅子，墙角有绿植，南墙是落地窗。暖黄色灯光，傍晚。' },
  { id: 'image-1', kind: 'image', title: '阁楼小屋（图片）', video: 'atticCabin-explore.mp4', imageAt: 2.0, prompt: '照着这张图搭场景。' },
  { id: 'image-2', kind: 'image', title: '雪村（图片）', video: 'snowVillage-explore.mp4', imageAt: 3.0, prompt: '照着这张图搭场景。' },
  { id: 'image-3', kind: 'image', title: '医疗舱（图片）', video: 'medBay-explore.mp4', imageAt: 4.0, prompt: '照着这张图搭场景。' },
  { id: 'vlayout-1', kind: 'video-layout', title: '客厅漫游（视频布局）', video: 'livingRoom-explore.mp4', prompt: '照着这段视频搭场景。' },
  { id: 'vlayout-2', kind: 'video-layout', title: '霍比特洞屋（视频布局）', video: 'hobbit-explore.mp4', prompt: '照着这段视频搭场景。' },
  { id: 'vlayout-3', kind: 'video-layout', title: '萤火虫花园（视频布局）', video: 'fireflyGarden-explore.mp4', prompt: '照着这段视频搭场景。' },
  { id: 'vposes-1', kind: 'video-poses', title: '竞技场（视频重建）', video: 'arena-explore.mp4' },
  { id: 'vposes-2', kind: 'video-poses', title: '风车村（视频重建）', video: 'windmillVillage-explore.mp4' },
  { id: 'vposes-3', kind: 'video-poses', title: '太空舱（视频重建）', video: 'spaceCabinPlay-explore.mp4' },
];

async function api<T>(method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array; type: string }): Promise<T> {
  const res = await fetch(`${BASE}/scenegen/api${path}`, {
    method,
    headers: raw ? { 'Content-Type': raw.type } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ? (raw.bytes as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => null) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(out?.error?.message ?? `${method} ${path}: ${res.status}`);
  return out;
}

/** An image (bytes) scaled to `w` wide as a JPEG data URL, for the model's eyes. */
function toDataUrl(bytes: Uint8Array, w = 1024): string {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${w}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'], { input: bytes, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.toString().slice(0, 200)}`);
  return `data:image/jpeg;base64,${r.stdout.toString('base64')}`;
}

function grabFrame(video: string, at: number, out: string): Uint8Array {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '2', out]);
  if (r.status !== 0) throw new Error(`ffmpeg frame: ${r.stderr.toString().slice(0, 200)}`);
  return new Uint8Array(readFileSync(out));
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url.startsWith('http') ? url : `${BASE}${url}`);
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

interface Job { status: string; stage: string; message: string; error?: string; log: string[]; startedAt: number; endedAt?: number }
async function waitJob(id: string, onTick?: (j: Job) => void): Promise<{ job: Job; result: Record<string, unknown> | null }> {
  for (;;) {
    const p = await api<{ job: Job | null; result: Record<string, unknown> | null }>('GET', `/projects/${id}`);
    if (p.job) onTick?.(p.job);
    if (p.job && p.job.status !== 'running') return { job: p.job, result: p.result };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function runLayoutCase(c: Case, dir: string, log: (m: string) => void) {
  const t0 = Date.now();
  const proj = await api<{ id: string; layout: Layout }>('POST', '/projects', { kind: 'text', title: c.title });
  const pics: string[] = [];
  const inputs: string[] = [];
  if (c.kind === 'image') {
    const bytes = grabFrame(join(VIDEOS, c.video!), c.imageAt ?? 2, join(dir, 'input.jpg'));
    await api('PUT', `/projects/${proj.id}/reference`, undefined, { bytes, type: 'image/jpeg' });
    pics.push(toDataUrl(bytes, 1280));
    inputs.push('input.jpg');
  }
  if (c.kind === 'video-layout') {
    const k = await api<{ frames: Array<{ file: string; url: string; time: number }> }>('PUT', `/projects/${proj.id}/layout-video`, undefined, { bytes: new Uint8Array(readFileSync(join(VIDEOS, c.video!))), type: 'video/mp4' });
    for (const f of k.frames) {
      const b = await fetchBytes(f.url);
      writeFileSync(join(dir, f.file), b);
      inputs.push(f.file);
      pics.push(toDataUrl(b, 768));
    }
  }
  const layout = proj.layout;
  let jobStarted: string | null = null;
  let generateCalls = 0;
  const host: AgentHost = {
    layout,
    changed: () => {},
    look: async () => {
      await api('PUT', `/projects/${proj.id}`, { layout });
      const cond = await api<{ files: { shaded: string }; prompt: string; capture: { position: number[]; yaw: number } }>('POST', `/projects/${proj.id}/conditions`);
      if (!layout.capture) layout.capture = cond.capture as Layout['capture'];
      return { image: toDataUrl(await fetchBytes(cond.files.shaded), 1024), prompt: cond.prompt };
    },
    findCapture: async () => { await api('PUT', `/projects/${proj.id}`, { layout }); return api<CaptureResult>('POST', `/projects/${proj.id}/capture`); },
    generate: async () => {
      generateCalls++;
      if (jobStarted) return { jobId: jobStarted };
      await api('PUT', `/projects/${proj.id}`, { layout, title: layout.title || c.title });
      const j = await api<{ id: string }>('POST', `/projects/${proj.id}/generate`, { provider: 'openai-image', maxFills: 'auto' });
      jobStarted = j.id;
      return { jobId: j.id };
    },
  };
  const items: ChatItem[] = [];
  let stats: TurnStats | null = null;
  let agentError: string | null = null;
  const ta = Date.now();
  try {
    const out = await runAgentTurn(c.prompt ?? '', host, {
      respond: (body, signal) => fetch(`${BASE}/scenegen/api/agent/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }),
      emit: (it) => { items.push(it); if (it.role === 'tool') log(`tool ${it.name}${it.isError ? ' (error)' : ''}`); },
      images: pics,
    });
    stats = out.stats;
  } catch (e) { agentError = (e as Error).message; log(`agent error: ${agentError}`); }
  const agentSeconds = (Date.now() - ta) / 1000;
  const issues = checkLayout(layout);
  // The agent is told to generate; if it did not, generate now so the rest of the pipeline is tested.
  if (!jobStarted && layout.objects.length) { log('agent did not start generation; starting it'); await host.generate(); }
  if (!jobStarted) return { id: c.id, kind: c.kind, title: c.title, ok: false, error: agentError ?? 'No layout to generate from.', inputs, agent: { seconds: agentSeconds, stats }, layout: { objects: layout.objects.length, issues: issues.map((i) => i.message) } };
  let lastStage = '';
  const { job, result } = await waitJob(proj.id, (j) => { if (j.stage !== lastStage) { lastStage = j.stage; log(`${j.stage}: ${j.message}`); } });
  const ok = job.status === 'done' && Boolean(result);
  if (ok) {
    const r = result as { files: Record<string, string> };
    for (const [k, f] of Object.entries(r.files)) if (k !== 'scene') writeFileSync(join(dir, f), await fetchBytes(`/scenegen/files/${proj.id}/out/${f}`));
  }
  writeFileSync(join(dir, 'layout.json'), JSON.stringify(layout, null, 2));
  writeFileSync(join(dir, 'chat.json'), JSON.stringify(items.map((it) => ('image' in it ? { ...it, image: it.image ? '(image)' : undefined } : it)), null, 2));
  const said = items.filter((i) => i.role === 'assistant').map((i) => i.text).join('\n');
  return {
    id: c.id, kind: c.kind, title: c.title, projectId: proj.id, ok, error: ok ? null : job.error ?? agentError,
    inputs, prompt: c.prompt,
    agent: { seconds: agentSeconds, stats, generateCalls, said, error: agentError },
    layout: { room: layout.room ? `${layout.room.width}×${layout.room.depth}×${layout.room.height} m` : `室外 ${layout.ground.size} m`, objects: layout.objects.length, types: layout.objects.map((o) => o.label), issues: issues.map((i) => i.message), style: layout.style.summary },
    pipeline: result, jobSeconds: job.endedAt ? (job.endedAt - job.startedAt) / 1000 : null, totalSeconds: (Date.now() - t0) / 1000,
  };
}

async function runPosesCase(c: Case, dir: string, log: (m: string) => void) {
  const t0 = Date.now();
  const proj = await api<{ id: string }>('POST', '/projects', { kind: 'video', title: c.title });
  await api('PUT', `/projects/${proj.id}/video`, undefined, { bytes: new Uint8Array(readFileSync(join(VIDEOS, c.video!))), type: 'video/mp4' });
  await api('POST', `/projects/${proj.id}/video-run`, {});
  let lastStage = '';
  const { job, result } = await waitJob(proj.id, (j) => { if (j.stage !== lastStage) { lastStage = j.stage; log(`${j.stage}: ${j.message}`); } });
  const ok = job.status === 'done' && Boolean(result);
  let views: { stats: Record<string, unknown>; frame: Record<string, unknown>; views: Array<{ file: string; c2w: number[][]; frameTime: number }> } | null = null;
  if (ok) {
    views = JSON.parse(new TextDecoder().decode(await fetchBytes(`/scenegen/files/${proj.id}/out/bundle/views.json`)));
    // A few frames for the report.
    const pick = [0, Math.floor(views!.views.length / 3), Math.floor((2 * views!.views.length) / 3), views!.views.length - 1];
    for (const [n, i] of pick.entries()) writeFileSync(join(dir, `frame-${n}.jpg`), await fetchBytes(`/scenegen/files/${proj.id}/out/bundle/${views!.views[i]!.file}`));
  }
  return {
    id: c.id, kind: c.kind, title: c.title, projectId: proj.id, ok, error: ok ? null : job.error, video: c.video,
    stats: views?.stats ?? null, frame: views?.frame ?? null,
    path: views?.views.map((v) => [v.c2w[0]![3], v.c2w[2]![3], v.c2w[0]![2], v.c2w[2]![2]]) ?? null,
    pipeline: result, jobSeconds: job.endedAt ? (job.endedAt - job.startedAt) / 1000 : null, totalSeconds: (Date.now() - t0) / 1000,
  };
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: e2e.mts <out-dir> [case-id ...]');
  const only = process.argv.slice(3);
  const cases = CASES.filter((c) => !only.length || only.includes(c.id) || only.includes(c.kind));
  mkdirSync(out, { recursive: true });
  const resultsFile = join(out, 'results.json');
  let all: Array<Record<string, unknown>> = [];
  try { all = JSON.parse(readFileSync(resultsFile, 'utf8')); } catch { /* first run */ }
  const concurrency = Number(process.env.E2E_CONCURRENCY ?? 3);
  const queue = [...cases];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const dir = join(out, c.id);
      mkdirSync(dir, { recursive: true });
      const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${c.id}: ${m}`);
      log(`start (${c.title})`);
      let r: Record<string, unknown>;
      try { r = c.kind === 'video-poses' ? await runPosesCase(c, dir, log) : await runLayoutCase(c, dir, log); } catch (e) { r = { id: c.id, kind: c.kind, title: c.title, ok: false, error: (e as Error).message }; }
      log(`${r.ok ? 'OK' : 'FAILED'} ${r.error ?? ''}`);
      writeFileSync(join(dir, 'result.json'), JSON.stringify(r, null, 2));
      all = [...all.filter((x) => x.id !== c.id), r].sort((a, b) => CASES.findIndex((x) => x.id === a.id) - CASES.findIndex((x) => x.id === b.id));
      writeFileSync(resultsFile, JSON.stringify(all, null, 2));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`done: ${all.filter((r) => r.ok).length}/${all.length} ok → ${resultsFile}`);
}

await main();
