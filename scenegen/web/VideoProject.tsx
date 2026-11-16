/**
 * Video → frames → COLMAP poses → scene. Today through the endpoints that exist (videoGen.ts): an
 * anchor panorama from the real frames, JST-2 views at the video's own cameras, reconstruct;
 * through posed-images (mock) once JST-2 takes images with poses.
 */
import { useEffect, useState } from 'react';

import { api, file } from './api.ts';
import { SplatViewer } from './SplatViewer.tsx';
import type { Config, Job, Project } from './api.ts';

interface Views { stats: Record<string, unknown> & { seconds?: Record<string, number> }; frame: { scale: string; floorY?: number }; views: Array<{ index: number; file: string; frameTime: number; width: number; height: number; c2w: number[][]; intrinsic: number[] }> }

const STAGES: Record<string, string> = { probe: '读取视频', sample: '抽帧', colmap: 'COLMAP 估计位姿', normalise: '重力与尺度', select: '挑选视角', write: '写出图片+位姿', upload: '上传 JST-2', stitch: '拼接锚点全景', complete: '补全视频没拍到的部分', scale: '测量尺度', retry: '重试', scene: 'JST-2 建场景', path: '沿视频路径生成视角', rebuild: 'JST-2 重建', fill: '检测并补缺口', verify: '与 COLMAP 点对比', done: '完成', start: '开始' };

export function VideoProject({ project, config, onChanged }: { project: Project; config: Config; onChanged: () => void }) {
  const [video, setVideo] = useState(project.video ?? null);
  const [job, setJob] = useState<Job | null>(project.job ?? null);
  const [result, setResult] = useState(project.result ?? null);
  const [views, setViews] = useState<Views | null>(null);
  const [uploading, setUploading] = useState(false);
  const [square, setSquare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(project.exported ?? null);

  useEffect(() => {
    if (job?.status !== 'running') return;
    const t = window.setInterval(async () => {
      const p = await api.get(project.id);
      setJob(p.job ?? null);
      if (p.job?.status !== 'running') { setResult(p.result ?? null); onChanged(); }
    }, 1000);
    return () => window.clearInterval(t);
  }, [job?.status, project.id, onChanged]);

  useEffect(() => {
    if (!result) { setViews(null); return; }
    void fetch(file(project.id, 'out/bundle/views.json', job?.endedAt)).then((r) => (r.ok ? r.json() : null)).then(setViews);
  }, [result, project.id, job?.endedAt]);

  async function upload(f: File) {
    setUploading(true); setError(null);
    try { setVideo(await api.video(project.id, f)); setResult(null); onChanged(); } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }

  const r = result as null | { views: number; endpoint: string; credits: number; seconds: Record<string, number>; stats: Record<string, number>; mode?: 'generate';
    anchor?: { index: number; frames: number; coverage: number }; metersPerUnit?: number; verify?: { points: number; within25: number; medianLogError: number };
    pathViews?: Array<{ index: number; file: string; image: string | null; position: number[]; yaw: number }>; files?: Record<string, string> };
  const gen = r?.mode === 'generate';
  return (
    <div className="video-project">
      <section className="video-left">
        <h3>1 · 上传视频</h3>
        <p className="muted small">绕着场景慢慢走或平移拍摄 10–60 秒，避免快速转头；画面里少一些走动的人。</p>
        <label className="file-btn big">{uploading ? '上传中…' : video ? '换一段视频' : '选择视频'}<input type="file" accept="video/mp4,video/quicktime" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>
        {video && <video src={file(project.id, video.file)} controls muted className="preview" />}
        <h3>2 · 估计位姿并重建</h3>
        <label className="check"><input type="checkbox" checked={square} onChange={(e) => setSquare(e.target.checked)} />裁成 1024×1024（与 JST-2 自己的视角一致）</label>
        <button className="primary wide" disabled={!video || job?.status === 'running' || !config.video.available} onClick={() => void api.videoRun(project.id, square ? { square: 1024 } : {}).then(setJob).catch((e) => setError((e as Error).message))}>开始</button>
        <p className="muted small">{config.video.endpoint === 'mock' ? 'JST-2 还不能上传图片+位姿：用视频帧拼出锚点全景建场景，再在视频自己的相机位置生成视角并重建（离锚点越远，画面越多是模型补出来的）。' : 'posed-images：线上 JST-2'}</p>
        {!config.video.available && <p className="warn">视频管线未安装：在 scenegen/py 建 .venv 并安装 requirements.txt。</p>}
        {job && <div className={`job ${job.status}`}>
          <div className="bar"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          <div>{job.status === 'running' ? `${STAGES[job.stage] ?? job.stage}：${job.message}` : job.status === 'done' ? '已完成' : `失败：${job.error}`}</div>
          <details><summary>日志</summary><pre>{job.log.join('\n')}</pre></details>
        </div>}
        {error && <div className="error">{error}</div>}
      </section>
      <section className="video-right">
        {views ? <>
          <h3>{views.views.length} 张图片 + 位姿</h3>
          <div className="stats">
            {(['candidates', 'keyframes', 'registered', 'selected'] as const).map((k) => <span key={k}>{({ candidates: '候选帧', keyframes: '关键帧', registered: '注册成功', selected: '发给 JST-2' })[k]} <b>{String(views.stats[k])}</b></span>)}
            <span>重投影误差 <b>{Number(views.stats.reprojErrorPx).toFixed(2)} px</b></span>
            <span>尺度 <b>{views.frame.scale === 'floor' ? '按地面（相机高 1.5 m）' : '估计'}</b></span>
          </div>
          {r && <div className="video-scene"><SplatViewer url={file(project.id, 'out/scene.spz', job?.endedAt)} /><p className="muted small">{gen ? '起点是锚点（视频里环顾最多的位置）。' : 'posed-images 是模拟接口时，这里是 COLMAP 稀疏点云的预览；接口上线后就是 JST-2 的重建。'}</p></div>}
          {gen && r.files && <div className="gen-anchor">
            <h3>锚点全景：视频帧拼接 → 补全</h3>
            <div className="pair"><img src={file(project.id, `out/${r.files.stitched}`, job?.endedAt)} alt="" /><img src={file(project.id, `out/${r.files.panorama}`, job?.endedAt)} alt="" /></div>
            {!!r.pathViews?.length && <><h3>沿视频路径：真实帧 | JST-2 在同一相机生成的视角</h3>
              <div className="gen-views">{r.pathViews.map((v) => <figure key={v.index}><img src={file(project.id, `out/bundle/${v.file}`)} alt="" /><img src={v.image ? file(project.id, `out/${v.image}`, job?.endedAt) : ''} alt="" /><figcaption>第 {v.index} 帧 · 离锚点 {Math.hypot(v.position[0]!, v.position[2]!).toFixed(1)} m</figcaption></figure>)}</div></>}
          </div>}
          <CameraPath views={views.views} />
          <div className="frames">{views.views.map((v) => <figure key={v.index}><img src={file(project.id, `out/bundle/${v.file}`)} alt="" loading="lazy" /><figcaption>{v.frameTime.toFixed(1)}s</figcaption></figure>)}</div>
          {r && <div className="result">
            <table><tbody>
              <tr><td>JST-2</td><td>{gen ? '锚点全景 + 路径生成' : r.endpoint === 'mock' ? '模拟接口' : '线上'} · {r.views} 个视角 · {r.credits} 额度</td></tr>
              {gen && r.anchor && <tr><td>锚点</td><td>第 {r.anchor.index} 帧，附近 {r.anchor.frames} 帧拼接 · 1 单位 = {r.metersPerUnit} m</td></tr>}
              {gen && r.verify && <tr><td>与视频一致</td><td>COLMAP 点 {Math.round(r.verify.within25 * 100)}% 在 ±25% 内（{r.verify.points} 个点）</td></tr>}
              <tr><td>耗时</td><td>{Object.entries(r.seconds).map(([k, v]) => `${k} ${v}s`).join(' · ')}</td></tr>
            </tbody></table>
            <div className="row">
              <a href={file(project.id, 'out/scene.spz', job?.endedAt)} download>下载 .spz</a>
              {!gen && <a href={file(project.id, 'out/bundle/request.json')} target="_blank" rel="noreferrer">posed-images 请求体</a>}
            </div>
            <button className="primary wide" onClick={() => void api.exportScene(project.id).then((x) => { setExported({ sceneId: x.sceneId, at: new Date().toISOString() }); onChanged(); }).catch((e) => setError((e as Error).message))}>{exported ? '已导入导演台 · 再导一次' : '导入导演台素材库'}</button>
          </div>}
        </> : <div className="empty">上传视频并开始后，这里显示抽出的图片、相机轨迹和重建结果</div>}
      </section>
    </div>
  );
}

/** Top-down camera path: positions on x/z, a tick for where each looks. */
function CameraPath({ views }: { views: Views['views'] }) {
  const pts = views.map((v) => ({ x: v.c2w[0]![3]!, z: v.c2w[2]![3]!, fx: v.c2w[0]![2]!, fz: v.c2w[2]![2]! }));
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const span = Math.max(maxX - minX, maxZ - minZ, 0.5) * 1.3;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const S = 260;
  const map = (x: number, z: number) => [S / 2 + ((x - cx) / span) * S, S / 2 + ((z - cz) / span) * S] as const;
  const tick = span * 0.06;
  return (
    <svg className="path" viewBox={`0 0 ${S} ${S}`} width={S} height={S}>
      <polyline fill="none" stroke="#9aa" strokeWidth={1} points={pts.map((p) => map(p.x, p.z).join(',')).join(' ')} />
      {pts.map((p, i) => { const [a, b] = map(p.x, p.z); const [c, d] = map(p.x + p.fx * tick, p.z + p.fz * tick); return <g key={i}><line x1={a} y1={b} x2={c} y2={d} stroke="#e24" strokeWidth={1.5} /><circle cx={a} cy={b} r={2.5} fill={i === 0 ? '#2a6' : '#335'} /></g>; })}
      <text x={6} y={14} fontSize={10} fill="#666">俯视 · 绿点为第一帧 · 红线为朝向</text>
    </svg>
  );
}
