import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

import { directorServer } from './app/server/plugin.ts';
import { scenegenServer } from './scenegen/server/plugin.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The 3D Director. `VIGGLE_API_KEY` and `OPENAI_API_KEY` (.env.local, or the
 * environment) stay on this server: generation is submitted and polled, and
 * the agent's model calls are relayed, by the middleware in
 * app/server/plugin.ts - never by the page.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  return {
    root,
    resolve: {
      alias: [{ find: '@stage', replacement: here('./src/stage/index.ts') }],
    },
    optimizeDeps: { include: ['react', 'react/jsx-runtime', 'react-dom/client'] },
    plugins: [
      directorServer({
        dataDir: here('./.data'),
        apiKey: env.VIGGLE_API_KEY || undefined,
        apiBase: env.VIGGLE_API_BASE_URL || undefined,
        openai: { apiKey: env.OPENAI_API_KEY || undefined, model: env.OPENAI_MODEL || 'gpt-6-luna', base: env.OPENAI_BASE_URL || undefined },
        seedScenes: [{
          name: 'Modern living room',
          spz: here('./assets/seed/modern-living-room.spz'),
          panorama: here('./assets/seed/modern-living-room-pano.png'),
        }],
      }),
      // The scene generator (/scenegen/): text → blockout → 3DGS, video → poses → 3DGS. Separate
      // from the director; it hands finished scenes to the library above. FAL_KEY enables the
      // FLUX depth panorama provider; SCENEGEN_POSED_IMAGES_BASE points the video path at a real
      // JST-2 posed-images endpoint (unset: the built-in mock).
      scenegenServer({
        dataDir: here('./.data'),
        viggleKey: env.VIGGLE_API_KEY || undefined,
        viggleBase: env.VIGGLE_API_BASE_URL || undefined,
        posedImagesBase: env.SCENEGEN_POSED_IMAGES_BASE || undefined,
        falKey: env.FAL_KEY || undefined,
        openai: { apiKey: env.OPENAI_API_KEY || undefined, model: env.OPENAI_MODEL || 'gpt-6-luna', base: env.OPENAI_BASE_URL || undefined },
        imageModel: env.SCENEGEN_IMAGE_MODEL || 'gpt-image-2',
        port: 5193,
      }),
    ],
    build: { rollupOptions: { input: { main: here('./index.html'), scenegen: here('./scenegen/index.html') } } },
    server: { port: 5193 },
  };
});
