/** The director's selection; the doc edits themselves live in `src/stage` (`@stage`). */
export {
  addClip, addShot, clamp, patchCharacter, patchClip, patchKey, patchShot, removeCharacter, removeClip, removeKey, removeShot, round, uid, upsertKey,
} from '@stage';

export type Selection =
  | { kind: 'character'; id: string }
  | { kind: 'clip'; characterId: string; clipId: string }
  | { kind: 'shot'; shotId: string }
  | { kind: 'key'; shotId: string; keyId: string }
  | null;
