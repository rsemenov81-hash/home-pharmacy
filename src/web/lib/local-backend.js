/**
 * Local Browser Storage & In-Browser Fetch Engine (`src/web/lib/local-backend.js`).
 *
 * Allows the Home Pharmacy PWA hosted statically (e.g., GitHub Pages) to run
 * 100% locally in the user's browser with zero server setup — executing the exact
 * same Web-Standard `createApp`, `HubService`, `core`, and `scheduler` modules
 * backed by `window.localStorage`, while allowing one-click switching to a remote
 * Cloudflare Worker or self-hosted Node 22 server in Settings.
 */

import { createApp } from '../../backend/app.js';
import { createMemoryStorage } from '../../backend/storage/memory.js';
import { createEmptyHubState, seedStarterCatalog } from '../../core/index.js';

const LOCAL_MODE_KEY = 'hp_local_browser_mode_v1';
const LOCAL_HUB_KEY = 'hp_local_browser_hub_v1';
const LOCAL_AUTH_KEY = 'hp_local_browser_auth_v1';
const LOCAL_TOKEN = 'hp-local-browser-session';

let cachedApp = null;

function isLoopbackHost() {
  if (typeof window === 'undefined') return true;
  const h = (window.location.hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function isStaticHostedEnvironment() {
  if (typeof window === 'undefined') return false;
  const proto = window.location.protocol;
  if (proto === 'file:' || proto === 'about:') return true;
  return !isLoopbackHost();
}

export function isLocalModeEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(LOCAL_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setLocalModeEnabled(enabled) {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(LOCAL_MODE_KEY, '1');
    else window.localStorage.removeItem(LOCAL_MODE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function shouldAutoEnterLocalMode({ hasToken, hasCustomApiUrl } = {}) {
  if (hasToken || hasCustomApiUrl) return false;
  if (isLocalModeEnabled()) return true;
  // Auto-enter local browser mode when served statically (e.g. GitHub Pages) with no backend configured
  return isStaticHostedEnvironment();
}

function createLocalStorageAdapter() {
  let initialHub = null;
  let initialAuth = null;
  try {
    const rawHub = window.localStorage.getItem(LOCAL_HUB_KEY);
    if (rawHub) initialHub = JSON.parse(rawHub);
    const rawAuth = window.localStorage.getItem(LOCAL_AUTH_KEY);
    if (rawAuth) initialAuth = JSON.parse(rawAuth);
  } catch {
    // start fresh on corrupt/unavailable storage
  }

  // On static hosted first launch (or untouched empty rev 0), pre-load the generic,
  // non-personal 26-compound Starter Reference Library so users immediately explore a rich hub.
  if (!initialHub || ((initialHub.compounds || []).length === 0 && (initialHub._rev || 0) === 0)) {
    const seeded = seedStarterCatalog(initialHub || createEmptyHubState(), {
      createOwnershipRecords: false,
    });
    initialHub = seeded.state;
    try {
      window.localStorage.setItem(LOCAL_HUB_KEY, JSON.stringify(initialHub));
    } catch {
      // ignore quota errors
    }
  }

  const mem = createMemoryStorage(initialHub);
  if (initialAuth) {
    mem.saveAuthStore(initialAuth).catch(() => {});
  }

  return {
    ...mem,
    kind: 'browser-local',
    async saveHubState(nextState) {
      const saved = await mem.saveHubState(nextState);
      try {
        window.localStorage.setItem(LOCAL_HUB_KEY, JSON.stringify(saved));
      } catch {
        // ignore quota errors; in-memory state still updated
      }
      return saved;
    },
    async saveAuthStore(nextAuth) {
      const saved = await mem.saveAuthStore(nextAuth);
      try {
        window.localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(saved));
      } catch {
        // ignore
      }
      return saved;
    },
  };
}

function getLocalApp() {
  if (!cachedApp) {
    const storage = createLocalStorageAdapter();
    cachedApp = createApp({
      storage,
      env: {
        HOUSEHOLD_ADMIN_TOKEN: LOCAL_TOKEN,
        HOUSEHOLD_PASSCODE: 'local-browser',
        MODE: 'browser-local',
      },
    });
  }
  return cachedApp;
}

export async function handleLocalApiRequest(method, path, body = undefined, { headers = {}, rawText = false } = {}) {
  const app = getLocalApp();
  const origin =
    typeof window !== 'undefined' && /^https?:\/\//i.test(window.location.origin)
      ? window.location.origin
      : 'https://local.home-pharmacy';

  const reqHeaders = new Headers({
    Accept: rawText ? '*/*' : 'application/json',
    Authorization: `Bearer ${LOCAL_TOKEN}`,
    ...headers,
  });

  let payload;
  if (body !== undefined) {
    reqHeaders.set('Content-Type', 'application/json');
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const req = new Request(`${origin}${path}`, {
    method,
    headers: reqHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
  });

  const res = await app.handleRequest(req);
  const text = await res.text();

  if (rawText) {
    if (!res.ok) {
      const err = new Error(text || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, text, headers: res.headers };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = new Error(json?.message || json?.error || text || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error || 'HTTP_ERROR';
    err.data = json;
    throw err;
  }

  return { status: res.status, json, text, headers: res.headers };
}
