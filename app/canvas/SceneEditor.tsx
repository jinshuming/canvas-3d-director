/**
 * The full-screen scene editor a 场景生成 / 场景重建 node opens once its task exists: a header
 * (back to the canvas, status, download, 送到导演台) over GenEditor or ReconEditor. It polls the
 * project while its job runs, so it follows a task the canvas started.
 */
import { useCallback, useEffect, useState } from 'react';

import { api as sg, file } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import { Icon } from '../icons.tsx';
import { linkProps, navigate, worldPath } from '../router.ts';
import { GenEditor } from './GenEditor.tsx';
import { appendWorldAfter } from './model.ts';
import { ReconEditor } from './ReconEditor.tsx';
import { sendToWorld, STATUS_LABEL, statusOf } from './SceneNodes.tsx';
import './scene-editor.css';

type ResultFiles = { files?: Record<string, string | null> } | null | undefined;

export function SceneEditor({ projectId, nodeId }: { projectId: string; nodeId: string | null }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setProject(await sg.get(projectId)); } catch (e) { setError((e as Error).message); }
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);
  // Follow the job while it runs, wherever it was started.
  const running = project?.job?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(t);
  }, [running, reload]);

  if (error) return <div className="se-root se-center">打不开这个场景：{error} <a {...linkProps('/canvas')}>返回画布</a></div>;
  if (!project) return <div className="se-root se-center">加载场景…</div>;
  const status = statusOf(project);
  const sceneFile = (project.result as ResultFiles)?.files?.scene;
  const recon = project.kind === 'video';
  return (
    <div className="se-root">
      <header className="se-top">
        <a className="se-back" {...linkProps('/canvas')} title="回到画布"><Icon name="chevronLeft" size={18} />画布</a>
        <span className="se-kind"><Icon name={recon ? 'camera' : 'scene'} size={15} />{recon ? '场景重建' : '场景生成'}</span>
        <strong className="se-title">{project.title}</strong>
        <span className={`se-status ${status}`}>{STATUS_LABEL[status]}</span>
        <div className="se-spacer" />
        {status === 'done' && sceneFile && <a className="se-btn" href={file(project.id, `out/${sceneFile}`, project.job?.endedAt ?? 0)} download><Icon name="download" size={15} />下载 .spz</a>}
        {status === 'done' && <SendToStudio project={project} nodeId={nodeId} onSent={() => void reload()} />}
      </header>
      {recon ? <ReconEditor project={project} reload={reload} /> : <GenEditor project={project} reload={reload} />}
    </div>
  );
}

/** 送到导演台: the scene into the library, a new 导演台 with it, and a 导演台 node after this one on the canvas. */
function SendToStudio({ project, nodeId, onSent }: { project: Project; nodeId: string | null; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ worldId: string; node: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const panorama = (project.result as ResultFiles)?.files?.panorama;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const w = await sendToWorld(project, panorama ? file(project.id, `out/${panorama}`) : null);
      setSent({ worldId: w.worldId, node: nodeId ? appendWorldAfter(nodeId, w.worldId, w.title) : null });
      onSent();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (sent) return <button className="se-btn primary" onClick={() => navigate(worldPath(sent.worldId, sent.node))}>进入导演台 <Icon name="arrowRight" size={15} /></button>;
  return <>
    {err && <small className="se-err">{err}</small>}
    <button className="se-btn primary" disabled={busy} onClick={() => void send()}>{busy ? '发送中…' : project.exported ? '再送一个导演台' : '送到导演台'} <Icon name="arrowRight" size={15} /></button>
  </>;
}
