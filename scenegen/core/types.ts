/**
 * The blockout layout: the single source of truth of a text-to-scene project.
 * World frame: see frame.ts (metres, +Y up, floor y = 0, -Z north).
 */
import type { CameraPose, Vec3 } from './frame.ts';

export type Wall = 'north' | 'south' | 'east' | 'west';

export interface Opening {
  id: string;
  kind: 'door' | 'window';
  wall: Wall;
  /** Centre along the wall, metres from the wall's middle (east/south positive). */
  offset: number;
  width: number;
  height: number;
  /** Bottom edge above the floor (0 for a door). */
  sill: number;
}

export interface Room {
  /** Interior width (x) and depth (z), metres. Centred on the origin. */
  width: number;
  depth: number;
  height: number;
  openings: Opening[];
}

export interface LayoutObject {
  id: string;
  /** Catalog type (catalog.ts), e.g. `sofa`. Unknown types render as a box. */
  type: string;
  /** What it is in words, used in the caption: "a grey linen three-seat sofa". */
  label: string;
  /** Width (x), height (y), depth (z) in metres, before `yaw`. */
  size: Vec3;
  /** Centre of the footprint at its base: [x, y, z], y = height of the surface it stands on. */
  position: Vec3;
  /** Which way the object's FRONT faces, degrees: 0 south (+Z), 90 east (+X), 180 north (-Z), 270 west (-X). */
  yaw: number;
  /** 0-1: how much it matters that the panorama shows it. Default by size. */
  importance?: number;
  /** Optional colour or material hint for the caption. */
  material?: string;
  /** What it stands on (another object's id), if anything. */
  on?: string;
  /** A key object: generated as its own 3D asset (SAM 3D) instead of as part of the environment. */
  key?: boolean;
}

export interface Style {
  /** One line: "warm scandinavian, afternoon sun". */
  summary: string;
  palette: string[];
  materials: string;
  lighting: string;
  timeOfDay?: string;
  weather?: string;
}

export interface Layout {
  version: 1;
  title: string;
  prompt: string;
  /** Indoor: a room. Outdoor: null, and `ground` gives the extent of the ground plane. */
  room: Room | null;
  ground: { size: number };
  objects: LayoutObject[];
  style: Style;
  capture: CameraPose | null;
}

export function emptyLayout(prompt = ''): Layout {
  return {
    version: 1,
    title: 'Untitled scene',
    prompt,
    room: null,
    ground: { size: 40 },
    objects: [],
    style: { summary: '', palette: [], materials: '', lighting: '' },
    capture: null,
  };
}

export const EYE_HEIGHT = 1.5;
