/** The mock canvas: nodes on an infinite board, kept in this browser only. */

export type NodeKind = 'image' | 'video' | '3d' | 'text' | 'previs' | 'world';

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
  /** World nodes: the stage this node opens. */
  stageId?: string;
  title?: string;
}

export interface CanvasEdge { from: string; to: string }

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  view: { x: number; y: number; zoom: number };
}

export const NODE_LABEL: Record<NodeKind, string> = {
  image: 'Image', video: 'Video', '3d': '3D', text: 'Text', previs: 'Agentic Previs', world: 'World',
};

export const NODE_SIZE: Record<NodeKind, [number, number]> = {
  image: [160, 210], video: [190, 106], '3d': [160, 106], text: [200, 120], previs: [160, 106], world: [240, 172],
};

const KEY = 'viggle-director:canvas:v1';

export function loadCanvas(seed: () => CanvasState): CanvasState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as CanvasState;
  } catch {
    // Private window or bad data: start from the seed.
  }
  return seed();
}

export function saveCanvas(s: CanvasState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not remembered, that's all */ }
}

export const newId = () => `n_${Math.random().toString(36).slice(2, 9)}`;
