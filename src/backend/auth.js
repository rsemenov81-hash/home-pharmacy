/**
 * Web-Standard Authentication, Constant-Time Comparison, Scoped Bearer/Query Auth,
 * Strict CORS Allowlist & Privacy Header Helpers (F4, F24, F45).
 *
 * Uses ONLY Web Crypto API (`crypto.subtle`, `crypto.getRandomValues`) for full
 * Node 22 + Cloudflare Workers runtime compatibility.
 */

const textEncoder = new TextEncoder();

export async function sha256Bytes(input) {
  const buf = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(input ?? '')));
  return new Uint8Array(buf);
}

export async function sha256Hex(input) {
  const bytes = await sha256Bytes(input);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Base64Url(input) {
  const bytes = await sha256Bytes(input);
  return base64UrlEncode(bytes);
}

export function randomToken(byteLen = 32) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = textEncoder.encode(a);
  const bufB = textEncoder.encode(b);
  const maxLen = Math.max(bufA.length, bufB.length);
  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < bufA.length ? bufA[i] : 0;
    const byteB = i < bufB.length ? bufB[i] : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0 && bufA.length > 0;
}

// ---------------------------------------------------------------------------
// Scope & Actor Helpers
// ---------------------------------------------------------------------------

const SCOPE_RANK = Object.freeze({
  read: 1,
  propose: 2,
  write: 3,
});

export function normalizeScopes(rawScope) {
  if (!rawScope) return ['read'];
  const tokens = Array.isArray(rawScope)
    ? rawScope
    : String(rawScope)
        .split(/[\s,]+/)
        .filter(Boolean);
  const valid = new Set();
  for (const t of tokens) {
    const low = String(t).toLowerCase().trim();
    if (low === 'read' || low === 'propose' || low === 'write') {
      valid.add(low);
    }
  }
  if (valid.size === 0) valid.add('read');
  // Higher scopes implicitly include lower scopes
  if (valid.has('write')) {
    valid.add('propose');
    valid.add('read');
  } else if (valid.has('propose')) {
    valid.add('read');
  }
  return [...valid];
}

export function primaryScopeOf(scopes) {
  const list = normalizeScopes(scopes);
  if (list.includes('write')) return 'write';
  if (list.includes('propose')) return 'propose';
  return 'read';
}

export function hasScope(auth, requiredScope) {
  if (!auth || !auth.authenticated) return false;
  const reqRank = SCOPE_RANK[requiredScope] ?? 3;
  const userRank = SCOPE_RANK[primaryScopeOf(auth.scopes || auth.scope)] ?? 0;
  return userRank >= reqRank;
}

export function normalizeAiActorName(rawName) {
  const s = String(rawName || '').toLowerCase();
  if (s.includes('claude')) return 'ai:claude';
  if (s.includes('gemini')) return 'ai:gemini';
  if (s.includes('grok')) return 'ai:grok';
  if (s.includes('chatgpt') || /\bgpt\b/.test(s) || s.includes('openai')) return 'ai:gpt';
  if (s.includes('muse')) return 'ai:muse';
  const cleaned = s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return cleaned ? `ai:${cleaned}` : 'ai:client';
}

// ---------------------------------------------------------------------------
// Strict CORS Allowlist & Security Headers
// ---------------------------------------------------------------------------

export function isOriginAllowed(origin, env = {}) {
  if (!origin || typeof origin !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Exact origin only (no path/query/hash/trailing slash spoofing)
  if (parsed.origin !== origin) return false;

  const { protocol, hostname } = parsed;
  if (protocol === 'https:' && hostname === 'rsemenov81-hash.github.io') {
    return true;
  }
  if (protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
    return true;
  }
  const extraRaw = env?.ALLOWED_ORIGINS || '';
  if (typeof extraRaw === 'string' && extraRaw.trim()) {
    const allowed = extraRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) return true;
  }
  return false;
}

export function getCorsHeaders(request, env = {}) {
  const origin = request.headers.get('origin');
  const headers = {
    Vary: 'Origin',
  };
  if (origin && isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] =
      'Authorization, Content-Type, If-Match, Mcp-Session-Id, MCP-Protocol-Version, Accept';
    headers['Access-Control-Expose-Headers'] = 'ETag, Mcp-Session-Id, WWW-Authenticate';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

export function getRequestOrigin(request, env = {}) {
  if (env?.PUBLIC_ORIGIN && typeof env.PUBLIC_ORIGIN === 'string') {
    return env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  }
  const url = new URL(request.url);
  return url.origin;
}

// ---------------------------------------------------------------------------
// Dual Authentication Resolver (Bearer Header OR ?token= Query Fallback)
// ---------------------------------------------------------------------------

export function extractBearerOrQueryToken(request) {
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader) {
    const match = /^Bearer\s+([^\s]+)\s*$/i.exec(authHeader);
    if (match && match[1]) {
      return { token: match[1], via: 'bearer', headerPresent: true };
    }
    // Malformed Authorization header -> treat as invalid credential attempt
    return { token: null, via: 'malformed_header', headerPresent: true };
  }
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  if (queryToken !== null) {
    return { token: queryToken.trim() || null, via: 'query', headerPresent: false };
  }
  return { token: null, via: 'none', headerPresent: false };
}

export async function resolveAuth(request, env, storage) {
  const extracted = extractBearerOrQueryToken(request);
  if (!extracted.token) {
    return { authenticated: false, reason: 'missing_token' };
  }

  const candidate = extracted.token;

  // 1. Household Admin Token
  const adminToken = env?.HOUSEHOLD_ADMIN_TOKEN || '';
  if (adminToken && constantTimeEqual(candidate, adminToken)) {
    return {
      authenticated: true,
      kind: 'admin',
      scope: 'write',
      scopes: ['read', 'propose', 'write'],
      actor: 'member:admin',
      memberId: null,
      via: extracted.via,
    };
  }

  // Hash candidate once for constant-time comparison against stored SHA-256 hashes
  const candidateHash = await sha256Hex(candidate);
  const authStore = await storage.getAuthStore();

  // 2. Scoped API Keys (SHA-256 hashed at rest)
  for (const key of authStore.apiKeys || []) {
    if (!key || key.revokedAt) continue;
    if (key.keyHash && constantTimeEqual(candidateHash, key.keyHash)) {
      const scopes = normalizeScopes(key.scope);
      const actor =
        typeof key.actor === 'string' && key.actor.trim()
          ? key.actor.trim()
          : normalizeAiActorName(key.name);
      return {
        authenticated: true,
        kind: 'api_key',
        keyId: key.id,
        keyName: key.name,
        scope: primaryScopeOf(scopes),
        scopes,
        actor,
        memberId: key.memberId || null,
        via: extracted.via,
      };
    }
  }

  // 3. OAuth 2.1 Access Tokens (SHA-256 hashed at rest)
  const nowMs = Date.now();
  for (const tok of authStore.oauthTokens || []) {
    if (!tok || tok.revokedAt) continue;
    if (tok.accessExpiresAt && Date.parse(tok.accessExpiresAt) <= nowMs) continue;
    if (tok.accessHash && constantTimeEqual(candidateHash, tok.accessHash)) {
      const scopes = normalizeScopes(tok.scope);
      return {
        authenticated: true,
        kind: 'oauth',
        tokenId: tok.id,
        grantId: tok.grantId,
        clientId: tok.clientId,
        clientName: tok.clientName || tok.clientId,
        scope: primaryScopeOf(scopes),
        scopes,
        actor: normalizeAiActorName(tok.clientName || tok.clientId),
        memberId: tok.memberId || null,
        resource: tok.resource || null,
        via: extracted.via,
      };
    }
  }

  return { authenticated: false, reason: 'invalid_token' };
}

// ---------------------------------------------------------------------------
// Standard Response Builders
// ---------------------------------------------------------------------------

export function jsonResponse(body, { status = 200, headers = {}, corsHeaders = {}, noStore = true } = {}) {
  const merged = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    ...corsHeaders,
    ...headers,
  };
  if (noStore) {
    merged['Cache-Control'] = 'no-store';
    merged.Pragma = 'no-cache';
  }
  return new Response(JSON.stringify(body), { status, headers: merged });
}

export function textResponse(text, { status = 200, contentType = 'text/plain; charset=utf-8', headers = {}, corsHeaders = {}, noStore = true } = {}) {
  const merged = {
    'Content-Type': contentType,
    'X-Robots-Tag': 'noindex, nofollow',
    ...corsHeaders,
    ...headers,
  };
  if (noStore) {
    merged['Cache-Control'] = 'no-store';
    merged.Pragma = 'no-cache';
  }
  return new Response(text, { status, headers: merged });
}

export function unauthorizedResponse({ origin, isMcp = false, corsHeaders = {}, message = 'Authentication required.' } = {}) {
  const headers = {
    'WWW-Authenticate': isMcp
      ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
      : `Bearer realm="home-pharmacy", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  };
  return jsonResponse(
    {
      error: 'unauthorized',
      message,
    },
    { status: 401, headers, corsHeaders, noStore: true },
  );
}

export function forbiddenResponse({ corsHeaders = {}, message = 'Insufficient token scope for this operation.' } = {}) {
  return jsonResponse(
    {
      error: 'forbidden',
      message,
    },
    { status: 403, headers: {}, corsHeaders, noStore: true },
  );
}
