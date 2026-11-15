/** Sample layouts for tests and the demo button. Built with the same ops the agent uses. */
import { addOpening, placeObject, setRoom } from './layout.ts';
import { emptyLayout } from './types.ts';
import type { Layout } from './types.ts';

export function livingRoom(): Layout {
  const l = emptyLayout('A cozy scandinavian living room: grey sofa, oak coffee table, bookshelf, plant, big window.');
  l.title = 'Scandinavian living room';
  setRoom(l, { width: 6, depth: 5, height: 2.8 });
  addOpening(l, { kind: 'window', wall: 'east', offset: 0, width: 2.4, height: 1.6, sill: 0.6 });
  addOpening(l, { kind: 'door', wall: 'south', offset: -2 });
  placeObject(l, { type: 'sofa', against: 'north', label: 'grey linen three-seat sofa', id: 'sofa' });
  placeObject(l, { type: 'rug', in_front_of: 'sofa', gap: -0.3, label: 'cream wool rug', id: 'rug' });
  placeObject(l, { type: 'coffee_table', in_front_of: 'sofa', gap: 0.45, label: 'low oak coffee table', id: 'coffee_table' });
  placeObject(l, { type: 'bookshelf', against: 'west', offset: -0.8, label: 'tall white bookshelf full of books', id: 'bookshelf' });
  placeObject(l, { type: 'plant', position: [2.5, -2.0], label: 'fiddle leaf fig in a ceramic pot', id: 'plant' });
  placeObject(l, { type: 'armchair', position: [1.6, 0.3], facing: 'coffee_table', label: 'mustard velvet armchair', id: 'armchair' });
  placeObject(l, { type: 'floor_lamp', left_of: 'sofa', gap: 0.15, label: 'brass floor lamp', id: 'lamp' });
  placeObject(l, { type: 'cabinet', against: 'south', offset: 1, label: 'oak tv sideboard', id: 'sideboard' });
  placeObject(l, { type: 'tv', on: 'sideboard', yaw: 180, label: 'flat tv', id: 'tv' });
  l.style = { summary: 'warm scandinavian, afternoon sun', palette: ['white', 'light oak', 'grey', 'mustard'], materials: 'white plaster walls, light oak floor, linen, wool', lighting: 'soft afternoon sunlight through the east window', timeOfDay: 'afternoon' };
  return l;
}

export function townSquare(): Layout {
  const l = emptyLayout('A small european town square with a fountain, trees, benches and houses around it.');
  l.title = 'Town square';
  l.ground = { size: 60 };
  placeObject(l, { type: 'well', position: [0, -4], label: 'stone fountain', id: 'fountain' });
  placeObject(l, { type: 'building', position: [0, -16], label: 'three-storey yellow town house', id: 'house_n' });
  placeObject(l, { type: 'building', position: [-14, -6], yaw: 90, label: 'red brick bakery', id: 'house_w' });
  placeObject(l, { type: 'building', position: [14, -6], yaw: 270, label: 'white café with awnings', id: 'house_e' });
  placeObject(l, { type: 'tree', position: [-6, -8], label: 'plane tree', id: 'tree_1' });
  placeObject(l, { type: 'tree', position: [6, -8], label: 'plane tree', id: 'tree_2' });
  placeObject(l, { type: 'bench', position: [-3, -1], facing: 'fountain', label: 'green park bench', id: 'bench_1' });
  placeObject(l, { type: 'bench', position: [3, -1], facing: 'fountain', label: 'green park bench', id: 'bench_2' });
  placeObject(l, { type: 'street_lamp', position: [-2, 2], label: 'iron street lamp', id: 'lamp' });
  l.style = { summary: 'sunny european town, late morning', palette: ['ochre', 'terracotta', 'cream', 'green'], materials: 'cobblestones, plaster facades, terracotta roofs', lighting: 'bright late-morning sun, soft shadows', timeOfDay: 'morning' };
  return l;
}
