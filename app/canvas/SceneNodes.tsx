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
import { generateScene, reconstructScene, STAGE_LABEL, watchProject } from '../../scenegen/web/runner.ts';
import type { RunStatus } from '../../scenegen/web/runner.ts';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { navigate, scenePath } from '../router.ts';
import type { CanvasNode } from './model.ts';

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

function useProject(id: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => (id ? watchProject(id, setProject) : undefined), [id, tick]);
  return { project, refresh: () => setTick((t) => t + 1) };
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

function FilePick({ accept, label, onFile, icon }: { accept: string; label: string; onFile: (f: File) => void; icon: 'image' | 'video' }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="cv-sg-chip" onClick={() => ref.current?.click()}><Icon name={icon} size={13} />{label}</button>
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </>
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

/** 场景生成: text / picture / video in, a generated 3DGS scene out. */
export function SceneGenCard({ node, inputs, onPatch, onSendToWorld }: Props) {
  const { project, refresh } = useProject(node.projectId);
  const [text, setText] = useState(node.text ?? '');
  const [media, setMedia] = useState<{ blob: Blob; url: string; kind: 'image' | 'video' } | null>(null);
  const [local, setLocal] = useState<RunStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const job = project?.job;
  const localRunning = Boolean(local && local.phase !== 'done' && local.phase !== 'failed');
  const status: SceneStatus = localRunning ? 'generating' : statusOf(project);
  const result = project?.result as { objects?: Array<{ file: string | null }>; files?: { panorama?: string }; alignment?: { floorY: number | null; objectsWithin25: number }; fill?: { after?: { worstHole: number } } | null; credits?: number } | null | undefined;
  const linkedImage = !media && inputs.imageSrc;
  const prompt = [inputs.text, text].filter((t) => t.trim()).join('\n');
  const opener = useOpener(node, project);

  const run = async () => {
    if (!node.projectId) return;
    setErr(null);
    try {
      let image: Blob | null = media?.kind === 'image' ? media.blob : null;
      if (!media && inputs.imageSrc) image = await (await fetch(inputs.imageSrc)).blob();
      await generateScene(node.projectId, { text: prompt, image, video: media?.kind === 'video' ? media.blob : null }, setLocal);
      setLocal(null);
      refresh();
    } catch (e) {
      setLocal({ phase: 'failed', message: (e as Error).message, progress: 0 });
      setErr((e as Error).message);
    }
  };

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
      ) : (
        <div className="cv-sg-input">
          {inputs.text && <div className="cv-sg-linked"><Icon name="text" size={12} />{inputs.text}</div>}
          <textarea placeholder="描述想要的场景，例如：一间温暖的日式茶室，矮桌、坐垫、纸拉门，傍晚的光" value={text}
            onChange={(e) => { setText(e.target.value); onPatch({ text: e.target.value }); }} />
          <div className="cv-sg-row">
            {media ? (
              <span className="cv-sg-media">{media.kind === 'image' ? <img src={media.url} alt="" /> : <video src={media.url} muted />}<button onClick={() => setMedia(null)}><Icon name="x" size={12} /></button></span>
            ) : linkedImage ? (
              <span className="cv-sg-media"><img src={inputs.imageSrc!} alt="" /><small>连入的图片</small></span>
            ) : (
              <>
                <FilePick accept="image/png,image/jpeg,image/webp" label="图片" icon="image" onFile={(f) => setMedia({ blob: f, url: URL.createObjectURL(f), kind: 'image' })} />
                <FilePick accept="video/mp4,video/quicktime" label="视频" icon="video" onFile={(f) => setMedia({ blob: f, url: URL.createObjectURL(f), kind: 'video' })} />
              </>
            )}
          </div>
        </div>
      )}
      <div className="cv-sg-foot">
        {status === 'generating' ? <Progress project={project} local={local} />
          : done ? <ResultActions project={project!} node={node} cover={file(project!.id, `out/${result!.files!.panorama!}`)} onSendToWorld={onSendToWorld} />
          : (
            <>
              <button className="cv-enter cv-sg-go" disabled={!node.projectId || (!prompt.trim() && !media && !linkedImage)} onClick={() => void run()}>{status === 'failed' ? '重新生成' : '生成场景'} <Icon name="sparkle" size={14} /></button>
              {(err || job?.status === 'failed') && <small className="cv-sg-err">{err ?? job?.error}</small>}
            </>
          )}
      </div>
    </div>
  );
}

/**
 * 场景重建: a video in, frames + COLMAP poses → a scene out: today an anchor panorama from the real
 * frames plus JST-2 views at the video's cameras (videoGen.ts); posed-images once JST-2 has it.
 */
export function SceneReconCard({ node, onSendToWorld }: Props) {
  const { project, refresh } = useProject(node.projectId);
  const [video, setVideo] = useState<{ blob: Blob; url: string } | null>(null);
  const [local, setLocal] = useState<RunStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [views, setViews] = useState<{ stats: Record<string, number>; first: string } | null>(null);
  const job = project?.job;
  const status: SceneStatus = local && local.phase !== 'failed' ? 'generating' : statusOf(project);
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

  const run = async () => {
    if (!node.projectId || (!video && !project?.video)) return;
    setErr(null);
    try {
      // A video uploaded before a reload is still on the server: run on it.
      if (video) await reconstructScene(node.projectId, video.blob, setLocal);
      else await sg.videoRun(node.projectId, {});
      setLocal(null);
      refresh();
    } catch (e) { setLocal(null); setErr((e as Error).message); }
  };

  const cover = generated && gen?.files?.panorama ? file(project!.id, `out/${gen.files.panorama}`, job?.endedAt) : views?.first ?? null;
  const videoUrl = video?.url ?? (project?.video ? file(project.id, project.video.file) : null);
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
        <Generating image={project && job?.status === 'running' ? file(project.id, 'out/anchor-stitched.png', job.startedAt) : null} video={videoUrl} />
      ) : (
        <div className="cv-sg-input">
          {videoUrl ? <video className="cv-sg-video" src={videoUrl} muted controls /> : (
            <div className="cv-node-empty cv-col cv-sg-drop">
              <Icon name="video" size={22} />
              <FilePick accept="video/mp4,video/quicktime" label="上传视频" icon="video" onFile={(f) => setVideo({ blob: f, url: URL.createObjectURL(f) })} />
              <small>绕着场景慢慢走或平移拍摄 10–60 秒</small>
            </div>
          )}
        </div>
      )}
      <div className="cv-sg-foot">
        {status === 'generating' ? <Progress project={project} local={local} />
          : done ? <ResultActions project={project!} node={node} cover={cover} onSendToWorld={onSendToWorld} />
          : (
            <>
              <button className="cv-enter cv-sg-go" disabled={!video && !project?.video} onClick={() => void run()}>{status === 'failed' ? '重新重建' : '重建场景'} <Icon name="camera" size={14} /></button>
              {(err || job?.status === 'failed') && <small className="cv-sg-err">{err ?? job?.error}</small>}
            </>
          )}
      </div>
    </div>
  );
}
