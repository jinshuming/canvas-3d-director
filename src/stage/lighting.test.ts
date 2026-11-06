import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_LIGHTING, LIGHT_PRESET_NAMES, LIGHT_PRESETS, normalizeLighting, presetByName } from './lighting.js';

test('every preset is in range and names itself', () => {
  for (const n of LIGHT_PRESET_NAMES) {
    const p = LIGHT_PRESETS[n];
    assert.equal(p.preset, n);
    assert.deepEqual(normalizeLighting(p, p), p, `${n} survives normalising unchanged`);
  }
});

test('a light is clamped into range, azimuth wraps, a bad colour keeps the old one', () => {
  const l = normalizeLighting({ azimuth: -90, elevation: 120, intensity: 9, ambient: -1, shadows: 3, relight: 2, sceneRelight: 1, color: 'red' });
  assert.equal(l.azimuth, 270);
  assert.equal(l.elevation, 90);
  assert.equal(l.intensity, 5);
  assert.equal(l.ambient, 0);
  assert.equal(l.shadows, 1);
  assert.equal(l.relight, 1);
  assert.ok(!('sceneRelight' in l), 'an old world\'s scene tint is dropped, not carried');
  assert.equal(l.color, DEFAULT_LIGHTING.color);
  assert.equal(normalizeLighting({ color: '#ABC' }).color, '#aabbcc');
  assert.equal(normalizeLighting({ azimuth: NaN as number }).azimuth, DEFAULT_LIGHTING.azimuth);
});

test('adjusting a preset leaves it a custom light; changing nothing keeps the preset name', () => {
  const dusk = LIGHT_PRESETS.dusk;
  assert.equal(normalizeLighting({}, dusk).preset, 'dusk');
  assert.equal(normalizeLighting({ elevation: 30 }, dusk).preset, undefined);
  assert.equal(normalizeLighting({ preset: 'night' }, dusk).preset, 'night');
});

test('presets are found by name or by their Chinese name', () => {
  assert.equal(presetByName('dusk'), 'dusk');
  assert.equal(presetByName('黄昏'), 'dusk');
  assert.equal(presetByName(' Night '), 'night');
  assert.equal(presetByName('sunrise'), null);
  assert.equal(presetByName(undefined), null);
});
