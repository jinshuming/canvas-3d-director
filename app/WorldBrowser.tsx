import { useEffect, useMemo, useState } from 'react';

import { api } from './api.ts';
import { bindWorldNode } from './canvas/model.ts';
import { Icon } from './icons.tsx';
import { navigate, worldPath } from './router.ts';
import type { WorldSummary } from './shared/world.ts';

/**
 * Every saved World, newest first: open one, start a copy of one, or put one
 * in the trash. In the editor it loads into the canvas node the editor was
 * entered from (that node then opens the chosen world); on its own page it
 * just opens.
 */
export function WorldBrowser({ currentId, nodeId, onClose }: { currentId?: string; nodeId?: string | null; onClose?: () => void }) {
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.listWorlds().then(setWorlds).catch((e: unknown) => setError(String(e)));
  useEffect(() => { void load(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!worlds || !q) return worlds;
    return worlds.filter((w) => [w.title, w.sceneName, w.lastPrompt].some((v) => v?.toLowerCase().includes(q)));
  }, [worlds, query]);

  const open = (w: { id: string; title: string }) => {
    if (nodeId) bindWorldNode(nodeId, w.id, w.title);
    onClose?.();
    navigate(worldPath(w.id, nodeId));
  };
  const copy = async (w: WorldSummary) => {
    setBusy(w.id);
    try { open(await api.createWorld({ copyOf: w.id })); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };
  const remove = async (w: WorldSummary) => {
    if (!confirm(`删除「${w.title}」？它会被移到服务器的回收站（.data/trash），可以手动找回。`)) return;
    setBusy(w.id);
    try { await api.deleteWorld(w.id); await load(); } catch (e) { setError(String(e)); } finally { setBusy(null); }
  };

  return (
    <div className="wb">
      <div className="wb-head">
        <div className="wb-search"><Icon name="search" size={16} /><input placeholder="搜索标题、场景或对话" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        {nodeId && <span className="muted small">选中的 World 会加载到当前画布节点</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {!worlds && !error && <p className="muted">加载中…</p>}
      {shown && !shown.length && <p className="muted">{query ? '没有匹配的 World。' : '还没有 World。'}</p>}
      <div className="wb-grid">
        {shown?.map((w) => {
          const current = w.id === currentId;
          return (
            <article key={w.id} className={`wb-card ${current ? 'current' : ''}`}>
              <button className="wb-cover" onClick={() => !current && open(w)} disabled={current || busy === w.id} title={current ? '正在编辑' : '打开'}>
                {w.coverUrl ? <img src={w.coverUrl} alt="" loading="lazy" /> : <span className="wb-cover-empty"><Icon name="globe" size={26} /></span>}
                {current && <span className="wb-tag">当前</span>}
                {w.origin.kind === 'copy' && <span className="wb-tag right" title={`复制自「${w.origin.fromTitle}」`}>副本</span>}
              </button>
              <div className="wb-meta">
                <strong title={w.title}>{w.title}</strong>
                <span className="muted small">{w.sceneName ?? '还没有场景'} · {w.characters} 角色 · {w.shots} 镜头</span>
                {w.lastPrompt && <span className="wb-prompt small" title={w.lastPrompt}>“{w.lastPrompt}”</span>}
                <span className="faint small">{ago(w.updatedAt)}{w.prompts ? ` · ${w.prompts} 轮对话` : ''}</span>
              </div>
              <div className="wb-actions">
                <button className="pill sm" disabled={current || busy === w.id} onClick={() => open(w)}>{nodeId ? '加载' : '打开'}</button>
                <button className="pill sm" disabled={busy === w.id} onClick={() => void copy(w)} title="以它为起点新建一个 World（对话从头开始）"><Icon name="copy" size={14} />复制</button>
                <button className="pill sm icon danger" disabled={current || busy === w.id} onClick={() => void remove(w)} title="移到回收站"><Icon name="trash" size={14} /></button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** "3 分钟前" style. */
export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(iso).toLocaleDateString();
}
