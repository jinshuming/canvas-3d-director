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
import type { ViewerPose } from '../../scenegen/web/SplatViewer.tsx';
import { Viewport } from '../../scenegen/web/Viewport.tsx';
import { AgentPanel } from '../agent/AgentPanel.tsx';
import type { ChatItem as PanelItem, TurnStats } from '../agent/useAgent.ts';
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
  candidates?: Array<{ file: string; objects: number | null; shell: number | null; people: { prominent: boolean; note?: string } | null }>; chosen?: number;
  expands?: Array<{ image: string | null; credits: number; pose: { position: number[]; yaw: number } }>;
  files: Record<string, string | null>; capture: { yaw: number }; credits: number; seconds: Record<string, number>;
  alignment: { within25: number; objectsWithin25: number };
  objects?: Array<{ id: string; label: string; file: string | null; crop: string; spread: number | null; error: string | null }>;
};

/** How the scene agent's tools, the fast blockout and the generation's stages read in the log. */
const SCENE_TOOL_LABEL: Record<string, string> = {
  quick_layout: '快速摆白模', get_layout: '查看白模', set_room: '设置房间', set_outdoor: '设为室外', add_opening: '添加门窗',
  place_objects: '摆放物体', update_object: '调整物体', remove_objects: '移除物体', check_layout: '检查白模', set_style: '设置风格',
  look: '观察白模', choose_capture_point: '选择拍摄点', set_capture_point: '设置拍摄点', generate_scene: '生成场景',
  start: '开始生成', conditions: '渲染白模条件图', pano: '生成全景图', scale: '测量尺度', scene: 'JST-2 建环境', fill: '检测并补缺口',
  objects: 'SAM 3D 生成物体', compose: '合成', verify: '校验', done: '完成',
};

let seq = 0;
const nid = () => `i${++seq}`;

/** The stored chat (scenegen's format) as the panel's lines. */
function chatToPanel(items: ChatItem[]): PanelItem[] {
  return items.map((it): PanelItem => (it.role === 'tool'
    ? { kind: 'tool', id: nid(), name: it.name, args: JSON.stringify(it.args), status: it.isError ? 'error' : 'done', result: it.text, image: it.image }
    : it.role === 'user' ? { kind: 'user', id: nid(), text: it.text } : { kind: 'assistant', id: nid(), text: it.text }));
}

/** A project laid out on the canvas has no chat: its prompt and its blockout, as the log's start. */
function canvasHistory(project: Project): PanelItem[] {
  const l = project.layout;
  if (!l.objects.length) return [];
  const out: PanelItem[] = [];
  if (l.prompt) out.push({ kind: 'user', id: nid(), text: l.prompt });
  out.push({ kind: 'tool', id: nid(), name: 'quick_layout', args: JSON.stringify({ title: l.title, objects: l.objects.length }), status: 'done',
    result: `${l.room ? `室内 ${l.room.width}×${l.room.depth}×${l.room.height} m` : '室外'}\n${l.objects.map((o) => `${o.key ? '★ ' : ''}${o.id}: ${o.label}`).join('\n')}\n风格：${l.style.summary}` });
  return out;
}

type LoggedJob = { kind: string; log: string[]; status: string; error?: string };

/** One job's steps from its log, and how it ended: a generation's summary, an expansion's, or the error. */
function oneJob(job: LoggedJob, project: Project, latest: boolean): PanelItem[] {
  const out: PanelItem[] = job.log.map((line, i): PanelItem => {
    const m = /^\[(\d+)s\] (\w+): (.*)$/.exec(line);
    const stage = m?.[2] ?? 'start';
    const last = i === job.log.length - 1;
    return { kind: 'tool', id: nid(), name: stage, args: JSON.stringify({ message: m?.[3] ?? line }), status: latest && last && job.status === 'running' ? 'running' : 'done', result: `${m ? `${m[1]} 秒 · ` : ''}${m?.[3] ?? line}` };
  });
  const expand = job.log.some((l) => / expand: /.test(l));
  const r = project.result as GenResult | null | undefined;
  if (job.status === 'done' && expand) out.push({ kind: 'assistant', id: nid(), text: `已从你选的视角扩展场景：${job.log.find((l) => / done: /.test(l))?.replace(/^\[\d+s\] done: /, '') ?? '完成'}。` });
  else if (job.status === 'done' && r && latest) {
    const objs = (r.objects ?? []).filter((o) => o.file);
    out.push({ kind: 'assistant', id: nid(), text: `场景生成好了：与白模 **${Math.round((r.alignment?.within25 ?? 0) * 100)}%** 一致，${objs.length ? `${objs.length} 个关键物体由 SAM 3D 单独生成（${objs.map((o) => o.label).join('、')}），` : ''}用了 ${r.credits} 额度。可以在左边看 3D 场景；走到有缺口的地方点右下角 Expand 补全；或继续说要改什么。` });
  } else if (job.status === 'done') out.push({ kind: 'assistant', id: nid(), text: '场景生成好了。' });
  if (job.status === 'failed') out.push({ kind: 'error', id: nid(), text: `${expand ? '扩展' : '生成'}失败：${job.error ?? job.log[job.log.length - 1] ?? '未知错误'}` });
  return out;
}

/** Every run on this project that left a log - earlier ones kept in the result - then the latest. */
function jobToPanel(project: Project): PanelItem[] {
  const job = project.job;
  if (!job || job.kind !== 'text') return [];
  const past = ((project.result as { pastJobs?: LoggedJob[] } | null | undefined)?.pastJobs ?? []).filter((j) => j.kind === 'text');
  return [...past.flatMap((j) => oneJob(j, project, false)), ...oneJob(job, project, true)];
}

function GenEditor({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [layout, setLayout] = useState<Layout>(project.layout);
  const [chat, setChat] = useState<ChatState>(() => (project.chat[0] as ChatState | undefined) ?? { items: [], previousId: null });
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [lastTurn, setLastTurn] = useState<TurnStats | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [start, setStart] = useState<ViewerPose | null>(null);
  const result = project.result as GenResult | null | undefined;
  const job = project.job;
  const running = job?.status === 'running';
  const [view, setView] = useState<'scene' | 'blockout' | 'pano' | 'refs'>(result?.files?.scene && !running ? 'scene' : 'blockout');
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => { void sg.config().then((c) => setModel(c.agent?.model ?? null)).catch(() => {}); }, []);
  // The layout the server has (the canvas may have laid it out), unless a turn is changing it here.
  useEffect(() => { if (!busy) setLayout(project.layout); }, [project.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // A run that finishes shows its scene.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && result?.files?.scene) setView('scene');
    wasRunning.current = running;
  }, [running, result?.files?.scene]);

  const persist = async (l: Layout, c: ChatState) => {
    // Pictures stay out of the stored chat: they are big and the model already has them.
    const stored = [{ ...c, items: c.items.map((it) => ('image' in it && it.image ? { ...it, image: undefined } : it)) }];
    await sg.put(project.id, { layout: l, title: l.title, chat: stored });
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy || running) return;
    setBusy(true); setStream('');
    const t0 = Date.now();
    let state = chat;
    const emit = (it: ChatItem) => { state = { ...state, items: [...state.items, it] }; setChat(state); if (it.role !== 'user') setStream(''); };
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      if (!layoutRef.current.objects.length) {
        // Nothing laid out yet: the fast path - one structured call, deterministic placement.
        emit({ role: 'user', text });
        const q = await sg.quickLayout(project.id, { text });
        setLayout(q.layout); layoutRef.current = q.layout;
        setView('blockout');
        emit({ role: 'tool', name: 'quick_layout', args: { text }, text: `${q.layout.room ? `室内 ${q.layout.room.width}×${q.layout.room.depth}×${q.layout.room.height} m` : '室外'}，${q.layout.objects.length} 个物体（模型 ${q.seconds.model.toFixed(1)} 秒 + 摆放 ${q.seconds.place.toFixed(1)} 秒）\n${q.layout.objects.map((o) => `${o.key ? '★ ' : ''}${o.id}: ${o.label}`).join('\n')}` });
        emit({ role: 'assistant', text: `白模摆好了：${q.layout.objects.length} 个物体，关键物体 ${q.keys.join('、') || '无'}。可以点「生成场景」，或继续说要改什么。` });
        setLastTurn({ steps: 1, toolCalls: 1, toolErrors: 0, tools: ['quick_layout'], ms: Date.now() - t0, inputTokens: 0, outputTokens: 0 });
      } else {
        const work = structuredClone(layoutRef.current);
        const host = projectHost(project.id, work, {
          toDataUrl, onChanged: () => setLayout(structuredClone(work)),
          generateBody: () => ({ objects: true }), onJob: () => void reload(),
        });
        setView('blockout');
        const out = await runAgentTurn(text, host, { respond: sg.respondAgent, previousId: state.previousId, emit, signal: ctl.signal, onText: (d) => setStream((s) => s + d) });
        state = { ...state, previousId: out.previousId };
        setChat(state);
        setLastTurn({ ...out.stats, ms: Date.now() - t0 });
        setLayout(structuredClone(work)); layoutRef.current = work;
      }
    } catch (e) {
      if (!ctl.signal.aborted) emit({ role: 'assistant', text: `出错了：${(e as Error).message}` });
    } finally {
      abort.current = null;
      setStream('');
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
  const reset = () => { const c = { items: [], previousId: null }; setChat(c); setLastTurn(null); void persist(layoutRef.current, c); };

  // The whole log: the conversation (or, for a canvas run, its prompt and blockout), then the latest
  // generation's stages - right after the agent's generate_scene call when it started one.
  const panel = (() => {
    seq = 0;
    const talk = chat.items.length ? chatToPanel(chat.items) : canvasHistory(project);
    const gen = jobToPanel(project);
    const at = chat.items.map((it) => (it.role === 'tool' ? it.name : '')).lastIndexOf('generate_scene');
    const items = at >= 0 ? [...talk.slice(0, at + 1), ...gen, ...talk.slice(at + 1)] : [...talk, ...gen];
    if (busy && stream) items.push({ kind: 'assistant', id: 'stream', text: stream, streaming: true });
    return items;
  })();

  const stamp = job?.endedAt ?? 0;
  const objects = (result?.objects ?? []).filter((o) => o.file);
  return (
    <div className="se-body">
      <section className="se-stage">
        <div className="se-tabs">
          {result?.files?.scene && <button className={view === 'scene' ? 'on' : ''} onClick={() => setView('scene')}>3D 场景</button>}
          <button className={view === 'blockout' ? 'on' : ''} onClick={() => setView('blockout')}>白模</button>
          {result?.files?.panorama && <button className={view === 'pano' ? 'on' : ''} onClick={() => setView('pano')}>全景图</button>}
          {result?.files?.panorama && <button className={view === 'refs' ? 'on' : ''} onClick={() => setView('refs')}>参考图</button>}
          <span className="se-spacer" />
          <span className="se-muted">{layout.room ? `室内 ${layout.room.width}×${layout.room.depth}×${layout.room.height} m` : layout.objects.length ? '室外' : ''}{layout.objects.length ? ` · ${layout.objects.length} 个物体` : ''}</span>
        </div>
        <div className="se-view">
          {view === 'scene' && result?.files?.scene
            ? <SplatViewer url={file(project.id, `out/${objects.length && result.files.environment ? result.files.environment : result.files.scene}`, stamp)}
                objects={result.files.environment ? objects.map((o) => ({ id: o.id, label: o.label, url: file(project.id, `out/${o.file}`, stamp) })) : []} yaw={result.capture?.yaw ?? 0}
                start={start} expanding={running} expandHint="从当前相机位置生成这个视角并重建环境（约 10 额度）"
                onExpand={(pose) => { setStart(pose); void sg.expand(project.id, pose).then(() => reload()).catch((e) => setChat((c) => ({ ...c, items: [...c.items, { role: 'assistant', text: `扩展失败：${(e as Error).message}` }] }))); }} />
            : view === 'pano' && result?.files?.panorama ? <img className="se-pano" src={file(project.id, `out/${result.files.panorama}`, stamp)} alt="" />
            : view === 'refs' && result ? <RefGallery project={project} result={result} stamp={stamp} />
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
          {(result.objects ?? []).map((o) => <img key={o.id} className={`se-thumb${o.file ? '' : ' failed'}`} src={file(project.id, `out/${o.crop}`, stamp)} title={o.error ? `${o.label}：${o.error}` : o.label} alt="" />)}
          {(result.objects ?? []).some((o) => !o.file) && <button className="se-btn" onClick={() => void sg.retryObjects(project.id).then(() => reload())}>
            <Icon name="loop" size={14} />重试失败的物体（{(result.objects ?? []).filter((o) => !o.file).length}）</button>}
        </div>}
      </section>

      <AgentPanel items={panel} busy={busy || running} model={model} lastTurn={busy ? null : lastTurn}
        onSend={(t) => void send(t)} onStop={() => abort.current?.abort()} onReset={reset} onAnswer={() => {}}
        toolLabels={SCENE_TOOL_LABEL} workingLabel={running ? '正在生成场景…' : '正在摆白模…'}
        placeholder={layout.objects.length ? '说说要改什么…' : '描述想要的场景…'}
        hello={<>
          <h2>场景 Agent</h2>
          <h1>想要一个什么样的场景？</h1>
          <p className="ag-lead">用一句话描述，例如「一间温暖的日式茶室，矮桌、坐垫、纸拉门，傍晚的光」。第一句几秒内摆成白模；之后可以继续说要改什么，再生成。每一步思考和操作都会记录在这里。</p>
        </>}
        actions={<button className="cv-ghost se-gen" disabled={!layout.objects.length || busy || running} title={result ? '重新生成' : '生成场景'}
          onClick={() => void generate().catch((e) => setChat((c) => ({ ...c, items: [...c.items, { role: 'assistant', text: `出错了：${(e as Error).message}` }] })))}>
          <Icon name="sparkle" size={16} />{result ? '重新生成' : '生成场景'}</button>} />
    </div>
  );
}

/**
 * Every picture the generation made or worked from, in the order it used them: what the panorama
 * was painted from (depth map + clay render of the environment's blockout), what it was scored with
 * (the semantic map), the candidates and the one kept, then per SAM 3D object its crop of the
 * environment, the blockout guide for that view and the object painted in - and the prompt.
 * A file a scene does not have (an older pipeline) is left out.
 */
function RefGallery({ project, result, stamp }: { project: Project; result: GenResult; stamp: number }) {
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => { void fetch(file(project.id, 'out/prompt.txt', stamp)).then((r) => (r.ok ? r.text() : null)).then(setPrompt).catch(() => {}); }, [project.id, stamp]);
  const src = (f: string) => file(project.id, `out/${f}`, stamp);
  const fig = (f: string, caption: string, note?: string, opts: { wide?: boolean; on?: boolean } = {}) => (
    <figure key={f} className={`se-ref${opts.wide ? ' wide' : ''}${opts.on ? ' on' : ''}`} onClick={() => setZoom({ src: src(f), caption })}>
      <img src={src(f)} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
      <figcaption><b>{caption}</b>{note && <span>{note}</span>}</figcaption>
    </figure>
  );
  const objs = result.objects ?? [];
  return (
    <div className="se-refs">
      <section>
        <h4>① 发给 GPT-image-2 的参考图 <span>环境白模（不含 SAM 3D 物体），从拍摄点渲染，像素对齐</span></h4>
        <div className="se-ref-row">
          {fig('depth.png', '等距深度图', '越亮越近：管空间和距离', { wide: true })}
          {fig('shaded.png', '白模渲染图', '每个物体一种颜色：管轮廓和位置', { wide: true })}
        </div>
      </section>
      <section>
        <h4>② 不发给出图模型 <span>打分用 / 画物体时的位置参考</span></h4>
        <div className="se-ref-row">
          {fig('semantic.png', '语义分割图', '给候选打分：全景图的边缘与它的边缘重合多少', { wide: true })}
          {fig('blockout-full/shaded.png', '完整白模渲染图', '含 SAM 3D 物体：画物体时的位置参考', { wide: true })}
        </div>
      </section>
      {!!result.candidates?.length && <section>
        <h4>③ 全景图候选 <span>先画 1 张：对齐分 ≥ 0.8 且没有人物就用；不够再画 2 张，选没有人物、对齐分最高的一张</span></h4>
        <div className="se-ref-row">
          {result.candidates.map((c, i) => fig(c.file, `候选 ${i + 1}${i === result.chosen ? ' · 选中' : ''}`, `对齐分 ${c.objects?.toFixed(2) ?? '—'}${c.people?.prominent ? ' · 有人物' : ''}`, { wide: true, on: i === result.chosen }))}
        </div>
      </section>}
      <section>
        <h4>④ 最终全景图 <span>交给 JST-2 建环境</span></h4>
        <div className="se-ref-row">{fig(result.files.panorama ?? 'panorama.png', '环境全景图', undefined, { wide: true })}</div>
      </section>
      {!!objs.length && <section>
        <h4>⑤ SAM 3D 物体 <span>环境裁图 → 白模参考 → 画入物体（送 SAM 3D 的图）</span></h4>
        {objs.map((o) => <div key={o.id} className="se-ref-row objs">
          {fig(`objects/${o.id}-env.jpg`, o.label, '环境全景图的裁图')}
          {fig(`objects/${o.id}-guide.jpg`, '白模参考', '同视角的完整白模')}
          {fig(o.crop, o.file ? '画入物体' : '画入物体 · 生成失败', o.spread ? `形状偏差 ${o.spread.toFixed(2)}` : o.error ?? '')}
        </div>)}
      </section>}
      {!!result.expands?.length && <section>
        <h4>⑥ Expand 生成的视角 <span>在你放的相机位置生成，再重建环境</span></h4>
        <div className="se-ref-row">
          {result.expands.filter((e) => e.image).map((e, i) => fig(e.image!, `Expand ${i + 1}`, `(${e.pose.position.map((v) => v.toFixed(1)).join(', ')}) m · 朝向 ${Math.round(e.pose.yaw)}° · ${e.credits} 额度`))}
        </div>
      </section>}
      {prompt && <section>
        <h4>⑦ 全景图提示词</h4>
        <pre className="se-prompt">{prompt}</pre>
      </section>}
      {zoom && <div className="se-zoom" onClick={() => setZoom(null)}><img src={zoom.src} alt="" /><span>{zoom.caption}</span></div>}
    </div>
  );
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
  const [start, setStart] = useState<ViewerPose | null>(null);
  const rerun = async () => {
    setErr(null);
    try { await sg.videoRun(project.id, { reusePoses: true }); await reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="se-body">
      <section className="se-stage">
        <div className="se-view">
          {r && (!running || start) ? <SplatViewer url={file(project.id, 'out/scene.spz', stamp)} start={start} expanding={running}
              onExpand={r.mode === 'generate' ? (pose) => { setStart(pose); setErr(null); void sg.expand(project.id, pose).then(() => reload()).catch((e) => setErr((e as Error).message)); } : undefined} />
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
