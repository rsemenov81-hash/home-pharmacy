/**
 * Tier 2 E2E Suite — Requirement Area C (Boundaries, Negative Paths & Security):
 * Unauthenticated 401/WWW-Authenticate, OAuth 2.1 PKCE/Replay/Passcode/Revocation/CIMD,
 * MCP Read & Propose Scope Enforcement, JSON-RPC 2.0 Error Codes, Incomplete 422,
 * Duplicate/Alias 409, Verified-Field Protection, BYOK 501 Fallback, Context Bundle
 * Secret Redaction & Filtering, Zero-PII Public Discovery, Revocation & CORS Allowlist.
 *
 * Strictly opaque-box: imports ONLY Node 22 built-ins and ../harness.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  startE2EServer,
  createApiClient,
  createMcpClient,
  generatePkcePair,
  runOAuthFlow,
  refreshOAuthToken,
  revokeOAuthToken,
  parseToolJson,
  unwrapData,
  fixtures,
} from '../harness.mjs';

const CANONICAL_READ_TOOLS = [
  'get_hub_overview',
  'list_sections',
  'get_section_schema',
  'search_compounds',
  'get_compound',
  'check_duplicate_compound',
  'get_member_stack',
  'analyze_stack_interactions',
  'suggest_stack_schedule',
  'get_today_schedule',
  'list_proposals',
];

const CANONICAL_PROPOSE_TOOLS = [
  'create_or_propose_compound',
  'enrich_compound',
  'update_compound_ownership',
  'propose_stack_change',
];

const CANONICAL_WRITE_TOOLS = [
  'configure_section',
  'resolve_proposal',
];

const CLEAR_BYOK_ENV = {
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  XAI_API_KEY: undefined,
  GROK_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  LLM_API_KEY: undefined,
  BYOK_API_KEY: undefined,
  BYOK_LLM_API_KEY: undefined,
  AI_API_KEY: undefined,
  MUSE_API_KEY: undefined,
};

function uid(prefix = 't2') {
  return `${prefix}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeOrigin(urlStr) {
  return String(urlStr || '').replace(/\/+$/, '');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function withServer(optionsOrFn, maybeFn) {
  const opts = typeof optionsOrFn === 'function' ? {} : (optionsOrFn || {});
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const server = await startE2EServer(opts);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

function assertNoStore(headers, label = 'response') {
  const cc = headers.get('cache-control');
  assert.ok(
    typeof cc === 'string' && cc.toLowerCase().includes('no-store'),
    `${label}: expected Cache-Control to include 'no-store', got ${JSON.stringify(cc)}`
  );
}

function assertWwwAuthenticateResourceMetadata(headers, origin, label = 'response') {
  const wwwAuth = headers.get('www-authenticate');
  assert.ok(
    typeof wwwAuth === 'string' && /^bearer\b/i.test(wwwAuth.trim()),
    `${label}: expected WWW-Authenticate starting with Bearer, got ${JSON.stringify(wwwAuth)}`
  );
  const expectedUrl = `${origin}/.well-known/oauth-protected-resource`;
  const re = new RegExp(
    `resource_metadata\\s*=\\s*(?:"${escapeRegExp(expectedUrl)}(?:/mcp)?"|${escapeRegExp(expectedUrl)}(?:/mcp)?(?=,|\\s|$))`,
    'i'
  );
  assert.ok(
    re.test(wwwAuth),
    `${label}: expected WWW-Authenticate resource_metadata pointing to ${expectedUrl}, got ${JSON.stringify(wwwAuth)}`
  );
}

async function initMcp(mcp) {
  const initRes = await mcp.initialize({ name: 'home-pharmacy-e2e-tier2', version: '1.0.0' });
  assert.strictEqual(initRes.status, 200, `initialize HTTP status: ${initRes.text}`);
  assert.strictEqual(initRes.error, null, `initialize error: ${JSON.stringify(initRes.error)}`);
  const notifRes = await mcp.notifyInitialized();
  assert.ok([200, 202, 204].includes(notifRes.status));
  return initRes;
}

async function getToolMap(mcp) {
  const res = await mcp.listTools();
  assert.strictEqual(res.status, 200, `tools/list failed: ${res.text}`);
  assert.strictEqual(res.error, null, `tools/list error: ${JSON.stringify(res.error)}`);
  assert.ok(Array.isArray(res.result?.tools), 'tools/list must return result.tools array');
  return new Map(res.result.tools.map((t) => [t.name, t]));
}

function getSchemaProps(tool) {
  const props = tool?.inputSchema?.properties;
  return props && typeof props === 'object' ? props : {};
}

function pickSchemaKey(tool, candidates, fallback) {
  const props = getSchemaProps(tool);
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(props, key)) return key;
  }
  return fallback;
}

function buildCreateCompoundArgs(tool, compoundPayload) {
  const props = getSchemaProps(tool);
  if (Object.prototype.hasOwnProperty.call(props, 'name')) {
    return compoundPayload;
  }
  for (const wrapper of ['compound', 'profile', 'payload', 'data']) {
    if (Object.prototype.hasOwnProperty.call(props, wrapper)) {
      return { [wrapper]: compoundPayload };
    }
  }
  return compoundPayload;
}

function buildEnrichCompoundArgs(tool, compoundId, patchFields) {
  const props = getSchemaProps(tool);
  const idKey = pickSchemaKey(tool, ['compoundId', 'id'], 'compoundId');
  for (const wrapper of ['patch', 'updates', 'fields', 'changes', 'data']) {
    if (
      Object.prototype.hasOwnProperty.call(props, wrapper) &&
      !Object.prototype.hasOwnProperty.call(props, 'summary')
    ) {
      return { [idKey]: compoundId, [wrapper]: patchFields };
    }
  }
  return { [idKey]: compoundId, ...patchFields };
}

function buildConfigureSectionArgs(tool, sectionId, patch) {
  const props = getSchemaProps(tool);
  const sectionKey = pickSchemaKey(tool, ['sectionId', 'id', 'section'], 'sectionId');
  for (const wrapper of ['patch', 'updates', 'config', 'changes']) {
    if (
      Object.prototype.hasOwnProperty.call(props, wrapper) &&
      !Object.prototype.hasOwnProperty.call(props, 'customFields')
    ) {
      return { [sectionKey]: sectionId, [wrapper]: patch };
    }
  }
  return { [sectionKey]: sectionId, ...patch };
}

function buildProposeStackChangeArgs(tool, { memberId, stackId, item, rationale }) {
  const props = getSchemaProps(tool);
  const memberKey = pickSchemaKey(tool, ['memberId', 'member'], 'memberId');
  const out = { [memberKey]: memberId };

  if (stackId) {
    const stackKey = pickSchemaKey(tool, ['stackId', 'stack'], 'stackId');
    if (Object.keys(props).length === 0 || Object.prototype.hasOwnProperty.call(props, stackKey)) {
      out[stackKey] = stackId;
    }
  }

  const rationaleKey = pickSchemaKey(tool, ['rationale', 'summary', 'reason', 'note'], 'rationale');
  out[rationaleKey] = rationale;

  const hasProps = Object.keys(props).length > 0;
  if (hasProps && Object.prototype.hasOwnProperty.call(props, 'changes')) {
    out.changes =
      props.changes?.type === 'array' ? [{ action: 'add', ...item }] : { add: [item], items: [item] };
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'add')) {
    out.add = props.add?.items?.type === 'string' ? [item.compoundId] : [item];
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'items')) {
    out.items = [item];
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'patch')) {
    out.patch = { add: [item], items: [item] };
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'compoundId')) {
    out.compoundId = item.compoundId;
    const opKey = pickSchemaKey(tool, ['action', 'operation', 'changeType'], 'action');
    if (Object.prototype.hasOwnProperty.call(props, opKey)) {
      const enumVals = props[opKey]?.enum;
      out[opKey] = Array.isArray(enumVals)
        ? (enumVals.find((v) => /add/i.test(String(v))) ?? enumVals[0])
        : 'add';
    }
    if (Object.prototype.hasOwnProperty.call(props, 'item')) out.item = item;
    if (Object.prototype.hasOwnProperty.call(props, 'doseAmount')) out.doseAmount = item.doseAmount;
    if (Object.prototype.hasOwnProperty.call(props, 'doseUnit')) out.doseUnit = item.doseUnit;
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'item')) {
    out.item = item;
    const opKey = pickSchemaKey(tool, ['action', 'operation', 'changeType'], 'action');
    if (Object.prototype.hasOwnProperty.call(props, opKey)) {
      const enumVals = props[opKey]?.enum;
      out[opKey] = Array.isArray(enumVals)
        ? (enumVals.find((v) => /add/i.test(String(v))) ?? enumVals[0])
        : 'add';
    }
  } else {
    out.action = 'add';
    out.compoundId = item.compoundId;
    out.item = item;
    out.items = [item];
    out.changes = { add: [item] };
  }

  return out;
}

function buildResolveProposalArgs(tool, proposalId, action) {
  const idKey = pickSchemaKey(tool, ['proposalId', 'id'], 'proposalId');
  const actionKey = pickSchemaKey(tool, ['action', 'decision', 'resolution'], 'action');
  return { [idKey]: proposalId, [actionKey]: action };
}

function extractKeyCreateResult(res) {
  const root = res.json && typeof res.json === 'object' ? res.json : {};
  const body =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;
  const isPlainObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
  const keyObj =
    (isPlainObj(body.key) ? body.key : null) ??
    (isPlainObj(body.apiKey) ? body.apiKey : null) ??
    (isPlainObj(root.key) ? root.key : null) ??
    (isPlainObj(root.apiKey) ? root.apiKey : null) ??
    body;
  const keyId = keyObj?.id ?? body?.id ?? root?.id ?? null;
  const firstNonEmptyStr = (...vals) =>
    vals.find((v) => typeof v === 'string' && v.length > 0) ?? null;
  const rawSecret = firstNonEmptyStr(
    body?.secret,
    body?.rawKey,
    body?.rawSecret,
    body?.plainKey,
    body?.token,
    body?.key,
    body?.apiKey,
    root?.secret,
    root?.rawKey,
    root?.rawSecret,
    root?.plainKey,
    root?.token,
    root?.key,
    root?.apiKey,
    keyObj?.secret,
    keyObj?.rawKey,
    keyObj?.rawSecret,
    keyObj?.plainKey,
    keyObj?.token,
    keyObj?.key,
    keyObj?.apiKey
  );
  return { keyObj, keyId, rawSecret };
}

async function mintApiKey(api, { name, scope, memberId = 'member_wife', actor }) {
  const body = { name, scope, memberId };
  if (actor) body.actor = actor;
  const res = await api.post('/api/v1/keys', body);
  assert.ok(res.status === 201 || res.status === 200, `POST /api/v1/keys failed (${res.status}): ${res.text}`);
  const { keyObj, keyId, rawSecret } = extractKeyCreateResult(res);
  assert.ok(typeof keyId === 'string' && keyId.length > 0);
  assert.ok(typeof rawSecret === 'string' && rawSecret.length >= 8);
  return { keyObj, keyId, rawSecret };
}

async function createCompoundApi(api, payload) {
  const res = await api.post('/api/v1/compounds', payload);
  assert.ok(res.status === 201 || res.status === 200, `POST /api/v1/compounds failed (${res.status}): ${res.text}`);
  const comp = unwrapData(res.json, ['compound', 'profile']);
  assert.ok(typeof comp?.id === 'string' && comp.id.length > 0);
  return comp;
}

async function listCompoundsApi(api) {
  const res = await api.get('/api/v1/compounds');
  assert.strictEqual(res.status, 200, `GET /api/v1/compounds failed (${res.status}): ${res.text}`);
  const list = unwrapData(res.json, ['compounds', 'items']);
  assert.ok(Array.isArray(list), 'GET /api/v1/compounds must return array');
  return list;
}

async function listProposalsApi(api) {
  const res = await api.get('/api/v1/proposals');
  assert.strictEqual(res.status, 200, `GET /api/v1/proposals failed (${res.status}): ${res.text}`);
  const list = unwrapData(res.json, ['proposals', 'items']);
  assert.ok(Array.isArray(list), 'GET /api/v1/proposals must return array');
  return list;
}

function collectMcpErrorText(res) {
  const parts = [];
  if (res.text) parts.push(res.text);
  if (res.error) parts.push(JSON.stringify(res.error));
  const parsed = parseToolJson(res, { allowNull: true });
  if (parsed !== null) parts.push(JSON.stringify(parsed));
  if (Array.isArray(res.result?.content)) {
    for (const item of res.result.content) {
      if (typeof item?.text === 'string') parts.push(item.text);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated POST /mcp Returns 401 + RFC 9728 WWW-Authenticate
// ---------------------------------------------------------------------------
test('T2-C01: unauthenticated, invalid Bearer & invalid ?token= POST /mcp return 401 with RFC 9728 WWW-Authenticate', async () => {
  await withServer(async (server) => {
    const unauthMcp = createMcpClient({ baseUrl: server.baseUrl });
    const resUnauth = await unauthMcp.call(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'unauth-client', version: '1.0.0' },
      },
      1,
      { auth: false }
    );
    assert.strictEqual(resUnauth.status, 401, `unauthenticated POST /mcp must return 401, got ${resUnauth.status}`);
    assertNoStore(resUnauth.headers, 'unauth POST /mcp');
    assertWwwAuthenticateResourceMetadata(resUnauth.headers, server.origin, 'unauth POST /mcp');

    // Invalid Bearer token
    const badBearerMcp = createMcpClient({
      baseUrl: server.baseUrl,
      token: `invalid_bearer_${uid()}`,
    });
    const resBadBearer = await badBearerMcp.ping();
    assert.strictEqual(resBadBearer.status, 401, 'invalid Bearer token on /mcp must return 401');
    assertNoStore(resBadBearer.headers, 'invalid Bearer POST /mcp');
    assertWwwAuthenticateResourceMetadata(resBadBearer.headers, server.origin, 'invalid Bearer POST /mcp');

    // Invalid ?token= query token
    const badQueryMcp = createMcpClient({
      baseUrl: server.baseUrl,
      token: `invalid_query_${uid()}`,
      tokenInQuery: true,
    });
    const resBadQuery = await badQueryMcp.ping();
    assert.strictEqual(resBadQuery.status, 401, 'invalid ?token= on /mcp must return 401');
    assertNoStore(resBadQuery.headers, 'invalid ?token= POST /mcp');
    assertWwwAuthenticateResourceMetadata(resBadQuery.headers, server.origin, 'invalid ?token= POST /mcp');
  });
});

// ---------------------------------------------------------------------------
// 2. OAuth 2.1 PKCE Enforcement Failures
// ---------------------------------------------------------------------------
test('T2-C02: OAuth 2.1 PKCE failures (wrong code_verifier -> 400, missing code_challenge & plain method rejected)', async () => {
  await withServer(async (server) => {
    const isCleanPkceRejection = (flow) =>
      (flow.authorizeGet?.status >= 400 && flow.authorizeGet?.status < 500) ||
      (flow.authorizeGet?.status >= 300 &&
        flow.authorizeGet?.status < 400 &&
        Boolean(flow.callback?.error)) ||
      (flow.authorizePost?.status >= 400 && flow.authorizePost?.status < 500) ||
      (flow.authorizePost?.status >= 300 &&
        flow.authorizePost?.status < 400 &&
        Boolean(flow.callback?.error));

    // Case A: Wrong PKCE code_verifier at /oauth/token
    const wrongVerFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      wrongVerifier: true,
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(wrongVerFlow.ok, false, 'wrong PKCE verifier must NOT succeed');
    assert.ok(typeof wrongVerFlow.code === 'string' && wrongVerFlow.code.length > 0, 'flow must reach token exchange');
    assert.strictEqual(wrongVerFlow.accessToken, null, 'wrong verifier must NOT return access_token');
    assert.strictEqual(
      wrongVerFlow.tokenResponse?.status,
      400,
      `wrong PKCE verifier must return HTTP 400 at /oauth/token, got ${wrongVerFlow.tokenResponse?.status}`
    );
    assertNoStore(wrongVerFlow.tokenResponse.headers, 'wrong verifier /oauth/token');
    assert.strictEqual(wrongVerFlow.tokenResponse.json?.access_token, undefined);
    assert.ok(
      typeof wrongVerFlow.tokenResponse.json?.error === 'string' && wrongVerFlow.tokenResponse.json.error.length > 0,
      'wrong verifier must return OAuth error code'
    );

    // Case B: Missing code_challenge at /oauth/authorize
    const missingChallenge = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      customAuthorizeQuery: { code_challenge: null },
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(missingChallenge.ok, false, 'missing code_challenge must be rejected');
    assert.strictEqual(missingChallenge.code, null, 'missing code_challenge must NEVER issue an auth code');
    assert.strictEqual(missingChallenge.accessToken, null);
    assert.ok(
      (missingChallenge.authorizeGet?.status ?? 0) < 500 &&
        (missingChallenge.authorizePost?.status ?? 0) < 500,
      `missing code_challenge must NOT trigger 5xx (get=${missingChallenge.authorizeGet?.status}, post=${missingChallenge.authorizePost?.status})`
    );
    assert.ok(
      isCleanPkceRejection(missingChallenge),
      `missing code_challenge must be rejected cleanly via 4xx or 3xx+error (get=${missingChallenge.authorizeGet?.status}, post=${missingChallenge.authorizePost?.status}, callback=${JSON.stringify(missingChallenge.callback)})`
    );

    // Case C: Downgraded code_challenge_method=plain rejected
    const plainMethod = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      customAuthorizeQuery: {
        code_challenge_method: 'plain',
        code_challenge: 'plain_text_pkce_challenge_must_fail_1234567890',
      },
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(plainMethod.ok, false, 'code_challenge_method=plain must be rejected');
    assert.strictEqual(plainMethod.code, null, 'plain PKCE method must NEVER issue an auth code');
    assert.strictEqual(plainMethod.accessToken, null);
    assert.ok(
      (plainMethod.authorizeGet?.status ?? 0) < 500 &&
        (plainMethod.authorizePost?.status ?? 0) < 500,
      `plain PKCE method must NOT trigger 5xx (get=${plainMethod.authorizeGet?.status}, post=${plainMethod.authorizePost?.status})`
    );
    assert.ok(
      isCleanPkceRejection(plainMethod),
      `plain PKCE method must be rejected cleanly via 4xx or 3xx+error (get=${plainMethod.authorizeGet?.status}, post=${plainMethod.authorizePost?.status}, callback=${JSON.stringify(plainMethod.callback)})`
    );
  });
});

// ---------------------------------------------------------------------------
// 3. OAuth 2.1 Auth Code Single-Use Replay, Wrong Passcode & Denied Consent
// ---------------------------------------------------------------------------
test('T2-C03: OAuth 2.1 single-use auth code replay rejected 400; wrong passcode & denied consent issue no code', async () => {
  await withServer(async (server) => {
    const resource = `${server.origin}/mcp`;

    // Case A: Single-use authorization code replay
    const validFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      resource,
    });
    assert.strictEqual(validFlow.ok, true, `initial valid flow failed: ${validFlow.error}`);
    assert.ok(typeof validFlow.code === 'string' && validFlow.code.length > 0);

    const pubApi = createApiClient({ baseUrl: server.baseUrl });
    const replayParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: validFlow.code,
      redirect_uri: validFlow.redirectUri,
      client_id: validFlow.clientId,
      code_verifier: validFlow.pkce.codeVerifier,
      resource,
    });
    if (validFlow.clientSecret) replayParams.set('client_secret', validFlow.clientSecret);

    const replayRes = await pubApi.post(validFlow.endpoints.tokenEndpoint, replayParams.toString(), {
      auth: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.strictEqual(
      replayRes.status,
      400,
      `replaying already-redeemed auth code must return 400, got ${replayRes.status}: ${replayRes.text}`
    );
    assert.strictEqual(replayRes.json?.access_token, undefined, 'code replay must NOT mint access_token');
    assert.ok(typeof replayRes.json?.error === 'string' && replayRes.json.error.length > 0);

    // Case B: Wrong household passcode
    const wrongPassFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      wrongPasscode: true,
      resource,
    });
    assert.strictEqual(wrongPassFlow.ok, false, 'wrong household passcode must NOT authorize');
    assert.strictEqual(wrongPassFlow.code, null, 'wrong household passcode must NEVER issue an auth code');
    assert.strictEqual(wrongPassFlow.accessToken, null);
    assert.strictEqual(wrongPassFlow.tokenResponse, null);
    assert.ok(wrongPassFlow.authorizePost !== null, 'must submit POST /oauth/authorize');
    const wpStatus = wrongPassFlow.authorizePost.status;
    assert.ok(wpStatus < 500, `wrong household passcode must NOT crash server with 5xx, got ${wpStatus}`);
    assert.ok(
      wpStatus === 200 ||
        (wpStatus >= 400 && wpStatus < 500) ||
        (wpStatus >= 300 && wpStatus < 400 && Boolean(wrongPassFlow.callback?.error)),
      `wrong passcode must return 4xx, re-rendered 200 error form, or 3xx with callback.error, got status=${wpStatus}, callback=${JSON.stringify(wrongPassFlow.callback)}`
    );
    assert.ok(
      !String(wrongPassFlow.redirectLocation || '').includes('code='),
      'wrong passcode must never redirect with code='
    );

    // Case C: Denied consent
    const denyFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      denyConsent: true,
      resource,
    });
    assert.strictEqual(denyFlow.ok, false, 'denied consent must NOT authorize');
    assert.strictEqual(denyFlow.code, null, 'denied consent must NEVER issue an auth code');
    assert.strictEqual(denyFlow.accessToken, null);
    assert.strictEqual(denyFlow.tokenResponse, null);
    assert.ok(denyFlow.authorizePost !== null, 'must submit POST /oauth/authorize deny');
    const denyStatus = denyFlow.authorizePost.status;
    assert.ok(denyStatus < 500, `denied consent must NOT crash server with 5xx, got ${denyStatus}`);
    assert.ok(
      denyStatus === 200 ||
        (denyStatus >= 400 && denyStatus < 500) ||
        (denyStatus >= 300 && denyStatus < 400 && Boolean(denyFlow.callback?.error)),
      `denied consent must return 4xx, 200 denial page, or 3xx with callback.error, got status=${denyStatus}, callback=${JSON.stringify(denyFlow.callback)}`
    );
    assert.ok(
      !String(denyFlow.redirectLocation || '').includes('code='),
      'denied consent must never redirect with code='
    );
  });
});

// ---------------------------------------------------------------------------
// 4. OAuth 2.1 Revoked Tokens & Rotated-Out Refresh Token Rejection
// ---------------------------------------------------------------------------
test('T2-C04: OAuth 2.1 revoked access token (401), revoked refresh token & rotated-out refresh token replay rejected', async () => {
  await withServer(async (server) => {
    const resource = `${server.origin}/mcp`;

    // Flow A: Active access-token revocation on a fresh, uncompromised token (decoupled from refresh reuse detection)
    const flowA = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      resource,
    });
    assert.strictEqual(flowA.ok, true, `flowA failed: ${flowA.error}`);

    const mcpLiveA = createMcpClient({ baseUrl: server.baseUrl, token: flowA.accessToken });
    const livePingA = await mcpLiveA.ping();
    assert.strictEqual(livePingA.status, 200, 'fresh access token must return 200 on /mcp immediately before /oauth/revoke');

    const apiLiveA = createApiClient({ baseUrl: server.baseUrl, token: flowA.accessToken });
    const liveRestA = await apiLiveA.get('/api/v1/sections');
    assert.strictEqual(liveRestA.status, 200, 'fresh access token must return 200 on /api/v1/* immediately before /oauth/revoke');

    const revAccess = await revokeOAuthToken({
      baseUrl: server.baseUrl,
      revocationEndpoint: flowA.endpoints.revocationEndpoint,
      token: flowA.accessToken,
      tokenTypeHint: 'access_token',
      clientId: flowA.clientId,
      clientSecret: flowA.clientSecret || undefined,
    });
    assert.ok(revAccess.status === 200 || revAccess.status === 204, `POST /oauth/revoke access_token failed: ${revAccess.status}`);

    const mcpPingAfterRevoke = await mcpLiveA.ping();
    assert.strictEqual(mcpPingAfterRevoke.status, 401, 'revoked access token must return 401 on /mcp');

    const restAfterRevoke = await apiLiveA.get('/api/v1/sections');
    assert.strictEqual(restAfterRevoke.status, 401, 'revoked access token must return 401 on /api/v1/*');

    // Flow B: Refresh token rotation + rotated-out refresh token replay rejection
    const flowB = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      resource,
    });
    assert.strictEqual(flowB.ok, true, `flowB failed: ${flowB.error}`);

    const rotated = await refreshOAuthToken({
      baseUrl: server.baseUrl,
      tokenEndpoint: flowB.endpoints.tokenEndpoint,
      refreshToken: flowB.refreshToken,
      clientId: flowB.clientId,
      clientSecret: flowB.clientSecret || undefined,
      resource,
    });
    assert.strictEqual(rotated.status, 200, `refresh rotation failed (${rotated.status}): ${rotated.text}`);
    assert.strictEqual(rotated.ok, true);
    assert.ok(
      typeof rotated.accessToken === 'string' && rotated.accessToken.length > 0,
      'rotated response must return non-empty access_token'
    );
    assert.ok(
      typeof rotated.refreshToken === 'string' && rotated.refreshToken.length > 0,
      'rotated response must return non-empty refresh_token'
    );
    assert.notStrictEqual(rotated.refreshToken, flowB.refreshToken, 'refresh must rotate refresh_token');

    const mcpRotated = createMcpClient({ baseUrl: server.baseUrl, token: rotated.accessToken });
    const pingRotated = await mcpRotated.ping();
    assert.strictEqual(pingRotated.status, 200, 'rotated access token must be live before old refresh replay');

    // Replay rotated-out old refresh token (may also trigger OAuth 2.1 §4.3.1 family revocation)
    const replayOldRefresh = await refreshOAuthToken({
      baseUrl: server.baseUrl,
      tokenEndpoint: flowB.endpoints.tokenEndpoint,
      refreshToken: flowB.refreshToken,
      clientId: flowB.clientId,
      clientSecret: flowB.clientSecret || undefined,
      resource,
    });
    assert.ok(
      replayOldRefresh.status === 400 || replayOldRefresh.status === 401,
      `rotated-out refresh token replay must return 400/401, got ${replayOldRefresh.status}`
    );
    assert.strictEqual(replayOldRefresh.ok, false);
    assert.strictEqual(replayOldRefresh.accessToken, null);

    // Flow C: Revoke refresh token directly and assert it cannot mint new tokens
    const flowC = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      resource,
    });
    assert.strictEqual(flowC.ok, true, `flowC failed: ${flowC.error}`);

    const revRefresh = await revokeOAuthToken({
      baseUrl: server.baseUrl,
      revocationEndpoint: flowC.endpoints.revocationEndpoint,
      token: flowC.refreshToken,
      tokenTypeHint: 'refresh_token',
      clientId: flowC.clientId,
      clientSecret: flowC.clientSecret || undefined,
    });
    assert.ok(revRefresh.status === 200 || revRefresh.status === 204);

    const useRevokedRefresh = await refreshOAuthToken({
      baseUrl: server.baseUrl,
      tokenEndpoint: flowC.endpoints.tokenEndpoint,
      refreshToken: flowC.refreshToken,
      clientId: flowC.clientId,
      clientSecret: flowC.clientSecret || undefined,
      resource,
    });
    assert.ok(
      useRevokedRefresh.status === 400 || useRevokedRefresh.status === 401,
      `revoked refresh token must return 400/401, got ${useRevokedRefresh.status}`
    );
    assert.strictEqual(useRevokedRefresh.ok, false);
    assert.strictEqual(useRevokedRefresh.accessToken, null);
  });
});

// ---------------------------------------------------------------------------
// 5. OAuth 2.1 CIMD HTTPS URL client_id & redirect_uri Validation
// ---------------------------------------------------------------------------
test('T2-C05: OAuth 2.1 valid HTTPS CIMD client_id succeeds; malicious client_ids & mismatched redirect_uri rejected', async () => {
  await withServer(async (server) => {
    const resource = `${server.origin}/mcp`;

    // Case A: Valid HTTPS CIMD client_id (skips DCR; manual redirect -> zero outbound network call)
    const cimdFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      clientId: 'https://chatgpt.com/oauth/client.json',
      redirectUri: 'https://chatgpt.com/oauth/callback',
      resource,
    });
    assert.strictEqual(cimdFlow.registration, null, 'CIMD flow must skip DCR');
    assert.strictEqual(cimdFlow.ok, true, `valid HTTPS CIMD flow failed: ${cimdFlow.error}`);
    assert.strictEqual(cimdFlow.authorizePost?.status, 302);
    assert.strictEqual(normalizeOrigin(cimdFlow.iss), server.origin);
    assert.ok(typeof cimdFlow.accessToken === 'string' && cimdFlow.accessToken.length > 0);

    const mcpCimd = createMcpClient({ baseUrl: server.baseUrl, token: cimdFlow.accessToken });
    const cimdPing = await mcpCimd.ping();
    assert.strictEqual(cimdPing.status, 200, 'token from valid HTTPS CIMD flow must work on /mcp');
    assert.strictEqual(cimdPing.error, null);

    // Case B: Invalid / malicious client_id values must be rejected directly with 4xx (never 5xx or open redirect)
    for (const badClientId of [
      'javascript:alert(1)',
      'http://evil.example/client.json',
      `unregistered_bare_client_${uid()}`,
    ]) {
      const badFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        scope: 'read',
        clientId: badClientId,
        redirectUri: 'https://evil.example/callback',
        skipDiscovery: true,
        resource,
      });
      assert.strictEqual(badFlow.ok, false, `malicious/invalid client_id '${badClientId}' must fail`);
      assert.strictEqual(badFlow.code, null, `invalid client_id '${badClientId}' must NEVER issue a code`);
      assert.strictEqual(badFlow.accessToken, null);
      const terminalStatus = badFlow.authorizePost?.status ?? badFlow.authorizeGet?.status;
      assert.ok(
        [400, 401, 403].includes(terminalStatus),
        `malicious/invalid client_id '${badClientId}' must return 400/401/403 (never 5xx or 3xx open redirect), got status=${terminalStatus} (get=${badFlow.authorizeGet?.status}, post=${badFlow.authorizePost?.status})`
      );
      const badLoc = String(
        badFlow.redirectLocation ||
          badFlow.authorizePost?.headers?.get('location') ||
          badFlow.authorizeGet?.headers?.get('location') ||
          ''
      );
      assert.ok(
        !badLoc.includes('evil.example'),
        `invalid client_id '${badClientId}' must NEVER open-redirect to evil.example (RFC 6749 §4.1.2.1), got Location=${JSON.stringify(badLoc)}`
      );
      assert.ok(
        !badLoc.includes('code='),
        `invalid client_id '${badClientId}' must never redirect with code=`
      );
    }

    // Case C: Mismatched redirect_uri on registered DCR client
    const pubApi = createApiClient({ baseUrl: server.baseUrl });
    const regRes = await pubApi.post(
      '/oauth/register',
      {
        client_name: `Redirect Check ${uid()}`,
        redirect_uris: ['http://127.0.0.1:19999/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'read',
      },
      { auth: false }
    );
    assert.strictEqual(regRes.status, 201, `DCR failed: ${regRes.text}`);
    const regClientId = regRes.json?.client_id;
    assert.ok(typeof regClientId === 'string' && regClientId.length > 0);

    const pkce = generatePkcePair();
    const mismatchRes = await pubApi.get('/oauth/authorize', {
      auth: false,
      redirect: 'manual',
      query: {
        response_type: 'code',
        client_id: regClientId,
        redirect_uri: 'https://evil.example/steal',
        scope: 'read',
        state: uid('st'),
        code_challenge: pkce.codeChallenge,
        code_challenge_method: 'S256',
      },
    });
    assert.ok(
      mismatchRes.status === 400 || mismatchRes.status === 403,
      `mismatched redirect_uri must return 400/403 (never redirect), got ${mismatchRes.status}`
    );
    const mismatchLoc = mismatchRes.headers.get('location') || '';
    assert.ok(!mismatchLoc.includes('evil.example'), 'must NEVER redirect to mismatched redirect_uri');
    assert.ok(!mismatchLoc.includes('code='), 'must NEVER issue code on mismatched redirect_uri');
  });
});

// ---------------------------------------------------------------------------
// 6. MCP Scope Enforcement — read Token
// ---------------------------------------------------------------------------
test('T2-C06: MCP read scope lists exact 11 read tools, rejects write/propose tools/call & mutates zero state', async () => {
  await withServer(async (server) => {
    const tag = uid('rscope');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Seed verified compound + pending proposal with distinct tag-scoped aliases (no F20 dedup collision)
    const baseComp = await createCompoundApi(
      adminApi,
      fixtures.makePeptideCompound({
        name: `BaseReadScope ${tag}`,
        canonicalMolecule: `brs-${tag}`,
        aliases: [`BaseReadScopeAlias ${tag}`],
      })
    );
    const verRes = await adminApi.post(`/api/v1/compounds/${encodeURIComponent(baseComp.id)}/verify`, {});
    assert.ok(verRes.status === 200 || verRes.status === 201);

    const { rawSecret: proposeKey } = await mintApiKey(adminApi, {
      name: `Seed Proposal ${tag}`,
      scope: 'propose',
      actor: 'ai:claude',
    });
    const mcpWrite = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    await initMcp(mcpWrite);
    const writeToolMap = await getToolMap(mcpWrite);

    const mcpSeeder = createMcpClient({ baseUrl: server.baseUrl, token: proposeKey });
    await initMcp(mcpSeeder);
    const beforeProps = new Set((await listProposalsApi(adminApi)).map((p) => p.id));
    const seedPropRes = await mcpSeeder.callTool(
      'enrich_compound',
      buildEnrichCompoundArgs(writeToolMap.get('enrich_compound'), baseComp.id, {
        summary: `Pending proposal target ${tag}`,
      })
    );
    assert.strictEqual(seedPropRes.status, 200, `seed proposal enrich_compound HTTP failed: ${seedPropRes.text}`);
    const pendingProposal = (await listProposalsApi(adminApi)).find(
      (p) => !beforeProps.has(p.id) && p.status === 'pending'
    );
    assert.ok(pendingProposal, 'must have real pending proposal for scope enforcement test');

    const beforeCompCount = (await listCompoundsApi(adminApi)).length;
    const blockedFieldKey = `read_blocked_${tag.slice(-6)}`;

    // Obtain read-scoped OAuth token
    const readFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(readFlow.ok, true, `read OAuth flow failed: ${readFlow.error}`);

    const mcpRead = createMcpClient({ baseUrl: server.baseUrl, token: readFlow.accessToken });
    await initMcp(mcpRead);

    // 1. tools/list must contain ONLY the 11 canonical read tools
    const listRes = await mcpRead.listTools();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.error, null);
    const readToolNames = (listRes.result?.tools || []).map((t) => t.name);
    assert.deepEqual(
      [...readToolNames].sort(),
      [...CANONICAL_READ_TOOLS].sort(),
      'read scope tools/list must expose the exact 11 read tools and omit all 6 propose/write tools'
    );
    for (const forbidden of [...CANONICAL_PROPOSE_TOOLS, ...CANONICAL_WRITE_TOOLS]) {
      assert.ok(!readToolNames.includes(forbidden), `read tools/list must omit '${forbidden}'`);
    }

    // 2. Direct tools/call to propose/write tools with valid arguments must be rejected (403 or JSON-RPC error)
    const callCreate = await mcpRead.callTool(
      'create_or_propose_compound',
      buildCreateCompoundArgs(
        writeToolMap.get('create_or_propose_compound'),
        fixtures.makePeptideCompound({
          name: `ReadBlockedCompound ${tag}`,
          canonicalMolecule: `rbc-${tag}`,
          aliases: [`ReadBlockedAlias ${tag}`],
        })
      )
    );
    assert.ok(
      callCreate.status === 403 || callCreate.error !== null,
      `read token calling create_or_propose_compound must return 403 or JSON-RPC error, got status=${callCreate.status}, body=${callCreate.text}`
    );

    const callConfig = await mcpRead.callTool(
      'configure_section',
      buildConfigureSectionArgs(writeToolMap.get('configure_section'), 'peptides', {
        customFields: [fixtures.makeCustomSectionField({ key: blockedFieldKey })],
      })
    );
    assert.ok(
      callConfig.status === 403 || callConfig.error !== null,
      `read token calling configure_section must return 403 or JSON-RPC error, got status=${callConfig.status}, body=${callConfig.text}`
    );

    const callResolve = await mcpRead.callTool(
      'resolve_proposal',
      buildResolveProposalArgs(writeToolMap.get('resolve_proposal'), pendingProposal.id, 'approve')
    );
    assert.ok(
      callResolve.status === 403 || callResolve.error !== null,
      `read token calling resolve_proposal must return 403 or JSON-RPC error, got status=${callResolve.status}, body=${callResolve.text}`
    );

    // 3. Side-effect invariance checks
    const afterComps = await listCompoundsApi(adminApi);
    assert.strictEqual(afterComps.length, beforeCompCount, 'blocked create_or_propose_compound must not create compound');
    assert.ok(!afterComps.some((c) => c.name === `ReadBlockedCompound ${tag}`));

    const pepSecRes = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(pepSecRes.status, 200);
    assert.ok(!pepSecRes.text.includes(blockedFieldKey), 'blocked configure_section must not alter peptides section');

    const propAfter = (await listProposalsApi(adminApi)).find((p) => p.id === pendingProposal.id);
    assert.strictEqual(propAfter?.status, 'pending', 'blocked resolve_proposal must leave proposal pending');
  });
});

// ---------------------------------------------------------------------------
// 7. MCP Scope Enforcement — propose Token
// ---------------------------------------------------------------------------
test('T2-C07: MCP propose scope lists exact 15 tools, allows propose tools & rejects write-only tools with zero mutations', async () => {
  await withServer(async (server) => {
    const tag = uid('pscope');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Capture full schema via admin write MCP client for constructing valid write-tool args
    const mcpWrite = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    await initMcp(mcpWrite);
    const writeToolMap = await getToolMap(mcpWrite);

    // Seed compounds & active stack for member_wife with distinct tag-scoped aliases (no F20 dedup collision)
    const c1 = await createCompoundApi(
      adminApi,
      fixtures.makePeptideCompound({
        name: `StackBase ${tag}`,
        canonicalMolecule: `sb-${tag}`,
        aliases: [`StackBaseAlias ${tag}`],
      })
    );
    const c2 = await createCompoundApi(
      adminApi,
      fixtures.makeSupplementCompound({
        name: `StackCandidate ${tag}`,
        canonicalMolecule: `sc-${tag}`,
        aliases: [`StackCandidateAlias ${tag}`],
      })
    );
    const stackRes = await adminApi.post(
      '/api/v1/members/member_wife/stacks',
      fixtures.makeStackPayload({
        name: `ProposeScopeStack ${tag}`,
        memberId: 'member_wife',
        active: true,
        items: [fixtures.makeStackItem({ compoundId: c1.id })],
      })
    );
    assert.ok(stackRes.status === 201 || stackRes.status === 200);
    const stack = unwrapData(stackRes.json, ['stack']);

    // Obtain propose-scoped OAuth token
    const proposeFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(proposeFlow.ok, true, `propose OAuth flow failed: ${proposeFlow.error}`);

    const mcpPropose = createMcpClient({ baseUrl: server.baseUrl, token: proposeFlow.accessToken });
    await initMcp(mcpPropose);

    // 1. tools/list must contain exact 15 read + propose tools and OMIT write-only tools
    const listRes = await mcpPropose.listTools();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.error, null);
    const proposeToolNames = (listRes.result?.tools || []).map((t) => t.name);
    const expected15 = [...CANONICAL_READ_TOOLS, ...CANONICAL_PROPOSE_TOOLS];
    assert.deepEqual(
      [...proposeToolNames].sort(),
      [...expected15].sort(),
      'propose scope tools/list must expose exact 15 read+propose tools'
    );
    for (const writeOnly of CANONICAL_WRITE_TOOLS) {
      assert.ok(!proposeToolNames.includes(writeOnly), `propose tools/list must omit write-only '${writeOnly}'`);
    }

    // 2. Propose tools MUST SUCCEED
    const createOk = await mcpPropose.callTool(
      'create_or_propose_compound',
      buildCreateCompoundArgs(
        writeToolMap.get('create_or_propose_compound'),
        fixtures.makePeptideCompound({
          name: `ProposeAllowed ${tag}`,
          canonicalMolecule: `pa-${tag}`,
          aliases: [`ProposeAllowedAlias ${tag}`],
        })
      )
    );
    assert.strictEqual(createOk.status, 200, `propose create_or_propose_compound failed: ${createOk.text}`);
    assert.strictEqual(createOk.error, null);
    assert.notStrictEqual(createOk.result?.isError, true, `create_or_propose_compound isError: ${createOk.text}`);

    const beforePropIds = new Set((await listProposalsApi(adminApi)).map((p) => p.id));
    const stackPropOk = await mcpPropose.callTool(
      'propose_stack_change',
      buildProposeStackChangeArgs(writeToolMap.get('propose_stack_change'), {
        memberId: 'member_wife',
        stackId: stack.id,
        item: fixtures.makeStackItem({ compoundId: c2.id, doseAmount: 200, doseUnit: 'mg' }),
        rationale: `Propose adding supplement (${tag})`,
      })
    );
    assert.strictEqual(stackPropOk.status, 200, `propose_stack_change failed: ${stackPropOk.text}`);
    assert.strictEqual(stackPropOk.error, null);
    assert.notStrictEqual(stackPropOk.result?.isError, true, `propose_stack_change isError: ${stackPropOk.text}`);

    const pendingProp = (await listProposalsApi(adminApi)).find(
      (p) => !beforePropIds.has(p.id) && p.status === 'pending'
    );
    assert.ok(pendingProp, 'propose_stack_change must create a pending proposal');

    // 3. Direct tools/call to write-only tools MUST BE REJECTED (403 or JSON-RPC error)
    const blockedFieldKey = `propose_blocked_${tag.slice(-6)}`;
    const callConfig = await mcpPropose.callTool(
      'configure_section',
      buildConfigureSectionArgs(writeToolMap.get('configure_section'), 'peptides', {
        customFields: [fixtures.makeCustomSectionField({ key: blockedFieldKey })],
      })
    );
    assert.ok(
      callConfig.status === 403 || callConfig.error !== null,
      `propose token calling configure_section must return 403 or JSON-RPC error, got status=${callConfig.status}, body=${callConfig.text}`
    );

    const callResolve = await mcpPropose.callTool(
      'resolve_proposal',
      buildResolveProposalArgs(writeToolMap.get('resolve_proposal'), pendingProp.id, 'approve')
    );
    assert.ok(
      callResolve.status === 403 || callResolve.error !== null,
      `propose token calling resolve_proposal must return 403 or JSON-RPC error, got status=${callResolve.status}, body=${callResolve.text}`
    );

    // 4. Side-effect invariance checks
    const pepSecAfter = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(pepSecAfter.status, 200);
    assert.ok(!pepSecAfter.text.includes(blockedFieldKey), 'blocked configure_section must not mutate section schema');

    const propAfter = (await listProposalsApi(adminApi)).find((p) => p.id === pendingProp.id);
    assert.strictEqual(propAfter?.status, 'pending', 'blocked resolve_proposal must leave proposal pending');
  });
});

// ---------------------------------------------------------------------------
// 8. JSON-RPC 2.0 Protocol Error Handling
// ---------------------------------------------------------------------------
test('T2-C08: JSON-RPC 2.0 protocol errors (-32700, -32600, -32601, -32602, unknown resource, prompt & tool)', async () => {
  await withServer(async (server) => {
    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    await initMcp(mcp);

    // 1. Malformed JSON -> -32700 Parse error
    const parseErr = await mcp.raw('{not-valid-json');
    assert.ok(parseErr.error !== null, `malformed JSON must return JSON-RPC error, got ${parseErr.text}`);
    assert.strictEqual(parseErr.error.code, -32700, `expected -32700 Parse error, got ${parseErr.error.code}`);

    // 2a. Invalid Request (missing method) -> -32600
    const invalidReq = await mcp.raw('{"jsonrpc":"2.0","id":1}');
    assert.ok(invalidReq.error !== null, `invalid request must return JSON-RPC error, got ${invalidReq.text}`);
    assert.strictEqual(invalidReq.error.code, -32600, `expected -32600 Invalid Request, got ${invalidReq.error.code}`);

    // 2b. Empty batch [] -> -32600
    const emptyBatch = await mcp.raw('[]');
    assert.ok(emptyBatch.error !== null, `empty batch [] must return JSON-RPC error, got ${emptyBatch.text}`);
    assert.strictEqual(emptyBatch.error.code, -32600, `expected -32600 for empty batch [], got ${emptyBatch.error.code}`);

    // 3. Unknown method -> -32601
    const unknownMethod = await mcp.call('nonexistent/method', {});
    assert.ok(unknownMethod.error !== null, `unknown method must return JSON-RPC error, got ${unknownMethod.text}`);
    assert.strictEqual(unknownMethod.error.code, -32601, `expected -32601 Method not found, got ${unknownMethod.error.code}`);

    // 4a. Invalid params on tools/call (missing name) -> -32602
    const badToolParams = await mcp.call('tools/call', {});
    assert.ok(badToolParams.error !== null, `tools/call {} must return JSON-RPC error, got ${badToolParams.text}`);
    assert.strictEqual(badToolParams.error.code, -32602, `expected -32602 Invalid params, got ${badToolParams.error.code}`);

    // 4b. Invalid params on resources/read (missing uri) -> -32602
    const badResParams = await mcp.call('resources/read', {});
    assert.ok(badResParams.error !== null, `resources/read {} must return JSON-RPC error, got ${badResParams.text}`);
    assert.strictEqual(badResParams.error.code, -32602, `expected -32602 Invalid params, got ${badResParams.error.code}`);

    // 5. Unknown resource URI -> JSON-RPC error (-32002 or negative code)
    const unknownRes = await mcp.readResource(`hub://compounds/nonexistent-99999-${uid()}`);
    assert.ok(unknownRes.error !== null, `unknown resource URI must return JSON-RPC error, got ${unknownRes.text}`);
    assert.strictEqual(unknownRes.result, null);
    assert.ok(
      typeof unknownRes.error.code === 'number' && unknownRes.error.code < 0,
      `unknown resource URI must have negative JSON-RPC error code, got ${unknownRes.error.code}`
    );

    // 6. Unknown prompt name -> JSON-RPC error
    const unknownPrompt = await mcp.getPrompt(`nonexistent_prompt_${uid()}`);
    assert.ok(unknownPrompt.error !== null, `unknown prompt name must return JSON-RPC error, got ${unknownPrompt.text}`);
    assert.strictEqual(unknownPrompt.result, null);
    assert.ok(typeof unknownPrompt.error.code === 'number' && unknownPrompt.error.code < 0);

    // 7. Unknown tool name -> JSON-RPC error or MCP isError: true
    const unknownTool = await mcp.callTool(`nonexistent_tool_${uid()}`, {});
    assert.ok(
      unknownTool.error !== null || unknownTool.result?.isError === true,
      `unknown tool name must return JSON-RPC error or result.isError=true, got ${unknownTool.text}`
    );
  });
});

// ---------------------------------------------------------------------------
// 9. AI Research-and-Create Incomplete Payload (422 / isError + Missing Keys)
// ---------------------------------------------------------------------------
test('T2-C09: incomplete create_or_propose_compound rejected with missing core & required custom field keys and creates nothing', async () => {
  await withServer(async (server) => {
    const tag = uid('inc');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Customize peptides section with a required custom field (restored in finally for --base-url isolation)
    const curPepRes = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(curPepRes.status, 200, `GET peptides section failed: ${curPepRes.text}`);
    const curPep = unwrapData(curPepRes.json, ['section']);
    const origCustomFields = Array.isArray(curPep?.customFields) ? curPep.customFields : [];
    const reqCustomKey = `req_coa_${tag.slice(-6)}`;
    const patchRes = await adminApi.patch('/api/v1/sections/peptides', {
      customFields: [
        ...origCustomFields,
        fixtures.makeCustomSectionField({
          key: reqCustomKey,
          label: 'Required Batch COA URL',
          fieldType: 'url',
          required: true,
          aiResearchInstruction: 'Mandatory COA URL for every peptide profile.',
        }),
      ],
    });
    assert.strictEqual(patchRes.status, 200, `PATCH section failed: ${patchRes.text}`);

    try {
      const beforeCount = (await listCompoundsApi(adminApi)).length;
      const { rawSecret: proposeKey } = await mintApiKey(adminApi, {
        name: `Incomplete Payload Key ${tag}`,
        scope: 'propose',
        actor: 'ai:claude',
      });

      const mcp = createMcpClient({ baseUrl: server.baseUrl, token: proposeKey });
      await initMcp(mcp);
      const toolMap = await getToolMap(mcp);

      const incompleteName = `SparseIncompletePeptide ${tag}`;
      const res = await mcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(toolMap.get('create_or_propose_compound'), {
          name: incompleteName,
          sectionId: 'peptides',
        })
      );

      assert.ok(
        res.status === 422 || res.error !== null || res.result?.isError === true,
        `incomplete create_or_propose_compound must be rejected (422 / error / isError), got status=${res.status}, body=${res.text}`
      );

      const diagText = collectMcpErrorText(res);
      assert.ok(
        /summary|mechanismOfAction|dosages|halfLife|timingRules|cycles/i.test(diagText),
        `rejection payload must list missing required core field keys, got: ${diagText}`
      );
      assert.ok(
        diagText.includes(reqCustomKey),
        `rejection payload must list missing required custom field '${reqCustomKey}', got: ${diagText}`
      );

      // Side-effect check: no broken compound created
      const afterComps = await listCompoundsApi(adminApi);
      assert.strictEqual(afterComps.length, beforeCount, 'rejected incomplete payload must NOT create compound');
      assert.ok(!afterComps.some((c) => c.name === incompleteName));
    } finally {
      try {
        await adminApi.patch('/api/v1/sections/peptides', {
          customFields: origCustomFields,
        });
      } catch {
        // Best-effort cleanup so original test failure is never masked
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Duplicate & Alias Collision via MCP create_or_propose_compound (409 / Error)
// ---------------------------------------------------------------------------
test('T2-C10: duplicate/alias collision via MCP create_or_propose_compound returns conflict referencing existing compoundId with zero cloning', async () => {
  await withServer(async (server) => {
    const tag = uid('dup');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    const aliasName = `AliasDupTarget-${tag}`;
    const altAlias = `AliasDupAlt-${tag}`;
    const existing = await createCompoundApi(
      adminApi,
      fixtures.makeDermCompound({
        name: `Tretinoin 0.05% Cream ${tag}`,
        canonicalMolecule: `tretinoin-${tag}`,
        aliases: [aliasName, altAlias],
        sectionId: 'dermatology',
      })
    );
    const beforeCount = (await listCompoundsApi(adminApi)).length;

    const { rawSecret: proposeKey } = await mintApiKey(adminApi, {
      name: `Dup Test Key ${tag}`,
      scope: 'propose',
      actor: 'ai:gpt',
    });

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: proposeKey });
    await initMcp(mcp);
    const toolMap = await getToolMap(mcp);

    const duplicatePayload = fixtures.makeDermCompound({
      name: aliasName,
      canonicalMolecule: `tretinoin-${tag}`,
      aliases: [`Tretinoin 0.05% Cream ${tag}`, altAlias],
      sectionId: 'dermatology',
    });
    const res = await mcp.callTool(
      'create_or_propose_compound',
      buildCreateCompoundArgs(toolMap.get('create_or_propose_compound'), duplicatePayload)
    );

    assert.ok(
      res.status === 409 || res.error !== null || res.result?.isError === true,
      `alias collision in same (sectionId, route) must be rejected (409 / error / isError), got status=${res.status}, body=${res.text}`
    );

    const diagText = collectMcpErrorText(res);
    assert.ok(
      diagText.includes(existing.id),
      `duplicate conflict response must reference existing compoundId '${existing.id}', got: ${diagText}`
    );

    const afterComps = await listCompoundsApi(adminApi);
    assert.strictEqual(
      afterComps.length,
      beforeCount,
      'duplicate alias submission must NEVER silently clone a second compound'
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Verified-Field Protection (F19 / F21)
// ---------------------------------------------------------------------------
test('T2-C11: verified compound fields cannot be overwritten by propose-scoped enrich_compound — routes cleanly to Proposals Inbox', async () => {
  await withServer(async (server) => {
    const tag = uid('ver');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    const origSummary = `Verified summary untouched (${tag})`;
    const origMoa = `Verified mechanism of action untouched (${tag})`;
    const origDoseRange = `250 mcg once daily verified (${tag})`;

    const basePayload = fixtures.makePeptideCompound({
      name: `VerifiedGuardPeptide ${tag}`,
      canonicalMolecule: `vgp-${tag}`,
      aliases: [`VerifiedGuardAlias ${tag}`],
      summary: origSummary,
      mechanismOfAction: origMoa,
      dosages: {
        rangeText: origDoseRange,
        defaultAmount: 250,
        defaultUnit: 'mcg',
        route: 'SubQ',
        frequencyText: 'once daily',
      },
    });
    const comp = await createCompoundApi(adminApi, basePayload);
    const verRes = await adminApi.post(`/api/v1/compounds/${encodeURIComponent(comp.id)}/verify`, {});
    assert.ok(verRes.status === 200 || verRes.status === 201);

    const checkVerifiedRes = await adminApi.get(`/api/v1/compounds/${encodeURIComponent(comp.id)}`);
    assert.strictEqual(checkVerifiedRes.status, 200);
    const checkVerified = unwrapData(checkVerifiedRes.json, ['compound', 'profile']);
    assert.strictEqual(checkVerified.profileStatus, 'verified');

    const beforePropIds = new Set((await listProposalsApi(adminApi)).map((p) => p.id));

    const proposeFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(proposeFlow.ok, true);

    const mcpPropose = createMcpClient({ baseUrl: server.baseUrl, token: proposeFlow.accessToken });
    await initMcp(mcpPropose);
    const toolMap = await getToolMap(mcpPropose);

    const attemptedSummary = `AI attempted overwrite summary (${tag})`;
    const attemptedMoa = `AI attempted overwrite MOA (${tag})`;
    const attemptedDoseRange = `999 mcg AI overwrite (${tag})`;

    const enrichAttemptRes = await mcpPropose.callTool(
      'enrich_compound',
      buildEnrichCompoundArgs(toolMap.get('enrich_compound'), comp.id, {
        summary: attemptedSummary,
        mechanismOfAction: attemptedMoa,
        dosages: {
          ...checkVerified.dosages,
          rangeText: attemptedDoseRange,
        },
      })
    );
    assert.strictEqual(
      enrichAttemptRes.status,
      200,
      `enrich_compound on verified profile should return HTTP 200 routing to Proposals Inbox, got ${enrichAttemptRes.status}: ${enrichAttemptRes.text}`
    );

    // 1. Live verified compound MUST retain its exact original values
    const liveRes = await adminApi.get(`/api/v1/compounds/${encodeURIComponent(comp.id)}`);
    assert.strictEqual(liveRes.status, 200);
    const live = unwrapData(liveRes.json, ['compound', 'profile']);
    assert.strictEqual(live.profileStatus, 'verified', 'compound must remain verified');
    assert.strictEqual(live.summary, origSummary, 'verified summary must NOT be silently overwritten');
    assert.strictEqual(live.mechanismOfAction, origMoa, 'verified mechanismOfAction must NOT be silently overwritten');
    assert.strictEqual(live.dosages?.rangeText, origDoseRange, 'verified dosages.rangeText must NOT be silently overwritten');

    // 2. Proposed edit MUST appear as a pending proposal in REST GET /api/v1/proposals & MCP list_proposals
    const afterProps = await listProposalsApi(adminApi);
    const createdProp = afterProps.find(
      (p) => !beforePropIds.has(p.id) && p.status === 'pending' && JSON.stringify(p).includes(comp.id)
    );
    assert.ok(
      createdProp,
      `verified-field edit attempt must route to a new pending proposal referencing ${comp.id}`
    );
    assert.ok(
      JSON.stringify(createdProp).includes('AI attempted overwrite'),
      'pending proposal must capture the proposed diff values'
    );

    const mcpPropsRes = await mcpPropose.callTool('list_proposals', {});
    assert.strictEqual(mcpPropsRes.status, 200);
    const mcpProps = unwrapData(parseToolJson(mcpPropsRes), ['proposals', 'items']);
    assert.ok(
      Array.isArray(mcpProps) && mcpProps.some((p) => p.id === createdProp.id),
      'pending verified-field proposal must also be visible in MCP list_proposals'
    );
  });
});

// ---------------------------------------------------------------------------
// 12. BYOK Autofill 501 Fallback (No LLM Key Configured)
// ---------------------------------------------------------------------------
test('T2-C12: POST /api/v1/ai/autofill returns 501 with prompt fallback guidance when no BYOK env key is configured', async () => {
  await withServer({ env: CLEAR_BYOK_ENV }, async (server) => {
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Unauthenticated must still return 401
    const unauthRes = await adminApi.post(
      '/api/v1/ai/autofill',
      { name: 'Epitalon', compoundName: 'Epitalon', sectionId: 'peptides' },
      { auth: false }
    );
    assert.strictEqual(unauthRes.status, 401, 'unauthenticated /api/v1/ai/autofill must return 401');

    // Authenticated with no BYOK LLM key configured -> strictly HTTP 501 (never 500)
    const res = await adminApi.post('/api/v1/ai/autofill', {
      name: 'Epitalon',
      compoundName: 'Epitalon',
      sectionId: 'peptides',
    });
    assert.strictEqual(
      res.status,
      501,
      `POST /api/v1/ai/autofill without BYOK key must return HTTP 501 (never 500), got ${res.status}: ${res.text}`
    );
    assertNoStore(res.headers, 'POST /api/v1/ai/autofill 501');
    assert.ok(res.json && typeof res.json === 'object', 'BYOK 501 response must return structured JSON');
    assert.ok(
      typeof res.json?.fallbackPrompt === 'string' ||
        typeof res.json?.prompt === 'string' ||
        /prompt|research-prompt|fallback/i.test(res.text),
      `BYOK 501 response must include clear prompt-fallback guidance, got: ${res.text}`
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Context Bundle Security, Auth & Query Filtering
// ---------------------------------------------------------------------------
test('T2-C13: context bundles require auth (401), redact all secrets/tokens & honor ?sections= and ?member= filters', async () => {
  await withServer(async (server) => {
    const tag = uid('ctx');
    const pubApi = createApiClient({ baseUrl: server.baseUrl });
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Unauthenticated requests must fail 401 with Cache-Control: no-store
    for (const path of ['/api/v1/export/context.md', '/api/v1/export/context.json']) {
      const unauth = await pubApi.get(path, { auth: false });
      assert.strictEqual(unauth.status, 401, `unauthenticated ${path} must return 401`);
      assertNoStore(unauth.headers, `unauth ${path}`);
    }

    // Mint API key & OAuth token to verify zero secret leakage
    const { rawSecret: apiKeySecret } = await mintApiKey(adminApi, {
      name: `Context Secret Guard ${tag}`,
      scope: 'read',
      actor: 'ai:muse',
    });
    const oauthFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(oauthFlow.ok, true);

    // Seed compounds across peptides & dermatology + separate wife & husband stacks
    const pepName = `PepCtxAlpha ${tag}`;
    const dermName = `DermCtxBeta ${tag}`;
    const suppName = `SuppCtxGamma ${tag}`;
    const pepComp = await createCompoundApi(
      adminApi,
      fixtures.makePeptideCompound({
        name: pepName,
        canonicalMolecule: `pep-ctx-${tag}`,
        aliases: [`PepCtxAlias ${tag}`],
      })
    );
    await createCompoundApi(
      adminApi,
      fixtures.makeDermCompound({
        name: dermName,
        canonicalMolecule: `derm-ctx-${tag}`,
        aliases: [`DermCtxAlias ${tag}`],
      })
    );
    const suppComp = await createCompoundApi(
      adminApi,
      fixtures.makeSupplementCompound({
        name: suppName,
        canonicalMolecule: `supp-ctx-${tag}`,
        aliases: [`SuppCtxAlias ${tag}`],
      })
    );

    const wifeStackName = `WifePrivateStack ${tag}`;
    const husbandStackName = `HusbandPrivateStack ${tag}`;
    const wsRes = await adminApi.post(
      '/api/v1/members/member_wife/stacks',
      fixtures.makeStackPayload({
        name: wifeStackName,
        memberId: 'member_wife',
        active: true,
        items: [fixtures.makeStackItem({ compoundId: pepComp.id })],
      })
    );
    assert.ok(wsRes.status === 201 || wsRes.status === 200);
    const hsRes = await adminApi.post(
      '/api/v1/members/member_husband/stacks',
      fixtures.makeStackPayload({
        name: husbandStackName,
        memberId: 'member_husband',
        active: true,
        items: [fixtures.makeStackItem({ compoundId: suppComp.id })],
      })
    );
    assert.ok(hsRes.status === 201 || hsRes.status === 200);

    const forbiddenSecrets = [
      server.adminToken,
      server.passcode,
      apiKeySecret,
      oauthFlow.accessToken,
      oauthFlow.refreshToken,
    ].filter(Boolean);

    // Full bundles must never leak any secret
    for (const path of ['/api/v1/export/context.md', '/api/v1/export/context.json']) {
      const fullRes = await adminApi.get(path);
      assert.strictEqual(fullRes.status, 200);
      assertNoStore(fullRes.headers, `GET ${path}`);
      for (const secret of forbiddenSecrets) {
        assert.ok(!fullRes.text.includes(secret), `${path} MUST NOT leak secret/token`);
      }
    }

    // ?sections=peptides filter on BOTH .md and .json
    for (const path of ['/api/v1/export/context.md', '/api/v1/export/context.json']) {
      const secFiltered = await adminApi.get(path, { query: { sections: 'peptides' } });
      assert.strictEqual(secFiltered.status, 200);
      assertNoStore(secFiltered.headers, `GET ${path}?sections=peptides`);
      assert.ok(secFiltered.text.includes(pepName), `${path}?sections=peptides must include peptide compound`);
      assert.ok(!secFiltered.text.includes(dermName), `${path}?sections=peptides must exclude dermatology compound`);
    }

    // ?member=member_wife filter on BOTH .md and .json
    for (const path of ['/api/v1/export/context.md', '/api/v1/export/context.json']) {
      const memFiltered = await adminApi.get(path, { query: { member: 'member_wife' } });
      assert.strictEqual(memFiltered.status, 200);
      assertNoStore(memFiltered.headers, `GET ${path}?member=member_wife`);
      assert.ok(memFiltered.text.includes(wifeStackName), `${path}?member=member_wife must include wife stack`);
      assert.ok(
        !memFiltered.text.includes(husbandStackName),
        `${path}?member=member_wife must exclude husband private stack`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Zero-PII Public Discovery (GET /llms.txt & GET /openapi.json)
// ---------------------------------------------------------------------------
test('T2-C14: public GET /llms.txt & GET /openapi.json contain zero stored household PII, notes, compounds or secrets', async () => {
  await withServer(async (server) => {
    const tag = uid('pii');
    const pubApi = createApiClient({ baseUrl: server.baseUrl });
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Synthetic sentinel PII values (strictly non-real test sentinels)
    const sentinelMember = `SentinelMemberAlpha91_${tag}`;
    const sentinelAllergy = `SentinelAllergy91_${tag}`;
    const sentinelRx = `SyntheticRxSentinel91_${tag}`;
    const sentinelCond = `SentinelCondition91_${tag}`;
    const sentinelCompound = `SentinelCompound91_${tag}`;
    const sentinelAlias = `SentinelCompoundAlias91_${tag}`;
    const sentinelNote = `SyntheticPrivateNote91_${tag}`;

    const patchMem = await adminApi.patch('/api/v1/members/member_wife', {
      name: sentinelMember,
      safetyContext: {
        pregnancyOrTrying: false,
        biologicalSexContext: 'female',
        allergies: [sentinelAllergy],
        activeRxMeds: [sentinelRx],
        conditions: [sentinelCond],
      },
    });
    assert.strictEqual(patchMem.status, 200, `PATCH member failed: ${patchMem.text}`);

    await createCompoundApi(
      adminApi,
      fixtures.makePeptideCompound({
        name: sentinelCompound,
        canonicalMolecule: `sentinel-${tag}`,
        aliases: [sentinelAlias],
        notes: sentinelNote,
      })
    );
    const { rawSecret: apiKeySecret } = await mintApiKey(adminApi, {
      name: `SentinelKey_${tag}`,
      scope: 'read',
    });

    const sentinels = [
      sentinelMember,
      sentinelAllergy,
      sentinelRx,
      sentinelCond,
      sentinelCompound,
      sentinelAlias,
      sentinelNote,
      server.adminToken,
      server.passcode,
      apiKeySecret,
    ];

    const llmsRes = await pubApi.get('/llms.txt', { auth: false });
    assert.strictEqual(llmsRes.status, 200);
    const oaRes = await pubApi.get('/openapi.json', { auth: false });
    assert.strictEqual(oaRes.status, 200);

    for (const s of sentinels) {
      assert.ok(!llmsRes.text.includes(s), `public /llms.txt leaked sentinel value: ${s}`);
      assert.ok(!oaRes.text.includes(s), `public /openapi.json leaked sentinel value: ${s}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Revoked API Key, Revoked OAuth Client & Disallowed CORS Origin Rejection
// ---------------------------------------------------------------------------
test('T2-C15: deleted API key & deleted OAuth client immediately invalidate all auth paths; disallowed CORS Origin rejected', async () => {
  await withServer(async (server) => {
    const tag = uid('rev');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // 1. Delete API key -> immediate 401 on Bearer, ?token=, and REST
    const { keyId, rawSecret } = await mintApiKey(adminApi, {
      name: `Immediate Revoke Key ${tag}`,
      scope: 'propose',
      actor: 'ai:grok',
    });
    const mcpKeyBearer = createMcpClient({ baseUrl: server.baseUrl, token: rawSecret });
    const mcpKeyQuery = createMcpClient({ baseUrl: server.baseUrl, token: rawSecret, tokenInQuery: true });
    assert.strictEqual((await mcpKeyBearer.ping()).status, 200);
    assert.strictEqual((await mcpKeyQuery.ping()).status, 200);

    const delKeyRes = await adminApi.del(`/api/v1/keys/${encodeURIComponent(keyId)}`);
    assert.ok(delKeyRes.status === 200 || delKeyRes.status === 204);

    assert.strictEqual((await mcpKeyBearer.ping()).status, 401, 'deleted API key via Bearer must return 401');
    assert.strictEqual((await mcpKeyQuery.ping()).status, 401, 'deleted API key via ?token= must return 401');
    const restKeyClient = createApiClient({ baseUrl: server.baseUrl, token: rawSecret });
    assert.strictEqual((await restKeyClient.get('/api/v1/compounds')).status, 401, 'deleted API key on REST must return 401');

    // 2. Delete OAuth client -> immediate 401 on access token AND failure on refresh token
    const oauthFlow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(oauthFlow.ok, true);
    const mcpOauth = createMcpClient({ baseUrl: server.baseUrl, token: oauthFlow.accessToken });
    assert.strictEqual((await mcpOauth.ping()).status, 200);

    const listClientsBefore = await adminApi.get('/api/v1/oauth/clients');
    assert.strictEqual(listClientsBefore.status, 200, `GET /api/v1/oauth/clients failed: ${listClientsBefore.text}`);
    const clientsBefore = unwrapData(listClientsBefore.json, ['clients', 'items']);
    assert.ok(Array.isArray(clientsBefore), 'GET /api/v1/oauth/clients must return array');
    const matchesTargetClient = (c) =>
      [c?.id, c?.client_id, c?.clientId].includes(oauthFlow.clientId);
    const foundClient = clientsBefore.find(matchesTargetClient);
    assert.ok(foundClient, `registered OAuth client ${oauthFlow.clientId} must appear in GET /api/v1/oauth/clients`);
    const deleteClientId =
      foundClient.id ?? foundClient.client_id ?? foundClient.clientId ?? oauthFlow.clientId;

    const delClientRes = await adminApi.del(`/api/v1/oauth/clients/${encodeURIComponent(deleteClientId)}`);
    assert.ok(delClientRes.status === 200 || delClientRes.status === 204);

    const listClientsAfter = await adminApi.get('/api/v1/oauth/clients');
    assert.strictEqual(listClientsAfter.status, 200);
    const clientsAfter = unwrapData(listClientsAfter.json, ['clients', 'items']);
    assert.ok(Array.isArray(clientsAfter));
    const stillActiveClient = clientsAfter.find(
      (c) =>
        matchesTargetClient(c) &&
        c?.revoked !== true &&
        c?.status !== 'revoked'
    );
    assert.strictEqual(stillActiveClient, undefined, 'deleted OAuth client must not remain active');

    assert.strictEqual((await mcpOauth.ping()).status, 401, 'deleted OAuth client access token must return 401 on /mcp');
    const restOauthClient = createApiClient({ baseUrl: server.baseUrl, token: oauthFlow.accessToken });
    assert.strictEqual((await restOauthClient.get('/api/v1/compounds')).status, 401, 'deleted OAuth client access token must return 401 on REST');

    const refreshAfterDelete = await refreshOAuthToken({
      baseUrl: server.baseUrl,
      tokenEndpoint: oauthFlow.endpoints.tokenEndpoint,
      refreshToken: oauthFlow.refreshToken,
      clientId: oauthFlow.clientId,
      clientSecret: oauthFlow.clientSecret || undefined,
      resource: `${server.origin}/mcp`,
    });
    assert.ok(
      refreshAfterDelete.status === 400 || refreshAfterDelete.status === 401,
      `refresh after OAuth client deletion must fail 400/401, got ${refreshAfterDelete.status}`
    );
    assert.strictEqual(refreshAfterDelete.ok, false);
    assert.strictEqual(refreshAfterDelete.accessToken, null);

    // 3. Disallowed CORS Origin (https://evil.example) must NEVER be echoed or wildcarded
    const evilOrigin = 'https://evil.example';
    const corsRestRes = await adminApi.get('/api/v1/compounds', { headers: { Origin: evilOrigin } });
    const corsMcpRes = await createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken }).ping({
      headers: { Origin: evilOrigin },
    });
    const corsPreflightRes = await adminApi.options('/mcp', {
      auth: false,
      headers: {
        Origin: evilOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });

    for (const [label, res] of [
      ['GET /api/v1/compounds', corsRestRes],
      ['POST /mcp', corsMcpRes],
      ['OPTIONS /mcp', corsPreflightRes],
    ]) {
      const acao = res.headers.get('access-control-allow-origin');
      assert.notStrictEqual(acao, evilOrigin, `${label} must NEVER reflect disallowed origin ${evilOrigin}`);
      assert.notStrictEqual(acao, '*', `${label} must NEVER send wildcard Access-Control-Allow-Origin: *`);
    }
  });
});
