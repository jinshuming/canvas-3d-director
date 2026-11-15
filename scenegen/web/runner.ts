/**
 * Running the scene generator from somewhere other than its own page - the
 * canvas's 场景生成 / 场景重建 nodes. One node = one scenegen project on the
 * server (like a World node = one World), so its progress and result survive
 * a reload; the agent turn runs in the page that started it.
 */
import { runAgentTurn } from '../agent/loop.ts';
import type { AgentHost } from '../agent/tools.ts';
import type { Layout } from '../core/types.ts';
import { api, toDataUrl } from './api.ts';
import type { Job, Project } from './api.ts';

export type RunPhase = 'idle' | 'uploading' | 'agent' | 'generating' | 'done' | 'failed';
export interface RunStatus { phase: RunPhase; message: string; progress: number }

export interface SceneInputs { text: string; image?: Blob | null; video?: Blob | null }

/** Text / picture / video → agent lays out the blockout → generation job (panorama, JST-2, gap fill). */
export async function generateScene(projectId: string, inputs: SceneInputs, onStatus: (s: RunStatus) => void): Promise<Job> {
  const pics: string[] = [];
  if (inputs.video) {
    onStatus({ phase: 'uploading', message: '上传视频，抽取关键帧', progress: 0.02 });
    const k = await api.layoutVideo(projectId, inputs.video);
    for (const f of k.frames) pics.push(await toDataUrl(f.url, 768));
  } else if (inputs.image) {
    onStatus({ phase: 'uploading', message: '上传图片', progress: 0.02 });
    await api.reference(projectId, inputs.image);
    pics.push(await toDataUrl(inputs.image, 1280));
  }
  const project = await api.get(projectId);
  const layout: Layout = project.layout;
  let job: Job | null = null;
  const host: AgentHost = {
    layout,
    changed: () => {},
    look: async () => {
      await api.put(projectId, { layout });
      const c = await api.conditions(projectId);
      if (!layout.capture) layout.capture = c.capture;
      return { image: await toDataUrl(c.files.shaded, 1024), prompt: c.prompt };
    },
    findCapture: async () => { await api.put(projectId, { layout }); return api.capture(projectId); },
    generate: async () => {
      if (job) return { jobId: job.id };
      await api.put(projectId, { layout, title: layout.title });
      job = await api.generate(projectId, {});
      return { jobId: job.id };
    },
  };
  let tools = 0;
  onStatus({ phase: 'agent', message: 'Agent 正在理解输入、摆放白模', progress: 0.05 });
  await runAgentTurn(inputs.text.trim(), host, {
    respond: (body, signal) => fetch('/scenegen/api/agent/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }),
    emit: (it) => {
      if (it.role !== 'tool') return;
      tools++;
      const what: Record<string, string> = { set_room: '建房间', set_outdoor: '设室外场地', add_opening: '开门窗', place_objects: '摆放物体', update_object: '调整物体', check_layout: '检查布局', set_style: '设定风格', look: '查看白模', choose_capture_point: '选拍摄点', generate_scene: '开始生成' };
      onStatus({ phase: 'agent', message: `Agent：${what[it.name] ?? it.name}（${layout.objects.length} 个物体）`, progress: Math.min(0.12, 0.05 + tools * 0.005) });
    },
    images: pics,
  });
  // The agent is asked to start generation; if it stopped short, start it so the node finishes.
  if (!job) {
    if (!layout.objects.length) throw new Error('Agent 没有摆出任何物体，换个说法再试一次。');
    await host.generate();
  }
  await api.put(projectId, { layout, title: layout.title });
  return job!;
}

/** Video → poses (COLMAP) → posed-images → scene. */
export async function reconstructScene(projectId: string, video: Blob, onStatus: (s: RunStatus) => void): Promise<Job> {
  onStatus({ phase: 'uploading', message: '上传视频', progress: 0.01 });
  await api.video(projectId, video);
  return api.videoRun(projectId, {});
}

/** Poll a project until its job ends; calls back on every change. */
export function watchProject(projectId: string, onProject: (p: Project) => void, intervalMs = 2000): () => void {
  let live = true;
  const tick = async () => {
    if (!live) return;
    try {
      const p = await api.get(projectId);
      onProject(p);
      if (p.job?.status === 'running') setTimeout(() => void tick(), intervalMs);
    } catch { if (live) setTimeout(() => void tick(), intervalMs * 2); }
  };
  void tick();
  return () => { live = false; };
}

export const STAGE_LABEL: Record<string, string> = {
  start: '开始', conditions: '渲染白模', pano: '生成全景图', scale: '测量尺度', scene: 'JST-2 建场景', fill: '检测并补缺口', verify: '校验', done: '完成',
  probe: '读取视频', sample: '抽帧', colmap: 'COLMAP 估计位姿', normalise: '重力与尺度', select: '挑选视角', write: '写出图片+位姿', upload: '上传 JST-2',
};
