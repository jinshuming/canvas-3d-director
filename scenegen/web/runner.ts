/**
 * Running the scene generator from somewhere other than its own page - the
 * canvas's 场景生成 / 场景重建 nodes. One node = one scenegen project on the
 * server (like a World node = one World), so its progress and result survive
 * a reload; the agent turn runs in the page that started it.
 */
import { api } from './api.ts';
import type { Job, Project } from './api.ts';

export type RunPhase = 'idle' | 'uploading' | 'agent' | 'generating' | 'done' | 'failed';
export interface RunStatus { phase: RunPhase; message: string; progress: number }

export interface SceneInputs { text: string; image?: Blob | null; video?: Blob | null; /** Key objects as SAM 3D assets. Default on. */ objects?: boolean }

/**
 * Text / picture / video → the fast blockout (one structured model call, deterministic placement)
 * → generation: panorama, then the environment (JST-2, gap fill) and the key objects (SAM 3D) side
 * by side, composed by the blockout.
 */
export async function generateScene(projectId: string, inputs: SceneInputs, onStatus: (s: RunStatus) => void): Promise<Job> {
  // Any combination of text, a picture and a video.
  if (inputs.video) {
    onStatus({ phase: 'uploading', message: '上传视频，抽取关键帧', progress: 0.02 });
    await api.layoutVideo(projectId, inputs.video);
  }
  if (inputs.image) {
    onStatus({ phase: 'uploading', message: '上传图片', progress: 0.03 });
    await api.reference(projectId, inputs.image);
  }
  onStatus({ phase: 'agent', message: '理解输入，摆放白模', progress: 0.05 });
  const q = await api.quickLayout(projectId, { text: inputs.text, useVideo: Boolean(inputs.video), useReference: Boolean(inputs.image) });
  if (!q.layout.objects.length) throw new Error('没有摆出任何物体，换个说法再试一次。');
  onStatus({ phase: 'generating', message: `白模：${q.layout.objects.length} 个物体（${q.keys.length} 个关键物体），${(q.seconds.model + q.seconds.place).toFixed(0)} 秒`, progress: 0.08 });
  return api.generate(projectId, inputs.objects === false ? { objects: false } : {});
}

/** Video → poses (COLMAP) → scene (the server picks the route: generate today, posed-images later). */
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
  start: '开始', conditions: '渲染白模', pano: '生成全景图', scale: '测量尺度', scene: 'JST-2 建环境', fill: '检测并补缺口', objects: 'SAM 3D 生成物体', compose: '合成', verify: '校验', done: '完成',
  probe: '读取视频', sample: '抽帧', colmap: 'COLMAP 估计位姿', normalise: '重力与尺度', select: '挑选视角', write: '写出图片+位姿', upload: '上传 JST-2',
  stitch: '拼接锚点全景', complete: '补全视频没拍到的部分', retry: '重试', path: '沿视频路径生成视角', rebuild: 'JST-2 重建',
};
