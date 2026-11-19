/** The /scenegen/ batch test page: project list on the left, TextProject / VideoProject on the right. Shared client code is in api.ts and runner.ts (README.md in this folder). */
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api.ts';
import type { Config, Project, ProjectSummary } from './api.ts';
import { TextProject } from './TextProject.tsx';
import { VideoProject } from './VideoProject.tsx';
import './styles.css';

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [list, setList] = useState<ProjectSummary[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => { void api.projects().then(setList).catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => { void api.config().then(setConfig).catch((e) => setError((e as Error).message)); refresh(); }, [refresh]);
  const open = async (id: string) => { setCurrent(await api.get(id)); history.replaceState(null, '', `#${id}`); };
  useEffect(() => { const id = location.hash.slice(1); if (id) void open(id).catch(() => {}); }, []);
  const create = async (kind: 'text' | 'video') => { const p = await api.create(kind); refresh(); setCurrent(p); history.replaceState(null, '', `#${p.id}`); };

  return (
    <div className="app">
      <header>
        <b>场景生成 · 批量测试</b>
        <span className="muted">逐个项目查看输入、白模、全景候选、3D 场景和指标；日常使用请在画布上加「场景生成」「场景重建」节点</span>
        <span className="grow" />
        <a href="/canvas" className="muted">回到画布 →</a>
      </header>
      <div className="body">
        <nav>
          <div className="row"><button className="primary" onClick={() => void create('text')}>＋ 文本 / 图片</button><button onClick={() => void create('video')}>＋ 视频</button></div>
          <ul>
            {list.map((p) => <li key={p.id} className={current?.id === p.id ? 'on' : ''} onClick={() => void open(p.id)}>
              <div>{p.kind === 'video' ? '🎬' : '🧱'} {p.title}</div>
              <div className="muted small">{statusText(p.status)}{p.exported ? ' · 已导入' : ''}</div>
            </li>)}
          </ul>
        </nav>
        <main>
          {error && <div className="error">{error}</div>}
          {!current || !config ? <div className="empty">新建一个项目，或从左边打开</div>
            : current.kind === 'video' ? <VideoProject key={current.id} project={current} config={config} onChanged={refresh} />
            : <TextProject key={current.id} project={current} config={config} onChanged={refresh} />}
        </main>
      </div>
    </div>
  );
}

function statusText(s: string) {
  return ({ draft: '草稿', running: '生成中', done: '已生成', failed: '失败' } as Record<string, string>)[s] ?? s;
}

createRoot(document.getElementById('root')!).render(<App />);
