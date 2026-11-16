/**
 * The fast blockout: ONE structured model call turns the user's text (and
 * pictures / video keyframes) into a whole layout spec - room, openings,
 * objects with their relations, style, which objects are key - and the rest is
 * deterministic: place by relation, push overlapping things apart, keep them in
 * the room, search the capture point. Seconds instead of the agent's minute;
 * the agent stays for editing a layout by conversation.
 */
import { catalogSummary, resolveType } from '../core/catalog.ts';
import { findCapturePoint } from '../core/capture.ts';
import { objectBounds } from '../core/geometry.ts';
import { addOpening, checkLayout, placeObject, setRoom } from '../core/layout.ts';
import type { PlaceSpec } from '../core/layout.ts';
import type { Layout, LayoutObject, Wall } from '../core/types.ts';
import { emptyLayout } from '../core/types.ts';

export interface LayoutSpec {
  title: string;
  outdoor: boolean;
  room: { width: number; depth: number; height: number };
  ground_size: number;
  openings: Array<{ kind: 'door' | 'window'; wall: Wall; offset: number; width: number }>;
  objects: Array<{
    id: string; type: string; label: string; width: number; height: number; depth: number;
    relation: 'against' | 'on' | 'in_front_of' | 'behind' | 'left_of' | 'right_of' | 'near' | 'position';
    /** A wall for `against`, an object id for the other relations, '' for `position`. */
    ref: string;
    x: number; z: number; gap: number;
    facing: string;
    key: boolean;
  }>;
  style: { summary: string; palette: string[]; materials: string; lighting: string };
}

const WALLS = ['north', 'south', 'east', 'west'];
const num = { type: 'number' };
const str = { type: 'string' };

const LAYOUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'outdoor', 'room', 'ground_size', 'openings', 'objects', 'style'],
  properties: {
    title: str,
    outdoor: { type: 'boolean' },
    room: { type: 'object', additionalProperties: false, required: ['width', 'depth', 'height'], properties: { width: num, depth: num, height: num } },
    ground_size: num,
    openings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'wall', 'offset', 'width'], properties: { kind: { type: 'string', enum: ['door', 'window'] }, wall: { type: 'string', enum: WALLS }, offset: num, width: num } } },
    objects: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'type', 'label', 'width', 'height', 'depth', 'relation', 'ref', 'x', 'z', 'gap', 'facing', 'key'],
      properties: { id: str, type: str, label: str, width: num, height: num, depth: num,
        relation: { type: 'string', enum: ['against', 'on', 'in_front_of', 'behind', 'left_of', 'right_of', 'near', 'position'] },
        ref: str, x: num, z: num, gap: num, facing: str, key: { type: 'boolean' } } } },
    style: { type: 'object', additionalProperties: false, required: ['summary', 'palette', 'materials', 'lighting'], properties: { summary: str, palette: { type: 'array', items: str }, materials: str, lighting: str } },
  },
} as const;

const QUICK_INSTRUCTIONS = `You turn a description (text, and maybe pictures or video frames of a place) into a 3D blockout layout, in ONE answer.

World: metres, floor y = 0, +X east, -Z north, +Z south. A room is centred on the origin: x from -width/2 to +width/2, z from -depth/2 (north wall) to +depth/2 (south wall).
- Interior: outdoor = false and a room of plausible size (living room 5-7 × 4-6 m, 2.7-3 m high; bedroom 4 × 4; café 8 × 6). Outdoors: outdoor = true, ground_size 30-60, and room is ignored (give 1, 1, 1).
- Openings: doors and windows; offset = centre along the wall from its middle (east/south positive).
- Objects: 4-12 indoors, 4-15 outdoors, in DEPENDENCY ORDER (a thing that refers to another comes after it). Real sizes in metres. A concrete label with material and colour ("grey linen three-seat sofa"). Never people, characters, robots or animals - the scene is an empty place.
- Placement by relation: against (ref = a wall; the object backs onto it and faces into the room), on (ref = the object it stands on), in_front_of / behind / left_of / right_of / near (ref = another object's id; left/right from that object's own point of view), or position (ref = '', x and z given). gap = clearance to the reference in metres (0.3-0.6 typical; 0 for against). x and z are used only for position (else 0).
- facing: an object id or a wall the object turns to face, or ''.
- key = true for the objects that define the scene (furniture pieces, a fountain, a car); false for small props, rugs, built-ins, and anything that belongs to the room itself. Indoors every free-standing thing in the open room becomes its own 3D object whatever key says (key only ranks it first); things placed against a wall are painted with the room.
- Leave walking space. Pictures/video: copy what they show - the same room shape, the same objects where they stand - and take the style from them.
- style: one-line summary, palette, materials, lighting (concrete: light direction, time of day, colour temperature).

Catalog types (type (default w×h×d m; aliases)) - use the closest, or "box" with a good label:
${catalogSummary()}`;

/**
 * Ask the model for the spec (Responses API, strict JSON schema). `images`: one picture, or a
 * walkthrough video's frames; `picture`: a picture added beside the frames.
 */
export async function requestSpec(input: { text: string; images: string[]; picture?: string }, ai: { apiKey?: string; base?: string; model: string }, f: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<LayoutSpec> {
  if (!ai.apiKey) throw Object.assign(new Error('OPENAI_API_KEY is not set on the server.'), { status: 503 });
  const frames = input.images.length > 1 || (input.images.length === 1 && input.picture);
  const lead = [
    frames ? `The first ${input.images.length} pictures are frames of one walkthrough video of the place, in time order: merge them into one layout.` : input.images.length ? 'The picture is the place to build.' : '',
    input.picture && input.images.length ? 'The last picture is a reference the user added: follow it for the look of the place and for anything it shows that the video does not.' : input.picture ? 'The picture is the place to build.' : '',
  ].filter(Boolean).join(' ');
  const pictures = input.picture ? [...input.images, input.picture] : input.images;
  const res = await f(`${ai.base ?? 'https://api.openai.com/v1'}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ai.model,
      instructions: QUICK_INSTRUCTIONS,
      reasoning: { effort: 'low' },
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: [input.text.trim() || 'Build this place.', lead].filter(Boolean).join('\n\n') }, ...pictures.map((u) => ({ type: 'input_image', image_url: u }))] }],
      text: { format: { type: 'json_schema', name: 'layout', schema: LAYOUT_SCHEMA, strict: true } },
    }),
  });
  const body = await res.json().catch(() => null) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; error?: { message?: string } } | null;
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `OpenAI ${res.status}`), { status: res.status === 401 ? 502 : res.status });
  const text = body?.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text;
  if (!text) throw new Error('The model returned no layout.');
  return JSON.parse(text) as LayoutSpec;
}

/** Spec → layout: place by relation (falling back to a free spot), then resolve overlaps and capture. */
export function buildLayout(spec: LayoutSpec, prompt: string): { layout: Layout; keys: string[]; issuesFixed: number } {
  const l = emptyLayout(prompt);
  l.title = spec.title || 'Untitled scene';
  if (spec.outdoor) l.ground = { size: Math.max(20, Math.min(80, spec.ground_size || 40)) };
  else setRoom(l, { width: clamp(spec.room.width, 2.5, 20), depth: clamp(spec.room.depth, 2.5, 20), height: clamp(spec.room.height, 2.2, 6) });
  if (l.room) for (const o of spec.openings) {
    try { addOpening(l, { kind: o.kind, wall: o.wall, offset: o.offset, width: o.width > 0 ? o.width : undefined }); } catch { /* skip */ }
  }
  const keys: string[] = [];
  for (const o of spec.objects) {
    const base: PlaceSpec = { type: resolveType(o.type) ?? 'box', id: o.id, label: o.label, size: [o.width, o.height, o.depth].map((v) => (v > 0 ? v : 0.5)) as [number, number, number], gap: o.gap > 0 ? o.gap : undefined };
    const rel: Partial<PlaceSpec> = o.relation === 'position' ? { position: [o.x, o.z] }
      : o.relation === 'against' ? (WALLS.includes(o.ref) ? { against: o.ref as Wall } : { position: [o.x, o.z] })
      : { [o.relation]: o.ref };
    if (o.facing) rel.facing = o.facing;
    let placed: LayoutObject | null = null;
    for (const attempt of [{ ...base, ...rel }, { ...base, position: [o.x, o.z], facing: o.facing || undefined }, { ...base, position: [0, 0] }]) {
      try { placed = placeObject(l, attempt as PlaceSpec); break; } catch { /* next */ }
    }
    if (placed && o.key) { placed.key = true; keys.push(placed.id); }
  }
  const issuesFixed = separate(l);
  const cap = findCapturePoint(l, { maxCandidates: 250 });
  l.capture = { position: cap.best.position, yaw: cap.best.yaw };
  l.style = { summary: spec.style.summary, palette: spec.style.palette, materials: spec.style.materials, lighting: spec.style.lighting };
  return { layout: l, keys, issuesFixed };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

/**
 * Push overlapping floor objects apart (the smaller one moves), keep them in the room. A few
 * passes are enough for the 4-15 objects a scene has; returns how many overlaps it resolved.
 */
function separate(l: Layout): number {
  const before = checkLayout(l).filter((i) => i.kind === 'overlap').length;
  const flat = new Set(['rug', 'road', 'water']);
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    for (let i = 0; i < l.objects.length; i++) for (let j = i + 1; j < l.objects.length; j++) {
      const a = l.objects[i]!, b = l.objects[j]!;
      if (flat.has(a.type) || flat.has(b.type) || a.on === b.id || b.on === a.id || a.on || b.on) continue;
      const ba = objectBounds(a), bb = objectBounds(b);
      const ox = Math.min(ba.max[0], bb.max[0]) - Math.max(ba.min[0], bb.min[0]);
      const oz = Math.min(ba.max[2], bb.max[2]) - Math.max(ba.min[2], bb.min[2]);
      if (ox <= 0.01 || oz <= 0.01) continue;
      const small = a.size[0] * a.size[2] < b.size[0] * b.size[2] ? a : b, big = small === a ? b : a;
      // Out along the shorter overlap, away from the other one, plus a 5 cm margin.
      if (ox < oz) small.position[0] += Math.sign(small.position[0] - big.position[0] || 1) * (ox + 0.05);
      else small.position[2] += Math.sign(small.position[2] - big.position[2] || 1) * (oz + 0.05);
      if (l.room) {
        const bs = objectBounds(small);
        small.position[0] -= Math.max(0, bs.max[0] - l.room.width / 2) - Math.max(0, -l.room.width / 2 - bs.min[0]);
        small.position[2] -= Math.max(0, bs.max[2] - l.room.depth / 2) - Math.max(0, -l.room.depth / 2 - bs.min[2]);
      }
      for (const o of l.objects) if (o.on === small.id) { o.position[0] = small.position[0]; o.position[2] = small.position[2]; }
      moved = true;
    }
    if (!moved) break;
  }
  return before - checkLayout(l).filter((i) => i.kind === 'overlap').length;
}
