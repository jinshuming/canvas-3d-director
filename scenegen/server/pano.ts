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

export interface PanoInput {
  prompt: string;
  /** PNG bytes, 2:1. */
  depth: Uint8Array;
  semantic: Uint8Array;
  shaded: Uint8Array;
  seed?: number;
  /** The user's input picture, if the scene came from one: the look to match. */
  styleImage?: { bytes: Uint8Array; mime: string };
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
      form.append('prompt', depthPrompt(input.prompt, Boolean(input.styleImage)));
      const depth = w / h === 2 ? input.depth : await resizeImage(input.depth, w, h, 'png');
      form.append('image[]', new Blob([depth as BlobPart], { type: 'image/png' }), 'depth-equirect.png');
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

export function depthPrompt(caption: string, withStyle: boolean): string {
  return [
    'The first reference image is an EQUIRECTANGULAR DEPTH MAP of a 3D layout, seen from one point: brighter = nearer, black = open sky / far outside.',
    'Paint a photorealistic 360° equirectangular panorama of exactly that space from exactly that point: every wall, opening, piece of furniture and object where the depth map has it, at the same size and distance, with the same horizon and the same distortion toward the top and bottom. Do not add large objects the depth map does not have; small decor is fine.',
    withStyle ? 'The second reference image shows the look to match: its materials, colours and light - not its layout.' : '',
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
