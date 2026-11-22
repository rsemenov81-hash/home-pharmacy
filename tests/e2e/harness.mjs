import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// ============================================================================
// 1. Constants & Shared Low-Level Utilities
// ============================================================================

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
export const DEFAULT_SERVER_SCRIPT = path.join(REPO_ROOT, 'src', 'backend', 'node-server.js');
export const DEFAULT_PLAYWRIGHT_BROWSERS_PATH = '/opt/ms-playwright';

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwnDefined(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepClone(val) {
  if (Array.isArray(val)) return val.map(deepClone);
  if (val instanceof Date) return new Date(val.getTime());
  if (isPlainObject(val)) {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (UNSAFE_OBJECT_KEYS.has(k)) continue;
      if (v !== undefined) out[k] = deepClone(v);
    }
    return out;
  }
  return val;
}

function deepMerge(base, overrides) {
  const result = deepClone(base);
  if (!isPlainObject(overrides)) return result;
  for (const [k, v] of Object.entries(overrides)) {
    if (UNSAFE_OBJECT_KEYS.has(k) || v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(result[k])) {
      result[k] = deepMerge(result[k], v);
    } else {
      result[k] = deepClone(v);
    }
  }
  return result;
}

function safeParseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function appendBoundedLog(current, chunk, maxBytes) {
  const next = current + chunk;
  if (next.length <= maxBytes) return next;
  return next.slice(next.length - maxBytes);
}

// ============================================================================
// 2. Network & Server Lifecycle (`getFreePort`, `startE2EServer`)
// ============================================================================

export function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address !== 'object' || typeof address.port !== 'number') {
        server.close(() => reject(new Error('Failed to determine allocated TCP port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

// Zero-leak singleton signal/exit cleanup registry for managed child servers.
const activeServers = new Set();
let exitHookInstalled = false;
let signalHooksInstalled = false;

function runAllSyncCleanups() {
  for (const entry of Array.from(activeServers)) {
    try {
      entry.syncCleanup();
    } catch {
      // Best-effort process-exit cleanup
    }
  }
  activeServers.clear();
}

function onProcessExit() {
  runAllSyncCleanups();
}

function onProcessSignal(sig) {
  runAllSyncCleanups();
  if (signalHooksInstalled) {
    process.off('SIGINT', onProcessSignal);
    process.off('SIGTERM', onProcessSignal);
    signalHooksInstalled = false;
  }
  try {
    process.kill(process.pid, sig);
  } catch {
    process.exit(sig === 'SIGINT' ? 130 : 143);
  }
}

function registerActiveServer(entry) {
  activeServers.add(entry);
  if (!exitHookInstalled) {
    process.on('exit', onProcessExit);
    exitHookInstalled = true;
  }
  if (!signalHooksInstalled && activeServers.size > 0) {
    process.on('SIGINT', onProcessSignal);
    process.on('SIGTERM', onProcessSignal);
    signalHooksInstalled = true;
  }
}

function unregisterActiveServer(entry) {
  activeServers.delete(entry);
  if (signalHooksInstalled && activeServers.size === 0) {
    process.off('SIGINT', onProcessSignal);
    process.off('SIGTERM', onProcessSignal);
    signalHooksInstalled = false;
  }
}

async function pollServerHealth({
  healthUrl,
  healthTimeoutMs,
  healthPollIntervalMs,
  getExitState,
  exitPromise,
  closePromise,
}) {
  const deadline = Date.now() + healthTimeoutMs;
  let lastStatus = null;
  let lastBody = '';
  let lastError = null;

  while (Date.now() < deadline) {
    const state = getExitState?.();
    if (state?.spawnError) {
      throw new Error(`Failed to spawn E2E server process: ${state.spawnError.message}`);
    }
    if (state?.exited) {
      if (closePromise) {
        await Promise.race([closePromise, delay(200)]);
      }
      const err = new Error(
        `E2E child server exited prematurely before /health became ready ` +
          `(code=${state.exitCode}, signal=${state.exitSignal})`
      );
      err.prematureExit = true;
      throw err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(2000, Math.max(200, remaining))),
      });
      lastStatus = res.status;
      lastBody = await res.text();
      const json = safeParseJson(lastBody);
      if (res.status === 200 && json?.ok === true) {
        return;
      }
      lastError = null;
    } catch (err) {
      lastError = err;
    }

    const postState = getExitState?.();
    if (postState?.spawnError || postState?.exited) {
      continue;
    }

    const sleepMs = Math.min(healthPollIntervalMs, Math.max(10, deadline - Date.now()));
    if (exitPromise) {
      await Promise.race([delay(sleepMs), exitPromise]);
    } else {
      await delay(sleepMs);
    }
  }

  const state = getExitState?.();
  if (state?.exited) {
    if (closePromise) {
      await Promise.race([closePromise, delay(200)]);
    }
    throw new Error(
      `E2E child server exited prematurely before /health became ready ` +
        `(code=${state.exitCode}, signal=${state.exitSignal})`
    );
  }

  throw new Error(
    `Timed out after ${healthTimeoutMs}ms waiting for ${healthUrl} to return 200 { ok: true } ` +
      `(lastStatus=${lastStatus}, lastBody=${JSON.stringify(lastBody.slice(0, 300))}, ` +
      `lastError=${lastError?.message ?? 'none'})`
  );
}

function attachHandleClients(handle) {
  const defaultApi = createApiClient({
    baseUrl: handle.baseUrl,
    token: handle.adminToken || null,
  });

  handle.api = (urlPath, opts = {}) => {
    const method = opts?.method ?? 'GET';
    return defaultApi.request(method, urlPath, opts);
  };

  handle.mcp = (payload, opts = {}) => {
    const suppressAuth = opts.auth === false;
    const effectiveToken = suppressAuth
      ? null
      : opts.token !== undefined
        ? opts.token
        : handle.adminToken || null;
    const expectedId =
      opts.expectedId !== undefined
        ? opts.expectedId
        : isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'id')
          ? payload.id
          : undefined;
    return sendMcpPayload({
      baseUrl: handle.baseUrl,
      mcpPath: opts.mcpPath ?? '/mcp',
      token: effectiveToken,
      tokenInQuery: suppressAuth ? false : Boolean(opts.tokenInQuery),
      protocolVersion: opts.protocolVersion ?? '2025-06-18',
      sessionId: opts.sessionId ?? null,
      payload,
      expectedId,
      headers: opts.headers,
      suppressAuth,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
  };

  return handle;
}

export async function startE2EServer(options = {}) {
  const healthTimeoutMs =
    options.healthTimeoutMs ?? (Number(process.env.E2E_HEALTH_TIMEOUT_MS) || 15_000);
  const healthPollIntervalMs = options.healthPollIntervalMs ?? 100;
  const sigkillTimeoutMs = options.sigkillTimeoutMs ?? 3_000;
  const maxLogBytes = options.maxLogBytes ?? 256 * 1024;

  const rawExternalUrl =
    typeof options.baseUrl === 'string' && options.baseUrl.trim()
      ? options.baseUrl.trim()
      : !options.ignoreExternalEnv && process.env.E2E_BASE_URL?.trim()
        ? process.env.E2E_BASE_URL.trim()
        : '';

  // External server override path (strictly non-destructive: no spawn, no temp dir, no-op stop).
  if (rawExternalUrl) {
    const cleanBaseUrl = rawExternalUrl.replace(/\/+$/, '');
    const parsed = new URL(cleanBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`External E2E_BASE_URL must use http: or https:, got: ${rawExternalUrl}`);
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    const adminToken = options.adminToken ?? process.env.E2E_ADMIN_TOKEN ?? '';
    const passcode = options.passcode ?? process.env.E2E_PASSCODE ?? '';

    await pollServerHealth({
      healthUrl: `${cleanBaseUrl}/health`,
      healthTimeoutMs,
      healthPollIntervalMs,
    });

    return attachHandleClients({
      baseUrl: cleanBaseUrl,
      origin: parsed.origin,
      port,
      adminToken,
      passcode,
      dataDir: null,
      proc: null,
      logs: { stdout: '', stderr: '', combined: '' },
      external: true,
      async stop() {
        // Strict no-op for externally managed servers
      },
    });
  }

  // Managed child process path.
  const cwd = options.cwd ?? REPO_ROOT;
  const serverScript = options.serverScript ?? DEFAULT_SERVER_SCRIPT;
  const resolvedScript = path.isAbsolute(serverScript)
    ? serverScript
    : path.resolve(cwd, serverScript);

  if (!fs.existsSync(resolvedScript)) {
    throw new Error(`E2E server script not found: ${resolvedScript}`);
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? (await getFreePort(host));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-pharmacy-e2e-'));

  let dbPath;
  let adminToken;
  let passcode;
  let origin;
  let baseUrl;
  let logs;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;
  let proc = null;
  let exitPromise;
  let closePromise;
  let registryEntry;

  try {
    dbPath = path.join(dataDir, 'home-pharmacy.sqlite');
    adminToken = options.adminToken ?? crypto.randomBytes(24).toString('hex');
    passcode = options.passcode ?? `e2e-pass-${crypto.randomBytes(8).toString('hex')}`;
    origin = `http://${host}:${port}`;
    baseUrl = origin;

    const allowedOriginsStr = Array.isArray(options.allowedOrigins)
      ? options.allowedOrigins.join(',')
      : typeof options.allowedOrigins === 'string'
        ? options.allowedOrigins
        : `http://127.0.0.1:${port},http://localhost:${port},https://rsemenov81-hash.github.io`;

    const childEnv = {
      ...process.env,
      HOST: host,
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_PATH: dbPath,
      STORAGE_DIR: dataDir,
      HOUSEHOLD_ADMIN_TOKEN: adminToken,
      HOUSEHOLD_PASSCODE: passcode,
      ALLOWED_ORIGINS: allowedOriginsStr,
      NODE_ENV: 'test',
      ...(options.env || {}),
    };
    delete childEnv.E2E_BASE_URL;

    logs = { stdout: '', stderr: '', combined: '' };

    proc = spawn(process.execPath, [resolvedScript], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => {
      logs.stdout = appendBoundedLog(logs.stdout, chunk, maxLogBytes);
      logs.combined = appendBoundedLog(logs.combined, chunk, maxLogBytes);
    });
    proc.stderr?.on('data', (chunk) => {
      logs.stderr = appendBoundedLog(logs.stderr, chunk, maxLogBytes);
      logs.combined = appendBoundedLog(logs.combined, chunk, maxLogBytes);
    });

    exitPromise = new Promise((resolve) => {
      proc.once('exit', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        resolve({ code, signal });
      });
      proc.once('error', (err) => {
        exited = true;
        spawnError = err;
        resolve({ code: null, signal: null, error: err });
      });
    });

    closePromise = new Promise((resolve) => {
      proc.once('close', () => resolve());
      proc.once('error', () => resolve());
    });

    registryEntry = {
      syncCleanup() {
        if (!exited && proc?.pid) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Process may have already exited
          }
        }
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
        } catch {
          // Best-effort directory cleanup
        }
      },
    };
    registerActiveServer(registryEntry);
  } catch (err) {
    if (proc?.pid && !exited) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Best-effort process cleanup
      }
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort directory cleanup
    }
    throw err;
  }

  let stopPromise = null;
  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      unregisterActiveServer(registryEntry);
      if (!exited && proc.pid) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Already exited
        }
        let killTimer;
        let hardTimer;
        try {
          await Promise.race([
            exitPromise,
            new Promise((resolve) => {
              killTimer = setTimeout(() => {
                if (!exited && proc.pid) {
                  try {
                    proc.kill('SIGKILL');
                  } catch {
                    // Already exited
                  }
                }
                hardTimer = setTimeout(resolve, 2000);
                hardTimer.unref?.();
              }, sigkillTimeoutMs);
              killTimer.unref?.();
            }),
          ]);
        } finally {
          clearTimeout(killTimer);
          clearTimeout(hardTimer);
        }
      }
      // Allow stdio close to flush briefly without blocking indefinitely.
      await Promise.race([closePromise, delay(150)]);
      // Clean up isolated temp directory (retry briefly for transient WAL release).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt < 2) await delay(50);
        }
      }
    })();
    return stopPromise;
  }

  try {
    await pollServerHealth({
      healthUrl: `${baseUrl}/health`,
      healthTimeoutMs,
      healthPollIntervalMs,
      getExitState: () => ({ exited, exitCode, exitSignal, spawnError }),
      exitPromise,
      closePromise,
    });
  } catch (err) {
    await stop();
    const diagParts = [err.message];
    if (logs.stderr.trim()) {
      diagParts.push(`--- stderr ---\n${logs.stderr.trim().slice(-2000)}`);
    }
    if (logs.stdout.trim()) {
      diagParts.push(`--- stdout ---\n${logs.stdout.trim().slice(-2000)}`);
    }
    const enriched = new Error(diagParts.join('\n'), { cause: err });
    enriched.logs = { ...logs };
    enriched.exitCode = exitCode;
    enriched.exitSignal = exitSignal;
    throw enriched;
  }

  return attachHandleClients({
    baseUrl,
    origin,
    port,
    adminToken,
    passcode,
    dataDir,
    proc,
    logs,
    external: false,
    stop,
  });
}

// ============================================================================
// 3. HTTP REST API Client (`createApiClient`)
// ============================================================================

function resolveSubpathUrl(pathStr, baseUrl) {
  const baseObj = new URL(baseUrl);
  const basePrefix = baseObj.pathname.replace(/\/+$/, '');
  if (
    basePrefix &&
    pathStr.startsWith('/') &&
    !pathStr.startsWith('//') &&
    pathStr !== basePrefix &&
    !pathStr.startsWith(`${basePrefix}/`) &&
    !pathStr.startsWith(`${basePrefix}?`) &&
    !pathStr.startsWith(`${basePrefix}#`)
  ) {
    return new URL(`${basePrefix}${pathStr}`, baseObj.origin);
  }
  const cleanBase = `${baseObj.origin}${basePrefix}/`;
  return new URL(pathStr, cleanBase);
}

function resolveRequestUrl(baseUrl, reqPath = '', query, effectiveToken, useTokenInQuery) {
  let url;
  const pathStr = reqPath == null ? '' : String(reqPath);

  if (/^https?:\/\//i.test(pathStr)) {
    url = new URL(pathStr);
  } else if (pathStr === '') {
    url = new URL(baseUrl);
  } else if (pathStr.startsWith('?')) {
    url = new URL(baseUrl);
    const hashIdx = pathStr.indexOf('#');
    const qStr = hashIdx >= 0 ? pathStr.slice(1, hashIdx) : pathStr.slice(1);
    const extra = new URLSearchParams(qStr);
    for (const [k, v] of extra.entries()) url.searchParams.append(k, v);
    if (hashIdx >= 0) {
      url.hash = pathStr.slice(hashIdx);
    }
  } else if (pathStr.startsWith('#')) {
    url = new URL(baseUrl);
    url.hash = pathStr;
  } else {
    url = resolveSubpathUrl(pathStr, baseUrl);
  }

  if (query instanceof URLSearchParams) {
    for (const [k, v] of query.entries()) {
      url.searchParams.append(k, v);
    }
  } else if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== null) {
            url.searchParams.append(k, String(item));
          }
        }
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  if (useTokenInQuery && effectiveToken && !url.searchParams.has('token')) {
    url.searchParams.set('token', String(effectiveToken));
  }

  return url;
}

function isRawBody(body) {
  return (
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  );
}

function mergeHeaders(target, source) {
  if (!source) return;
  if (source instanceof Headers) {
    for (const [k, v] of source.entries()) target.set(k, v);
    return;
  }
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (v === null) target.delete(k);
    else target.set(k, String(v));
  }
}

function inspectHeaderOverride(source, targetName) {
  const lowerTarget = String(targetName).toLowerCase();
  if (!source) return { present: false, deleted: false };
  if (source instanceof Headers) {
    return { present: source.has(lowerTarget), deleted: false };
  }
  let result = { present: false, deleted: false };
  if (typeof source === 'object') {
    for (const [k, v] of Object.entries(source)) {
      if (k.toLowerCase() === lowerTarget) {
        if (v === undefined) continue;
        result = { present: true, deleted: v === null };
      }
    }
  }
  return result;
}

export function createApiClient({
  baseUrl,
  token = null,
  tokenInQuery = false,
  defaultHeaders = {},
  timeoutMs = 15_000,
} = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new TypeError('createApiClient requires a non-empty baseUrl string');
  }
  const normalizedBase = baseUrl.trim();

  async function request(method, reqPath = '', opts = {}) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const suppressAuth = opts.auth === false;
    const authOverride = inspectHeaderOverride(opts.headers, 'authorization');
    const explicitAuthNull = authOverride.deleted;
    const explicitAuthValue = authOverride.present && !authOverride.deleted;

    const effectiveToken = suppressAuth
      ? null
      : opts.token !== undefined
        ? opts.token
        : token;
    const useTokenInQuery = suppressAuth
      ? false
      : opts.tokenInQuery !== undefined
        ? Boolean(opts.tokenInQuery)
        : Boolean(tokenInQuery);

    const url = resolveRequestUrl(
      normalizedBase,
      reqPath,
      opts.query,
      effectiveToken,
      useTokenInQuery
    );

    const headers = new Headers();
    mergeHeaders(headers, defaultHeaders);
    if (suppressAuth && !explicitAuthValue) {
      headers.delete('authorization');
    }
    mergeHeaders(headers, opts.headers);

    if (
      !suppressAuth &&
      !explicitAuthNull &&
      effectiveToken &&
      typeof effectiveToken === 'string' &&
      !useTokenInQuery &&
      !headers.has('authorization')
    ) {
      headers.set('authorization', `Bearer ${effectiveToken}`);
    }

    const fetchOpts = {
      method: upperMethod,
      headers,
      redirect: opts.redirect ?? 'follow',
    };

    const effectiveTimeout = opts.timeoutMs ?? timeoutMs;
    if (opts.signal) {
      fetchOpts.signal = opts.signal;
    } else if (effectiveTimeout > 0) {
      fetchOpts.signal = AbortSignal.timeout(effectiveTimeout);
    }

    const hasBody = opts.body !== undefined && opts.body !== null;
    if (hasBody && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
      if (isRawBody(opts.body)) {
        fetchOpts.body = opts.body;
      } else {
        fetchOpts.body = JSON.stringify(opts.body);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      }
    }

    const response = await fetch(url, fetchOpts);
    const text = upperMethod === 'HEAD' ? '' : await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: safeParseJson(text),
      ok: response.ok,
      url: response.url || url.toString(),
    };
  }

  return {
    request,
    get(reqPath, opts = {}) {
      return request('GET', reqPath, opts);
    },
    head(reqPath, opts = {}) {
      return request('HEAD', reqPath, opts);
    },
    options(reqPath, opts = {}) {
      return request('OPTIONS', reqPath, opts);
    },
    post(reqPath, body, opts = {}) {
      return request('POST', reqPath, {
        ...opts,
        body: body !== undefined ? body : opts?.body,
      });
    },
    put(reqPath, body, opts = {}) {
      return request('PUT', reqPath, {
        ...opts,
        body: body !== undefined ? body : opts?.body,
      });
    },
    patch(reqPath, body, opts = {}) {
      return request('PATCH', reqPath, {
        ...opts,
        body: body !== undefined ? body : opts?.body,
      });
    },
    del(reqPath, optsOrBody, maybeOpts) {
      if (maybeOpts !== undefined) {
        return request('DELETE', reqPath, { ...maybeOpts, body: optsOrBody });
      }
      return request('DELETE', reqPath, optsOrBody || {});
    },
  };
}

// ============================================================================
// 4. RFC 7636 PKCE (`computePkceChallenge`, `generatePkcePair`)
// ============================================================================

export function computePkceChallenge(codeVerifier) {
  if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) {
    throw new TypeError('computePkceChallenge requires a non-empty string codeVerifier');
  }
  return crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

export function generatePkcePair(byteLength = 48) {
  if (!Number.isInteger(byteLength) || byteLength < 32 || byteLength > 96) {
    throw new RangeError('generatePkcePair byteLength must be an integer between 32 and 96');
  }
  const codeVerifier = crypto.randomBytes(byteLength).toString('base64url');
  const codeChallenge = computePkceChallenge(codeVerifier);
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

// ============================================================================
// 5. Zero-Dependency HTML Tokenizer & OAuth Consent Form Parser
// ============================================================================

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeHtmlEntities(str) {
  if (typeof str !== 'string' || !str.includes('&')) return str ?? '';
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function findRawTextClose(html, startIndex, tagName) {
  const lower = html.toLowerCase();
  const needle = `</${tagName}`;
  let idx = startIndex;
  while (idx < html.length) {
    const pos = lower.indexOf(needle, idx);
    if (pos === -1) return { contentEnd: html.length, afterClose: html.length };
    const afterName = pos + needle.length;
    const nextCh = html[afterName];
    if (nextCh === '>' || nextCh === '/' || /\s/.test(nextCh || '')) {
      const gt = html.indexOf('>', afterName);
      return {
        contentEnd: pos,
        afterClose: gt === -1 ? html.length : gt + 1,
      };
    }
    idx = afterName;
  }
  return { contentEnd: html.length, afterClose: html.length };
}

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function skipHtmlComment(src, i) {
  // Handle HTML5 abruptly closed comments <!--> and <!--->
  if (src.startsWith('<!-->', i)) return i + 5;
  if (src.startsWith('<!--->', i)) return i + 6;
  const end = src.indexOf('-->', i + 4);
  return end === -1 ? src.length : end + 3;
}

function tokenizeHtml(html) {
  const tokens = [];
  const src = String(html || '');
  const len = src.length;
  let i = 0;

  while (i < len) {
    // HTML comment <!-- ... -->
    if (src.startsWith('<!--', i)) {
      i = skipHtmlComment(src, i);
      continue;
    }

    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (i < len) tokens.push({ type: 'text', raw: src.slice(i) });
      break;
    }

    if (lt > i) {
      tokens.push({ type: 'text', raw: src.slice(i, lt) });
      i = lt;
    }

    // Re-check comment right at lt
    if (src.startsWith('<!--', i)) {
      i = skipHtmlComment(src, i);
      continue;
    }

    // Declarations / Processing Instructions (<!DOCTYPE ...>, <?xml ...>)
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const gt = src.indexOf('>', i + 2);
      i = gt === -1 ? len : gt + 1;
      continue;
    }

    // Closing tag </tagName ...>
    if (src[i + 1] === '/') {
      let j = i + 2;
      while (j < len && /\s/.test(src[j])) j++;
      const nameStart = j;
      while (j < len && /[A-Za-z0-9:-]/.test(src[j])) j++;
      const tag = src.slice(nameStart, j).toLowerCase();
      const gt = src.indexOf('>', j);
      i = gt === -1 ? len : gt + 1;
      if (tag) {
        tokens.push({ type: 'close', tag });
      }
      continue;
    }

    // Opening tag <tagName ...>
    if (i + 1 < len && /[A-Za-z]/.test(src[i + 1])) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9:-]/.test(src[j])) j++;
      const tag = src.slice(i + 1, j).toLowerCase();
      const attrs = {};
      let selfClosing = false;
      const isVoidTag = VOID_HTML_TAGS.has(tag);

      while (j < len) {
        while (j < len && /\s/.test(src[j])) j++;
        if (j >= len) break;
        if (src[j] === '>') {
          j++;
          break;
        }
        if (src[j] === '/' && src[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        if (src[j] === '/') {
          j++;
          continue;
        }

        // Parse attribute name
        const attrStart = j;
        while (j < len && !/[\s=/>]/.test(src[j])) j++;
        const attrName = src.slice(attrStart, j).toLowerCase();
        if (!attrName) {
          j++;
          continue;
        }

        while (j < len && /\s/.test(src[j])) j++;

        if (src[j] === '=') {
          j++;
          while (j < len && /\s/.test(src[j])) j++;
          let rawVal = '';
          if (src[j] === '"' || src[j] === "'") {
            const quote = src[j++];
            const valStart = j;
            while (j < len && src[j] !== quote) j++;
            rawVal = src.slice(valStart, j);
            if (j < len && src[j] === quote) j++;
          } else {
            const valStart = j;
            while (j < len) {
              const ch = src[j];
              if (/\s/.test(ch) || ch === '>') break;
              if (isVoidTag && ch === '/' && src[j + 1] === '>') break;
              j++;
            }
            rawVal = src.slice(valStart, j);
          }
          if (!Object.prototype.hasOwnProperty.call(attrs, attrName)) {
            attrs[attrName] = decodeHtmlEntities(rawVal);
          }
        } else {
          if (!Object.prototype.hasOwnProperty.call(attrs, attrName)) {
            attrs[attrName] = '';
          }
        }
      }

      i = j;
      tokens.push({ type: 'open', tag, attrs, selfClosing });

      // Skip raw text inside <script> and <style> so decoy HTML strings are ignored.
      if (!selfClosing && (tag === 'script' || tag === 'style')) {
        const closeInfo = findRawTextClose(src, i, tag);
        i = closeInfo.afterClose;
      } else if (!selfClosing && tag === 'textarea') {
        // RCDATA inside <textarea>: preserve inner text verbatim without parsing nested tags.
        const closeInfo = findRawTextClose(src, i, 'textarea');
        tokens.push({ type: 'text', raw: src.slice(i, closeInfo.contentEnd) });
        tokens.push({ type: 'close', tag: 'textarea' });
        i = closeInfo.afterClose;
      }
      continue;
    }

    // Stray '<' not starting a valid tag — treat as text
    tokens.push({ type: 'text', raw: '<' });
    i++;
  }

  return tokens;
}

const DENY_WORD_RE = /\b(deny|denied|reject|rejected|cancel|cancelled|decline|declined|refuse|refused)\b/i;
const APPROVE_WORD_RE =
  /\b(approve|approved|allow|allowed|grant|granted|accept|accepted|confirm|confirmed|authorize|authorized|consent)\b/i;
const DENY_BOOL_RE = /^(no|false|0)$/i;
const APPROVE_BOOL_RE = /^(yes|true|1)$/i;
const CONSENT_NAME_RE = /(decision|consent|action|approve|allow|confirm|grant|authorize)/i;
const PASSCODE_NAME_RE = /(passcode|password|passphrase|household_?pin|\bpin\b|secret)/i;
const CODE_PARAM_EXCLUDE_RE = /^code(_|$)/i;
const MEMBER_EXACT_RE = /^(member|member_id|memberid|household_member|acting_member|subject_member)$/i;
const OAUTH_HIDDEN_NAMES = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'state',
  'resource',
  'response_type',
]);

function classifyConsentIntent(value, label, name = '', ariaLabel = '') {
  const valStr = String(value || '').trim();
  const valTokens = valStr.replace(/[_-]+/g, ' ');
  const nameTokens = String(name || '').trim().replace(/[_-]+/g, ' ');
  const labelStr = `${label || ''} ${ariaLabel || ''}`.trim();

  // 1. Explicit semantic words in value
  if (DENY_WORD_RE.test(valTokens)) return 'deny';
  if (APPROVE_WORD_RE.test(valTokens)) return 'approve';

  // 2. Explicit semantic words in label / aria-label (never prose "no"/"0"/"1")
  if (DENY_WORD_RE.test(labelStr)) return 'deny';
  if (APPROVE_WORD_RE.test(labelStr)) return 'approve';

  // 3. Strict negative boolean on value (^(no|false|0)$)
  if (DENY_BOOL_RE.test(valStr)) return 'deny';

  // 4. Explicit semantic words in name (preserves name="deny" value="1" and checkbox name="consent" value="on")
  if (DENY_WORD_RE.test(nameTokens)) return 'deny';
  if (APPROVE_WORD_RE.test(nameTokens)) return 'approve';

  // 5. Strict positive boolean on value (^(yes|true|1)$)
  if (APPROVE_BOOL_RE.test(valStr)) return 'approve';

  // 6. Unknown
  return 'unknown';
}

function safeResolveFormAction(rawAction, authorizeUrl) {
  const trimmedAction = typeof rawAction === 'string' ? rawAction.trim() : '';
  const trimmedBase = typeof authorizeUrl === 'string' ? authorizeUrl.trim() : '';
  if (trimmedAction) {
    try {
      return trimmedBase
        ? new URL(trimmedAction, trimmedBase).toString()
        : new URL(trimmedAction).toString();
    } catch {
      return trimmedAction;
    }
  }
  if (trimmedBase) {
    try {
      return new URL(trimmedBase).toString();
    } catch {
      return trimmedBase;
    }
  }
  return '';
}

function finalizeParsedForm(rawForm, authorizeUrl) {
  const rawAction = Object.prototype.hasOwnProperty.call(rawForm.attrs, 'action')
    ? rawForm.attrs.action
    : null;
  const action = safeResolveFormAction(rawAction, authorizeUrl);
  const hasExplicitMethod = Boolean(rawForm.attrs.method && rawForm.attrs.method.trim());
  const method = hasExplicitMethod ? rawForm.attrs.method.trim().toUpperCase() : 'POST';

  // Attach <label for="..."> text onto controls first, then fall back to aria-label
  // only after both wrapping <label> and <label for="..."> have been resolved.
  const controls = rawForm.controls.map((ctrl) => {
    let resolvedLabel = ctrl.label || '';
    if (!resolvedLabel && ctrl.id && rawForm.labelsByFor.has(ctrl.id)) {
      resolvedLabel = rawForm.labelsByFor.get(ctrl.id);
    }
    if (!resolvedLabel && ctrl.ariaLabel) {
      resolvedLabel = ctrl.ariaLabel;
    }
    if (resolvedLabel !== ctrl.label) {
      return { ...ctrl, label: resolvedLabel };
    }
    return ctrl;
  });

  const hiddenFields = {};
  const fields = {};
  const submitButtons = [];

  // HTML5 radio button group rule: when multiple non-disabled radios share a name with
  // checked=true, only the last checked radio in document order is active.
  const lastCheckedRadioByName = new Map();
  for (const ctrl of controls) {
    if (!ctrl.disabled && ctrl.name && ctrl.tag === 'input' && ctrl.type === 'radio' && ctrl.checked) {
      lastCheckedRadioByName.set(ctrl.name, ctrl);
    }
  }

  const setFieldValue = (name, value, isMulti) => {
    if (!name) return;
    if (isMulti) {
      if (!Object.prototype.hasOwnProperty.call(fields, name)) {
        fields[name] = [value];
      } else if (Array.isArray(fields[name])) {
        fields[name].push(value);
      } else {
        fields[name] = [fields[name], value];
      }
    } else if (Object.prototype.hasOwnProperty.call(fields, name)) {
      if (Array.isArray(fields[name])) fields[name].push(value);
      else fields[name] = [fields[name], value];
    } else {
      fields[name] = value;
    }
  };

  for (const ctrl of controls) {
    if (ctrl.tag === 'button' || (ctrl.tag === 'input' && (ctrl.type === 'submit' || ctrl.type === 'image'))) {
      if (ctrl.tag === 'button' && ctrl.type !== 'submit') continue;
      submitButtons.push({
        tag: ctrl.tag,
        name: ctrl.name || '',
        value: ctrl.value ?? '',
        label: ctrl.label || ctrl.ariaLabel || ctrl.value || '',
        ariaLabel: ctrl.ariaLabel || '',
        disabled: Boolean(ctrl.disabled),
      });
      continue;
    }

    if (ctrl.disabled || !ctrl.name) continue;

    if (ctrl.tag === 'input') {
      if (ctrl.type === 'hidden') {
        hiddenFields[ctrl.name] = ctrl.value;
        setFieldValue(ctrl.name, ctrl.value, false);
      } else if (ctrl.type === 'checkbox') {
        if (ctrl.checked) {
          setFieldValue(ctrl.name, ctrl.value, true);
        }
      } else if (ctrl.type === 'radio') {
        if (ctrl.checked && lastCheckedRadioByName.get(ctrl.name) === ctrl) {
          setFieldValue(ctrl.name, ctrl.value, false);
        }
      } else if (ctrl.type !== 'button' && ctrl.type !== 'reset' && ctrl.type !== 'file') {
        setFieldValue(ctrl.name, ctrl.value, false);
      }
    } else if (ctrl.tag === 'textarea') {
      setFieldValue(ctrl.name, ctrl.value, false);
    } else if (ctrl.tag === 'select') {
      const enabledOpts = (ctrl.options || []).filter((o) => !o.disabled);
      const selectedOpts = enabledOpts.filter((o) => o.selected);
      if (ctrl.multiple) {
        if (selectedOpts.length > 0) {
          fields[ctrl.name] = selectedOpts.map((o) => o.value);
        }
      } else if (selectedOpts.length > 0) {
        fields[ctrl.name] = selectedOpts[selectedOpts.length - 1].value;
      } else if (enabledOpts.length > 0) {
        fields[ctrl.name] = enabledOpts[0].value;
      }
    }
  }

  const enabledControls = controls.filter((c) => !c.disabled);

  // 1) Detect passcodeField
  let passcodeField = null;
  const passwordInput = enabledControls.find(
    (c) => c.tag === 'input' && c.type === 'password' && c.name
  );
  if (passwordInput) {
    passcodeField = passwordInput.name;
  } else {
    const fallbackPass = enabledControls.find(
      (c) =>
        c.tag === 'input' &&
        (c.type === 'text' || c.type === 'tel' || c.type === 'search') &&
        c.name &&
        !CODE_PARAM_EXCLUDE_RE.test(c.name) &&
        (PASSCODE_NAME_RE.test(c.name) || PASSCODE_NAME_RE.test(c.id || ''))
    );
    if (fallbackPass) passcodeField = fallbackPass.name;
  }

  // 2) Detect scopeFields
  const allScopeCandidates = enabledControls.filter(
    (c) =>
      c.name &&
      c.tag !== 'button' &&
      c.type !== 'submit' &&
      (/^scopes?(\[\])?$/i.test(c.name) || /scope/i.test(c.name))
  );
  const visibleScopeCandidates = allScopeCandidates.filter(
    (c) => !(c.tag === 'input' && c.type === 'hidden')
  );
  const chosenScopes =
    visibleScopeCandidates.length > 0 ? visibleScopeCandidates : allScopeCandidates;
  const scopeFields = chosenScopes.map((c) => ({
    name: c.name,
    tag: c.tag,
    type: c.type || c.tag,
    value: c.value,
    multiple: Boolean(c.multiple),
    options: c.options ? c.options.map((o) => ({ ...o })) : undefined,
  }));

  // 3) Detect memberField
  const allMemberCandidates = enabledControls.filter(
    (c) =>
      c.name &&
      c.tag !== 'button' &&
      c.type !== 'submit' &&
      (MEMBER_EXACT_RE.test(c.name) || /member/i.test(c.name))
  );
  const visibleMemberCandidates = allMemberCandidates.filter(
    (c) => !(c.tag === 'input' && c.type === 'hidden')
  );
  const memberMatch =
    visibleMemberCandidates.find((c) => c.tag === 'select') ||
    visibleMemberCandidates.find((c) => MEMBER_EXACT_RE.test(c.name)) ||
    visibleMemberCandidates[0] ||
    allMemberCandidates[0] ||
    null;
  const memberField = memberMatch
    ? {
        name: memberMatch.name,
        tag: memberMatch.tag,
        type: memberMatch.type || memberMatch.tag,
        options: memberMatch.options ? memberMatch.options.map((o) => ({ ...o })) : undefined,
      }
    : null;

  // 4) Detect consentControls
  const consentControls = [];
  for (const btn of submitButtons) {
    if (btn.disabled) continue;
    if (btn.name) {
      consentControls.push({
        name: btn.name,
        tag: btn.tag,
        type: 'submit',
        value: btn.value,
        label: btn.label,
        intent: classifyConsentIntent(btn.value, btn.label, btn.name, btn.ariaLabel),
      });
    }
  }
  for (const c of enabledControls) {
    if (c.tag === 'input' && (c.type === 'checkbox' || c.type === 'radio') && c.name) {
      if (
        CONSENT_NAME_RE.test(c.name) ||
        CONSENT_NAME_RE.test(c.label || '') ||
        CONSENT_NAME_RE.test(c.ariaLabel || '')
      ) {
        consentControls.push({
          name: c.name,
          tag: 'input',
          type: c.type,
          value: c.value,
          label: c.label || c.ariaLabel || '',
          intent: classifyConsentIntent(c.value, c.label || '', c.name, c.ariaLabel || ''),
        });
      }
    }
  }
  if (consentControls.length === 0) {
    for (const c of enabledControls) {
      if (c.tag === 'input' && c.type === 'hidden' && c.name && CONSENT_NAME_RE.test(c.name)) {
        consentControls.push({
          name: c.name,
          tag: 'input',
          type: 'hidden',
          value: c.value,
          label: '',
          intent: classifyConsentIntent(c.value, '', c.name, ''),
        });
      }
    }
  }

  // Score form to select primary consent form vs separate deny form.
  const hasPassword = Boolean(passwordInput);
  const hasOAuthHidden = Object.keys(hiddenFields).some((k) => OAUTH_HIDDEN_NAMES.has(k));
  const hasDenyControl =
    consentControls.some((c) => c.intent === 'deny') ||
    submitButtons.some(
      (b) => !b.disabled && classifyConsentIntent(b.value, b.label, b.name, b.ariaLabel) === 'deny'
    );
  const hasApproveControl =
    consentControls.some((c) => c.intent === 'approve') ||
    submitButtons.some(
      (b) => !b.disabled && classifyConsentIntent(b.value, b.label, b.name, b.ariaLabel) === 'approve'
    );
  const isDenyOnly = !hasPassword && hasDenyControl && !hasApproveControl;

  let score = 0;
  if (hasPassword) score += 4;
  if (hasOAuthHidden) score += 3;
  if (/(authorize|oauth)/i.test(action)) score += 2;
  if (method === 'POST') score += 1;
  if (isDenyOnly) score -= 3;

  return {
    action,
    rawAction,
    method,
    hasExplicitMethod,
    hiddenFields,
    controls,
    fields,
    submitButtons,
    detected: {
      passcodeField,
      scopeFields,
      memberField,
      consentControls,
    },
    _score: score,
    _isDenyOnly: isDenyOnly,
  };
}

export function parseAuthorizeForm(html, authorizeUrl) {
  const tokens = tokenizeHtml(html);
  const rawForms = [];
  let currentForm = null;
  let currentSelect = null;
  let currentOption = null;
  let currentTextarea = null;
  let currentButton = null;
  let currentLabel = null;

  const flushOption = () => {
    if (!currentOption || !currentSelect) return;
    const label = decodeHtmlEntities(currentOption.text).replace(/\s+/g, ' ').trim();
    const hasValueAttr = Object.prototype.hasOwnProperty.call(currentOption.attrs, 'value');
    currentSelect.options.push({
      value: hasValueAttr ? currentOption.attrs.value : label,
      label,
      selected: Object.prototype.hasOwnProperty.call(currentOption.attrs, 'selected'),
      disabled: Object.prototype.hasOwnProperty.call(currentOption.attrs, 'disabled'),
    });
    currentOption = null;
  };

  const finalizeButton = (btn) => {
    const decodedText = decodeHtmlEntities(btn._rawLabel || '')
      .replace(/\s+/g, ' ')
      .trim();
    btn.label = decodedText || btn.ariaLabel || '';
    delete btn._rawLabel;
    return btn;
  };

  const flushLabel = () => {
    if (!currentLabel || !currentForm) return;
    const labelText = decodeHtmlEntities(currentLabel.text).replace(/\s+/g, ' ').trim();
    if (labelText) {
      if (currentLabel.forId) {
        currentForm.labelsByFor.set(currentLabel.forId, labelText);
      } else {
        // HTML5 §4.10.4: a wrapping <label> labels only its first non-hidden labelable control.
        const target = currentLabel.controls.find(
          (c) => !(c.tag === 'input' && c.type === 'hidden')
        );
        if (target && !target.label) {
          target.label = labelText;
        }
      }
    }
    currentLabel = null;
  };

  const flushForm = () => {
    if (!currentForm) return;
    flushOption();
    if (currentSelect) {
      currentForm.controls.push(currentSelect);
      currentSelect = null;
    }
    if (currentTextarea) {
      currentForm.controls.push(currentTextarea);
      currentTextarea = null;
    }
    if (currentButton) {
      currentForm.controls.push(finalizeButton(currentButton));
      currentButton = null;
    }
    flushLabel();
    rawForms.push(currentForm);
    currentForm = null;
  };

  for (const tok of tokens) {
    if (tok.type === 'open') {
      const { tag, attrs, selfClosing } = tok;
      if (tag === 'form') {
        if (currentForm) flushForm();
        currentForm = { attrs, controls: [], labelsByFor: new Map() };
        continue;
      }
      if (!currentForm) continue;

      if (tag === 'label' && !selfClosing) {
        if (currentLabel) flushLabel();
        currentLabel = { forId: (attrs.for || '').trim(), text: '', controls: [] };
      } else if (tag === 'input') {
        const type = (attrs.type || 'text').trim().toLowerCase();
        const hasValueAttr = Object.prototype.hasOwnProperty.call(attrs, 'value');
        const value = hasValueAttr
          ? attrs.value
          : type === 'checkbox' || type === 'radio'
            ? 'on'
            : '';
        const ariaLabel = (attrs['aria-label'] || '').trim();
        const ctrl = {
          tag: 'input',
          type,
          name: attrs.name ?? '',
          id: attrs.id ?? '',
          value,
          checked: Object.prototype.hasOwnProperty.call(attrs, 'checked'),
          disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
          required: Object.prototype.hasOwnProperty.call(attrs, 'required'),
          ariaLabel,
          label: '',
        };
        currentForm.controls.push(ctrl);
        if (currentLabel) currentLabel.controls.push(ctrl);
      } else if (tag === 'select') {
        flushOption();
        if (currentSelect) currentForm.controls.push(currentSelect);
        const ariaLabel = (attrs['aria-label'] || '').trim();
        currentSelect = {
          tag: 'select',
          type: 'select',
          name: attrs.name ?? '',
          id: attrs.id ?? '',
          multiple: Object.prototype.hasOwnProperty.call(attrs, 'multiple'),
          disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
          required: Object.prototype.hasOwnProperty.call(attrs, 'required'),
          ariaLabel,
          label: '',
          options: [],
        };
        if (currentLabel) currentLabel.controls.push(currentSelect);
        if (selfClosing) {
          currentForm.controls.push(currentSelect);
          currentSelect = null;
        }
      } else if (tag === 'option' && currentSelect) {
        flushOption();
        currentOption = { attrs, text: '' };
        if (selfClosing) flushOption();
      } else if (tag === 'textarea') {
        const ariaLabel = (attrs['aria-label'] || '').trim();
        currentTextarea = {
          tag: 'textarea',
          type: 'textarea',
          name: attrs.name ?? '',
          id: attrs.id ?? '',
          value: '',
          disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
          required: Object.prototype.hasOwnProperty.call(attrs, 'required'),
          ariaLabel,
          label: '',
        };
        if (currentLabel) currentLabel.controls.push(currentTextarea);
        if (selfClosing) {
          currentForm.controls.push(currentTextarea);
          currentTextarea = null;
        }
      } else if (tag === 'button') {
        if (currentButton) {
          currentForm.controls.push(finalizeButton(currentButton));
        }
        const type = (attrs.type || 'submit').trim().toLowerCase();
        const ariaLabel = (attrs['aria-label'] || '').trim();
        currentButton = {
          tag: 'button',
          type,
          name: attrs.name ?? '',
          id: attrs.id ?? '',
          value: attrs.value ?? '',
          disabled: Object.prototype.hasOwnProperty.call(attrs, 'disabled'),
          ariaLabel,
          label: ariaLabel,
          _rawLabel: '',
        };
        if (selfClosing) {
          currentForm.controls.push(finalizeButton(currentButton));
          currentButton = null;
        }
      }
    } else if (tok.type === 'text') {
      if (!currentForm) continue;
      if (currentOption) currentOption.text += tok.raw;
      if (currentTextarea) currentTextarea.value += decodeHtmlEntities(tok.raw);
      if (currentButton) currentButton._rawLabel += tok.raw;
      if (currentLabel && !currentOption && !currentTextarea && !currentButton) {
        currentLabel.text += tok.raw;
      }
    } else if (tok.type === 'close') {
      if (!currentForm) continue;
      const { tag } = tok;
      if (tag === 'form') {
        flushForm();
      } else if (tag === 'option' || tag === 'optgroup') {
        flushOption();
      } else if (tag === 'select' && currentSelect) {
        flushOption();
        currentForm.controls.push(currentSelect);
        currentSelect = null;
      } else if (tag === 'textarea' && currentTextarea) {
        currentForm.controls.push(currentTextarea);
        currentTextarea = null;
      } else if (tag === 'button' && currentButton) {
        currentForm.controls.push(finalizeButton(currentButton));
        currentButton = null;
      } else if (tag === 'label' && currentLabel) {
        flushLabel();
      }
    }
  }
  if (currentForm) flushForm();

  if (rawForms.length === 0) {
    return {
      action: safeResolveFormAction(null, authorizeUrl),
      rawAction: null,
      method: 'POST',
      hasExplicitMethod: false,
      hiddenFields: {},
      controls: [],
      fields: {},
      submitButtons: [],
      detected: {
        passcodeField: null,
        scopeFields: [],
        memberField: null,
        consentControls: [],
      },
      denyForm: null,
      formsCount: 0,
      forms: [],
    };
  }

  const parsedForms = rawForms.map((rf) => finalizeParsedForm(rf, authorizeUrl));
  let bestIdx = 0;
  for (let idx = 1; idx < parsedForms.length; idx++) {
    if (parsedForms[idx]._score > parsedForms[bestIdx]._score) {
      bestIdx = idx;
    }
  }

  const primary = parsedForms[bestIdx];
  const denyCandidate =
    parsedForms.find((f, idx) => idx !== bestIdx && f._isDenyOnly) || null;

  const stripInternal = (f) => {
    const { _score, _isDenyOnly, ...rest } = f;
    return rest;
  };

  const cleanForms = parsedForms.map(stripInternal);
  const cleanPrimary = cleanForms[bestIdx];
  const cleanDenyForm = denyCandidate ? stripInternal(denyCandidate) : null;

  return {
    ...cleanPrimary,
    denyForm: cleanDenyForm,
    formsCount: cleanForms.length,
    forms: cleanForms,
  };
}

export function buildAuthorizeFormBody(
  parsedForm,
  {
    passcode,
    wrongPasscode = false,
    scope,
    memberId,
    denyConsent = false,
    skipConsent = false,
    extraFormFields,
  } = {}
) {
  const form = denyConsent && parsedForm?.denyForm ? parsedForm.denyForm : parsedForm;
  const params = new URLSearchParams();

  // 1) Walk non-disabled non-submit controls in document order so hidden + visible
  // controls sharing the same `name` (e.g. hidden=0 + checked checkbox=1) are both preserved.
  const consentControlNames = new Set(
    (form.detected?.consentControls || []).map((c) => c.name).filter(Boolean)
  );
  const appendedFromControls = new Set();
  const lastCheckedRadioByName = new Map();
  for (const ctrl of form.controls || []) {
    if (!ctrl.disabled && ctrl.name && ctrl.tag === 'input' && ctrl.type === 'radio' && ctrl.checked) {
      lastCheckedRadioByName.set(ctrl.name, ctrl);
    }
  }

  for (const ctrl of form.controls || []) {
    if (ctrl.disabled || !ctrl.name) continue;
    if (ctrl.tag === 'button') continue;

    if (ctrl.tag === 'input') {
      if (
        ctrl.type === 'submit' ||
        ctrl.type === 'image' ||
        ctrl.type === 'button' ||
        ctrl.type === 'reset' ||
        ctrl.type === 'file'
      ) {
        continue;
      }
      if (ctrl.type === 'hidden') {
        params.append(ctrl.name, ctrl.value);
        appendedFromControls.add(ctrl.name);
      } else if (ctrl.type === 'checkbox') {
        if (!consentControlNames.has(ctrl.name) && ctrl.checked) {
          params.append(ctrl.name, ctrl.value);
          appendedFromControls.add(ctrl.name);
        }
      } else if (ctrl.type === 'radio') {
        if (
          !consentControlNames.has(ctrl.name) &&
          ctrl.checked &&
          lastCheckedRadioByName.get(ctrl.name) === ctrl
        ) {
          params.append(ctrl.name, ctrl.value);
          appendedFromControls.add(ctrl.name);
        }
      } else if (!consentControlNames.has(ctrl.name)) {
        params.append(ctrl.name, ctrl.value);
        appendedFromControls.add(ctrl.name);
      }
    } else if (ctrl.tag === 'textarea') {
      if (!consentControlNames.has(ctrl.name)) {
        params.append(ctrl.name, ctrl.value);
        appendedFromControls.add(ctrl.name);
      }
    } else if (ctrl.tag === 'select') {
      if (!consentControlNames.has(ctrl.name)) {
        const enabledOpts = (ctrl.options || []).filter((o) => !o.disabled);
        const selectedOpts = enabledOpts.filter((o) => o.selected);
        if (ctrl.multiple) {
          for (const opt of selectedOpts) {
            params.append(ctrl.name, opt.value);
          }
          if (selectedOpts.length > 0) appendedFromControls.add(ctrl.name);
        } else if (selectedOpts.length > 0) {
          params.append(ctrl.name, selectedOpts[selectedOpts.length - 1].value);
          appendedFromControls.add(ctrl.name);
        } else if (enabledOpts.length > 0) {
          params.append(ctrl.name, enabledOpts[0].value);
          appendedFromControls.add(ctrl.name);
        }
      }
    }
  }

  // Fallback for synthetic parsedForm objects without populated `controls`
  for (const [k, v] of Object.entries(form.hiddenFields || {})) {
    if (!appendedFromControls.has(k)) {
      params.set(k, String(v));
      appendedFromControls.add(k);
    }
  }

  for (const [k, v] of Object.entries(form.fields || {})) {
    if (appendedFromControls.has(k)) continue;
    if (consentControlNames.has(k)) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.set(k, String(v));
    }
  }

  // 2) Passcode
  const effectivePasscode =
    wrongPasscode === true
      ? 'wrong-passcode-e2e'
      : typeof wrongPasscode === 'string'
        ? wrongPasscode
        : passcode;

  if (effectivePasscode !== undefined) {
    if (form.detected?.passcodeField) {
      params.set(form.detected.passcodeField, String(effectivePasscode));
    } else if (!denyConsent) {
      params.set('passcode', String(effectivePasscode));
    }
  }

  // 3) Scope
  if (scope !== undefined) {
    const scopeStr = String(scope).trim();
    const wanted = scopeStr.split(/[\s,]+/).filter(Boolean);
    const wantedLower = new Set(wanted.map((w) => w.toLowerCase()));
    const scopeFields = form.detected?.scopeFields || [];

    const checkboxFields = scopeFields.filter(
      (f) => f.tag === 'input' && f.type === 'checkbox'
    );
    const selectField = scopeFields.find((f) => f.tag === 'select');
    const textOrHiddenField = scopeFields.find(
      (f) => f.tag === 'input' && f.type !== 'checkbox' && f.type !== 'radio'
    );
    const radioFields = scopeFields.filter((f) => f.tag === 'input' && f.type === 'radio');

    if (checkboxFields.length > 0) {
      const byName = new Map();
      for (const cb of checkboxFields) {
        if (!byName.has(cb.name)) byName.set(cb.name, []);
        byName.get(cb.name).push(cb);
      }
      for (const [name, cbs] of byName.entries()) {
        params.delete(name);
        if (cbs.length > 1) {
          let matchedAny = false;
          for (const cb of cbs) {
            if (wantedLower.has(String(cb.value || '').toLowerCase())) {
              params.append(name, cb.value);
              matchedAny = true;
            }
          }
          if (!matchedAny && scopeStr) {
            params.append(name, scopeStr);
          }
        } else {
          const cb = cbs[0];
          const valLower = String(cb.value || '').toLowerCase();
          const nameLower = name.toLowerCase();
          const matchesVal = wantedLower.has(valLower);
          const matchesSuffix = [...wantedLower].some((w) => nameLower.endsWith(`_${w}`));
          if (matchesVal || matchesSuffix) {
            params.append(name, cb.value || 'on');
          }
        }
      }
    } else if (selectField) {
      const enabledOpts = (selectField.options || []).filter((o) => !o.disabled);
      params.delete(selectField.name);
      if (selectField.multiple) {
        let matchedAny = false;
        for (const opt of enabledOpts) {
          if (wantedLower.has(String(opt.value).toLowerCase())) {
            params.append(selectField.name, opt.value);
            matchedAny = true;
          }
        }
        if (!matchedAny && scopeStr) params.set(selectField.name, scopeStr);
      } else {
        const pickSingleChoice = (candidates) => {
          const exact = candidates.find((c) => c.value === scopeStr);
          if (exact) return exact;
          if (wanted.length > 0) {
            const containsAll = candidates.find((c) => {
              const tokens = new Set(String(c.value).toLowerCase().split(/[\s,]+/).filter(Boolean));
              return wanted.every((w) => tokens.has(w.toLowerCase()));
            });
            if (containsAll) return containsAll;
            for (const priv of ['write', 'propose', 'read']) {
              if (wantedLower.has(priv)) {
                const found = candidates.find((c) => String(c.value).toLowerCase() === priv);
                if (found) return found;
              }
            }
          }
          return null;
        };
        const chosen = pickSingleChoice(enabledOpts);
        params.set(selectField.name, chosen ? chosen.value : scopeStr);
      }
    } else if (radioFields.length > 0) {
      const radioName = radioFields[0].name;
      const exact = radioFields.find((r) => r.value === scopeStr);
      const containsAll =
        !exact &&
        wanted.length > 0 &&
        radioFields.find((r) => {
          const tokens = new Set(String(r.value).toLowerCase().split(/[\s,]+/).filter(Boolean));
          return wanted.every((w) => tokens.has(w.toLowerCase()));
        });
      let highestPriv = null;
      if (!exact && !containsAll && wanted.length > 0) {
        for (const priv of ['write', 'propose', 'read']) {
          if (wantedLower.has(priv)) {
            const found = radioFields.find((r) => String(r.value).toLowerCase() === priv);
            if (found) {
              highestPriv = found;
              break;
            }
          }
        }
      }
      const chosen = exact || containsAll || highestPriv;
      params.set(radioName, chosen ? chosen.value : scopeStr);
    } else if (textOrHiddenField) {
      params.set(textOrHiddenField.name, scopeStr);
    }
  }

  // 4) Member selection
  if (memberId !== undefined && form.detected?.memberField) {
    const mf = form.detected.memberField;
    if (mf.tag === 'select') {
      const enabledOpts = (mf.options || []).filter((o) => !o.disabled);
      const targetLower = String(memberId).toLowerCase();
      const match =
        enabledOpts.find((o) => o.value === memberId) ||
        enabledOpts.find((o) => String(o.value).toLowerCase() === targetLower) ||
        enabledOpts.find((o) => String(o.label).toLowerCase() === targetLower);
      params.set(mf.name, match ? match.value : String(memberId));
    } else {
      params.set(mf.name, String(memberId));
    }
  }

  // 5) Consent / Decision controls
  const consentControls = form.detected?.consentControls || [];
  if (skipConsent) {
    for (const c of consentControls) {
      if (c.name) params.delete(c.name);
    }
  } else if (denyConsent) {
    for (const c of consentControls) {
      if (c.name && c.intent !== 'deny' && c.type !== 'hidden') {
        params.delete(c.name);
      }
    }
    const denyCtrl = consentControls.find((c) => c.intent === 'deny' && c.name);
    if (denyCtrl) {
      params.set(denyCtrl.name, denyCtrl.value);
    } else if (!parsedForm?.denyForm) {
      const anyDecision = consentControls.find((c) => c.name);
      if (anyDecision) params.set(anyDecision.name, 'deny');
    }
  } else {
    // Approve consent (default)
    for (const c of consentControls) {
      if (c.type === 'checkbox' && c.name && (c.intent === 'approve' || c.intent === 'unknown')) {
        params.set(c.name, c.value || 'on');
      }
    }
    const approveRadio = consentControls.find(
      (c) => c.type === 'radio' && c.name && c.intent === 'approve'
    );
    if (approveRadio) {
      params.set(approveRadio.name, approveRadio.value);
    }
    const namedSubmits = consentControls.filter((c) => c.type === 'submit' && c.name);
    const approveSubmit =
      namedSubmits.find((c) => c.intent === 'approve') ||
      (namedSubmits.length === 1 && namedSubmits[0].intent !== 'deny' ? namedSubmits[0] : null);
    if (approveSubmit) {
      params.set(approveSubmit.name, approveSubmit.value);
    }
  }

  // 6) Surgical overrides
  if (extraFormFields && typeof extraFormFields === 'object') {
    for (const [k, v] of Object.entries(extraFormFields)) {
      if (v === null || v === undefined) {
        params.delete(k);
      } else if (Array.isArray(v)) {
        params.delete(k);
        for (const item of v) params.append(k, String(item));
      } else {
        params.set(k, String(v));
      }
    }
  }

  return {
    action: form.action,
    method: form.method,
    params,
  };
}

// ============================================================================
// 6. OAuth 2.1 Discovery, DCR, CIMD, Authorize, Token, Refresh & Revoke
// ============================================================================

function extractCookieHeader(headers) {
  if (!headers || typeof headers.getSetCookie !== 'function') return '';
  const pairs = [];
  for (const raw of headers.getSetCookie()) {
    const firstPart = raw.split(';', 1)[0]?.trim();
    if (firstPart && firstPart.includes('=')) {
      pairs.push(firstPart);
    }
  }
  return pairs.join('; ');
}

function parseRedirectLocation(locationHeader, fallbackBase) {
  if (!locationHeader) return null;
  let url;
  try {
    url = new URL(locationHeader, fallbackBase);
  } catch {
    return null;
  }
  return {
    location: locationHeader,
    url: url.toString(),
    origin: url.origin,
    pathname: url.pathname,
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    iss: url.searchParams.get('iss'),
    error: url.searchParams.get('error'),
    errorDescription: url.searchParams.get('error_description'),
    params: Object.fromEntries(url.searchParams.entries()),
  };
}

function resolveEndpoint(candidate, fallbackPath, baseUrl) {
  const tryResolve = (val) => {
    if (typeof val !== 'string' || !val.trim()) return null;
    const trimmed = val.trim();
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        return new URL(trimmed).toString();
      }
      if (baseUrl) {
        return resolveSubpathUrl(trimmed, baseUrl).toString();
      }
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  };

  const fromCandidate = tryResolve(candidate);
  if (fromCandidate) return fromCandidate;

  const fromFallback = tryResolve(fallbackPath);
  if (fromFallback) return fromFallback;

  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const cleanFallback = String(fallbackPath || '');
  return cleanBase
    ? `${cleanBase}${cleanFallback.startsWith('/') ? '' : '/'}${cleanFallback}`
    : cleanFallback;
}

function normalizeOAuthContentType(contentType = 'form') {
  if (typeof contentType === 'string' && /json/i.test(contentType)) {
    return 'json';
  }
  return 'form';
}

function encodeOAuthPayload(bodyObj, contentType = 'form') {
  const mode = normalizeOAuthContentType(contentType);
  if (mode === 'json') {
    return {
      contentTypeHeader: 'application/json',
      body: JSON.stringify(bodyObj),
    };
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(bodyObj)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  return {
    contentTypeHeader: 'application/x-www-form-urlencoded',
    body: params.toString(),
  };
}

export async function runOAuthFlow({
  baseUrl,
  passcode,
  scope = 'read',
  memberId,
  clientName = 'home-pharmacy-e2e-client',
  redirectUri = 'http://127.0.0.1:19999/oauth/callback',
  resource,
  clientId,
  clientSecret,
  state,
  pkce,
  wrongVerifier = false,
  wrongPasscode = false,
  denyConsent = false,
  skipConsent = false,
  skipDiscovery = false,
  tokenContentType,
  contentType,
  customRegisterBody,
  customAuthorizeQuery,
  extraFormFields,
  customTokenBody,
  headers: extraHeaders,
} = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new TypeError('runOAuthFlow requires a non-empty baseUrl string');
  }

  const client = createApiClient({
    baseUrl,
    defaultHeaders: extraHeaders || {},
  });

  const effectivePkce = pkce ?? generatePkcePair();
  const effectiveState = state ?? crypto.randomBytes(16).toString('base64url');
  const effectiveContentType = tokenContentType ?? contentType ?? 'form';

  let protectedResource = null;
  let protectedResourceMcp = null;
  let authorizationServer = null;
  let registration = null;
  let authorizeGet = null;
  let parsedForm = null;
  let authorizePost = null;
  let callback = null;
  let tokenResponse = null;
  let effectiveClientId = clientId ?? null;
  let effectiveClientSecret = clientSecret ?? null;
  let overrideError = null;

  let registrationEndpoint = resolveEndpoint(null, '/oauth/register', baseUrl);
  let authorizationEndpoint = resolveEndpoint(null, '/oauth/authorize', baseUrl);
  let tokenEndpoint = resolveEndpoint(null, '/oauth/token', baseUrl);
  let revocationEndpoint = resolveEndpoint(null, '/oauth/revoke', baseUrl);

  const buildResult = () => {
    const ok = Boolean(tokenResponse?.ok && tokenResponse?.json?.access_token);
    let err = null;
    if (!ok) {
      if (overrideError) {
        err = overrideError;
      } else if (tokenResponse) {
        err =
          tokenResponse.json?.error ??
          (!tokenResponse.ok ? `token_${tokenResponse.status}` : 'token_missing_access_token');
      } else if (callback?.error) {
        err = callback.error;
      } else if (authorizePost && !callback?.code) {
        err = authorizePost.json?.error ?? `authorize_post_${authorizePost.status}`;
      } else if (authorizeGet && !parsedForm && !callback?.code) {
        err = authorizeGet.json?.error ?? `authorize_get_${authorizeGet.status}`;
      } else if (registration && !registration.json?.client_id) {
        err =
          registration.json?.error ??
          (!registration.ok ? `register_${registration.status}` : 'register_missing_client_id');
      }
    }

    const redirectLocation =
      callback?.location ??
      authorizePost?.headers?.get?.('location') ??
      authorizeGet?.headers?.get?.('location') ??
      null;

    return {
      ok,
      error: err,
      clientId: effectiveClientId,
      clientSecret: effectiveClientSecret,
      redirectUri,
      state: effectiveState,
      pkce: effectivePkce,
      endpoints: {
        registrationEndpoint,
        authorizationEndpoint,
        tokenEndpoint,
        revocationEndpoint,
      },
      discovery: {
        protectedResource,
        protectedResourceMcp,
        authorizationServer,
      },
      // Top-level ergonomic aliases
      protectedResource,
      protectedResourceMcp,
      authServerMetadata: authorizationServer?.json ?? null,
      registration,
      authorizeGet,
      parsedForm,
      authorizePost,
      callback,
      redirectLocation,
      callbackParams: callback?.params ?? null,
      code: callback?.code ?? null,
      iss: callback?.iss ?? null,
      returnedState: callback?.state ?? null,
      tokenResponse,
      accessToken: tokenResponse?.json?.access_token ?? null,
      refreshToken: tokenResponse?.json?.refresh_token ?? null,
      tokenType: tokenResponse?.json?.token_type ?? null,
      expiresIn: tokenResponse?.json?.expires_in ?? null,
      grantedScope: tokenResponse?.json?.scope ?? null,
    };
  };

  // Step 1: Discovery (RFC 9728 + RFC 8414)
  if (!skipDiscovery) {
    protectedResource = await client.get('/.well-known/oauth-protected-resource', { auth: false });
    protectedResourceMcp = await client.get('/.well-known/oauth-protected-resource/mcp', {
      auth: false,
    });
    authorizationServer = await client.get('/.well-known/oauth-authorization-server', {
      auth: false,
    });

    const asMeta = authorizationServer?.json;
    registrationEndpoint = resolveEndpoint(asMeta?.registration_endpoint, '/oauth/register', baseUrl);
    authorizationEndpoint = resolveEndpoint(
      asMeta?.authorization_endpoint,
      '/oauth/authorize',
      baseUrl
    );
    tokenEndpoint = resolveEndpoint(asMeta?.token_endpoint, '/oauth/token', baseUrl);
    revocationEndpoint = resolveEndpoint(asMeta?.revocation_endpoint, '/oauth/revoke', baseUrl);
  }

  // Step 2: Optional RFC 7591 Dynamic Client Registration (skipped if clientId provided, e.g., CIMD)
  if (!effectiveClientId) {
    const registerBody = {
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
      ...(customRegisterBody || {}),
    };
    registration = await client.post(registrationEndpoint, registerBody, { auth: false });
    if (!registration.ok || !registration.json?.client_id) {
      return buildResult();
    }
    effectiveClientId = registration.json.client_id;
    if (registration.json.client_secret && !effectiveClientSecret) {
      effectiveClientSecret = registration.json.client_secret;
    }
  }

  // Step 3: GET /oauth/authorize (redirect: 'manual')
  const authorizeQuery = {
    response_type: 'code',
    client_id: effectiveClientId,
    redirect_uri: redirectUri,
    scope,
    state: effectiveState,
    code_challenge: effectivePkce.codeChallenge,
    code_challenge_method: effectivePkce.codeChallengeMethod,
  };
  if (resource !== undefined) authorizeQuery.resource = resource;
  if (memberId !== undefined) authorizeQuery.member_id = memberId;
  if (customAuthorizeQuery && typeof customAuthorizeQuery === 'object') {
    for (const [k, v] of Object.entries(customAuthorizeQuery)) {
      if (v === null || v === undefined) delete authorizeQuery[k];
      else authorizeQuery[k] = v;
    }
  }

  authorizeGet = await client.get(authorizationEndpoint, {
    query: authorizeQuery,
    redirect: 'manual',
    auth: false,
  });

  let authorizeRequestUrl = authorizationEndpoint;
  try {
    const authorizeUrlObj = new URL(authorizationEndpoint);
    for (const [k, v] of Object.entries(authorizeQuery)) {
      authorizeUrlObj.searchParams.set(k, String(v));
    }
    authorizeRequestUrl = authorizeUrlObj.toString();
  } catch {
    // Keep fallback string if authorizationEndpoint could not be parsed as URL
  }
  const cookieHeader = extractCookieHeader(authorizeGet.headers);

  // If GET /oauth/authorize directly redirected (e.g., error or auto-approve)
  if (authorizeGet.status >= 300 && authorizeGet.status < 400) {
    callback = parseRedirectLocation(authorizeGet.headers.get('location'), authorizeRequestUrl);
    if (!callback?.code) {
      return buildResult();
    }
  } else {
    if (!authorizeGet.ok) {
      return buildResult();
    }

    // Step 4: Parse Consent Form & Submit POST /oauth/authorize (redirect: 'manual')
    parsedForm = parseAuthorizeForm(authorizeGet.text, authorizeRequestUrl);
    if (parsedForm.formsCount === 0) {
      overrideError = 'no_authorize_form_found';
      return buildResult();
    }

    const { action, method, params } = buildAuthorizeFormBody(parsedForm, {
      passcode,
      wrongPasscode,
      scope,
      memberId,
      denyConsent,
      skipConsent,
      extraFormFields,
    });

    let actionUrl;
    try {
      actionUrl = new URL(action, authorizeRequestUrl);
    } catch {
      overrideError = 'invalid_authorize_form_action';
      return buildResult();
    }
    if (actionUrl.protocol !== 'http:' && actionUrl.protocol !== 'https:') {
      overrideError = 'invalid_authorize_form_action';
      return buildResult();
    }

    const submitHeaders = {};
    if (cookieHeader) submitHeaders.cookie = cookieHeader;

    if (method === 'GET') {
      actionUrl.search = '';
      const getAction = actionUrl.toString();
      authorizePost = await client.get(getAction, {
        query: params,
        headers: submitHeaders,
        redirect: 'manual',
        auth: false,
      });
    } else {
      submitHeaders['content-type'] = 'application/x-www-form-urlencoded';
      authorizePost = await client.request(method, actionUrl.toString(), {
        body: params.toString(),
        headers: submitHeaders,
        redirect: 'manual',
        auth: false,
      });
    }

    callback = parseRedirectLocation(authorizePost.headers.get('location'), actionUrl.toString());

    // Graceful stop on non-redirect or missing authorization code (wrong passcode / deny / skipConsent)
    if (authorizePost.status < 300 || authorizePost.status >= 400 || !callback?.code) {
      return buildResult();
    }
  }

  // Step 5: Token Exchange (POST /oauth/token)
  const verifierToSend =
    wrongVerifier === true
      ? generatePkcePair().codeVerifier
      : typeof wrongVerifier === 'string'
        ? wrongVerifier
        : effectivePkce.codeVerifier;

  const tokenBody = {
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: redirectUri,
    client_id: effectiveClientId,
    code_verifier: verifierToSend,
  };
  if (effectiveClientSecret) tokenBody.client_secret = effectiveClientSecret;
  if (resource !== undefined) tokenBody.resource = resource;
  if (customTokenBody && typeof customTokenBody === 'object') {
    for (const [k, v] of Object.entries(customTokenBody)) {
      if (v === null || v === undefined) delete tokenBody[k];
      else tokenBody[k] = v;
    }
  }

  const encoded = encodeOAuthPayload(tokenBody, effectiveContentType);
  tokenResponse = await client.post(tokenEndpoint, encoded.body, {
    headers: { 'content-type': encoded.contentTypeHeader },
    auth: false,
  });

  return buildResult();
}

export async function refreshOAuthToken({
  baseUrl,
  tokenEndpoint,
  refreshToken,
  clientId,
  clientSecret,
  scope,
  resource,
  contentType,
  tokenContentType,
  customBody,
  headers,
} = {}) {
  const endpoint = resolveEndpoint(tokenEndpoint, '/oauth/token', baseUrl);
  const bodyObj = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };
  if (clientId !== undefined) bodyObj.client_id = clientId;
  if (clientSecret !== undefined) bodyObj.client_secret = clientSecret;
  if (scope !== undefined) bodyObj.scope = scope;
  if (resource !== undefined) bodyObj.resource = resource;
  if (customBody && typeof customBody === 'object') {
    for (const [k, v] of Object.entries(customBody)) {
      if (v === null || v === undefined) delete bodyObj[k];
      else bodyObj[k] = v;
    }
  }

  const encoded = encodeOAuthPayload(bodyObj, contentType ?? tokenContentType ?? 'form');
  const client = createApiClient({ baseUrl: baseUrl || endpoint, defaultHeaders: headers || {} });
  const res = await client.post(endpoint, encoded.body, {
    headers: { 'content-type': encoded.contentTypeHeader },
    auth: false,
  });

  return {
    status: res.status,
    headers: res.headers,
    text: res.text,
    json: res.json,
    ok: res.ok,
    accessToken: res.json?.access_token ?? null,
    refreshToken: res.json?.refresh_token ?? null,
    tokenType: res.json?.token_type ?? null,
    expiresIn: res.json?.expires_in ?? null,
    scope: res.json?.scope ?? null,
  };
}

export async function revokeOAuthToken({
  baseUrl,
  revocationEndpoint,
  token,
  tokenTypeHint,
  clientId,
  clientSecret,
  contentType,
  tokenContentType,
  customBody,
  headers,
} = {}) {
  const endpoint = resolveEndpoint(revocationEndpoint, '/oauth/revoke', baseUrl);
  const bodyObj = { token };
  if (tokenTypeHint !== undefined) bodyObj.token_type_hint = tokenTypeHint;
  if (clientId !== undefined) bodyObj.client_id = clientId;
  if (clientSecret !== undefined) bodyObj.client_secret = clientSecret;
  if (customBody && typeof customBody === 'object') {
    for (const [k, v] of Object.entries(customBody)) {
      if (v === null || v === undefined) delete bodyObj[k];
      else bodyObj[k] = v;
    }
  }

  const encoded = encodeOAuthPayload(bodyObj, contentType ?? tokenContentType ?? 'form');
  const client = createApiClient({ baseUrl: baseUrl || endpoint, defaultHeaders: headers || {} });
  const res = await client.post(endpoint, encoded.body, {
    headers: { 'content-type': encoded.contentTypeHeader },
    auth: false,
  });

  return {
    status: res.status,
    headers: res.headers,
    text: res.text,
    json: res.json,
    ok: res.ok,
  };
}

// ============================================================================
// 7. Streamable HTTP MCP Client (`createMcpClient`) & `parseToolJson`
// ============================================================================

function parseSseJsonMessages(text) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\n+/);
  const messages = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        const val = line.slice(5);
        dataLines.push(val.startsWith(' ') ? val.slice(1) : val);
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      // Ignore non-JSON SSE event data
    }
  }

  return messages;
}

async function sendMcpPayload({
  baseUrl,
  mcpPath = '/mcp',
  token = null,
  tokenInQuery = false,
  protocolVersion = '2025-06-18',
  sessionId = null,
  payload,
  rawBody,
  expectedId,
  isBatch = false,
  headers: extraHeaders,
  suppressAuth = false,
  suppressAuthHeader = false,
  timeoutMs = 15_000,
}) {
  const effectiveToken = suppressAuth ? null : token;
  const effectiveTokenInQuery = suppressAuth ? false : Boolean(tokenInQuery);
  const url = resolveRequestUrl(baseUrl, mcpPath, undefined, effectiveToken, effectiveTokenInQuery);
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json, text/event-stream');
  if (protocolVersion) {
    headers.set('mcp-protocol-version', String(protocolVersion));
  }
  if (sessionId) {
    headers.set('mcp-session-id', String(sessionId));
  }
  const authOverride = inspectHeaderOverride(extraHeaders, 'authorization');
  const explicitAuthNull = Boolean(suppressAuthHeader || authOverride.deleted);
  mergeHeaders(headers, extraHeaders);
  if (suppressAuth && !(authOverride.present && !authOverride.deleted)) {
    headers.delete('authorization');
  }

  if (
    !suppressAuth &&
    !explicitAuthNull &&
    effectiveToken &&
    typeof effectiveToken === 'string' &&
    !effectiveTokenInQuery &&
    !headers.has('authorization')
  ) {
    headers.set('authorization', `Bearer ${effectiveToken}`);
  }

  const requestBody =
    rawBody !== undefined
      ? rawBody
      : typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);

  const fetchOpts = {
    method: 'POST',
    headers,
    body: requestBody,
  };
  if (timeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(timeoutMs);
  }

  const response = await fetch(url, fetchOpts);
  const text = await response.text();
  const returnedSessionId = response.headers.get('mcp-session-id') ?? sessionId ?? null;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const treatAsBatch = Boolean(isBatch || Array.isArray(payload));

  let body = null;
  if (text.trim() !== '') {
    if (contentType.includes('text/event-stream')) {
      const sseMessages = parseSseJsonMessages(text);
      if (treatAsBatch) {
        const flat = [];
        for (const msg of sseMessages) {
          if (Array.isArray(msg)) flat.push(...msg);
          else flat.push(msg);
        }
        body = flat;
      } else {
        let picked = null;
        if (expectedId !== undefined) {
          picked = sseMessages.find((m) => m && typeof m === 'object' && m.id === expectedId) ?? null;
        }
        if (!picked) {
          for (let idx = sseMessages.length - 1; idx >= 0; idx--) {
            const m = sseMessages[idx];
            if (m && typeof m === 'object' && ('result' in m || 'error' in m)) {
              picked = m;
              break;
            }
          }
        }
        if (!picked && sseMessages.length > 0) {
          picked = sseMessages[sseMessages.length - 1];
        }
        body = picked;
      }
    } else {
      body = safeParseJson(text);
    }
  }

  if (treatAsBatch) {
    const responses = Array.isArray(body) ? body : [];
    const topError = !Array.isArray(body) && isPlainObject(body) ? body.error ?? null : null;
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: body,
      body,
      responses,
      result: null,
      error: topError,
      ok: response.ok,
      sessionId: returnedSessionId,
    };
  }

  return {
    status: response.status,
    headers: response.headers,
    text,
    json: body,
    body,
    result: isPlainObject(body) ? body.result ?? null : null,
    error: isPlainObject(body) ? body.error ?? null : null,
    id: isPlainObject(body) && body.id !== undefined ? body.id : null,
    ok: response.ok,
    sessionId: returnedSessionId,
  };
}

export function createMcpClient({
  baseUrl,
  token = null,
  tokenInQuery = false,
  protocolVersion = '2025-06-18',
  mcpPath = '/mcp',
  defaultHeaders = {},
  timeoutMs = 15_000,
} = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new TypeError('createMcpClient requires a non-empty baseUrl string');
  }

  let nextId = 1;
  let currentSessionId = null;

  function buildHeaders(extraHeaders, suppressAuth = false) {
    const combined = new Headers();
    mergeHeaders(combined, defaultHeaders);
    const authOverride = inspectHeaderOverride(extraHeaders, 'authorization');
    if (suppressAuth && !(authOverride.present && !authOverride.deleted)) {
      combined.delete('authorization');
    }
    mergeHeaders(combined, extraHeaders);
    return { combined, explicitAuthNull: authOverride.deleted };
  }

  async function sendSingle(payload, expectedId, opts = {}) {
    const suppressAuth = opts.auth === false;
    const { combined, explicitAuthNull } = buildHeaders(opts.headers, suppressAuth);
    const res = await sendMcpPayload({
      baseUrl,
      mcpPath,
      token: suppressAuth ? null : opts.token !== undefined ? opts.token : token,
      tokenInQuery: suppressAuth
        ? false
        : opts.tokenInQuery !== undefined
          ? opts.tokenInQuery
          : tokenInQuery,
      protocolVersion: opts.protocolVersion ?? protocolVersion,
      sessionId: opts.sessionId !== undefined ? opts.sessionId : currentSessionId,
      payload,
      expectedId,
      isBatch: false,
      headers: combined,
      suppressAuth,
      suppressAuthHeader: explicitAuthNull,
      timeoutMs: opts.timeoutMs ?? timeoutMs,
    });
    if (res.sessionId) {
      currentSessionId = res.sessionId;
    }
    return res;
  }

  function call(method, params, id, opts = {}) {
    const reqId = id !== undefined ? id : nextId++;
    const payload = {
      jsonrpc: '2.0',
      id: reqId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return sendSingle(payload, reqId, opts);
  }

  function notify(method, params, opts = {}) {
    const payload = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return sendSingle(payload, undefined, opts);
  }

  async function batch(requests, opts = {}) {
    if (!Array.isArray(requests)) {
      throw new TypeError('createMcpClient.batch requires an array of JSON-RPC requests');
    }
    const normalized = requests.map((req) => {
      if (!isPlainObject(req)) return req;
      const copy = { jsonrpc: '2.0', ...req };
      const isNotification = String(copy.method || '').startsWith('notifications/');
      if (!('id' in copy) && !isNotification) {
        copy.id = nextId++;
      }
      return copy;
    });

    const suppressAuth = opts.auth === false;
    const { combined, explicitAuthNull } = buildHeaders(opts.headers, suppressAuth);
    const res = await sendMcpPayload({
      baseUrl,
      mcpPath,
      token: suppressAuth ? null : opts.token !== undefined ? opts.token : token,
      tokenInQuery: suppressAuth
        ? false
        : opts.tokenInQuery !== undefined
          ? opts.tokenInQuery
          : tokenInQuery,
      protocolVersion: opts.protocolVersion ?? protocolVersion,
      sessionId: opts.sessionId !== undefined ? opts.sessionId : currentSessionId,
      payload: normalized,
      isBatch: true,
      headers: combined,
      suppressAuth,
      suppressAuthHeader: explicitAuthNull,
      timeoutMs: opts.timeoutMs ?? timeoutMs,
    });
    if (res.sessionId) {
      currentSessionId = res.sessionId;
    }
    return res;
  }

  async function raw(rawBody, opts = {}) {
    const suppressAuth = opts.auth === false;
    const { combined, explicitAuthNull } = buildHeaders(opts.headers, suppressAuth);
    const res = await sendMcpPayload({
      baseUrl,
      mcpPath,
      token: suppressAuth ? null : opts.token !== undefined ? opts.token : token,
      tokenInQuery: suppressAuth
        ? false
        : opts.tokenInQuery !== undefined
          ? opts.tokenInQuery
          : tokenInQuery,
      protocolVersion: opts.protocolVersion ?? protocolVersion,
      sessionId: opts.sessionId !== undefined ? opts.sessionId : currentSessionId,
      rawBody: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
      isBatch: false,
      headers: combined,
      suppressAuth,
      suppressAuthHeader: explicitAuthNull,
      timeoutMs: opts.timeoutMs ?? timeoutMs,
    });
    if (res.sessionId) {
      currentSessionId = res.sessionId;
    }
    return res;
  }

  return {
    protocolVersion,
    getSessionId() {
      return currentSessionId;
    },
    setSessionId(id) {
      currentSessionId = id ?? null;
    },
    call,
    notify,
    batch,
    raw,
    initialize(
      clientInfo = { name: 'home-pharmacy-e2e', version: '1.0.0' },
      capabilities = {}
    ) {
      return call('initialize', { protocolVersion, capabilities, clientInfo });
    },
    notifyInitialized() {
      return notify('notifications/initialized');
    },
    ping(opts) {
      return call('ping', {}, undefined, opts);
    },
    listTools(cursor) {
      return call('tools/list', cursor ? { cursor } : {});
    },
    callTool(name, args = {}) {
      return call('tools/call', { name, arguments: args });
    },
    listResources(cursor) {
      return call('resources/list', cursor ? { cursor } : {});
    },
    readResource(uri) {
      return call('resources/read', { uri });
    },
    listPrompts(cursor) {
      return call('prompts/list', cursor ? { cursor } : {});
    },
    getPrompt(name, args) {
      return call('prompts/get', args !== undefined ? { name, arguments: args } : { name });
    },
  };
}

function safeJsonSnippet(value, maxLen = 300) {
  try {
    const str = JSON.stringify(value);
    return typeof str === 'string' ? str.slice(0, maxLen) : '';
  } catch {
    try {
      return String(value).slice(0, maxLen);
    } catch {
      return '[unserializable]';
    }
  }
}

function tryParseTextJson(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  if (!trimmed) return { ok: false };

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Try markdown fenced JSON blocks
  }

  const jsonFences = [];
  const otherFences = [];
  for (const match of trimmed.matchAll(/```([^\n`]*)\n?([\s\S]*?)```/gi)) {
    const firstLine = (match[1] || '').trim();
    const body = (match[2] || '').trim();
    const firstLower = firstLine.toLowerCase();
    if (body) {
      if (firstLower === 'json' || firstLower.startsWith('json ') || firstLower.startsWith('json\t')) {
        jsonFences.push(body);
      } else {
        otherFences.push(body);
      }
    } else if (firstLine) {
      otherFences.push(firstLine.replace(/^json\s+/i, ''));
    }
  }

  for (const candidate of [...jsonFences, ...otherFences]) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Not valid JSON inside this fence; try next
    }
  }

  return { ok: false };
}

export function parseToolJson(input, { allowNull = false } = {}) {
  const fail = (message) => {
    if (allowNull) return null;
    throw new Error(message);
  };

  if (input === null || input === undefined) {
    return fail('parseToolJson received null or undefined input');
  }

  if (typeof input === 'string') {
    const parsed = tryParseTextJson(input);
    if (parsed.ok) return parsed.value;
    return fail(`parseToolJson could not parse string as JSON: ${JSON.stringify(input.slice(0, 300))}`);
  }

  if (typeof input !== 'object') {
    return fail(`parseToolJson received unsupported input type: ${typeof input}`);
  }

  // Detect JSON-RPC protocol error (distinct from MCP tool result with isError: true)
  const rpcError = input.error ?? input.body?.error ?? null;
  const hasResult = input.result !== undefined && input.result !== null
    ? true
    : input.body?.result !== undefined && input.body?.result !== null;
  if (rpcError && !hasResult) {
    const statusNote = input.status !== undefined ? `HTTP ${input.status}, ` : '';
    return fail(
      `parseToolJson encountered JSON-RPC error (${statusNote}code=${rpcError.code}, message=${rpcError.message})`
    );
  }

  const target = input.result ?? input.body?.result ?? input;
  let diagnosticText = '';

  if (Array.isArray(target?.content)) {
    const textParts = [];
    for (const item of target.content) {
      if (typeof item?.text === 'string') {
        textParts.push(item.text);
        const parsed = tryParseTextJson(item.text);
        if (parsed.ok) return parsed.value;
      }
    }
    if (textParts.length > 1) {
      const joined = textParts.join('');
      const parsedJoined = tryParseTextJson(joined);
      if (parsedJoined.ok) return parsedJoined.value;
    }
    diagnosticText = textParts.join('\n');
  } else if (Array.isArray(target?.contents)) {
    const textParts = [];
    for (const item of target.contents) {
      if (typeof item?.text === 'string') {
        textParts.push(item.text);
        const parsed = tryParseTextJson(item.text);
        if (parsed.ok) return parsed.value;
      }
    }
    diagnosticText = textParts.join('\n');
  }

  if (target?.structuredContent !== undefined && target.structuredContent !== null && typeof target.structuredContent === 'object') {
    return target.structuredContent;
  }

  if (allowNull) return null;

  const snippet = (diagnosticText || input.text || safeJsonSnippet(target) || '').slice(0, 300);
  const statusNote = input.status !== undefined ? ` (HTTP ${input.status})` : '';
  return fail(`parseToolJson could not extract JSON payload${statusNote}: ${snippet}`);
}

// ============================================================================
// 8. Lazy Playwright Chromium Launcher & `openAuthenticatedPage`
// ============================================================================

function findPreinstalledChromium(browsersPath, headless = true) {
  if (!browsersPath || !fs.existsSync(browsersPath)) return null;
  let entries;
  try {
    entries = fs.readdirSync(browsersPath);
  } catch {
    return null;
  }

  const pickByPrefix = (prefix, relCandidates) => {
    const dirs = entries
      .filter((e) => e.startsWith(prefix))
      .sort((a, b) => {
        const na = Number(a.slice(prefix.length)) || 0;
        const nb = Number(b.slice(prefix.length)) || 0;
        return nb - na;
      });
    for (const dir of dirs) {
      for (const rel of relCandidates) {
        const full = path.join(browsersPath, dir, rel);
        if (fs.existsSync(full)) return full;
      }
    }
    return null;
  };

  const headlessShellCandidates = [
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-headless-shell-linux/headless_shell',
    'chrome-linux/headless_shell',
  ];
  const fullChromeCandidates = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
  ];

  if (headless !== false) {
    return (
      pickByPrefix('chromium_headless_shell-', headlessShellCandidates) ||
      pickByPrefix('chromium-', fullChromeCandidates)
    );
  }
  return pickByPrefix('chromium-', fullChromeCandidates);
}

async function loadPlaywright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= DEFAULT_PLAYWRIGHT_BROWSERS_PATH;
  const expectedDir = path.join(REPO_ROOT, 'node_modules', 'playwright');
  if (!fs.existsSync(expectedDir)) {
    throw new Error(
      `Playwright is not installed at ${expectedDir}. ` +
        `Run "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install" in ${REPO_ROOT} before executing browser E2E tests.`
    );
  }

  const mjsEntry = path.join(expectedDir, 'index.mjs');
  const req = createRequire(import.meta.url);
  let entryPath;
  if (fs.existsSync(mjsEntry)) {
    entryPath = mjsEntry;
  } else {
    try {
      entryPath = req.resolve('playwright', { paths: [REPO_ROOT] });
    } catch {
      entryPath = path.join(expectedDir, 'index.js');
    }
  }

  let pw;
  try {
    const mod = await import(pathToFileURL(entryPath).href);
    pw = mod?.chromium ? mod : mod?.default;
  } catch {
    const cjsPath = req.resolve('playwright', { paths: [REPO_ROOT] });
    pw = req(cjsPath);
  }

  if (!pw?.chromium?.launch) {
    throw new Error(`Loaded playwright from ${entryPath}, but chromium.launch is unavailable.`);
  }
  return pw;
}

async function firstVisibleLocator(page, selectorList) {
  for (const selector of selectorList) {
    const loc = page.locator(selector).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        return loc;
      }
    } catch {
      // Ignore detached/transient locator check
    }
  }
  return null;
}

export async function openAuthenticatedPage(browserOrHandleOrPage, baseUrl, creds = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new TypeError('openAuthenticatedPage requires a non-empty baseUrl string');
  }

  const { token, passcode, timeoutMs = 15_000, page: customPage } = creds || {};

  let page = customPage ?? null;
  let createdPage = false;
  if (!page) {
    if (
      browserOrHandleOrPage &&
      typeof browserOrHandleOrPage.goto === 'function' &&
      typeof browserOrHandleOrPage.locator === 'function'
    ) {
      page = browserOrHandleOrPage;
    } else if (
      browserOrHandleOrPage?.page &&
      typeof browserOrHandleOrPage.page.goto === 'function'
    ) {
      page = browserOrHandleOrPage.page;
    } else if (
      browserOrHandleOrPage &&
      typeof browserOrHandleOrPage.newPage === 'function'
    ) {
      page = await browserOrHandleOrPage.newPage();
      createdPage = true;
    } else {
      throw new TypeError(
        'openAuthenticatedPage requires a Playwright Page, Browser, BrowserContext, or launchBrowser() handle'
      );
    }
  }

  try {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const targetUrl = token
      ? `${cleanBase}/?token=${encodeURIComponent(token)}`
      : `${cleanBase}/`;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const navLocator = page.locator('[data-testid="nav-sections"]').first();
    const quickWaitMs = Math.min(2500, timeoutMs);
    try {
      await navLocator.waitFor({ state: 'visible', timeout: quickWaitMs });
      return page;
    } catch {
      // Auth/sign-in form or settings-sync credential gate may be rendered instead.
    }

    const tokenInput = await firstVisibleLocator(page, [
      'input[data-testid*="token" i]',
      '[data-testid*="token" i] input',
      'input[name*="token" i]',
      'input[placeholder*="token" i]',
      'input[aria-label*="token" i]',
    ]);

    const passcodeInput = await firstVisibleLocator(page, [
      'input[data-testid*="pass" i]',
      '[data-testid*="pass" i] input',
      'input[name*="pass" i]',
      'input[placeholder*="pass" i]',
      'input[aria-label*="pass" i]',
      'input[type="password"]:not([name*="token" i]):not([data-testid*="token" i]):not([placeholder*="token" i]):not([aria-label*="token" i])',
    ]);

    let distinctPasscodeInput = passcodeInput;
    if (tokenInput && token && passcodeInput) {
      let tokenHandle = null;
      let passHandle = null;
      try {
        tokenHandle = await tokenInput.elementHandle({ timeout: 1000 });
        passHandle = await passcodeInput.elementHandle({ timeout: 1000 });
        if (tokenHandle && passHandle) {
          const isSameNode = await page.evaluate(([a, b]) => a === b, [tokenHandle, passHandle]);
          if (isSameNode) {
            distinctPasscodeInput = null;
          }
        }
      } catch {
        // Ignore transient detach during DOM-identity check
      } finally {
        await tokenHandle?.dispose().catch(() => {});
        await passHandle?.dispose().catch(() => {});
      }
    }

    let filledInput = null;
    if (tokenInput && token) {
      await tokenInput.fill(String(token));
      filledInput = tokenInput;
    }
    if (distinctPasscodeInput && (passcode || token)) {
      await distinctPasscodeInput.fill(String(passcode || token));
      filledInput = distinctPasscodeInput;
    }

    if (!filledInput && (token || passcode)) {
      const fallbackInput = await firstVisibleLocator(page, [
        '[data-testid="settings-sync"] input',
        'form input[type="text"]',
        'form input:not([type])',
        'form input[type="password"]',
      ]);
      if (fallbackInput) {
        await fallbackInput.fill(String(token || passcode));
        filledInput = fallbackInput;
      }
    }

    if (filledInput) {
      const submitBtn = await firstVisibleLocator(page, [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Unlock")',
        'button:has-text("Connect")',
        'button:has-text("Save")',
        'button:has-text("Continue")',
        'button:has-text("Enter")',
        'button:has-text("Login")',
      ]);

      if (submitBtn) {
        await submitBtn.click();
      } else {
        await filledInput.press('Enter');
      }
    }

    await navLocator.waitFor({ state: 'visible', timeout: timeoutMs });
    return page;
  } catch (err) {
    if (createdPage) {
      await page.close().catch(() => {});
    }
    throw err;
  }
}

export async function launchBrowser(options = {}) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= DEFAULT_PLAYWRIGHT_BROWSERS_PATH;
  const pw = await loadPlaywright();

  const headless = options.headless ?? true;
  const defaultArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  const mergedArgs = [...defaultArgs, ...(options.args || [])];

  const launchOpts = {
    headless,
    args: mergedArgs,
    ...(options.launchOptions || {}),
  };
  if (options.executablePath) {
    launchOpts.executablePath = options.executablePath;
  }

  // Detect revision mismatch between npm playwright and /opt/ms-playwright preinstalled binary.
  if (!launchOpts.executablePath) {
    let defaultExe = null;
    try {
      defaultExe = pw.chromium.executablePath?.();
    } catch {
      defaultExe = null;
    }
    if (!defaultExe || !fs.existsSync(defaultExe)) {
      const fallbackExe = findPreinstalledChromium(
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        headless
      );
      if (fallbackExe) {
        launchOpts.executablePath = fallbackExe;
      }
    }
  }

  let browser;
  try {
    browser = await pw.chromium.launch(launchOpts);
  } catch (err) {
    if (/Executable doesn't exist/i.test(String(err?.message || ''))) {
      const fallbackExe = findPreinstalledChromium(
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        headless
      );
      if (fallbackExe && fallbackExe !== launchOpts.executablePath) {
        browser = await pw.chromium.launch({ ...launchOpts, executablePath: fallbackExe });
      } else {
        throw new Error(
          `Failed to launch Chromium (PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}): ${err.message}`,
          { cause: err }
        );
      }
    } else {
      throw err;
    }
  }

  const contextOpts = {
    viewport: options.viewport !== undefined ? options.viewport : { width: 1280, height: 800 },
    ...(options.contextOptions || {}),
  };

  const consoleErrors = [];
  const pageErrors = [];
  const attachedPages = new WeakSet();

  function attachPageListeners(p) {
    if (!p || attachedPages.has(p)) return;
    attachedPages.add(p);
    p.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push({
          text: msg.text(),
          location: msg.location(),
          url: p.url(),
        });
      }
    });
    p.on('pageerror', (err) => {
      pageErrors.push({
        message: err?.message ?? String(err),
        stack: err?.stack ?? '',
        url: p.url(),
      });
    });
  }

  let context = null;
  let page = null;
  try {
    context = await browser.newContext(contextOpts);
    context.on('page', attachPageListeners);
    page = await context.newPage();
    attachPageListeners(page);
  } catch (err) {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }

  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        await context.close();
      } catch {
        // Ignore already-closed context
      }
      try {
        await browser.close();
      } catch {
        // Ignore already-closed browser
      }
    })();
    return closePromise;
  }

  return {
    browser,
    context,
    page,
    consoleErrors,
    pageErrors,
    openAuthenticatedPage(baseUrl, creds = {}) {
      const targetPage = creds?.page ?? page;
      attachPageListeners(targetPage);
      return openAuthenticatedPage(targetPage, baseUrl, creds);
    },
    close,
  };
}

// ============================================================================
// 9. Opaque-Box REST Response Unwrapper (`unwrapData`)
// ============================================================================

const DEFAULT_ENVELOPE_KEYS = [
  'compound', 'compounds',
  'member', 'members',
  'section', 'sections',
  'stack', 'stacks',
  'schedule', 'interactions',
  'proposal', 'proposals',
  'ownership', 'ownerships',
  'key', 'keys', 'apiKey', 'apiKeys',
  'snapshot', 'snapshots',
  'log', 'logs',
  'auditLog', 'audit_log',
  'client', 'clients',
  'household', 'settings', 'adherence',
  'items', 'results', 'records', 'entries',
];

const ENTITY_GUARD_KEYS = new Set([
  'id', 'slug', 'name',
  'systemic', 'dermatology',
  'hardStops', 'avoidSameSlot',
  'routineAnchors', 'safetyContext',
  'timingRules', 'dosages', 'cycles', 'halfLife',
  'compoundId', 'provenance', '_format',
]);

const WRAPPER_META_KEYS = new Set([
  'ok', 'success', 'status',
  'count', 'total', 'totalCount', 'limit', 'offset', 'page', 'pages', 'cursor', 'nextCursor', 'hasMore',
  'meta', 'rev', '_rev', 'version', 'timestamp', 'updatedAt', 'generatedAt',
  'message', 'warning', 'warnings',
  'memberId', 'scope', 'sectionId', 'stackId', 'dateKey', 'query', 'filters',
]);

function unwrapSingleFallbackKey(obj) {
  if (!isPlainObject(obj)) return { matched: false, value: obj };

  const ownKeys = Object.keys(obj);
  for (const key of ownKeys) {
    if (ENTITY_GUARD_KEYS.has(key)) {
      return { matched: false, value: obj };
    }
  }

  const matches = DEFAULT_ENVELOPE_KEYS.filter((k) => hasOwnDefined(obj, k));
  if (matches.length !== 1) {
    return { matched: false, value: obj };
  }

  const matchedKey = matches[0];
  for (const key of ownKeys) {
    if (key !== matchedKey && !WRAPPER_META_KEYS.has(key)) {
      return { matched: false, value: obj };
    }
  }

  return { matched: true, value: obj[matchedKey] };
}

export function unwrapData(json, candidateKeys) {
  if (!isPlainObject(json)) return json;

  const explicitKeys =
    candidateKeys == null
      ? []
      : (Array.isArray(candidateKeys) ? candidateKeys : [candidateKeys]).filter(
          (k) => typeof k === 'string' && k.length > 0
        );

  // Priority 1: caller-provided candidateKeys on top-level json
  for (const key of explicitKeys) {
    if (hasOwnDefined(json, key)) return json[key];
  }

  // Priority 2: `data` envelope (and nested `data[key]` / single fallback inside `data`)
  if (hasOwnDefined(json, 'data')) {
    const inner = json.data;
    if (isPlainObject(inner)) {
      for (const key of explicitKeys) {
        if (hasOwnDefined(inner, key)) return inner[key];
      }
      const fbInner = unwrapSingleFallbackKey(inner);
      if (fbInner.matched) return fbInner.value;
      return inner;
    }
    return inner;
  }

  // Priority 3: single standard fallback envelope key on top-level json
  const fbTop = unwrapSingleFallbackKey(json);
  if (fbTop.matched) return fbTop.value;

  return json;
}

// ============================================================================
// 10. Synthetic Non-Personal Educational Domain Fixtures (`fixtures`)
// ============================================================================

function makePeptideCompound(overrides = {}) {
  return deepMerge(
    {
      name: 'BPC-157',
      canonicalMolecule: 'bpc-157',
      aliases: ['Body Protection Compound-157', 'PL 14736'],
      sectionId: 'peptides',
      subsection: 'Tissue & Recovery',
      tags: ['peptide', 'healing', 'cytoprotective', 'subq'],
      relatedCompoundIds: [],
      summary:
        'Synthetic 15-amino-acid pentadecapeptide studied in preclinical models for soft-tissue, tendon, and gastrointestinal mucosal repair.',
      detailedDescription:
        'BPC-157 is a partial sequence derived from a gastric juice protein investigated in laboratory literature for angiogenic and cytoprotective signaling. Human clinical trial data remain limited.',
      mechanismOfAction:
        'Modulates nitric oxide (NO) pathways, upregulates VEGF-mediated angiogenesis, and promotes fibroblast migration and growth-hormone receptor expression in injured connective tissue.',
      useCaseScenarios: [
        'Soft-tissue and tendon recovery research',
        'Gastrointestinal mucosal cytoprotection',
      ],
      benefits: [
        'Angiogenic tissue-repair signaling',
        'Tendon/ligament fibroblast support',
        'Gastrointestinal mucosal resilience',
      ],
      timingRules: {
        preferredSlots: ['waking_fasted', 'bedtime_fasted'],
        avoidSlots: [],
        foodState: 'fasted',
        fastingWindowHours: 1,
        workoutRelation: 'any',
        circadianEffect: 'neutral',
        timingNotes:
          'Typically scheduled fasted in the morning or evening away from heavy meals.',
      },
      halfLife: {
        valueHours: 4,
        minHours: 3,
        maxHours: 6,
        displayText: '~4 hours (preclinical systemic clearance)',
        route: 'SubQ',
        kind: 'elimination',
        effectDurationNote:
          'Downstream tissue-signaling cascades extend beyond plasma half-life.',
        sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/36137574/',
      },
      dosages: {
        rangeText: '250-500 mcg daily',
        defaultAmount: 250,
        defaultUnit: 'mcg',
        route: 'SubQ',
        frequencyText: 'Once or twice daily',
        femaleDoseNote: 'Educational reference typically starts at 250 mcg once daily.',
        maleDoseNote: 'Educational reference typically 250-500 mcg daily.',
        titrationSchedule:
          'Begin at 250 mcg once daily for 7 days to assess tolerance before splitting doses.',
        maxCeiling: 1000,
      },
      cycles: {
        patternText: '4-8 weeks on, 2-4 weeks off',
        cycleDays: 42,
        offDays: 21,
        continuous: false,
        washoutNote: 'Include a 2-4 week off-cycle washout between blocks.',
      },
      doNotPairWith: [
        {
          targetType: 'class',
          targetRef: 'oncogenic_growth_factors',
          severity: 'caution',
          mechanism: 'Theoretical overlap in VEGF/angiogenesis proliferative signaling.',
          recommendation:
            'Avoid combining with aggressive systemic growth-factor protocols without specialist oversight.',
          citation: 'https://pubmed.ncbi.nlm.nih.gov/36137574/',
        },
      ],
      synergies: [
        {
          targetRef: 'tb-500',
          coLocate: true,
          reason: 'Complementary actin-upregulation and angiogenic repair mechanisms.',
        },
      ],
      contraindications: ['Active or suspected malignancy', 'Pregnancy or breastfeeding'],
      sideEffects: ['Mild injection-site erythema', 'Transient fatigue or headache'],
      monitoringLabs: ['CBC', 'CMP', 'hs-CRP'],
      storageNotes:
        'Store lyophilized vial at -20°C to 8°C; store reconstituted vial refrigerated (2-8°C) protected from light and discard after 28 days.',
      sectionData: {
        form: 'lyophilized',
        vialMg: 5,
        vialIU: null,
        diluentMl: 2,
        solvent: 'BAC',
        solventNote:
          'Reconstitute gently along vial wall with bacteriostatic water (0.9% benzyl alcohol); do not shake.',
        isBlend: false,
        blendComponents: [],
        siteRotationRecommended: true,
        recommendedSites: [
          'abdomen_left',
          'abdomen_right',
          'thigh_left',
          'thigh_right',
          'flank_left',
          'flank_right',
          'glute_left',
          'glute_right',
        ],
      },
      customFields: {},
      profileStatus: 'ai_draft',
      provenance: {
        sourceModel: 'manual',
        researchedAt: '2026-10-01T12:00:00.000Z',
        evidenceTier: 'working_hypothesis',
        confidence: 'medium',
        citations: [
          {
            title:
              'Pentadecapeptide BPC 157: Preclinical Pharmacokinetics and Tissue Repair Review',
            url: 'https://pubmed.ncbi.nlm.nih.gov/36137574/',
            pmid: '36137574',
          },
        ],
      },
      notes: 'Educational reference profile; not medical advice.',
    },
    overrides
  );
}

function makePedCompound(overrides = {}) {
  return deepMerge(
    {
      name: 'Testosterone Cypionate',
      canonicalMolecule: 'testosterone-cypionate',
      aliases: ['Test Cyp', 'Depo-Testosterone', 'Testosterone 17beta-cypionate'],
      sectionId: 'peds',
      subsection: 'Injectable Androgens',
      tags: [
        'ped',
        'androgen',
        'aas',
        'testosterone',
        'injectable_oil',
        'hpg_suppressive',
        'virilization_risk',
        'teratogen',
      ],
      relatedCompoundIds: [],
      summary:
        'Long-acting esterified injectable testosterone used clinically for male hypogonadism and studied as an androgenic/anabolic foundation.',
      detailedDescription:
        'Testosterone cypionate is suspended in carrier oil for intramuscular or subcutaneous depot release. It undergoes enzymatic conversion to estradiol via aromatase and to DHT via 5-alpha-reductase.',
      mechanismOfAction:
        'Binds cytosolic androgen receptors (AR) to regulate anabolic gene transcription, erythropoiesis, nitrogen retention, and bone mineral density while exerting negative feedback on hypothalamic GnRH and pituitary LH/FSH.',
      useCaseScenarios: [
        'Clinical hypogonadism replacement education',
        'Androgen base pharmacology reference',
      ],
      benefits: [
        'Lean mass and nitrogen retention',
        'Bone mineral density support',
        'Libido and red blood cell production',
      ],
      timingRules: {
        preferredSlots: ['morning_am'],
        avoidSlots: [],
        foodState: 'any',
        workoutRelation: 'any',
        circadianEffect: 'neutral',
        timingNotes:
          'Administer on consistent weekly schedule (e.g., 2x/week Mon/Thu) to minimize peak-to-trough swings.',
      },
      halfLife: {
        valueHours: 192,
        minHours: 168,
        maxHours: 216,
        displayText: '~7-8 days (depot ester)',
        route: 'IM',
        kind: 'depot',
        effectDurationNote:
          'Cypionate ester slows release from carrier oil depot; steady state reached in ~4-5 weeks.',
        sourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/',
      },
      dosages: {
        rangeText: '100-200 mg/week split into 2 administrations',
        defaultAmount: 60,
        defaultUnit: 'mg',
        route: 'IM',
        frequencyText: 'Twice weekly (Mon/Thu)',
        femaleDoseNote:
          'High virilization risk in females; any female androgen therapy requires specialist-guided microdosing.',
        maleDoseNote:
          'Typical clinical replacement range 100-150 mg/week split into 2 administrations.',
        titrationSchedule:
          'Evaluate trough total/free testosterone, sensitive estradiol, and hematocrit after 6-8 weeks.',
        maxCeiling: 250,
      },
      cycles: {
        patternText:
          'Continuous clinician-monitored protocol or 12-16 week cycle with lab surveillance',
        cycleDays: 112,
        offDays: 42,
        continuous: true,
        washoutNote:
          'Full depot washout requires ~5 half-lives (~5-6 weeks) before HPG axis recovery testing.',
      },
      doNotPairWith: [
        {
          targetType: 'class',
          targetRef: 'pregnancy',
          severity: 'hard_stop',
          mechanism: 'Exogenous androgens are teratogenic and cause fetal virilization.',
          recommendation: 'Strictly contraindicated in pregnancy or while trying to conceive.',
          citation: 'https://dailymed.nlm.nih.gov/dailymed/',
        },
        {
          targetType: 'class',
          targetRef: '17aa_oral',
          severity: 'caution',
          mechanism:
            'Co-administration with 17-alpha-alkylated orals compounds HDL suppression, blood pressure elevation, and hepatic strain.',
          recommendation:
            'Avoid unmonitored stacking; track lipids, liver enzymes, and hematocrit.',
          citation: 'https://pubmed.ncbi.nlm.nih.gov/29562364/',
        },
      ],
      synergies: [
        {
          targetRef: 'hcg',
          coLocate: false,
          reason:
            'LH-mimetic signaling supports intratesticular steroidogenesis during exogenous androgen administration.',
        },
      ],
      contraindications: [
        'Pregnancy or trying to conceive',
        'Prostate or breast carcinoma',
        'Baseline hematocrit >52%',
        'Untreated severe obstructive sleep apnea',
      ],
      sideEffects: [
        'Erythrocytosis / elevated hematocrit',
        'Estrogenic fluid retention or gynecomastia',
        'HPG axis suppression and reduced spermatogenesis',
        'Acne or androgenic hair thinning',
      ],
      monitoringLabs: [
        'Total & Free Testosterone',
        'Sensitive Estradiol (LC-MS/MS)',
        'CBC / Hematocrit',
        'Lipid Panel (HDL/LDL/ApoB)',
        'CMP',
        'PSA',
        'LH / FSH',
      ],
      storageNotes:
        'Store oil vial upright at controlled room temperature (20-25°C) away from direct light; do not refrigerate.',
      sectionData: {
        compoundClass: 'Injectable AAS (Testosterone Ester)',
        ester: 'Cypionate',
        esterHalfLifeDays: 8,
        oilPreMixed: true,
        concentrationMgPerMl: 200,
        vialMl: 10,
        aromatizes: true,
        progestogenic: false,
        dhtDerived: false,
        c17AlphaAlkylated: false,
        hepatotoxicityRisk: 'low',
        hpgSuppression: 'high',
        requiresTestosteroneBase: false,
        ancillaries: [
          'HCG (gonadal support)',
          'Lab-guided aromatase inhibitor only if symptomatic with elevated sensitive E2',
        ],
        pctRequired: true,
        pctNotes:
          'Wait ~4-5 weeks after last cypionate injection for ester clearance prior to physician-supervised HPG recovery.',
        femaleVirilizationRisk: 'high',
        teratogenicityRisk: 'high',
        mandatoryLabs: [
          'CBC / Hematocrit',
          'Total & Free Testosterone',
          'Sensitive Estradiol',
          'Lipid Panel',
          'CMP',
          'PSA',
        ],
      },
      customFields: {},
      profileStatus: 'ai_draft',
      provenance: {
        sourceModel: 'manual',
        researchedAt: '2026-10-01T12:00:00.000Z',
        evidenceTier: 'established',
        confidence: 'high',
        citations: [
          {
            title:
              'Endocrine Society Clinical Practice Guideline: Testosterone Therapy in Men With Hypogonadism',
            url: 'https://pubmed.ncbi.nlm.nih.gov/29562364/',
            pmid: '29562364',
          },
        ],
      },
      notes:
        'Educational harm-reduction reference; requires clinician supervision and regular bloodwork.',
    },
    overrides
  );
}

function makeSupplementCompound(overrides = {}) {
  return deepMerge(
    {
      name: 'Magnesium Glycinate',
      canonicalMolecule: 'magnesium',
      aliases: ['Magnesium Bisglycinate', 'Mg Glycinate'],
      sectionId: 'vitamins_supplements',
      subsection: 'Minerals & Electrolytes',
      tags: ['supplement', 'mineral', 'magnesium', 'sleep_support', 'chelate'],
      relatedCompoundIds: [],
      summary:
        'Chelated form of elemental magnesium bound to two glycine molecules, widely used for neuromuscular relaxation and sleep quality with high GI tolerance.',
      detailedDescription:
        'Magnesium is an essential cofactor for >300 enzymatic reactions including ATP synthesis, neuromuscular conduction, and Vitamin D metabolism. The bisglycinate chelate minimizes osmotic GI distress compared to oxide or citrate forms.',
      mechanismOfAction:
        'Acts as an endogenous NMDA receptor voltage-dependent blocker, supports GABAergic inhibitory tone, and provides glycine co-delivery for thermoregulatory sleep onset.',
      useCaseScenarios: [
        'Evening relaxation and sleep architecture support',
        'Correcting dietary magnesium insufficiency',
        'Cofactor support alongside Vitamin D3 supplementation',
      ],
      benefits: [
        'Improved sleep latency and calmness',
        'Neuromuscular cramp prevention',
        'Gentle gastrointestinal tolerability',
      ],
      timingRules: {
        preferredSlots: ['evening_dinner', 'bedtime_fasted'],
        avoidSlots: ['pre_workout'],
        foodState: 'any',
        workoutRelation: 'any',
        circadianEffect: 'sedating',
        timingNotes: 'Evening or pre-bedtime administration aligns with mild calming effects.',
      },
      halfLife: {
        valueHours: null,
        minHours: null,
        maxHours: null,
        displayText: 'Homeostatically regulated renal excretion (unmodeled single half-life)',
        route: 'Oral',
        kind: 'unmodeled',
        effectDurationNote:
          'Tissue and RBC magnesium stores equilibrate over weeks of steady intake.',
        sourceUrl: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
      },
      dosages: {
        rangeText: '200-400 mg elemental magnesium daily',
        defaultAmount: 200,
        defaultUnit: 'mg',
        route: 'Oral',
        frequencyText: 'Once daily in the evening',
        femaleDoseNote:
          'Adult female RDA is 310-320 mg/day total; supplemental Adult UL is 350 mg/day.',
        maleDoseNote:
          'Adult male RDA is 400-420 mg/day total; supplemental Adult UL is 350 mg/day.',
        titrationSchedule:
          'Start with 100-200 mg elemental magnesium in the evening for 1 week before increasing.',
        maxCeiling: 350,
      },
      cycles: {
        patternText: 'Continuous daily nutritional support',
        cycleDays: null,
        offDays: null,
        continuous: true,
        washoutNote: 'No washout required for physiological intake.',
      },
      doNotPairWith: [
        {
          targetType: 'nutrient',
          targetRef: 'zinc',
          severity: 'avoid_same_slot',
          separationHours: 2,
          mechanism: 'High-dose divalent cations compete for intestinal absorption.',
          recommendation: 'Separate high-dose zinc (>30 mg) and magnesium by at least 2 hours.',
          citation: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
        },
        {
          targetType: 'rx_med',
          targetRef: 'tetracycline_fluoroquinolone',
          severity: 'avoid_same_slot',
          separationHours: 4,
          mechanism: 'Chelation in GI lumen reduces antibiotic bioavailability.',
          recommendation:
            'Separate by at least 2-4 hours from tetracycline or fluoroquinolone antibiotics.',
          citation: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
        },
      ],
      synergies: [
        {
          targetRef: 'vitamin-d3',
          coLocate: false,
          reason:
            'Magnesium is a required cofactor for hepatic and renal Vitamin D activation.',
        },
      ],
      contraindications: [
        'Severe chronic kidney disease (eGFR <30 mL/min)',
        'Myasthenia gravis (caution at high doses)',
      ],
      sideEffects: ['Mild GI looseness at high supplemental intakes', 'Mild evening drowsiness'],
      monitoringLabs: ['RBC Magnesium', 'Serum Magnesium', 'BMP / eGFR'],
      storageNotes: 'Keep bottle tightly closed in a cool, dry location away from humidity.',
      sectionData: {
        chemicalForm: 'Magnesium Bisglycinate Chelate',
        bioavailabilityNote:
          'High absorption and low laxative potential relative to magnesium oxide.',
        elementalWeightMg: 200,
        totalCompoundWeightMg: 1430,
        servingForm: 'capsule',
        servingSize: '2 capsules',
        supplementFacts: [
          {
            nutrient: 'Magnesium (as Magnesium Bisglycinate)',
            amount: 200,
            unit: 'mg',
            percentDailyValue: 48,
          },
        ],
        foodCondition: 'With or without food',
        adultUpperLimit: {
          nutrientKey: 'magnesium_supplemental',
          amount: 350,
          unit: 'mg',
          basis: 'supplemental_only',
          sourceUrl: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
        },
        allergens: [],
        thirdPartyTestedNote: 'Select USP, NSF, or ISO-17025 third-party verified products.',
      },
      customFields: {},
      profileStatus: 'ai_draft',
      provenance: {
        sourceModel: 'manual',
        researchedAt: '2026-10-01T12:00:00.000Z',
        evidenceTier: 'established',
        confidence: 'high',
        citations: [
          {
            title: 'NIH Office of Dietary Supplements: Magnesium Fact Sheet for Health Professionals',
            url: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
          },
        ],
      },
      notes: 'Track elemental magnesium separately from total chelate capsule weight.',
    },
    overrides
  );
}

function makeDermCompound(overrides = {}) {
  return deepMerge(
    {
      name: 'Tretinoin 0.05% Cream',
      canonicalMolecule: 'tretinoin',
      aliases: ['All-trans retinoic acid', 'Retin-A'],
      sectionId: 'dermatology',
      subsection: 'Facial Retinoids',
      tags: [
        'dermatology',
        'retinoid',
        'photosensitizing',
        'teratogen',
        'pm_only',
        'skin_cycling_active',
      ],
      relatedCompoundIds: [],
      summary:
        'Prescription-strength all-trans retinoic acid topical cream considered the clinical gold standard for photoaging, collagen remodeling, and comedonal acne.',
      detailedDescription:
        'Tretinoin directly activates nuclear retinoic acid receptors without metabolic conversion, accelerating epidermal turnover and stimulating dermal Type I/III procollagen synthesis.',
      mechanismOfAction:
        'Binds RAR-alpha/beta/gamma receptors in keratinocytes and dermal fibroblasts, normalizing follicular desquamation, suppressing matrix metalloproteinases (MMPs), and upregulating dermal collagen production.',
      useCaseScenarios: [
        'Photoaging and fine-line reduction',
        'Comedonal acne management',
        'Alternating-night skin cycling active',
      ],
      benefits: [
        'Accelerated epidermal renewal',
        'Dermal collagen synthesis',
        'Improved texture and dyschromia',
      ],
      timingRules: {
        preferredSlots: ['derm_pm'],
        avoidSlots: ['derm_am'],
        foodState: 'any',
        workoutRelation: 'any',
        circadianEffect: 'neutral',
        timingNotes:
          'PM only onto dry skin 15-20 min after cleansing; pair with broad-spectrum AM SPF 30+.',
      },
      halfLife: {
        valueHours: 1,
        minHours: 0.5,
        maxHours: 2,
        displayText: 'Minimal systemic absorption (<2%); epidermal remodeling cycle 28-42 days',
        route: 'Topical',
        kind: 'biological',
        effectDurationNote:
          'Gene-expression remodeling persists across multi-week keratinocyte turnover.',
        sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/17515510/',
      },
      dosages: {
        rangeText: 'Pea-sized amount (0.025%-0.05%) 2-5 nights/week',
        defaultAmount: 1,
        defaultUnit: 'pea_size',
        route: 'Topical',
        frequencyText: 'Alternating nights (2-4x/week)',
        femaleDoseNote: 'Avoid entirely during pregnancy or while trying to conceive.',
        maleDoseNote: 'Pea-sized amount over dry face/neck at night; avoid immediate eye corners.',
        titrationSchedule:
          'Start 2 nights/week for 3-4 weeks, gradually advancing to alternate nights as barrier adapts.',
        maxCeiling: 1,
      },
      cycles: {
        patternText:
          'Continuous skin cycling (Retinoid night / Exfoliant night / 2 Barrier Recovery nights)',
        cycleDays: null,
        offDays: null,
        continuous: true,
        washoutNote: 'Hold 48-72h before and 24h after microneedling or chemical peels.',
      },
      doNotPairWith: [
        {
          targetType: 'class',
          targetRef: 'aha_bha',
          severity: 'alternate_days',
          mechanism:
            'Concurrent strong exfoliating acids and retinoids compound barrier irritation and erythema.',
          recommendation: 'Separate onto alternating PM nights.',
          citation: 'https://pubmed.ncbi.nlm.nih.gov/17515510/',
        },
        {
          targetType: 'compound',
          targetRef: 'benzoyl-peroxide',
          severity: 'avoid_same_slot',
          separationHours: 12,
          mechanism:
            'Benzoyl peroxide oxidizes non-encapsulated tretinoin and intensifies irritation.',
          recommendation: 'Place benzoyl peroxide in AM and tretinoin in PM.',
          citation: 'https://pubmed.ncbi.nlm.nih.gov/17515510/',
        },
        {
          targetType: 'class',
          targetRef: 'pregnancy',
          severity: 'hard_stop',
          mechanism:
            'Topical retinoids are contraindicated as a teratogenic precaution during pregnancy.',
          recommendation: 'Discontinue when pregnant or trying to conceive.',
          citation: 'https://dailymed.nlm.nih.gov/dailymed/',
        },
      ],
      synergies: [
        {
          targetRef: 'ceramide-moisturizer',
          coLocate: true,
          reason:
            'Barrier-repair ceramide cream mitigates retinoid-induced transepidermal water loss.',
        },
      ],
      contraindications: [
        'Pregnancy or trying to conceive',
        'Sunburned or acutely abraded skin',
        'Active facial eczema flare',
      ],
      sideEffects: [
        'Peeling, dryness, and transient retinoid dermatitis',
        'Increased UV photosensitivity',
        'Initial comedonal purging',
      ],
      monitoringLabs: [],
      storageNotes:
        'Keep tube tightly capped at room temperature (20-25°C) away from heat and direct sunlight.',
      sectionData: {
        targetArea: ['face', 'neck'],
        vehicleType: 'cream',
        actives: [{ name: 'Tretinoin', concentrationPct: 0.05, optimalPh: 5.5 }],
        layeringStep: 5,
        waitTimeMinutes: 15,
        amPmSuitability: 'pm_only',
        photosensitivity: true,
        leaveOn: true,
        acclimationRamp:
          '2 nights/week for weeks 1-3, 3 nights/week for weeks 4-6, then alternate nights.',
        skinCyclingRole: 'retinoid',
        pregnancySafety: 'avoid',
      },
      customFields: {},
      profileStatus: 'ai_draft',
      provenance: {
        sourceModel: 'manual',
        researchedAt: '2026-10-01T12:00:00.000Z',
        evidenceTier: 'established',
        confidence: 'high',
        citations: [
          {
            title:
              'Retinoids in the treatment of skin aging: an overview of clinical efficacy and safety',
            url: 'https://pubmed.ncbi.nlm.nih.gov/17515510/',
            pmid: '17515510',
          },
        ],
      },
      notes: 'Always pair with broad-spectrum AM sunscreen (SPF 30+).',
    },
    overrides
  );
}

function makeProtocolOsExport(overrides = {}) {
  return deepMerge(
    {
      _format: 'protocol-os-export/v1',
      exportedAt: '2026-10-15T08:00:00.000Z',
      activeProfile: 'Spouse A',
      protocols: [
        {
          id: 'proto_bpc157_syn',
          profile: 'Spouse A',
          peptideId: 'bpc157',
          peptideName: 'BPC-157',
          doseMcg: 250,
          doseUnit: 'mcg',
          doseValue: 250,
          route: 'SubQ',
          schedule: { days: [1, 2, 3, 4, 5], timeOfDay: 'morning' },
          cycleDays: 42,
          startDate: '2026-10-01',
          active: true,
          updatedAt: '2026-10-15T08:00:00.000Z',
        },
        {
          id: 'proto_blend_syn',
          profile: 'Spouse A',
          peptideId: 'wolverine',
          peptideName: 'Wolverine (BPC + TB)',
          ingredients: { bpc157: 0.5, tb500: 0.5 },
          doseMcg: 500,
          doseUnit: 'mcg',
          doseValue: 500,
          route: 'SubQ',
          schedule: { days: [1, 3, 5], timeOfDay: 'evening' },
          cycleDays: 35,
          startDate: '2026-10-01',
          active: true,
          updatedAt: '2026-10-15T08:00:00.000Z',
        },
        {
          id: 'proto_ipa_eod_syn',
          profile: 'Spouse B',
          peptideId: 'ipamorelin',
          peptideName: 'Ipamorelin',
          doseMcg: 200,
          doseUnit: 'mcg',
          doseValue: 200,
          route: 'SubQ',
          schedule: { every: 2, anchor: '2026-10-01', days: [0, 2, 4, 6], timeOfDay: 'evening' },
          cycleDays: 56,
          startDate: '2026-10-01',
          active: true,
          updatedAt: '2026-10-15T08:00:00.000Z',
        },
      ],
      vials: [
        {
          id: 'vial_bpc157_syn',
          peptideId: 'bpc157',
          peptideName: 'BPC-157',
          mgPerVial: 5,
          diluentMl: 2,
          doseMcg: 250,
          totalMcg: 5000,
          remainingMcg: 4250,
          mcgPerMl: 2500,
          mcgPerUnit: 25,
          unitsPerDose: 10,
          unitLabel: null,
          iuPerVial: null,
          reconstitutedAt: '2026-10-01T07:00:00.000Z',
          cycleStartDate: '2026-10-01',
          cycleDays: 42,
          active: true,
          formType: 'liquid',
          inventoryProfile: 'Spouse A',
          updatedAt: '2026-10-15T08:00:00.000Z',
        },
        {
          id: 'vial_blend_syn',
          peptideId: 'wolverine',
          peptideName: 'Wolverine (BPC + TB)',
          mgPerVial: 10,
          diluentMl: 2,
          doseMcg: 500,
          totalMcg: 10000,
          remainingMcg: 8500,
          mcgPerMl: 5000,
          mcgPerUnit: 50,
          unitsPerDose: 10,
          unitLabel: null,
          iuPerVial: null,
          reconstitutedAt: '2026-10-01T07:00:00.000Z',
          cycleStartDate: '2026-10-01',
          cycleDays: 35,
          active: true,
          formType: 'liquid',
          inventoryProfile: 'Spouse A',
          updatedAt: '2026-10-15T08:00:00.000Z',
        },
      ],
      storage: [],
      meta: {
        migrations: [],
        tombstones: { protocols: {}, vials: {}, logs: {} },
      },
      logs: [
        {
          id: 'log_syn_1',
          protocolId: 'proto_bpc157_syn',
          vialId: 'vial_bpc157_syn',
          peptideId: 'bpc157',
          peptide: 'BPC-157',
          peptideName: 'BPC-157',
          profile: 'Spouse A',
          datetime: '2026-10-14T07:15:00.000Z',
          doseMcg: 250,
          doseUnit: 'mcg',
          doseValue: 250,
          doseMl: 0.1,
          site: 'abdomen_left',
          skipped: false,
          notes: 'Synthetic routine log entry',
          updatedAt: '2026-10-14T07:15:00.000Z',
        },
        {
          id: 'log_syn_2',
          protocolId: 'proto_blend_syn',
          vialId: 'vial_blend_syn',
          peptideId: 'wolverine',
          peptide: 'Wolverine (BPC + TB)',
          peptideName: 'Wolverine (BPC + TB)',
          profile: 'Spouse A',
          datetime: '2026-10-14T20:00:00.000Z',
          doseMcg: 0,
          doseUnit: 'mcg',
          doseValue: 0,
          doseMl: null,
          site: '',
          skipped: true,
          notes: 'Synthetic skipped travel day',
          updatedAt: '2026-10-14T20:00:00.000Z',
        },
      ],
    },
    overrides
  );
}

function makeStackItem(overrides = {}) {
  return deepMerge(
    {
      compoundId: 'cmp_synthetic_1',
      doseAmount: 250,
      doseUnit: 'mcg',
      frequency: 'daily',
      cadence: {
        type: 'daily',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
      pinnedSlot: null,
      enabled: true,
    },
    overrides
  );
}

function makeStackPayload(overrides = {}) {
  return deepMerge(
    {
      name: 'Foundation Stack',
      memberId: 'member_wife',
      active: true,
      description: 'Synthetic cross-section foundation stack.',
      items: [makeStackItem()],
    },
    overrides
  );
}

function makeMemberPayload(overrides = {}) {
  return deepMerge(
    {
      name: 'Alex',
      avatarInitial: 'A',
      accentColor: '#3D7A5A',
      role: 'admin',
      routineAnchors: {
        wake: '07:00',
        breakfast: '08:00',
        workout: '06:30',
        workoutDays: [1, 2, 3, 4, 5],
        lunch: '13:00',
        dinner: '19:00',
        bed: '22:30',
        tz: 'UTC',
      },
      safetyContext: {
        pregnancyOrTrying: false,
        biologicalSexContext: 'unspecified',
        allergies: [],
        activeRxMeds: [],
        conditions: [],
      },
    },
    overrides
  );
}

function makeCustomSectionField(overrides = {}) {
  return deepMerge(
    {
      key: 'coa_purity_url',
      label: 'Certificate of Analysis URL',
      fieldType: 'url',
      required: false,
      showOnCard: true,
      aiResearchInstruction:
        'Provide a third-party Certificate of Analysis or verified reference URL when available.',
    },
    overrides
  );
}

export const fixtures = {
  makePeptideCompound,
  makePedCompound,
  makeSupplementCompound,
  makeDermCompound,
  makeProtocolOsExport,
  makeStackItem,
  makeStackPayload,
  makeMemberPayload,
  makeCustomSectionField,
};
