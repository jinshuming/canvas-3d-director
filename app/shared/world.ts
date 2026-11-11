import type { StageDoc } from '../../src/stage/types.ts';
import { blankStage } from './blank.ts';

/**
 * A World project file: everything one World node on the canvas opens - the
 * stage (scene, cast, motions, moves, shots), the conversation with the agent
 * that built it, and a cover - in one JSON document with its own format tag
 * and schema version, so old files can be read and upgraded.
 *
 * On disk, one folder per world (`<dataDir>/worlds/<id>/`): `world.json`
 * (this) and `cover.jpg`. Generated assets live in the shared library
 * (`/files/...`), which worlds point at by URL.
 *
 * The stage keeps its own `version` for the editor's optimistic lock: the
 * stage, the chat and the title are written separately (the editor saves the
 * stage on every edit, the agent panel its transcript after each turn), and
 * the server merges each into the file under a per-world lock.
 */

export const WORLD_FORMAT = 'director.world';
export const WORLD_SCHEMA = 1;

export interface WorldFile {
  format: typeof WORLD_FORMAT;
  schema: typeof WORLD_SCHEMA;
  id: string;
  /** The world's name; the stage's `title` mirrors it. */
  title: string;
  createdAt: string;
  /** Any write: stage, chat, title or cover. */
  updatedAt: string;
  origin: WorldOrigin;
  /** A still of the world, refreshed by the editor; null until there is something to show. */
  cover: { file: string; updatedAt: string } | null;
  stage: StageDoc;
  chat: WorldChat;
}

export type WorldOrigin =
  | { kind: 'blank' }
  | { kind: 'copy'; from: string; fromTitle: string }
  /** Upgraded from a pre-world stage file. */
  | { kind: 'stage'; from: string };

/** The agent conversation that built the world. Pictures are not kept; the words are. */
export interface WorldChat {
  /** The model response the next turn chains on (OpenAI `previous_response_id`); null starts afresh. */
  previousResponseId: string | null;
  items: ChatItem[];
  updatedAt: string | null;
}

/** One line in the chat. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; status: 'running' | 'done' | 'error'; result?: string; image?: string }
  | { kind: 'confirm'; id: string; text: string; answer?: boolean }
  | { kind: 'error'; id: string; text: string };

/** What a list of worlds shows: enough to recognise one and pick it. */
export interface WorldSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The cover, else the scene's panorama, else null. */
  coverUrl: string | null;
  sceneName: string | null;
  characters: number;
  shots: number;
  /** User messages in the chat. */
  prompts: number;
  /** The latest thing the user asked the agent, for "what was this one?". */
  lastPrompt: string | null;
  origin: WorldOrigin;
}

const now = () => new Date().toISOString();

export function newWorld(id: string, title: string, origin: WorldOrigin = { kind: 'blank' }): WorldFile {
  const at = now();
  return {
    format: WORLD_FORMAT, schema: WORLD_SCHEMA, id, title, createdAt: at, updatedAt: at, origin, cover: null,
    stage: blankStage(id, title),
    chat: emptyChat(),
  };
}

export const emptyChat = (): WorldChat => ({ previousResponseId: null, items: [], updatedAt: null });

/** A pre-world stage file as a world: same id, so canvas nodes and links that named it still open it. */
export function worldFromStage(stage: StageDoc): WorldFile {
  return {
    format: WORLD_FORMAT, schema: WORLD_SCHEMA, id: stage.id, title: stage.title,
    createdAt: stage.updatedAt, updatedAt: stage.updatedAt, origin: { kind: 'stage', from: stage.id }, cover: null,
    stage, chat: emptyChat(),
  };
}

/**
 * A new world with another's stage: a fresh conversation (the model's chain
 * belongs to the original), the cover carried over until the editor makes one.
 */
export function copyWorld(src: WorldFile, id: string, title = `${src.title} 副本`): WorldFile {
  const w = newWorld(id, title, { kind: 'copy', from: src.id, fromTitle: src.title });
  w.stage = { ...structuredClone(src.stage), id, title, version: 1, updatedAt: w.createdAt };
  return w;
}

/**
 * Read a world file of any schema this code knows, or throw: the one place
 * that knows old shapes. Fills what older writers left out.
 */
export function readWorld(raw: unknown): WorldFile {
  const w = raw as Partial<WorldFile> | null;
  if (!w || typeof w.format !== 'string' || !w.format.endsWith('.world')) throw new Error('Not a World file.');
  if (typeof w.schema !== 'number' || w.schema > WORLD_SCHEMA) throw new Error(`World schema ${w.schema} is newer than this app understands.`);
  if (!w.id || !w.stage) throw new Error('World file is missing its id or stage.');
  return {
    format: WORLD_FORMAT, schema: WORLD_SCHEMA,
    id: w.id, title: w.title ?? w.stage.title ?? 'World',
    createdAt: w.createdAt ?? w.stage.updatedAt, updatedAt: w.updatedAt ?? w.stage.updatedAt,
    origin: w.origin ?? { kind: 'blank' }, cover: w.cover ?? null,
    stage: { ...w.stage, id: w.id },
    chat: { ...emptyChat(), ...w.chat, items: w.chat?.items ?? [] },
  };
}

/** What a tool step reads when the page went away while it was running. */
export const INTERRUPTED = '（这一步没做完：页面刷新或关闭时它还在运行）';

/** A chat as stored: no pictures (they are large and the model has seen them), no half-finished lines. */
export function storableChat(chat: WorldChat): WorldChat {
  return {
    ...chat,
    items: chat.items
      .filter((x) => x.kind !== 'confirm' || x.answer !== undefined)
      .map((x) => {
        // A step still running when this is stored will never finish (the loop lives in the page): say so.
        if (x.kind === 'tool' && x.status === 'running') return { ...x, image: undefined, status: 'error' as const, result: x.result || INTERRUPTED };
        if (x.kind === 'tool') return { ...x, image: undefined };
        if (x.kind === 'assistant') return { ...x, streaming: undefined };
        return x;
      }),
  };
}

export function summarize(w: WorldFile, coverUrl: (w: WorldFile) => string | null): WorldSummary {
  const prompts = w.chat.items.filter((x): x is Extract<ChatItem, { kind: 'user' }> => x.kind === 'user');
  return {
    id: w.id, title: w.title, createdAt: w.createdAt, updatedAt: w.updatedAt,
    coverUrl: coverUrl(w) ?? w.stage.scene?.panoramaUrl ?? null,
    sceneName: w.stage.scene?.name ?? null,
    characters: w.stage.characters.length,
    shots: w.stage.shots.length,
    prompts: prompts.length,
    lastPrompt: prompts[prompts.length - 1]?.text ?? null,
    origin: w.origin,
  };
}

/** Nothing built and nothing said yet: the editor opens agent-first. */
export function isEmptyWorld(w: Pick<WorldFile, 'stage' | 'chat'>): boolean {
  return !w.stage.scene && !w.stage.characters.length && !w.stage.shots.length && !w.chat.items.length;
}

export const WORLD_ID = /^[A-Za-z0-9_-]{1,64}$/;
