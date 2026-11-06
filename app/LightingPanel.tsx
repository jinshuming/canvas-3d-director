import type { StageDoc, StageLighting } from '@stage';
import { DEFAULT_LIGHTING, LIGHT_PRESET_LABEL, LIGHT_PRESET_NAMES, LIGHT_PRESETS, normalizeLighting } from '@stage';

import { Icon } from './icons.tsx';
import type { StageStore } from './useStage.ts';

interface Props {
  doc: StageDoc;
  update: StageStore['update'];
  onClose: () => void;
}

interface Knob { key: keyof Omit<StageLighting, 'preset' | 'color' | 'sceneRelight'>; label: string; min: number; max: number; step: number; unit?: string; hint?: string }

const KNOBS: Knob[] = [
  { key: 'azimuth', label: '光从哪来', min: 0, max: 360, step: 5, unit: '°', hint: '0° 在镜头身后，照亮面向镜头的角色；90° 在画面右侧；180° 在角色身后（逆光、剪影）；270° 在画面左侧' },
  { key: 'elevation', label: '光的高度', min: 0, max: 90, step: 1, unit: '°', hint: '越低影子越长，90° 是正上方' },
  { key: 'intensity', label: '光的强度', min: 0, max: 4, step: 0.1 },
  { key: 'ambient', label: '环境光', min: 0, max: 2, step: 0.05, hint: '脸太暗时调高' },
  { key: 'shadows', label: '影子深浅', min: 0, max: 1, step: 0.05, hint: '0 没有影子' },
  { key: 'relight', label: '角色受光', min: 0, max: 1, step: 0.05, hint: '光改变角色原本外观的程度' },
];

/**
 * The world's light: a preset to start from, then the direction, height, strength and colour of the sun,
 * the sky fill, and how dark the shadows are. With no light the scene and characters keep the look they
 * were captured with; with one, characters stand in the scene's light and cast shadows on it.
 */
export function LightingPanel({ doc, update, onClose }: Props) {
  const light = doc.lighting ?? null;
  const set = (next: StageLighting | null, commit = true) => update((d) => ({ ...d, lighting: next }), { commit });
  // Ending a drag is one undo step: the same light, as a new object, committed.
  const settle = () => update((d) => (d.lighting ? { ...d, lighting: { ...d.lighting } } : d));

  return (
    <aside className="float library-card light-card">
      <header className="lib-head">
        <button className="ghost-icon" onClick={onClose} title="收起"><Icon name="chevronLeft" size={20} /></button>
        <h2>光影</h2>
      </header>
      <div className="lib-scroll">
        <p className="hint-box">给场景加一束太阳光：角色会站在场景的光里，并在地面上留下影子。不开光影时，场景和角色保持原本的样子。</p>

        <div className="chips">
          <button className={`chip-btn ${!light ? 'on' : ''}`} onClick={() => set(null)}>关</button>
          {LIGHT_PRESET_NAMES.map((n) => (
            <button key={n} className={`chip-btn ${light?.preset === n ? 'on' : ''}`} onClick={() => set({ ...LIGHT_PRESETS[n] })}>{LIGHT_PRESET_LABEL[n]}</button>
          ))}
        </div>

        {!light && <button className="pill primary" onClick={() => set({ ...DEFAULT_LIGHTING })}><Icon name="bulb" size={16} />开启光影</button>}

        {light && (
          <div className="gen light-knobs">
            {KNOBS.map((k) => (
              <label key={k.key} className="knob" title={k.hint}>
                <span className="knob-label">{k.label}<em>{k.key === 'azimuth' || k.key === 'elevation' ? Math.round(light[k.key]) : light[k.key].toFixed(2)}{k.unit ?? ''}</em></span>
                <input type="range" min={k.min} max={k.max} step={k.step} value={light[k.key]}
                  onChange={(e) => set(normalizeLighting({ [k.key]: Number(e.target.value) }, light), false)}
                  onPointerUp={settle} onKeyUp={settle} onBlur={settle} />
                {k.hint && <span className="muted small">{k.hint}</span>}
              </label>
            ))}
            <label className="knob">
              <span className="knob-label">光的颜色<em>{light.color}</em></span>
              <input type="color" value={light.color} onChange={(e) => set(normalizeLighting({ color: e.target.value }, light), false)} onBlur={settle} />
            </label>
          </div>
        )}
      </div>
    </aside>
  );
}
