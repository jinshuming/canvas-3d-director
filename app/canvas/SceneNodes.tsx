/**
 * The canvas's scene nodes, backed by the scene generator (scenegen/):
 *
 *   场景生成  text, a picture or a video → the fast blockout → environment (JST-2) + key objects
 *             (SAM 3D) → composed scene
 *   场景重建  a video → frames + COLMAP poses → anchor panorama + JST-2 views at the video's cameras
 *
 * A node has three states: waiting for its input, generating, done (a failed run goes back to
 * waiting, with the error). Each node is one scenegen project on the server, so its progress and
 * result survive a reload; once its task exists, clicking the card opens the full-screen scene
 * editor (SceneEditor.tsx). A finished scene goes to a 导演台: imported into the library, set on a
 * new 导演台's stage, and a 导演台 node is wired after it.
 */
import { useEffect, useRef, useState } from 'react';

import { api as sg, file, toDataUrl } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import { STAGE_LABEL, watchProject } from '../../scenegen/web/runner.ts';
import type { RunStatus } from '../../scenegen/web/runner.ts';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { navigate, scenePath } from '../router.ts';
import type { CanvasNode } from './model.ts';
import type { SceneDraft } from './sceneDrafts.ts';
import { patchDraft, useDraft } from './sceneDrafts.ts';

/** What reaches a node through its incoming edges. */
export interface NodeInputs { text: string; imageSrc: string | null }

interface Props {
  node: CanvasNode;
  inputs: NodeInputs;
  onPatch: (patch: Partial<CanvasNode>) => void;
  onSendToWorld: (world: { worldId: string; title: string }) => void;
}

export type SceneStatus = 'input' | 'generating' | 'done' | 'failed';
export const STATUS_LABEL: Record<SceneStatus, string> = { input: '待输入', generating: '生成中', done: '已完成', failed: '失败' };

/** Where a scene project stands: its job decides, then whether it has a result. */
export function statusOf(p: Project | null): SceneStatus {
  if (!p) return 'input';
  if (p.job?.status === 'running') return 'generating';
  if (p.job?.status === 'failed') return 'failed';
  if (p.result) return 'done';
  return 'input';
}

/** The node's project, polled while its job runs; `version` (a run started or ended) fetches it again. */
function useProject(id: string | undefined, version: number) {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => (id ? watchProject(id, setProject) : undefined), [id, version]);
  return { project };
}

/** Export the project's scene, make a 导演台 (World) whose stage has it, and say which. */
export async function sendToWorld(project: Project, cover: string | null): Promise<{ worldId: string; title: string }> {
  const { sceneId } = await sg.exportScene(project.id);
  const lib = await api.library();
  const scene = lib.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('导入素材库后没找到这个场景。');
  const world = await api.createWorld({ title: project.title });
  const stage = await api.getStage(world.id);
  await api.saveStage({ ...stage, title: project.title, scene: { name: scene.name, url: scene.url, placement: null, viggle: scene.viggle, panoramaUrl: scene.panoramaUrl } }, stage.version);
  // The 导演台 node shows a cover: the panorama, or a frame of the video, until the editor saves its own.
  if (cover) await api.saveCover(world.id, await toDataUrl(cover, 960)).catch(() => {});
  return { worldId: world.id, title: world.title };
}

function Progress({ project, local }: { project: Project | null; local: RunStatus | null }) {
  const job = project?.job;
  const running = job?.status === 'running';
  const p = running ? job.progress : local?.progress ?? 0;
  const msg = running ? `${STAGE_LABEL[job.stage] ?? job.stage}：${job.message}` : local?.message ?? '';
  return (
    <div className="cv-sg-progress">
      <div className="cv-sg-bar"><div style={{ width: `${Math.round(Math.max(0.03, p) * 100)}%` }} /></div>
      <small>{msg}</small>
    </div>
  );
}

function ResultActions({ project, node, cover, onSendToWorld }: { project: Project; node: CanvasNode; cover: string | null; onSendToWorld: Props['onSendToWorld'] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="cv-sg-actions">
      <button className="cv-sg-btn" onClick={() => navigate(scenePath(project.id, node.id))}>打开 3D 编辑</button>
      <button className="cv-sg-btn primary" disabled={busy} onClick={() => { setBusy(true); setErr(null); void sendToWorld(project, cover).then(onSendToWorld).catch((e) => setErr((e as Error).message)).finally(() => setBusy(false)); }}>
        {busy ? '发送中…' : project.exported ? '再送一个导演台' : '送到导演台'} <Icon name="arrowRight" size={13} />
      </button>
      {err && <small className="cv-sg-err">{err}</small>}
    </div>
  );
}

/**
 * Clicking the card - not a drag, not one of its controls - opens the full-screen editor, once
 * the node's task exists.
 */
function useOpener(node: CanvasNode, project: Project | null) {
  const down = useRef<{ x: number; y: number } | null>(null);
  if (!node.projectId || !(project?.job || project?.result)) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => { down.current = { x: e.clientX, y: e.clientY }; },
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, a, input, textarea, video, label')) return;
      const d = down.current;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      navigate(scenePath(node.projectId!, node.id));
    },
    title: '打开全屏 3D 编辑',
  };
}

/** Tell the canvas what this card shows, so it draws the composer only while the node waits. */
function usePublish(nodeId: string, draft: SceneDraft, status: SceneStatus, serverVideo: boolean, project: Project | null) {
  // A submitted run hands over to the server's job once the card sees it.
  const started = project?.job?.startedAt ?? 0;
  useEffect(() => {
    if (draft.local?.phase === 'generating' && draft.submittedAt && started >= draft.submittedAt - 2000) patchDraft(nodeId, { local: null });
  }, [nodeId, draft.local?.phase, draft.submittedAt, started]);
  useEffect(() => {
    if (draft.status !== status || draft.serverVideo !== serverVideo) patchDraft(nodeId, { status, serverVideo });
  }, [nodeId, status, serverVideo, draft.status, draft.serverVideo]);
}

function StateBadge({ status }: { status: SceneStatus }) {
  return <span className={`cv-sg-state ${status}`}>{status === 'generating' && <span className="cv-sg-pulse" />}{STATUS_LABEL[status]}</span>;
}

/** The generating card: a picture of what is being made (when there is one) under the progress. */
function Generating({ image, video }: { image?: string | null; video?: string | null }) {
  const [ok, setOk] = useState(true);
  return (
    <div className="cv-sg-cover cv-sg-gen">
      {image && ok ? <img src={image} alt="" draggable={false} onError={() => setOk(false)} />
        : video ? <video src={video} muted />
        : <div className="cv-node-empty"><Icon name="scene" size={26} /></div>}
      <div className="cv-world-shade" />
      <div className="cv-sg-open-hint"><Icon name="expand" size={14} />点击进入 3D 编辑</div>
    </div>
  );
}

/** The waiting card: what the composer under the selected node has been given so far. */
function Waiting({ kind, draft, inputs, serverVideo }: { kind: 'scenegen' | 'scenerecon'; draft: SceneDraft; inputs: NodeInputs; serverVideo: string | null }) {
  const text = [inputs.text, draft.text].filter((t) => t.trim()).join(' · ');
  const image = draft.image?.url ?? inputs.imageSrc;
  const video = draft.video?.url ?? serverVideo;
  if (!text && !image && !video) {
    return <div className="cv-sg-wait"><Icon name={kind === 'scenegen' ? 'scene' : 'video'} size={30} /><small>{kind === 'scenegen' ? '选中节点，在下方输入文本、图片或视频' : '选中节点，在下方上传视频'}</small></div>;
  }
  return (
    <div className="cv-sg-wait filled">
      {(image || video) && <div className="cv-sg-wait-media">{image && <img src={image} alt="" draggable={false} />}{video && <video src={video} muted />}</div>}
      {text && <p>{text}</p>}
    </div>
  );
}

/** 场景生成: text / picture / video in, a generated 3DGS scene out. */
export function SceneGenCard({ node, inputs, onSendToWorld }: Props) {
  const draft = useDraft(node.id, node.text ?? '');
  const { project } = useProject(node.projectId, draft.version);
  const job = project?.job;
  const status: SceneStatus = draft.local ? 'generating' : statusOf(project);
  const result = project?.result as { objects?: Array<{ file: string | null }>; files?: { panorama?: string }; alignment?: { floorY: number | null; objectsWithin25: number }; fill?: { after?: { worstHole: number } } | null; credits?: number } | null | undefined;
  const opener = useOpener(node, project);
  usePublish(node.id, draft, status, false, project);
  const done = status === 'done' && result?.files?.panorama;
  return (
    <div className={`cv-sg-card ${status}${'onClick' in opener ? ' openable' : ''}`} {...opener}>
      <StateBadge status={status} />
      {done ? (
        <div className="cv-sg-cover">
          <img src={file(project!.id, `out/${result!.files!.panorama!}`, job?.endedAt)} alt="" draggable={false} />
          <div className="cv-world-shade" />
          <div className="cv-sg-cover-info">
            <strong>{project!.title}</strong>
            <small>{project!.layout.objects.length} 个物体{result!.objects?.length ? `（${result!.objects.filter((o) => o.file).length} 个 SAM 3D）` : ''} · 白模深度一致 {Math.round((result!.alignment?.objectsWithin25 ?? 0) * 100)}% · {result!.credits ?? 0} 额度</small>
          </div>
        </div>
      ) : status === 'generating' ? (
        <Generating image={project && job?.status === 'running' ? file(project.id, 'out/shaded.png', job.startedAt) : null} />
      ) : <Waiting kind="scenegen" draft={draft} inputs={inputs} serverVideo={null} />}
      <div className="cv-sg-foot">
        {status === 'generating' ? <Progress project={project} local={draft.local} />
          : done ? <ResultActions project={project!} node={node} cover={file(project!.id, `out/${result!.files!.panorama!}`)} onSendToWorld={onSendToWorld} />
          : (draft.error || job?.status === 'failed') ? <small className="cv-sg-err">{draft.error ?? job?.error}</small>
          : null}
      </div>
    </div>
  );
}

/**
 * 场景重建: a video in, frames + COLMAP poses → a scene out: today an anchor panorama from the real
 * frames plus JST-2 views at the video's cameras (videoGen.ts); posed-images once JST-2 has it.
 */
export function SceneReconCard({ node, inputs, onSendToWorld }: Props) {
  const draft = useDraft(node.id);
  const { project } = useProject(node.projectId, draft.version);
  const [views, setViews] = useState<{ stats: Record<string, number>; first: string } | null>(null);
  const job = project?.job;
  const status: SceneStatus = draft.local ? 'generating' : statusOf(project);
  const done = status === 'done';
  const gen = (project?.result as { mode?: string; verify?: { within25: number }; pathViews?: unknown[]; credits?: number; files?: { panorama?: string } } | null | undefined);
  const generated = gen?.mode === 'generate';
  const opener = useOpener(node, project);

  useEffect(() => {
    if (!done || !project) return;
    void fetch(file(project.id, 'out/bundle/views.json', job?.endedAt)).then((r) => (r.ok ? r.json() : null)).then((v: { stats: Record<string, number>; views: Array<{ file: string }> } | null) => {
      if (v) setViews({ stats: v.stats, first: file(project.id, `out/bundle/${v.views[Math.floor(v.views.length / 2)]!.file}`) });
    });
  }, [done, project?.id, job?.endedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const cover = generated && gen?.files?.panorama ? file(project!.id, `out/${gen.files.panorama}`, job?.endedAt) : views?.first ?? null;
  const serverVideo = project?.video ? file(project.id, project.video.file) : null;
  usePublish(node.id, draft, status, Boolean(serverVideo), project);
  return (
    <div className={`cv-sg-card ${status}${'onClick' in opener ? ' openable' : ''}`} {...opener}>
      <StateBadge status={status} />
      {done && views ? (
        <div className="cv-sg-cover">
          <img src={cover ?? views.first} alt="" draggable={false} />
          <div className="cv-world-shade" />
          <div className="cv-sg-cover-info">
            <strong>{project!.title}</strong>
            <small>关键帧注册 {views.stats.registered}/{views.stats.keyframes} · 重投影误差 {Number(views.stats.reprojErrorPx).toFixed(2)} px{generated ? ` · 沿视频路径生成 ${gen?.pathViews?.length ?? 0} 个视角 · ${gen?.credits ?? 0} 额度` : ` · ${views.stats.selected} 个视角发给 JST-2`}</small>
            <small className="cv-world-prompt">{generated ? `锚点全景（视频帧拼接 + 补全）建场景 · 与视频一致 ${Math.round((gen?.verify?.within25 ?? 0) * 100)}%` : 'posed-images 接口未开放：当前为稀疏点云预览'}</small>
          </div>
        </div>
      ) : status === 'generating' ? (
        <Generating image={project && job?.status === 'running' ? file(project.id, 'out/anchor-stitched.png', job.startedAt) : null} video={draft.video?.url ?? serverVideo} />
      ) : <Waiting kind="scenerecon" draft={draft} inputs={inputs} serverVideo={serverVideo} />}
      <div className="cv-sg-foot">
        {status === 'generating' ? <Progress project={project} local={draft.local} />
          : done ? <ResultActions project={project!} node={node} cover={cover} onSendToWorld={onSendToWorld} />
          : (draft.error || job?.status === 'failed') ? <small className="cv-sg-err">{draft.error ?? job?.error}</small>
          : null}
      </div>
    </div>
  );
}
