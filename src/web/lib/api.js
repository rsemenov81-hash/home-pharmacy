/**
 * Home Pharmacy Browser API Client (`src/web/lib/api.js`).
 * Captures `?token=` on initial load into memory/sessionStorage and immediately scrubs
 * `?token=` from `window.history.replaceState` so credentials never linger in the URL bar.
 */

import { handleLocalApiRequest, isLocalModeEnabled, setLocalModeEnabled } from './local-backend.js';

const TOKEN_STORAGE_KEY = 'hp_session_token_v1';
const BASE_URL_STORAGE_KEY = 'hp_api_base_url_v1';

let memoryToken = '';

export function bootstrapTokenFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const qTok = url.searchParams.get('token');
    if (qTok && qTok.trim()) {
      memoryToken = qTok.trim();
      setLocalModeEnabled(false);
      try {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, memoryToken);
      } catch {
        // ignore storage quota errors
      }
      url.searchParams.delete('token');
      window.history.replaceState({}, document.title, url.pathname + (url.search ? url.search : '') + url.hash);
      return memoryToken;
    }
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored && stored.trim()) {
      memoryToken = stored.trim();
      return memoryToken;
    }
  } catch {
    // ignore URL errors
  }
  return memoryToken;
}

export function getAuthToken() {
  return memoryToken;
}

export function setAuthToken(token) {
  memoryToken = typeof token === 'string' ? token.trim() : '';
  try {
    if (memoryToken) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, memoryToken);
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getCustomApiBaseUrl() {
  try {
    const custom = window.localStorage.getItem(BASE_URL_STORAGE_KEY);
    if (custom && custom.trim()) return custom.trim().replace(/\/+$/, '');
  } catch {
    // ignore
  }
  return '';
}

export function getApiBaseUrl() {
  const custom = getCustomApiBaseUrl();
  if (custom) return custom;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export function setApiBaseUrl(url) {
  try {
    const clean = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (clean) window.localStorage.setItem(BASE_URL_STORAGE_KEY, clean);
    else window.localStorage.removeItem(BASE_URL_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function apiRequest(method, path, body = undefined, { headers = {}, rawText = false } = {}) {
  if (isLocalModeEnabled()) {
    return handleLocalApiRequest(method, path, body, { headers, rawText });
  }
  const base = getApiBaseUrl();
  const token = getAuthToken();
  const reqHeaders = {
    Accept: rawText ? '*/*' : 'application/json',
    ...headers,
  };
  if (token) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers: reqHeaders,
    body: payload,
  });

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

export const api = {
  get: (path, opts) => apiRequest('GET', path, undefined, opts),
  post: (path, body, opts) => apiRequest('POST', path, body, opts),
  put: (path, body, opts) => apiRequest('PUT', path, body, opts),
  patch: (path, body, opts) => apiRequest('PATCH', path, body, opts),
  del: (path, body, opts) => apiRequest('DELETE', path, body, opts),
};
