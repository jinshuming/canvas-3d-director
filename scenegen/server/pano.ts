/**
 * Panorama providers: blockout conditions in, a 2:1 equirect panorama out.
 *
 * - `jst2-reference`: JST-2's own `/v1/scenes/pano` with the caption as the
 *   prompt and the blockout renders as reference images. Needs only the Viggle
 *   key. Also returns JST-2's reconstruction of it, whose floor gives the
 *   panorama's scale for free.
 * - `fal-flux-depth`: FLUX.1 Depth [pro] on fal, conditioned on the blockout's
 *   equirect depth at 2048×1024. Follows the layout most closely. Needs FAL_KEY.
 * - `openai-image`: GPT-image-2 with the equirect depth map as the reference
 *   image (the default when OPENAI_API_KEY works): the layout comes from the
 *   depth, the look from the caption (and the user's photo, if any).
 */
import { Jst2Client, newSessionId } from './jst2.ts';
import { encodePng } from './png.ts';

export interface PanoInput {
  prompt: string;
  /** PNG bytes, 2:1. */
  depth: Uint8Array;
  semantic: Uint8Array;
  shaded: Uint8Array;
  seed?: number;
  /** Hard numbers about the space ("room 6 × 5 m, ceiling 2.8 m, camera 1.5 m up"), stated to the image model. */
  geometry?: string;
  /** The user's input picture, if the scene came from one: the look to match. */
  styleImage?: { bytes: Uint8Array; mime: string };
  /** Also send the clay render (pixel-aligned with the depth map) as a structure reference. */
  withClay?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface PanoOutput {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  /** Provider's own reconstruction (jst2-reference): enough to read the scale off. */
  probeSpz?: Uint8Array;
  credits?: number;
  note?: string;
}

export interface PanoProvider {
  id: string;
  label: string;
  available: boolean;
  generate(input: PanoInput): Promise<PanoOutput>;
}

export function jst2ReferenceProvider(client: Jst2Client, available: boolean): PanoProvider {
  return {
    id: 'jst2-reference',
    label: 'JST-2 (blockout as reference)',
    available,
    async generate(input) {
      input.onProgress?.('JST-2 is painting the panorama from the blockout');
      let task = await client.panoFromPrompt({
        sessionId: newSessionId('sgref'),
        prompt: input.prompt,
        references: [
          { bytes: input.shaded, mime: 'image/png', name: 'blockout-equirect.png' },
          { bytes: input.semantic, mime: 'image/png', name: 'blockout-semantic.png' },
        ],
        quality: 'low',
      });
      const credits = task.credits;
      task = await client.wait(task, { signal: input.signal });
      const pano = task.result!.panorama?.url;
      if (!pano) throw new Error('JST-2 returned no panorama.');
      const [bytes, probeSpz] = await Promise.all([client.download(pano), client.download(task.result!.spz.url)]);
      return { bytes, mime: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg', probeSpz, credits };
    },
  };
}

/**
 * GPT-image-2 painting the panorama with the blockout's EQUIRECT DEPTH MAP as
 * the reference image (optionally also the user's photo for the look). The
 * model returns a 3:2 frame, so the 2:1 depth is squeezed to it on the way in
 * and the result stretched back to 2:1 on the way out: the same horizontal
 * scale both ways, so every pixel keeps its direction.
 */
export function openaiImageProvider(cfg: { apiKey?: string; base?: string; model?: string; size?: string }, f: typeof fetch = (...a) => globalThis.fetch(...a)): PanoProvider {
  const model = cfg.model ?? 'gpt-image-2';
  const size = cfg.size ?? '1536x1024';
  return {
    id: 'openai-image',
    label: `${model} (depth as reference)`,
    available: Boolean(cfg.apiKey),
    async generate(input) {
      if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set.');
      const [w, h] = size.split('x').map(Number) as [number, number];
      input.onProgress?.(`${model} is painting the panorama from the depth map`);
      const form = new FormData();
      form.append('model', model);
      form.append('size', size);
      form.append('n', '1');
      form.append('prompt', depthPrompt(input.prompt, Boolean(input.styleImage), input.geometry, Boolean(input.withClay)));
      const depth = w / h === 2 ? input.depth : await resizeImage(input.depth, w, h, 'png');
      form.append('image[]', new Blob([depth as BlobPart], { type: 'image/png' }), 'depth-equirect.png');
      if (input.withClay) {
        const clay = w / h === 2 ? input.shaded : await resizeImage(input.shaded, w, h, 'png');
        form.append('image[]', new Blob([clay as BlobPart], { type: 'image/png' }), 'clay-equirect.png');
      }
      if (input.styleImage) form.append('image[]', new Blob([input.styleImage.bytes as BlobPart], { type: input.styleImage.mime }), 'style-reference.png');
      const res = await f(`${(cfg.base ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/images/edits`, { method: 'POST', signal: input.signal, headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
      const body = await res.json().catch(() => null) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(`OpenAI image ${res.status}: ${body?.error?.message ?? 'failed'}`);
      const item = body?.data?.[0];
      let bytes: Uint8Array;
      if (item?.b64_json) bytes = new Uint8Array(Buffer.from(item.b64_json, 'base64'));
      else if (item?.url) bytes = new Uint8Array(await (await f(item.url)).arrayBuffer());
      else throw new Error('OpenAI returned no image.');
      // Back to 2:1 equirect.
      const pano = await resizeImage(bytes, 2048, 1024, 'png');
      return { bytes: pano, mime: 'image/png' };
    },
  };
}

export function depthPrompt(caption: string, withStyle: boolean, geometry?: string, withClay = false): string {
  return [
    'The first reference image is an EQUIRECTANGULAR DEPTH MAP of a 3D layout, seen from one point: brighter = nearer, black = no surface (open sky, or the view out through a window or door).',
    withClay ? 'The second reference image is a clay render of the SAME layout from the SAME point, pixel for pixel aligned with the depth map: each flat-coloured shape is one object, outlined in dark lines. Its colours are only labels - take the outlines and positions from it, never its colours or its grey look.' : '',
    'Paint a photorealistic 360° equirectangular panorama of exactly that space from exactly that point: every wall, opening, piece of furniture and object where the depth map has it, at the same size and distance, with the same horizon and the same distortion toward the top and bottom. Do not add large objects the depth map does not have; small decor is fine.',
    'Keep the room the size the depth map shows: the walls and the ceiling stay exactly where it puts them. Do not make the room taller, deeper or wider, do not vault or raise the ceiling, and do not open up walls that are solid in the depth map.',
    geometry ? `Measurements: ${geometry}.` : '',
    withStyle ? `The ${withClay ? 'third' : 'second'} reference image shows the look to match: its materials, colours and light - not its layout, and not any people, characters or creatures in it.` : '',
    'No people, characters, figures, robots, mannequins or animals anywhere in the panorama.',
    'The left and right edges must join seamlessly.',
    caption,
  ].filter(Boolean).join('\n');
}

/** Resize with ffmpeg (on the dev machine; no image library in Node). */
export async function resizeImage(bytes: Uint8Array, w: number, h: number, fmt: 'png' | 'jpg'): Promise<Uint8Array> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${w}:${h}:flags=lanczos`, '-f', 'image2pipe', '-vcodec', fmt === 'png' ? 'png' : 'mjpeg', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(out))) : reject(new Error(`ffmpeg resize failed: ${err.slice(0, 200)}`))));
    p.stdin.end(Buffer.from(bytes));
  });
}

export function falFluxDepthProvider(key: string | undefined, f: typeof fetch = (...a) => globalThis.fetch(...a)): PanoProvider {
  return {
    id: 'fal-flux-depth',
    label: 'FLUX.1 Depth (fal)',
    available: Boolean(key),
    async generate(input) {
      if (!key) throw new Error('FAL_KEY is not set for the scene generator.');
      input.onProgress?.('FLUX depth is painting the panorama');
      const res = await f('https://fal.run/fal-ai/flux-pro/v1/depth', {
        method: 'POST',
        signal: input.signal,
        headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: input.prompt,
          control_image_url: `data:image/png;base64,${Buffer.from(input.depth).toString('base64')}`,
          image_size: { width: 2048, height: 1024 },
          num_inference_steps: 28,
          output_format: 'png',
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        }),
      });
      const body = await res.json().catch(() => null) as { images?: Array<{ url: string }>; detail?: unknown } | null;
      if (!res.ok || !body?.images?.[0]?.url) throw new Error(`fal ${res.status}: ${JSON.stringify(body?.detail ?? body).slice(0, 200)}`);
      const img = await f(body.images[0].url);
      const bytes = new Uint8Array(await img.arrayBuffer());
      return { bytes, mime: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' };
    },
  };
}

export type PeopleCheck = (pano: Uint8Array) => Promise<{ people: boolean; prominent: boolean; note: string }>;

/** Ask a vision model whether a panorama shows people (or characters, robots, animals). */
export function peopleCheck(cfg: { apiKey?: string; base?: string; model: string }, f: typeof fetch = (...a) => globalThis.fetch(...a)): PeopleCheck | undefined {
  if (!cfg.apiKey) return undefined;
  return async (pano) => {
    const small = await resizeImage(pano, 1536, 768, 'jpg');
    const res = await f(`${(cfg.base ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        input: [{ role: 'user', content: [
          { type: 'input_text', text: 'This is a 360° equirectangular panorama of a place. Does it show any person, character, robot, mannequin or animal? "prominent" is true only for one standing or sitting in the space at life size (something a viewer would read as a figure in the room); small decor - figurines, statuettes, toys, pictures or posters - is not prominent. Answer with JSON only: {"people": true|false, "prominent": true|false, "note": "what and where, or empty"}.' },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${Buffer.from(small).toString('base64')}` },
        ] }],
        text: { format: { type: 'json_object' } },
      }),
    });
    const body = await res.json().catch(() => null) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(body?.error?.message ?? `vision ${res.status}`);
    const text = body?.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text ?? '{}';
    const j = JSON.parse(text) as { people?: boolean; prominent?: boolean; note?: string };
    return { people: Boolean(j.people), prominent: Boolean(j.people && j.prominent), note: String(j.note ?? '') };
  };
}

/**
 * Paint ONE object into its crop of the environment's panorama - the perspective view SAM 3D will
 * see. `box` is the object's blockout box projected into the crop; the edit is masked to it (with a
 * margin, more below for the contact shadow) and composited strictly, so the rest is the
 * environment's own pixels. `guide` is the same view of the full blockout's clay render: where the
 * object stands and how big it is. One object per edit: given several at once the model swaps them.
 */
export async function paintObject(cfg: { apiKey?: string; base?: string; model?: string }, input: { image: Uint8Array; guide: Uint8Array; size: number; box: [number, number, number, number]; label: string; style?: string; signal?: AbortSignal }, f: typeof fetch = (...a) => globalThis.fetch(...a)): Promise<Uint8Array> {
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set.');
  const S = input.size;
  const [x0, y0, x1, y1] = input.box;
  const mx = (x1 - x0) * 0.15 + 8, my = (y1 - y0) * 0.15 + 8;
  const bx0 = Math.max(0, Math.floor(x0 - mx)), bx1 = Math.min(S - 1, Math.ceil(x1 + mx));
  const by0 = Math.max(0, Math.floor(y0 - my)), by1 = Math.min(S - 1, Math.ceil(y1 + my * 2));
  const rgba = new Uint8Array(S * S * 4).fill(255);
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) rgba[(y * S + x) * 4 + 3] = 0;
  const [image, guide] = await Promise.all([resizeImage(input.image, S, S, 'png'), resizeImage(input.guide, S, S, 'png')]);
  const form = new FormData();
  form.append('model', cfg.model ?? 'gpt-image-2');
  form.append('size', `${S}x${S}`);
  form.append('n', '1');
  form.append('prompt', [
    'The first image is a photo of a place. The second is a clay blockout of the SAME view, pixel-aligned: the grey blocks show where things stand and how big they are.',
    `In the transparent area of the mask, ADD: ${input.label}. Exactly where and as big as its block in the clay image, facing the way the block faces, standing on the floor (or on what its block stands on).`,
    `Photoreal and complete, in the photo's light and perspective${input.style ? `, ${input.style}` : ''}, with a natural contact shadow. Only ADD this one object: everything already in the photo stays, inside the transparent area too (chairs, plants, other furniture - where the object is in front of them it hides them, where they are in front of it they hide it); outside the transparent area nothing changes at all. No people, no text.`,
  ].filter(Boolean).join('\n'));
  form.append('image[]', new Blob([image as BlobPart], { type: 'image/png' }), 'photo.png');
  form.append('image[]', new Blob([guide as BlobPart], { type: 'image/png' }), 'blockout.png');
  form.append('mask', new Blob([encodePng(rgba, S, S, 4) as BlobPart], { type: 'image/png' }), 'mask.png');
  const res = await f(`${(cfg.base ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/images/edits`, { method: 'POST', signal: input.signal, headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
  const body = await res.json().catch(() => null) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(`OpenAI image edit ${res.status}: ${body?.error?.message ?? 'failed'}`);
  const item = body?.data?.[0];
  const bytes = item?.b64_json ? new Uint8Array(Buffer.from(item.b64_json, 'base64')) : item?.url ? new Uint8Array(await (await f(item.url)).arrayBuffer()) : null;
  if (!bytes) throw new Error('OpenAI returned no image.');
  // The model repaints the whole frame; keep its pixels only under the mask (feathered), the original elsewhere.
  const alpha = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) alpha[i] = rgba[i * 4 + 3]! < 128 ? 255 : 0;
  return composite(image, await resizeImage(bytes, S, S, 'png'), encodePng(feather(alpha, S, S, 6), S, S, 1), S, S);
}

/** Box-blur a 0/255 mask `r` px (twice, so the edge is smooth), wrapping columns. */
function feather(a: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let src = a;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += src[y * w + ((x + k + w) % w)]!; tmp[y * w + x] = s / (2 * r + 1); }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]!; n++; } } out[y * w + x] = s / n; }
    src = out;
  }
  return src;
}

/** base where alpha is 0, top where it is 255, blended between (ffmpeg alphamerge + overlay). */
async function composite(base: Uint8Array, top: Uint8Array, alphaPng: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile: wf, readFile: rf, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'sg-comp-'));
  try {
    await Promise.all([wf(join(dir, 'b.png'), base), wf(join(dir, 't.png'), top), wf(join(dir, 'a.png'), alphaPng)]);
    await new Promise<void>((resolve, reject) => {
      const fc = `[0]scale=${w}:${h},format=rgba[b];[1]scale=${w}:${h},format=rgba[t];[2]scale=${w}:${h},format=gray[a];[t][a]alphamerge[ta];[b][ta]overlay=format=auto,format=rgb24`;
      const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'b.png'), '-i', join(dir, 't.png'), '-i', join(dir, 'a.png'), '-filter_complex', fc, join(dir, 'o.png')]);
      let err = '';
      p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg composite failed: ${err.slice(0, 200)}`))));
    });
    return new Uint8Array(await rf(join(dir, 'o.png')));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

