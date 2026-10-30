import type { StageDoc } from '@stage';

import type { GenJob, Library } from './shared/library.ts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly body?: unknown) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
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
  listStages: () => call<Array<{ id: string; title: string; updatedAt: string }>>('/api/stages'),
  createStage: (title: string) => call<StageDoc>('/api/stages', { method: 'POST', body: JSON.stringify({ title }) }),
  getStage: (id: string) => call<StageDoc>(`/api/stages/${id}`),
  saveStage: (doc: StageDoc, baseVersion: number) => call<StageDoc>(`/api/stages/${doc.id}`, { method: 'PUT', body: JSON.stringify({ baseVersion, doc }) }),
  library: () => call<Library>('/api/library'),
  generate: (kind: GenJob['kind'], input: Record<string, unknown>) => call<GenJob>(`/api/gen/${kind}`, { method: 'POST', body: JSON.stringify(input) }),
  dismissJob: (id: string) => call<{ ok: true }>(`/api/jobs/${id}`, { method: 'DELETE' }),
};
