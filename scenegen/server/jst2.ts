/**
 * JST-2 (Viggle Scene API, `/v1/scenes/*`) client for the scene generator.
 *
 * The API keeps no scene: a scene is an ordered list of batch ids under a
 * session id the caller chooses. Every submit returns a task at once; poll
 * `GET /v1/scenes/{id}` until it is `ready`.
 *
 * `posedImages` is the endpoint the scene generator NEEDS for video input and
 * the API does not have yet (2026-11-15). Its shape follows the existing batch
 * model - images, each with a camera-to-world matrix and normalised pinhole
 * intrinsics - and is written down in docs/SCENEGEN_DESIGN.md §3.2. Until it
 * exists, point `posedImagesBase` at the mock in `mockjst2.ts`.
 */

export type C2W = number[][];

export interface SceneBatchView { index: number; url: string; c2w: C2W; intrinsic: number[] }
export interface SceneBatch { batchId: string; createdAt: number; kind: string; views: SceneBatchView[] }
export interface SceneResult {
  operation: string;
  sessionId: string;
  outputBatch: SceneBatch | null;
  spz: { url: string };
  preview: { url: string } | null;
  panorama: { url: string } | null;
  referenceViewCount: number;
  newViewCount: number;
  seconds: Record<string, number>;
}
export interface SceneTask {
  id: string;
  sessionId: string;
  operation: string;
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';
  result: SceneResult | null;
  error: { code: string; message: string } | null;
  credits?: number;
}

export interface PosedView {
  /** JPEG or PNG bytes. */
  image: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
  c2w: C2W;
  /** [fx, fy, cx, cy]: fx and cx divided by the image width, fy and cy by its height. */
  intrinsic: number[];
}

export interface Jst2Options {
  apiKey?: string;
  base?: string;
  /** Where `posed-images` lives (a function: read at each call). Default `base`. */
  posedImagesBase?: string | (() => string);
  fetch?: typeof fetch;
}

export class Jst2Error extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'Jst2Error'; }
}

export const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_VIEWS = 40;

export function newSessionId(prefix = 'sg'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export class Jst2Client {
  private readonly base: string;
  private readonly posedBaseOf: () => string;
  private readonly f: typeof fetch;
  constructor(private readonly opts: Jst2Options) {
    this.base = (opts.base ?? 'https://apis.viggle.ai').replace(/\/$/, '');
    const pb = opts.posedImagesBase;
    this.posedBaseOf = () => (typeof pb === 'function' ? pb() : pb ?? this.base).replace(/\/$/, '');
    this.f = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  /** `POST /v1/scenes/pano` from a prompt and up to 8 reference images (files). */
  panoFromPrompt(input: { sessionId: string; prompt: string; references?: Array<{ bytes: Uint8Array; mime: string; name: string }>; quality?: 'low' | 'medium' | 'high' }): Promise<SceneTask> {
    const refs = input.references ?? [];
    if (refs.length > 8) throw new Jst2Error('At most 8 reference images.', 400);
    if (!refs.length) return this.json(this.base, '/v1/scenes/pano', { sessionId: input.sessionId, prompt: input.prompt, quality: input.quality ?? 'low' });
    const form = new FormData();
    form.append('sessionId', input.sessionId);
    form.append('prompt', input.prompt);
    form.append('quality', input.quality ?? 'low');
    for (const r of refs) form.append('referenceImageFiles', new Blob([r.bytes as BlobPart], { type: r.mime }), r.name);
    return this.send(this.base, '/v1/scenes/pano', form);
  }

  /** `POST /v1/scenes/custom-pano`: a 2:1 panorama placed at `c2w` (OpenCV axes) in the caller's world. */
  customPano(input: { sessionId: string; panorama: Uint8Array; mime: string; c2w: C2W; metersPerUnit?: number }): Promise<SceneTask> {
    checkC2W(input.c2w);
    const form = new FormData();
    form.append('sessionId', input.sessionId);
    form.append('panoramaC2w', JSON.stringify(input.c2w));
    if (input.metersPerUnit !== undefined) form.append('metersPerUnit', String(input.metersPerUnit));
    form.append('panorama', new Blob([input.panorama as BlobPart], { type: input.mime }), input.mime === 'image/png' ? 'panorama.png' : 'panorama.jpg');
    return this.send(this.base, '/v1/scenes/custom-pano', form);
  }

  /** `POST /v1/scenes/generate`. */
  generate(input: { sessionId: string; referenceBatchIds: string[]; targetC2w: C2W; projection?: 'perspective' | 'pano'; fov?: number; seed?: number }): Promise<SceneTask> {
    checkC2W(input.targetC2w);
    return this.json(this.base, '/v1/scenes/generate', { projection: 'perspective', ...input });
  }

  /** `POST /v1/scenes/reconstruct`. */
  reconstruct(input: { sessionId: string; referenceBatchIds: string[] }): Promise<SceneTask> {
    return this.json(this.base, '/v1/scenes/reconstruct', input);
  }

  /**
   * PROPOSED `POST /v1/scenes/posed-images` (not yet on the API): a batch made from the caller's
   * own images and cameras, and a scene rebuilt from it. Multipart: `sessionId`, `views` (JSON:
   * `[{ c2w, intrinsic }]`, in the order of the files), `imageFiles` (one per view), optional
   * `metersPerUnit`. Returns a task like the others; its `outputBatch.kind` is `uploaded`.
   */
  async posedImages(input: { sessionId: string; views: PosedView[]; metersPerUnit?: number }): Promise<SceneTask> {
    if (input.views.length < 1 || input.views.length > MAX_VIEWS) throw new Jst2Error(`Send 1-${MAX_VIEWS} views.`, 400);
    for (const v of input.views) {
      checkC2W(v.c2w);
      if (v.intrinsic.length !== 4 || v.intrinsic.some((x) => !(x > 0) || x > 4)) throw new Jst2Error('intrinsic must be [fx, fy, cx, cy], normalised by the image size.', 400);
    }
    const form = new FormData();
    form.append('sessionId', input.sessionId);
    form.append('views', JSON.stringify(input.views.map((v) => ({ c2w: v.c2w, intrinsic: v.intrinsic }))));
    if (input.metersPerUnit !== undefined) form.append('metersPerUnit', String(input.metersPerUnit));
    input.views.forEach((v, i) => form.append('imageFiles', new Blob([v.image as BlobPart], { type: v.mime }), `${String(i).padStart(4, '0')}${v.mime === 'image/png' ? '.png' : '.jpg'}`));
    return this.send(this.posedBaseOf(), '/v1/scenes/posed-images', form);
  }

  async get(taskId: string, base = this.base): Promise<SceneTask> {
    const res = await this.f(`${base}/v1/scenes/${encodeURIComponent(taskId)}`, { headers: this.headers() });
    return await this.read(res) as SceneTask;
  }

  /** Poll until the task is final. Throws on `failed` / `cancelled`. */
  async wait(task: SceneTask, opts: { intervalMs?: number; timeoutMs?: number; onUpdate?: (t: SceneTask) => void; base?: string; signal?: AbortSignal } = {}): Promise<SceneTask> {
    const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
    let t = task;
    while (t.status === 'queued' || t.status === 'processing') {
      if (Date.now() > deadline) throw new Jst2Error(`Task ${t.id} did not finish in time.`, 504);
      opts.signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3000));
      t = await this.get(t.id, opts.base);
      opts.onUpdate?.(t);
    }
    if (t.status !== 'ready' || !t.result) throw new Jst2Error(t.error?.message ?? `Task ${t.id} ended ${t.status}.`, 502, t.error?.code);
    return t;
  }

  async download(url: string): Promise<Uint8Array> {
    const res = await this.f(url);
    if (!res.ok) throw new Jst2Error(`Download failed (${res.status}).`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  private headers(): Record<string, string> {
    if (!this.opts.apiKey) throw new Jst2Error('VIGGLE_API_KEY is not set on the server.', 503);
    return { Authorization: `Bearer ${this.opts.apiKey}`, 'X-Viggle-Source': 'viggle-director-scenegen' };
  }

  private json(base: string, path: string, body: unknown): Promise<SceneTask> {
    return this.send(base, path, JSON.stringify(body), { 'Content-Type': 'application/json' });
  }

  private async send(base: string, path: string, body: BodyInit, extra: Record<string, string> = {}): Promise<SceneTask> {
    const res = await this.f(base + path, { method: 'POST', headers: { ...this.headers(), ...extra }, body });
    return await this.read(res) as SceneTask;
  }

  private async read(res: Response): Promise<unknown> {
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = (body as { error?: { message?: string; code?: string }; message?: string; detail?: unknown } | null);
      const msg = e?.error?.message ?? e?.message ?? (typeof e?.detail === 'string' ? e.detail : null) ?? `JST-2 ${res.status}: ${text.slice(0, 200)}`;
      throw new Jst2Error(msg, res.status, e?.error?.code);
    }
    return body;
  }
}

export function checkC2W(m: C2W): void {
  const ok = Array.isArray(m) && m.length === 4 && m.every((r) => Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(v)))
    && m[3]![0] === 0 && m[3]![1] === 0 && m[3]![2] === 0 && m[3]![3] === 1;
  if (!ok) throw new Jst2Error('c2w must be a 4x4 matrix whose last row is [0, 0, 0, 1].', 400);
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[i]![j]!));
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const dot = R[0]![a]! * R[0]![b]! + R[1]![a]! * R[1]![b]! + R[2]![a]! * R[2]![b]!;
    if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-3) throw new Jst2Error('c2w rotation must be orthonormal.', 400);
  }
}
