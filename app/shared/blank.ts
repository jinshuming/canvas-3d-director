import type { StageDoc } from '../../src/stage/types.ts';

export function blankStage(id: string, title: string): StageDoc {
  return {
    id,
    version: 1,
    title,
    duration: 8,
    fps: 24,
    aspect: '16:9',
    scene: null,
    characters: [],
    shots: [],
    updatedAt: new Date().toISOString(),
  };
}
