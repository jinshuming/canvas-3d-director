/** The mock canvas: nodes on an infinite board, kept in this browser only. */

export type NodeKind = 'image' | 'video' | '3d' | 'text' | 'previs' | 'world' | 'scenegen' | 'scenerecon';

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Image nodes: the picture. */
  src?: string;
  /** Text nodes. */
  text?: string;
  /** World nodes: the World project file this node opens. */
  worldId?: string;
  /** 场景生成 / 场景重建 nodes: the scene generator project (scenegen/) this node runs. */
  projectId?: string;
  title?: string;
  /** An example node the canvas added (a finished scene): which input it shows, e.g. 文本. */
  example?: string;
}

export interface CanvasEdge { from: string; to: string }

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  view: { x: number; y: number; zoom: number };
  /** The examples were added once (a later visit does not bring back the ones deleted). */
  examples?: number;
}

export const NODE_LABEL: Record<NodeKind, string> = {
  image: 'Image', video: 'Video', '3d': '3D', text: 'Text', previs: 'Agentic Previs', world: '导演台', scenegen: '场景生成', scenerecon: '场景重建',
};

export const NODE_SIZE: Record<NodeKind, [number, number]> = {
  image: [160, 210], video: [190, 106], '3d': [160, 106], text: [200, 120], previs: [160, 106], world: [260, 190], scenegen: [300, 250], scenerecon: [300, 250],
};

const KEY = 'viggle-director:canvas:v1';

export function loadCanvas(seed: () => CanvasState): CanvasState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as CanvasState;
      // World nodes used to name a stage; a stage became a world with the same id.
      for (const n of s.nodes as Array<CanvasNode & { stageId?: string }>) {
        if (n.stageId && !n.worldId) n.worldId = n.stageId;
        delete n.stageId;
      }
      return s;
    }
  } catch {
    // Private window or bad data: start from the seed.
  }
  return seed();
}

/**
 * Point a World node at another world (the editor's "open here"). The canvas
 * lives in this browser, so the editor writes it directly; the canvas page
 * reads it again when it mounts.
 */
export function bindWorldNode(nodeId: string, worldId: string, title: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const s = loadCanvas(() => JSON.parse(raw) as CanvasState);
    const node = s.nodes.find((n) => n.id === nodeId && n.kind === 'world');
    if (!node) return false;
    node.worldId = worldId;
    node.title = title;
    saveCanvas(s);
    return true;
  } catch {
    return false;
  }
}

/** A new 导演台 node for a scene node's result: to the scene node's right (wire it from there). */
export function worldNodeAfter(from: CanvasNode, worldId: string, title: string): CanvasNode {
  const [w, h] = NODE_SIZE.world;
  return { id: newId(), kind: 'world', x: from.x + from.w + 120, y: from.y + (from.h - h) / 2, w, h, worldId, title };
}

/**
 * The full-screen scene editor sent a scene node's result to a new 导演台: add its node to the
 * stored canvas, as the canvas does itself when the card's own button sends it. Returns its id.
 */
export function appendWorldAfter(fromId: string, worldId: string, title: string): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = loadCanvas(() => JSON.parse(raw) as CanvasState);
    const from = s.nodes.find((n) => n.id === fromId);
    if (!from) return null;
    const node = worldNodeAfter(from, worldId, title);
    s.nodes.push(node);
    s.edges.push({ from: fromId, to: node.id });
    saveCanvas(s);
    return node.id;
  } catch {
    return null;
  }
}

export function saveCanvas(s: CanvasState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not remembered, that's all */ }
}

export const newId = () => `n_${Math.random().toString(36).slice(2, 9)}`;
