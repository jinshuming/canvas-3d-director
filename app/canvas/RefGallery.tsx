/**
 * 参考图: every picture a generation made or worked from, in the order it used them - what the
 * panorama was painted from (depth map + clay render of the environment's blockout), what it was
 * scored with (the semantic map), the candidates and the one kept, per SAM 3D object its crop of
 * the environment, the blockout guide for that view and the object painted in, the Expand views,
 * and the prompt. A file an older scene does not have hides itself.
 */
import { useEffect, useState } from 'react';

import { file } from '../../scenegen/web/api.ts';
import type { Project } from '../../scenegen/web/api.ts';
import type { GenResult } from './sceneResults.ts';

export function RefGallery({ project, result, stamp }: { project: Project; result: GenResult; stamp: number }) {
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => { void fetch(file(project.id, 'out/prompt.txt', stamp)).then((r) => (r.ok ? r.text() : null)).then(setPrompt).catch(() => {}); }, [project.id, stamp]);
  const src = (f: string) => file(project.id, `out/${f}`, stamp);
  const fig = (f: string, caption: string, note?: string, opts: { wide?: boolean; on?: boolean } = {}) => (
    <figure key={f} className={`se-ref${opts.wide ? ' wide' : ''}${opts.on ? ' on' : ''}`} onClick={() => setZoom({ src: src(f), caption })}>
      <img src={src(f)} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none'; }} />
      <figcaption><b>{caption}</b>{note && <span>{note}</span>}</figcaption>
    </figure>
  );
  const objs = result.objects ?? [];
  return (
    <div className="se-refs">
      <section>
        <h4>① 发给 GPT-image-2 的参考图 <span>环境白模（不含 SAM 3D 物体），从拍摄点渲染，像素对齐</span></h4>
        <div className="se-ref-row">
          {fig('depth.png', '等距深度图', '越亮越近：管空间和距离', { wide: true })}
          {fig('shaded.png', '白模渲染图', '每个物体一种颜色：管轮廓和位置', { wide: true })}
        </div>
      </section>
      <section>
        <h4>② 不发给出图模型 <span>打分用 / 画物体时的位置参考</span></h4>
        <div className="se-ref-row">
          {fig('semantic.png', '语义分割图', '给候选打分：全景图的边缘与它的边缘重合多少', { wide: true })}
          {fig('blockout-full/shaded.png', '完整白模渲染图', '含 SAM 3D 物体：画物体时的位置参考', { wide: true })}
        </div>
      </section>
      {!!result.candidates?.length && <section>
        <h4>③ 全景图候选 <span>先画 1 张：对齐分 ≥ 0.8 且没有人物就用；不够再画 2 张，选没有人物、对齐分最高的一张</span></h4>
        <div className="se-ref-row">
          {result.candidates.map((c, i) => fig(c.file, `候选 ${i + 1}${i === result.chosen ? ' · 选中' : ''}`, `对齐分 ${c.objects?.toFixed(2) ?? '—'}${c.people?.prominent ? ' · 有人物' : ''}`, { wide: true, on: i === result.chosen }))}
        </div>
      </section>}
      <section>
        <h4>④ 最终全景图 <span>交给 JST-2 建环境</span></h4>
        <div className="se-ref-row">{fig(result.files.panorama ?? 'panorama.png', '环境全景图', undefined, { wide: true })}</div>
      </section>
      {!!objs.length && <section>
        <h4>⑤ SAM 3D 物体 <span>环境裁图 → 白模参考 → 画入物体（送 SAM 3D 的图）</span></h4>
        {objs.map((o) => <div key={o.id} className="se-ref-row objs">
          {fig(`objects/${o.id}-env.jpg`, o.label, '环境全景图的裁图')}
          {fig(`objects/${o.id}-guide.jpg`, '白模参考', '同视角的完整白模')}
          {fig(o.crop, o.file ? '画入物体' : '画入物体 · 生成失败', o.spread ? `形状偏差 ${o.spread.toFixed(2)}` : o.error ?? '')}
        </div>)}
      </section>}
      {!!result.expands?.length && <section>
        <h4>⑥ Expand 生成的视角 <span>在你放的相机位置生成，再重建环境</span></h4>
        <div className="se-ref-row">
          {result.expands.filter((e) => e.image).map((e, i) => fig(e.image!, `Expand ${i + 1}`, `(${e.pose.position.map((v) => v.toFixed(1)).join(', ')}) m · 朝向 ${Math.round(e.pose.yaw)}° · ${e.credits} 额度`))}
        </div>
      </section>}
      {prompt && <section>
        <h4>⑦ 全景图提示词</h4>
        <pre className="se-prompt">{prompt}</pre>
      </section>}
      {zoom && <div className="se-zoom" onClick={() => setZoom(null)}><img src={zoom.src} alt="" /><span>{zoom.caption}</span></div>}
    </div>
  );
}
