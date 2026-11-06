import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CameraSample, GapView, StageDoc, StageRenderer } from '@stage';
import { captureOf, checkScene, fillPoseToFile, poseOfCamera, sceneVersion } from '@stage';
import type { FillPose } from '@stage';

import { api } from './api.ts';
import { Icon } from './icons.tsx';
import type { GenJob, Library, LibraryScene } from './shared/library.ts';
import { fillCredits } from './shared/library.ts';

interface Props {
  doc: StageDoc;
  renderer: StageRenderer | null;
  onClose: () => void;
  /** Put the free camera at a pose, to look at a gap before filling it. */
  onFly: (cam: CameraSample) => void;
  /** Switch the World to a filled version of its scene. */
  onUseScene: (s: LibraryScene) => void;
}

const EMPTY: Library = { scenes: [], characters: [], motions: [], jobs: [] };
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** Why a scene cannot be filled, in the user's words. */
function whyNot(doc: StageDoc): string | null {
  if (!doc.scene) return '先选一个场景。';
  if (!doc.scene.viggle?.sessionId) return '这个场景是预设或导入的，没有 Viggle 会话，只能检测，不能补全。用文字生成的新场景可以补全。';
  if (!doc.scene.placement) return '场景还在测量地面，稍等几秒。';
  if (!doc.scene.placement.upright) return '这个场景文件的格式不支持补全（只有 .spz 场景可以）。';
  return null;
}

/**
 * Expand the scene by hand: find where it is thin (holes and smears), fly the camera there to see it,
 * and fill that view - Viggle generates it and rebuilds the scene, which comes back as a new scene to
 * switch to. The same check and fill the agent has as tools.
 */
export function ExpandPanel({ doc, renderer, onClose, onFly, onUseScene }: Props) {
  const [views, setViews] = useState<GapView[] | null>(null);
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lib, setLib] = useState<Library>(EMPTY);
  const [busy, setBusy] = useState(false);

  const blocked = whyNot(doc);
  const batches = doc.scene?.viggle?.batchIds.length ?? 0;
  const credits = fillCredits(batches || 1);

  const refresh = useCallback(() => api.library().then(setLib).catch(() => {}), []);
  useEffect(() => { void refresh(); }, [refresh]);

  // The fills of this scene's lineage: the scene in the library this World shows, and whatever was filled from it.
  const here = lib.scenes.find((s) => s.url === doc.scene?.url);
  const fills = useMemo(() => lib.jobs.filter((j): j is GenJob & { fill: NonNullable<GenJob['fill']> } => j.kind === 'fill' && !!j.fill && j.fill.sceneId === here?.id), [lib.jobs, here]);
  const running = fills.some((j) => j.status === 'processing');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [running, refresh]);

  // A check belongs to one version of one scene: filling (or switching) retires it.
  const version = sceneVersion(doc);
  const key = `${doc.scene?.url}@${version}`;
  useEffect(() => { if (checkedUrl && checkedUrl !== key) { setViews(null); setCheckedUrl(null); } }, [key, checkedUrl]);

  const check = () => {
    if (!renderer || !doc.scene?.placement) return;
    setChecking(true);
    setError(null);
    // The search is a second of arithmetic on the main thread: let the button show it is working first.
    setTimeout(() => {
      try {
        const sample = renderer.cloudSample();
        const capture = captureOf(doc);
        if (!sample || sample.positions.length < 3000 || !capture) { setError('这个场景没有可读取的点云数据（流式场景），无法检测。'); setViews(null); return; }
        setViews(checkScene(sample, { capture }).views);
        setCheckedUrl(key);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChecking(false);
      }
    }, 30);
  };

  const look = (v: GapView) => {
    const f = v.forward;
    onFly({ position: v.position, target: [v.position[0] + f[0] * 3, v.position[1] + f[1] * 3, v.position[2] + f[2] * 3], fov: 70 });
  };

  const fill = async (pose: FillPose) => {
    if (blocked || busy || running) return;
    if (!confirm(`补全这个视角会消耗约 ${credits} 额度（$${(credits / 100).toFixed(2)}）：先生成这个视角，再用全部视角重建场景，约 1–3 分钟，失败自动退还。继续吗？`)) return;
    setBusy(true);
    setError(null);
    try {
      const file = fillPoseToFile(doc, pose);
      await api.generate('fill', { sceneUrl: doc.scene!.url, position: file.position, yaw: file.yaw, pitch: file.pitch });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fillHere = () => { if (renderer) void fill(poseOfCamera(renderer.getCamera(3))); };

  // A finished fill whose scene this World is not showing yet: the thing the user is waiting for.
  const ready = fills.find((j) => j.status === 'ready' && j.assetId && lib.scenes.find((s) => s.id === j.assetId)?.url !== doc.scene?.url);
  const readyScene = ready ? lib.scenes.find((s) => s.id === ready.assetId) : undefined;
  const live = fills.find((j) => j.status === 'processing');
  const failed = fills.find((j) => j.status === 'failed');

  return (
    <aside className="float library-card expand-card">
      <header className="lib-head">
        <button className="ghost-icon" onClick={onClose} title="收起"><Icon name="chevronLeft" size={20} /></button>
        <h2>扩展场景</h2>
      </header>
      <div className="lib-scroll">
        <p className="hint-box">全景场景只在拍摄点附近完整。走远了会出现<strong>空洞</strong>（没有重建出来）和<strong>模糊</strong>（拖影）。检测缺口，飞过去看看，再补全那个视角。</p>
        {blocked && <p className="hint-box warn">{blocked}</p>}
        {!blocked && batches > 1 && <p className="muted small">这个场景已经补全过 {batches - 1} 次。</p>}

        {live && (
          <div className="gen">
            <div className="job processing"><span className="job-dot" /> <span className="job-label">{live.fill.phase === 'generate' ? '正在生成这个视角…' : '正在重建场景…'}</span></div>
            <p className="muted small">约 1–3 分钟，可以先做别的；完成后这里会出现「应用」。</p>
          </div>
        )}
        {readyScene && (
          <div className="gen">
            <div className="job ready"><span className="job-dot" /> <span className="job-label">补全完成：{readyScene.name}</span></div>
            <div className="gen-row"><button className="pill primary" onClick={() => onUseScene(readyScene)}>应用到这个 World</button></div>
            <p className="muted small">角色和镜头保持不变；应用后重新检测，看看还有没有缺口。</p>
          </div>
        )}
        {failed && !live && <p className="hint-box warn">上一次补全失败了：{failed.error ?? '未知原因'}（额度会退还）。</p>}

        <div className="gen">
          <div className="gen-row">
            <button className="pill" disabled={checking || !renderer || !doc.scene?.placement} onClick={check}><Icon name="sparkle" size={16} />{checking ? '检测中…' : views ? '重新检测' : '检测场景缺口'}</button>
            <button className="pill" disabled={!!blocked || busy || running} onClick={fillHere} title="先把自由相机飞到想补的位置，再点这里"><Icon name="camera" size={16} />从当前视角补全</button>
          </div>
          <p className="muted small">检测免费，约 1 秒。补全约 {credits} 额度，每次一个视角。</p>
        </div>

        {error && <p className="hint-box warn">{error}</p>}
        {views && !views.length && <p className="hint-box">没有发现值得补全的视角。这不等于场景完美：飞到你要拍的角度看一看，有瑕疵就用「从当前视角补全」。</p>}
        {views && views.length > 0 && (
          <>
            <div className="section-title">值得补全的视角（从好到一般）</div>
            <div className="list">
              {views.map((v) => (
                <div key={v.id} className="gap-row">
                  <button className="menu-row" onClick={() => look(v)} title="把自由相机飞到这个视角">
                    <span className="tile"><Icon name="camera" size={18} /></span>
                    <span className="menu-label">视角 {v.priority}{v.role === 'candidate' ? '（次要）' : ''}
                      <span className="sub">空洞 {pct(v.hole)} · 模糊 {pct(v.blur)}</span></span>
                  </button>
                  <button className="pill" disabled={!!blocked || busy || running} onClick={() => void fill({ position: v.position, yaw: v.yaw, pitch: v.pitch })}>补全</button>
                </div>
              ))}
            </div>
            <p className="muted small">点视角把相机飞过去看；觉得有问题再点「补全」。顺序综合了远近和构图，不是按数字大小。</p>
          </>
        )}
      </div>
    </aside>
  );
}
