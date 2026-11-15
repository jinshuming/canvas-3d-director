/**
 * The canvas's scene nodes, backed by the scene generator (scenegen/):
 *
 *   场景生成  text, a picture or a video → blockout (agent) → panorama → JST-2 scene → gap fill
 *   场景重建  a video → frames + COLMAP poses → JST-2 posed-images → scene
 *
 * Each node is one scenegen project on the server, so its progress and result
 * survive a reload. A finished scene goes to a World: imported into the
 * library, set on a new World's stage, and a World node is wired after it.
 */
import { useEffect, useRef, useState } from 'react';

import { api as sg, file } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import { generateScene, reconstructScene, STAGE_LABEL, watchProject } from '../../scenegen/web/runner.ts';
import type { RunStatus } from '../../scenegen/web/runner.ts';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import type { CanvasNode } from './model.ts';

/** What reaches a node through its incoming edges. */
export interface NodeInputs { text: string; imageSrc: string | null }

interface Props {
  node: CanvasNode;
  inputs: NodeInputs;
  onPatch: (patch: Partial<CanvasNode>) => void;
  onSendToWorld: (world: { worldId: string; title: string }) => void;
}

function useProject(id: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => (id ? watchProject(id, setProject) : undefined), [id, tick]);
  return { project, refresh: () => setTick((t) => t + 1) };
}

/** Export the project's scene, make a World whose stage has it, and say which. */
async function sendToWorld(project: Project): Promise<{ worldId: string; title: string }> {
  const { sceneId } = await sg.exportScene(project.id);
  const lib = await api.library();
  const scene = lib.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('导入素材库后没找到这个场景。');
  const world = await api.createWorld({ title: project.title });
  const stage = await api.getStage(world.id);
  await api.saveStage({ ...stage, title: project.title, scene: { name: scene.name, url: scene.url, placement: null, viggle: scene.viggle, panoramaUrl: scene.panoramaUrl } }, stage.version);
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

function ResultActions({ project, onSendToWorld }: { project: Project; onSendToWorld: Props['onSendToWorld'] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="cv-sg-actions">
      <button className="cv-sg-btn" onClick={() => window.open(`/scenegen/index.html#${project.id}`, '_blank')}>查看 3D</button>
      <button className="cv-sg-btn primary" disabled={busy} onClick={() => { setBusy(true); setErr(null); void sendToWorld(project).then(onSendToWorld).catch((e) => setErr((e as Error).message)).finally(() => setBusy(false)); }}>
        {busy ? '发送中…' : project.exported ? '再送一个 World' : '送到 World'} <Icon name="arrowRight" size={13} />
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

/** 场景生成: text / picture / video in, a generated 3DGS scene out. */
export function SceneGenCard({ node, inputs, onPatch, onSendToWorld }: Props) {
  const { project, refresh } = useProject(node.projectId);
  const [text, setText] = useState(node.text ?? '');
  const [media, setMedia] = useState<{ blob: Blob; url: string; kind: 'image' | 'video' } | null>(null);
  const [local, setLocal] = useState<RunStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const job = project?.job;
  const running = Boolean(local && local.phase !== 'done' && local.phase !== 'failed') || job?.status === 'running';
  const result = project?.result as { files?: { panorama?: string }; alignment?: { floorY: number | null; objectsWithin25: number }; fill?: { after?: { worstHole: number } } | null; credits?: number } | null | undefined;
  const linkedImage = !media && inputs.imageSrc;
  const prompt = [inputs.text, text].filter((t) => t.trim()).join('\n');

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

  const done = job?.status === 'done' && result?.files?.panorama;
  return (
    <div className="cv-sg-card">
      {done ? (
        <div className="cv-sg-cover">
          <img src={file(project!.id, `out/${result!.files!.panorama!}`, job?.endedAt)} alt="" draggable={false} />
          <div className="cv-world-shade" />
          <div className="cv-sg-cover-info">
            <strong>{project!.title}</strong>
            <small>{project!.layout.objects.length} 个物体 · 白模深度一致 {Math.round((result!.alignment?.objectsWithin25 ?? 0) * 100)}% · 最大空洞 {Math.round((result!.fill?.after?.worstHole ?? 0) * 100)}% · {result!.credits ?? 0} 额度</small>
          </div>
        </div>
      ) : (
        <div className="cv-sg-input">
          {inputs.text && <div className="cv-sg-linked"><Icon name="text" size={12} />{inputs.text}</div>}
          <textarea placeholder="描述想要的场景，例如：一间温暖的日式茶室，矮桌、坐垫、纸拉门，傍晚的光" value={text} disabled={running}
            onChange={(e) => { setText(e.target.value); onPatch({ text: e.target.value }); }} />
          <div className="cv-sg-row">
            {media ? (
              <span className="cv-sg-media">{media.kind === 'image' ? <img src={media.url} alt="" /> : <video src={media.url} muted />}<button onClick={() => setMedia(null)} disabled={running}><Icon name="x" size={12} /></button></span>
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
        {running ? <Progress project={project} local={local} />
          : done ? <ResultActions project={project!} onSendToWorld={onSendToWorld} />
          : (
            <>
              <button className="cv-enter cv-sg-go" disabled={!node.projectId || (!prompt.trim() && !media && !linkedImage)} onClick={() => void run()}>生成场景 <Icon name="sparkle" size={14} /></button>
              {(err || job?.status === 'failed') && <small className="cv-sg-err">{err ?? job?.error}</small>}
            </>
          )}
      </div>
    </div>
  );
}

/** 场景重建: a video in, frames + COLMAP poses → JST-2 posed-images → a scene out. */
export function SceneReconCard({ node, onSendToWorld }: Props) {
  const { project, refresh } = useProject(node.projectId);
  const [video, setVideo] = useState<{ blob: Blob; url: string } | null>(null);
  const [local, setLocal] = useState<RunStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [views, setViews] = useState<{ stats: Record<string, number>; first: string } | null>(null);
  const job = project?.job;
  const running = Boolean(local && local.phase !== 'failed') || job?.status === 'running';
  const done = job?.status === 'done' && project?.result;

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

  return (
    <div className="cv-sg-card">
      {done && views ? (
        <div className="cv-sg-cover">
          <img src={views.first} alt="" draggable={false} />
          <div className="cv-world-shade" />
          <div className="cv-sg-cover-info">
            <strong>{project!.title}</strong>
            <small>关键帧注册 {views.stats.registered}/{views.stats.keyframes} · 重投影误差 {Number(views.stats.reprojErrorPx).toFixed(2)} px · {views.stats.selected} 个视角发给 JST-2</small>
            <small className="cv-world-prompt">posed-images 接口未开放：当前为稀疏点云预览</small>
          </div>
        </div>
      ) : (
        <div className="cv-sg-input">
          {video ? <video className="cv-sg-video" src={video.url} muted controls /> : project?.video ? <video className="cv-sg-video" src={file(project.id, project.video.file)} muted controls /> : (
            <div className="cv-node-empty cv-col cv-sg-drop">
              <Icon name="video" size={22} />
              <FilePick accept="video/mp4,video/quicktime" label="上传视频" icon="video" onFile={(f) => setVideo({ blob: f, url: URL.createObjectURL(f) })} />
              <small>绕着场景慢慢走或平移拍摄 10–60 秒</small>
            </div>
          )}
        </div>
      )}
      <div className="cv-sg-foot">
        {running ? <Progress project={project} local={local} />
          : done ? <ResultActions project={project!} onSendToWorld={onSendToWorld} />
          : (
            <>
              <button className="cv-enter cv-sg-go" disabled={!video && !project?.video} onClick={() => void run()}>重建场景 <Icon name="camera" size={14} /></button>
              {(err || job?.status === 'failed') && <small className="cv-sg-err">{err ?? job?.error}</small>}
            </>
          )}
      </div>
    </div>
  );
}
