import type { AssetKind, AssetRef, GenerationJob, StageDoc, StageRenderer, StageToolHost } from '@stage';

import { api } from './api.ts';
import type { Library } from './shared/library.ts';
import { PRESET_CHARACTERS, PRESET_MOTIONS, PRESET_SCENES } from './shared/library.ts';

/**
 * The director as a stage-tool host: the doc and undo history from useStage,
 * the live renderer, and the asset library (presets + what the server
 * generated). An agent loop calls `runStageTool(name, input, host)`.
 */
export function createDirectorHost(o: {
  getDoc: () => StageDoc;
  update: (fn: (d: StageDoc) => StageDoc) => void;
  renderer: () => StageRenderer | null;
  ui: StageToolHost['ui'];
}): StageToolHost {
  return {
    getDoc: o.getDoc,
    update: o.update,
    get renderer() { return o.renderer(); },
    assets: {
      async list(kind: AssetKind): Promise<AssetRef[]> {
        const lib: Library = await api.library().catch(() => ({ scenes: [], characters: [], motions: [], jobs: [] }));
        if (kind === 'scene') {
          return [
            ...lib.scenes.map((s) => ({ id: s.id, kind, name: s.name, url: s.url, source: 'generated' as const, viggle: s.viggle, panoramaUrl: s.panoramaUrl, objectsUrl: s.objectsUrl, relight: s.relight, lighting: s.lighting })),
            ...PRESET_SCENES.map((s) => ({ id: s.id, kind, name: s.name, url: s.url, source: 'preset' as const })),
          ];
        }
        if (kind === 'character') {
          return [...lib.characters, ...PRESET_CHARACTERS].map((c) => ({ id: c.id, kind, name: c.name, aliases: c.aliases, url: c.url, source: c.viggleId ? 'generated' as const : 'preset' as const }));
        }
        return [...lib.motions, ...PRESET_MOTIONS].map((m) => ({ id: m.id, kind, name: m.name, aliases: m.aliases, url: m.url, source: m.viggleId ? 'generated' as const : 'preset' as const }));
      },
      async generate(kind: AssetKind, input: Record<string, unknown>): Promise<GenerationJob> {
        const j = await api.generate(kind, input);
        return { id: j.id, kind, status: j.status, label: j.label, credits: j.credits, assetId: j.assetId, error: j.error };
      },
      async fillView(input): Promise<GenerationJob> {
        const j = await api.generate('fill', input);
        return { id: j.id, kind: 'fill' as const, status: j.status, label: j.label, credits: j.credits, assetId: j.assetId, error: j.error };
      },
      async jobs(): Promise<GenerationJob[]> {
        const lib = await api.library();
        // H3 renders belong to the export, not to what the agent makes.
        return lib.jobs.flatMap((j) => (j.kind === 'h3' ? [] : [{ id: j.id, kind: j.kind, status: j.status, label: j.label, credits: j.credits, assetId: j.assetId, error: j.error }]));
      },
    },
    ui: o.ui,
  };
}
