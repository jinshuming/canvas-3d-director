/**
 * 场景生成 in the scene editor: the 3D view (the generated scene with its layers - environment and
 * each SAM 3D object - or the blockout while there is no scene yet) beside the scene agent. The
 * first message lays out the blockout fast, later ones edit it, and 生成场景 runs the pipeline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatItem } from '../../scenegen/agent/loop.ts';
import { runAgentTurn } from '../../scenegen/agent/loop.ts';
import type { Layout } from '../../scenegen/core/types.ts';
import { projectHost } from '../../scenegen/web/agentHost.ts';
import { api as sg, file, toDataUrl } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import { SplatViewer } from '../../scenegen/web/SplatViewer.tsx';
import type { ViewerPose } from '../../scenegen/web/SplatViewer.tsx';
import { Viewport } from '../../scenegen/web/Viewport.tsx';
import { AgentPanel } from '../agent/AgentPanel.tsx';
import type { TurnStats } from '../agent/useAgent.ts';
import { Icon } from '../icons.tsx';
import { JobStatus } from './JobStatus.tsx';
import { LightButton, LightPanel, roomBox, useLighting } from './LightPanel.tsx';
import { RefGallery } from './RefGallery.tsx';
import { objectLines, roomText, SCENE_TOOL_LABEL, sceneLog } from './sceneLog.ts';
import type { GenResult } from './sceneResults.ts';
import { totalSeconds } from './sceneResults.ts';

interface ChatState { items: ChatItem[]; previousId: string | null }
type View = 'scene' | 'blockout' | 'pano' | 'refs';

export function GenEditor({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [layout, setLayout] = useState<Layout>(project.layout);
  const [chat, setChat] = useState<ChatState>(() => (project.chat[0] as ChatState | undefined) ?? { items: [], previousId: null });
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [lastTurn, setLastTurn] = useState<TurnStats | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [start, setStart] = useState<ViewerPose | null>(null);
  const light = useLighting(project);
  const result = project.result as GenResult | null | undefined;
  const files = result?.files;
  const job = project.job;
  const running = job?.status === 'running';
  const [view, setView] = useState<View>(files?.scene && !running ? 'scene' : 'blockout');
  // The room the light re-colours: rebuilt only when the layout changes, so the relight is not redone every render.
  const box = useMemo(() => roomBox(layout), [layout]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => { void sg.config().then((c) => setModel(c.agent?.model ?? null)).catch(() => {}); }, []);
  // The layout the server has (the canvas may have laid it out), unless a turn is changing it here.
  useEffect(() => { if (!busy) setLayout(project.layout); }, [project.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // A run that finishes shows its scene.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && files?.scene) setView('scene');
    wasRunning.current = running;
  }, [running, files?.scene]);

  const say = (text: string) => setChat((c) => ({ ...c, items: [...c.items, { role: 'assistant', text }] }));

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
        emit({ role: 'tool', name: 'quick_layout', args: { text }, text: `${roomText(q.layout)}，${q.layout.objects.length} 个物体（模型 ${q.seconds.model.toFixed(1)} 秒 + 摆放 ${q.seconds.place.toFixed(1)} 秒）\n${objectLines(q.layout)}` });
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

  const log = sceneLog(project, chat.items);
  if (busy && stream) log.push({ kind: 'assistant', id: 'stream', text: stream, streaming: true });

  const stamp = job?.endedAt ?? 0;
  const outFile = (name: string) => file(project.id, `out/${name}`, stamp);
  const objects = (result?.objects ?? []).filter((o) => o.file);
  const failedObjects = (result?.objects ?? []).filter((o) => !o.file).length;
  const tab = (v: View, label: string) => <button className={view === v ? 'on' : ''} onClick={() => setView(v)}>{label}</button>;
  return (
    <div className="se-body">
      <section className="se-stage">
        <div className="se-tabs">
          {files?.scene && tab('scene', '3D 场景')}
          {tab('blockout', '白模')}
          {files?.panorama && tab('pano', '全景图')}
          {files?.panorama && tab('refs', '参考图')}
          {files?.scene && <LightButton light={light} onClick={() => { setView('scene'); light.setOpen((o) => !o); }} />}
          <span className="se-spacer" />
          <span className="se-muted">{layout.room || layout.objects.length ? roomText(layout) : ''}{layout.objects.length ? ` · ${layout.objects.length} 个物体` : ''}</span>
        </div>
        <div className="se-view">
          {view === 'scene' && files?.scene
            // With SAM 3D objects the environment and each object load as layers; otherwise the composed scene.
            ? <SplatViewer url={outFile(objects.length && files.environment ? files.environment : files.scene)}
                objects={files.environment ? objects.map((o) => ({ id: o.id, label: o.label, url: outFile(o.file!) })) : []} yaw={result!.capture?.yaw ?? 0}
                start={start} expanding={running} expandHint="从当前相机位置生成这个视角并重建环境（约 10 额度）"
                lighting={light.lighting} relightBox={box}
                onExpand={(pose) => { setStart(pose); void sg.expand(project.id, pose).then(() => reload()).catch((e) => say(`扩展失败：${(e as Error).message}`)); }} />
            : view === 'pano' && files?.panorama ? <img className="se-pano" src={outFile(files.panorama)} alt="" />
            : view === 'refs' && result ? <RefGallery project={project} result={result} stamp={stamp} />
            : layout.objects.length ? <Viewport layout={layout} capture={layout.capture} selected={selected} onSelect={setSelected} background="#17181b" />
            : <div className="se-empty"><Icon name="scene" size={34} /><p>在右侧描述你想要的场景，几秒内摆成白模。</p></div>}
          <JobStatus project={project} failedLabel="生成" />
          {light.open && view === 'scene' && <LightPanel light={light} />}
        </div>
        {result && !running && <div className="se-strip">
          <span>与白模一致 <b>{Math.round((result.alignment?.within25 ?? 0) * 100)}%</b></span>
          <span>SAM 3D 物体 <b>{objects.length}</b></span>
          <span>额度 <b>{result.credits}</b></span>
          <span>耗时 <b>{totalSeconds(result.seconds)} 秒</b></span>
          {(result.objects ?? []).map((o) => <img key={o.id} className={`se-thumb${o.file ? '' : ' failed'}`} src={outFile(o.crop)} title={o.error ? `${o.label}：${o.error}` : o.label} alt="" />)}
          {failedObjects > 0 && <button className="se-btn" onClick={() => void sg.retryObjects(project.id).then(() => reload())}>
            <Icon name="loop" size={14} />重试失败的物体（{failedObjects}）</button>}
        </div>}
      </section>

      <AgentPanel items={log} busy={busy || running} model={model} lastTurn={busy ? null : lastTurn}
        onSend={(t) => void send(t)} onStop={() => abort.current?.abort()} onReset={reset} onAnswer={() => {}}
        toolLabels={SCENE_TOOL_LABEL} workingLabel={running ? '正在生成场景…' : '正在摆白模…'}
        placeholder={layout.objects.length ? '说说要改什么…' : '描述想要的场景…'}
        hello={<>
          <h2>场景 Agent</h2>
          <h1>想要一个什么样的场景？</h1>
          <p className="ag-lead">用一句话描述，例如「一间温暖的日式茶室，矮桌、坐垫、纸拉门，傍晚的光」。第一句几秒内摆成白模；之后可以继续说要改什么，再生成。每一步思考和操作都会记录在这里。</p>
        </>}
        actions={<button className="cv-ghost se-gen" disabled={!layout.objects.length || busy || running} title={result ? '重新生成' : '生成场景'}
          onClick={() => void generate().catch((e) => say(`出错了：${(e as Error).message}`))}>
          <Icon name="sparkle" size={16} />{result ? '重新生成' : '生成场景'}</button>} />
    </div>
  );
}
