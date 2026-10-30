import type { StageRenderer } from '../StageRenderer.js';
import type { StageDoc } from '../types.js';

/**
 * What the stage tools need from whoever runs them: the doc, a way to change
 * it, the renderer (for anything that looks), and the asset library.
 *
 * The director implements it in the browser, where the renderer lives. A
 * server-side agent loop proxies the same calls to the page (TapNow calls
 * these "client tools"); the edit tools themselves are pure and run anywhere.
 */
export interface StageToolHost {
  /** The latest doc, edits included. */
  getDoc(): StageDoc;
  /** Replace the doc; one undo step per call. */
  update(fn: (d: StageDoc) => StageDoc): void;
  /** Null where nothing renders (a test, a server): the looking tools then say so. */
  renderer: StageRenderer | null;
  assets: AssetSource;
  /** Optional UI hooks: show the agent's work as it goes. */
  ui?: {
    /** Point the viewport at a shot (or back to the free camera) and move the playhead. */
    preview?(p: { shotId?: string | null; time?: number; play?: boolean }): void;
    select?(s: { characterId?: string; shotId?: string } | null): void;
    undo?(): void;
    redo?(): void;
    /** Render a shot to video or a frame to PNG and hand it to the user. */
    exportShot?(shotId: string, kind: 'png' | 'mp4', time?: number): Promise<string>;
  };
}

export type AssetKind = 'scene' | 'character' | 'motion';

export interface AssetRef {
  id: string;
  kind: AssetKind;
  name: string;
  url: string;
  /** Where it came from: Viggle's free presets, or generated for this project. */
  source: 'preset' | 'generated';
  /** Other names it answers to (Chinese, synonyms). */
  aliases?: string[];
  /** Motions: seconds, when known. */
  seconds?: number | null;
  /** Scenes: the Viggle session, so views can be filled later. */
  viggle?: { sessionId: string; batchIds: string[] } | null;
  panoramaUrl?: string | null;
}

export interface GenerationJob {
  id: string;
  kind: AssetKind;
  status: 'processing' | 'ready' | 'failed';
  label: string;
  credits: number;
  assetId: string | null;
  error: string | null;
}

export interface AssetSource {
  list(kind: AssetKind): Promise<AssetRef[]>;
  /** Spends credits. Absent where generation is not set up. */
  generate?(kind: AssetKind, input: Record<string, unknown>): Promise<GenerationJob>;
  jobs?(): Promise<GenerationJob[]>;
}

/** A tool result in the Messages API's `tool_result` content shape. */
export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } }
  >;
  is_error?: boolean;
}
