/**
 * Self-Hosted OAuth 2.1 + PKCE (S256) + Discovery (RFC 9728 / RFC 8414 / RFC 9207) +
 * Dynamic Client Registration (RFC 7591) + Client ID Metadata Document (CIMD) +
 * Household Consent UI + Refresh Token Rotation + Revocation (RFC 7009) (F24).
 *
 * Pure Web Standards (`Request` -> `Response`, Web Crypto). Works on Node 22 & Cloudflare Workers.
 */

import {
  constantTimeEqual,
  getRequestOrigin,
  jsonResponse,
  normalizeScopes,
  primaryScopeOf,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from './auth.js';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;    // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000; // 30 days
const VALID_SCOPES = new Set(['read', 'propose', 'write']);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidRedirectUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isValidHttpsCimdClientId(clientId) {
  if (typeof clientId !== 'string' || !clientId.trim()) return false;
  try {
    const parsed = new URL(clientId);
    // Strict CIMD rule: MUST be HTTPS URL with non-empty hostname and non-root or metadata path
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

function parseCookie(headerVal, name) {
  if (!headerVal) return null;
  const parts = headerVal.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

async function parseFormOrJson(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  const raw = await request.text();
  if (ct.includes('application/json')) {
    try {
      const obj = JSON.parse(raw || '{}');
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return null;
    }
  }
  if (ct.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return out;
  }
  try {
    const obj = JSON.parse(raw || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function parseRequestedScope(rawScope) {
  if (!rawScope || typeof rawScope !== 'string' || !rawScope.trim()) {
    return { ok: true, scopes: ['read'], scopeString: 'read' };
  }
  const parts = rawScope.trim().split(/\s+/).filter(Boolean);
  for (const p of parts) {
    if (!VALID_SCOPES.has(p)) {
      return { ok: false, invalid: p };
    }
  }
  const primary = primaryScopeOf(parts);
  return { ok: true, scopes: normalizeScopes(parts), scopeString: primary };
}

function renderConsentHtml({
  origin,
  clientId,
  clientName,
  redirectUri,
  scope,
  state,
  codeChallenge,
  codeChallengeMethod,
  resource,
  csrfToken,
  members = [],
  errorMsg = '',
}) {
  const memberOptions = (members.length > 0 ? members : [{ id: 'member_wife', name: 'Wife' }, { id: 'member_husband', name: 'Husband' }])
    .map(
      (m, idx) =>
        `<option value="${escapeHtml(m.id)}"${idx === 0 ? ' selected' : ''}>${escapeHtml(m.name)} (${escapeHtml(m.id)})</option>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Authorize AI Access — Home Pharmacy</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0c1714; color: #f3ede2; margin: 0; padding: 2rem; display: flex; justify-content: center; }
    .card { max-width: 440px; width: 100%; background: #13241f; border: 1px solid #2a453c; border-radius: 14px; padding: 1.5rem; }
    h1 { font-size: 1.2rem; margin: 0 0 0.5rem; color: #e3c886; }
    p { font-size: 0.9rem; color: #c7d1cc; line-height: 1.45; }
    label { display: block; margin-top: 1rem; font-size: 0.85rem; color: #e3c886; }
    input[type="password"], select { width: 100%; box-sizing: border-box; margin-top: 0.35rem; padding: 0.6rem; border-radius: 8px; border: 1px solid #35584c; background: #0c1714; color: #f3ede2; }
    .err { background: #4a1c1c; border: 1px solid #b54545; color: #ffd4d4; padding: 0.6rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.85rem; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    button { flex: 1; padding: 0.7rem; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; }
    .approve { background: #e3c886; color: #0c1714; }
    .deny { background: #263a33; color: #f3ede2; }
    .meta { font-size: 0.8rem; color: #9db2aa; margin-top: 0.5rem; word-break: break-all; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Authorize AI Assistant</h1>
    <p><strong>${escapeHtml(clientName || clientId)}</strong> requests <strong>${escapeHtml(scope)}</strong> access to your Home Pharmacy hub.</p>
    <div class="meta">Client ID: ${escapeHtml(clientId)}</div>
    ${resource ? `<div class="meta">Resource: ${escapeHtml(resource)}</div>` : ''}
    ${errorMsg ? `<div class="err" role="alert">${escapeHtml(errorMsg)}</div>` : ''}
    <form action="${escapeHtml(origin)}/oauth/authorize" method="POST">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
      <input type="hidden" name="response_type" value="code" />
      <input type="hidden" name="scope" value="${escapeHtml(scope)}" />
      <input type="hidden" name="state" value="${escapeHtml(state || '')}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}" />
      <input type="hidden" name="resource" value="${escapeHtml(resource || '')}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <label for="member_id">Household Member Context</label>
      <select id="member_id" name="member_id">${memberOptions}</select>
      <label for="passcode">Household Passcode</label>
      <input id="passcode" type="password" name="passcode" autocomplete="current-password" required />
      <div class="actions">
        <button type="submit" name="decision" value="approve" class="approve">Approve</button>
        <button type="submit" name="decision" value="deny" class="deny" formnovalidate>Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 Route Handler
// ---------------------------------------------------------------------------

export async function handleOAuthRoute(request, url, env, storage, corsHeaders) {
  const origin = getRequestOrigin(request, env);
  const { pathname } = url;
  const method = request.method.toUpperCase();

  // 1. RFC 9728 Protected Resource Metadata (root + /mcp)
  if (
    method === 'GET' &&
    (pathname === '/.well-known/oauth-protected-resource' ||
      pathname === '/.well-known/oauth-protected-resource/mcp')
  ) {
    const resource = pathname.endsWith('/mcp') ? `${origin}/mcp` : `${origin}/mcp`;
    return jsonResponse(
      {
        resource,
        authorization_servers: [origin],
        scopes_supported: ['read', 'propose', 'write'],
        bearer_methods_supported: ['header'],
        resource_documentation: `${origin}/llms.txt`,
      },
      { status: 200, corsHeaders, noStore: false },
    );
  }

  // 2. RFC 8414 Authorization Server Metadata (with RFC 9207 iss + CIMD support)
  if (method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
    return jsonResponse(
      {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['read', 'propose', 'write'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      },
      { status: 200, corsHeaders, noStore: false },
    );
  }

  // 3. RFC 7591 Dynamic Client Registration (POST /oauth/register)
  if (method === 'POST' && pathname === '/oauth/register') {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        { error: 'invalid_client_metadata', error_description: 'Request body must be valid JSON.' },
        { status: 400, corsHeaders },
      );
    }
    if (!body || typeof body !== 'object') {
      return jsonResponse(
        { error: 'invalid_client_metadata', error_description: 'Client metadata must be an object.' },
        { status: 400, corsHeaders },
      );
    }
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
      return jsonResponse(
        {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris must be a non-empty array of valid https:// or localhost http:// URLs.',
        },
        { status: 400, corsHeaders },
      );
    }

    const clientName =
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 120)
        : 'AI MCP Client';
    const tokenAuthMethod =
      body.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'none';
    const clientId = `hp_client_${randomToken(12)}`;
    const clientSecret = tokenAuthMethod === 'client_secret_post' ? `hp_csec_${randomToken(24)}` : null;
    const nowIso = new Date().toISOString();

    const authStore = await storage.getAuthStore();
    authStore.oauthClients.push({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: [...new Set(redirectUris)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: tokenAuthMethod,
      client_secret_hash: clientSecret ? await sha256Hex(clientSecret) : null,
      scope: typeof body.scope === 'string' ? body.scope : 'read propose write',
      createdAt: nowIso,
      revokedAt: null,
    });
    await storage.saveAuthStore(authStore);

    const resp = {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: [...new Set(redirectUris)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: tokenAuthMethod,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    if (clientSecret) resp.client_secret = clientSecret;
    return jsonResponse(resp, { status: 201, corsHeaders });
  }

  // 4. OAuth 2.1 Authorization Endpoint (GET & POST /oauth/authorize)
  if (pathname === '/oauth/authorize' && (method === 'GET' || method === 'POST')) {
    const authStore = await storage.getAuthStore();
    const hubState = await storage.getHubState();

    const validateAuthParams = (params) => {
      const responseType = params.response_type || 'code';
      const clientId = String(params.client_id || '').trim();
      const redirectUri = String(params.redirect_uri || '').trim();
      const codeChallenge = String(params.code_challenge || '').trim();
      const codeChallengeMethod = String(params.code_challenge_method || '').trim();
      const state = String(params.state || '');
      const resource = String(params.resource || '').trim();
      const scopeCheck = parseRequestedScope(params.scope);

      if (responseType !== 'code') {
        return { ok: false, status: 400, error: 'unsupported_response_type', desc: 'Only response_type=code is supported.' };
      }
      if (!clientId) {
        return { ok: false, status: 400, error: 'invalid_request', desc: 'client_id is required.' };
      }
      if (!redirectUri || !isValidRedirectUri(redirectUri)) {
        return { ok: false, status: 400, error: 'invalid_request', desc: 'Valid redirect_uri is required.' };
      }

      // Resolve client via DCR registry OR valid HTTPS URL CIMD
      const dcrClient = (authStore.oauthClients || []).find(
        (c) => c.client_id === clientId && !c.revokedAt,
      );
      let clientName = clientId;
      if (dcrClient) {
        if (!dcrClient.redirect_uris.includes(redirectUri)) {
          return { ok: false, status: 400, error: 'invalid_request', desc: 'redirect_uri is not registered for this client_id.' };
        }
        clientName = dcrClient.client_name || clientId;
      } else if (isValidHttpsCimdClientId(clientId)) {
        try {
          clientName = new URL(clientId).hostname;
        } catch {
          clientName = clientId;
        }
      } else {
        return {
          ok: false,
          status: 400,
          error: 'invalid_client',
          desc: 'Unknown client_id (must be registered via /oauth/register or a valid https:// CIMD URL).',
        };
      }

      // Mandatory PKCE S256 (OAuth 2.1)
      if (!codeChallenge) {
        return { ok: false, status: 400, error: 'invalid_request', desc: 'PKCE code_challenge is required.' };
      }
      if (codeChallengeMethod !== 'S256') {
        return {
          ok: false,
          status: 400,
          error: 'invalid_request',
          desc: 'Only PKCE code_challenge_method=S256 is permitted.',
        };
      }
      if (!scopeCheck.ok) {
        return {
          ok: false,
          status: 400,
          error: 'invalid_scope',
          desc: `Unsupported scope "${scopeCheck.invalid}". Allowed: read, propose, write.`,
        };
      }

      return {
        ok: true,
        clientId,
        clientName,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        state,
        resource,
        scope: scopeCheck.scopeString,
        isCimd: !dcrClient,
      };
    };

    if (method === 'GET') {
      const q = {};
      for (const [k, v] of url.searchParams.entries()) q[k] = v;
      const check = validateAuthParams(q);
      if (!check.ok) {
        return jsonResponse(
          { error: check.error, error_description: check.desc },
          { status: check.status, corsHeaders },
        );
      }

      const csrfToken = randomToken(16);
      const html = renderConsentHtml({
        origin,
        clientId: check.clientId,
        clientName: check.clientName,
        redirectUri: check.redirectUri,
        scope: check.scope,
        state: check.state,
        codeChallenge: check.codeChallenge,
        codeChallengeMethod: check.codeChallengeMethod,
        resource: check.resource,
        csrfToken,
        members: hubState.members || [],
      });

      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          'X-Frame-Options': 'DENY',
          'Set-Cookie': `hp_oauth_csrf=${encodeURIComponent(csrfToken)}; Path=/oauth/authorize; HttpOnly; SameSite=Lax`,
          ...corsHeaders,
        },
      });
    }

    // POST /oauth/authorize — validate consent & household passcode
    const body = await parseFormOrJson(request);
    if (!body) {
      return jsonResponse({ error: 'invalid_request', error_description: 'Malformed request body.' }, { status: 400, corsHeaders });
    }

    const check = validateAuthParams(body);
    if (!check.ok) {
      return jsonResponse(
        { error: check.error, error_description: check.desc },
        { status: check.status, corsHeaders },
      );
    }

    // CSRF verification when cookie was issued
    const cookieCsrf = parseCookie(request.headers.get('cookie'), 'hp_oauth_csrf');
    if (cookieCsrf && body.csrf_token && !constantTimeEqual(cookieCsrf, String(body.csrf_token))) {
      return jsonResponse(
        { error: 'invalid_request', error_description: 'CSRF token mismatch.' },
        { status: 403, corsHeaders },
      );
    }

    const decision = String(body.decision || body.action || body.consent || 'approve').toLowerCase().trim();
    if (decision === 'deny' || decision === 'cancel' || decision === 'reject' || body.deny !== undefined) {
      const cb = new URL(check.redirectUri);
      cb.searchParams.set('error', 'access_denied');
      cb.searchParams.set('error_description', 'User denied authorization request.');
      if (check.state) cb.searchParams.set('state', check.state);
      cb.searchParams.set('iss', origin);
      return new Response(null, {
        status: 302,
        headers: {
          Location: cb.toString(),
          'Cache-Control': 'no-store',
          ...corsHeaders,
        },
      });
    }

    // Verify Household Passcode constant-time
    const expectedPasscode = env?.HOUSEHOLD_PASSCODE || '';
    const submittedPasscode = String(body.passcode || body.password || '');
    if (!expectedPasscode || !constantTimeEqual(submittedPasscode, expectedPasscode)) {
      const csrfToken = randomToken(16);
      const html = renderConsentHtml({
        origin,
        clientId: check.clientId,
        clientName: check.clientName,
        redirectUri: check.redirectUri,
        scope: check.scope,
        state: check.state,
        codeChallenge: check.codeChallenge,
        codeChallengeMethod: check.codeChallengeMethod,
        resource: check.resource,
        csrfToken,
        members: hubState.members || [],
        errorMsg: 'Invalid household passcode.',
      });
      return new Response(html, {
        status: 401,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          ...corsHeaders,
        },
      });
    }

    // Issue single-use authorization code
    const rawCode = `hp_code_${randomToken(24)}`;
    const codeHash = await sha256Hex(rawCode);
    const now = Date.now();
    const memberId =
      typeof body.member_id === 'string' && body.member_id.trim()
        ? body.member_id.trim()
        : typeof body.memberId === 'string' && body.memberId.trim()
          ? body.memberId.trim()
          : (hubState.members?.[0]?.id || 'member_wife');

    // Track CIMD client in oauthClients list for visibility/revocation in settings
    if (check.isCimd && !authStore.oauthClients.some((c) => c.client_id === check.clientId)) {
      authStore.oauthClients.push({
        client_id: check.clientId,
        client_name: check.clientName,
        redirect_uris: [check.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        isCimd: true,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      });
    }

    authStore.oauthCodes.push({
      codeHash,
      clientId: check.clientId,
      clientName: check.clientName,
      redirectUri: check.redirectUri,
      codeChallenge: check.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: check.scope,
      memberId,
      resource: check.resource || `${origin}/mcp`,
      state: check.state,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + AUTH_CODE_TTL_MS).toISOString(),
      usedAt: null,
      grantId: null,
    });
    await storage.saveAuthStore(authStore);

    const cb = new URL(check.redirectUri);
    cb.searchParams.set('code', rawCode);
    if (check.state) cb.searchParams.set('state', check.state);
    cb.searchParams.set('iss', origin);

    return new Response(null, {
      status: 302,
      headers: {
        Location: cb.toString(),
        'Cache-Control': 'no-store',
        ...corsHeaders,
      },
    });
  }

  // 5. OAuth 2.1 Token Endpoint (POST /oauth/token)
  if (method === 'POST' && pathname === '/oauth/token') {
    const body = await parseFormOrJson(request);
    if (!body) {
      return jsonResponse({ error: 'invalid_request', error_description: 'Malformed token request.' }, { status: 400, corsHeaders });
    }

    const grantType = String(body.grant_type || '').trim();
    const authStore = await storage.getAuthStore();
    const now = Date.now();

    if (grantType === 'authorization_code') {
      const code = String(body.code || '').trim();
      const clientId = String(body.client_id || '').trim();
      const redirectUri = String(body.redirect_uri || '').trim();
      const codeVerifier = String(body.code_verifier || '').trim();
      const resource = String(body.resource || '').trim();

      if (!code || !codeVerifier) {
        return jsonResponse(
          { error: 'invalid_request', error_description: 'code and code_verifier are required.' },
          { status: 400, corsHeaders },
        );
      }

      const codeHash = await sha256Hex(code);
      const record = (authStore.oauthCodes || []).find(
        (c) => c.codeHash && constantTimeEqual(c.codeHash, codeHash),
      );
      if (!record) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'Invalid authorization code.' },
          { status: 400, corsHeaders },
        );
      }

      // Single-use replay defense: if already used, revoke any tokens issued under this grant!
      if (record.usedAt) {
        if (record.grantId) {
          for (const t of authStore.oauthTokens || []) {
            if (t.grantId === record.grantId && !t.revokedAt) {
              t.revokedAt = new Date(now).toISOString();
            }
          }
          await storage.saveAuthStore(authStore);
        }
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'Authorization code has already been used.' },
          { status: 400, corsHeaders },
        );
      }

      if (Date.parse(record.expiresAt) <= now) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'Authorization code has expired.' },
          { status: 400, corsHeaders },
        );
      }
      if (clientId && record.clientId !== clientId) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'client_id mismatch.' },
          { status: 400, corsHeaders },
        );
      }
      if (redirectUri && record.redirectUri !== redirectUri) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' },
          { status: 400, corsHeaders },
        );
      }

      // RFC 8707 resource check (if provided)
      if (resource && record.resource && resource.replace(/\/+$/, '') !== record.resource.replace(/\/+$/, '')) {
        return jsonResponse(
          { error: 'invalid_target', error_description: 'resource parameter does not match authorized resource.' },
          { status: 400, corsHeaders },
        );
      }

      // Verify PKCE S256
      const computedChallenge = await sha256Base64Url(codeVerifier);
      if (!constantTimeEqual(computedChallenge, record.codeChallenge)) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'PKCE S256 code_verifier verification failed.' },
          { status: 400, corsHeaders },
        );
      }

      // Verify client_secret if DCR client requires client_secret_post
      const clientRec = (authStore.oauthClients || []).find((c) => c.client_id === record.clientId);
      if (clientRec?.revokedAt) {
        return jsonResponse({ error: 'invalid_client', error_description: 'Client has been revoked.' }, { status: 401, corsHeaders });
      }
      if (clientRec?.client_secret_hash) {
        const subSecretHash = await sha256Hex(String(body.client_secret || ''));
        if (!constantTimeEqual(subSecretHash, clientRec.client_secret_hash)) {
          return jsonResponse({ error: 'invalid_client', error_description: 'Invalid client_secret.' }, { status: 401, corsHeaders });
        }
      }

      // Mark code used and issue access + refresh tokens
      const grantId = `grant_${randomToken(12)}`;
      const accessToken = `hp_at_${randomToken(32)}`;
      const refreshToken = `hp_rt_${randomToken(32)}`;

      record.usedAt = new Date(now).toISOString();
      record.grantId = grantId;

      authStore.oauthTokens.push({
        id: `tok_${randomToken(10)}`,
        grantId,
        clientId: record.clientId,
        clientName: record.clientName || clientRec?.client_name || record.clientId,
        memberId: record.memberId,
        scope: record.scope,
        resource: record.resource,
        accessHash: await sha256Hex(accessToken),
        refreshHash: await sha256Hex(refreshToken),
        accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
        createdAt: new Date(now).toISOString(),
        rotatedAt: null,
        revokedAt: null,
      });

      await storage.saveAuthStore(authStore);

      return jsonResponse(
        {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
          refresh_token: refreshToken,
          scope: record.scope,
        },
        { status: 200, corsHeaders },
      );
    }

    if (grantType === 'refresh_token') {
      const refreshToken = String(body.refresh_token || '').trim();
      const clientId = String(body.client_id || '').trim();
      if (!refreshToken) {
        return jsonResponse(
          { error: 'invalid_request', error_description: 'refresh_token is required.' },
          { status: 400, corsHeaders },
        );
      }

      const refreshHash = await sha256Hex(refreshToken);
      const record = (authStore.oauthTokens || []).find(
        (t) => t.refreshHash && constantTimeEqual(t.refreshHash, refreshHash),
      );

      if (!record) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'Unknown refresh_token.' },
          { status: 400, corsHeaders },
        );
      }

      // Single-use refresh rotation: reject already-rotated or revoked refresh token with 400 invalid_grant
      if (record.rotatedAt || record.revokedAt) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'Refresh token has already been rotated or revoked.' },
          { status: 400, corsHeaders },
        );
      }

      if (record.refreshExpiresAt && Date.parse(record.refreshExpiresAt) <= now) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'Refresh token expired.' },
          { status: 400, corsHeaders },
        );
      }
      if (clientId && record.clientId !== clientId) {
        return jsonResponse(
          { error: 'invalid_grant', error_description: 'client_id mismatch.' },
          { status: 400, corsHeaders },
        );
      }

      // Rotate: invalidate old access + refresh token record, issue brand new pair
      const nowIso = new Date(now).toISOString();
      record.rotatedAt = nowIso;
      record.revokedAt = nowIso;

      const nextAccess = `hp_at_${randomToken(32)}`;
      const nextRefresh = `hp_rt_${randomToken(32)}`;

      authStore.oauthTokens.push({
        id: `tok_${randomToken(10)}`,
        grantId: record.grantId,
        clientId: record.clientId,
        clientName: record.clientName,
        memberId: record.memberId,
        scope: record.scope,
        resource: record.resource,
        accessHash: await sha256Hex(nextAccess),
        refreshHash: await sha256Hex(nextRefresh),
        accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
        createdAt: nowIso,
        rotatedAt: null,
        revokedAt: null,
      });

      await storage.saveAuthStore(authStore);

      return jsonResponse(
        {
          access_token: nextAccess,
          token_type: 'Bearer',
          expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
          refresh_token: nextRefresh,
          scope: record.scope,
        },
        { status: 200, corsHeaders },
      );
    }

    return jsonResponse(
      { error: 'unsupported_grant_type', error_description: `Unsupported grant_type "${grantType}".` },
      { status: 400, corsHeaders },
    );
  }

  // 6. OAuth 2.1 Revocation Endpoint (POST /oauth/revoke — RFC 7009)
  if (method === 'POST' && pathname === '/oauth/revoke') {
    const body = await parseFormOrJson(request);
    const token = String(body?.token || '').trim();
    if (token) {
      const hash = await sha256Hex(token);
      const authStore = await storage.getAuthStore();
      const nowIso = new Date().toISOString();
      let targetGrantId = null;
      for (const tok of authStore.oauthTokens || []) {
        if (
          (tok.accessHash && constantTimeEqual(tok.accessHash, hash)) ||
          (tok.refreshHash && constantTimeEqual(tok.refreshHash, hash))
        ) {
          targetGrantId = tok.grantId;
          tok.revokedAt = nowIso;
        }
      }
      if (targetGrantId) {
        for (const tok of authStore.oauthTokens || []) {
          if (tok.grantId === targetGrantId && !tok.revokedAt) {
            tok.revokedAt = nowIso;
          }
        }
        await storage.saveAuthStore(authStore);
      }
    }
    return jsonResponse({ ok: true, revoked: true }, { status: 200, corsHeaders });
  }

  return null;
}
