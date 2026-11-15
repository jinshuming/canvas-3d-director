/** The asset library the server keeps: what Viggle generated, re-hosted under `/files/`, and the jobs making more. */

export interface LibraryScene {
  id: string;
  name: string;
  aliases?: string[];
  url: string;
  panoramaUrl: string | null;
  viggle: { sessionId: string; batchIds: string[] } | null;
  /** The scene this one is a filled-in version of. */
  parentId?: string;
  /** From the scene generator: its blockout (scenegen/core/types.ts Layout), in the scene's own frame. */
  layoutUrl?: string;
  createdAt: string;
}

export interface LibraryCharacter {
  id: string;
  name: string;
  aliases?: string[];
  url: string;
  thumbnailUrl: string | null;
  viggleId: string | null;
  createdAt: string;
}

export interface LibraryMotion {
  id: string;
  name: string;
  aliases?: string[];
  url: string;
  viggleId: string | null;
  createdAt: string;
}

/** Where a fill is: the new view is being generated, then the scene rebuilt from every view it now has. */
export interface FillState {
  /** The library scene being filled; the new one is derived from it. */
  sceneId: string;
  sessionId: string;
  /** Batches the rebuild will read: the scene's own, plus the new view's once it exists. */
  batchIds: string[];
  phase: 'generate' | 'reconstruct';
}

export interface GenJob {
  id: string;
  kind: 'scene' | 'character' | 'motion' | 'fill' | 'h3';
  fill?: FillState;
  /** H3 render: the World it was made from, and the finished video once it is downloaded (`/files/...`). */
  worldId?: string;
  videoUrl?: string;
  /** The Viggle task / character / motion id. */
  remoteId: string;
  label: string;
  status: 'processing' | 'ready' | 'failed';
  /** Credits the submit was charged (refunded by Viggle if it fails). */
  credits: number;
  error: string | null;
  assetId: string | null;
  createdAt: string;
}

export interface Library {
  scenes: LibraryScene[];
  characters: LibraryCharacter[];
  motions: LibraryMotion[];
  jobs: GenJob[];
}

/** Viggle's public gallery assets: usable at once, no credits. */
const CDN = 'https://assets.viggle.ai/pub/www/jst2-gallery/';

export const PRESET_SCENES: LibraryScene[] = [
  { id: 'pre_attic', name: 'Attic hideaway', url: `${CDN}attic-cabin-8873bda3.sog`, panoramaUrl: null, viggle: null, createdAt: '' },
  { id: 'pre_hobbit', name: 'Hobbit hole', url: `${CDN}hobbit-faea6bf0.sog`, panoramaUrl: null, viggle: null, createdAt: '' },
  { id: 'pre_arena', name: 'Arena', aliases: ['竞技场'], url: `${CDN}arena-4ac5da9b.sog`, panoramaUrl: null, viggle: null, createdAt: '' },
  { id: 'pre_blue', name: 'Blue room', url: `${CDN}blue-room-e859178c.sog`, panoramaUrl: null, viggle: null, createdAt: '' },
];

export const PRESET_CHARACTERS: LibraryCharacter[] = [
  { id: 'pre_frodo', name: 'Frodo', aliases: ['霍比特人', 'hobbit', '少年'], url: `${CDN}rivendell-frodo-17a70101.vsplat` },
  { id: 'pre_viking', name: 'Viking', aliases: ['维京', '维京女战士', '女战士', '女人'], url: `${CDN}viking-woman-p01-f09477b2.vsplat` },
  { id: 'pre_traveller', name: 'Traveller', aliases: ['旅行者', '旅人', '男人'], url: `${CDN}windmill-player-3b5fc511.vsplat` },
  { id: 'pre_villager_a', name: 'Villager A', aliases: ['村民', '村民A'], url: `${CDN}windmill-npc-r02-new1011-04-p04-vsplat-0dd47fa9.vsplat` },
  { id: 'pre_villager_b', name: 'Villager B', aliases: ['村民', '村民B'], url: `${CDN}windmill-npc-r14-new1011-12-p04-vsplat-d8701b3c.vsplat` },
  { id: 'pre_attic', name: 'Attic', aliases: ['阁楼角色'], url: `${CDN}attic-cabin-character-40d389ae.vsplat` },
  { id: 'pre_arena', name: 'Arena', aliases: ['竞技场角色'], url: `${CDN}arena-character-0c9edb65.vsplat` },
].map((c) => ({ ...c, thumbnailUrl: null, viggleId: null, createdAt: '' }));

export const PRESET_MOTIONS: LibraryMotion[] = [
  { id: 'pre_idle', name: 'Idle', aliases: ['待机', '站着', '站立', 'stand'], url: `${CDN}pinoc-standing-idle-3e1a1f20.glb` },
  { id: 'pre_walk', name: 'Walk', aliases: ['走', '走路', '行走'], url: `${CDN}pinoc-walking-a0293881.glb` },
  { id: 'pre_run', name: 'Run', aliases: ['跑', '奔跑', '跑步'], url: `${CDN}pinoc-running-1902fd18.glb` },
  { id: 'pre_jump', name: 'Jump', aliases: ['跳', '跳跃'], url: `${CDN}pinoc-jump-75ac6fd5.glb` },
  { id: 'pre_wave', name: 'Wave', aliases: ['挥手', '打招呼', '招手'], url: `${CDN}windmill-npc-react-wavehello-glb-640ca1ec.glb` },
  { id: 'pre_greet', name: 'Greet', aliases: ['问候', '打招呼', '致意'], url: `${CDN}windmill-npc-react-friendlygreeting-glb-1de231ee.glb` },
  { id: 'pre_nod', name: 'Nod', aliases: ['点头', '同意'], url: `${CDN}windmill-npc-react-nodyes-glb-456f8c82.glb` },
  { id: 'pre_point', name: 'Point', aliases: ['指', '指向', '指着'], url: `${CDN}windmill-npc-react-pointforward-glb-8a1e9d33.glb` },
  { id: 'pre_beckon', name: 'Beckon', aliases: ['招手示意', '叫过来', '过来'], url: `${CDN}windmill-npc-react-beckon-glb-4622ae67.glb` },
  { id: 'pre_surprise', name: 'Surprise', aliases: ['惊讶', '吃惊', '惊喜'], url: `${CDN}windmill-npc-react-pleasantsurprise-glb-b9a039e6.glb` },
  { id: 'pre_cheer', name: 'Cheer', aliases: ['欢呼', '庆祝', '欢庆', '高兴'], url: `${CDN}cheer-5e381c61.glb` },
  { id: 'pre_clap', name: 'Clap', aliases: ['鼓掌', '拍手'], url: `${CDN}su-clapping-cafee4b2.glb` },
  { id: 'pre_talk', name: 'Talk', aliases: ['说话', '讲话', '交谈', '对话'], url: `${CDN}windmill-interaction-conversation-speak-c4d5660f.glb` },
  { id: 'pre_listen', name: 'Listen', aliases: ['听', '倾听', '聆听'], url: `${CDN}windmill-interaction-conversation-listen-9332af0f.glb` },
  { id: 'pre_turn', name: 'Turn around', aliases: ['转身', '回头', '转过身'], url: `${CDN}windmill-interaction-turn-180-9bb354a5.glb` },
].map((m) => ({ ...m, viggleId: null, createdAt: '' }));

/** Credits each generation costs (docs.viggle.ai/v1/pricing). */
export const COSTS = { scene: 6, character: 30, motion: 10 } as const;

/**
 * What filling one view of a generated scene costs, in credits (Viggle's public prices): the new
 * view is 1, and the rebuild is 1 per view the scene will then hold - the 6 of the panorama, 1 per
 * earlier fill, and the new one. `batches` is how many image batches the scene has now.
 */
export function fillCredits(batches: number): number {
  const views = 6 + Math.max(0, batches - 1);
  return 1 + views + 1;
}

// ── H3: the previs video, rendered by Viggle's MiniMax H3 video model ─────────

export const H3_RESOLUTIONS = ['480p', '768p', '1080p', '2k', '4k'] as const;
export type H3Resolution = (typeof H3_RESOLUTIONS)[number];

/** Credits per 5 seconds in reference-video mode (Viggle's prices), with the prompt-rewrite pass on and off. */
const H3_PER_5S: Record<'on' | 'off', Record<H3Resolution, number>> = {
  on: { '480p': 35, '768p': 45, '1080p': 50, '2k': 55, '4k': 75 },
  off: { '480p': 15, '768p': 25, '1080p': 30, '2k': 35, '4k': 55 },
};

/** H3 makes 5 to 15 seconds in one go. */
export const H3_MIN_SECONDS = 5;
export const H3_MAX_SECONDS = 15;

/** The length H3 is asked for, for a previs video this long: whole seconds, within what it can make. */
export function h3Duration(previsSeconds: number): number {
  return Math.min(H3_MAX_SECONDS, Math.max(H3_MIN_SECONDS, Math.ceil(previsSeconds - 1e-6)));
}

/** Credits for an H3 render: per started second, at the rate for its resolution. */
export function h3Credits(durationS: number, resolution: H3Resolution, enhance: boolean): number {
  return Math.ceil(durationS) * (H3_PER_5S[enhance ? 'on' : 'off'][resolution] / 5);
}

/** The frame shapes H3 takes; the stage's 2.39:1 is its 21:9. */
export const H3_ASPECT: Record<string, string> = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1', '4:3': '4:3', '2.39:1': '21:9' };
