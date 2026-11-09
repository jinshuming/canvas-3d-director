import type { CameraSample } from '../camera.js';
import { sampleShot, shotSpan } from '../camera.js';
import type { StageRenderer, StageView } from '../StageRenderer.js';
import type { StageDoc, Vec3Tuple } from '../types.js';
import { ASPECTS } from '../types.js';

/** Wait until the scene, the bodies and their clips have loaded, so a picture shows what the doc says. */
export async function settle(r: StageRenderer, timeoutMs = 20_000): Promise<string[]> {
  const until = performance.now() + timeoutMs;
  for (;;) {
    const s = r.getAssetState();
    if (!s.sceneLoading && !s.sceneColliding && !s.loadingCharacters.length && !s.loadingClips.length) return s.errors;
    if (performance.now() > until) return [...s.errors, 'Some assets were still loading.'];
    await new Promise((res) => setTimeout(res, 150));
  }
}

/**
 * Look through a camera at stage time `t` and return the frame as a canvas,
 * cropped to the stage's aspect. The viewport and clock are put back after.
 * `labels` writes each character's name over them, so a model can tell who is who.
 */
export async function renderStill(
  r: StageRenderer,
  doc: StageDoc,
  camera: CameraSample,
  t: number,
  opts: { width?: number; labels?: boolean; aspect?: number } = {},
): Promise<HTMLCanvasElement> {
  const aspect = opts.aspect ?? ASPECTS[doc.aspect];
  // An edit tool just before may have asked the editor to preview; let that land on
  // the renderer first, or it lands mid-capture and the picture is of the wrong view.
  await new Promise((res) => setTimeout(res, 0));
  await r.frames(1);
  const before: StageView = r.getView();
  const time = r.getTime();
  r.setDoc(doc);
  r.setTime(t);
  r.setView({ kind: 'camera', camera });
  try {
    await settle(r);
    const canvas = await r.capture(aspect, opts.width ?? 768);
    if (opts.labels) label(canvas, r.framing(camera, aspect, t));
    return canvas;
  } finally {
    r.setTime(time);
    r.setView(before);
  }
}

function label(canvas: HTMLCanvasElement, framed: ReturnType<StageRenderer['framing']>): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.font = `600 ${Math.max(12, Math.round(W / 48))}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const f of framed) {
    if (!f.box || f.visible <= 0) continue;
    const [u0, v0, u1, v1] = f.box;
    const text = f.name;
    const w = ctx.measureText(text).width + 12;
    const h = Math.round(W / 48) + 10;
    // Above the head when there is room, else just inside the bottom of the body - never over the face.
    const above = v0 * H - 6;
    const y = above >= h ? above : Math.min(H - 4, v1 * H - 4);
    const x = Math.min(W - w / 2 - 4, Math.max(w / 2 + 4, ((u0 + u1) / 2) * W));
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2, y - h, w, h);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y - 4);
  }
}

/**
 * Looking down on the floor from just under the ceiling, wide: a panorama
 * scene is only whole inside the room, so a camera any higher sees the
 * ceiling or the reconstruction's outer shell. Centred on `centre` (the cast,
 * usually); "up" in the picture is -Z.
 */
export function topDownCamera(centre: readonly [number, number], height = 2.25, fov = 100): CameraSample {
  const [cx, cz] = centre;
  return { position: [cx, height, cz + 0.05], target: [cx, 0, cz], fov };
}

/** What a character sees: from their eyes, the way they face. */
export function povCamera(at: Vec3Tuple, yaw: number, height: number, fov = 60): CameraSample {
  const a = (yaw * Math.PI) / 180;
  const eye: Vec3Tuple = [at[0], at[1] + height * 0.93, at[2]];
  return { position: eye, target: [eye[0] - Math.sin(a) * 3, eye[1] - 0.1, eye[2] - Math.cos(a) * 3], fov };
}

/** Frames of a shot, evenly over its span, tiled into one image with time stamps. */
export async function contactSheet(r: StageRenderer, doc: StageDoc, shotId: string, frames: number): Promise<HTMLCanvasElement> {
  const shot = doc.shots.find((s) => s.id === shotId);
  const span = shot ? shotSpan(shot) : null;
  if (!shot || !span) throw new Error('That shot has no camera keys yet.');
  const n = Math.max(2, Math.min(12, frames));
  const cols = n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const aspect = ASPECTS[doc.aspect];
  const tileW = 288;
  const tileH = Math.round(tileW / aspect);
  const sheet = document.createElement('canvas');
  sheet.width = cols * tileW;
  sheet.height = rows * tileH;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  for (let i = 0; i < n; i++) {
    const t = span[0] + ((span[1] - span[0]) * i) / (n - 1);
    const cam = sampleShot(shot, t)!;
    const tile = await renderStill(r, doc, cam, t, { width: tileW, labels: true });
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * tileH;
    ctx.drawImage(tile, x, y, tileW, tileH);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x + 6, y + 6, 64, 22);
    ctx.fillStyle = '#fff';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${t.toFixed(2)}s`, x + 12, y + 17);
  }
  return sheet;
}

export function toBase64Jpeg(canvas: HTMLCanvasElement, quality = 0.82): string {
  return canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, '');
}
