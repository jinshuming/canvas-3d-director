import type { StageLighting } from './types.js';

/**
 * The stage's light: one sun-like key light with a direction, a colour and a strength, a sky fill, and
 * how hard it works on the scene and on the characters. A world with no `lighting` keeps the look the
 * scene and characters were captured with; setting one switches relighting on, and the characters
 * then stand in the scene's light and cast shadows on it.
 *
 * Azimuth is where the light comes FROM, as a compass bearing in the stage: 0 shines from +Z (behind a
 * camera at the capture point looking forward, so on the face of a character looking at it), 90 from
 * +X, 180 from -Z (behind the character: backlight), 270 from -X. Elevation: 0 the horizon, 90 overhead.
 */

export const LIGHT_PRESET_NAMES = ['morning', 'noon', 'dusk', 'night', 'overcast'] as const;
export type LightPresetName = (typeof LIGHT_PRESET_NAMES)[number];

/** Chinese names for the presets, and what a creator calls them. */
export const LIGHT_PRESET_LABEL: Record<LightPresetName, string> = { morning: '清晨', noon: '正午', dusk: '黄昏', night: '夜晚', overcast: '阴天' };

export const LIGHT_PRESETS: Record<LightPresetName, StageLighting> = {
  // Low, warm, from the front-side: long shadows, faces lit.
  morning: { preset: 'morning', azimuth: 40, elevation: 20, intensity: 2.0, color: '#ffd9a8', ambient: 0.7, shadows: 0.75, relight: 1 },
  // High and white: short shadows under the feet.
  noon: { preset: 'noon', azimuth: 20, elevation: 70, intensity: 2.2, color: '#fff6e8', ambient: 0.6, shadows: 0.8, relight: 1 },
  // Almost on the horizon, orange, a long shadow across the floor.
  dusk: { preset: 'dusk', azimuth: 315, elevation: 10, intensity: 1.8, color: '#ff9a55', ambient: 0.7, shadows: 0.85, relight: 1 },
  // Moonlight: dim and blue, soft shadows.
  night: { preset: 'night', azimuth: 335, elevation: 35, intensity: 0.9, color: '#9db8ff', ambient: 0.45, shadows: 0.5, relight: 1 },
  // A flat sky: weak light, faint shadows.
  overcast: { preset: 'overcast', azimuth: 0, elevation: 60, intensity: 1.0, color: '#e9eef5', ambient: 1.0, shadows: 0.2, relight: 0.8 },
};

/** The light a world gets when it is switched on with nothing chosen. */
export const DEFAULT_LIGHTING: StageLighting = LIGHT_PRESETS.noon;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** `#rgb` or `#rrggbb`, lowercase; anything else is the fallback. */
function hex(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fallback;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
}

/** A lighting with every field in range (and no scene tint, which this version no longer has), given a partial one over a base. A change that is not a preset drops the preset name. */
export function normalizeLighting(patch: Partial<StageLighting>, base: StageLighting = DEFAULT_LIGHTING): StageLighting {
  const touched = (['azimuth', 'elevation', 'intensity', 'color', 'ambient', 'shadows', 'relight'] as const).some((k) => patch[k] !== undefined);
  const out: StageLighting = {
    azimuth: ((num(patch.azimuth, base.azimuth) % 360) + 360) % 360,
    elevation: clamp(num(patch.elevation, base.elevation), 0, 90),
    intensity: clamp(num(patch.intensity, base.intensity), 0, 5),
    color: hex(patch.color, base.color),
    ambient: clamp(num(patch.ambient, base.ambient), 0, 2),
    shadows: clamp(num(patch.shadows, base.shadows), 0, 1),
    relight: clamp(num(patch.relight, base.relight), 0, 1),
  };
  const preset = patch.preset !== undefined ? patch.preset : touched ? undefined : base.preset;
  if (preset) out.preset = preset;
  return out;
}

/** The preset by name (or Chinese label), or null. */
export function presetByName(name: unknown): LightPresetName | null {
  const key = String(name ?? '').trim().toLowerCase();
  const byLabel = (Object.keys(LIGHT_PRESET_LABEL) as LightPresetName[]).find((k) => LIGHT_PRESET_LABEL[k] === key);
  if (byLabel) return byLabel;
  return (LIGHT_PRESET_NAMES as readonly string[]).includes(key) ? (key as LightPresetName) : null;
}
