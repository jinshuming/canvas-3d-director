/**
 * What a scene node is about to be given - its text, picture and video - and its run before the
 * server's job exists (uploading, laying out the blockout). Shared by the node's card and the
 * composer under the selected node, which are drawn apart (the card on the board, the composer
 * in screen space). Files stay in memory: they go to the server when the run starts.
 */
import { useSyncExternalStore } from 'react';

import { generateScene, reconstructScene } from '../../scenegen/web/runner.ts';
import type { RunStatus } from '../../scenegen/web/runner.ts';
import { api as sg } from '../../scenegen/web/api.ts';

export interface Media { blob: Blob; url: string; name: string }
export interface SceneDraft {
  text: string;
  image: Media | null;
  video: Media | null;
  /** Key objects as SAM 3D assets (场景生成). */
  objects: boolean;
  local: RunStatus | null;
  error: string | null;
  /** Bumped when a run starts or ends, so the card fetches its project again. */
  version: number;
  /** What the card shows (it knows the project): the canvas draws the composer only while it waits. */
  status?: 'input' | 'generating' | 'done' | 'failed';
  /** The project already has a video on the server (场景重建). */
  serverVideo?: boolean;
  /** When the run was submitted: `local` stays until the card sees a job started after it. */
  submittedAt?: number;
}

const EMPTY: SceneDraft = { text: '', image: null, video: null, objects: true, local: null, error: null, version: 0 };
const drafts = new Map<string, SceneDraft>();
const listeners = new Set<() => void>();

export function getDraft(nodeId: string, text = ''): SceneDraft {
  let d = drafts.get(nodeId);
  if (!d) { d = { ...EMPTY, text }; drafts.set(nodeId, d); }
  return d;
}

export function patchDraft(nodeId: string, patch: Partial<SceneDraft>): void {
  drafts.set(nodeId, { ...getDraft(nodeId), ...patch });
  for (const l of listeners) l();
}

export function useDraft(nodeId: string, text = ''): SceneDraft {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => getDraft(nodeId, text));
}

export const mediaOf = (f: File): Media => ({ blob: f, url: URL.createObjectURL(f), name: f.name });

/** 场景生成 from the draft (plus what flows in through edges); 场景重建 from its video. */
export async function runNode(kind: 'scenegen' | 'scenerecon', nodeId: string, projectId: string, linked: { text: string; imageSrc: string | null }, hasServerVideo: boolean): Promise<void> {
  const d = getDraft(nodeId);
  patchDraft(nodeId, { error: null, submittedAt: Date.now(), local: { phase: 'uploading', message: '准备中', progress: 0.01 } });
  const onStatus = (s: RunStatus) => patchDraft(nodeId, { local: s });
  try {
    if (kind === 'scenerecon') {
      if (d.video) await reconstructScene(projectId, d.video.blob, onStatus);
      else if (hasServerVideo) await sg.videoRun(projectId, {});
      else throw new Error('先上传一段视频。');
    } else {
      let image = d.image?.blob ?? null;
      if (!image && linked.imageSrc) image = await (await fetch(linked.imageSrc)).blob();
      const text = [linked.text, d.text].filter((t) => t.trim()).join('\n');
      await generateScene(projectId, { text, image, video: d.video?.blob ?? null, objects: d.objects }, onStatus);
    }
    // Still 生成中 until the card has fetched the job this started (no flash of the old state).
    patchDraft(nodeId, { local: { phase: 'generating', message: '已提交', progress: 0.08 }, image: null, video: null, version: getDraft(nodeId).version + 1 });
  } catch (e) {
    patchDraft(nodeId, { local: null, error: (e as Error).message, version: getDraft(nodeId).version + 1 });
  }
}
