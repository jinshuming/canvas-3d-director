/** The project's .env.local as a map, for the eval scripts (the dev server reads it through Vite). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('../../', import.meta.url).pathname;

export function loadEnv(): Record<string, string> {
  return Object.fromEntries(readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
}
