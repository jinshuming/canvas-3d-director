import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from './api.ts';
import { CanvasPage } from './canvas/CanvasPage.tsx';
import { Icon, Logo } from './icons.tsx';
import { linkProps, navigate, useRoute, worldPath } from './router.ts';
import { Studio } from './Studio.tsx';
import { WorldBrowser } from './WorldBrowser.tsx';

/** /canvas/world: every World project. */
function Worlds() {
  const [creating, setCreating] = useState(false);
  const create = async () => {
    setCreating(true);
    try { navigate(worldPath((await api.createWorld()).id)); } finally { setCreating(false); }
  };
  return (
    <div className="home wide">
      <div className="home-brand"><Logo size={40} /><h1>World</h1></div>
      <p className="lead">每个 World 是一个工程文件：场景、角色、动作、镜头，以及和 Agent 的对话。</p>
      <div className="btn-row">
        <button className="pill primary" disabled={creating} onClick={() => void create()}><Icon name="plus" />新建 World</button>
        <a className="pill" {...linkProps('/canvas')}><Icon name="chevronLeft" />回到画布</a>
      </div>
      <WorldBrowser />
    </div>
  );
}

function App() {
  const route = useRoute();
  const [config, setConfig] = useState<{ live: boolean; agent: { model: string } | null }>({ live: false, agent: null });
  useEffect(() => { api.config().then(setConfig).catch(() => {}); }, []);
  if (route.page === 'canvas') return <CanvasPage />;
  if (route.page === 'world') return <Studio key={route.id} stageId={route.id} nodeId={route.node} live={config.live} agentModel={config.agent?.model ?? null} />;
  return <Worlds />;
}

// The evaluation runner (see eval/index.js), dev only.
if (import.meta.env.DEV) void import('../eval/index.js');

createRoot(document.getElementById('root')!).render(<App />);
