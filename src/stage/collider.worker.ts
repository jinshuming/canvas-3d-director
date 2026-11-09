// The engine's collider worker, spawned from here because a bundler only emits a worker from a relative
// `new URL`. Importing it installs its onmessage. (As PINOC's walkCollider.worker.ts; the published engine ships
// the worker as dist/collider-worker.js.)
import '../../node_modules/@viggle/splat-engine/dist/collider-worker.js';
