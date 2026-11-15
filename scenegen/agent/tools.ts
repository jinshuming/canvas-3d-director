/**
 * The layout agent's tools. They edit the layout in memory (core/layout.ts)
 * and reach the server through `host` only for the renders and the
 * generation - so they run the same in the page and in a Node test.
 */
import type { CaptureResult } from '../core/capture.ts';
import { checkLayout, describeLayout, addOpening, placeObject, removeObjects, setRoom, updateObject } from '../core/layout.ts';
import type { PlaceSpec } from '../core/layout.ts';
import type { Layout, Wall } from '../core/types.ts';

export interface AgentHost {
  layout: Layout;
  /** Persist the layout (and show it). */
  changed(): void;
  /** The clay render from the capture point, as a URL the model can read (data: URL). */
  look(): Promise<{ image: string; prompt: string }>;
  findCapture(): Promise<CaptureResult>;
  /** Start generation; resolves when it has STARTED (the page shows progress). */
  generate(provider?: string): Promise<{ jobId: string }>;
}

export interface ToolOutput { text: string; image?: string; isError?: boolean }

const WALLS = ['north', 'south', 'east', 'west'];
const NUM = { type: 'number' };
const STR = { type: 'string' };

const PLACE_ITEM = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Catalog type or alias.' },
    id: { type: 'string', description: 'Short id to refer to it later (snake_case).' },
    label: { type: 'string', description: 'What it looks like, with material and colour.' },
    size: { type: 'array', items: NUM, minItems: 3, maxItems: 3, description: '[width, height, depth] m. Omit for the default.' },
    position: { type: 'array', items: NUM, minItems: 2, maxItems: 3, description: '[x, z] or [x, y, z]. Only when no relation fits.' },
    yaw: { ...NUM, description: 'Where its front faces: 0 south, 90 east, 180 north, 270 west.' },
    against: { type: 'string', enum: WALLS },
    on: { ...STR, description: 'Id of the object it stands on.' },
    in_front_of: STR, behind: STR, left_of: STR, right_of: STR, near: STR,
    facing: { ...STR, description: 'Object id or wall it turns to face.' },
    gap: { ...NUM, description: 'Gap to the reference, m (default 0.4).' },
    offset: { ...NUM, description: 'Slide along the wall / sideways, m.' },
    importance: { ...NUM, description: '0-1, how much the panorama must show it.' },
    material: STR,
  },
  required: ['type', 'label'],
};

export const AGENT_TOOLS = [
  { name: 'get_layout', description: 'The layout as text: room, objects (id, type, label, position, size, facing), capture point, style, and any problems.', parameters: { type: 'object', properties: {} } },
  { name: 'set_room', description: 'Make the scene an interior: a rectangular room centred on the origin.', parameters: { type: 'object', properties: { width: NUM, depth: NUM, height: NUM }, required: ['width', 'depth'] } },
  { name: 'set_outdoor', description: 'Make the scene outdoors: a ground plane of this size (m) and sky.', parameters: { type: 'object', properties: { ground_size: NUM } } },
  { name: 'add_opening', description: 'A door or window in a wall. offset = centre along the wall from its middle (east/south positive).', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['door', 'window'] }, wall: { type: 'string', enum: WALLS }, offset: NUM, width: NUM, height: NUM, sill: NUM }, required: ['kind', 'wall'] } },
  { name: 'place_objects', description: 'Place objects, in order (later ones may refer to earlier ones). Returns where each landed, or why it failed.', parameters: { type: 'object', properties: { objects: { type: 'array', items: PLACE_ITEM } }, required: ['objects'] } },
  { name: 'update_object', description: 'Change an object: label, size [w,h,d], position [x,y,z], yaw, importance, material.', parameters: { type: 'object', properties: { id: STR, label: STR, size: { type: 'array', items: NUM }, position: { type: 'array', items: NUM }, yaw: NUM, importance: NUM, material: STR }, required: ['id'] } },
  { name: 'remove_objects', description: 'Remove objects by id.', parameters: { type: 'object', properties: { ids: { type: 'array', items: STR } }, required: ['ids'] } },
  { name: 'check_layout', description: 'Problems: overlaps, floating things, things outside the room, no way through.', parameters: { type: 'object', properties: {} } },
  { name: 'set_style', description: 'The look the panorama is painted with.', parameters: { type: 'object', properties: { title: STR, summary: STR, palette: { type: 'array', items: STR }, materials: STR, lighting: STR, time_of_day: STR, weather: STR }, required: ['summary', 'lighting'] } },
  { name: 'look', description: 'See the blockout as the panorama will frame it: a clay 360° render from the capture point (searched if unset), plus the prompt it would be painted with.', parameters: { type: 'object', properties: {} } },
  { name: 'choose_capture_point', description: 'Search the best place to stand for the panorama (sees the important objects unoccluded, at a good distance, with floor in view) and set it.', parameters: { type: 'object', properties: {} } },
  { name: 'set_capture_point', description: 'Set the capture point by hand: [x, z] at eye height, and the yaw the panorama centre faces (0 north, 90 east).', parameters: { type: 'object', properties: { position: { type: 'array', items: NUM }, yaw: NUM }, required: ['position'] } },
  { name: 'generate_scene', description: 'Paint the panorama from the blockout and build the 3D scene with JST-2 (about 12 credits, about a minute). The page shows the progress.', parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['jst2-reference', 'fal-flux-depth'] } } } },
] as const;

export const OPENAI_TOOLS = AGENT_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));

function issuesText(layout: Layout): string {
  const issues = checkLayout(layout);
  return issues.length ? `Problems:\n${issues.map((i, n) => `${n + 1}. ${i.message}`).join('\n')}` : 'No problems found.';
}

export async function runTool(name: string, args: Record<string, unknown>, host: AgentHost): Promise<ToolOutput> {
  const L = host.layout;
  try {
    switch (name) {
      case 'get_layout': return { text: `${describeLayout(L)}\n${issuesText(L)}` };
      case 'set_room': {
        const r = setRoom(L, { width: Number(args.width), depth: Number(args.depth), height: args.height === undefined ? undefined : Number(args.height) });
        L.capture = null; host.changed();
        return { text: `Room ${r.width}×${r.depth}×${r.height} m.` };
      }
      case 'set_outdoor': {
        L.room = null; L.ground = { size: Number(args.ground_size ?? 40) }; L.capture = null; host.changed();
        return { text: `Outdoors, ground ${L.ground.size} m.` };
      }
      case 'add_opening': {
        const o = addOpening(L, { kind: args.kind as 'door' | 'window', wall: args.wall as Wall, offset: args.offset as number | undefined, width: args.width as number | undefined, height: args.height as number | undefined, sill: args.sill as number | undefined });
        host.changed();
        return { text: `${o.id}: ${o.kind} in the ${o.wall} wall at ${o.offset}, ${o.width}×${o.height} m.` };
      }
      case 'place_objects': {
        const items = (args.objects as PlaceSpec[] | undefined) ?? [];
        const lines: string[] = [];
        let failed = 0;
        for (const spec of items) {
          try {
            const o = placeObject(L, spec);
            lines.push(`${o.id}: ${o.type} at (${o.position.map((v) => v.toFixed(2)).join(', ')}), faces ${o.yaw}°`);
          } catch (e) { failed++; lines.push(`${spec.id ?? spec.type}: FAILED - ${(e as Error).message}`); }
        }
        L.capture = null; host.changed();
        return { text: `${lines.join('\n')}\n${issuesText(L)}`, isError: failed === items.length && items.length > 0 };
      }
      case 'update_object': {
        const { id, ...patch } = args as { id: string } & Record<string, unknown>;
        const o = updateObject(L, id, patch as Parameters<typeof updateObject>[2]);
        L.capture = null; host.changed();
        return { text: `${o.id} now at (${o.position.join(', ')}), size ${o.size.join('×')}, faces ${o.yaw}°.\n${issuesText(L)}` };
      }
      case 'remove_objects': {
        const n = removeObjects(L, (args.ids as string[]) ?? []);
        L.capture = null; host.changed();
        return { text: `Removed ${n}.` };
      }
      case 'check_layout': return { text: issuesText(L) };
      case 'set_style': {
        if (typeof args.title === 'string' && args.title) L.title = args.title;
        L.style = { summary: String(args.summary ?? ''), palette: (args.palette as string[] | undefined) ?? [], materials: String(args.materials ?? ''), lighting: String(args.lighting ?? ''), ...(args.time_of_day ? { timeOfDay: String(args.time_of_day) } : {}), ...(args.weather ? { weather: String(args.weather) } : {}) };
        host.changed();
        return { text: 'Style set.' };
      }
      case 'look': {
        const r = await host.look();
        return { text: `The clay render from the capture point (centre = the panorama's front). Prompt it would be painted with:\n${r.prompt}`, image: r.image };
      }
      case 'choose_capture_point': {
        const c = await host.findCapture();
        L.capture = { position: c.best.position, yaw: c.best.yaw };
        host.changed();
        const hidden = Object.entries(c.best.visible).filter(([, v]) => v < 0.5).map(([k]) => k);
        return { text: `Capture point (${c.best.position.join(', ')}), facing ${c.best.yaw}°, score ${c.best.score} of ${c.evaluated} candidates. Floor in view ${Math.round(c.best.floorShare * 100)}%.${hidden.length ? ` Mostly hidden from here: ${hidden.join(', ')} - move them or accept it.` : ' Every object is visible.'}` };
      }
      case 'set_capture_point': {
        const pos = args.position as number[];
        L.capture = { position: [Number(pos[0]), 1.5, Number(pos[pos.length === 3 ? 2 : 1])], yaw: Number(args.yaw ?? 0) };
        host.changed();
        return { text: `Capture point set at (${L.capture.position.join(', ')}), facing ${L.capture.yaw}°.` };
      }
      case 'generate_scene': {
        if (!L.objects.length) return { text: 'The layout is empty.', isError: true };
        const j = await host.generate(typeof args.provider === 'string' ? args.provider : undefined);
        return { text: `Generation started (${j.jobId}). The page shows its progress; it takes about a minute.` };
      }
      default: return { text: `Unknown tool ${name}.`, isError: true };
    }
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}
