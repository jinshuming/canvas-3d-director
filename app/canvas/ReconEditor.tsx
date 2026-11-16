/**
 * 场景重建 in the scene editor: the 3D view beside the reconstruction - its numbers, the anchor
 * panorama, and the video's real frames against the views JST-2 generated at the same cameras.
 */
import { useState } from 'react';

import { api as sg, file } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import { SplatViewer } from '../../scenegen/web/SplatViewer.tsx';
import type { ViewerPose } from '../../scenegen/web/SplatViewer.tsx';
import { Icon } from '../icons.tsx';
import { JobStatus } from './JobStatus.tsx';
import { LightButton, LightPanel, RECON_BOX, useLighting } from './LightPanel.tsx';
import type { ReconResult } from './sceneResults.ts';
import { totalSeconds } from './sceneResults.ts';

export function ReconEditor({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const r = project.result as ReconResult | null | undefined;
  const job = project.job;
  const running = job?.status === 'running';
  const stamp = job?.endedAt ?? 0;
  const [err, setErr] = useState<string | null>(null);
  const [start, setStart] = useState<ViewerPose | null>(null);
  const light = useLighting(project);
  const rerun = async () => {
    setErr(null);
    try { await sg.videoRun(project.id, { reusePoses: true }); await reload(); } catch (e) { setErr((e as Error).message); }
  };
  const expand = (pose: ViewerPose) => {
    setStart(pose); setErr(null);
    void sg.expand(project.id, pose).then(() => reload()).catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="se-body">
      <section className="se-stage">
        {r && <div className="se-tabs">
          <button className="on">3D 场景</button>
          <LightButton light={light} onClick={() => light.setOpen((o) => !o)} />
        </div>}
        <div className="se-view">
          {/* While a rerun goes, the old scene stays only when it is being expanded from a pose. */}
          {r && (!running || start) ? <SplatViewer url={file(project.id, 'out/scene.spz', stamp)} start={start} expanding={running}
              lighting={light.lighting} relightBox={RECON_BOX} onExpand={r.mode === 'generate' ? expand : undefined} />
            : project.video ? <video className="se-video" src={file(project.id, project.video.file)} muted controls />
            : <div className="se-empty"><Icon name="video" size={34} /><p>先在画布节点上传一段视频。</p></div>}
          <JobStatus project={project} failedLabel="重建" />
          {light.open && r && <LightPanel light={light} />}
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
              <tr><td>耗时</td><td>{totalSeconds(r.seconds)} 秒</td></tr>
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
