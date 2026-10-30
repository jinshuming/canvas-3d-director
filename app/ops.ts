/** The director's selection; the doc edits themselves live in `src/stage` (`@stage`). */
export {
  addClip, addShot, cutTo, moveCutEnd, patchCut, removeCut, sortedCuts, clamp, patchCharacter, patchClip, patchKey, patchShot, removeCharacter, removeClip, removeKey, removeShot, round, uid, upsertKey,
} from '@stage';

export type Selection =
  | { kind: 'character'; id: string }
  | { kind: 'clip'; characterId: string; clipId: string }
  | { kind: 'shot'; shotId: string }
  | { kind: 'key'; shotId: string; keyId: string }
  | { kind: 'cut'; cutId: string }
  | null;

/** A colour per shot, by its place in the list: the edit track and the shot card share it. */
const SHOT_COLORS = ['#5eb1ff', '#ffb547', '#3ccf8e', '#c78bff', '#ff7a8a', '#4fd1c5'];
export const shotColor = (index: number) => SHOT_COLORS[((index % SHOT_COLORS.length) + SHOT_COLORS.length) % SHOT_COLORS.length]!;
