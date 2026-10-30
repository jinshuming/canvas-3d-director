import type { CameraKey, StageCharacter, StageClip, StageDoc, StageMove, StageShot } from './types.js';

/** Pure edits on a StageDoc: each returns a new doc. Shared by the editor UI and the agent tools. */

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function patchCharacter(d: StageDoc, id: string, patch: Partial<StageCharacter>): StageDoc {
  return { ...d, characters: d.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function removeCharacter(d: StageDoc, id: string): StageDoc {
  return { ...d, characters: d.characters.filter((c) => c.id !== id) };
}

export function addClip(d: StageDoc, characterId: string, clip: StageClip): StageDoc {
  return {
    ...d,
    duration: Math.max(d.duration, Math.ceil(clip.end)),
    characters: d.characters.map((c) => (c.id === characterId ? { ...c, clips: [...c.clips, clip] } : c)),
  };
}

export function patchClip(d: StageDoc, characterId: string, clipId: string, patch: Partial<StageClip>): StageDoc {
  return {
    ...d,
    characters: d.characters.map((c) => (c.id !== characterId ? c : {
      ...c, clips: c.clips.map((k) => (k.id === clipId ? { ...k, ...patch } : k)),
    })),
  };
}

export function removeClip(d: StageDoc, characterId: string, clipId: string): StageDoc {
  return { ...d, characters: d.characters.map((c) => (c.id !== characterId ? c : { ...c, clips: c.clips.filter((k) => k.id !== clipId) })) };
}

export function addShot(d: StageDoc, name?: string): { doc: StageDoc; shot: StageShot } {
  const shot: StageShot = { id: uid('shot'), name: name ?? `Shot ${d.shots.length + 1}`, keys: [], interpolation: 'smooth', easing: 'easeInOut' };
  return { doc: { ...d, shots: [...d.shots, shot] }, shot };
}

export function patchShot(d: StageDoc, shotId: string, patch: Partial<StageShot>): StageDoc {
  return { ...d, shots: d.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)) };
}

export function removeShot(d: StageDoc, shotId: string): StageDoc {
  return { ...d, shots: d.shots.filter((s) => s.id !== shotId) };
}

/** Add a key, or replace the one already at (nearly) the same time. */
export function upsertKey(d: StageDoc, shotId: string, key: Omit<CameraKey, 'id'> & { id?: string }): { doc: StageDoc; key: CameraKey } {
  const shot = d.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error('No such shot.');
  const same = key.id ? shot.keys.find((k) => k.id === key.id) : shot.keys.find((k) => Math.abs(k.t - key.t) < 1 / 48);
  const next: CameraKey = { ...key, id: same?.id ?? key.id ?? uid('key') };
  const keys = same ? shot.keys.map((k) => (k.id === same.id ? next : k)) : [...shot.keys, next];
  keys.sort((a, b) => a.t - b.t);
  return { doc: { ...patchShot(d, shotId, { keys }), duration: Math.max(d.duration, Math.ceil(next.t)) }, key: next };
}

export function patchKey(d: StageDoc, shotId: string, keyId: string, patch: Partial<CameraKey>): StageDoc {
  const shot = d.shots.find((s) => s.id === shotId);
  if (!shot) return d;
  const keys = shot.keys.map((k) => (k.id === keyId ? { ...k, ...patch } : k)).sort((a, b) => a.t - b.t);
  return patchShot(d, shotId, { keys });
}

export function removeKey(d: StageDoc, shotId: string, keyId: string): StageDoc {
  const shot = d.shots.find((s) => s.id === shotId);
  return shot ? patchShot(d, shotId, { keys: shot.keys.filter((k) => k.id !== keyId) }) : d;
}

export function addMove(d: StageDoc, characterId: string, move: StageMove): StageDoc {
  return {
    ...d,
    duration: Math.max(d.duration, Math.ceil(move.end)),
    characters: d.characters.map((c) => (c.id === characterId ? { ...c, moves: [...(c.moves ?? []), move].sort((a, b) => a.start - b.start) } : c)),
  };
}

export function removeMove(d: StageDoc, characterId: string, moveId: string): StageDoc {
  return { ...d, characters: d.characters.map((c) => (c.id === characterId ? { ...c, moves: (c.moves ?? []).filter((m) => m.id !== moveId) } : c)) };
}

export const round = (v: number, step = 0.01) => Math.round(v / step) * step;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
