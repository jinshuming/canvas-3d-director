/**
 * What a selected scene node shows around it, in screen space (it does not scale with the board):
 * an Upload pill above it, a + on each side, and the composer below it.
 *
 *   场景生成  text, a picture and a video, in any combination (and what flows in through edges)
 *   场景重建  a video only
 *
 * Shown while the node waits for its input (or after a failed run); once the task exists the
 * card itself opens the full-screen editor.
 */
import { useRef } from 'react';

import { Icon } from '../icons.tsx';
import type { CanvasNode } from './model.ts';
import type { NodeInputs } from './SceneNodes.tsx';
import { mediaOf, patchDraft, runNode, useDraft } from './sceneDrafts.ts';

export interface ScreenRect { left: number; top: number; width: number; height: number }

export function SceneComposer({ node, rect, inputs, hasServerVideo, ui, onText, onAddText }: {
  node: CanvasNode;
  /** The node's box on screen, relative to the board. */
  rect: ScreenRect;
  inputs: NodeInputs;
  hasServerVideo: boolean;
  ui: number;
  onText: (text: string) => void;
  /** The left +: a Text node wired into this one. */
  onAddText: () => void;
}) {
  const gen = node.kind === 'scenegen';
  const d = useDraft(node.id, node.text ?? '');
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const busy = Boolean(d.local);
  const linkedImage = !d.image && inputs.imageSrc;
  const ready = gen ? Boolean(d.text.trim() || inputs.text || d.image || linkedImage || d.video) : Boolean(d.video || hasServerVideo);
  const send = () => { if (ready && !busy && node.projectId) void runNode(node.kind as 'scenegen' | 'scenerecon', node.id, node.projectId, inputs, hasServerVideo); };
  const upload = () => (gen ? imageInput : videoInput).current?.click();

  const cx = rect.left + rect.width / 2;
  // A fixed width, whatever the board's zoom (it is screen-space UI), but never wider than the window.
  const width = Math.min(720 * ui, window.innerWidth - 48);
  const left = Math.max(24, Math.min(window.innerWidth - width - 24, cx - width / 2));
  return (
    <>
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) patchDraft(node.id, { image: mediaOf(f) }); e.target.value = ''; }} />
      <input ref={videoInput} type="file" accept="video/mp4,video/quicktime" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) patchDraft(node.id, { video: mediaOf(f) }); e.target.value = ''; }} />

      <button className="cv-overlay cv-ov-upload" style={{ left: cx, top: rect.top - 34 * ui }} onClick={upload}><Icon name="upload" size={16} />Upload</button>
      {gen && <button className="cv-overlay cv-ov-plus" style={{ left: rect.left - 34 * ui, top: rect.top + rect.height / 2 }} onClick={onAddText} title="连入一个文本节点"><Icon name="plus" size={14} /></button>}
      <button className="cv-overlay cv-ov-plus" style={{ left: rect.left + rect.width + 34 * ui, top: rect.top + rect.height / 2 }} onClick={() => videoInput.current?.click()} title={gen ? '附上一段视频' : '上传视频'}><Icon name="video" size={13} /></button>

      <div className="cv-overlay cv-composer2" style={{ left, top: rect.top + rect.height + 22 * ui, width }}>
        <div className="cv-c2-tools">
          <button className="cv-c2-tool on" title={gen ? '场景生成' : '场景重建'}><Icon name={gen ? 'scene' : 'camera'} size={17} /></button>
          <span className="cv-c2-sep" />
          {gen && <button className="cv-c2-tool" onClick={() => imageInput.current?.click()} title="附上图片"><Icon name="image" size={17} /></button>}
          <button className="cv-c2-tool" onClick={() => videoInput.current?.click()} title={gen ? '附上视频' : '上传视频'}><Icon name="video" size={17} /></button>
          {inputs.text && <span className="cv-c2-chip linked" title={inputs.text}><Icon name="text" size={12} />{inputs.text.slice(0, 18)}{inputs.text.length > 18 ? '…' : ''}</span>}
          {linkedImage && <span className="cv-c2-chip linked"><img src={inputs.imageSrc!} alt="" />连入的图片</span>}
          {d.image && <span className="cv-c2-chip"><img src={d.image.url} alt="" />{d.image.name}<button onClick={() => patchDraft(node.id, { image: null })}><Icon name="x" size={11} /></button></span>}
          {d.video && <span className="cv-c2-chip"><video src={d.video.url} muted />{d.video.name}<button onClick={() => patchDraft(node.id, { video: null })}><Icon name="x" size={11} /></button></span>}
          {!gen && !d.video && hasServerVideo && <span className="cv-c2-chip linked"><Icon name="video" size={12} />已上传的视频</span>}
        </div>
        {gen
          ? <textarea className="cv-c2-text" value={d.text} disabled={busy} placeholder="描述想要的场景，可以同时附上图片和视频…"
              onChange={(e) => { patchDraft(node.id, { text: e.target.value }); onText(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          : <button className="cv-c2-drop" onClick={() => videoInput.current?.click()} disabled={busy}>
              <Icon name="video" size={20} />{d.video || hasServerVideo ? '换一段视频' : '上传一段视频'}<small>绕着场景慢慢走或平移拍摄 10–60 秒，避免快速转头；只支持视频输入</small>
            </button>}
        <div className="cv-c2-bar">
          <span className="cv-c2-model"><Icon name={gen ? 'sparkle' : 'camera'} size={16} />{gen ? '场景生成 · GPT-image + JST-2' : '场景重建 · COLMAP + JST-2'}</span>
          <span className="cv-c2-sep" />
          {gen
            ? <button className={`cv-c2-opt ${d.objects ? 'on' : ''}`} onClick={() => patchDraft(node.id, { objects: !d.objects })} title="关键物体用 SAM 3D 单独生成"><Icon name="box" size={15} />SAM 3D 物体 · {d.objects ? '开' : '关'}</button>
            : <span className="cv-c2-opt"><Icon name="video" size={15} />锚点全景 + 路径视角</span>}
          <span className="cv-spacer" />
          {d.error && <small className="cv-c2-err" title={d.error}>{d.error}</small>}
          {d.local && <small className="cv-c2-status">{d.local.message}</small>}
          <span className="cv-c2-send">
            <Icon name="credits" size={17} /><span>约 {gen ? 25 : 24}</span>
            <button disabled={!ready || busy || !node.projectId} onClick={send} title={gen ? '生成场景' : '重建场景'}><Icon name="arrowUp" size={18} /></button>
          </span>
        </div>
      </div>
    </>
  );
}
