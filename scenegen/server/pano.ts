/**
 * Panorama providers: blockout conditions in, a 2:1 equirect panorama out.
 *
 * - `jst2-reference`: JST-2's own `/v1/scenes/pano` with the caption as the
 *   prompt and the blockout renders as reference images. Needs only the Viggle
 *   key. Also returns JST-2's reconstruction of it, whose floor gives the
 *   panorama's scale for free.
 * - `fal-flux-depth`: FLUX.1 Depth [pro] on fal, conditioned on the blockout's
 *   equirect depth at 2048×1024. Follows the layout most closely. Needs FAL_KEY.
 * - `upload`: a panorama the user brings.
 */
import { Jst2Client, newSessionId } from './jst2.ts';

export interface PanoInput {
  prompt: string;
  /** PNG bytes, 2:1. */
  depth: Uint8Array;
  semantic: Uint8Array;
  shaded: Uint8Array;
  seed?: number;
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
