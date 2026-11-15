/**
 * The layout agent's host for a scenegen project: its tools edit `layout` in
 * memory and reach the server (renders, capture search, generation) through
 * the project API. One implementation for every place the agent runs - the
 * batch test page, the canvas node, the end-to-end harness - which differ only
 * in how a picture becomes a data URL and what they show while it works.
 */
import type { AgentHost } from '../agent/tools.ts';
import type { Layout } from '../core/types.ts';
import { api } from './api.ts';
import type { Conditions, Job } from './api.ts';

export interface ProjectHostOptions {
  /** An image URL (served by the dev server) as a data: URL at most `width` wide, for the model's eyes. */
  toDataUrl: (url: string, width: number) => Promise<string>;
  /** What to ask the generation for; the agent may name a provider. Default: the server's defaults. */
  generateBody?: (provider?: string) => Parameters<typeof api.generate>[1];
  onChanged?: () => void;
  onConditions?: (c: Conditions) => void;
  onJob?: (job: Job) => void;
}

export function projectHost(projectId: string, layout: Layout, o: ProjectHostOptions): AgentHost & { job(): Job | null } {
  let job: Job | null = null;
  return {
    layout,
    changed: () => o.onChanged?.(),
    look: async () => {
      await api.put(projectId, { layout });
      const c = await api.conditions(projectId);
      o.onConditions?.(c);
      if (!layout.capture) layout.capture = c.capture;
      return { image: await o.toDataUrl(c.files.shaded, 1024), prompt: c.prompt };
    },
    findCapture: async () => {
      await api.put(projectId, { layout });
      return api.capture(projectId);
    },
    // One generation per agent turn: a second call reports the one already running.
    generate: async (provider) => {
      if (job) return { jobId: job.id };
      await api.put(projectId, { layout, title: layout.title });
      job = await api.generate(projectId, o.generateBody?.(provider) ?? {});
      o.onJob?.(job);
      return { jobId: job.id };
    },
    job: () => job,
  };
}
