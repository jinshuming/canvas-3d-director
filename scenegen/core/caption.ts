/**
 * The panorama prompt, compiled from the layout (like Atlas's chiselCaption,
 * but deterministic): the place, its style, and every object with WHERE it is
 * as seen from the capture point (ahead / to the right / behind ...), nearest
 * and most important first. An LLM may rewrite it; this is the fallback and
 * the reference.
 */
import { DEG } from './frame.ts';
import type { CameraPose } from './frame.ts';
import { importanceOf } from './capture.ts';
import type { Layout } from './types.ts';

const DIRS = ['straight ahead', 'ahead to the right', 'to the right', 'behind on the right', 'behind', 'behind on the left', 'to the left', 'ahead to the left'];

export function directionWord(pose: CameraPose, x: number, z: number): { word: string; distance: number; bearing: number } {
  const dx = x - pose.position[0], dz = z - pose.position[2];
  // Bearing clockwise from the camera's forward, degrees.
  const bearing = ((Math.atan2(dx, -dz) / DEG - pose.yaw) % 360 + 360) % 360;
  return { word: DIRS[Math.round(bearing / 45) % 8]!, distance: Math.hypot(dx, dz), bearing };
}

export function compileCaption(layout: Layout, pose: CameraPose): string {
  const place = layout.room
    ? `an interior room about ${layout.room.width} by ${layout.room.depth} metres with a ${layout.room.height} metre ceiling${layout.room.openings.length ? `, ${layout.room.openings.map((o) => `a ${o.kind} in the ${o.wall} wall`).join(', ')}` : ''}`
    : 'an outdoor place';
  const objs = layout.objects
    .map((o, i) => ({ o, w: importanceOf(layout, i), d: directionWord(pose, o.position[0], o.position[2]) }))
    .sort((a, b) => b.w / Math.max(1, b.d.distance) - a.w / Math.max(1, a.d.distance));
  const s = layout.style;
  const head = [
    `A seamless 360-degree equirectangular panorama, photographed from eye height inside ${place}.`,
    layout.prompt ? `Scene: ${layout.prompt}` : '',
    s.summary ? `Style: ${s.summary}.` : '',
    s.materials ? `Materials: ${s.materials}.` : '',
    s.palette.length ? `Palette: ${s.palette.join(', ')}.` : '',
    s.lighting ? `Lighting: ${s.lighting}.` : '',
  ].filter(Boolean).join(' ');
  const tail = 'Photorealistic, level horizon, every object complete, no people, no text.';
  // JST-2 takes at most 1000 characters: objects go in, most important first, while they fit.
  let visible = '';
  for (const { o, d } of objs) {
    const item = `${o.label}${o.material ? ` (${o.material})` : ''} ${d.word} ${d.distance.toFixed(1)} m`;
    const next = visible ? `${visible}; ${item}` : item;
    if (head.length + tail.length + next.length + 14 > LIMIT) break;
    visible = next;
  }
  return [head, visible ? `Visible: ${visible}.` : '', tail].filter(Boolean).join(' ').slice(0, LIMIT);
}

const LIMIT = 1000;
