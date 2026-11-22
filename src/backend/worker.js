/**
 * Cloudflare Workers Entrypoint (`src/backend/worker.js`).
 * Uses D1 (strongly consistent primary) or KV fallback via `createCloudflareStorage(env)`.
 */

import { createApp } from './app.js';
import { createCloudflareStorage } from './storage/cloudflare.js';
import { createMemoryStorage } from './storage/memory.js';

let fallbackMemory = null;

export default {
  async fetch(request, env, ctx) { // eslint-disable-line no-unused-vars
    let storage;
    if (env?.DB || env?.KV) {
      storage = createCloudflareStorage(env);
    } else {
      if (!fallbackMemory) fallbackMemory = createMemoryStorage();
      storage = fallbackMemory;
    }

    const staticHandler = env?.ASSETS
      ? async (req) => {
          const res = await env.ASSETS.fetch(req);
          if (res.status === 404) return null;
          return res;
        }
      : null;

    const app = createApp({
      storage,
      env: { ...env, MODE: 'cloudflare' },
      staticHandler,
    });
    return app.handleRequest(request);
  },
};
