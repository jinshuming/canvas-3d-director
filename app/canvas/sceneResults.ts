/** What the scene editor reads from a scenegen project's `result` (the server writes it). */

/** 场景生成: file names are relative to the project's out/ folder. */
export type GenResult = {
  candidates?: Array<{ file: string; objects: number | null; shell: number | null; people: { prominent: boolean; note?: string } | null }>; chosen?: number;
  expands?: Array<{ image: string | null; credits: number; pose: { position: number[]; yaw: number } }>;
  files: Record<string, string | null>; capture: { yaw: number }; credits: number; seconds: Record<string, number>;
  alignment: { within25: number; objectsWithin25: number };
  objects?: Array<{ id: string; label: string; file: string | null; crop: string; spread: number | null; error: string | null }>;
};

/** 场景重建: `mode: 'generate'` is today's route (anchor panorama + JST-2 views along the video's path). */
export type ReconResult = {
  mode?: 'generate'; views: number; credits: number; seconds: Record<string, number>; files?: Record<string, string>;
  anchor?: { index: number; frames: number }; verify?: { points: number; within25: number };
  pathViews?: Array<{ index: number; file: string; image: string | null; position: number[] }>;
};

export const totalSeconds = (seconds: Record<string, number> | undefined) => Math.round(Object.values(seconds ?? {}).reduce((a, b) => a + b, 0));
