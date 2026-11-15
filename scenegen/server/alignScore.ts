/**
 * Score panoramas against their blockout with scenegen/py/panoalign.py
 * (blockout edges vs panorama edges, above chance; 0 = chance, 1 = perfect).
 * Null when the Python environment is not installed: callers then keep the
 * first candidate.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { PY_BIN, PY_DIR } from './videoScene.ts';

export interface AlignScore { objects: number; shell: number }

export function alignScorerAvailable(): boolean {
  return existsSync(PY_BIN);
}

export function scorePanoramas(semanticPng: string, panos: string[]): Promise<AlignScore[] | null> {
  if (!alignScorerAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn(PY_BIN, ['-m', 'panoalign', semanticPng, ...panos], { cwd: PY_DIR });
    let out = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(out) as Record<string, { objects: { lift: number }; shell: { lift: number } }>;
        resolve(panos.map((f) => ({ objects: j[f]!.objects.lift, shell: j[f]!.shell.lift })));
      } catch { resolve(null); }
    });
  });
}
