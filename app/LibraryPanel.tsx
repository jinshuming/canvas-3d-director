import { useCallback, useEffect, useState } from 'react';

import type { StageCharacter } from '@stage';

import { api } from './api.ts';
import { Icon } from './icons.tsx';
import type { GenJob, Library, LibraryCharacter, LibraryMotion, LibraryScene } from './shared/library.ts';
import { COSTS, PRESET_CHARACTERS, PRESET_MOTIONS, PRESET_SCENES } from './shared/library.ts';

export type LibraryTab = 'scene' | 'character' | 'motion';
type Tab = LibraryTab;

const TAB_LABEL: Record<Tab, string> = { scene: '场景', character: '角色', motion: '动作' };

interface Props {
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  live: boolean;
  selectedCharacter: StageCharacter | null;
  onUseScene: (s: LibraryScene) => void;
  onAddCharacter: (c: LibraryCharacter) => void;
  onAddMotion: (m: LibraryMotion) => void;
}

const EMPTY: Library = { scenes: [], characters: [], motions: [], jobs: [] };

/**
 * Scenes, characters and motions: Viggle's public presets (free), what this
 * project generated, and forms to generate more through the server.
 */
export function LibraryPanel({ tab, onTab, onClose, live, selectedCharacter, onUseScene, onAddCharacter, onAddMotion }: Props) {
  const [lib, setLib] = useState<Library>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showGen, setShowGen] = useState(false);
  const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());

  const refresh = useCallback(() => api.library().then(setLib).catch((e: unknown) => setError(String(e))), []);
  // Jobs finish on the server whoever is watching: look again on each tab and when the window comes back.
  useEffect(() => { void refresh(); }, [refresh, tab]);
  useEffect(() => {
    const onFocus = () => void refresh();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [refresh]);
  const pending = lib.jobs.some((j) => j.status === 'processing');
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  const submit = async (kind: Tab, input: Record<string, unknown>) => {
    const what = { scene: '场景', character: '角色', motion: '动作' }[kind];
    if (!confirm(`生成一个${what}会消耗 ${COSTS[kind]} 额度（$${(COSTS[kind] / 100).toFixed(2)}），失败自动退还。继续吗？`)) return false;
    setError(null);
    try {
      await api.generate(kind, input);
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const jobs = lib.jobs.filter((j) => j.kind === tab);

  return (
    <aside className="float library-card">
      <header className="lib-head">
        <button className="ghost-icon" onClick={onClose} title="收起"><Icon name="chevronLeft" size={20} /></button>
        <h2>素材库</h2>
        <div className="spacer" />
        {live && (
          <button className={`pill sm ${showGen ? 'on' : ''}`} onClick={() => setShowGen((v) => !v)}>
            <Icon name="sparkle" size={16} />AI {TAB_LABEL[tab]}
          </button>
        )}
      </header>
      <div className="seg wide">
        {(['scene', 'character', 'motion'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => onTab(t)}>{TAB_LABEL[t]}</button>
        ))}
      </div>
      <label className="search">
        <Icon name="search" size={17} />
        <input placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="lib-scroll">
        {live && showGen && <GenerateForm tab={tab} onSubmit={async (k, input) => { const ok = await submit(k, input); if (ok) setShowGen(false); return ok; }} />}
        {!live && <p className="muted small hint-box">服务端未设置 VIGGLE_API_KEY，只能使用 Viggle 预置素材。在项目根目录的 .env.local 里设置后即可用 AI 生成。</p>}
        {error && <p className="error small">{error}</p>}
        {jobs.map((j) => <JobRow key={j.id} job={j} onDismiss={() => api.dismissJob(j.id).then(refresh)} />)}

        {tab === 'scene' && <Section title="我生成的" items={lib.scenes.filter((s) => match(s.name))} render={(s) => <SceneCard key={s.id} s={s} onUse={onUseScene} />} />}
        {tab === 'scene' && <Section title="Viggle 预置" items={PRESET_SCENES.filter((s) => match(s.name))} render={(s) => <SceneCard key={s.id} s={s} onUse={onUseScene} />} />}

        {tab === 'character' && <Section title="我生成的" items={lib.characters.filter((c) => match(c.name))} render={(c) => <CharacterCard key={c.id} c={c} onAdd={onAddCharacter} />} />}
        {tab === 'character' && <Section title="Viggle 预置" items={PRESET_CHARACTERS.filter((c) => match(c.name))} render={(c) => <CharacterCard key={c.id} c={c} onAdd={onAddCharacter} />} />}

        {tab === 'motion' && (
          <p className={`small hint-box ${selectedCharacter ? '' : 'warn'}`}>
            {selectedCharacter ? <>添加到 <strong>{selectedCharacter.name}</strong> 的播放头位置</> : '先在画面或时间轴里选中一个角色'}
          </p>
        )}
        {tab === 'motion' && <Section list title="我生成的" items={lib.motions.filter((m) => match(m.name))} render={(m) => <MotionRow key={m.id} m={m} disabled={!selectedCharacter} onAdd={onAddMotion} />} />}
        {tab === 'motion' && <Section list title="Viggle 预置" items={PRESET_MOTIONS.filter((m) => match(m.name))} render={(m) => <MotionRow key={m.id} m={m} disabled={!selectedCharacter} onAdd={onAddMotion} />} />}
      </div>
    </aside>
  );
}

function Section<T>({ title, items, render, list }: { title: string; items: T[]; render: (t: T) => React.ReactNode; list?: boolean }) {
  if (!items.length) return null;
  return (
    <>
      <h4 className="section-title">{title}</h4>
      <div className={list ? 'list' : 'cards'}>{items.map(render)}</div>
    </>
  );
}

function SceneCard({ s, onUse }: { s: LibraryScene; onUse: (s: LibraryScene) => void }) {
  return (
    <button className="card" onClick={() => onUse(s)} title="设为场景">
      {s.panoramaUrl ? <img src={s.panoramaUrl} alt="" /> : <div className="card-ph"><Icon name="scene" size={22} /></div>}
      <span>{s.name}</span>
    </button>
  );
}

function CharacterCard({ c, onAdd }: { c: LibraryCharacter; onAdd: (c: LibraryCharacter) => void }) {
  return (
    <button className="card" onClick={() => onAdd(c)} title="加入片场">
      {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" /> : <div className="card-ph"><Icon name="character" size={22} /></div>}
      <span>{c.name}</span>
    </button>
  );
}

function MotionRow({ m, disabled, onAdd }: { m: LibraryMotion; disabled: boolean; onAdd: (m: LibraryMotion) => void }) {
  return (
    <button className="menu-row" disabled={disabled} onClick={() => onAdd(m)}>
      <span className="tile"><Icon name="motion" size={18} /></span>
      <span className="menu-label">{m.name}</span>
      <Icon name="plus" size={16} className="muted" />
    </button>
  );
}

function JobRow({ job, onDismiss }: { job: GenJob; onDismiss: () => void }) {
  return (
    <div className={`menu-row job ${job.status}`}>
      <span className="tile"><span className="job-dot" /></span>
      <span className="menu-label">
        <span className="job-label" title={job.label}>{job.label}</span>
        <span className="sub">{job.status === 'processing' ? `生成中 · ${job.credits} 额度` : job.status === 'ready' ? '完成，已加入下方' : job.error ?? '失败（额度已退还）'}</span>
      </span>
      {job.status !== 'processing' && <button className="ghost-icon" onClick={onDismiss}><Icon name="x" size={14} /></button>}
    </div>
  );
}

function GenerateForm({ tab, onSubmit }: { tab: Tab; onSubmit: (kind: Tab, input: Record<string, unknown>) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [quality, setQuality] = useState('low');
  const [duration, setDuration] = useState(5);
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    let input: Record<string, unknown>;
    if (tab === 'scene') input = { prompt: text, quality };
    else if (tab === 'motion') input = { text, duration, name };
    else {
      if (!image) { setBusy(false); return; }
      input = { name: name || image.name.replace(/\.\w+$/, ''), imageBase64: await toBase64(image), mimeType: image.type };
    }
    const ok = await onSubmit(tab, input);
    setBusy(false);
    if (ok) { setText(''); setName(''); setImage(null); }
  };

  return (
    <div className="gen">
      {tab === 'scene' && (
        <>
          <textarea rows={3} placeholder="描述场景，例如：雨夜的霓虹街角，湿漉漉的柏油路" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
          <div className="gen-row">
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
            <button className="pill primary" disabled={busy || !text.trim()} onClick={go}>生成场景 · {COSTS.scene} 额度</button>
          </div>
        </>
      )}
      {tab === 'character' && (
        <>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
          <div className="gen-row">
            <input placeholder="名字（可选）" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="pill primary" disabled={busy || !image} onClick={go}>生成角色 · {COSTS.character} 额度</button>
          </div>
          <p className="muted small">全身正面照效果最好，生成约 1–2 分钟。</p>
        </>
      )}
      {tab === 'motion' && (
        <>
          <textarea rows={2} placeholder="描述动作，例如：慢慢走过来，停下，回头看" value={text} onChange={(e) => setText(e.target.value)} maxLength={400} />
          <div className="gen-row">
            <label className="field-inline">秒 <input type="number" min={3} max={60} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
            <button className="pill primary" disabled={busy || !text.trim()} onClick={go}>生成动作 · {COSTS.motion} 额度</button>
          </div>
        </>
      )}
    </div>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
