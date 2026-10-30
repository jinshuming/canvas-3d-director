import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api.ts';
import { CanvasPage } from './canvas/CanvasPage.tsx';
import { Icon, Logo } from './icons.tsx';
import { linkProps, navigate, useRoute } from './router.ts';
import { Studio } from './Studio.tsx';

/** /canvas/world: every World. */
function Worlds() {
  const [stages, setStages] = useState<Array<{ id: string; title: string; updatedAt: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.listStages().then(setStages).catch((e: unknown) => setError(String(e))); }, []);
  const create = async () => {
    const d = await api.createStage('未命名片场');
    navigate(`/canvas/world/${d.id}`);
  };
  return (
    <div className="home">
      <div className="home-brand"><Logo size={40} /><h1>World</h1></div>
      <p className="lead">今天拍什么？用 Viggle 生成的场景、角色和动作搭一场戏，摆机位、设计运镜，导出画面和视频。</p>
      <div className="btn-row">
        <button className="pill primary" onClick={() => void create()}><Icon name="plus" />新建片场</button>
        <a className="pill" {...linkProps('/canvas')}><Icon name="chevronLeft" />回到画布</a>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="stage-list">
        {stages?.map((s) => (
          <a key={s.id} className="stage-item" {...linkProps(`/canvas/world/${s.id}`)}>
            <strong>{s.title}</strong>
            <span className="muted small">{new Date(s.updatedAt).toLocaleString()}</span>
          </a>
        ))}
      </div>
      {stages && !stages.length && <p className="muted">还没有片场。</p>}
    </div>
  );
}

function App() {
  const route = useRoute();
  const [config, setConfig] = useState<{ live: boolean; agent: { model: string } | null }>({ live: false, agent: null });
  useEffect(() => { api.config().then(setConfig).catch(() => {}); }, []);
  if (route.page === 'canvas') return <CanvasPage />;
  if (route.page === 'world') return <Studio key={route.id} stageId={route.id} live={config.live} agentModel={config.agent?.model ?? null} />;
  return <Worlds />;
}

createRoot(document.getElementById('root')!).render(<App />);
