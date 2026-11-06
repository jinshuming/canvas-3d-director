import { useState } from 'react';

import type { StageAspect } from '@stage';
import { ASPECTS } from '@stage';

import { Icon } from './icons.tsx';
import type { H3Resolution } from './shared/library.ts';
import { H3_MAX_SECONDS, H3_MIN_SECONDS, H3_RESOLUTIONS, h3Credits, h3Duration } from './shared/library.ts';

const ASPECT_LABEL: Record<StageAspect, string> = { '16:9': '16:9 横屏', '9:16': '9:16 竖屏', '1:1': '1:1 方形', '4:3': '4:3', '2.39:1': '2.39:1 宽银幕' };
const FPS = [24, 25, 30];

/** What H3 is asked to make, beyond the previs video it is given. */
export interface H3Options {
  prompt: string;
  resolution: H3Resolution;
  quality: 'low' | 'high';
  /** Let Viggle's planner rewrite the prompt: better, and dearer. */
  enhance: boolean;
}

export interface ExportChoice {
  aspect: StageAspect;
  fps: number;
  /** Set when the video is to be rendered by H3; absent: the previs mp4 itself. */
  h3?: H3Options;
}

interface Props {
  aspect: StageAspect;
  fps: number;
  /** What is exported: the whole edit, or (with no cuts yet) the active shot. */
  what: string;
  /** How long that previs video is, seconds. */
  seconds: number;
  /** The world's title, to start the prompt from. */
  title: string;
  onCancel: () => void;
  onExport: (c: ExportChoice) => void;
}

const DEFAULT_PROMPT = '电影质感。严格保持参考视频里的镜头运动、角色动作、站位和场景构图，补足真实的光影、材质和细节。';

/**
 * The choices an export needs. The previs video is exported as it is (free, at once), or handed to
 * Viggle's MiniMax H3 as the reference video to be rendered into a finished one (credits, minutes).
 */
export function ExportDialog({ aspect, fps, what, seconds, title, onCancel, onExport }: Props) {
  const [a, setA] = useState(aspect);
  const [f, setF] = useState(fps);
  const [mode, setMode] = useState<'previs' | 'h3'>('previs');
  const [prompt, setPrompt] = useState(title && !/^(World \d+|未命名 World)$/.test(title) ? `${title}。${DEFAULT_PROMPT}` : DEFAULT_PROMPT);
  const [resolution, setResolution] = useState<H3Resolution>('768p');
  const [quality, setQuality] = useState<'low' | 'high'>('high');
  const [enhance, setEnhance] = useState(false);

  const length = h3Duration(seconds);
  const credits = h3Credits(length, resolution, enhance);
  const clipped = seconds > H3_MAX_SECONDS + 1e-6;
  const go = () => onExport({ aspect: a, fps: f, ...(mode === 'h3' ? { h3: { prompt: prompt.trim(), resolution, quality, enhance } } : {}) });

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-box" role="dialog" aria-label="导出成片">
        <header className="modal-head">
          <h2>导出成片</h2>
          <button className="pill sm icon" onClick={onCancel} title="关闭"><Icon name="x" size={16} /></button>
        </header>
        <p className="muted small">{what}</p>

        <div className="mode-pick" role="radiogroup" aria-label="输出方式">
          <button role="radio" aria-checked={mode === 'previs'} className={`mode ${mode === 'previs' ? 'on' : ''}`} onClick={() => setMode('previs')}>
            <strong>输出 MP4 · 不渲染</strong>
            <span>直接导出预演画面，免费，马上下载。</span>
          </button>
          <button role="radio" aria-checked={mode === 'h3'} className={`mode ${mode === 'h3' ? 'on' : ''}`} onClick={() => setMode('h3')}>
            <strong>输出 MP4 · 使用 H3 渲染</strong>
            <span>把预演视频交给 Viggle 的 MiniMax H3，生成画面更精致的视频，花额度，需要几分钟。</span>
          </button>
        </div>

        <label className="field"><span>画幅</span>
          <select value={a} onChange={(e) => setA(e.target.value as StageAspect)}>
            {(Object.keys(ASPECTS) as StageAspect[]).map((k) => <option key={k} value={k}>{ASPECT_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="field"><span>帧率</span>
          <select value={f} onChange={(e) => setF(Number(e.target.value))}>
            {FPS.map((v) => <option key={v} value={v}>{v} fps</option>)}
          </select>
        </label>

        {mode === 'h3' && (
          <div className="h3-box">
            <label className="field"><span>画面描述</span>
              <textarea rows={3} value={prompt} maxLength={1000} onChange={(e) => setPrompt(e.target.value)} placeholder="想要什么质感、风格、光线" />
            </label>
            <div className="h3-row">
              <label className="field"><span>分辨率</span>
                <select value={resolution} onChange={(e) => setResolution(e.target.value as H3Resolution)}>
                  {H3_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="field"><span>质量</span>
                <select value={quality} onChange={(e) => setQuality(e.target.value as 'low' | 'high')}>
                  <option value="high">高质量</option><option value="low">快速</option>
                </select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} />让 AI 改写画面描述（更贵）</label>
            <p className="hint-box">
              生成 <strong>{length} 秒</strong> · {resolution} · 约 <strong>{credits} 额度</strong>（${(credits / 100).toFixed(2)}），失败退还。
              {clipped && <> 预演有 {seconds.toFixed(1)} 秒，H3 一次最长 {H3_MAX_SECONDS} 秒，只会用前 {H3_MAX_SECONDS} 秒。</>}
              {seconds < H3_MIN_SECONDS - 1e-6 && <> H3 最短 {H3_MIN_SECONDS} 秒，预演不足时后面由它自己补。</>}
            </p>
          </div>
        )}

        <div className="btn-row modal-actions">
          <button className="pill" onClick={onCancel}>取消</button>
          <button className="pill primary" disabled={mode === 'h3' && !prompt.trim()} onClick={go}>
            <Icon name="download" size={16} />{mode === 'h3' ? `渲染 · ${credits} 额度` : '导出'}
          </button>
        </div>
      </div>
    </div>
  );
}
