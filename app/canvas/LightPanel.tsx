/**
 * Relighting a scene in the scene editor (Atlas's Relight): the 3D director's light presets and
 * knobs, plus how far the scene itself takes the light (`scene`). Saved with the project and
 * carried into the 导演台 when the scene is sent there.
 */
import { useRef, useState } from 'react';
import { LIGHT_PRESET_LABEL, LIGHT_PRESET_NAMES, LIGHT_PRESETS } from '@stage';

import type { Layout } from '../../scenegen/core/types.ts';
import { api as sg } from '../../scenegen/web/api.ts';
import type { Project, SceneLighting } from '../../scenegen/web/api.ts';
import type { RelightBox } from '../../scenegen/web/SplatViewer.tsx';
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

const fromPreset = (name: (typeof LIGHT_PRESET_NAMES)[number], scene = 0.6): SceneLighting => ({ ...LIGHT_PRESETS[name], scene });

export interface LightingState {
  lighting: SceneLighting | null;
  setLighting: (l: SceneLighting | null) => void;
  open: boolean;
  setOpen: (open: boolean | ((o: boolean) => boolean)) => void;
}

/** The project's lighting: applied live, saved with the project (debounced). */
export function useLighting(project: Project): LightingState {
  const [lighting, set] = useState<SceneLighting | null>(project.lighting ?? null);
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const setLighting = (l: SceneLighting | null) => {
    set(l);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void sg.put(project.id, { lighting: l }).catch(() => {}), 400);
  };
  return { lighting, setLighting, open, setOpen };
}

/** The 光照 tab: names the preset in use while the scene is relit. */
export function LightButton({ light, onClick }: { light: LightingState; onClick: () => void }) {
  const { lighting } = light;
  const name = lighting?.preset ? (LIGHT_PRESET_LABEL as Record<string, string>)[lighting.preset] ?? '自定义' : '自定义';
  return (
    <button className={`se-light-btn${light.open ? ' on' : ''}${lighting ? ' lit' : ''}`} onClick={onClick}>
      <Icon name="sparkle" size={13} />光照{lighting ? ` · ${name}` : ''}
    </button>
  );
}

export function LightPanel({ light }: { light: LightingState }) {
  const { lighting, setLighting: onChange } = light;
  return (
    <div className="se-light">
      <header>
        <Icon name="sparkle" size={15} /><strong>光照</strong>
        <span className="se-spacer" />
        <label className="se-switch"><input type="checkbox" checked={Boolean(lighting)} onChange={(e) => onChange(e.target.checked ? lighting ?? fromPreset('noon') : null)} />{lighting ? '开' : '关（原始光照）'}</label>
        <button className="se-x" onClick={() => light.setOpen(false)} title="收起"><Icon name="x" size={14} /></button>
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

/**
 * Where a generated scene's environment is relit, in the scene file's frame (capture point at the
 * origin): its room a little past the walls, floor to ceiling - a relit area stops at the edge of
 * its box, and at the walls that edge does not show. Outdoors, the ground around the capture point.
 */
export function roomBox(layout: Layout): RelightBox | null {
  const c = layout.capture?.position;
  if (!c) return null;
  if (layout.room) {
    const { width: w, depth: d, height: h } = layout.room;
    return { min: [-w / 2 - c[0] - 0.3, -c[1] - 0.3, -d / 2 - c[2] - 0.3], max: [w / 2 - c[0] + 0.3, h - c[1] + 0.3, d / 2 - c[2] + 0.3] };
  }
  const s = Math.min(15, layout.ground.size / 2);
  return { min: [-s - c[0], -c[1] - 0.5, -s - c[2]], max: [s - c[0], 8 - c[1], s - c[2]] };
}

/** A reconstruction has no blockout room: relight what lies within 8 m of the capture point. */
export const RECON_BOX: RelightBox = { min: [-8, -3, -8], max: [8, 5, 8] };
