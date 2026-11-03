// Helpers shared by the tasks: read the live stage, measure what a shot shows.
import { sampleShot, shotSpan } from '../src/stage/camera.ts';

export const doc = () => window.__director.host.getDoc();
export const stage = () => window.__stage;

export const ang = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
/** The yaw (stage convention: 0 faces -Z) that looks from `a` toward `b`. */
export const yawToward = (a, b) => (Math.atan2(-(b[0] - a[0]), -(b[2] - a[2])) * 180) / Math.PI;
export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const byName = (re) => doc().characters.find((c) => re.test(c.name) || re.test(c.url));
export const VIKING = /viking/i;
export const TRAVELLER = /traveller|windmill-player/i;
export const FRODO = /frodo/i;

export const at = (c, t) => stage().characterAt(c.id, t);
export const clipsOf = (c) => (c ? [...c.clips].sort((a, b) => a.start - b.start) : []);
export const clipLabel = (k) => `${k.name}@${k.start}-${k.end}`;
export const firstClip = (c, re) => clipsOf(c).find((k) => re.test(k.name));
export const lastMoveEnd = (c) => Math.max(0, ...(c?.moves ?? []).map((m) => m.end));

/** Degrees between where a character faces at `t` and the direction of `point`. */
export function facingError(c, t, point) {
  const p = at(c, t);
  return Math.abs(ang(p.yaw - yawToward(p.position, point)));
}

/** The camera of a shot at `t` (default its middle), or null without keys. */
export function camOf(shot, t) {
  const span = shotSpan(shot);
  if (!span) return null;
  return { cam: sampleShot(shot, t ?? (span[0] + span[1]) / 2), span };
}

/** Per shot: at start / middle / end, is each character (all, or those matching `names`) in frame with a clear view? */
export function shotHealth(names) {
  const out = [];
  for (const s of doc().shots) {
    const span = shotSpan(s);
    if (!span) { out.push({ shot: s.name, keys: 0 }); continue; }
    let clear = 0, framed = 0, total = 0, overFloor = 0, samples = 0;
    for (const t of [span[0], (span[0] + span[1]) / 2, span[1]]) {
      const cam = sampleShot(s, t);
      samples++;
      if (stage().floorAt(cam.position[0], cam.position[2], cam.position[1]) !== null) overFloor++;
      for (const f of stage().framing(cam, 16 / 9, t)) {
        const who = doc().characters.find((c) => c.id === f.id);
        if (names && !names.some((n) => n.test(f.name) || (who && n.test(who.url)))) continue;
        total++;
        if (f.line_of_sight === 'clear') clear++;
        if (f.head_in_frame && f.visible > 0.2) framed++;
      }
    }
    out.push({ shot: s.name, keys: s.keys.length, span, clear, framed, total, overFloor, samples });
  }
  return out;
}

/** 0..1 over all shots: the share of (character, moment) samples with a clear view and the head in frame. */
export function shotQuality(health) {
  const shots = health.filter((h) => h.keys > 0 && h.total > 0);
  if (!shots.length) return 0;
  const total = shots.reduce((n, h) => n + h.total, 0);
  const clear = shots.reduce((n, h) => n + h.clear, 0);
  const framed = shots.reduce((n, h) => n + h.framed, 0);
  const floor = shots.reduce((n, h) => n + h.overFloor / h.samples, 0) / shots.length;
  return +((0.4 * clear) / total + (0.4 * framed) / total + 0.2 * floor).toFixed(3);
}

/** Distance from a shot's camera to a point at `t`. */
export const camDistance = (shot, t, point) => {
  const c = sampleShot(shot, t);
  return Math.hypot(c.position[0] - point[0], c.position[1] - point[1], c.position[2] - point[2]);
};

/** Degrees the camera swings round its target between a shot's first and last key. */
export function sweepDeg(shot) {
  const ks = [...shot.keys].sort((a, b) => a.t - b.t);
  if (ks.length < 2) return 0;
  const a = ks[0], b = ks[ks.length - 1];
  return Math.round(Math.abs(ang(yawToward(a.target, a.position) - yawToward(b.target, b.position))));
}

/** The whole-body height share a shot gives a character at `t` (bigger = tighter). */
export function sizeIn(shot, t, c) {
  const cam = sampleShot(shot, t);
  const f = stage().framing(cam, 16 / 9, t).find((x) => x.id === c.id);
  return f ? f.heightInFrame : 0;
}

export const cjkShare = (text) => {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!letters) return 0;
  return (letters.match(/[㐀-鿿]/g) ?? []).length / letters.length;
};
