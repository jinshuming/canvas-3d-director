/**
 * The full-screen scene editor a 场景生成 / 场景重建 node opens once its task exists.
 *
 *   场景生成  the 3D view (the generated scene, its layers - environment and each SAM 3D object -
 *             or the blockout while there is no scene yet) beside the scene agent: the first
 *             message lays out the blockout fast, later ones edit it, and 生成 runs the pipeline
 *   场景重建  the 3D view beside the reconstruction: progress, the anchor panorama, the video's
 *             real frames against the views JST-2 generated at the same cameras
 *
 * Both poll the project while its job runs, so they follow a task the canvas started.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatItem } from '../../scenegen/agent/loop.ts';
import { runAgentTurn } from '../../scenegen/agent/loop.ts';
import type { Layout } from '../../scenegen/core/types.ts';
import { projectHost } from '../../scenegen/web/agentHost.ts';
import { api as sg, file, toDataUrl } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import { STAGE_LABEL } from '../../scenegen/web/runner.ts';
import { SplatViewer } from '../../scenegen/web/SplatViewer.tsx';
import { Viewport } from '../../scenegen/web/Viewport.tsx';
import { Icon } from '../icons.tsx';
import { linkProps, navigate, worldPath } from '../router.ts';
import { appendWorldAfter } from './model.ts';
import { sendToWorld, STATUS_LABEL, statusOf } from './SceneNodes.tsx';
import './scene-editor.css';

interface ChatState { items: ChatItem[]; previousId: string | null }

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
  const stamp = project.job?.endedAt ?? 0;
  const result = project.result as { files?: Record<string, string | null> } | null | undefined;
  const scene = result?.files?.scene ? file(project.id, `out/${result.files.scene}`, stamp) : null;
  return (
    <div className="se-root">
      <header className="se-top">
        <a className="se-back" {...linkProps('/canvas')} title="回到画布"><Icon name="chevronLeft" size={18} />画布</a>
        <span className="se-kind"><Icon name={project.kind === 'video' ? 'camera' : 'scene'} size={15} />{project.kind === 'video' ? '场景重建' : '场景生成'}</span>
        <strong className="se-title">{project.title}</strong>
        <span className={`se-status ${status}`}>{STATUS_LABEL[status]}</span>
        <div className="se-spacer" />
        {scene && status === 'done' && <a className="se-btn" href={scene} download><Icon name="download" size={15} />下载 .spz</a>}
        {status === 'done' && <SendToStudio project={project} nodeId={nodeId} onSent={() => void reload()} />}
      </header>
      {project.kind === 'video' ? <ReconEditor project={project} reload={reload} /> : <GenEditor project={project} reload={reload} />}
    </div>
  );
}

/** 送到导演台: the scene into the library, a new 导演台 with it, and a 导演台 node after this one on the canvas. */
function SendToStudio({ project, nodeId, onSent }: { project: Project; nodeId: string | null; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ worldId: string; node: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const r = project.result as { files?: Record<string, string | null> } | null | undefined;
  const cover = r?.files?.panorama ? file(project.id, `out/${r.files.panorama}`) : null;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const w = await sendToWorld(project, cover);
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

function Progress({ project }: { project: Project }) {
  const job = project.job;
  if (job?.status !== 'running') return null;
  return (
    <div className="se-progress">
      <div className="se-bar"><div style={{ width: `${Math.round(Math.max(0.03, job.progress) * 100)}%` }} /></div>
      <span><b>{STAGE_LABEL[job.stage] ?? job.stage}</b> {job.message}</span>
    </div>
  );
}

// ── 场景生成 ───────────────────────────────────────────────────────────────

type GenResult = {
  files: Record<string, string | null>; capture: { yaw: number }; credits: number; seconds: Record<string, number>;
  alignment: { within25: number; objectsWithin25: number };
  objects?: Array<{ id: string; label: string; file: string | null; crop: string; spread: number | null; error: string | null }>;
};

function GenEditor({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [layout, setLayout] = useState<Layout>(project.layout);
  const [chat, setChat] = useState<ChatState>(() => (project.chat[0] as ChatState | undefined) ?? { items: [], previousId: null });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const result = project.result as GenResult | null | undefined;
  const job = project.job;
  const running = job?.status === 'running';
  const [view, setView] = useState<'scene' | 'blockout' | 'pano'>(result?.files?.scene && !running ? 'scene' : 'blockout');
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const log = useRef<HTMLDivElement>(null);

  // The layout the server has (the canvas may have laid it out), unless a turn is changing it here.
  useEffect(() => { if (!busy) setLayout(project.layout); }, [project.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // A run that finishes shows its scene.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && result?.files?.scene) setView('scene');
    wasRunning.current = running;
  }, [running, result?.files?.scene]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [chat.items.length, busy]);

  const persist = async (l: Layout, c: ChatState) => {
    // Pictures stay out of the stored chat: they are big and the model already has them.
    const stored = [{ ...c, items: c.items.map((it) => ('image' in it && it.image ? { ...it, image: undefined } : it)) }];
    await sg.put(project.id, { layout: l, title: l.title, chat: stored });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || running) return;
    setDraft(''); setBusy(true);
    let state = chat;
    const emit = (it: ChatItem) => { state = { ...state, items: [...state.items, it] }; setChat(state); };
    try {
      if (!layoutRef.current.objects.length) {
        // Nothing laid out yet: the fast path - one structured call, deterministic placement.
        emit({ role: 'user', text });
        const q = await sg.quickLayout(project.id, { text });
        setLayout(q.layout); layoutRef.current = q.layout;
        setView('blockout');
        emit({ role: 'assistant', text: `白模已摆好：${q.layout.objects.length} 个物体，关键物体 ${q.keys.join('、') || '无'}（${(q.seconds.model + q.seconds.place).toFixed(1)} 秒）。可以点「生成场景」，或继续说要改什么。` });
      } else {
        const work = structuredClone(layoutRef.current);
        const host = projectHost(project.id, work, {
          toDataUrl, onChanged: () => setLayout(structuredClone(work)),
          generateBody: () => ({ objects: true }), onJob: () => void reload(),
        });
        setView('blockout');
        const out = await runAgentTurn(text, host, { respond: sg.respondAgent, previousId: state.previousId, emit });
        state = { ...state, previousId: out.previousId };
        setChat(state);
        setLayout(structuredClone(work)); layoutRef.current = work;
      }
    } catch (e) {
      emit({ role: 'assistant', text: `出错了：${(e as Error).message}` });
    } finally {
      await persist(layoutRef.current, state).catch(() => {});
      setBusy(false);
      void reload();
    }
  };

  const generate = async () => {
    await sg.put(project.id, { layout: layoutRef.current, title: layoutRef.current.title });
    await sg.generate(project.id, { objects: true });
    await reload();
  };

  const stamp = job?.endedAt ?? 0;
  const objects = (result?.objects ?? []).filter((o) => o.file);
  return (
    <div className="se-body">
      <section className="se-stage">
        <div className="se-tabs">
          {result?.files?.scene && <button className={view === 'scene' ? 'on' : ''} onClick={() => setView('scene')}>3D 场景</button>}
          <button className={view === 'blockout' ? 'on' : ''} onClick={() => setView('blockout')}>白模</button>
          {result?.files?.panorama && <button className={view === 'pano' ? 'on' : ''} onClick={() => setView('pano')}>全景图</button>}
          <span className="se-spacer" />
          <span className="se-muted">{layout.room ? `室内 ${layout.room.width}×${layout.room.depth}×${layout.room.height} m` : layout.objects.length ? '室外' : ''}{layout.objects.length ? ` · ${layout.objects.length} 个物体` : ''}</span>
        </div>
        <div className="se-view">
          {view === 'scene' && result?.files?.scene
            ? <SplatViewer url={file(project.id, `out/${objects.length && result.files.environment ? result.files.environment : result.files.scene}`, stamp)}
                objects={result.files.environment ? objects.map((o) => ({ id: o.id, label: o.label, url: file(project.id, `out/${o.file}`, stamp) })) : []} yaw={result.capture?.yaw ?? 0} />
            : view === 'pano' && result?.files?.panorama ? <img className="se-pano" src={file(project.id, `out/${result.files.panorama}`, stamp)} alt="" />
            : layout.objects.length ? <Viewport layout={layout} capture={layout.capture} selected={selected} onSelect={setSelected} background="#17181b" />
            : <div className="se-empty"><Icon name="scene" size={34} /><p>在右侧描述你想要的场景，几秒内摆成白模。</p></div>}
          <Progress project={project} />
          {job?.status === 'failed' && <div className="se-failed">生成失败：{job.error}</div>}
        </div>
        {result && !running && <div className="se-strip">
          <span>与白模一致 <b>{Math.round((result.alignment?.within25 ?? 0) * 100)}%</b></span>
          <span>SAM 3D 物体 <b>{objects.length}</b></span>
          <span>额度 <b>{result.credits}</b></span>
          <span>耗时 <b>{Math.round(Object.values(result.seconds ?? {}).reduce((a, b) => a + b, 0))} 秒</b></span>
          {(result.objects ?? []).map((o) => <img key={o.id} className="se-thumb" src={file(project.id, `out/${o.crop}`, stamp)} title={o.error ?? o.label} alt="" />)}
        </div>}
      </section>

      <aside className="se-chat">
        <header><Icon name="sparkle" size={16} />场景 Agent</header>
        <div className="se-log" ref={log}>
          {!chat.items.length && <div className="se-hint">
            <p>用一句话描述场景，例如「一间温暖的日式茶室，矮桌、坐垫、纸拉门，傍晚的光」。</p>
            <p>第一句几秒内摆成白模；之后可以继续说要改什么（加一张桌子、窗户放在东墙、换成夜晚），再点「生成场景」。</p>
          </div>}
          {chat.items.map((it, i) => <ChatRow key={i} item={it} />)}
          {busy && <div className="se-msg assistant pending">思考中…</div>}
        </div>
        <div className="se-composer">
          <textarea value={draft} disabled={busy || running} placeholder={layout.objects.length ? '说说要改什么…' : '描述想要的场景…'}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <div className="se-row">
            <button className="se-btn" disabled={!layout.objects.length || busy || running} onClick={() => void generate().catch((e) => setChat((c) => ({ ...c, items: [...c.items, { role: 'assistant', text: `出错了：${(e as Error).message}` }] })))}>
              <Icon name="sparkle" size={15} />{result ? '重新生成' : '生成场景'}
            </button>
            <span className="se-spacer" />
            <button className="se-send" disabled={!draft.trim() || busy || running} onClick={() => void send()}><Icon name="arrowUp" size={18} /></button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.role === 'tool') return <details className={`se-msg tool${item.isError ? ' err' : ''}`}><summary>{item.name}</summary><pre>{item.text}</pre></details>;
  return <div className={`se-msg ${item.role}`}>{item.text}</div>;
}

// ── 场景重建 ───────────────────────────────────────────────────────────────

type ReconResult = {
  mode?: 'generate'; views: number; credits: number; seconds: Record<string, number>; files?: Record<string, string>;
  anchor?: { index: number; frames: number }; verify?: { points: number; within25: number };
  pathViews?: Array<{ index: number; file: string; image: string | null; position: number[] }>;
};

function ReconEditor({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const r = project.result as ReconResult | null | undefined;
  const job = project.job;
  const running = job?.status === 'running';
  const stamp = job?.endedAt ?? 0;
  const [err, setErr] = useState<string | null>(null);
  const rerun = async () => {
    setErr(null);
    try { await sg.videoRun(project.id, { reusePoses: true }); await reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="se-body">
      <section className="se-stage">
        <div className="se-view">
          {r && !running ? <SplatViewer url={file(project.id, 'out/scene.spz', stamp)} />
            : project.video ? <video className="se-video" src={file(project.id, project.video.file)} muted controls />
            : <div className="se-empty"><Icon name="video" size={34} /><p>先在画布节点上传一段视频。</p></div>}
          <Progress project={project} />
          {job?.status === 'failed' && <div className="se-failed">重建失败：{job.error}</div>}
        </div>
      </section>
      <aside className="se-chat se-panel">
        <header><Icon name="camera" size={16} />重建</header>
        <div className="se-log">
          {r?.mode === 'generate' && <>
            <table className="se-table"><tbody>
              <tr><td>锚点</td><td>第 {r.anchor?.index} 帧，附近 {r.anchor?.frames} 帧拼接</td></tr>
              <tr><td>JST-2</td><td>{r.views} 个视角 · {r.credits} 额度</td></tr>
              {r.verify && <tr><td>与视频一致</td><td>COLMAP 点 {Math.round(r.verify.within25 * 100)}% 在 ±25% 内</td></tr>}
              <tr><td>耗时</td><td>{Math.round(Object.values(r.seconds ?? {}).reduce((a, b) => a + b, 0))} 秒</td></tr>
            </tbody></table>
            {r.files && <><h4>锚点全景：视频帧拼接 → 补全</h4>
              <img className="se-wide" src={file(project.id, `out/${r.files.stitched}`, stamp)} alt="" />
              <img className="se-wide" src={file(project.id, `out/${r.files.panorama}`, stamp)} alt="" /></>}
            {!!r.pathViews?.length && <><h4>真实帧 | 同一相机生成的视角</h4>
              {r.pathViews.map((v) => <figure key={v.index} className="se-pair">
                <img src={file(project.id, `out/bundle/${v.file}`)} alt="" />
                {v.image && <img src={file(project.id, `out/${v.image}`, stamp)} alt="" />}
                <figcaption>第 {v.index} 帧 · 离锚点 {Math.hypot(v.position[0]!, v.position[2]!).toFixed(1)} m</figcaption>
              </figure>)}</>}
          </>}
          {r && r.mode !== 'generate' && <p className="se-muted">posed-images（模拟接口）的结果：COLMAP 稀疏点云预览。</p>}
          {job && <details className="se-joblog"><summary>日志</summary><pre>{job.log.join('\n')}</pre></details>}
          {err && <p className="se-err">{err}</p>}
        </div>
        <div className="se-composer">
          <div className="se-row">
            <button className="se-btn" disabled={running || !project.video} onClick={() => void rerun()}><Icon name="loop" size={15} />{r ? '重新重建（复用位姿）' : '开始重建'}</button>
          </div>
        </div>
      </aside>
    </div>
  );
}
