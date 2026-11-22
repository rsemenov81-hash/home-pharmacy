import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  REPO_ROOT,
  getFreePort,
  startE2EServer,
  createApiClient,
  computePkceChallenge,
  generatePkcePair,
  parseAuthorizeForm,
  buildAuthorizeFormBody,
  runOAuthFlow,
  refreshOAuthToken,
  revokeOAuthToken,
  createMcpClient,
  parseToolJson,
  launchBrowser,
  openAuthenticatedPage,
  unwrapData,
  fixtures,
} from './harness.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_E2E_PATH = path.join(THIS_DIR, 'run-e2e.mjs');
const HARNESS_PATH = path.join(THIS_DIR, 'harness.mjs');

// ============================================================================
// Ephemeral Mock Server & Fake E2E Suite Templates (staged in os.tmpdir())
// ============================================================================

const MOCK_SERVER_SOURCE = `
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 0);
const DATA_DIR = process.env.DATA_DIR || '';
const DB_PATH = process.env.DB_PATH || '';
const STORAGE_DIR = process.env.STORAGE_DIR || '';
const ADMIN_TOKEN = process.env.HOUSEHOLD_ADMIN_TOKEN || '';
const PASSCODE = process.env.HOUSEHOLD_PASSCODE || '';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '';

if (DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'state.json'),
    JSON.stringify({ initialized: true, pid: process.pid }),
    'utf8'
  );
}

const CSRF_COOKIE_NAME = 'hp_oauth_csrf';
const CSRF_COOKIE_VALUE = 'csrf_cookie_val_99';
const CSRF_NONCE_PLAIN = 'nonce_abc&123';
const CSRF_NONCE_HTML = 'nonce_abc&amp;123';

const registeredClients = new Map();
const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function parseFormOrJson(raw, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      return { ok: true, data: JSON.parse(raw), format: 'json' };
    } catch {
      return { ok: false, data: null, format: 'json' };
    }
  }
  const params = new URLSearchParams(raw);
  const data = {};
  for (const [k, v] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(data, k)) {
      data[k] = Array.isArray(data[k]) ? [...data[k], v] : [data[k], v];
    } else {
      data[k] = v;
    }
  }
  return { ok: true, data, format: 'form' };
}

function authenticate(req, url) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  let authVia = null;
  if (/^Bearer\\s+/i.test(authHeader)) {
    token = authHeader.replace(/^Bearer\\s+/i, '').trim();
    authVia = 'bearer';
  } else if (url.searchParams.has('token')) {
    token = url.searchParams.get('token') || '';
    authVia = 'query';
  }
  if (!token) return null;
  if (token === ADMIN_TOKEN) {
    return { token, authVia, scope: 'write', memberId: 'member_wife', kind: 'admin' };
  }
  const tokRec = accessTokens.get(token);
  if (tokRec && !tokRec.revoked) {
    return { token, authVia, scope: tokRec.scope, memberId: tokRec.memberId, kind: 'oauth' };
  }
  return null;
}

function escapeHtmlAttr(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function handleSingleMcpRequest(rpc, req, auth) {
  if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || !rpc.method) {
    return {
      jsonrpc: '2.0',
      id: rpc?.id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }
  const { id, method, params = {} } = rpc;
  const sessionId = req.headers['mcp-session-id'] || null;
  const protoVer = req.headers['mcp-protocol-version'] || '2025-06-18';

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || protoVer,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'selftest-mcp', version: '1.0.0' },
      },
      _newSessionId: 'sess_' + crypto.randomBytes(6).toString('hex'),
    };
  }
  if (method === 'notifications/initialized') {
    return { _notificationAccepted: true };
  }
  if (method === 'ping') {
    return {
      jsonrpc: '2.0',
      id,
      result: { pong: true, sessionId, authVia: auth.authVia, protocolVersion: protoVer },
    };
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'echo_tool', description: 'Echo input arguments as JSON' },
          { name: 'sse_tool', description: 'Return JSON-RPC response over SSE' },
          { name: 'sse_multi_tool', description: 'Return multi-id JSON-RPC frames over SSE' },
          { name: 'validation_error_tool', description: 'Return structured isError JSON' },
        ],
      },
    };
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};
    if (toolName === 'echo_tool') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                echoed: args,
                sessionId,
                scope: auth.scope,
                authVia: auth.authVia,
              }),
            },
          ],
        },
      };
    }
    if (toolName === 'sse_tool') {
      return {
        _sseSingle: true,
        id,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ via: 'sse', echoed: args, ok: true }) }],
          },
        },
      };
    }
    if (toolName === 'sse_multi_tool') {
      return {
        _sseMulti: true,
        id,
        frames: [
          {
            jsonrpc: '2.0',
            id: 999,
            result: { content: [{ type: 'text', text: JSON.stringify({ wrong: true, frameId: 999 }) }] },
          },
          {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify({ matchedId: id, ok: true }) }] },
          },
          {
            jsonrpc: '2.0',
            id: 888,
            result: { content: [{ type: 'text', text: JSON.stringify({ wrong: true, frameId: 888 }) }] },
          },
        ],
      };
    }
    if (toolName === 'validation_error_tool') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 422, missingFields: ['summary', 'dosages'] }),
            },
          ],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Unknown tool: ' + toolName },
    };
  }
  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [{ uri: 'hub://overview', name: 'Overview', mimeType: 'application/json' }],
      },
    };
  }
  if (method === 'resources/read') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        contents: [
          {
            uri: params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({ uri: params.uri, sections: 4 }),
          },
        ],
      },
    };
  }
  if (method === 'prompts/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { prompts: [{ name: 'research_compound', description: 'Research compound prompt' }] },
    };
  }
  if (method === 'prompts/get') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        description: 'Prompt for ' + params.name,
        messages: [
          { role: 'user', content: { type: 'text', text: 'Research ' + (params.arguments?.compound || 'BPC-157') } },
        ],
      },
    };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found: ' + method },
  };
}

const server = http.createServer(async (req, res) => {
  const hostHeader = req.headers.host || (HOST + ':' + server.address().port);
  const origin = 'http://' + hostHeader;
  const url = new URL(req.url || '/', origin);
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  // Public health endpoint
  if (method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      version: 'selftest',
      storage: 'memory',
      mode: 'test',
      pid: process.pid,
    });
  }

  // Debug env inspection for lifecycle tests
  if (method === 'GET' && pathname === '/debug-env') {
    return sendJson(res, 200, {
      host: HOST,
      port: PORT,
      dataDir: DATA_DIR,
      dbPath: DB_PATH,
      storageDir: STORAGE_DIR,
      hasAdminToken: Boolean(ADMIN_TOKEN),
      hasPasscode: Boolean(PASSCODE),
      allowedOrigins: ALLOWED_ORIGINS,
    });
  }

  // Minimal Browser UI pages for Playwright launchBrowser + openAuthenticatedPage tests
  if (method === 'GET' && pathname === '/') {
    const qToken = url.searchParams.get('token');
    const triggerError = url.searchParams.get('triggerError') === '1';
    const triggerPageError = url.searchParams.get('triggerPageError') === '1';
    if (qToken && qToken === ADMIN_TOKEN) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Home Pharmacy Selftest</title></head><body>' +
          '<nav data-testid="nav-sections">Sections Direct Auth</nav>' +
          (triggerError ? '<script>console.error("E2E_SELFTEST_CONSOLE_ERR");</script>' : '') +
          (triggerPageError
            ? '<script>setTimeout(() => { throw new Error("E2E_SELFTEST_PAGE_ERR"); }, 10);</script>'
            : '') +
          '</body></html>'
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Home Pharmacy Login</title></head><body>' +
        '<main id="app">' +
        '<form id="login-form">' +
        '<label for="passcode">Passcode</label>' +
        '<input id="passcode" type="password" name="passcode" />' +
        '<button type="submit">Unlock</button>' +
        '</form>' +
        '</main>' +
        '<script>' +
        'document.getElementById("login-form").addEventListener("submit", async (e) => {' +
        '  e.preventDefault();' +
        '  const v = document.getElementById("passcode").value;' +
        '  const r = await fetch("/api/v1/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: v }) });' +
        '  if (r.ok) { const nav = document.createElement("nav"); nav.setAttribute("data-testid", "nav-sections"); nav.textContent = "Sections Form Auth"; document.getElementById("app").replaceChildren(nav); }' +
        '});' +
        '</script>' +
        '</body></html>'
    );
    return;
  }

  // Masked <input type="password" name="token"> and combined name="token_pass" UI regression fixtures
  if (
    method === 'GET' &&
    (pathname === '/masked-token-ui' ||
      pathname === '/masked-token-ui/' ||
      pathname === '/masked-token-pass-ui' ||
      pathname === '/masked-token-pass-ui/')
  ) {
    const isCombined = pathname.startsWith('/masked-token-pass-ui');
    const nameAttr = isCombined ? 'token_pass' : 'token';
    const testIdAttr = isCombined ? 'token-pass-input' : 'token-input';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Masked Token Login</title></head><body>' +
        '<main id="app">' +
        '<form id="masked-form">' +
        '<input id="tok" type="password" name="' + nameAttr + '" data-testid="' + testIdAttr + '" placeholder="API Token" />' +
        '<button type="submit">Unlock</button>' +
        '</form>' +
        '</main>' +
        '<script>' +
        'document.getElementById("masked-form").addEventListener("submit", async (e) => {' +
        '  e.preventDefault();' +
        '  const v = document.getElementById("tok").value;' +
        '  const r = await fetch("/api/v1/login-token-only", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: v }) });' +
        '  if (r.ok) { const nav = document.createElement("nav"); nav.setAttribute("data-testid", "nav-sections"); nav.textContent = "Sections Masked Token Auth"; document.getElementById("app").replaceChildren(nav); }' +
        '});' +
        '</script>' +
        '</body></html>'
    );
    return;
  }

  // Combined credential password input matching both token and passcode selectors (for { passcode }-only regression)
  if (method === 'GET' && (pathname === '/combined-cred-ui' || pathname === '/combined-cred-ui/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Combined Credential Login</title></head><body>' +
        '<main id="app">' +
        '<form id="combined-form">' +
        '<input id="cred" type="password" name="credential" placeholder="Enter household passcode or API token" />' +
        '<button type="submit">Unlock</button>' +
        '</form>' +
        '</main>' +
        '<script>' +
        'document.getElementById("combined-form").addEventListener("submit", async (e) => {' +
        '  e.preventDefault();' +
        '  const v = document.getElementById("cred").value;' +
        '  const r = await fetch("/api/v1/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: v, token: v }) });' +
        '  if (r.ok) { const nav = document.createElement("nav"); nav.setAttribute("data-testid", "nav-sections"); nav.textContent = "Sections Combined Cred Auth"; document.getElementById("app").replaceChildren(nav); }' +
        '});' +
        '</script>' +
        '</body></html>'
    );
    return;
  }

  // Dual password fields (token + passcode) UI regression fixture
  if (method === 'GET' && (pathname === '/dual-pass-ui' || pathname === '/dual-pass-ui/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Dual Password Login</title></head><body>' +
        '<main id="app">' +
        '<form id="dual-form">' +
        '<input id="tok" type="password" name="token" />' +
        '<input id="pass" type="password" name="passcode" />' +
        '<button type="submit">Unlock</button>' +
        '</form>' +
        '</main>' +
        '<script>' +
        'document.getElementById("dual-form").addEventListener("submit", async (e) => {' +
        '  e.preventDefault();' +
        '  const t = document.getElementById("tok").value;' +
        '  const p = document.getElementById("pass").value;' +
        '  const r = await fetch("/api/v1/login-dual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t, passcode: p }) });' +
        '  if (r.ok) { const nav = document.createElement("nav"); nav.setAttribute("data-testid", "nav-sections"); nav.textContent = "Sections Dual Pass Auth"; document.getElementById("app").replaceChildren(nav); }' +
        '});' +
        '</script>' +
        '</body></html>'
    );
    return;
  }

  // Always-locked page for standalone openAuthenticatedPage failure cleanup regression
  if (method === 'GET' && (pathname === '/always-locked-ui' || pathname === '/always-locked-ui/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><body><form onsubmit="return false"><input type="password" name="passcode" /><button type="submit">Unlock</button></form></body></html>'
    );
    return;
  }

  if (method === 'POST' && pathname === '/api/v1/login') {
    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}
    if (parsed.passcode === PASSCODE || parsed.token === ADMIN_TOKEN) {
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: 'invalid_credentials' });
  }

  if (method === 'POST' && pathname === '/api/v1/login-token-only') {
    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}
    if (parsed.token === ADMIN_TOKEN) {
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: 'wrong_token' });
  }

  if (method === 'POST' && pathname === '/api/v1/login-dual') {
    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}
    if (parsed.token === ADMIN_TOKEN && parsed.passcode === PASSCODE) {
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: 'wrong_dual_creds' });
  }

  // OAuth 2.1 Discovery (RFC 9728 + RFC 8414)
  if (
    method === 'GET' &&
    (pathname === '/.well-known/oauth-protected-resource' ||
      pathname === '/.well-known/oauth-protected-resource/mcp')
  ) {
    return sendJson(res, 200, {
      resource: origin + '/mcp',
      authorization_servers: [origin],
      scopes_supported: ['read', 'propose', 'write'],
      bearer_methods_supported: ['header'],
    });
  }

  if (method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
    return sendJson(res, 200, {
      issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register',
      revocation_endpoint: origin + '/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      scopes_supported: ['read', 'propose', 'write'],
    });
  }

  // RFC 7591 Dynamic Client Registration
  if (method === 'POST' && pathname === '/oauth/register') {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid_client_metadata' }); }
    const clientId = 'dcr_' + crypto.randomBytes(8).toString('hex');
    const record = {
      client_id: clientId,
      client_name: body.client_name || 'unnamed',
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
      scope: body.scope || 'read',
    };
    registeredClients.set(clientId, record);
    return sendJson(res, 201, record);
  }

  // OAuth Authorize GET (Consent Screen HTML + CSRF Cookie + Entity-Encoded Nonce)
  if (method === 'GET' && pathname === '/oauth/authorize') {
    const clientId = url.searchParams.get('client_id') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';
    const state = url.searchParams.get('state') || '';
    const resource = url.searchParams.get('resource') || '';
    const isCimd = /^https:\\/\\//i.test(clientId);

    if (!registeredClients.has(clientId) && !isCimd) {
      return sendJson(res, 400, { error: 'invalid_client' });
    }
    if (!redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      return sendJson(res, 400, { error: 'invalid_request' });
    }

    const html = [
      '<!doctype html><html><body>',
      '<form action="/oauth/authorize" method="POST">',
      '<input type="hidden" name="client_id" value="' + escapeHtmlAttr(clientId) + '" />',
      '<input type="hidden" name="redirect_uri" value="' + escapeHtmlAttr(redirectUri) + '" />',
      '<input type="hidden" name="code_challenge" value="' + escapeHtmlAttr(codeChallenge) + '" />',
      '<input type="hidden" name="code_challenge_method" value="' + escapeHtmlAttr(codeChallengeMethod) + '" />',
      '<input type="hidden" name="state" value="' + escapeHtmlAttr(state) + '" />',
      '<input type="hidden" name="resource" value="' + escapeHtmlAttr(resource) + '" />',
      '<input type="hidden" name="csrf_nonce" value="' + CSRF_NONCE_HTML + '" />',
      '<label for="passcode">Household Passcode</label>',
      '<input id="passcode" type="password" name="passcode" required />',
      '<select name="member_id">',
      '  <option value="member_wife" selected>Wife</option>',
      '  <option value="member_husband">Husband</option>',
      '</select>',
      '<input type="checkbox" name="scope" value="read" checked />',
      '<input type="checkbox" name="scope" value="propose" />',
      '<input type="checkbox" name="scope" value="write" />',
      '<input type="checkbox" name="consent" value="yes" />',
      '<button type="submit" name="decision" value="approve">Approve</button>',
      '<button type="submit" name="decision" value="deny">Deny</button>',
      '</form>',
      '</body></html>',
    ].join('\\n');

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': CSRF_COOKIE_NAME + '=' + CSRF_COOKIE_VALUE + '; HttpOnly; SameSite=Lax; Path=/oauth',
    });
    res.end(html);
    return;
  }

  // OAuth Authorize POST
  if (method === 'POST' && pathname === '/oauth/authorize') {
    const cookies = parseCookies(req.headers['cookie']);
    if (cookies[CSRF_COOKIE_NAME] !== CSRF_COOKIE_VALUE) {
      return sendJson(res, 403, { error: 'invalid_csrf_cookie' });
    }
    const raw = await readBody(req);
    const parsed = parseFormOrJson(raw, req.headers['content-type']);
    const body = parsed.data || {};
    if (body.csrf_nonce !== CSRF_NONCE_PLAIN) {
      return sendJson(res, 403, { error: 'invalid_csrf_nonce' });
    }
    const redirectUri = String(body.redirect_uri || '');
    const state = String(body.state || '');

    if (body.decision === 'deny') {
      const target = new URL(redirectUri);
      target.searchParams.set('error', 'access_denied');
      if (state) target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (body.consent !== 'yes' || body.decision !== 'approve') {
      return sendJson(res, 400, { error: 'consent_required' });
    }

    if (body.passcode !== PASSCODE) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<html><body><p>Invalid household passcode</p></body></html>');
      return;
    }

    const scopeVal = Array.isArray(body.scope) ? body.scope.join(' ') : String(body.scope || 'read');
    const code = 'code_' + crypto.randomBytes(12).toString('hex');
    authCodes.set(code, {
      used: false,
      clientId: String(body.client_id || ''),
      redirectUri,
      codeChallenge: String(body.code_challenge || ''),
      scope: scopeVal,
      memberId: String(body.member_id || 'member_wife'),
      resource: String(body.resource || ''),
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    target.searchParams.set('iss', origin);
    res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
    res.end();
    return;
  }

  // OAuth Token Exchange & Refresh Rotation (Form + JSON)
  if (method === 'POST' && pathname === '/oauth/token') {
    const raw = await readBody(req);
    const parsed = parseFormOrJson(raw, req.headers['content-type']);
    if (!parsed.ok || !parsed.data) {
      return sendJson(res, 400, { error: 'invalid_request' });
    }
    const body = parsed.data;
    if (body.grant_type === 'authorization_code') {
      const rec = authCodes.get(String(body.code || ''));
      if (!rec || rec.used) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }
      rec.used = true;
      if (body.client_id !== rec.clientId || body.redirect_uri !== rec.redirectUri) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }
      const verifier = String(body.code_verifier || '');
      const computed = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
      if (computed !== rec.codeChallenge) {
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE S256 mismatch' });
      }
      const at = 'at_' + crypto.randomBytes(16).toString('hex');
      const rt = 'rt_' + crypto.randomBytes(16).toString('hex');
      accessTokens.set(at, {
        revoked: false,
        scope: rec.scope,
        memberId: rec.memberId,
        clientId: rec.clientId,
      });
      refreshTokens.set(rt, {
        active: true,
        scope: rec.scope,
        memberId: rec.memberId,
        clientId: rec.clientId,
        accessToken: at,
      });
      return sendJson(res, 200, {
        access_token: at,
        refresh_token: rt,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: rec.scope,
      });
    }

    if (body.grant_type === 'refresh_token') {
      const rtRec = refreshTokens.get(String(body.refresh_token || ''));
      if (!rtRec || !rtRec.active) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }
      rtRec.active = false;
      const newAt = 'at_' + crypto.randomBytes(16).toString('hex');
      const newRt = 'rt_' + crypto.randomBytes(16).toString('hex');
      accessTokens.set(newAt, {
        revoked: false,
        scope: rtRec.scope,
        memberId: rtRec.memberId,
        clientId: rtRec.clientId,
      });
      refreshTokens.set(newRt, {
        active: true,
        scope: rtRec.scope,
        memberId: rtRec.memberId,
        clientId: rtRec.clientId,
        accessToken: newAt,
      });
      return sendJson(res, 200, {
        access_token: newAt,
        refresh_token: newRt,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: rtRec.scope,
      });
    }

    return sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  // OAuth Revoke (Form + JSON)
  if (method === 'POST' && pathname === '/oauth/revoke') {
    const raw = await readBody(req);
    const parsed = parseFormOrJson(raw, req.headers['content-type']);
    const tok = String(parsed.data?.token || '');
    if (accessTokens.has(tok)) {
      accessTokens.get(tok).revoked = true;
    }
    if (refreshTokens.has(tok)) {
      const r = refreshTokens.get(tok);
      r.active = false;
      if (accessTokens.has(r.accessToken)) accessTokens.get(r.accessToken).revoked = true;
    }
    return sendJson(res, 200, { ok: true, revoked: true });
  }

  // OAuth Edge-Case Mock Routes (/oauth-edge/<mode>/...)
  const edgeMatch = pathname.match(/^\\/oauth-edge\\/(token500|auth200|dcr201|getform|bad-discovery|consent-bool|bad-action-post|bad-action-get)(\\/.*)$/);
  if (edgeMatch) {
    const mode = edgeMatch[1];
    const subPath = edgeMatch[2];
    const edgeBase = origin + '/oauth-edge/' + mode;

    if (method === 'GET' && subPath.startsWith('/.well-known/oauth-protected-resource')) {
      return sendJson(res, 200, { resource: edgeBase + '/mcp', authorization_servers: [edgeBase] });
    }
    if (method === 'GET' && subPath === '/.well-known/oauth-authorization-server') {
      return sendJson(res, 200, {
        issuer: edgeBase,
        authorization_endpoint: mode === 'bad-discovery' ? 'http://[::1' : edgeBase + '/oauth/authorize',
        token_endpoint: edgeBase + '/oauth/token',
        registration_endpoint: edgeBase + '/oauth/register',
      });
    }
    if (method === 'POST' && subPath === '/oauth/register') {
      if (mode === 'dcr201') {
        res.writeHead(201, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('plain text created without json');
        return;
      }
      return sendJson(res, 201, { client_id: 'edge_' + mode + '_cid' });
    }
    if (method === 'GET' && subPath === '/oauth/authorize') {
      if (mode === 'bad-discovery') {
        return sendJson(res, 404, { error: 'fallback_not_configured' });
      }
      if (mode === 'getform' && url.searchParams.has('passcode')) {
        // Verify GET form submission did NOT duplicate client_id or state
        const cids = url.searchParams.getAll('client_id');
        const states = url.searchParams.getAll('state');
        if (cids.length !== 1 || states.length !== 1) {
          return sendJson(res, 400, { error: 'duplicate_get_params', cids, states });
        }
        const target = new URL(url.searchParams.get('redirect_uri') || 'http://127.0.0.1:19999/oauth/callback');
        target.searchParams.set('code', 'edge_get_code');
        target.searchParams.set('state', states[0]);
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      const cid = escapeHtmlAttr(url.searchParams.get('client_id') || '');
      const ruri = escapeHtmlAttr(url.searchParams.get('redirect_uri') || '');
      const st = escapeHtmlAttr(url.searchParams.get('state') || '');
      if (mode === 'bad-action-post' || mode === 'bad-action-get') {
        const badMethod = mode === 'bad-action-get' ? 'GET' : 'POST';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><form action="http://[::1" method="' + badMethod + '">' +
            '<input type="hidden" name="client_id" value="' + cid + '" />' +
            '<input type="password" name="passcode" />' +
            '<button type="submit" name="decision" value="approve">Approve</button>' +
          '</form></body></html>'
        );
        return;
      }
      if (mode === 'consent-bool') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><form action="' + edgeBase + '/oauth/authorize" method="POST">' +
            '<input type="hidden" name="client_id" value="' + cid + '" />' +
            '<input type="hidden" name="redirect_uri" value="' + ruri + '" />' +
            '<input type="hidden" name="state" value="' + st + '" />' +
            '<input type="password" name="passcode" />' +
            '<button type="submit" name="consent" value="1">Approve</button>' +
            '<button type="submit" name="consent" value="0">Deny</button>' +
          '</form></body></html>'
        );
        return;
      }
      const methodAttr = mode === 'getform' ? 'method="GET"' : 'action="' + edgeBase + '/oauth/authorize" method="POST"';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><form ' + methodAttr + '>' +
          '<input type="hidden" name="client_id" value="' + cid + '" />' +
          '<input type="hidden" name="redirect_uri" value="' + ruri + '" />' +
          '<input type="hidden" name="state" value="' + st + '" />' +
          '<input type="password" name="passcode" />' +
          '<button type="submit" name="decision" value="approve">Approve</button>' +
        '</form></body></html>'
      );
      return;
    }
    if (method === 'POST' && subPath === '/oauth/authorize') {
      const raw = await readBody(req);
      const parsed = parseFormOrJson(raw, req.headers['content-type']);
      const body = parsed.data || {};
      if (mode === 'auth200') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><p>Wrong passcode, try again</p></body></html>');
        return;
      }
      if (mode === 'consent-bool') {
        const target = new URL(String(body.redirect_uri || 'http://127.0.0.1:19999/oauth/callback'));
        if (body.consent === '0') {
          target.searchParams.set('error', 'access_denied');
          if (body.state) target.searchParams.set('state', String(body.state));
          res.writeHead(302, { location: target.toString() });
          res.end();
          return;
        }
        if (body.consent !== '1') {
          return sendJson(res, 400, { error: 'invalid_consent_value', received: body.consent });
        }
        target.searchParams.set('code', 'edge_code_' + mode);
        if (body.state) target.searchParams.set('state', String(body.state));
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      const target = new URL(String(body.redirect_uri || 'http://127.0.0.1:19999/oauth/callback'));
      target.searchParams.set('code', 'edge_code_' + mode);
      if (body.state) target.searchParams.set('state', String(body.state));
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    if (method === 'POST' && subPath === '/oauth/token') {
      if (mode === 'token500') {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Internal Token Server Error');
        return;
      }
      return sendJson(res, 200, {
        access_token: 'edge_at_' + mode,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read',
      });
    }
    return sendJson(res, 404, { error: 'edge_not_found', path: pathname });
  }

  // REST Echo & Non-JSON Endpoints (supports both root and /hub subpath)
  if (pathname === '/api/v1/echo' || pathname === '/hub/api/v1/echo') {
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'vary': 'Origin',
      });
      res.end();
      return;
    }
    const auth = authenticate(req, url);
    if (!auth) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    const raw = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
    let bodyVal = raw;
    if (raw && String(req.headers['content-type'] || '').includes('application/json')) {
      try { bodyVal = JSON.parse(raw); } catch {}
    }
    if (method === 'HEAD') {
      res.writeHead(200, { 'x-head-ok': '1', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const queryObj = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (Object.prototype.hasOwnProperty.call(queryObj, k)) {
        queryObj[k] = Array.isArray(queryObj[k]) ? [...queryObj[k], v] : [queryObj[k], v];
      } else {
        queryObj[k] = v;
      }
    }
    return sendJson(res, 200, {
      ok: true,
      data: {
        method,
        path: pathname,
        query: queryObj,
        authVia: auth.authVia,
        scope: auth.scope,
        memberId: auth.memberId,
        customHeader: req.headers['x-e2e-test'] || null,
        removedHeader: req.headers['x-default-drop'] || null,
        contentType: req.headers['content-type'] || null,
        body: bodyVal,
      },
    });
  }

  if (method === 'GET' && pathname === '/api/v1/plain') {
    const auth = authenticate(req, url);
    if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('plain-text-response-ok');
    return;
  }

  if (method === 'GET' && pathname === '/api/v1/csv') {
    const auth = authenticate(req, url);
    if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
    res.end('name,section\\nBPC-157,peptides\\n');
    return;
  }

  if (method === 'DELETE' && pathname === '/api/v1/nocontent') {
    const auth = authenticate(req, url);
    if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  // Streamable HTTP MCP Endpoint (POST /mcp)
  if (method === 'POST' && pathname === '/mcp') {
    const auth = authenticate(req, url);
    if (!auth) {
      return sendJson(
        res,
        401,
        { error: 'unauthorized' },
        {
          'www-authenticate': 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource"',
        }
      );
    }

    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Empty batch not allowed' },
        });
      }
      const wantsSseBatch = parsed.some((item) => item?.params?.name === 'sse_tool');
      const outputs = parsed.map((item) => {
        const out = handleSingleMcpRequest(item, req, auth);
        if (out._sseSingle) return out.payload;
        if (out._notificationAccepted) return null;
        return out;
      }).filter(Boolean);

      if (wantsSseBatch) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        res.write(': batch stream start\\n\\n');
        for (const frame of outputs) {
          res.write('event: message\\ndata: ' + JSON.stringify(frame) + '\\n\\n');
        }
        res.end();
        return;
      }
      return sendJson(res, 200, outputs);
    }

    const out = handleSingleMcpRequest(parsed, req, auth);
    if (out._notificationAccepted) {
      res.writeHead(202, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (out._sseSingle) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.write(': keepalive comment\\n\\n');
      res.write(
        'event: message\\ndata: ' +
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 50 } }) +
          '\\n\\n'
      );
      res.write('event: message\\ndata: ' + JSON.stringify(out.payload) + '\\n\\n');
      res.end();
      return;
    }
    if (out._sseMulti) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      for (const frame of out.frames) {
        res.write('event: message\\ndata: ' + JSON.stringify(frame) + '\\n\\n');
      }
      res.end();
      return;
    }
    const extraHeaders = {};
    if (out._newSessionId) {
      extraHeaders['mcp-session-id'] = out._newSessionId;
      delete out._newSessionId;
    }
    return sendJson(res, 200, out, extraHeaders);
  }

  return sendJson(res, 404, { error: 'not_found', path: pathname });
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log('MOCK_SERVER_READY port=' + addr.port);
});
`;

const CRASH_SERVER_SOURCE = `
console.error('CRASH_DATA_DIR=' + (process.env.DATA_DIR || ''));
console.error('SELFTEST_BOOT_BOOM: simulated startup crash');
process.exit(42);
`;

const STUBBORN_SERVER_SOURCE = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 0);
const DATA_DIR = process.env.DATA_DIR || '';
if (DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'stubborn.txt'), 'alive', 'utf8');
}

// Intentionally trap and ignore SIGTERM to test SIGKILL escalation
process.on('SIGTERM', () => {
  console.log('IGNORED_SIGTERM');
});

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(PORT, HOST, () => {
  console.log('STUBBORN_SERVER_READY');
});
`;

function canConnectTcp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// ============================================================================
// Harness & Runner Self-Test Suite (20 Real Tests)
// ============================================================================

describe('E2E Harness & Runner Self-Test Suite', () => {
  let tmpRoot;
  let mockServerScript;
  let crashServerScript;
  let stubbornServerScript;
  let fakeE2eRoot;
  let emptyE2eRoot;
  let sharedServer;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-selftest-'));
    mockServerScript = path.join(tmpRoot, 'mock-server.mjs');
    crashServerScript = path.join(tmpRoot, 'crash-server.mjs');
    stubbornServerScript = path.join(tmpRoot, 'stubborn-server.mjs');

    fs.writeFileSync(mockServerScript, MOCK_SERVER_SOURCE, 'utf8');
    fs.writeFileSync(crashServerScript, CRASH_SERVER_SOURCE, 'utf8');
    fs.writeFileSync(stubbornServerScript, STUBBORN_SERVER_SOURCE, 'utf8');

    // Stage isolated fake-e2e directory for run-e2e.mjs CLI verification
    fakeE2eRoot = path.join(tmpRoot, 'fake-e2e');
    for (const dir of ['tier1', 'tier2', 'tier3', 'tier4']) {
      fs.mkdirSync(path.join(fakeE2eRoot, dir), { recursive: true });
    }

    fs.writeFileSync(
      path.join(fakeE2eRoot, 'tier1', 'alpha.e2e.test.mjs'),
      `import test from 'node:test';
import assert from 'node:assert/strict';
test('alpha verifies env propagation and spoof immunity', () => {
  console.log('pass 999');
  console.log('tests 999');
  assert.ok(process.env.PLAYWRIGHT_BROWSERS_PATH, 'PLAYWRIGHT_BROWSERS_PATH must be set');
  if (process.env.EXPECT_BASE_URL) {
    assert.equal(process.env.E2E_BASE_URL, process.env.EXPECT_BASE_URL);
  }
});
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(fakeE2eRoot, 'tier1', 'beta.e2e.test.mjs'),
      `import test from 'node:test';
import assert from 'node:assert/strict';
// COMMENT_ONLY_TRAP appears solely in this comment to exercise Node 22 1..0 synthetic-pass trap
test('UNIQUE_BETA_TITLE passes cleanly', () => {
  assert.equal(2 + 2, 4);
});
test('beta second passing test', () => {
  assert.equal('ok'.toUpperCase(), 'OK');
});
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(fakeE2eRoot, 'tier2', 'fail-and-cancel.e2e.test.mjs'),
      `import { describe, before, it } from 'node:test';
import assert from 'node:assert/strict';
it('deliberate failing assertion with console spoof', () => {
  console.log('pass 999');
  assert.equal(1, 2);
});
describe('hook failure triggers cancelled test', () => {
  before(() => {
    throw new Error('simulated before hook boom');
  });
  it('cancelled child test', () => {
    assert.equal(1, 1);
  });
});
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(fakeE2eRoot, 'tier3', 'cross.e2e.test.mjs'),
      `import test from 'node:test';
import assert from 'node:assert/strict';
test('tier3 cross check', () => { assert.equal(10, 10); });
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(fakeE2eRoot, 'tier4', 'scenario.e2e.test.mjs'),
      `import test from 'node:test';
import assert from 'node:assert/strict';
test('tier4 scenario check', () => { assert.equal(true, true); });
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(fakeE2eRoot, 'harness-selftest.mjs'),
      `import test from 'node:test';
import assert from 'node:assert/strict';
test('isolated fake selftest passes without recursion', () => {
  assert.equal(process.env.E2E_SELFTEST_ACTIVE, '1');
});
`,
      'utf8'
    );

    emptyE2eRoot = path.join(tmpRoot, 'empty-e2e');
    fs.mkdirSync(path.join(emptyE2eRoot, 'tier3'), { recursive: true });

    sharedServer = await startE2EServer({
      serverScript: mockServerScript,
      ignoreExternalEnv: true,
    });
  });

  after(async () => {
    if (sharedServer) {
      await sharedServer.stop();
    }
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 01. getFreePort()
  // --------------------------------------------------------------------------
  it('01. getFreePort() allocates distinct valid unbound TCP ports on 127.0.0.1', async () => {
    const port1 = await getFreePort();
    assert.ok(Number.isInteger(port1) && port1 >= 1024 && port1 <= 65535);

    // Hold port1 live to prove getFreePort() finds a genuinely distinct free port
    const holder = net.createServer();
    await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port1, '127.0.0.1', resolve);
    });
    try {
      const port2 = await getFreePort();
      assert.ok(Number.isInteger(port2) && port2 >= 1024 && port2 <= 65535);
      assert.notEqual(port1, port2);

      // Verify port2's probe socket was closed and is immediately bindable
      const probe = net.createServer();
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port2, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  // --------------------------------------------------------------------------
  // 02. startE2EServer() managed lifecycle
  // --------------------------------------------------------------------------
  it('02. startE2EServer() boots managed server, isolates env/dataDir, captures logs, exposes api()/mcp(), and idempotent stop() cleans up', async () => {
    const server = await startE2EServer({
      serverScript: mockServerScript,
      ignoreExternalEnv: true,
    });
    const savedDataDir = server.dataDir;
    const savedPort = server.port;

    try {
      assert.equal(server.external, false);
      assert.equal(server.baseUrl, `http://127.0.0.1:${savedPort}`);
      assert.equal(server.origin, server.baseUrl);
      assert.ok(server.adminToken.length >= 32);
      assert.ok(server.passcode.startsWith('e2e-pass-'));
      assert.ok(savedDataDir && fs.existsSync(path.join(savedDataDir, 'state.json')));
      assert.match(server.logs.stdout, /MOCK_SERVER_READY/);

      // Check isolated environment propagation
      const envRes = await server.api('/debug-env', { auth: false });
      assert.equal(envRes.status, 200);
      assert.equal(envRes.json.host, '127.0.0.1');
      assert.equal(envRes.json.port, savedPort);
      assert.equal(envRes.json.dataDir, savedDataDir);
      assert.equal(envRes.json.dbPath, path.join(savedDataDir, 'home-pharmacy.sqlite'));
      assert.equal(envRes.json.storageDir, savedDataDir);
      assert.equal(envRes.json.hasAdminToken, true);
      assert.equal(envRes.json.hasPasscode, true);
      assert.match(envRes.json.allowedOrigins, /rsemenov81-hash\.github\.io/);

      // Check server.api() authenticated + unauthenticated
      const echoRes = await server.api('/api/v1/echo');
      assert.equal(echoRes.status, 200);
      assert.equal(echoRes.ok, true);
      assert.equal(echoRes.json.data.authVia, 'bearer');

      const unauthRes = await server.api('/api/v1/echo', { auth: false });
      assert.equal(unauthRes.status, 401);

      // Check server.mcp() returns both json and body identically
      const mcpRes = await server.mcp({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} });
      assert.equal(mcpRes.status, 200);
      assert.equal(mcpRes.ok, true);
      assert.equal(mcpRes.result.pong, true);
      assert.strictEqual(mcpRes.json, mcpRes.body);
    } finally {
      await server.stop();
      // Idempotent second stop() must resolve cleanly
      await server.stop();
    }

    assert.equal(fs.existsSync(savedDataDir), false, 'dataDir must be deleted after stop()');
    const stillListening = await canConnectTcp(savedPort);
    assert.equal(stillListening, false, 'port must refuse connections after stop()');
  });

  // --------------------------------------------------------------------------
  // 03. startE2EServer() fast-fail on missing script or crash
  // --------------------------------------------------------------------------
  it('03. startE2EServer() fails fast on missing script or startup crash and cleans up dataDir', async () => {
    await assert.rejects(
      () =>
        startE2EServer({
          serverScript: path.join(tmpRoot, 'nonexistent-server.mjs'),
          ignoreExternalEnv: true,
        }),
      /E2E server script not found/
    );

    const startedAt = Date.now();
    let caught = null;
    try {
      await startE2EServer({
        serverScript: crashServerScript,
        healthTimeoutMs: 15_000,
        ignoreExternalEnv: true,
      });
    } catch (err) {
      caught = err;
    }
    const elapsedMs = Date.now() - startedAt;

    assert.ok(caught, 'Expected crash-server startup to reject');
    assert.ok(elapsedMs < 3500, `Expected fast fail (<3500ms), took ${elapsedMs}ms`);
    assert.match(caught.message, /SELFTEST_BOOT_BOOM/);
    assert.match(caught.message, /code=42/);

    const dirMatch = caught.message.match(/CRASH_DATA_DIR=([^\s\r\n]+)/);
    assert.ok(dirMatch && dirMatch[1], 'Expected CRASH_DATA_DIR in captured stderr');
    assert.equal(
      fs.existsSync(dirMatch[1]),
      false,
      'Temporary dataDir must be cleaned up when startup crashes'
    );

    // Regression H1: synchronous spawn() throw (invalid cwd type) must clean up newly created dataDir
    const beforeDirs = new Set(
      fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('home-pharmacy-e2e-'))
    );
    await assert.rejects(
      () =>
        startE2EServer({
          serverScript: mockServerScript,
          cwd: 12345,
          ignoreExternalEnv: true,
        }),
      /ERR_INVALID_ARG_TYPE|string|Buffer|URL/i
    );
    const afterDirs = fs
      .readdirSync(os.tmpdir())
      .filter((d) => d.startsWith('home-pharmacy-e2e-') && !beforeDirs.has(d));
    assert.deepEqual(afterDirs, [], 'Synchronous spawn() throw must not leak dataDir');
  });

  // --------------------------------------------------------------------------
  // 04. startE2EServer() SIGTERM -> SIGKILL escalation
  // --------------------------------------------------------------------------
  it('04. startE2EServer() escalates SIGTERM to SIGKILL on stubborn child and removes dataDir', async () => {
    const server = await startE2EServer({
      serverScript: stubbornServerScript,
      sigkillTimeoutMs: 350,
      ignoreExternalEnv: true,
    });
    const savedDir = server.dataDir;
    assert.ok(fs.existsSync(path.join(savedDir, 'stubborn.txt')));

    const stopStart = Date.now();
    await server.stop();
    const stopElapsed = Date.now() - stopStart;

    assert.equal(server.proc.signalCode, 'SIGKILL', 'Stubborn process must be killed by SIGKILL');
    assert.ok(stopElapsed >= 250 && stopElapsed < 3500, `Unexpected escalation time: ${stopElapsed}ms`);
    assert.equal(fs.existsSync(savedDir), false, 'dataDir must be removed after SIGKILL');
  });

  // --------------------------------------------------------------------------
  // 05. startE2EServer() external override (options.baseUrl & E2E_BASE_URL)
  // --------------------------------------------------------------------------
  it('05. startE2EServer() honors options.baseUrl and E2E_BASE_URL non-destructively', async () => {
    const extDirect = await startE2EServer({
      baseUrl: sharedServer.baseUrl,
      adminToken: sharedServer.adminToken,
      passcode: sharedServer.passcode,
    });
    assert.equal(extDirect.external, true);
    assert.equal(extDirect.proc, null);
    assert.equal(extDirect.dataDir, null);
    const r1 = await extDirect.api('/api/v1/echo');
    assert.equal(r1.status, 200);
    await extDirect.stop();

    // Test via environment variables (restored in finally)
    const prevBase = process.env.E2E_BASE_URL;
    const prevTok = process.env.E2E_ADMIN_TOKEN;
    const prevPass = process.env.E2E_PASSCODE;
    process.env.E2E_BASE_URL = `${sharedServer.baseUrl}/`;
    process.env.E2E_ADMIN_TOKEN = sharedServer.adminToken;
    process.env.E2E_PASSCODE = sharedServer.passcode;
    try {
      const extEnv = await startE2EServer();
      assert.equal(extEnv.external, true);
      assert.equal(extEnv.baseUrl, sharedServer.baseUrl);
      assert.equal(extEnv.proc, null);
      assert.equal(extEnv.dataDir, null);
      const r2 = await extEnv.api('/api/v1/echo');
      assert.equal(r2.status, 200);
      await extEnv.stop();
    } finally {
      if (prevBase === undefined) delete process.env.E2E_BASE_URL;
      else process.env.E2E_BASE_URL = prevBase;
      if (prevTok === undefined) delete process.env.E2E_ADMIN_TOKEN;
      else process.env.E2E_ADMIN_TOKEN = prevTok;
      if (prevPass === undefined) delete process.env.E2E_PASSCODE;
      else process.env.E2E_PASSCODE = prevPass;
    }

    // Confirm underlying sharedServer and its dataDir were NEVER harmed
    const health = await sharedServer.api('/health', { auth: false });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(fs.existsSync(sharedServer.dataDir), true);
  });

  // --------------------------------------------------------------------------
  // 06. Listener leak prevention
  // --------------------------------------------------------------------------
  it('06. startE2EServer() prevents SIGTERM/SIGINT/exit listener leaks across repeated lifecycles', async () => {
    const beforeExit = process.listenerCount('exit');
    const beforeSigterm = process.listenerCount('SIGTERM');
    const beforeSigint = process.listenerCount('SIGINT');

    for (let i = 0; i < 6; i++) {
      const s = await startE2EServer({
        serverScript: mockServerScript,
        ignoreExternalEnv: true,
      });
      await s.stop();
    }

    assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
    assert.equal(process.listenerCount('SIGINT'), beforeSigint);
    assert.ok(process.listenerCount('exit') <= beforeExit + 1);
  });

  // --------------------------------------------------------------------------
  // 07. createApiClient()
  // --------------------------------------------------------------------------
  it('07. createApiClient() handles all verbs, URL/query resolution, Bearer vs ?token=, headers, 401 & non-JSON safety', async () => {
    const api = createApiClient({
      baseUrl: `${sharedServer.baseUrl}/`,
      token: sharedServer.adminToken,
      defaultHeaders: { 'X-E2E-Test': 'default-hdr', 'X-Default-Drop': 'should-drop' },
    });

    // GET with existing query + opts.query (scalar + array + null/undefined skipped) + null header deletion
    const g = await api.get('api/v1/echo?section=peptides', {
      query: { ownership: 'have', tag: ['a', 'b'], skippedNull: null, skippedUndef: undefined },
      headers: { 'X-Default-Drop': null },
    });
    assert.equal(g.status, 200);
    assert.equal(g.ok, true);
    assert.equal(g.headers.get('cache-control'), 'no-store');
    assert.equal(g.json.data.method, 'GET');
    assert.equal(g.json.data.authVia, 'bearer');
    assert.equal(g.json.data.customHeader, 'default-hdr');
    assert.equal(g.json.data.removedHeader, null);
    assert.equal(g.json.data.query.section, 'peptides');
    assert.equal(g.json.data.query.ownership, 'have');
    assert.deepEqual(g.json.data.query.tag, ['a', 'b']);
    assert.equal('skippedNull' in g.json.data.query, false);

    // POST JSON, PUT raw string, PATCH Buffer, DELETE 2-arg { body } & 3-arg, HEAD, OPTIONS
    const p = await api.post('/api/v1/echo', { compound: 'BPC-157' });
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.data.body, { compound: 'BPC-157' });
    assert.match(p.json.data.contentType, /application\/json/);

    const putRaw = await api.put('/api/v1/echo', new URLSearchParams({ k: 'v' }));
    assert.equal(putRaw.status, 200);
    assert.equal(putRaw.json.data.body, 'k=v');

    const patchBuf = await api.patch('/api/v1/echo', Buffer.from('raw-bytes'), {
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(patchBuf.status, 200);
    assert.equal(patchBuf.json.data.body, 'raw-bytes');

    const del2 = await api.del('/api/v1/echo', { body: { reason: 'two-arg' } });
    assert.equal(del2.status, 200);
    assert.deepEqual(del2.json.data.body, { reason: 'two-arg' });

    const del3 = await api.del('/api/v1/echo', { reason: 'three-arg' }, { headers: { 'X-E2E-Test': 'override' } });
    assert.equal(del3.status, 200);
    assert.deepEqual(del3.json.data.body, { reason: 'three-arg' });
    assert.equal(del3.json.data.customHeader, 'override');

    const headRes = await api.head('/api/v1/echo');
    assert.equal(headRes.status, 200);
    assert.equal(headRes.text, '');
    assert.equal(headRes.json, null);

    const optRes = await api.options('/api/v1/echo', {
      headers: { Origin: 'http://localhost:5173' },
      auth: false,
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    // tokenInQuery: true & preserving explicit ?token=bad
    const queryApi = createApiClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      tokenInQuery: true,
    });
    const qOk = await queryApi.get('/api/v1/echo?x=1');
    assert.equal(qOk.status, 200);
    assert.equal(qOk.json.data.authVia, 'query');

    const qExplicitBad = await queryApi.get('/api/v1/echo?token=wrong-token');
    assert.equal(qExplicitBad.status, 401);
    assert.equal(qExplicitBad.ok, false);

    // auth: false suppresses both header and query token (including inherited defaultHeaders Authorization)
    const noAuth = await queryApi.get('/api/v1/echo', { auth: false });
    assert.equal(noAuth.status, 401);

    const inheritedAuthApi = createApiClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      defaultHeaders: { Authorization: `Bearer ${sharedServer.adminToken}` },
    });
    assert.equal((await inheritedAuthApi.get('/api/v1/echo', { auth: false })).status, 401);

    // Regression H6: explicit { Authorization: null } suppresses default Bearer token injection
    const nullAuthHeader = await api.get('/api/v1/echo', { headers: { Authorization: null } });
    assert.equal(nullAuthHeader.status, 401);

    // Regression 3.6: inspectHeaderOverride last-key-wins on mixed-case duplicate Authorization keys
    const mixedNullAuth = await api.get('/api/v1/echo', {
      headers: { Authorization: 'Bearer old', authorization: null },
    });
    assert.equal(mixedNullAuth.status, 401, 'Last-key authorization:null must suppress default Bearer');
    const mixedSetAuth = await api.get('/api/v1/echo', {
      auth: false,
      headers: { authorization: null, Authorization: `Bearer ${sharedServer.adminToken}` },
    });
    assert.equal(mixedSetAuth.status, 200, 'Last-key explicit Authorization must win over earlier null');

    // Regression H5a: ?a=1#frag strips #frag before query parsing (never encodes %23frag into value)
    const echoEndpointApi = createApiClient({
      baseUrl: `${sharedServer.baseUrl}/api/v1/echo`,
      token: sharedServer.adminToken,
    });
    const fragRes = await echoEndpointApi.get('?a=1#frag', { query: { b: '2' } });
    assert.equal(fragRes.status, 200);
    assert.equal(fragRes.json.data.query.a, '1');
    assert.equal(fragRes.json.data.query.b, '2');

    // Regression H5b: baseUrl with subpath (/hub) preserves prefix on leading-slash paths without doubling
    const subpathApi = createApiClient({
      baseUrl: `${sharedServer.baseUrl}/hub`,
      token: sharedServer.adminToken,
    });
    const sub1 = await subpathApi.get('/api/v1/echo');
    assert.equal(sub1.status, 200);
    assert.equal(sub1.json.data.path, '/hub/api/v1/echo');
    const sub2 = await subpathApi.get('/hub/api/v1/echo');
    assert.equal(sub2.status, 200);
    assert.equal(sub2.json.data.path, '/hub/api/v1/echo');

    // Regression 3.7c: query-bearing baseUrl (/hub?env=1) preserves /hub subpath on relative paths
    const querySubpathApi = createApiClient({
      baseUrl: `${sharedServer.baseUrl}/hub?env=1`,
      token: sharedServer.adminToken,
    });
    const subRel = await querySubpathApi.get('api/v1/echo');
    assert.equal(subRel.status, 200);
    assert.equal(subRel.json.data.path, '/hub/api/v1/echo');

    // Non-JSON endpoints return json: null without throwing
    const plain = await api.get('/api/v1/plain');
    assert.equal(plain.status, 200);
    assert.equal(plain.text, 'plain-text-response-ok');
    assert.equal(plain.json, null);

    const csv = await api.get('/api/v1/csv');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^name,section/);
    assert.equal(csv.json, null);

    const noContent = await api.del('/api/v1/nocontent');
    assert.equal(noContent.status, 204);
    assert.equal(noContent.text, '');
    assert.equal(noContent.json, null);
  });

  // --------------------------------------------------------------------------
  // 08. generatePkcePair() & computePkceChallenge()
  // --------------------------------------------------------------------------
  it('08. generatePkcePair() & computePkceChallenge() satisfy RFC 7636 S256 and Appendix B vector', () => {
    // RFC 7636 Appendix B exact test vector
    assert.equal(
      computePkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );

    const pair1 = generatePkcePair();
    const pair2 = generatePkcePair(32);
    const pair3 = generatePkcePair(96);

    assert.equal(pair1.codeChallengeMethod, 'S256');
    assert.equal(pair1.codeVerifier.length, 64);
    assert.equal(pair2.codeVerifier.length, 43);
    assert.equal(pair3.codeVerifier.length, 128);
    assert.notEqual(pair1.codeVerifier, pair2.codeVerifier);

    for (const p of [pair1, pair2, pair3]) {
      assert.match(p.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
      assert.match(p.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
      const independent = crypto
        .createHash('sha256')
        .update(p.codeVerifier, 'ascii')
        .digest('base64url');
      assert.equal(p.codeChallenge, independent);
    }

    assert.throws(() => generatePkcePair(16), RangeError);
    assert.throws(() => generatePkcePair(100), RangeError);
  });

  // --------------------------------------------------------------------------
  // 09. parseAuthorizeForm() & buildAuthorizeFormBody() adversarial HTML
  // --------------------------------------------------------------------------
  it('09. parseAuthorizeForm() & buildAuthorizeFormBody() handle adversarial HTML, entity decoding, field detection & dual-form deny', () => {
    const html = `<!doctype html>
      <html>
      <head>
        <style>.x { content: "<form action='/css-decoy'>"; }</style>
        <script>
          const decoy = '<form action="/js-decoy"><input type="password" name="script_pass"></form>';
        </script>
      </head>
      <body>
        <!-- <form action="/comment-decoy"><input type="password" name="comment_pass"></form> -->
        <form
          action=/oauth/authorize
          method='post'
          data-expr="a > b"
        >
          <input type="hidden" name="code_challenge" value="abc_123" />
          <input type="hidden" name="csrf" value="tok&amp;1&quot;&#39;&#x27;&amp;quot;" data-gt="1 > 0">
          <input type="hidden" name="disabled_hidden" value="skipme" disabled />
          <label for="hp_pass">Household Passcode</label>
          <input id="hp_pass" type="password" name="household_pass" required />
          <select name="member_id">
            <option value="">Choose...</option>
            <option value="member_wife" selected>Wife</option>
            <option>Husband</option>
          </select>
          <input type="checkbox" name="scope" value="read" checked />
          <input type="checkbox" name="scope" value="propose" />
          <input type="checkbox" name="scope" value="write" />
          <textarea name="note">Line &lt;1&gt; &amp; ok</textarea>
          <input type="checkbox" name="consent" value="yes" />
          <button name="decision" value="approve">Authorize Access</button>
        </form>
        <form action="/oauth/deny" method="POST">
          <input type="hidden" name="state" value="st_1" />
          <button type="submit" name="decision" value="deny">Deny Request</button>
        </form>
      </body>
      </html>`;

    const parsed = parseAuthorizeForm(html, 'http://127.0.0.1:4000/oauth/authorize?client_id=c1');
    assert.equal(parsed.formsCount, 2);
    assert.equal(parsed.action, 'http://127.0.0.1:4000/oauth/authorize');
    assert.equal(parsed.method, 'POST');
    assert.equal(parsed.hiddenFields.code_challenge, 'abc_123');
    // Single-pass entity decoding check: &amp;quot; -> &quot; (NOT ")
    assert.equal(parsed.hiddenFields.csrf, `tok&1"''&quot;`);
    assert.equal('disabled_hidden' in parsed.hiddenFields, false);
    assert.equal(parsed.detected.passcodeField, 'household_pass');
    assert.equal(parsed.detected.memberField?.name, 'member_id');
    assert.equal(parsed.detected.memberField?.options[0].value, '');
    assert.equal(parsed.detected.memberField?.options[2].value, 'Husband');
    assert.equal(parsed.fields.note, 'Line <1> & ok');
    assert.equal(parsed.submitButtons[0].name, 'decision');
    assert.ok(parsed.denyForm, 'Expected separate denyForm to be detected');
    assert.equal(parsed.denyForm.action, 'http://127.0.0.1:4000/oauth/deny');

    // Approve build
    const approved = buildAuthorizeFormBody(parsed, {
      passcode: 'secret-123',
      scope: 'read propose',
      memberId: 'Husband',
      extraFormFields: { custom_flag: '1' },
    });
    assert.equal(approved.params.get('household_pass'), 'secret-123');
    assert.equal(approved.params.get('member_id'), 'Husband');
    assert.deepEqual(approved.params.getAll('scope'), ['read', 'propose']);
    assert.equal(approved.params.get('consent'), 'yes');
    assert.equal(approved.params.get('decision'), 'approve');
    assert.equal(approved.params.get('custom_flag'), '1');

    // skipConsent omits consent & approve button
    const skipped = buildAuthorizeFormBody(parsed, { passcode: 'secret-123', skipConsent: true });
    assert.equal(skipped.params.has('consent'), false);
    assert.equal(skipped.params.has('decision'), false);

    // denyConsent switches to separate denyForm
    const denied = buildAuthorizeFormBody(parsed, { denyConsent: true });
    assert.equal(denied.action, 'http://127.0.0.1:4000/oauth/deny');
    assert.equal(denied.params.get('decision'), 'deny');
    assert.equal(denied.params.get('state'), 'st_1');

    // Regression H9a: abruptly closed HTML5 comments (<!--> and <!--->) + unquoted trailing / on non-void <form>
    const edgeHtml1 = `<!--><!---><form action=/oauth/authorize/>
      <label><input type="checkbox" name="ok_box" value="yes"> I consent to authorize</label>
      <input type="hidden" name="agree" value="0" />
      <input type="checkbox" name="agree" value="1" checked />
      <input type="radio" name="scope" value="read" checked />
      <input type="radio" name="scope" value="propose" />
      <input type="radio" name="scope" value="write" />
      <button name="decision" value="approve">Approve (read-only, no write)</button>
      <button name="deny" value="1">Submit</button>
    </form>`;
    const parsedEdge1 = parseAuthorizeForm(edgeHtml1, 'http://127.0.0.1:4000/start');
    assert.equal(parsedEdge1.formsCount, 1);
    assert.equal(parsedEdge1.action, 'http://127.0.0.1:4000/oauth/authorize/');
    const wrappedCb = parsedEdge1.controls.find((c) => c.name === 'ok_box');
    assert.equal(wrappedCb.label, 'I consent to authorize');
    assert.ok(
      parsedEdge1.detected.consentControls.some((c) => c.name === 'ok_box' && c.intent === 'approve'),
      'Implicit wrapping <label> must detect consent checkbox'
    );
    const approveBtn = parsedEdge1.detected.consentControls.find(
      (c) => c.name === 'decision' && c.value === 'approve'
    );
    const denyBtn = parsedEdge1.detected.consentControls.find(
      (c) => c.name === 'deny' && c.value === '1'
    );
    assert.equal(approveBtn?.intent, 'approve', 'Prose "no" in approve label must not flip intent to deny');
    assert.equal(denyBtn?.intent, 'deny', 'Explicit name="deny" must beat boolean value="1"');

    // Regression H11: radio privilege precedence (read propose -> propose, read write -> write) + hidden+checkbox same name
    const builtRadioPropose = buildAuthorizeFormBody(parsedEdge1, {
      passcode: 'pw',
      scope: 'read propose',
    });
    assert.equal(builtRadioPropose.params.get('scope'), 'propose');
    assert.equal(builtRadioPropose.params.get('ok_box'), 'yes');
    assert.deepEqual(builtRadioPropose.params.getAll('agree'), ['0', '1']);

    const builtRadioWrite = buildAuthorizeFormBody(parsedEdge1, {
      passcode: 'pw',
      scope: 'read write',
    });
    assert.equal(builtRadioWrite.params.get('scope'), 'write');

    // Regression H11: non-multiple <select name="scope"> with empty scope="" must NOT vacuously pick first option
    const selectNoEmptyHtml = `<form action="/oauth/authorize" method="POST">
      <select name="scope">
        <option value="read">Read</option>
        <option value="propose">Propose</option>
        <option value="write">Write</option>
      </select>
    </form>`;
    const parsedSelect = parseAuthorizeForm(selectNoEmptyHtml, 'http://127.0.0.1:4000/oauth/authorize');
    const builtEmptyScope = buildAuthorizeFormBody(parsedSelect, { passcode: 'pw', scope: '' });
    assert.equal(builtEmptyScope.params.get('scope'), '');

    // Regression H9b: unclosed <button> finalizes label & strips _rawLabel; aria-label classifies consent buttons
    const unclosedAndAriaHtml = `<form action="/oauth/authorize" method="POST">
      <button name="x" value="x" aria-label="Approve"></button>
      <button name="y" value="y" aria-label="Deny"></button>
      <button name="z" value="go">Approve Access
    </form>`;
    const parsedBtns = parseAuthorizeForm(unclosedAndAriaHtml, 'http://127.0.0.1:4000/oauth/authorize');
    const btnX = parsedBtns.detected.consentControls.find((c) => c.name === 'x');
    const btnY = parsedBtns.detected.consentControls.find((c) => c.name === 'y');
    const btnZ = parsedBtns.detected.consentControls.find((c) => c.name === 'z');
    const rawBtnZ = parsedBtns.controls.find((c) => c.name === 'z');
    assert.equal(btnX?.intent, 'approve');
    assert.equal(btnY?.intent, 'deny');
    assert.equal(btnZ?.label, 'Approve Access');
    assert.equal(btnZ?.intent, 'approve');
    assert.equal('_rawLabel' in rawBtnZ, false);

    // Regression H9c: omitted authorizeUrl and malformed action URL must not throw TypeError
    const noBaseParsed = parseAuthorizeForm('<form action="/oauth/authorize"></form>');
    assert.equal(noBaseParsed.action, '/oauth/authorize');
    const malformedActionParsed = parseAuthorizeForm(
      '<form action="http://[::1"></form>',
      'http://127.0.0.1:4000/oauth/authorize'
    );
    assert.equal(malformedActionParsed.action, 'http://[::1');

    // Regression 3.3: classifyConsentIntent 6-step precedence on shared consent/approve/authorize names
    const sharedConsentHtml = `<form action="/oauth/authorize" method="POST">
      <input type="password" name="passcode" />
      <button type="submit" name="consent" value="1">Approve</button>
      <button type="submit" name="consent" value="0">Deny</button>
    </form>`;
    const parsedSharedConsent = parseAuthorizeForm(sharedConsentHtml, 'http://127.0.0.1:4000/oauth/authorize');
    assert.equal(
      parsedSharedConsent.detected.consentControls.find((c) => c.value === '1')?.intent,
      'approve'
    );
    assert.equal(
      parsedSharedConsent.detected.consentControls.find((c) => c.value === '0')?.intent,
      'deny'
    );
    assert.equal(
      buildAuthorizeFormBody(parsedSharedConsent, { passcode: 'pw' }).params.get('consent'),
      '1'
    );
    assert.equal(
      buildAuthorizeFormBody(parsedSharedConsent, { passcode: 'pw', denyConsent: true }).params.get('consent'),
      '0'
    );

    const neutralBoolHtml = `<form action="/oauth/authorize" method="POST">
      <button type="submit" name="consent" value="0">Submit</button>
      <button type="submit" name="approve" value="true">Approve</button>
      <button type="submit" name="approve" value="false">Deny</button>
      <button type="submit" name="authorize" value="false">Cancel</button>
      <input type="radio" name="authorize" value="yes" />
      <input type="radio" name="authorize" value="no" />
    </form>`;
    const parsedNeutralBool = parseAuthorizeForm(neutralBoolHtml, 'http://127.0.0.1:4000/oauth/authorize');
    assert.equal(
      parsedNeutralBool.detected.consentControls.find((c) => c.name === 'consent' && c.value === '0')?.intent,
      'deny',
      'Neutral label Submit + value=0 on name=consent must classify as deny'
    );
    assert.equal(
      parsedNeutralBool.detected.consentControls.find((c) => c.name === 'approve' && c.value === 'true')?.intent,
      'approve'
    );
    assert.equal(
      parsedNeutralBool.detected.consentControls.find((c) => c.name === 'approve' && c.value === 'false')?.intent,
      'deny'
    );
    assert.equal(
      parsedNeutralBool.detected.consentControls.find((c) => c.name === 'authorize' && c.value === 'false')?.intent,
      'deny'
    );
    assert.equal(
      parsedNeutralBool.detected.consentControls.find((c) => c.name === 'authorize' && c.value === 'yes')?.intent,
      'approve'
    );
    assert.equal(
      parsedNeutralBool.detected.consentControls.find((c) => c.name === 'authorize' && c.value === 'no')?.intent,
      'deny'
    );

    const approveBoolForm = parseAuthorizeForm(
      `<form action="/oauth/authorize" method="POST">
        <input type="password" name="passcode" />
        <button type="submit" name="approve" value="true">Approve</button>
        <button type="submit" name="approve" value="false">Deny</button>
      </form>`,
      'http://127.0.0.1:4000/oauth/authorize'
    );
    assert.equal(
      buildAuthorizeFormBody(approveBoolForm, { passcode: 'pw', denyConsent: true }).params.get('approve'),
      'false'
    );

    const radioConsentOrderForm = parseAuthorizeForm(
      `<form action="/oauth/authorize" method="POST">
        <input type="password" name="passcode" />
        <label><input type="radio" name="consent" value="0" /> Deny</label>
        <label><input type="radio" name="consent" value="1" /> Approve</label>
      </form>`,
      'http://127.0.0.1:4000/oauth/authorize'
    );
    assert.equal(
      buildAuthorizeFormBody(radioConsentOrderForm, { passcode: 'pw' }).params.get('consent'),
      '1',
      'Approve must select value=1 even when Deny radio value=0 appears first'
    );
    assert.equal(
      buildAuthorizeFormBody(radioConsentOrderForm, { passcode: 'pw', denyConsent: true }).params.get('consent'),
      '0'
    );

    // Regression 3.4 & 3.7a: <label for>/wrapping <label> beat aria-label, wrapping <label> targets ONLY first
    // non-hidden control (HTML5 §4.10.4), and duplicate checked radios emit ONLY the last checked radio.
    const labelAndRadioHtml = `<form action="/oauth/authorize" method="POST">
      <label for="cb_for">I approve and consent</label>
      <input id="cb_for" type="checkbox" name="ok_for" value="1" aria-label="Toggle" />
      <label><input type="checkbox" name="ok_wrap" value="1" aria-label="Toggle" /> I approve and consent</label>
      <input type="checkbox" name="ok_aria_only" value="1" aria-label="Approve access" />
      <label><input type="checkbox" name="consent_first" value="1" /> I approve access <input type="checkbox" name="newsletter" value="1" /></label>
      <label><input type="hidden" name="hidden_prefix" value="0" /><input type="checkbox" name="consent_after_hidden" value="1" /> I consent</label>
      <input type="radio" name="theme" value="light" checked />
      <input type="radio" name="theme" value="dark" checked />
    </form>`;
    const parsedLabelRadio = parseAuthorizeForm(labelAndRadioHtml, 'http://127.0.0.1:4000/oauth/authorize');
    assert.equal(
      parsedLabelRadio.controls.find((c) => c.name === 'ok_for')?.label,
      'I approve and consent',
      'aria-label must not block <label for=...>'
    );
    assert.equal(
      parsedLabelRadio.controls.find((c) => c.name === 'ok_wrap')?.label,
      'I approve and consent',
      'aria-label must not block wrapping <label>'
    );
    assert.equal(
      parsedLabelRadio.controls.find((c) => c.name === 'ok_aria_only')?.label,
      'Approve access',
      'aria-label remains fallback when no <label> is present'
    );
    assert.equal(
      parsedLabelRadio.controls.find((c) => c.name === 'consent_first')?.label,
      'I approve access'
    );
    assert.equal(
      parsedLabelRadio.controls.find((c) => c.name === 'newsletter')?.label,
      '',
      'Second visible control inside wrapping <label> must not inherit label text'
    );
    assert.equal(
      parsedLabelRadio.detected.consentControls.some((c) => c.name === 'newsletter'),
      false
    );
    assert.equal(
      parsedLabelRadio.controls.find((c) => c.name === 'consent_after_hidden')?.label,
      'I consent',
      'Wrapping <label> must skip hidden inputs and label first non-hidden control'
    );
    assert.equal(parsedLabelRadio.fields.theme, 'dark', 'Parsed fields must keep only last checked radio');
    const builtLabelRadio = buildAuthorizeFormBody(parsedLabelRadio, { passcode: 'pw' });
    assert.deepEqual(
      builtLabelRadio.params.getAll('theme'),
      ['dark'],
      'Serialized form body must emit only last checked radio in group'
    );
  });

  // --------------------------------------------------------------------------
  // 10. runOAuthFlow() happy path: DCR + PKCE S256 + Cookie CSRF + iss + form
  // --------------------------------------------------------------------------
  it('10. runOAuthFlow() succeeds end-to-end with discovery, DCR, Cookie CSRF, PKCE S256, RFC 9207 iss & form token exchange', async () => {
    const flow = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      scope: 'read propose',
      memberId: 'member_husband',
      resource: `${sharedServer.baseUrl}/mcp`,
    });

    assert.equal(flow.ok, true);
    assert.equal(flow.error, null);
    assert.equal(flow.discovery.protectedResource.status, 200);
    assert.equal(flow.discovery.protectedResourceMcp.status, 200);
    assert.equal(flow.discovery.authorizationServer.status, 200);
    // Ergonomic top-level aliases
    assert.strictEqual(flow.protectedResource, flow.discovery.protectedResource);
    assert.strictEqual(flow.protectedResourceMcp, flow.discovery.protectedResourceMcp);
    assert.equal(flow.authServerMetadata.issuer, sharedServer.origin);
    assert.equal(flow.registration.status, 201);
    assert.match(flow.clientId, /^dcr_/);
    assert.equal(flow.authorizePost.status, 302);
    assert.ok(flow.redirectLocation && flow.code);
    assert.equal(flow.returnedState, flow.state);
    assert.equal(flow.iss, sharedServer.origin);
    assert.equal(flow.callbackParams.code, flow.code);
    assert.equal(flow.tokenResponse.status, 200);
    assert.ok(flow.accessToken);
    assert.ok(flow.refreshToken);
    assert.equal(flow.grantedScope, 'read propose');

    // Verify minted access token works on live API
    const api = createApiClient({ baseUrl: sharedServer.baseUrl, token: flow.accessToken });
    const echo = await api.get('/api/v1/echo');
    assert.equal(echo.status, 200);
    assert.equal(echo.json.data.scope, 'read propose');
    assert.equal(echo.json.data.memberId, 'member_husband');
  });

  // --------------------------------------------------------------------------
  // 11. runOAuthFlow() CIMD HTTPS clientId + JSON token exchange
  // --------------------------------------------------------------------------
  it('11. runOAuthFlow() supports CIMD HTTPS clientId (skipping DCR) + JSON token exchange', async () => {
    const cimdClientId = 'https://ai-client.example.test/oauth/client.json';
    const flowMime = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      scope: 'propose',
      clientId: cimdClientId,
      tokenContentType: 'application/json',
    });

    assert.equal(flowMime.ok, true);
    assert.equal(flowMime.registration, null);
    assert.equal(flowMime.clientId, cimdClientId);
    assert.equal(flowMime.tokenResponse.status, 200);
    assert.ok(flowMime.accessToken);

    // Also accept shorthand 'json'
    const flowShort = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      scope: 'read',
      clientId: cimdClientId,
      tokenContentType: 'json',
    });
    assert.equal(flowShort.ok, true);
    assert.ok(flowShort.accessToken);

    const api = createApiClient({ baseUrl: sharedServer.baseUrl, token: flowMime.accessToken });
    const echo = await api.get('/api/v1/echo');
    assert.equal(echo.status, 200);
    assert.equal(echo.json.data.scope, 'propose');
  });

  // --------------------------------------------------------------------------
  // 12. runOAuthFlow() negative paths
  // --------------------------------------------------------------------------
  it('12. runOAuthFlow() negative paths stop gracefully without throwing (wrongPasscode, denyConsent, skipConsent, wrongVerifier)', async () => {
    const badPass = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      wrongPasscode: true,
    });
    assert.equal(badPass.ok, false);
    assert.equal(badPass.authorizePost.status, 403);
    assert.equal(badPass.code, null);
    assert.equal(badPass.tokenResponse, null);
    assert.equal(badPass.accessToken, null);

    const denied = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      denyConsent: true,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.authorizePost.status, 302);
    assert.equal(denied.callback.error, 'access_denied');
    assert.equal(denied.code, null);
    assert.equal(denied.tokenResponse, null);

    const skipped = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      skipConsent: true,
    });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.authorizePost.status, 400);
    assert.equal(skipped.code, null);
    assert.equal(skipped.tokenResponse, null);

    const badVerifier = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      wrongVerifier: true,
    });
    assert.equal(badVerifier.ok, false);
    assert.ok(badVerifier.code, 'Authorize step should succeed before PKCE verification fails');
    assert.equal(badVerifier.tokenResponse.status, 400);
    assert.equal(badVerifier.tokenResponse.json.error, 'invalid_grant');
    assert.equal(badVerifier.error, 'invalid_grant');
    assert.equal(badVerifier.accessToken, null);

    // Regression H12a: token 500 non-JSON after 302 redirect reports token_500 (never authorize_post_302)
    const tok500 = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/token500`,
      passcode: sharedServer.passcode,
    });
    assert.equal(tok500.ok, false);
    assert.equal(tok500.error, 'token_500');

    // Regression H12b: 200 HTML wrong-passcode re-render reports authorize_post_200 (never null)
    const auth200 = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/auth200`,
      passcode: sharedServer.passcode,
    });
    assert.equal(auth200.ok, false);
    assert.equal(auth200.error, 'authorize_post_200');

    // Regression H12c: 201 non-JSON DCR reports register_missing_client_id
    const dcr201 = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/dcr201`,
      passcode: sharedServer.passcode,
    });
    assert.equal(dcr201.ok, false);
    assert.equal(dcr201.error, 'register_missing_client_id');

    // Regression H12d: method="GET" consent form without action strips existing query (no duplicate params)
    const getFormFlow = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/getform`,
      passcode: sharedServer.passcode,
    });
    assert.equal(getFormFlow.ok, true, `Expected GET form flow ok, got error=${getFormFlow.error}`);
    assert.equal(getFormFlow.accessToken, 'edge_at_getform');

    // Regression H12e: malformed discovery authorization_endpoint must not throw TypeError: Invalid URL
    const badDisc = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/bad-discovery`,
      passcode: sharedServer.passcode,
    });
    assert.equal(badDisc.ok, false);
    assert.ok(typeof badDisc.error === 'string' && badDisc.error.length > 0);

    // Regression 3.3 (end-to-end): realistic <button name="consent" value="1">Approve</button> / value="0">Deny</button>
    const consentBoolApprove = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/consent-bool`,
      passcode: sharedServer.passcode,
    });
    assert.equal(consentBoolApprove.ok, true, `Expected consent-bool approve ok, got ${consentBoolApprove.error}`);
    assert.equal(consentBoolApprove.accessToken, 'edge_at_consent-bool');

    const consentBoolDeny = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/consent-bool`,
      passcode: sharedServer.passcode,
      denyConsent: true,
    });
    assert.equal(consentBoolDeny.ok, false);
    assert.equal(consentBoolDeny.authorizePost.status, 302);
    assert.equal(consentBoolDeny.callback?.error, 'access_denied');
    assert.equal(consentBoolDeny.error, 'access_denied');

    // Regression 3.5: malformed <form action="http://[::1"> (POST & GET) returns structured error without throwing
    const badActionPost = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/bad-action-post`,
      passcode: sharedServer.passcode,
    });
    assert.equal(badActionPost.ok, false);
    assert.equal(badActionPost.error, 'invalid_authorize_form_action');

    const badActionGet = await runOAuthFlow({
      baseUrl: `${sharedServer.baseUrl}/oauth-edge/bad-action-get`,
      passcode: sharedServer.passcode,
    });
    assert.equal(badActionGet.ok, false);
    assert.equal(badActionGet.error, 'invalid_authorize_form_action');
  });

  // --------------------------------------------------------------------------
  // 13. refreshOAuthToken() rotation & revokeOAuthToken()
  // --------------------------------------------------------------------------
  it('13. refreshOAuthToken() enforces rotation and revokeOAuthToken() invalidates access on REST and MCP', async () => {
    const initial = await runOAuthFlow({
      baseUrl: sharedServer.baseUrl,
      passcode: sharedServer.passcode,
      scope: 'write',
    });
    assert.equal(initial.ok, true);

    const refreshed = await refreshOAuthToken({
      baseUrl: sharedServer.baseUrl,
      refreshToken: initial.refreshToken,
      clientId: initial.clientId,
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.ok, true);
    assert.ok(refreshed.accessToken && refreshed.accessToken !== initial.accessToken);
    assert.ok(refreshed.refreshToken && refreshed.refreshToken !== initial.refreshToken);

    // Replaying rotated old refresh token must fail
    const replay = await refreshOAuthToken({
      baseUrl: sharedServer.baseUrl,
      refreshToken: initial.refreshToken,
      clientId: initial.clientId,
      contentType: 'application/json',
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'invalid_grant');

    // New access token works
    const api = createApiClient({ baseUrl: sharedServer.baseUrl, token: refreshed.accessToken });
    assert.equal((await api.get('/api/v1/echo')).status, 200);

    // Revoke new access token (via JSON content type)
    const revoked = await revokeOAuthToken({
      baseUrl: sharedServer.baseUrl,
      token: refreshed.accessToken,
      tokenTypeHint: 'access_token',
      contentType: 'application/json',
    });
    assert.equal(revoked.status, 200);

    // Revoked token rejected on REST and MCP (with WWW-Authenticate)
    assert.equal((await api.get('/api/v1/echo')).status, 401);
    const mcpRevoked = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: refreshed.accessToken,
    });
    const pingRevoked = await mcpRevoked.ping();
    assert.equal(pingRevoked.status, 401);
    assert.match(pingRevoked.headers.get('www-authenticate') || '', /resource_metadata=/);
  });

  // --------------------------------------------------------------------------
  // 14. createMcpClient() single, session, 202, SSE, resources, prompts, raw
  // --------------------------------------------------------------------------
  it('14. createMcpClient() handles initialize, Mcp-Session-Id propagation, 202 notification, SSE, resources, prompts & raw parse error', async () => {
    const mcp = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      protocolVersion: '2025-06-18',
    });

    const init = await mcp.initialize();
    assert.equal(init.status, 200);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const sessId = mcp.getSessionId();
    assert.match(sessId || '', /^sess_/);

    const notif = await mcp.notifyInitialized();
    assert.equal(notif.status, 202);
    assert.equal(notif.body, null);

    const ping = await mcp.ping();
    assert.equal(ping.status, 200);
    assert.equal(ping.result.pong, true);
    assert.equal(ping.result.sessionId, sessId);
    assert.equal(ping.result.protocolVersion, '2025-06-18');

    const tools = await mcp.listTools();
    assert.equal(tools.status, 200);
    assert.ok(tools.result.tools.some((t) => t.name === 'echo_tool'));

    const echoCall = await mcp.callTool('echo_tool', { query: 'peptides' });
    const echoData = parseToolJson(echoCall);
    assert.deepEqual(echoData.echoed, { query: 'peptides' });
    assert.equal(echoData.sessionId, sessId);

    // Real text/event-stream SSE parsing (with comments + progress notification + matching id response)
    const sseCall = await mcp.callTool('sse_tool', { test: 42 });
    assert.equal(sseCall.status, 200);
    assert.match(sseCall.headers.get('content-type') || '', /text\/event-stream/);
    const sseData = parseToolJson(sseCall);
    assert.deepEqual(sseData, { via: 'sse', echoed: { test: 42 }, ok: true });

    // Resources & Prompts
    const resList = await mcp.listResources();
    assert.equal(resList.result.resources[0].uri, 'hub://overview');
    const resRead = await mcp.readResource('hub://overview');
    assert.deepEqual(parseToolJson(resRead), { uri: 'hub://overview', sections: 4 });

    const promptList = await mcp.listPrompts();
    assert.equal(promptList.result.prompts[0].name, 'research_compound');
    const promptGet = await mcp.getPrompt('research_compound', { compound: 'GHK-Cu' });
    assert.match(promptGet.result.messages[0].content.text, /GHK-Cu/);

    // Protocol compat 2024-11-05
    const mcpCompat = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      protocolVersion: '2024-11-05',
    });
    const pingCompat = await mcpCompat.ping();
    assert.equal(pingCompat.result.protocolVersion, '2024-11-05');

    // Unauthenticated 401 + WWW-Authenticate
    const mcpUnauth = createMcpClient({ baseUrl: sharedServer.baseUrl });
    const unauth = await mcpUnauth.ping();
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate') || '', /oauth-protected-resource/);

    // Regression H6: createMcpClient honors { auth: false } across call/ping, batch & raw
    const mcpWithDefaultAuth = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      tokenInQuery: true,
      defaultHeaders: { Authorization: `Bearer ${sharedServer.adminToken}` },
    });
    assert.equal((await mcpWithDefaultAuth.ping({ auth: false })).status, 401);
    assert.equal(
      (await mcpWithDefaultAuth.batch([{ method: 'ping', params: {} }], { auth: false })).status,
      401
    );
    assert.equal((await mcpWithDefaultAuth.raw('{"jsonrpc":"2.0","id":1,"method":"ping"}', { auth: false })).status, 401);

    // Regression 3.6: tokenInQuery:true with { headers: { Authorization: null } } preserves ?token= (parity with createApiClient)
    const mcpQueryOnly = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      tokenInQuery: true,
    });
    const mcpQueryPing = await mcpQueryOnly.ping({ headers: { Authorization: null } });
    assert.equal(mcpQueryPing.status, 200);
    assert.equal(mcpQueryPing.result.authVia, 'query');
    const mcpQueryBatch = await mcpQueryOnly.batch([{ method: 'ping', params: {} }], {
      headers: { Authorization: null },
    });
    assert.equal(mcpQueryBatch.status, 200);
    assert.equal(mcpQueryBatch.responses[0].result.authVia, 'query');
    const mcpQueryRaw = await mcpQueryOnly.raw('{"jsonrpc":"2.0","id":9,"method":"ping"}', {
      headers: { Authorization: null },
    });
    assert.equal(mcpQueryRaw.status, 200);
    assert.equal(mcpQueryRaw.result.authVia, 'query');

    // Mixed-case duplicate Authorization keys on header-auth MCP client (last-key-wins)
    assert.equal(
      (await mcp.ping({ headers: { Authorization: 'Bearer old', authorization: null } })).status,
      401
    );

    // Regression H7: handle.mcp forwards payload.id as expectedId for multi-frame SSE streams
    const multiSse = await sharedServer.mcp({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'sse_multi_tool', arguments: {} },
    });
    assert.equal(multiSse.status, 200);
    assert.equal(multiSse.id, 7);
    assert.deepEqual(parseToolJson(multiSse), { matchedId: 7, ok: true });

    // Malformed JSON -> -32700 via raw()
    const badJson = await mcp.raw('{malformed json');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.error.code, -32700);
  });

  // --------------------------------------------------------------------------
  // 15. createMcpClient() batch (JSON & SSE) + ?token= query auth
  // --------------------------------------------------------------------------
  it('15. createMcpClient() supports JSON-RPC 2.0 batch requests (JSON & SSE) and ?token= auth fallback', async () => {
    const mcpQuery = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
      tokenInQuery: true,
    });

    const batchRes = await mcpQuery.batch([
      { method: 'ping', params: {} },
      { method: 'tools/list', params: {} },
    ]);
    assert.equal(batchRes.status, 200);
    assert.equal(batchRes.responses.length, 2);
    assert.equal(batchRes.responses[0].result.pong, true);
    assert.equal(batchRes.responses[0].result.authVia, 'query');
    assert.ok(Array.isArray(batchRes.responses[1].result.tools));

    // SSE batch frames
    const sseBatch = await mcpQuery.batch([
      { method: 'tools/call', params: { name: 'sse_tool', arguments: { idx: 1 } } },
      { method: 'ping', params: {} },
    ]);
    assert.equal(sseBatch.status, 200);
    assert.match(sseBatch.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(sseBatch.responses.length, 2);
    assert.deepEqual(parseToolJson(sseBatch.responses[0]), {
      via: 'sse',
      echoed: { idx: 1 },
      ok: true,
    });
    assert.equal(sseBatch.responses[1].result.pong, true);
  });

  // --------------------------------------------------------------------------
  // 16. parseToolJson()
  // --------------------------------------------------------------------------
  it('16. parseToolJson() extracts plain JSON, fenced JSON, isError JSON, structuredContent, resources/read & enforces throw vs allowNull', async () => {
    const mcp = createMcpClient({
      baseUrl: sharedServer.baseUrl,
      token: sharedServer.adminToken,
    });

    // Live isError: true structured validation response MUST parse cleanly
    const valErrRes = await mcp.callTool('validation_error_tool', {});
    assert.equal(valErrRes.result.isError, true);
    const valErrJson = parseToolJson(valErrRes);
    assert.deepEqual(valErrJson, { status: 422, missingFields: ['summary', 'dosages'] });

    // Markdown fenced JSON
    assert.deepEqual(
      parseToolJson({ result: { content: [{ type: 'text', text: '```json\n{"a":1}\n```' }] } }),
      { a: 1 }
    );

    // Split multi-block content
    assert.deepEqual(
      parseToolJson({ result: { content: [{ type: 'text', text: '{"split":' }, { type: 'text', text: 'true}' }] } }),
      { split: true }
    );

    // MCP 2025-06-18 structuredContent fallback
    assert.deepEqual(
      parseToolJson({ result: { content: [{ type: 'text', text: 'Summary prose' }], structuredContent: { count: 4 } } }),
      { count: 4 }
    );

    // JSON-RPC protocol error throws descriptively; allowNull returns null
    const rpcErr = { status: 200, error: { code: -32602, message: 'Invalid params' }, result: null };
    assert.throws(() => parseToolJson(rpcErr), /-32602/);
    assert.equal(parseToolJson(rpcErr, { allowNull: true }), null);

    // Plain prose throws descriptively; allowNull returns null
    const prose = { result: { content: [{ type: 'text', text: 'Not JSON at all' }] } };
    assert.throws(() => parseToolJson(prose), /could not extract JSON/i);
    assert.equal(parseToolJson(prose, { allowNull: true }), null);

    // Regression H8a: multi-fence text with non-JSON fence before valid ```json fence
    const multiFence = {
      result: {
        content: [
          {
            type: 'text',
            text: 'Note:\n```\nnot json here\n```\nPayload:\n```json\n{"ok":true,"secondFence":1}\n```',
          },
        ],
      },
    };
    assert.deepEqual(parseToolJson(multiFence), { ok: true, secondFence: 1 });

    // Untagged valid JSON fence after a non-JSON text fence
    const multiFenceUntagged = {
      result: {
        content: [
          {
            type: 'text',
            text: '```text\nplain words\n```\n```\n{"untaggedSecond":2}\n```',
          },
        ],
      },
    };
    assert.deepEqual(parseToolJson(multiFenceUntagged), { untaggedSecond: 2 });

    // Regression H8b: circular object with allowNull: true returns null (never throws TypeError)
    const circular = { label: 'loop' };
    circular.self = circular;
    assert.equal(parseToolJson(circular, { allowNull: true }), null);
    assert.throws(() => parseToolJson(circular), /could not extract JSON/i);
  });

  // --------------------------------------------------------------------------
  // 17. unwrapData() edge-case truth table
  // --------------------------------------------------------------------------
  it('17. unwrapData() satisfies full edge-case truth table including falsy values, entity guards & multi-collection objects', () => {
    // Non-plain-object fast path
    assert.equal(unwrapData(null), null);
    assert.equal(unwrapData(undefined), undefined);
    assert.equal(unwrapData(0), 0);
    assert.equal(unwrapData(false), false);
    assert.equal(unwrapData('hello'), 'hello');
    assert.deepEqual(unwrapData([1, 2]), [1, 2]);

    // Priority 1: explicit candidateKeys beat `data`
    assert.deepEqual(unwrapData({ compound: { id: '1' }, data: { id: '2' } }, 'compound'), { id: '1' });

    // Priority 2: nested data[key] + empty array preserved
    assert.deepEqual(unwrapData({ ok: true, data: { compounds: [] } }, 'compounds'), []);
    assert.deepEqual(unwrapData({ ok: true, data: { id: '1', name: 'BPC' } }, 'compound'), { id: '1', name: 'BPC' });

    // Falsy primitives inside data & explicit keys preserved verbatim
    assert.equal(unwrapData({ ok: true, data: false }), false);
    assert.equal(unwrapData({ ok: true, data: 0 }), 0);
    assert.equal(unwrapData({ ok: true, data: '' }), '');
    assert.equal(unwrapData({ ok: true, flag: false }, ['flag']), false);

    // Priority 3: single standard fallback + wrapper meta
    assert.deepEqual(unwrapData({ ok: true, count: 0, compounds: [] }), []);
    assert.deepEqual(unwrapData({ ok: true, auditLog: [{ id: 'a1' }] }), [{ id: 'a1' }]);

    // Entity guards prevent destroying Stack or SpreadResult
    const stack = { id: 's1', name: 'AM', memberId: 'member_wife', items: [{ compoundId: 'c1' }] };
    assert.deepEqual(unwrapData(stack), stack);
    assert.deepEqual(unwrapData(stack, 'stack'), stack);

    const spread = { memberId: 'm1', stackId: 's1', systemic: { slots: [] }, dermatology: {}, interactions: { hardStops: [] } };
    assert.deepEqual(unwrapData(spread), spread);
    assert.deepEqual(unwrapData(spread, 'schedule'), spread);

    // Multi-collection object untouched when candidateKeys omitted, unwrapped when specified
    const hub = { members: [{ id: 'm1' }], sections: [], compounds: [] };
    assert.deepEqual(unwrapData(hub), hub);
    assert.deepEqual(unwrapData(hub, 'members'), [{ id: 'm1' }]);

    // Unknown sibling key blocks fallback unwrap
    const customObj = { customProp: 1, items: [1] };
    assert.deepEqual(unwrapData(customObj, 'missing'), customObj);
  });

  // --------------------------------------------------------------------------
  // 18. fixtures builders + deepMerge + zero PII scan
  // --------------------------------------------------------------------------
  it('18. fixtures builders satisfy PROJECT.md §1 across all 4 sections + protocol-os + stack + member + custom field with zero PII', () => {
    const peptide = fixtures.makePeptideCompound();
    const ped = fixtures.makePedCompound();
    const supp = fixtures.makeSupplementCompound();
    const derm = fixtures.makeDermCompound();
    const pos = fixtures.makeProtocolOsExport();
    const stackItem = fixtures.makeStackItem();
    const stack = fixtures.makeStackPayload();
    const member = fixtures.makeMemberPayload();
    const customField = fixtures.makeCustomSectionField();

    assert.equal(peptide.sectionId, 'peptides');
    assert.equal(ped.sectionId, 'peds');
    assert.equal(supp.sectionId, 'vitamins_supplements');
    assert.equal(derm.sectionId, 'dermatology');
    assert.equal(pos._format, 'protocol-os-export/v1');
    assert.equal(pos.protocols.length, 3);
    assert.equal(pos.vials.length, 2);
    assert.equal(pos.logs.length, 2);
    assert.equal(stackItem.compoundId, 'cmp_synthetic_1');
    assert.equal(stack.memberId, 'member_wife');
    assert.equal(member.routineAnchors.tz, 'UTC');
    assert.match(customField.key, /^[a-z][a-z0-9_]*$/);

    // Verify all 4 compound profiles carry complete core fields + valid https:// citations
    for (const c of [peptide, ped, supp, derm]) {
      assert.ok(c.name && c.summary && c.mechanismOfAction);
      assert.ok(Array.isArray(c.useCaseScenarios) && c.useCaseScenarios.length > 0);
      assert.ok(c.timingRules && c.halfLife && c.dosages && c.cycles);
      assert.ok(Array.isArray(c.doNotPairWith) && c.doNotPairWith.length > 0);
      assert.ok(c.sectionData && typeof c.sectionData === 'object');
      assert.ok(c.provenance.citations.length > 0);
      for (const cit of c.provenance.citations) {
        assert.match(cit.url, /^https:\/\//);
      }
    }

    // Verify deepMerge nested preservation, array replacement, null override, and caller non-mutation
    const inputOverride = {
      timingRules: { preferredSlots: ['bedtime_fasted'] },
      sectionData: { vialMg: 10 },
      dosages: { maxCeiling: null },
      aliases: ['OnlyAlias'],
    };
    const snapshotBefore = JSON.stringify(inputOverride);
    const customized = fixtures.makePeptideCompound(inputOverride);
    assert.deepEqual(customized.timingRules.preferredSlots, ['bedtime_fasted']);
    assert.equal(customized.timingRules.foodState, 'fasted', 'Sibling nested fields preserved');
    assert.equal(customized.sectionData.vialMg, 10);
    assert.equal(customized.sectionData.solvent, 'BAC', 'Sibling sectionData preserved');
    assert.equal(customized.dosages.maxCeiling, null);
    assert.deepEqual(customized.aliases, ['OnlyAlias'], 'Arrays replaced cleanly');
    assert.equal(JSON.stringify(inputOverride), snapshotBefore, 'Caller override not mutated');

    // Regression H13a: makePeptideCompound caution entry must NOT carry separationHours: 0
    assert.equal(peptide.doNotPairWith[0].severity, 'caution');
    assert.equal(peptide.doNotPairWith[0].separationHours, undefined);
    assert.equal('separationHours' in peptide.doNotPairWith[0], false);

    // Regression H13b: tightened isPlainObject / deepClone preserves Date instances (never flattens to {})
    const sampleDate = new Date('2026-10-01T12:00:00.000Z');
    const withDate = fixtures.makePeptideCompound({ customDate: sampleDate });
    assert.ok(withDate.customDate instanceof Date, 'Date override must remain a Date instance');
    assert.equal(withDate.customDate.toISOString(), sampleDate.toISOString());
    assert.notStrictEqual(withDate.customDate, sampleDate, 'Date override should be cloned safely');

    // Regression 3.7b: deepMerge/deepClone ignore __proto__/constructor/prototype keys
    const protoPayload = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"pollutedCtor":"yes"}},"timingRules":{"__proto__":{"nestedPolluted":"yes"}}}'
    );
    const protoSafe = fixtures.makePeptideCompound(protoPayload);
    assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
    assert.equal(({}).pollutedCtor, undefined, 'Object.prototype must not be polluted via constructor');
    assert.equal(protoSafe.polluted, undefined, 'Returned object prototype must not be replaced via __proto__');
    assert.equal(protoSafe.timingRules.nestedPolluted, undefined, 'Nested __proto__ must be ignored');
    assert.equal(Object.getPrototypeOf(protoSafe), Object.prototype);

    // Zero-PII / zero-secret sanity scan across all generated fixture payloads
    const serialized = JSON.stringify({ peptide, ped, supp, derm, pos, stack, member, customField });
    assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(serialized, /\b\d{3}-\d{2}-\d{4}\b/);
  });

  // --------------------------------------------------------------------------
  // 19. run-e2e.mjs CLI runner (tiers, filter, 1..0 trap, spoof, recursion guard)
  // --------------------------------------------------------------------------
  it('19. run-e2e.mjs CLI handles --list, --tier, --filter, 1..0 trap, spoof immunity, hook cancel, invalid args & recursion guard', () => {
    const runRunner = (cliArgs, extraEnv = {}) =>
      spawnSync(process.execPath, [RUN_E2E_PATH, ...cliArgs], {
        encoding: 'utf8',
        env: { ...process.env, ...extraEnv },
      });

    // --list sorted order
    const listRes = runRunner(['--list', '--tier=1', `--root=${fakeE2eRoot}`]);
    assert.equal(listRes.status, 0);
    const alphaIdx = listRes.stdout.indexOf('tier1/alpha.e2e.test.mjs');
    const betaIdx = listRes.stdout.indexOf('tier1/beta.e2e.test.mjs');
    assert.ok(alphaIdx !== -1 && betaIdx !== -1 && alphaIdx < betaIdx, 'Files must be ASCII-sorted');

    // --tier=1 pass + --base-url propagation + console spoof immunity
    const t1 = runRunner(
      ['--tier=1', `--root=${fakeE2eRoot}`, `--base-url=${sharedServer.baseUrl}`],
      { EXPECT_BASE_URL: sharedServer.baseUrl }
    );
    assert.equal(t1.status, 0, t1.stdout + t1.stderr);
    assert.match(t1.stdout, /Tier 1: PASS\s+tests=3\s+pass=3\s+fail=0/);
    assert.match(t1.stdout, /OVERALL: PASS\s+tests=3\s+pass=3\s+fail=0/);

    // --tier=all fails because tier2 has fail=1 and cancelled=1 (not fooled by pass 999)
    const tAll = runRunner(['--tier=all', `--root=${fakeE2eRoot}`]);
    assert.equal(tAll.status, 1);
    assert.match(tAll.stdout, /Tier 1: PASS/);
    assert.match(tAll.stdout, /Tier 2: FAIL.*fail=1\s+cancelled=1/);
    assert.match(tAll.stdout, /Tier 3: PASS/);
    assert.match(tAll.stdout, /Tier 4: PASS/);
    assert.match(tAll.stdout, /OVERALL: FAIL/);

    // --filter filename match
    const fFile = runRunner(['--tier=1', '--filter=alpha', `--root=${fakeE2eRoot}`]);
    assert.equal(fFile.status, 0);
    assert.match(fFile.stdout, /Tier 1: PASS\s+tests=1\s+pass=1\s+fail=0/);

    // --filter test-name fallback
    const fTitle = runRunner(['--tier=1', '--filter=UNIQUE_BETA_TITLE', `--root=${fakeE2eRoot}`]);
    assert.equal(fTitle.status, 0, fTitle.stdout + fTitle.stderr);
    assert.match(fTitle.stdout, /Tier 1: PASS\s+tests=1\s+pass=1\s+fail=0/);

    // --filter comment-only word defeats Node 22 1..0 synthetic empty-file pass!
    const fTrap = runRunner(['--tier=1', '--filter=COMMENT_ONLY_TRAP', `--root=${fakeE2eRoot}`]);
    assert.equal(fTrap.status, 1, 'Comment-only match must exit 1 (defeating Node 22 1..0 trap)');

    // --filter zero matches (both execution and --list exit 1)
    const fNone = runRunner(['--tier=1', '--filter=NO_SUCH_TEST_XYZ', `--root=${fakeE2eRoot}`]);
    assert.equal(fNone.status, 1);
    const fNoneList = runRunner(['--list', '--tier=1', '--filter=NO_SUCH_TEST_XYZ', `--root=${fakeE2eRoot}`]);
    assert.equal(fNoneList.status, 1);

    // Regression R1a: test.skip must exit 1 with skipped=1
    const skipRoot = path.join(tmpRoot, 'skip-e2e');
    fs.mkdirSync(path.join(skipRoot, 'tier1'), { recursive: true });
    fs.writeFileSync(
      path.join(skipRoot, 'tier1', 'skipped.e2e.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('passing test', () => { assert.equal(1, 1); });\ntest.skip('forbidden skipped test', () => {});\n`,
      'utf8'
    );
    const skipRes = runRunner(['--tier=1', `--root=${skipRoot}`]);
    assert.equal(skipRes.status, 1, 'test.skip must exit 1');
    assert.match(skipRes.stdout, /skipped=1/);

    // Regression R1b: empty 0-test .e2e.test.mjs file ALONE must exit 1 (never PASS tests=1)
    const emptyFileRoot = path.join(tmpRoot, 'empty-file-e2e');
    fs.mkdirSync(path.join(emptyFileRoot, 'tier1'), { recursive: true });
    fs.writeFileSync(
      path.join(emptyFileRoot, 'tier1', 'empty.e2e.test.mjs'),
      '// empty stub file defining zero tests\n',
      'utf8'
    );
    const emptyFileRes = runRunner(['--tier=1', `--root=${emptyFileRoot}`]);
    assert.equal(emptyFileRes.status, 1, 'Empty 0-test file alone must exit 1');
    assert.match(emptyFileRes.stderr, /empty or prematurely exited/i);

    // Regression R1c: empty 0-test file ALONGSIDE a real passing file must exit 1 (never inflate count)
    const mixedEmptyRoot = path.join(tmpRoot, 'mixed-empty-e2e');
    fs.mkdirSync(path.join(mixedEmptyRoot, 'tier1'), { recursive: true });
    fs.writeFileSync(
      path.join(mixedEmptyRoot, 'tier1', 'a-real.e2e.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real pass', () => { assert.equal(1, 1); });\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(mixedEmptyRoot, 'tier1', 'b-empty.e2e.test.mjs'),
      '// zero tests\n',
      'utf8'
    );
    const mixedEmptyRes = runRunner(['--tier=1', `--root=${mixedEmptyRoot}`]);
    assert.equal(mixedEmptyRes.status, 1, 'Empty file mixed with real file must exit 1');
    assert.match(mixedEmptyRes.stdout, /tests=1\s+pass=1\s+fail=1/);

    // Regression R1d: abrupt process.exit(0) mid-test must exit 1
    const abortRoot = path.join(tmpRoot, 'abort-e2e');
    fs.mkdirSync(path.join(abortRoot, 'tier1'), { recursive: true });
    fs.writeFileSync(
      path.join(abortRoot, 'tier1', 'abort.e2e.test.mjs'),
      `import test from 'node:test';\ntest('aborts early', () => { process.exit(0); });\ntest('unreachable fail', () => { throw new Error('boom'); });\n`,
      'utf8'
    );
    const abortRes = runRunner(['--tier=1', `--root=${abortRoot}`]);
    assert.equal(abortRes.status, 1, 'Abrupt process.exit(0) mid-test must exit 1');

    // Regression R2: --filter matches dynamic template-literal & JS-escaped titles via runtime fallback
    const dynRoot = path.join(tmpRoot, 'dynamic-title-e2e');
    fs.mkdirSync(path.join(dynRoot, 'tier1'), { recursive: true });
    fs.writeFileSync(
      path.join(dynRoot, 'tier1', 'dynamic.e2e.test.mjs'),
      `import test from 'node:test';
import assert from 'node:assert/strict';
const sec = 'peptides';
test(\`Section \${sec}: CRUD\`, () => { assert.equal(1, 1); });
test('Wife\\'s stack isolation', () => { assert.equal(2, 2); });
test('weird ^a.*b?c{2}$|d\\\\e title', () => { assert.equal(3, 3); });
`,
      'utf8'
    );
    const dynTpl = runRunner(['--tier=1', '--filter=Section peptides', `--root=${dynRoot}`]);
    assert.equal(dynTpl.status, 0, dynTpl.stdout + dynTpl.stderr);
    assert.match(dynTpl.stdout, /Tier 1: PASS\s+tests=1\s+pass=1\s+fail=0/);

    const dynQuote = runRunner(['--tier=1', "--filter=Wife's stack", `--root=${dynRoot}`]);
    assert.equal(dynQuote.status, 0, dynQuote.stdout + dynQuote.stderr);
    assert.match(dynQuote.stdout, /Tier 1: PASS\s+tests=1\s+pass=1\s+fail=0/);

    const dynMeta = runRunner(['--tier=1', '--filter=^a.*b?c{2}$|d\\e', `--root=${dynRoot}`]);
    assert.equal(dynMeta.status, 0, dynMeta.stdout + dynMeta.stderr);
    assert.match(dynMeta.stdout, /Tier 1: PASS\s+tests=1\s+pass=1\s+fail=0/);

    // Regression 3.1: Pass 2 --filter in execution mode must never drop dynamic tests when sibling
    // files contain the substring in a comment or static test (same-tier and cross-tier).
    const dynCommentRoot = path.join(tmpRoot, 'dyn-comment-poison-e2e');
    fs.mkdirSync(path.join(dynCommentRoot, 'tier1'), { recursive: true });
    fs.mkdirSync(path.join(dynCommentRoot, 'tier2'), { recursive: true });
    fs.writeFileSync(
      path.join(dynCommentRoot, 'tier1', 'a-dynamic.e2e.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nconst sec = 'peptides';\ntest(\`Section \${sec}: CRUD\`, () => { assert.equal(1, 1); });\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dynCommentRoot, 'tier1', 'b-comment.e2e.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\n// Note: Section peptides is tested in a-dynamic.e2e.test.mjs\ntest('vitamins CRUD', () => { assert.equal(1, 1); });\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dynCommentRoot, 'tier2', 'c-comment.e2e.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\n// Cross-tier comment referencing Section peptides\ntest('bounds check', () => { assert.equal(1, 1); });\n`,
      'utf8'
    );
    const dynSameTierComment = runRunner(['--tier=1', '--filter=Section peptides', `--root=${dynCommentRoot}`]);
    assert.equal(dynSameTierComment.status, 0, dynSameTierComment.stdout + dynSameTierComment.stderr);
    assert.match(dynSameTierComment.stdout, /Tier 1: PASS\s+tests=1\s+pass=1\s+fail=0/);

    const dynAllTierComment = runRunner(['--tier=all', '--filter=Section peptides', `--root=${dynCommentRoot}`]);
    assert.equal(dynAllTierComment.status, 0, dynAllTierComment.stdout + dynAllTierComment.stderr);
    assert.match(dynAllTierComment.stdout, /OVERALL: PASS\s+tests=1\s+pass=1\s+fail=0/);

    const dynFailRoot = path.join(tmpRoot, 'dyn-failing-sibling-e2e');
    fs.mkdirSync(path.join(dynFailRoot, 'tier1'), { recursive: true });
    fs.writeFileSync(
      path.join(dynFailRoot, 'tier1', 'a-dynamic-fail.e2e.test.mjs'),
      `import test from 'node:test';\nconst sec = 'peptides';\ntest(\`Section \${sec}: CRUD\`, () => { throw new Error('DYNAMIC_REGRESSION_BUG'); });\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dynFailRoot, 'tier1', 'b-static-pass.e2e.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('Section peptides: read list', () => { assert.equal(1, 1); });\n`,
      'utf8'
    );
    const dynFailRes = runRunner(['--tier=1', '--filter=Section peptides', `--root=${dynFailRoot}`]);
    assert.equal(dynFailRes.status, 1, 'Failing dynamic test must not be silently dropped alongside static sibling');
    assert.match(dynFailRes.stdout, /Tier 1: FAIL\s+tests=2\s+pass=1\s+fail=1/);

    // Empty tier exits 1
    const emptyRes = runRunner(['--tier=3', `--root=${emptyE2eRoot}`]);
    assert.equal(emptyRes.status, 1);

    // Invalid CLI args exit 2
    assert.equal(runRunner(['--tier=99']).status, 2);
    assert.equal(runRunner(['--unknown-flag']).status, 2);
    assert.equal(runRunner(['--base-url=not-a-url']).status, 2);
    assert.equal(runRunner(['--tier=1', '--selftest']).status, 2);

    // Recursion guard: same target blocked with exit 2
    const blockedActive = runRunner(['--selftest'], { E2E_SELFTEST_ACTIVE: '1' });
    assert.equal(blockedActive.status, 2, 'Active selftest without different root must exit 2');

    const blockedSameTarget = runRunner(['--selftest', `--root=${fakeE2eRoot}`], {
      E2E_SELFTEST_TARGETS: path.resolve(fakeE2eRoot, 'harness-selftest.mjs'),
    });
    assert.equal(blockedSameTarget.status, 2, 'Re-targeting already active selftest must exit 2');

    // Non-recursive distinct target (--root=<fakeE2eRoot>) succeeds cleanly even inside --selftest!
    const nestedDistinct = runRunner(['--selftest', `--root=${fakeE2eRoot}`]);
    assert.equal(nestedDistinct.status, 0, nestedDistinct.stdout + nestedDistinct.stderr);
    assert.match(nestedDistinct.stdout, /Selftest: PASS\s+tests=1\s+pass=1\s+fail=0/);
  });

  // --------------------------------------------------------------------------
  // 20. launchBrowser() & openAuthenticatedPage() (lazy import + live Chromium)
  // --------------------------------------------------------------------------
  it('20. launchBrowser() & openAuthenticatedPage() keep Playwright lazy and verify Chromium auth paths, viewport, errors & leak cleanup', async () => {
    // Verify harness.mjs has zero top-level playwright or internal src/ imports
    const harnessSrc = fs.readFileSync(HARNESS_PATH, 'utf8');
    assert.doesNotMatch(harnessSrc, /^\s*import\s+.*['"]playwright['"]/m);
    assert.doesNotMatch(harnessSrc, /from\s+['"][^'"]*(src|dist|tools)\//);

    const pwDir = path.join(REPO_ROOT, 'node_modules', 'playwright');
    if (!fs.existsSync(pwDir)) {
      await assert.rejects(
        () => launchBrowser(),
        /Playwright is not installed.*node_modules\/playwright/i
      );
      assert.ok(
        process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH.length > 0,
        'PLAYWRIGHT_BROWSERS_PATH must be populated before launch attempt'
      );
      return;
    }

    const countDescendantChromium = () => {
      const out = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
      if (out.status !== 0) return 0;
      const children = new Map();
      const comms = new Map();
      for (const line of out.stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        comms.set(pid, m[3].trim().toLowerCase());
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(pid);
      }
      const seen = new Set();
      const queue = [...(children.get(process.pid) || [])];
      let count = 0;
      while (queue.length > 0) {
        const p = queue.shift();
        if (seen.has(p)) continue;
        seen.add(p);
        const c = comms.get(p) || '';
        if (c.includes('chrom') || c.includes('headless_shell')) count++;
        for (const ch of children.get(p) || []) queue.push(ch);
      }
      return count;
    };

    // Regression H2a: launchBrowser() cleans up Chromium process when newContext() throws
    const beforeLeakCheck = countDescendantChromium();
    await assert.rejects(
      () =>
        launchBrowser({
          contextOptions: { storageState: path.join(tmpRoot, 'nonexistent-storage-state.json') },
        }),
      /ENOENT|no such file/i
    );
    assert.equal(
      countDescendantChromium(),
      beforeLeakCheck,
      'launchBrowser() must not leak Chromium processes if newContext() throws'
    );

    // Regression H2b: viewport: { width: 390, height: 844 } (mobile) & viewport: null preserved
    const mobileHandle = await launchBrowser({ viewport: { width: 390, height: 844 } });
    try {
      assert.deepEqual(mobileHandle.page.viewportSize(), { width: 390, height: 844 });
    } finally {
      await mobileHandle.close();
    }

    const nullVpHandle = await launchBrowser({ viewport: null });
    try {
      assert.equal(nullVpHandle.page.viewportSize(), null);
    } finally {
      await nullVpHandle.close();
    }

    const handle = await launchBrowser();
    try {
      assert.ok(process.env.PLAYWRIGHT_BROWSERS_PATH);

      // Path A: URL-token auth via handle.openAuthenticatedPage
      const pageA = await handle.openAuthenticatedPage(sharedServer.baseUrl, {
        token: sharedServer.adminToken,
      });
      const navTextA = await pageA.locator('[data-testid="nav-sections"]').textContent();
      assert.match(navTextA || '', /Sections Direct Auth/);

      // Path B: Unauthenticated login form fallback via standalone openAuthenticatedPage
      const pageB = await openAuthenticatedPage(handle, sharedServer.baseUrl, {
        passcode: sharedServer.passcode,
      });
      const navTextB = await pageB.locator('[data-testid="nav-sections"]').textContent();
      assert.match(navTextB || '', /Sections Form Auth/);
      assert.equal(handle.pageErrors.length, 0, `Unexpected pageErrors: ${JSON.stringify(handle.pageErrors)}`);

      // Regression H3a: masked <input type="password" name="token"> must NOT be overwritten with passcode
      const pageMasked = await handle.openAuthenticatedPage(`${sharedServer.baseUrl}/masked-token-ui`, {
        token: sharedServer.adminToken,
        passcode: sharedServer.passcode,
      });
      const navMasked = await pageMasked.locator('[data-testid="nav-sections"]').textContent();
      assert.match(navMasked || '', /Sections Masked Token Auth/);

      // Regression H3b: single input matching BOTH token and pass selectors (name="token_pass") guarded by DOM-identity check
      const pageCombined = await handle.openAuthenticatedPage(`${sharedServer.baseUrl}/masked-token-pass-ui`, {
        token: sharedServer.adminToken,
        passcode: sharedServer.passcode,
      });
      const navCombined = await pageCombined.locator('[data-testid="nav-sections"]').textContent();
      assert.match(navCombined || '', /Sections Masked Token Auth/);

      // Regression 3.2: { passcode }-only (no token) on combined credential password input unlocks cleanly
      const pageCombinedPassOnly = await openAuthenticatedPage(
        handle,
        `${sharedServer.baseUrl}/combined-cred-ui`,
        { passcode: sharedServer.passcode }
      );
      const navCombinedPassOnly = await pageCombinedPassOnly
        .locator('[data-testid="nav-sections"]')
        .textContent();
      assert.match(navCombinedPassOnly || '', /Sections Combined Cred Auth/);

      // Regression H3c: dual password inputs (token + passcode) filled distinctly
      const pageDual = await handle.openAuthenticatedPage(`${sharedServer.baseUrl}/dual-pass-ui`, {
        token: sharedServer.adminToken,
        passcode: sharedServer.passcode,
      });
      const navDual = await pageDual.locator('[data-testid="nav-sections"]').textContent();
      assert.match(navDual || '', /Sections Dual Pass Auth/);

      // Regression H4a: standalone openAuthenticatedPage(rawBrowser, ...) closes implicit context/page on failure
      const contextsBefore = handle.browser.contexts().length;
      await assert.rejects(
        () =>
          openAuthenticatedPage(handle.browser, `${sharedServer.baseUrl}/always-locked-ui`, {
            passcode: 'wrong',
            timeoutMs: 1200,
          }),
        /Timeout/i
      );
      assert.equal(
        handle.browser.contexts().length,
        contextsBefore,
        'Standalone openAuthenticatedPage(rawBrowser) must not leak BrowserContext on auth failure'
      );

      // Regression H4b: standalone openAuthenticatedPage(context, ...) closes created page on failure
      const pagesBefore = handle.context.pages().length;
      await assert.rejects(
        () =>
          openAuthenticatedPage(handle.context, `${sharedServer.baseUrl}/always-locked-ui`, {
            passcode: 'wrong',
            timeoutMs: 1200,
          }),
        /Timeout/i
      );
      assert.equal(
        handle.context.pages().length,
        pagesBefore,
        'Standalone openAuthenticatedPage(context) must not leak Page on auth failure'
      );

      // Path C: consoleErrors & pageErrors capture
      const errUrl = `${sharedServer.baseUrl}/?token=${encodeURIComponent(sharedServer.adminToken)}&triggerError=1&triggerPageError=1`;
      await handle.page.goto(errUrl, { waitUntil: 'domcontentloaded' });
      await handle.page.locator('[data-testid="nav-sections"]').waitFor({ state: 'visible' });
      await handle.page.waitForTimeout(100);
      assert.ok(
        handle.consoleErrors.some((e) => e.text.includes('E2E_SELFTEST_CONSOLE_ERR')),
        `Expected consoleErrors to capture E2E_SELFTEST_CONSOLE_ERR, got: ${JSON.stringify(handle.consoleErrors)}`
      );
      assert.ok(
        handle.pageErrors.some((e) => e.message.includes('E2E_SELFTEST_PAGE_ERR')),
        `Expected pageErrors to capture E2E_SELFTEST_PAGE_ERR, got: ${JSON.stringify(handle.pageErrors)}`
      );
    } finally {
      await handle.close();
      // Idempotent second close()
      await handle.close();
    }

    assert.equal(
      countDescendantChromium(),
      beforeLeakCheck,
      'Zero descendant Chromium processes should remain after close()'
    );
  });
});
