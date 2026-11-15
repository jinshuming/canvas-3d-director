/** Text / picture → blockout → panorama → JST-2 scene → gap fill. */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatItem } from '../agent/loop.ts';
import { runAgentTurn } from '../agent/loop.ts';
import type { AgentHost } from '../agent/tools.ts';
import { livingRoom, townSquare } from '../core/fixtures.ts';
import { checkLayout } from '../core/layout.ts';
import type { Layout } from '../core/types.ts';
import { api, file, toDataUrl } from './api.ts';
import type { Conditions, Config, Job, Project } from './api.ts';
import { SplatViewer } from './SplatViewer.tsx';
import { Viewport } from './Viewport.tsx';

interface ChatState { items: ChatItem[]; previousId: string | null }

const STAGES: Record<string, string> = { conditions: '渲染白模', pano: '生成全景图', scale: '测量尺度', scene: 'JST-2 建场景', fill: '检测并补缺口', verify: '校验', done: '完成', start: '开始' };

export function TextProject({ project, config, onChanged }: { project: Project; config: Config; onChanged: () => void }) {
  const [layout, setLayout] = useState<Layout>(project.layout);
  const [chat, setChat] = useState<ChatState>(() => (project.chat[0] as ChatState | undefined) ?? { items: [], previousId: null });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [picture, setPicture] = useState<{ blob: Blob; url: string; video?: boolean } | null>(null);
  const [cond, setCond] = useState<Conditions | null>(null);
  const [tab, setTab] = useState<'shaded' | 'depth' | 'semantic' | 'pano' | 'scene'>(project.result ? 'scene' : 'shaded');
  const [selected, setSelected] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(project.job ?? null);
  const [result, setResult] = useState(project.result ?? null);
  const [provider, setProvider] = useState(config.defaultProvider);
  const [fills, setFills] = useState<number | 'auto'>('auto');
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(project.exported ?? null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const saveTimer = useRef<number>(0);

  const persist = useCallback((l: Layout, c?: ChatState) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // Pictures stay out of the stored chat: they are big and the model already has them.
      const stored = c ? [{ ...c, items: c.items.map((it) => ('image' in it && it.image ? { ...it, image: undefined } : it)) }] : undefined;
      void api.put(project.id, { layout: l, title: l.title, ...(stored ? { chat: stored } : {}) }).then(() => { onChanged(); void refreshRef.current(); });
    }, 400);
  }, [project.id, onChanged]);

  const refreshConditions = useCallback(async () => {
    if (!layoutRef.current.objects.length) { setCond(null); return; }
    try { setCond(await api.conditions(project.id)); } catch (e) { setError((e as Error).message); }
  }, [project.id]);

  // Poll the job while it runs.
  useEffect(() => {
    if (job?.status !== 'running') return;
    const t = window.setInterval(async () => {
      const p = await api.get(project.id);
      setJob(p.job ?? null);
      if (p.job?.status !== 'running') { setResult(p.result ?? null); setExported(p.exported ?? null); setTab('scene'); onChanged(); }
    }, 1500);
    return () => window.clearInterval(t);
  }, [job?.status, project.id, onChanged]);

  const refreshRef = useRef(refreshConditions);
  refreshRef.current = refreshConditions;
  useEffect(() => { void refreshConditions(); }, [refreshConditions]);

  const update = (l: Layout) => { const copy = structuredClone(l); setLayout(copy); persist(copy); };

  async function generate(): Promise<Job> {
    setError(null);
    await api.put(project.id, { layout: layoutRef.current, title: layoutRef.current.title });
    const j = await api.generate(project.id, { provider, maxFills: fills });
    setJob(j);
    return j;
  }

  async function send() {
    if (busy || (!draft.trim() && !picture)) return;
    setBusy(true); setError(null);
    const text = draft.trim();
    setDraft('');
    const pics: string[] = [];
    if (picture?.video) {
      // A walkthrough video: keyframes for the agent to read the place from (the middle one becomes the style reference).
      const k = await api.layoutVideo(project.id, picture.blob).catch((e) => { setError((e as Error).message); return null; });
      for (const f of k?.frames ?? []) pics.push(await toDataUrl(f.url, 768));
      setPicture(null);
    } else if (picture) {
      await api.reference(project.id, picture.blob).catch(() => null);
      pics.push(await toDataUrl(picture.blob, 1280));
      setPicture(null);
    }
    let state: ChatState = chat;
    const emit = (it: ChatItem) => { state = { ...state, items: [...state.items, it] }; setChat(state); };
    const work = structuredClone(layoutRef.current);
    const host: AgentHost = {
      layout: work,
      changed: () => { setLayout(structuredClone(work)); },
      look: async () => {
        await api.put(project.id, { layout: work });
        const c = await api.conditions(project.id);
        setCond(c);
        if (!work.capture) work.capture = c.capture;
        return { image: await toDataUrl(c.files.shaded, 1024), prompt: c.prompt };
      },
      findCapture: async () => { await api.put(project.id, { layout: work }); return api.capture(project.id); },
      generate: async (p) => {
        if (p) setProvider(p);
        await api.put(project.id, { layout: work, title: work.title });
        const j = await api.generate(project.id, { provider: p ?? provider, maxFills: fills });
        setJob(j);
        return { jobId: j.id };
      },
    };
    try {
      const out = await runAgentTurn(text, host, {
        respond: (body, signal) => fetch('/scenegen/api/agent/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }),
        previousId: chat.previousId, emit, images: pics,
      });
      state = { ...state, previousId: out.previousId };
      setChat(state);
    } catch (e) {
      setError((e as Error).message);
      emit({ role: 'assistant', text: `出错了：${(e as Error).message}` });
    } finally {
      setLayout(structuredClone(work));
      persist(work, state);
      setBusy(false);
      void refreshConditions();
    }
  }

  const issues = checkLayout(layout);
  const r = result as null | { files: Record<string, string>; alignment: { floorY: number | null; within25: number; objectsWithin25: number; medianLogError: number }; metersPerUnit: number; credits: number; provider: string; seconds: Record<string, number>; prompt: string; candidates?: Array<{ file: string; objects: number | null; people: { prominent: boolean } | null }>; chosen?: number; fill: null | { rounds: Array<{ holeBefore: number; holeAfter: number | null; pose: { position: number[]; yaw: number } }>; before: { worstHole: number }; after: { worstHole: number } } };
  const stamp = job?.endedAt ?? 0;

  return (
    <div className="text-project">
      <section className="chat">
        <div className="chat-log">
          {!chat.items.length && <div className="hint">
            <p>用一句话描述场景，或上传一张图片 / 一段视频，agent 会用白模资产把它摆出来，然后从合适的位置生成全景图，再交给 JST-2 建出 3D 场景。</p>
            <p>也可以先载入示例布局：</p>
            <div className="row"><button onClick={() => update(livingRoom())}>示例：北欧客厅</button><button onClick={() => update(townSquare())}>示例：小镇广场</button></div>
            {!config.agent && <p className="warn">服务端没有配置 OPENAI_API_KEY，agent 不可用。</p>}
          </div>}
          {chat.items.map((it, i) => <ChatRow key={i} item={it} />)}
          {busy && <div className="msg assistant pending">思考中…</div>}
        </div>
        <div className="composer">
          {picture && <div className="attached">{picture.video ? <video src={picture.url} muted /> : <img src={picture.url} alt="" />}<button onClick={() => setPicture(null)}>×</button></div>}
          <textarea value={draft} placeholder="例如：一间温暖的日式茶室，榻榻米、矮桌、纸拉门，傍晚的光" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} disabled={busy} />
          <div className="row">
            <label className="file-btn">图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) setPicture({ blob: f, url: URL.createObjectURL(f) }); e.target.value = ''; }} /></label>
            <label className="file-btn">视频<input type="file" accept="video/mp4,video/quicktime" onChange={(e) => { const f = e.target.files?.[0]; if (f) setPicture({ blob: f, url: URL.createObjectURL(f), video: true }); e.target.value = ''; }} /></label>
            <span className="grow" />
            <button className="primary" onClick={() => void send()} disabled={busy || (!draft.trim() && !picture) || !config.agent}>发送</button>
          </div>
        </div>
      </section>

      <section className="stage">
        <div className="stage-head">
          <input className="title" value={layout.title} onChange={(e) => update({ ...layout, title: e.target.value })} />
          <span className="muted">{layout.room ? `室内 ${layout.room.width}×${layout.room.depth}×${layout.room.height} m` : '室外'} · {layout.objects.length} 个物体</span>
        </div>
        <Viewport layout={layout} capture={cond?.capture ?? layout.capture} selected={selected} onSelect={setSelected} />
        <div className="tabs">
          {(['shaded', 'depth', 'semantic', 'pano', 'scene'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} disabled={t === 'pano' || t === 'scene' ? !r : !cond}>{{ shaded: '白模全景', depth: '等距深度图', semantic: '语义图', pano: '生成的全景图', scene: '3D 场景' }[t]}</button>)}
          <span className="grow" />
          <button onClick={() => void refreshConditions()} disabled={!layout.objects.length}>重新渲染</button>
        </div>
        <div className={`pano${tab === 'scene' ? ' tall' : ''}`}>
          {tab === 'scene' && r ? <SplatViewer url={file(project.id, `out/${r.files.scene}`, stamp)} yaw={(r as unknown as { capture: { yaw: number } }).capture.yaw} /> : tab === 'pano' && r ? <img src={file(project.id, `out/${r.files.panorama}`, stamp)} alt="" /> : cond ? <img src={cond.files[tab === 'pano' || tab === 'scene' ? 'shaded' : tab]} alt="" /> : <div className="empty">摆好白模后在这里看到全景条件图</div>}
        </div>
      </section>

      <aside className="side">
        <h3>物体</h3>
        <ul className="objects">
          {layout.objects.map((o) => <li key={o.id} className={selected === o.id ? 'sel' : ''} onClick={() => setSelected(o.id)}>
            <b>{o.id}</b> <span className="muted">{o.label}</span>
            <button className="x" title="删除" onClick={(e) => { e.stopPropagation(); update({ ...layout, objects: layout.objects.filter((x) => x.id !== o.id), capture: null }); }}>×</button>
          </li>)}
        </ul>
        {issues.length > 0 && <div className="issues">{issues.map((i, k) => <div key={k}>⚠ {i.message}</div>)}</div>}
        <h3>风格</h3>
        <textarea className="style" value={layout.style.summary} placeholder="一句话风格：温暖北欧、午后阳光" onChange={(e) => update({ ...layout, style: { ...layout.style, summary: e.target.value } })} />
        <textarea className="style" value={layout.style.lighting} placeholder="光照" onChange={(e) => update({ ...layout, style: { ...layout.style, lighting: e.target.value } })} />

        <h3>生成</h3>
        <label>全景图生成<select value={provider} onChange={(e) => setProvider(e.target.value)}>{config.providers.map((p) => <option key={p.id} value={p.id} disabled={!p.available}>{p.label}{p.available ? '' : '（未配置）'}</option>)}</select></label>
        <label>自动补缺口<select value={String(fills)} onChange={(e) => setFills(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}><option value="auto">自动（按场景大小，最多 3 个）</option>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n ? `最多 ${n} 个视角` : '不补'}</option>)}</select></label>
        <button className="primary wide" disabled={!layout.objects.length || job?.status === 'running' || !config.viggle} onClick={() => void generate().catch((e) => setError((e as Error).message))}>生成 3D 场景</button>
        <p className="muted small">JST-2：全景 + 场景约 12 额度，每补一个缺口约 13 额度；自动档补到最大空洞低于 5% 为止</p>
        {job && <div className={`job ${job.status}`}>
          <div className="bar"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          <div>{job.status === 'running' ? `${STAGES[job.stage] ?? job.stage}：${job.message}` : job.status === 'done' ? '已完成' : `失败：${job.error}`}</div>
          <details><summary>日志</summary><pre>{job.log.join('\n')}</pre></details>
          {job.status === 'running' && <button onClick={() => void api.cancel(project.id)}>取消</button>}
        </div>}
        {r && <div className="result">
          <h3>结果</h3>
          <table><tbody>
            <tr><td>地面高度</td><td>{r.alignment.floorY ?? '?'} m（目标 0）</td></tr>
            <tr><td>与白模深度一致（±25%）</td><td>整体 {Math.round(r.alignment.within25 * 100)}% · 物体 {Math.round(r.alignment.objectsWithin25 * 100)}%</td></tr>
            <tr><td>尺度</td><td>1 JST-2 单位 = {r.metersPerUnit} m</td></tr>
            {r.candidates && r.candidates.length > 1 && <tr><td>全景候选</td><td>{r.candidates.length} 张，选第 {(r.chosen ?? 0) + 1} 张（与白模对齐 {r.candidates[r.chosen ?? 0]?.objects?.toFixed(2) ?? '?'}）</td></tr>}
            {r.fill && <tr><td>补缺口</td><td>{r.fill.rounds.length} 个视角，最大空洞 {Math.round(r.fill.before.worstHole * 100)}% → {Math.round(r.fill.after.worstHole * 100)}%</td></tr>}
            <tr><td>额度</td><td>{r.credits}</td></tr>
            <tr><td>耗时</td><td>{Object.entries(r.seconds).map(([k, v]) => `${STAGES[k] ?? k} ${v}s`).join(' · ')}</td></tr>
          </tbody></table>
          {r.candidates && r.candidates.length > 1 && <div className="cands">{r.candidates.map((c, i) => <figure key={c.file} className={i === r.chosen ? 'on' : ''}><img src={file(project.id, `out/${c.file}`, stamp)} alt="" /><figcaption>{c.objects?.toFixed(2) ?? '—'}{c.people?.prominent ? ' · 有人物' : ''}{i === r.chosen ? ' · 选中' : ''}</figcaption></figure>)}</div>}
          <div className="row">
            <a href={file(project.id, `out/${r.files.scene}`, stamp)} download>下载 .spz</a>
            <a href={file(project.id, `out/${r.files.panorama}`, stamp)} target="_blank" rel="noreferrer">全景图</a>
            <a href={file(project.id, 'out/prompt.txt', stamp)} target="_blank" rel="noreferrer">prompt</a>
          </div>
          <button className="primary wide" onClick={() => void api.exportScene(project.id).then((x) => { setExported({ sceneId: x.sceneId, at: new Date().toISOString() }); onChanged(); }).catch((e) => setError((e as Error).message))}>{exported ? '已导入导演台 · 再导一次' : '导入导演台素材库'}</button>
          {exported && <p className="muted small">素材库场景 id：{exported.sceneId}。在 <a href="/canvas/world" target="_blank" rel="noreferrer">导演台</a> 的素材库里选用。</p>}
        </div>}
        {error && <div className="error">{error}</div>}
      </aside>
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.role === 'tool') return <details className={`msg tool${item.isError ? ' err' : ''}`}><summary>{item.name}</summary>{item.image && <img src={item.image} alt="" />}<pre>{JSON.stringify(item.args, null, 1)}</pre><pre>{item.text}</pre></details>;
  return <div className={`msg ${item.role}`}>{item.role === 'user' && item.image && <img src={item.image} alt="" />}{item.text}</div>;
}
