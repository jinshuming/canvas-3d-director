import type { StageDoc } from '@stage';

import type { GenJob, Library } from './shared/library.ts';
import type { WorldChat, WorldFile, WorldSummary } from './shared/world.ts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly body?: unknown) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A FormData body sets its own multipart Content-Type (with the boundary).
  const json: Record<string, string> = init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  const res = await fetch(path, { ...init, headers: { ...json, ...init.headers } });
  const text = await res.text();
  const body = text ? JSON.parse(text) as unknown : null;
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(res.status, err?.message ?? `HTTP ${res.status}`, err?.code, body);
  }
  return body as T;
}

export const api = {
  config: () => call<{ live: boolean; agent: { model: string } | null }>('/api/config'),
  listWorlds: () => call<WorldSummary[]>('/api/worlds'),
  /** A new world; `copyOf` starts it from another world's stage (with a fresh conversation). */
  createWorld: (opts: { title?: string; copyOf?: string } = {}) => call<WorldFile>('/api/worlds', { method: 'POST', body: JSON.stringify(opts) }),
  getWorld: (id: string) => call<WorldFile>(`/api/worlds/${id}`),
  renameWorld: (id: string, title: string) => call<WorldSummary>(`/api/worlds/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  /** Moves the world to the server's trash folder. */
  deleteWorld: (id: string) => call<{ ok: true }>(`/api/worlds/${id}`, { method: 'DELETE' }),
  getStage: (id: string) => call<StageDoc>(`/api/worlds/${id}/stage`),
  saveStage: (doc: StageDoc, baseVersion: number) => call<StageDoc>(`/api/worlds/${doc.id}/stage`, { method: 'PUT', body: JSON.stringify({ baseVersion, doc }) }),
  saveChat: (id: string, chat: WorldChat) => call<{ updatedAt: string }>(`/api/worlds/${id}/chat`, { method: 'PUT', body: JSON.stringify({ chat }) }),
  saveCover: (id: string, dataUrl: string) => call<{ coverUrl: string }>(`/api/worlds/${id}/cover`, { method: 'PUT', body: JSON.stringify({ dataUrl }) }),
  library: () => call<Library>('/api/library'),
  generate: (kind: GenJob['kind'], input: Record<string, unknown>) => call<GenJob>(`/api/gen/${kind}`, { method: 'POST', body: JSON.stringify(input) }),
  /** An H3 render: `form` carries the previs video as `reference_video`, and the options. */
  submitH3: (form: FormData) => call<GenJob>('/api/h3', { method: 'POST', body: form }),
  dismissJob: (id: string) => call<{ ok: true }>(`/api/jobs/${id}`, { method: 'DELETE' }),
};
