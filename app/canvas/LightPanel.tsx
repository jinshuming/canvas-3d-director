/**
 * Relight a generated scene (Atlas's Relight): the 3D director's light presets and knobs - where the
 * key light comes from, how high, how strong, its colour, the sky fill, how dark the shadows are,
 * how far characters take it - plus how far the SCENE takes it (`scene`). Saved with the scene and
 * carried into the director when it is sent there.
 */
import { LIGHT_PRESET_LABEL, LIGHT_PRESET_NAMES, LIGHT_PRESETS } from '@stage';

import type { SceneLighting } from '../../scenegen/web/api.ts';
import { Icon } from '../icons.tsx';

interface Knob { key: keyof Omit<SceneLighting, 'preset' | 'color'>; label: string; min: number; max: number; step: number; unit?: string; hint?: string }
const KNOBS: Knob[] = [
  { key: 'azimuth', label: '光从哪来', min: 0, max: 360, step: 5, unit: '°', hint: '0° 从 +Z（场景的南面）照来，90° 从东面' },
  { key: 'elevation', label: '光的高度', min: 0, max: 90, step: 1, unit: '°', hint: '越低影子越长，90° 是正上方' },
  { key: 'intensity', label: '光的强度', min: 0, max: 4, step: 0.1 },
  { key: 'ambient', label: '环境光', min: 0, max: 2, step: 0.05, hint: '暗处太黑时调高' },
  { key: 'shadows', label: '影子深浅', min: 0, max: 1, step: 0.05, hint: '0 没有影子' },
  { key: 'scene', label: '场景受光', min: 0, max: 1, step: 0.05, hint: '新光照替换场景原有光照的程度；0 保持原样，只投影子' },
  { key: 'relight', label: '角色受光', min: 0, max: 1, step: 0.05, hint: '在导演台里，光改变角色原本外观的程度' },
];

export const fromPreset = (name: (typeof LIGHT_PRESET_NAMES)[number], scene = 0.6): SceneLighting => ({ ...LIGHT_PRESETS[name], scene });

export function LightPanel({ lighting, onChange, onClose }: { lighting: SceneLighting | null; onChange: (l: SceneLighting | null) => void; onClose: () => void }) {
  return (
    <div className="se-light">
      <header>
        <Icon name="sparkle" size={15} /><strong>光照</strong>
        <span className="se-spacer" />
        <label className="se-switch"><input type="checkbox" checked={Boolean(lighting)} onChange={(e) => onChange(e.target.checked ? lighting ?? fromPreset('noon') : null)} />{lighting ? '开' : '关（原始光照）'}</label>
        <button className="se-x" onClick={onClose} title="收起"><Icon name="x" size={14} /></button>
      </header>
      <div className="se-presets">
        {LIGHT_PRESET_NAMES.map((n) => <button key={n} className={lighting?.preset === n ? 'on' : ''} onClick={() => onChange(fromPreset(n, lighting?.scene ?? 0.6))}>{LIGHT_PRESET_LABEL[n]}</button>)}
      </div>
      {lighting && <div className="se-knobs">
        {KNOBS.map((k) => (
          <label key={k.key} title={k.hint}>
            <span>{k.label}<b>{k.unit ? Math.round(lighting[k.key]) + k.unit : lighting[k.key].toFixed(2)}</b></span>
            <input type="range" min={k.min} max={k.max} step={k.step} value={lighting[k.key]} onChange={(e) => onChange({ ...lighting, preset: undefined, [k.key]: Number(e.target.value) })} />
          </label>
        ))}
        <label><span>光的颜色</span><input type="color" value={lighting.color} onChange={(e) => onChange({ ...lighting, preset: undefined, color: e.target.value })} /></label>
      </div>}
      <p className="se-light-note">灯光实时作用在 3D 场景上，并随场景一起送到导演台。</p>
    </div>
  );
}
