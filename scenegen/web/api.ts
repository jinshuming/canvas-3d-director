import type { CaptureResult } from '../core/capture.ts';
import type { CameraPose } from '../core/frame.ts';
import type { Issue } from '../core/layout.ts';
import type { Layout } from '../core/types.ts';

export interface Config {
  providers: Array<{ id: string; label: string; available: boolean }>;
  defaultProvider: string;
  agent: { model: string } | null;
  video: { available: boolean; endpoint: 'mock' | 'live' };
  viggle: boolean;
}
export interface Job { id: string; kind: string; status: 'running' | 'done' | 'failed'; stage: string; message: string; progress: number; log: string[]; error?: string; startedAt: number; endedAt?: number }
export interface ProjectSummary { id: string; kind: 'text' | 'video'; title: string; updatedAt: string; objects: number; status: string; exported: { sceneId: string } | null; thumb: string | null }
export interface Project {
  id: string; kind: 'text' | 'video'; title: string; updatedAt: string; layout: Layout; chat: unknown[];
  video?: { file: string; bytes: number } | null; reference?: { file: string; mime: string } | null;
  result?: Record<string, unknown> | null; job?: Job | null; exported?: { sceneId: string; at: string } | null;
}
export interface Conditions { capture: CameraPose; range: { zMin: number; zMax: number }; legend: Array<{ cls: string; color: number[]; share: number }>; prompt: string; issues: Issue[]; files: { depth: string; semantic: string; shaded: string } }

async function call<T>(method: string, path: string, body?: unknown, raw?: { body: Blob; type: string }): Promise<T> {
  const res = await fetch(`/scenegen/api${path}`, {
    method,
    headers: raw ? { 'Content-Type': raw.type } : body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await res.json().catch(() => null) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(out?.error?.message ?? `${method} ${path}: ${res.status}`);
  return out;
}

export const api = {
  config: () => call<Config>('GET', '/config'),
  projects: () => call<ProjectSummary[]>('GET', '/projects'),
  create: (kind: 'text' | 'video', extra: { title?: string; layout?: Layout } = {}) => call<Project>('POST', '/projects', { kind, ...extra }),
  get: (id: string) => call<Project>('GET', `/projects/${id}`),
  put: (id: string, patch: Partial<Pick<Project, 'title' | 'layout' | 'chat'>>) => call<{ ok: true }>('PUT', `/projects/${id}`, patch),
  conditions: (id: string) => call<Conditions>('POST', `/projects/${id}/conditions`),
  capture: (id: string) => call<CaptureResult>('POST', `/projects/${id}/capture`),
  generate: (id: string, body: { provider?: string; maxFills?: number | 'auto'; useReference?: boolean }) => call<Job>('POST', `/projects/${id}/generate`, body),
  layoutVideo: (id: string, file: Blob) => call<{ frames: Array<{ file: string; time: number; url: string }> }>('PUT', `/projects/${id}/layout-video`, undefined, { body: file, type: file.type || 'video/mp4' }),
  reference: (id: string, file: Blob) => call<{ url: string }>('PUT', `/projects/${id}/reference`, undefined, { body: file, type: file.type }),
  video: (id: string, file: Blob) => call<{ file: string; bytes: number }>('PUT', `/projects/${id}/video`, undefined, { body: file, type: file.type || 'video/mp4' }),
  videoRun: (id: string, body: { square?: number }) => call<Job>('POST', `/projects/${id}/video-run`, body),
  cancel: (id: string) => call<{ ok: true }>('POST', `/projects/${id}/cancel`),
  exportScene: (id: string) => call<{ sceneId: string }>('POST', `/projects/${id}/export`),
};

export const file = (id: string, path: string, bust?: string | number) => `/scenegen/files/${id}/${path}${bust ? `?t=${bust}` : ''}`;

/** An image URL as a data: URL, scaled down to `maxW` wide (JPEG) - for the model's eyes. */
export async function toDataUrl(src: string | Blob, maxW = 1024): Promise<string> {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);
  const w = Math.min(maxW, bmp.width), h = Math.round((bmp.height * w) / bmp.width);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}
