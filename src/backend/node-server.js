/**
 * Node 22 Local Server for Home Pharmacy (`src/backend/node-server.js`).
 * Bridges `node:http` to the Web-Standard `createApp({ storage, env })` Fetch handler,
 * persists state in local SQLite (`node:sqlite`), and serves the built React 18 PWA (`dist/web/`).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createSqliteStorage } from './storage/sqlite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIST_DIR = path.join(REPO_ROOT, 'dist', 'web');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

function createStaticHandler(distDir) {
  return async function handleStatic(request, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    if (!fs.existsSync(distDir)) return null;

    let relPath = decodeURIComponent(url.pathname);
    if (relPath === '/' || relPath === '') relPath = '/index.html';

    // Prevent directory traversal outside distDir
    const normalized = path.posix.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const candidate = path.join(distDir, normalized);
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(path.resolve(distDir))) return null;

    let filePath = resolved;
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback for client-side routes (only when not requesting a static file extension)
      if (!path.extname(normalized)) {
        const indexPath = path.join(distDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          filePath = indexPath;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const body = request.method === 'HEAD' ? null : fs.readFileSync(filePath);
    const headers = {
      'Content-Type': contentType,
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': ext === '.html' || path.basename(filePath) === 'sw.js' ? 'no-store' : 'public, max-age=300',
    };
    return new Response(body, { status: 200, headers });
  };
}

function readNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startNodeServer(customEnv = {}) {
  const env = { ...process.env, ...customEnv };
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT ?? 8787);
  const dataDir = env.DATA_DIR || env.STORAGE_DIR || path.join(REPO_ROOT, '.data');
  const dbPath = env.DB_PATH || path.join(dataDir, 'home-pharmacy.sqlite');

  const storage = createSqliteStorage({ dbPath, dataDir });
  const app = createApp({
    storage,
    env: { ...env, MODE: env.MODE || 'local' },
    staticHandler: createStaticHandler(env.WEB_DIST_DIR || WEB_DIST_DIR),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const reqHost = req.headers.host || `${host}:${port}`;
      const fullUrl = `http://${reqHost}${req.url || '/'}`;
      const method = (req.method || 'GET').toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const bodyBuf = hasBody ? await readNodeRequestBody(req) : undefined;

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else {
          headers.set(k, v);
        }
      }

      const webReq = new Request(fullUrl, {
        method,
        headers,
        body: hasBody && bodyBuf && bodyBuf.length > 0 ? bodyBuf : undefined,
      });

      const webRes = await app.handleRequest(webReq);
      res.statusCode = webRes.status;

      // Handle multiple Set-Cookie headers properly in Node 22
      const setCookies = typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
      for (const [k, v] of webRes.headers.entries()) {
        if (k.toLowerCase() === 'set-cookie') continue;
        res.setHeader(k, v);
      }
      if (setCookies.length > 0) {
        res.setHeader('set-cookie', setCookies);
      }

      const arrBuf = await webRes.arrayBuffer();
      res.end(Buffer.from(arrBuf));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: err?.message || 'Unhandled error' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  const stop = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await storage.close();
  };

  return { server, storage, app, host, port: actualPort, stop };
}

// Run directly when executed via `node src/backend/node-server.js`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  startNodeServer()
    .then(({ host, port, stop }) => {
      console.log(`Home Pharmacy listening on http://${host}:${port}`);
      const shutdown = async () => {
        await stop();
        process.exit(0);
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error('Failed to start Home Pharmacy server:', err);
      process.exit(1);
    });
}
