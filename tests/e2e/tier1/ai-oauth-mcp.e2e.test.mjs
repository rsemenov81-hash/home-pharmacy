/**
 * Tier 1 E2E Suite — Requirement Area C (Happy Path):
 * OAuth 2.1, Universal 5-AI Streamable HTTP MCP, AI Onboarding & Enrichment,
 * Proposals Inbox, Immutable Audit Log, OpenAPI 3.1.0, llms.txt, Context Bundles,
 * AI Prompt Builder & Dual-Runtime Security Hygiene.
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

const ALL_17_CANONICAL_TOOLS = [
  ...CANONICAL_READ_TOOLS,
  ...CANONICAL_PROPOSE_TOOLS,
  ...CANONICAL_WRITE_TOOLS,
];

const CORE_SECTION_SLUGS = [
  'peptides',
  'peds',
  'vitamins_supplements',
  'dermatology',
];

const CANONICAL_PROMPTS = [
  'research_compound',
  'review_stack_safety',
  'optimize_daily_schedule',
];

function uid(prefix = 't1') {
  return `${prefix}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeOrigin(urlStr) {
  return String(urlStr || '').replace(/\/+$/, '');
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
    `${label}: expected Cache-Control to contain 'no-store', got ${JSON.stringify(cc)}`
  );
}

async function initMcp(mcp) {
  const initRes = await mcp.initialize({ name: 'home-pharmacy-e2e-tier1', version: '1.0.0' });
  assert.strictEqual(initRes.status, 200, `initialize HTTP status: ${initRes.text}`);
  assert.strictEqual(initRes.error, null, `initialize JSON-RPC error: ${JSON.stringify(initRes.error)}`);
  assert.ok(initRes.result && typeof initRes.result === 'object', 'initialize result must be object');
  const notifRes = await mcp.notifyInitialized();
  assert.ok(
    [200, 202, 204].includes(notifRes.status),
    `notifications/initialized status expected 200/202/204, got ${notifRes.status}`
  );
  assert.strictEqual(notifRes.error, null, `notifications/initialized error: ${JSON.stringify(notifRes.error)}`);
  return initRes;
}

async function getToolMap(mcp) {
  const res = await mcp.listTools();
  assert.strictEqual(res.status, 200, `tools/list HTTP status: ${res.text}`);
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

function buildEnrichCompoundArgs(tool, compoundId, patchFields, extra = {}) {
  const props = getSchemaProps(tool);
  const idKey = pickSchemaKey(tool, ['compoundId', 'id'], 'compoundId');
  for (const wrapper of ['patch', 'updates', 'fields', 'changes', 'data']) {
    if (
      Object.prototype.hasOwnProperty.call(props, wrapper) &&
      !Object.prototype.hasOwnProperty.call(props, 'summary')
    ) {
      const out = { [idKey]: compoundId, [wrapper]: patchFields };
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && Object.prototype.hasOwnProperty.call(props, k)) {
          out[k] = v;
        }
      }
      return out;
    }
  }
  return { [idKey]: compoundId, ...patchFields, ...extra };
}

function buildOwnershipArgs(tool, compoundId, ownershipPatch) {
  const props = getSchemaProps(tool);
  const idKey = pickSchemaKey(tool, ['compoundId', 'id'], 'compoundId');
  if (
    Object.prototype.hasOwnProperty.call(props, 'ownership') &&
    !Object.prototype.hasOwnProperty.call(props, 'status')
  ) {
    return { [idKey]: compoundId, ownership: ownershipPatch };
  }
  return { [idKey]: compoundId, ...ownershipPatch };
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
    const changesSchema = props.changes;
    if (changesSchema?.type === 'array') {
      out.changes = [{ action: 'add', ...item }];
    } else {
      out.changes = { add: [item], items: [item] };
    }
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'add')) {
    const addItemsType = props.add?.items?.type;
    out.add = addItemsType === 'string' ? [item.compoundId] : [item];
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'items')) {
    out.items = [item];
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'patch')) {
    out.patch = { add: [item], items: [item] };
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'compoundId')) {
    out.compoundId = item.compoundId;
    const opKey = pickSchemaKey(tool, ['action', 'operation', 'changeType'], 'action');
    if (Object.prototype.hasOwnProperty.call(props, opKey)) {
      const enumVals = props[opKey]?.enum;
      const addVal = Array.isArray(enumVals)
        ? (enumVals.find((v) => /add/i.test(String(v))) ?? enumVals[0])
        : 'add';
      out[opKey] = addVal;
    }
    if (Object.prototype.hasOwnProperty.call(props, 'item')) out.item = item;
    if (Object.prototype.hasOwnProperty.call(props, 'doseAmount')) out.doseAmount = item.doseAmount;
    if (Object.prototype.hasOwnProperty.call(props, 'doseUnit')) out.doseUnit = item.doseUnit;
  } else if (hasProps && Object.prototype.hasOwnProperty.call(props, 'item')) {
    out.item = item;
    const opKey = pickSchemaKey(tool, ['action', 'operation', 'changeType'], 'action');
    if (Object.prototype.hasOwnProperty.call(props, opKey)) {
      const enumVals = props[opKey]?.enum;
      const addVal = Array.isArray(enumVals)
        ? (enumVals.find((v) => /add/i.test(String(v))) ?? enumVals[0])
        : 'add';
      out[opKey] = addVal;
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

function buildResolveProposalArgs(tool, proposalId, action, edits) {
  const idKey = pickSchemaKey(tool, ['proposalId', 'id'], 'proposalId');
  const actionKey = pickSchemaKey(tool, ['action', 'decision', 'resolution'], 'action');
  const out = { [idKey]: proposalId, [actionKey]: action };
  if (edits !== undefined) {
    const editsKey = pickSchemaKey(tool, ['edits', 'modifications', 'override'], 'edits');
    out[editsKey] = edits;
  }
  return out;
}

function buildPromptArgs(promptDef, desired) {
  const declared = Array.isArray(promptDef?.arguments) ? promptDef.arguments : [];
  if (declared.length === 0) return desired.fallback;
  const out = {};
  for (const arg of declared) {
    const name = String(arg?.name || '');
    if (/section/i.test(name) && desired.sectionId !== undefined) {
      out[name] = desired.sectionId;
    } else if (/member|user|person/i.test(name) && desired.memberId !== undefined) {
      out[name] = desired.memberId;
    } else if (/stack/i.test(name) && desired.stackId !== undefined) {
      out[name] = desired.stackId;
    } else if (/date/i.test(name) && desired.dateKey !== undefined) {
      out[name] = desired.dateKey;
    } else if (/compound|substance|^name$/i.test(name) && desired.compound !== undefined) {
      out[name] = desired.compound;
    }
  }
  return Object.keys(out).length > 0 ? out : desired.fallback;
}

function extractPromptText(promptResult) {
  const messages = promptResult?.messages;
  assert.ok(Array.isArray(messages) && messages.length >= 1, 'prompts/get must return non-empty messages[]');
  const parts = [];
  for (const msg of messages) {
    if (typeof msg?.content === 'string') {
      parts.push(msg.content);
    } else if (typeof msg?.content?.text === 'string') {
      parts.push(msg.content.text);
    } else if (Array.isArray(msg?.content)) {
      for (const c of msg.content) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('\n');
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
  assert.ok(
    res.status === 201 || res.status === 200,
    `POST /api/v1/keys failed (${res.status}): ${res.text}`
  );
  assertNoStore(res.headers, 'POST /api/v1/keys');
  const { keyObj, keyId, rawSecret } = extractKeyCreateResult(res);
  assert.ok(typeof keyId === 'string' && keyId.length > 0, `expected non-empty keyId in ${res.text}`);
  assert.ok(typeof rawSecret === 'string' && rawSecret.length >= 8, `expected raw secret in ${res.text}`);
  return { res, keyObj, keyId, rawSecret };
}

async function createCompoundApi(api, payload) {
  const res = await api.post('/api/v1/compounds', payload);
  assert.ok(
    res.status === 201 || res.status === 200,
    `POST /api/v1/compounds failed (${res.status}): ${res.text}`
  );
  const comp = unwrapData(res.json, ['compound', 'profile']);
  assert.ok(typeof comp?.id === 'string' && comp.id.length > 0, `expected compound.id in ${res.text}`);
  return comp;
}

async function getCompoundApi(api, compoundId) {
  const res = await api.get(`/api/v1/compounds/${encodeURIComponent(compoundId)}`);
  assert.strictEqual(res.status, 200, `GET /api/v1/compounds/${compoundId} failed (${res.status}): ${res.text}`);
  return unwrapData(res.json, ['compound', 'profile']);
}

async function verifyCompoundApi(api, compoundId) {
  const res = await api.post(`/api/v1/compounds/${encodeURIComponent(compoundId)}/verify`, {});
  assert.ok(res.status === 200 || res.status === 201, `verify compound failed (${res.status}): ${res.text}`);
  const verified = await getCompoundApi(api, compoundId);
  assert.strictEqual(verified.profileStatus, 'verified', 'compound must be marked verified');
  return verified;
}

async function listProposalsApi(api, query = {}) {
  const res = await api.get('/api/v1/proposals', { query });
  assert.strictEqual(res.status, 200, `GET /api/v1/proposals failed (${res.status}): ${res.text}`);
  assertNoStore(res.headers, 'GET /api/v1/proposals');
  const list = unwrapData(res.json, ['proposals', 'items']);
  assert.ok(Array.isArray(list), `expected proposals array, got ${res.text}`);
  return list;
}

function findOwnershipEntry(json, compoundId, scope) {
  const unwrapped = unwrapData(json, ['ownership', 'ownerships', 'records', 'items']);
  if (Array.isArray(unwrapped)) {
    return unwrapped.find(
      (o) => o && o.compoundId === compoundId && (!scope || o.scope === scope)
    ) || null;
  }
  if (unwrapped && typeof unwrapped === 'object') {
    for (const val of Object.values(unwrapped)) {
      if (val && typeof val === 'object' && val.compoundId === compoundId && (!scope || val.scope === scope)) {
        return val;
      }
      if (Array.isArray(val)) {
        const match = val.find((o) => o && o.compoundId === compoundId && (!scope || o.scope === scope));
        if (match) return match;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. RFC 9728 Protected Resource Metadata & RFC 8414 Authorization Server Metadata
// ---------------------------------------------------------------------------
test('T1-C01: RFC 9728 protected resource metadata (root + /mcp) & RFC 8414 auth server metadata', async () => {
  await withServer(async (server) => {
    const pub = createApiClient({ baseUrl: server.baseUrl });

    const prRoot = await pub.get('/.well-known/oauth-protected-resource', { auth: false });
    const prMcp = await pub.get('/.well-known/oauth-protected-resource/mcp', { auth: false });
    const asMeta = await pub.get('/.well-known/oauth-authorization-server', { auth: false });

    for (const [label, res] of [
      ['/.well-known/oauth-protected-resource', prRoot],
      ['/.well-known/oauth-protected-resource/mcp', prMcp],
    ]) {
      assert.strictEqual(res.status, 200, `${label} must return 200, got ${res.status}`);
      assert.ok(
        String(res.headers.get('content-type') || '').toLowerCase().includes('application/json'),
        `${label} must return application/json`
      );
      const body = res.json;
      assert.ok(body && typeof body === 'object', `${label} must return JSON object`);
      assert.ok(
        typeof body.resource === 'string' && normalizeOrigin(body.resource).startsWith(server.origin),
        `${label} resource must start with ${server.origin}, got ${JSON.stringify(body.resource)}`
      );
      assert.ok(
        Array.isArray(body.authorization_servers) &&
          body.authorization_servers.some((s) => normalizeOrigin(s) === server.origin),
        `${label} authorization_servers must include ${server.origin}, got ${JSON.stringify(body.authorization_servers)}`
      );
      assert.ok(Array.isArray(body.scopes_supported), `${label} scopes_supported must be array`);
      for (const scope of ['read', 'propose', 'write']) {
        assert.ok(
          body.scopes_supported.includes(scope),
          `${label} scopes_supported must include '${scope}'`
        );
      }
      assert.ok(
        Array.isArray(body.bearer_methods_supported) && body.bearer_methods_supported.includes('header'),
        `${label} bearer_methods_supported must include 'header'`
      );
    }

    assert.strictEqual(asMeta.status, 200, `RFC 8414 metadata must return 200, got ${asMeta.status}`);
    assert.ok(
      String(asMeta.headers.get('content-type') || '').toLowerCase().includes('application/json'),
      'RFC 8414 metadata must return application/json'
    );
    const meta = asMeta.json;
    assert.ok(meta && typeof meta === 'object', 'RFC 8414 metadata must be JSON object');
    assert.strictEqual(
      normalizeOrigin(meta.issuer),
      server.origin,
      `RFC 8414 issuer must equal ${server.origin}`
    );

    for (const [field, suffix] of [
      ['authorization_endpoint', '/oauth/authorize'],
      ['token_endpoint', '/oauth/token'],
      ['registration_endpoint', '/oauth/register'],
      ['revocation_endpoint', '/oauth/revoke'],
    ]) {
      assert.ok(
        typeof meta[field] === 'string' &&
          meta[field].startsWith(server.origin) &&
          meta[field].endsWith(suffix),
        `RFC 8414 ${field} must point to ${server.origin}${suffix}, got ${JSON.stringify(meta[field])}`
      );
    }

    assert.deepEqual(
      meta.code_challenge_methods_supported,
      ['S256'],
      'PKCE code_challenge_methods_supported must be strictly ["S256"]'
    );
    assert.strictEqual(
      meta.authorization_response_iss_parameter_supported,
      true,
      'RFC 9207 authorization_response_iss_parameter_supported must be true'
    );
    assert.strictEqual(
      meta.client_id_metadata_document_supported,
      true,
      'CIMD client_id_metadata_document_supported must be true'
    );
    assert.ok(
      Array.isArray(meta.response_types_supported) && meta.response_types_supported.includes('code'),
      'response_types_supported must include "code"'
    );
    assert.ok(
      Array.isArray(meta.grant_types_supported) &&
        meta.grant_types_supported.includes('authorization_code') &&
        meta.grant_types_supported.includes('refresh_token'),
      'grant_types_supported must include authorization_code and refresh_token'
    );
    assert.ok(Array.isArray(meta.scopes_supported), 'RFC 8414 scopes_supported must be array');
    for (const scope of ['read', 'propose', 'write']) {
      assert.ok(meta.scopes_supported.includes(scope), `RFC 8414 scopes_supported must include '${scope}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Full OAuth 2.1 DCR + PKCE S256 Flow (Form-URLEncoded & JSON Token Exchange)
// ---------------------------------------------------------------------------
test('T1-C02: full OAuth 2.1 DCR + PKCE S256 flow with both form-urlencoded and JSON token exchange', async () => {
  await withServer(async (server) => {
    const resource = `${server.origin}/mcp`;

    // Flow A: application/x-www-form-urlencoded token exchange
    const flowForm = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      memberId: 'member_wife',
      clientName: `Claude Form E2E ${uid()}`,
      resource,
      tokenContentType: 'form',
    });

    assert.strictEqual(flowForm.ok, true, `OAuth form flow failed: ${flowForm.error}`);
    assert.strictEqual(flowForm.error, null);
    assert.strictEqual(flowForm.registration?.status, 201, 'DCR must return HTTP 201');
    assertNoStore(flowForm.registration.headers, 'POST /oauth/register');
    assert.ok(typeof flowForm.clientId === 'string' && flowForm.clientId.length > 0);
    assert.ok(
      Array.isArray(flowForm.registration.json?.redirect_uris) &&
        flowForm.registration.json.redirect_uris.includes(flowForm.redirectUri),
      'DCR response must echo redirect_uris'
    );
    assert.strictEqual(flowForm.authorizeGet?.status, 200, 'GET /oauth/authorize must return 200 HTML');
    assert.ok(
      String(flowForm.authorizeGet.headers.get('content-type') || '').toLowerCase().includes('text/html'),
      'GET /oauth/authorize must return text/html'
    );
    assertNoStore(flowForm.authorizeGet.headers, 'GET /oauth/authorize');
    assert.ok(flowForm.parsedForm && flowForm.parsedForm.formsCount >= 1);

    assert.strictEqual(flowForm.authorizePost?.status, 302, 'POST /oauth/authorize must return 302 redirect');
    assertNoStore(flowForm.authorizePost.headers, 'POST /oauth/authorize');
    assert.ok(typeof flowForm.code === 'string' && flowForm.code.length > 0, 'callback must include code');
    assert.strictEqual(flowForm.returnedState, flowForm.state, 'callback state must match sent state');
    assert.strictEqual(
      normalizeOrigin(flowForm.iss),
      server.origin,
      'RFC 9207 callback iss must match authorization server origin'
    );

    assert.strictEqual(flowForm.tokenResponse?.status, 200, 'POST /oauth/token (form) must return 200');
    assertNoStore(flowForm.tokenResponse.headers, 'POST /oauth/token (form)');
    assert.ok(typeof flowForm.accessToken === 'string' && flowForm.accessToken.length > 0);
    assert.ok(typeof flowForm.refreshToken === 'string' && flowForm.refreshToken.length > 0);
    assert.strictEqual(String(flowForm.tokenType).toLowerCase(), 'bearer');
    assert.ok(typeof flowForm.expiresIn === 'number' && flowForm.expiresIn > 0);
    assert.ok(String(flowForm.grantedScope || '').includes('propose'));

    const mcpForm = createMcpClient({ baseUrl: server.baseUrl, token: flowForm.accessToken });
    await initMcp(mcpForm);
    const pingForm = await mcpForm.ping();
    assert.strictEqual(pingForm.status, 200);
    assert.strictEqual(pingForm.error, null);
    const toolsForm = await mcpForm.listTools();
    assert.strictEqual(toolsForm.status, 200);
    assert.strictEqual(toolsForm.result?.tools?.length, 15, 'propose OAuth token must see 15 MCP tools');

    // Flow B: application/json token exchange
    const flowJson = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      memberId: 'member_husband',
      clientName: `Gemini JSON E2E ${uid()}`,
      resource,
      tokenContentType: 'json',
    });

    assert.strictEqual(flowJson.ok, true, `OAuth JSON flow failed: ${flowJson.error}`);
    assert.strictEqual(flowJson.registration?.status, 201);
    assert.strictEqual(flowJson.authorizePost?.status, 302);
    assert.strictEqual(flowJson.returnedState, flowJson.state);
    assert.strictEqual(normalizeOrigin(flowJson.iss), server.origin);
    assert.strictEqual(flowJson.tokenResponse?.status, 200, 'POST /oauth/token (json) must return 200');
    assertNoStore(flowJson.tokenResponse.headers, 'POST /oauth/token (json)');
    assert.ok(typeof flowJson.accessToken === 'string' && flowJson.accessToken.length > 0);
    assert.notStrictEqual(flowJson.accessToken, flowForm.accessToken);
    assert.strictEqual(String(flowJson.tokenType).toLowerCase(), 'bearer');
    assert.ok(typeof flowJson.expiresIn === 'number' && flowJson.expiresIn > 0);

    const mcpJson = createMcpClient({ baseUrl: server.baseUrl, token: flowJson.accessToken });
    await initMcp(mcpJson);
    const pingJson = await mcpJson.ping();
    assert.strictEqual(pingJson.status, 200);
    assert.strictEqual(pingJson.error, null);
    const toolsJson = await mcpJson.listTools();
    assert.strictEqual(toolsJson.status, 200);
    assert.strictEqual(toolsJson.result?.tools?.length, 11, 'read OAuth token must see 11 MCP tools');
  });
});

// ---------------------------------------------------------------------------
// 3. OAuth 2.1 Refresh Token Rotation, Revocation & Client Management
// ---------------------------------------------------------------------------
test('T1-C03: OAuth 2.1 refresh token rotation, /oauth/revoke, and GET/DELETE /api/v1/oauth/clients', async () => {
  await withServer(async (server) => {
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
    const resource = `${server.origin}/mcp`;

    // Flow 1: refresh rotation + /oauth/revoke
    const flow1 = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      clientName: `Grok Rotate ${uid()}`,
      resource,
    });
    assert.strictEqual(flow1.ok, true, `flow1 failed: ${flow1.error}`);

    const refreshed = await refreshOAuthToken({
      baseUrl: server.baseUrl,
      tokenEndpoint: flow1.endpoints.tokenEndpoint,
      refreshToken: flow1.refreshToken,
      clientId: flow1.clientId,
      clientSecret: flow1.clientSecret || undefined,
      resource,
    });

    assert.strictEqual(refreshed.status, 200, `refresh_token failed (${refreshed.status}): ${refreshed.text}`);
    assert.strictEqual(refreshed.ok, true);
    assertNoStore(refreshed.headers, 'POST /oauth/token (refresh)');
    assert.ok(typeof refreshed.accessToken === 'string' && refreshed.accessToken.length > 0);
    assert.notStrictEqual(refreshed.accessToken, flow1.accessToken, 'refresh must mint a new access_token');
    assert.ok(typeof refreshed.refreshToken === 'string' && refreshed.refreshToken.length > 0);
    assert.notStrictEqual(refreshed.refreshToken, flow1.refreshToken, 'refresh must rotate refresh_token');
    assert.strictEqual(String(refreshed.tokenType).toLowerCase(), 'bearer');
    assert.ok(typeof refreshed.expiresIn === 'number' && refreshed.expiresIn > 0);

    const mcpRefreshed = createMcpClient({ baseUrl: server.baseUrl, token: refreshed.accessToken });
    const pingOk = await mcpRefreshed.ping();
    assert.strictEqual(pingOk.status, 200);
    assert.strictEqual(pingOk.error, null);

    const revRes = await revokeOAuthToken({
      baseUrl: server.baseUrl,
      revocationEndpoint: flow1.endpoints.revocationEndpoint,
      token: refreshed.accessToken,
      tokenTypeHint: 'access_token',
      clientId: flow1.clientId,
      clientSecret: flow1.clientSecret || undefined,
    });
    assert.ok(
      revRes.status === 200 || revRes.status === 204,
      `POST /oauth/revoke must return 200/204, got ${revRes.status}`
    );
    assertNoStore(revRes.headers, 'POST /oauth/revoke');

    const pingAfterRevoke = await mcpRefreshed.ping();
    assert.strictEqual(pingAfterRevoke.status, 401, 'revoked access token must immediately return 401 on /mcp');

    // Flow 2: OAuth client listing & admin revocation via /api/v1/oauth/clients
    const flow2 = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'read',
      clientName: `Revocable Client ${uid()}`,
      resource,
    });
    assert.strictEqual(flow2.ok, true, `flow2 failed: ${flow2.error}`);

    const mcpClient2 = createMcpClient({ baseUrl: server.baseUrl, token: flow2.accessToken });
    const pingBeforeClientDelete = await mcpClient2.ping();
    assert.strictEqual(pingBeforeClientDelete.status, 200);

    const listClientsBefore = await adminApi.get('/api/v1/oauth/clients');
    assert.strictEqual(listClientsBefore.status, 200);
    assertNoStore(listClientsBefore.headers, 'GET /api/v1/oauth/clients');
    assert.ok(!listClientsBefore.text.includes(flow2.accessToken), 'clients list must NEVER expose access tokens');
    assert.ok(!listClientsBefore.text.includes(flow2.refreshToken), 'clients list must NEVER expose refresh tokens');

    const clientsBefore = unwrapData(listClientsBefore.json, ['clients', 'items']);
    assert.ok(Array.isArray(clientsBefore), 'GET /api/v1/oauth/clients must return array');
    const matchesTargetClient = (c) =>
      [c?.id, c?.client_id, c?.clientId].includes(flow2.clientId);
    const foundClient = clientsBefore.find(matchesTargetClient);
    assert.ok(foundClient, `registered client ${flow2.clientId} must appear in GET /api/v1/oauth/clients`);

    const deleteClientId =
      foundClient.id ?? foundClient.client_id ?? foundClient.clientId ?? flow2.clientId;
    const delClientRes = await adminApi.del(`/api/v1/oauth/clients/${encodeURIComponent(deleteClientId)}`);
    assert.ok(
      delClientRes.status === 200 || delClientRes.status === 204,
      `DELETE /api/v1/oauth/clients/:id must return 200/204, got ${delClientRes.status}`
    );

    const pingAfterClientDelete = await mcpClient2.ping();
    assert.strictEqual(
      pingAfterClientDelete.status,
      401,
      'access token for deleted OAuth client must immediately return 401'
    );

    const listClientsAfter = await adminApi.get('/api/v1/oauth/clients');
    assert.strictEqual(listClientsAfter.status, 200);
    const clientsAfter = unwrapData(listClientsAfter.json, ['clients', 'items']);
    assert.ok(Array.isArray(clientsAfter));
    const stillActive = clientsAfter.find(
      (c) =>
        matchesTargetClient(c) &&
        c?.revoked !== true &&
        c?.status !== 'revoked'
    );
    assert.strictEqual(stillActive, undefined, 'deleted OAuth client must be removed from active clients');
  });
});

// ---------------------------------------------------------------------------
// 4. Scoped API Key Lifecycle & Dual Auth (Bearer + ?token=)
// ---------------------------------------------------------------------------
test('T1-C04: scoped API key lifecycle (raw secret once, masked list, Bearer & ?token=, immediate delete)', async () => {
  await withServer(async (server) => {
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
    const keyName = `Meta Muse Key ${uid()}`;

    const { keyId, rawSecret } = await mintApiKey(adminApi, {
      name: keyName,
      scope: 'propose',
      memberId: 'member_wife',
      actor: 'ai:muse',
    });

    const listRes = await adminApi.get('/api/v1/keys');
    assert.strictEqual(listRes.status, 200);
    assertNoStore(listRes.headers, 'GET /api/v1/keys');
    assert.ok(
      !listRes.text.includes(rawSecret),
      'GET /api/v1/keys must NEVER expose the raw API key secret after minting'
    );
    const keys = unwrapData(listRes.json, ['keys', 'apiKeys', 'items']);
    assert.ok(Array.isArray(keys), 'GET /api/v1/keys must return array');
    const entry = keys.find((k) => k?.id === keyId);
    assert.ok(entry, `minted key ${keyId} must appear in GET /api/v1/keys`);
    assert.strictEqual(entry.scope, 'propose');

    // Auth mode 1: Authorization: Bearer <rawSecret>
    const mcpBearer = createMcpClient({ baseUrl: server.baseUrl, token: rawSecret });
    await initMcp(mcpBearer);
    const pingBearer = await mcpBearer.ping();
    assert.strictEqual(pingBearer.status, 200);
    assert.strictEqual(pingBearer.error, null);
    const bearerTools = await mcpBearer.listTools();
    assert.strictEqual(bearerTools.result?.tools?.length, 15, 'propose API key must see 15 MCP tools');

    // Auth mode 2: ?token=<rawSecret> query fallback
    const mcpQuery = createMcpClient({
      baseUrl: server.baseUrl,
      token: rawSecret,
      tokenInQuery: true,
    });
    const pingQuery = await mcpQuery.ping();
    assert.strictEqual(pingQuery.status, 200, `MCP ?token= fallback failed: ${pingQuery.text}`);
    assert.strictEqual(pingQuery.error, null);

    const restQuery = createApiClient({
      baseUrl: server.baseUrl,
      token: rawSecret,
      tokenInQuery: true,
    });
    const sectionsQuery = await restQuery.get('/api/v1/sections');
    assert.strictEqual(sectionsQuery.status, 200, 'REST ?token= fallback must succeed');

    // Revoke API key
    const delRes = await adminApi.del(`/api/v1/keys/${encodeURIComponent(keyId)}`);
    assert.ok(delRes.status === 200 || delRes.status === 204, `DELETE /api/v1/keys/:id failed (${delRes.status})`);

    const bearerAfter = await mcpBearer.ping();
    assert.strictEqual(bearerAfter.status, 401, 'revoked API key via Bearer must return 401');

    const queryAfter = await mcpQuery.ping();
    assert.strictEqual(queryAfter.status, 401, 'revoked API key via ?token= must return 401');

    const listAfter = await adminApi.get('/api/v1/keys');
    assert.strictEqual(listAfter.status, 200);
    const keysAfter = unwrapData(listAfter.json, ['keys', 'apiKeys', 'items']);
    const stillActive = keysAfter.find(
      (k) => k?.id === keyId && k?.revoked !== true && k?.status !== 'revoked'
    );
    assert.strictEqual(stillActive, undefined, 'deleted API key must not remain active');
  });
});

// ---------------------------------------------------------------------------
// 5. MCP Protocol Handshake (2025-06-18 & 2024-11-05) & Streamable HTTP Transport
// ---------------------------------------------------------------------------
test('T1-C05: MCP handshake (2025-06-18 & 2024-11-05), notifications/initialized, ping, session ID & JSON-RPC batch', async () => {
  await withServer(async (server) => {
    // Primary protocol version: 2025-06-18
    const mcp2025 = createMcpClient({
      baseUrl: server.baseUrl,
      token: server.adminToken,
      protocolVersion: '2025-06-18',
    });
    const init2025 = await initMcp(mcp2025);
    assertNoStore(init2025.headers, 'initialize 2025-06-18');
    assert.strictEqual(init2025.result.protocolVersion, '2025-06-18');
    assert.ok(typeof init2025.result.capabilities === 'object' && init2025.result.capabilities !== null);
    assert.ok(
      typeof init2025.result.serverInfo?.name === 'string' && init2025.result.serverInfo.name.length > 0,
      'initialize must return serverInfo.name'
    );

    if (init2025.sessionId !== null) {
      assert.ok(typeof init2025.sessionId === 'string' && init2025.sessionId.length > 0);
      assert.strictEqual(mcp2025.getSessionId(), init2025.sessionId);
    }

    const ping2025 = await mcp2025.ping();
    assert.strictEqual(ping2025.status, 200);
    assertNoStore(ping2025.headers, 'ping 2025-06-18');
    assert.strictEqual(ping2025.error, null);
    assert.ok(ping2025.result !== null && typeof ping2025.result === 'object');

    // JSON-RPC 2.0 batch with 2 requests + 1 notification (notification must produce NO response)
    const batchRes = await mcp2025.batch([
      { id: 101, method: 'ping', params: {} },
      { method: 'notifications/initialized' },
      { id: 102, method: 'tools/list', params: {} },
    ]);
    assert.strictEqual(batchRes.status, 200, `MCP batch failed (${batchRes.status}): ${batchRes.text}`);
    assertNoStore(batchRes.headers, 'MCP batch');
    assert.strictEqual(batchRes.error, null);
    assert.ok(Array.isArray(batchRes.responses), 'MCP batch must return responses array');
    assert.strictEqual(
      batchRes.responses.length,
      2,
      `batch with 2 requests + 1 notification must return exactly 2 responses, got ${batchRes.responses.length}`
    );

    const r101 = batchRes.responses.find((r) => r.id === 101);
    const r102 = batchRes.responses.find((r) => r.id === 102);
    assert.ok(r101 && r101.error == null && r101.result !== undefined, 'batch ping response (id=101) must succeed');
    assert.ok(
      r102 && r102.error == null && Array.isArray(r102.result?.tools) && r102.result.tools.length === 17,
      'batch tools/list response (id=102) must return 17 tools'
    );

    // Backward-compatible protocol version: 2024-11-05
    const mcp2024 = createMcpClient({
      baseUrl: server.baseUrl,
      token: server.adminToken,
      protocolVersion: '2024-11-05',
    });
    const init2024 = await initMcp(mcp2024);
    assertNoStore(init2024.headers, 'initialize 2024-11-05');
    assert.strictEqual(init2024.result.protocolVersion, '2024-11-05');
    assert.ok(typeof init2024.result.serverInfo?.name === 'string' && init2024.result.serverInfo.name.length > 0);
    const ping2024 = await mcp2024.ping();
    assert.strictEqual(ping2024.status, 200);
    assert.strictEqual(ping2024.error, null);
  });
});

// ---------------------------------------------------------------------------
// 6. Complete 17-Tool MCP Inventory Verification (write scope)
// ---------------------------------------------------------------------------
test('T1-C06: tools/list on write OAuth token exposes exact 17 canonical MCP tools with valid schemas', async () => {
  await withServer(async (server) => {
    const flow = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'write',
      clientName: `Write Inventory Client ${uid()}`,
      resource: `${server.origin}/mcp`,
    });
    assert.strictEqual(flow.ok, true, `write OAuth flow failed: ${flow.error}`);

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: flow.accessToken });
    await initMcp(mcp);
    const res = await mcp.listTools();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.error, null);
    assertNoStore(res.headers, 'tools/list write');

    const tools = res.result?.tools;
    assert.ok(Array.isArray(tools), 'tools/list must return result.tools array');
    const names = tools.map((t) => t.name);
    assert.strictEqual(new Set(names).size, names.length, 'tools/list must not contain duplicate tool names');
    assert.deepEqual(
      [...names].sort(),
      [...ALL_17_CANONICAL_TOOLS].sort(),
      'write token tools/list must contain the exact 17 canonical MCP tools'
    );

    for (const tool of tools) {
      assert.ok(
        typeof tool.description === 'string' && tool.description.trim().length > 0,
        `tool ${tool.name} must have a non-empty description`
      );
      assert.ok(
        tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.type === 'object',
        `tool ${tool.name} must declare an object inputSchema`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 7. MCP Read Tools Execution (All 6 Read Discovery/Catalog Tools)
// ---------------------------------------------------------------------------
test('T1-C07: MCP read tools execute end-to-end (overview, sections, custom schema, search, get, duplicate check)', async () => {
  await withServer(async (server) => {
    const tag = uid('read');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Customize peptides section with custom field + aiResearchPrompt (restored in finally)
    const existingPepSec = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(existingPepSec.status, 200);
    const origPepSec = unwrapData(existingPepSec.json, ['section']);
    const currentFields = Array.isArray(origPepSec?.customFields) ? origPepSec.customFields : [];
    const origPrompt = origPepSec?.aiResearchPrompt ?? '';
    const customFieldKey = `coa_ref_${tag.slice(-6)}`;
    const customPrompt = `Always verify peptide purity and cite PubMed studies (${tag}).`;

    const patchSec = await adminApi.patch('/api/v1/sections/peptides', {
      aiResearchPrompt: customPrompt,
      customFields: [
        ...currentFields,
        fixtures.makeCustomSectionField({
          key: customFieldKey,
          label: 'Third-Party COA Reference',
          required: false,
          aiResearchInstruction: `Provide verified COA URL (${tag}).`,
        }),
      ],
    });
    assert.strictEqual(patchSec.status, 200, `PATCH section failed: ${patchSec.text}`);

    try {

    // Seed two compounds in distinct sections
    const pepName = `BPC-157 ${tag}`;
    const pepComp = await createCompoundApi(
      adminApi,
      fixtures.makePeptideCompound({
        name: pepName,
        canonicalMolecule: `bpc-157-${tag}`,
        aliases: [`PL 14736 ${tag}`],
      })
    );
    const dermAlias = `Retin-A ${tag}`;
    const dermComp = await createCompoundApi(
      adminApi,
      fixtures.makeDermCompound({
        name: `Tretinoin 0.05% Cream ${tag}`,
        canonicalMolecule: `tretinoin-${tag}`,
        aliases: [dermAlias],
      })
    );

    const { rawSecret: readKey } = await mintApiKey(adminApi, {
      name: `Read Tools Key ${tag}`,
      scope: 'read',
      actor: 'ai:gemini',
    });

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: readKey });
    await initMcp(mcp);
    const toolMap = await getToolMap(mcp);

    // 1. get_hub_overview
    const ovRes = await mcp.callTool('get_hub_overview', {});
    assert.strictEqual(ovRes.status, 200);
    assert.strictEqual(ovRes.error, null);
    assert.notStrictEqual(ovRes.result?.isError, true);
    const ovData = parseToolJson(ovRes);
    assert.ok(ovData && typeof ovData === 'object', 'get_hub_overview must return JSON object');
    const ovStr = JSON.stringify(ovData);
    assert.ok(ovStr.includes('peptides'), 'overview must reference core sections');
    assert.ok(ovStr.includes('member_wife') || ovStr.includes('Wife'), 'overview must reference default members');

    // 2. list_sections
    const lsRes = await mcp.callTool('list_sections', {});
    assert.strictEqual(lsRes.status, 200);
    assert.strictEqual(lsRes.error, null);
    assert.notStrictEqual(lsRes.result?.isError, true);
    const sections = unwrapData(parseToolJson(lsRes), ['sections', 'items']);
    assert.ok(Array.isArray(sections) && sections.length >= 4, 'list_sections must return >= 4 sections');
    const slugs = sections.map((s) => s.id);
    for (const coreSlug of CORE_SECTION_SLUGS) {
      assert.ok(slugs.includes(coreSlug), `list_sections must include core section '${coreSlug}'`);
    }

    // 3. get_section_schema (must dynamically reflect custom field + aiResearchPrompt)
    const schemaKey = pickSchemaKey(toolMap.get('get_section_schema'), ['sectionId', 'id', 'section'], 'sectionId');
    const gsRes = await mcp.callTool('get_section_schema', { [schemaKey]: 'peptides' });
    assert.strictEqual(gsRes.status, 200);
    assert.strictEqual(gsRes.error, null);
    assert.notStrictEqual(gsRes.result?.isError, true);
    const schemaData = parseToolJson(gsRes);
    const schemaStr = JSON.stringify(schemaData);
    assert.ok(schemaStr.includes(customFieldKey), `get_section_schema must include custom field ${customFieldKey}`);
    assert.ok(schemaStr.includes(customPrompt), 'get_section_schema must include updated aiResearchPrompt');

    // 4. search_compounds (query + section filter)
    const searchTool = toolMap.get('search_compounds');
    const qKey = pickSchemaKey(searchTool, ['q', 'query'], 'q');
    const secFilterKey = pickSchemaKey(searchTool, ['sectionId', 'section'], 'sectionId');
    const scRes = await mcp.callTool('search_compounds', { [qKey]: tag, [secFilterKey]: 'peptides' });
    assert.strictEqual(scRes.status, 200);
    assert.strictEqual(scRes.error, null);
    assert.notStrictEqual(scRes.result?.isError, true);
    const foundList = unwrapData(parseToolJson(scRes), ['compounds', 'results', 'items']);
    assert.ok(Array.isArray(foundList), 'search_compounds must return array');
    assert.ok(foundList.some((c) => c.id === pepComp.id), 'search_compounds must return matching peptide');
    assert.ok(!foundList.some((c) => c.id === dermComp.id), 'search_compounds section filter must exclude dermatology');

    // 5. get_compound
    const getCompKey = pickSchemaKey(toolMap.get('get_compound'), ['compoundId', 'id'], 'compoundId');
    const gcRes = await mcp.callTool('get_compound', { [getCompKey]: pepComp.id });
    assert.strictEqual(gcRes.status, 200);
    assert.strictEqual(gcRes.error, null);
    assert.notStrictEqual(gcRes.result?.isError, true);
    const fullComp = unwrapData(parseToolJson(gcRes), ['compound', 'profile']);
    assert.strictEqual(fullComp.id, pepComp.id);
    assert.strictEqual(fullComp.name, pepName);
    assert.strictEqual(fullComp.sectionId, 'peptides');
    assert.ok(typeof fullComp.mechanismOfAction === 'string' && fullComp.mechanismOfAction.length > 0);
    assert.ok(fullComp.dosages && typeof fullComp.dosages === 'object');
    assert.ok(fullComp.halfLife && typeof fullComp.halfLife === 'object');

    // 6. check_duplicate_compound (alias collision detection)
    const dupTool = toolMap.get('check_duplicate_compound');
    const dupSecKey = pickSchemaKey(dupTool, ['sectionId', 'section'], 'sectionId');
    const dupRes = await mcp.callTool('check_duplicate_compound', {
      name: dermAlias,
      [dupSecKey]: 'dermatology',
      route: 'Topical',
    });
    assert.strictEqual(dupRes.status, 200);
    assert.strictEqual(dupRes.error, null);
    assert.notStrictEqual(dupRes.result?.isError, true);
    const dupData = parseToolJson(dupRes);
    const dupStr = JSON.stringify(dupData);
    assert.ok(
      dupData?.isDuplicate === true ||
        dupData?.duplicate === true ||
        dupData?.hasDuplicate === true ||
        dupData?.exactMatch === true ||
        (Array.isArray(dupData?.matches) && dupData.matches.length > 0) ||
        dupData?.existingCompoundId === dermComp.id ||
        dupData?.compoundId === dermComp.id,
      `check_duplicate_compound must detect alias duplicate: ${dupStr}`
    );
    assert.ok(
      dupStr.includes(dermComp.id),
      `check_duplicate_compound must return existing compoundId ${dermComp.id}, got ${dupStr}`
    );
    } finally {
      try {
        await adminApi.patch('/api/v1/sections/peptides', {
          aiResearchPrompt: origPrompt,
          customFields: currentFields,
        });
      } catch {
        // Best-effort cleanup so original test failure is never masked
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. MCP AI Onboarding, Enrichment & Ownership Workflow
// ---------------------------------------------------------------------------
test('T1-C08: MCP AI onboarding (create_or_propose_compound -> ai_draft + provenance), enrich_compound & ownership', async () => {
  await withServer(async (server) => {
    const tag = uid('onboard');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
    const { rawSecret: proposeKey } = await mintApiKey(adminApi, {
      name: `Claude Onboarding Key ${tag}`,
      scope: 'propose',
      actor: 'ai:claude',
    });

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: proposeKey });
    await initMcp(mcp);
    const toolMap = await getToolMap(mcp);

    const citationUrl = 'https://pubmed.ncbi.nlm.nih.gov/12374906/';
    const baseCompound = fixtures.makePeptideCompound({
      name: `Epitalon ${tag}`,
      canonicalMolecule: `epitalon-${tag}`,
      aliases: [],
      tags: [],
      summary: `Synthetic tetrapeptide researched for pineal and telomerase biology (${tag}).`,
      detailedDescription: '',
      useCaseScenarios: ['Preclinical circadian peptide research'],
      benefits: [],
      contraindications: [],
      sideEffects: [],
      monitoringLabs: [],
      storageNotes: '',
      synergies: [],
      notes: '',
      provenance: {
        sourceModel: 'ai:claude',
        researchedAt: '2026-11-21T12:00:00.000Z',
        evidenceTier: 'working_hypothesis',
        confidence: 'medium',
        citations: [
          {
            title: 'Peptide bioregulation preclinical reference',
            url: citationUrl,
            pmid: '12374906',
          },
        ],
      },
    });

    // Step 1: create_or_propose_compound
    const createArgs = buildCreateCompoundArgs(toolMap.get('create_or_propose_compound'), baseCompound);
    const createRes = await mcp.callTool('create_or_propose_compound', createArgs);
    assert.strictEqual(createRes.status, 200, `create_or_propose_compound HTTP failed: ${createRes.text}`);
    assert.strictEqual(createRes.error, null, `create_or_propose_compound JSON-RPC error: ${JSON.stringify(createRes.error)}`);
    assert.notStrictEqual(createRes.result?.isError, true, `create_or_propose_compound isError: ${createRes.text}`);

    const createdParsed = parseToolJson(createRes);
    const createdObj = unwrapData(createdParsed, ['compound', 'profile']);
    const compoundId = createdObj?.id ?? createdParsed?.compoundId ?? createdParsed?.id;
    assert.ok(typeof compoundId === 'string' && compoundId.length > 0, `missing compoundId in ${JSON.stringify(createdParsed)}`);

    const persisted1 = await getCompoundApi(adminApi, compoundId);
    assert.strictEqual(persisted1.profileStatus, 'ai_draft', 'new AI compound must land as ai_draft by default');
    assert.strictEqual(persisted1.provenance?.evidenceTier, 'working_hypothesis');
    assert.ok(
      typeof persisted1.provenance?.sourceModel === 'string' &&
        persisted1.provenance.sourceModel.trim().length > 0,
      `persisted compound must retain non-empty provenance.sourceModel, got ${JSON.stringify(persisted1.provenance?.sourceModel)}`
    );
    assert.ok(
      typeof persisted1.provenance?.researchedAt === 'string' &&
        !Number.isNaN(Date.parse(persisted1.provenance.researchedAt)),
      `persisted compound must retain valid ISO provenance.researchedAt, got ${JSON.stringify(persisted1.provenance?.researchedAt)}`
    );
    assert.ok(
      Array.isArray(persisted1.provenance?.citations) &&
        persisted1.provenance.citations.some((c) => c?.url === citationUrl),
      'persisted compound must retain citation URL'
    );
    assert.ok(
      typeof persisted1.completenessPct === 'number' &&
        persisted1.completenessPct > 0 &&
        persisted1.completenessPct < 100,
      `expected 0 < completenessPct < 100 before enrichment, got ${persisted1.completenessPct}`
    );
    const initialCompleteness = persisted1.completenessPct;

    // Step 2: enrich_compound to fill blank fields and strictly increase completenessPct
    const enrichPatch = {
      aliases: [`Epithalon ${tag}`, `Ala-Glu-Asp-Gly ${tag}`],
      tags: ['peptide', 'pineal', 'circadian'],
      detailedDescription: `Expanded synthetic monograph describing Ala-Glu-Asp-Gly research profile (${tag}).`,
      benefits: ['Circadian rhythm research interest', 'Cellular senescence study marker'],
      contraindications: ['Pregnancy or nursing (insufficient clinical data)'],
      sideEffects: ['Mild transient injection-site redness'],
      monitoringLabs: ['CBC', 'CMP', 'hs-CRP'],
      storageNotes: 'Store lyophilized vial at -20C; keep reconstituted solution refrigerated at 2-8C.',
      synergies: [{ targetRef: 'magnesium', coLocate: false, reason: 'Evening sleep hygiene support' }],
      notes: `Enriched gap-filled reference notes (${tag}).`,
    };
    const enrichArgs = buildEnrichCompoundArgs(
      toolMap.get('enrich_compound'),
      compoundId,
      enrichPatch,
      { provenance: baseCompound.provenance }
    );
    const enrichRes = await mcp.callTool('enrich_compound', enrichArgs);
    assert.strictEqual(enrichRes.status, 200);
    assert.strictEqual(enrichRes.error, null, `enrich_compound error: ${JSON.stringify(enrichRes.error)}`);
    assert.notStrictEqual(enrichRes.result?.isError, true, `enrich_compound isError: ${enrichRes.text}`);

    const persisted2 = await getCompoundApi(adminApi, compoundId);
    assert.strictEqual(persisted2.summary, baseCompound.summary, 'enrichment must not clobber existing summary');
    assert.ok(persisted2.detailedDescription.includes(tag), 'enrichment must populate detailedDescription');
    assert.ok(persisted2.storageNotes.includes('2-8C'), 'enrichment must populate storageNotes');
    assert.ok(
      Array.isArray(persisted2.monitoringLabs) && persisted2.monitoringLabs.includes('CBC'),
      'enrichment must populate monitoringLabs'
    );
    assert.ok(
      typeof persisted2.completenessPct === 'number' && persisted2.completenessPct > initialCompleteness,
      `enrichment must strictly increase completenessPct (${initialCompleteness} -> ${persisted2.completenessPct})`
    );

    // Step 3: update_compound_ownership -> 'have' then 'low_stock'
    const ownTool = toolMap.get('update_compound_ownership');
    const ownRes1 = await mcp.callTool(
      'update_compound_ownership',
      buildOwnershipArgs(ownTool, compoundId, {
        scope: 'household',
        status: 'have',
        quantity: 2,
        unit: 'vials',
        notes: `Refrigerated synthetic inventory (${tag})`,
      })
    );
    assert.strictEqual(ownRes1.status, 200);
    assert.strictEqual(ownRes1.error, null);
    assert.notStrictEqual(ownRes1.result?.isError, true);

    const restOwn1 = await adminApi.get('/api/v1/ownership');
    assert.strictEqual(restOwn1.status, 200);
    const rec1 = findOwnershipEntry(restOwn1.json, compoundId, 'household');
    assert.ok(rec1, 'GET /api/v1/ownership must reflect MCP ownership update');
    assert.strictEqual(rec1.status, 'have');

    const ownRes2 = await mcp.callTool(
      'update_compound_ownership',
      buildOwnershipArgs(ownTool, compoundId, {
        scope: 'household',
        status: 'low_stock',
        quantity: 1,
        unit: 'vial',
      })
    );
    assert.strictEqual(ownRes2.status, 200);
    assert.strictEqual(ownRes2.error, null);
    assert.notStrictEqual(ownRes2.result?.isError, true);

    const restOwn2 = await adminApi.get('/api/v1/ownership');
    assert.strictEqual(restOwn2.status, 200);
    const rec2 = findOwnershipEntry(restOwn2.json, compoundId, 'household');
    assert.ok(rec2);
    assert.strictEqual(rec2.status, 'low_stock');
  });
});

// ---------------------------------------------------------------------------
// 9. MCP Section Config & Stack/Schedule Tools
// ---------------------------------------------------------------------------
test('T1-C09: MCP configure_section (write), get_member_stack, propose_stack_change, interactions, schedule & today', async () => {
  await withServer(async (server) => {
    const tag = uid('stack');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Mint write-scoped API key to exercise configure_section + stack tools
    const { rawSecret: writeKey } = await mintApiKey(adminApi, {
      name: `Write Stack Key ${tag}`,
      scope: 'write',
      actor: 'ai:gpt',
    });

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: writeKey });
    await initMcp(mcp);
    const toolMap = await getToolMap(mcp);

    // 1. configure_section on peptides (preserve & restore original section config in finally)
    const existingPep = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(existingPep.status, 200, `GET peptides section failed: ${existingPep.text}`);
    const origPepSec = unwrapData(existingPep.json, ['section']);
    const prevCustom = Array.isArray(origPepSec?.customFields) ? origPepSec.customFields : [];
    const origPrompt = origPepSec?.aiResearchPrompt ?? '';
    const newFieldKey = `batch_lot_${tag.slice(-6)}`;
    const newPrompt = `Document lyophilized peptide solvent and stability (${tag}).`;

    const cfgArgs = buildConfigureSectionArgs(toolMap.get('configure_section'), 'peptides', {
      aiResearchPrompt: newPrompt,
      customFields: [
        ...prevCustom,
        fixtures.makeCustomSectionField({
          key: newFieldKey,
          label: 'Manufacturer Lot ID',
          fieldType: 'text',
          required: false,
          aiResearchInstruction: 'Record lot reference when available.',
        }),
      ],
    });
    const cfgRes = await mcp.callTool('configure_section', cfgArgs);
    assert.strictEqual(cfgRes.status, 200);
    assert.strictEqual(cfgRes.error, null, `configure_section error: ${JSON.stringify(cfgRes.error)}`);
    assert.notStrictEqual(cfgRes.result?.isError, true, `configure_section isError: ${cfgRes.text}`);

    try {
      const schemaKey = pickSchemaKey(toolMap.get('get_section_schema'), ['sectionId', 'id', 'section'], 'sectionId');
      const verifySchemaRes = await mcp.callTool('get_section_schema', { [schemaKey]: 'peptides' });
      const verifySchemaStr = JSON.stringify(parseToolJson(verifySchemaRes));
      assert.ok(verifySchemaStr.includes(newFieldKey), 'configure_section custom field must persist in get_section_schema');
      assert.ok(verifySchemaStr.includes(newPrompt), 'configure_section aiResearchPrompt must persist');

      // Seed cross-section compounds + active stack for member_wife (distinct tag-scoped aliases)
      const pep = await createCompoundApi(
        adminApi,
        fixtures.makePeptideCompound({
          name: `BPC-157 ${tag}`,
          canonicalMolecule: `bpc-${tag}`,
          aliases: [`BPC-157 Alias ${tag}`],
        })
      );
      const supp = await createCompoundApi(
        adminApi,
        fixtures.makeSupplementCompound({
          name: `Magnesium Glycinate ${tag}`,
          canonicalMolecule: `mg-${tag}`,
          aliases: [`Mg Glycinate ${tag}`],
        })
      );
      const derm = await createCompoundApi(
        adminApi,
        fixtures.makeDermCompound({
          name: `Tretinoin Cream ${tag}`,
          canonicalMolecule: `tret-${tag}`,
          aliases: [`Tretinoin Alias ${tag}`],
        })
      );
      const extraSupp = await createCompoundApi(
        adminApi,
        fixtures.makeSupplementCompound({
          name: `Zinc Picolinate ${tag}`,
          canonicalMolecule: `zinc-${tag}`,
          aliases: [`Zinc ${tag}`],
          tags: ['zinc', 'mineral'],
          dosages: { defaultAmount: 15, defaultUnit: 'mg', route: 'Oral', rangeText: '15-30 mg', frequencyText: 'once daily' },
        })
      );

    const stackRes = await adminApi.post(
      '/api/v1/members/member_wife/stacks',
      fixtures.makeStackPayload({
        name: `Wife Cross-Section Stack ${tag}`,
        memberId: 'member_wife',
        active: true,
        items: [
          fixtures.makeStackItem({ compoundId: pep.id, doseAmount: 250, doseUnit: 'mcg' }),
          fixtures.makeStackItem({ compoundId: supp.id, doseAmount: 200, doseUnit: 'mg' }),
          fixtures.makeStackItem({ compoundId: derm.id, doseAmount: 1, doseUnit: 'pea_size' }),
        ],
      })
    );
    assert.ok(stackRes.status === 201 || stackRes.status === 200, `create stack failed: ${stackRes.text}`);
    const createdStack = unwrapData(stackRes.json, ['stack']);
    assert.ok(typeof createdStack?.id === 'string' && createdStack.id.length > 0);

    // 2. get_member_stack
    const gmsKey = pickSchemaKey(toolMap.get('get_member_stack'), ['memberId', 'member'], 'memberId');
    const gmsRes = await mcp.callTool('get_member_stack', { [gmsKey]: 'member_wife' });
    assert.strictEqual(gmsRes.status, 200);
    assert.strictEqual(gmsRes.error, null);
    assert.notStrictEqual(gmsRes.result?.isError, true);
    const gmsStr = JSON.stringify(parseToolJson(gmsRes));
    assert.ok(gmsStr.includes(pep.id), 'get_member_stack must include seeded peptide item');
    assert.ok(gmsStr.includes(supp.id), 'get_member_stack must include seeded supplement item');
    assert.ok(gmsStr.includes(derm.id), 'get_member_stack must include seeded dermatology item');

    // 3. propose_stack_change (creates pending proposal without silently mutating active stack)
    const proposalsBefore = await listProposalsApi(adminApi);
    const beforeIds = new Set(proposalsBefore.map((p) => p.id));

    const proposeArgs = buildProposeStackChangeArgs(toolMap.get('propose_stack_change'), {
      memberId: 'member_wife',
      stackId: createdStack.id,
      item: fixtures.makeStackItem({ compoundId: extraSupp.id, doseAmount: 15, doseUnit: 'mg' }),
      rationale: `Add Zinc separated from Magnesium (${tag})`,
    });
    const pscRes = await mcp.callTool('propose_stack_change', proposeArgs);
    assert.strictEqual(pscRes.status, 200);
    assert.strictEqual(pscRes.error, null, `propose_stack_change error: ${JSON.stringify(pscRes.error)}`);
    assert.notStrictEqual(pscRes.result?.isError, true, `propose_stack_change isError: ${pscRes.text}`);

    const proposalsAfter = await listProposalsApi(adminApi);
    const newProposal = proposalsAfter.find((p) => !beforeIds.has(p.id) && p.status === 'pending');
    assert.ok(newProposal, 'propose_stack_change must create a pending proposal in Proposals Inbox');

    // Confirm active stack was NOT silently mutated
    const stacksCheckRes = await adminApi.get('/api/v1/members/member_wife/stacks');
    assert.strictEqual(stacksCheckRes.status, 200);
    const liveStacks = unwrapData(stacksCheckRes.json, ['stacks', 'items']);
    const liveTarget = liveStacks.find((s) => s.id === createdStack.id);
    assert.ok(liveTarget, 'live stack must still exist');
    assert.strictEqual(liveTarget.items.length, 3, 'propose_stack_change must NOT silently mutate active stack');

    // 4. analyze_stack_interactions
    const asiTool = toolMap.get('analyze_stack_interactions');
    const asiArgs = { [pickSchemaKey(asiTool, ['memberId', 'member'], 'memberId')]: 'member_wife' };
    if (Object.prototype.hasOwnProperty.call(getSchemaProps(asiTool), 'stackId')) {
      asiArgs.stackId = createdStack.id;
    }
    const asiRes = await mcp.callTool('analyze_stack_interactions', asiArgs);
    assert.strictEqual(asiRes.status, 200);
    assert.strictEqual(asiRes.error, null);
    assert.notStrictEqual(asiRes.result?.isError, true);
    const interactions = unwrapData(parseToolJson(asiRes), ['interactions', 'analysis']);
    assert.ok(interactions && typeof interactions === 'object', 'analyze_stack_interactions must return object');
    for (const key of ['hardStops', 'avoidSameSlot', 'alternateDays', 'cautions', 'synergies', 'ulWarnings', 'safetyAlerts']) {
      assert.ok(
        Array.isArray(interactions[key]),
        `InteractionAnalysis must include array '${key}', got ${JSON.stringify(interactions)}`
      );
    }

    // 5. suggest_stack_schedule
    const sssTool = toolMap.get('suggest_stack_schedule');
    const sssArgs = { [pickSchemaKey(sssTool, ['memberId', 'member'], 'memberId')]: 'member_wife' };
    if (Object.prototype.hasOwnProperty.call(getSchemaProps(sssTool), 'stackId')) {
      sssArgs.stackId = createdStack.id;
    }
    const sssRes = await mcp.callTool('suggest_stack_schedule', sssArgs);
    assert.strictEqual(sssRes.status, 200);
    assert.strictEqual(sssRes.error, null);
    assert.notStrictEqual(sssRes.result?.isError, true);
    const spread = unwrapData(parseToolJson(sssRes), ['schedule', 'spread']);
    assert.ok(spread?.systemic && Array.isArray(spread.systemic.slots), 'SpreadResult must include systemic.slots[]');
    assert.strictEqual(spread.systemic.slots.length, 8, 'SpreadResult systemic track must have 8 canonical slots');
    assert.ok(spread?.dermatology?.skin && spread?.dermatology?.hairScalp, 'SpreadResult must include dermatology skin & hairScalp tracks');

    // 6. get_today_schedule
    const gtsTool = toolMap.get('get_today_schedule');
    const gtsArgs = { [pickSchemaKey(gtsTool, ['memberId', 'member'], 'memberId')]: 'member_wife' };
    const dateArg = pickSchemaKey(gtsTool, ['dateKey', 'date'], 'dateKey');
    if (Object.prototype.hasOwnProperty.call(getSchemaProps(gtsTool), dateArg)) {
      gtsArgs[dateArg] = '2026-11-23';
    }
    const gtsRes = await mcp.callTool('get_today_schedule', gtsArgs);
    assert.strictEqual(gtsRes.status, 200);
    assert.strictEqual(gtsRes.error, null);
    assert.notStrictEqual(gtsRes.result?.isError, true);
    const todayData = parseToolJson(gtsRes);
    assert.ok(todayData && typeof todayData === 'object', 'get_today_schedule must return structured JSON');
    const todayStr = JSON.stringify(todayData);
    assert.ok(
      todayStr.includes(pep.id) || todayStr.includes(pep.name) || todayStr.includes(supp.id) || todayStr.includes(supp.name),
      `get_today_schedule must reflect active stack compounds, got ${todayStr.slice(0, 300)}`
    );
    } finally {
      try {
        await adminApi.patch('/api/v1/sections/peptides', {
          aiResearchPrompt: origPrompt,
          customFields: prevCustom,
        });
      } catch {
        // Best-effort cleanup so original test failure is never masked
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. MCP & REST Proposals Inbox Lifecycle (Approve & Dismiss on Both Surfaces)
// ---------------------------------------------------------------------------
test('T1-C10: proposals inbox lifecycle via MCP (list_proposals / resolve_proposal) and REST (approve & dismiss)', async () => {
  await withServer(async (server) => {
    const tag = uid('prop');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Seed 4 verified compounds with distinct tag-scoped aliases so AI edits route deterministically to Proposals Inbox
    const origSummaries = [
      `Verified baseline summary 1 (${tag})`,
      `Verified baseline summary 2 (${tag})`,
      `Verified baseline summary 3 (${tag})`,
      `Verified baseline summary 4 (${tag})`,
    ];
    const comps = [];
    for (let i = 0; i < 4; i += 1) {
      const c = await createCompoundApi(
        adminApi,
        fixtures.makePeptideCompound({
          name: `ProposalPeptide${i + 1} ${tag}`,
          canonicalMolecule: `prop-pep-${i + 1}-${tag}`,
          aliases: [`ProposalPeptideAlias${i + 1} ${tag}`],
          summary: origSummaries[i],
        })
      );
      await verifyCompoundApi(adminApi, c.id);
      comps.push(c);
    }

    // Mint propose-scoped AI token to create 4 pending proposals via verified-field edits
    const { rawSecret: proposeKey } = await mintApiKey(adminApi, {
      name: `Propose Inbox Key ${tag}`,
      scope: 'propose',
      actor: 'ai:claude',
    });
    const mcpPropose = createMcpClient({ baseUrl: server.baseUrl, token: proposeKey });
    await initMcp(mcpPropose);
    const proposeTools = await getToolMap(mcpPropose);

    const beforeIds = new Set((await listProposalsApi(adminApi)).map((p) => p.id));
    const proposedSummaries = [
      `Approved via MCP (${tag})`,
      `Dismissed via REST (${tag})`,
      `Approved via REST (${tag})`,
      `Dismissed via MCP (${tag})`,
    ];
    const createdProps = [];
    for (let i = 0; i < 4; i += 1) {
      const propCallRes = await mcpPropose.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(proposeTools.get('enrich_compound'), comps[i].id, {
          summary: proposedSummaries[i],
        })
      );
      assert.strictEqual(propCallRes.status, 200, `enrich_compound verified edit ${i + 1} HTTP failed: ${propCallRes.text}`);
      const after = await listProposalsApi(adminApi);
      const created = after.find((p) => !beforeIds.has(p.id) && p.status === 'pending');
      assert.ok(created, `verified-field edit ${i + 1} must create a pending proposal`);
      beforeIds.add(created.id);
      createdProps.push(created);
    }

    // Verify all pending proposals are visible via MCP list_proposals
    const mcpWrite = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    await initMcp(mcpWrite);
    const writeTools = await getToolMap(mcpWrite);

    const mcpListRes = await mcpWrite.callTool('list_proposals', {});
    assert.strictEqual(mcpListRes.status, 200);
    assert.strictEqual(mcpListRes.error, null);
    const mcpProposals = unwrapData(parseToolJson(mcpListRes), ['proposals', 'items']);
    assert.ok(Array.isArray(mcpProposals), 'MCP list_proposals must return array');
    for (const p of createdProps) {
      assert.ok(mcpProposals.some((x) => x.id === p.id), `MCP list_proposals must contain proposal ${p.id}`);
    }

    // 1. Approve via MCP resolve_proposal (write scope)
    const approveMcpRes = await mcpWrite.callTool(
      'resolve_proposal',
      buildResolveProposalArgs(writeTools.get('resolve_proposal'), createdProps[0].id, 'approve')
    );
    assert.strictEqual(approveMcpRes.status, 200);
    assert.strictEqual(approveMcpRes.error, null, `resolve_proposal approve error: ${JSON.stringify(approveMcpRes.error)}`);
    assert.notStrictEqual(approveMcpRes.result?.isError, true, `resolve_proposal approve isError: ${approveMcpRes.text}`);
    assert.strictEqual(
      (await getCompoundApi(adminApi, comps[0].id)).summary,
      proposedSummaries[0],
      'approving proposal via MCP resolve_proposal must apply change to target compound'
    );

    // 2. Dismiss via REST POST /api/v1/proposals/:id/resolve
    const dismissRestRes = await adminApi.post(
      `/api/v1/proposals/${encodeURIComponent(createdProps[1].id)}/resolve`,
      { action: 'dismiss' }
    );
    assert.strictEqual(dismissRestRes.status, 200, `REST dismiss failed (${dismissRestRes.status}): ${dismissRestRes.text}`);
    assertNoStore(dismissRestRes.headers, 'POST /api/v1/proposals/:id/resolve (dismiss)');
    assert.strictEqual(
      (await getCompoundApi(adminApi, comps[1].id)).summary,
      origSummaries[1],
      'dismissing proposal via REST must leave target compound completely unmodified'
    );

    // 3. Approve via REST POST /api/v1/proposals/:id/resolve
    const approveRestRes = await adminApi.post(
      `/api/v1/proposals/${encodeURIComponent(createdProps[2].id)}/resolve`,
      { action: 'approve' }
    );
    assert.strictEqual(approveRestRes.status, 200, `REST approve failed (${approveRestRes.status}): ${approveRestRes.text}`);
    assertNoStore(approveRestRes.headers, 'POST /api/v1/proposals/:id/resolve (approve)');
    assert.strictEqual(
      (await getCompoundApi(adminApi, comps[2].id)).summary,
      proposedSummaries[2],
      'approving proposal via REST must apply change to target compound'
    );

    // 4. Dismiss via MCP resolve_proposal (write scope)
    const dismissMcpRes = await mcpWrite.callTool(
      'resolve_proposal',
      buildResolveProposalArgs(writeTools.get('resolve_proposal'), createdProps[3].id, 'dismiss')
    );
    assert.strictEqual(dismissMcpRes.status, 200);
    assert.strictEqual(dismissMcpRes.error, null, `resolve_proposal dismiss error: ${JSON.stringify(dismissMcpRes.error)}`);
    assert.notStrictEqual(dismissMcpRes.result?.isError, true, `resolve_proposal dismiss isError: ${dismissMcpRes.text}`);
    assert.strictEqual(
      (await getCompoundApi(adminApi, comps[3].id)).summary,
      origSummaries[3],
      'dismissing proposal via MCP resolve_proposal must leave target compound unmodified'
    );

    // Confirm final statuses in REST GET /api/v1/proposals (handling pending-only default via ?status=all fallback)
    const defaultProposals = await listProposalsApi(adminApi);
    for (const resolvedProp of createdProps) {
      const inDefault = defaultProposals.find((p) => p.id === resolvedProp.id);
      assert.notStrictEqual(
        inDefault?.status,
        'pending',
        `resolved proposal ${resolvedProp.id} must no longer be pending in GET /api/v1/proposals`
      );
    }
    let byId = new Map(defaultProposals.map((p) => [p.id, p]));
    if (createdProps.some((p) => !byId.has(p.id))) {
      const allProposals = await listProposalsApi(adminApi, { status: 'all' });
      byId = new Map(allProposals.map((p) => [p.id, p]));
    }
    for (const approvedProp of [createdProps[0], createdProps[2]]) {
      const f = byId.get(approvedProp.id);
      assert.ok(
        f && (f.status === 'approved' || f.status === 'applied'),
        `expected proposal ${approvedProp.id} status approved/applied, got ${JSON.stringify(f?.status)}`
      );
    }
    for (const dismissedProp of [createdProps[1], createdProps[3]]) {
      const f = byId.get(dismissedProp.id);
      assert.ok(
        f && (f.status === 'dismissed' || f.status === 'rejected'),
        `expected proposal ${dismissedProp.id} status dismissed/rejected, got ${JSON.stringify(f?.status)}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 11. MCP Resources (resources/list + resources/read for All 5 Canonical URIs)
// ---------------------------------------------------------------------------
test('T1-C11: MCP resources/list and resources/read for all 5 canonical hub:// URIs', async () => {
  await withServer(async (server) => {
    const tag = uid('res');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    const comp = await createCompoundApi(
      adminApi,
      fixtures.makePeptideCompound({
        name: `GHK-Cu ${tag}`,
        canonicalMolecule: `ghk-cu-${tag}`,
        aliases: [`GHK-Cu Alias ${tag}`],
      })
    );
    const stackRes = await adminApi.post(
      '/api/v1/members/member_wife/stacks',
      fixtures.makeStackPayload({
        name: `Resource Stack ${tag}`,
        memberId: 'member_wife',
        active: true,
        items: [fixtures.makeStackItem({ compoundId: comp.id, doseAmount: 2, doseUnit: 'mg' })],
      })
    );
    assert.ok(stackRes.status === 201 || stackRes.status === 200);

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    await initMcp(mcp);

    const listRes = await mcp.listResources();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.error, null);
    assert.ok(
      Array.isArray(listRes.result?.resources) && listRes.result.resources.length >= 2,
      'resources/list must return discoverable resources'
    );
    const listedUris = listRes.result.resources.map((r) => r.uri);
    assert.ok(listedUris.includes('hub://overview'), 'resources/list must include hub://overview');
    assert.ok(listedUris.includes('hub://sections'), 'resources/list must include hub://sections');

    // Read all 5 canonical resource URIs
    const uris = [
      'hub://overview',
      'hub://sections',
      `hub://compounds/${comp.id}`,
      'hub://members/member_wife/stack',
      'hub://members/member_wife/schedule',
    ];

    const parsedByUri = new Map();
    for (const uri of uris) {
      const readRes = await mcp.readResource(uri);
      assert.strictEqual(readRes.status, 200, `resources/read ${uri} failed (${readRes.status}): ${readRes.text}`);
      assert.strictEqual(readRes.error, null, `resources/read ${uri} error: ${JSON.stringify(readRes.error)}`);
      assert.ok(
        Array.isArray(readRes.result?.contents) && readRes.result.contents.length >= 1,
        `resources/read ${uri} must return non-empty contents[]`
      );
      assert.strictEqual(readRes.result.contents[0].uri, uri, `contents[0].uri must match ${uri}`);
      parsedByUri.set(uri, parseToolJson(readRes));
    }

    assert.ok(JSON.stringify(parsedByUri.get('hub://overview')).includes('member_wife'));

    const sectionsPayload = unwrapData(parsedByUri.get('hub://sections'), ['sections', 'items']);
    assert.ok(Array.isArray(sectionsPayload));
    for (const slug of CORE_SECTION_SLUGS) {
      assert.ok(sectionsPayload.some((s) => s.id === slug), `hub://sections must include ${slug}`);
    }

    const compPayload = unwrapData(parsedByUri.get(`hub://compounds/${comp.id}`), ['compound', 'profile']);
    assert.strictEqual(compPayload.id, comp.id);
    assert.strictEqual(compPayload.name, comp.name);

    const stackPayloadStr = JSON.stringify(parsedByUri.get('hub://members/member_wife/stack'));
    assert.ok(stackPayloadStr.includes(comp.id), 'hub://members/member_wife/stack must include seeded compound');

    const schedPayload = unwrapData(parsedByUri.get('hub://members/member_wife/schedule'), ['schedule', 'spread']);
    assert.ok(
      schedPayload?.systemic && schedPayload?.dermatology,
      'hub://members/member_wife/schedule must return SpreadResult with systemic & dermatology'
    );
  });
});

// ---------------------------------------------------------------------------
// 12. MCP Prompts (prompts/list + prompts/get for All 3 Canonical Prompts)
// ---------------------------------------------------------------------------
test('T1-C12: MCP prompts/list and prompts/get for research_compound, review_stack_safety & optimize_daily_schedule', async () => {
  await withServer(async (server) => {
    const tag = uid('prompt');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Customize peptides section so research_compound prompt reflects dynamic schema (restored in finally)
    const curPepRes = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(curPepRes.status, 200, `GET peptides section failed: ${curPepRes.text}`);
    const curPep = unwrapData(curPepRes.json, ['section']);
    const origCustomFields = Array.isArray(curPep?.customFields) ? curPep.customFields : [];
    const origPrompt = curPep?.aiResearchPrompt ?? '';
    const customKey = `hplc_cert_${tag.slice(-6)}`;
    const customInstr = `Include third-party HPLC assay purity (${tag}).`;
    const patchPepRes = await adminApi.patch('/api/v1/sections/peptides', {
      aiResearchPrompt: customInstr,
      customFields: [
        ...origCustomFields,
        fixtures.makeCustomSectionField({
          key: customKey,
          label: 'HPLC Purity Certificate',
          required: false,
          aiResearchInstruction: customInstr,
        }),
      ],
    });
    assert.ok(
      [200, 201].includes(patchPepRes.status),
      `PATCH peptides section failed (${patchPepRes.status}): ${patchPepRes.text}`
    );

    try {
      const comp = await createCompoundApi(
        adminApi,
        fixtures.makePeptideCompound({
          name: `TB-500 ${tag}`,
          canonicalMolecule: `tb500-${tag}`,
          aliases: [`TB-500 Alias ${tag}`],
        })
      );
      const stackSeedRes = await adminApi.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: `Prompt Stack ${tag}`,
          memberId: 'member_wife',
          active: true,
          items: [fixtures.makeStackItem({ compoundId: comp.id })],
        })
      );
      assert.ok(
        [200, 201].includes(stackSeedRes.status),
        `POST member_wife stack failed (${stackSeedRes.status}): ${stackSeedRes.text}`
      );

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    await initMcp(mcp);

    const listRes = await mcp.listPrompts();
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.error, null);
    const prompts = listRes.result?.prompts;
    assert.ok(Array.isArray(prompts), 'prompts/list must return prompts array');
    const promptMap = new Map(prompts.map((p) => [p.name, p]));
    for (const expectedName of CANONICAL_PROMPTS) {
      assert.ok(promptMap.has(expectedName), `prompts/list must include '${expectedName}'`);
    }

    // 1. research_compound
    const rcArgs = buildPromptArgs(promptMap.get('research_compound'), {
      compound: `Semax ${tag}`,
      sectionId: 'peptides',
      fallback: { compoundName: `Semax ${tag}`, name: `Semax ${tag}`, sectionId: 'peptides' },
    });
    const rcRes = await mcp.getPrompt('research_compound', rcArgs);
    assert.strictEqual(rcRes.status, 200);
    assert.strictEqual(rcRes.error, null, `prompts/get research_compound error: ${JSON.stringify(rcRes.error)}`);
    const rcText = extractPromptText(rcRes.result);
    assert.ok(rcText.length > 40, 'research_compound prompt must contain substantive instructions');
    assert.ok(
      rcText.includes(`Semax ${tag}`) || /peptides/i.test(rcText),
      'research_compound prompt must reference requested compound/section'
    );
    assert.ok(
      rcText.includes(customKey) || rcText.includes(customInstr) || /hplc/i.test(rcText),
      'research_compound prompt must reflect customized section schema / aiResearchPrompt'
    );

    // 2. review_stack_safety
    const rssArgs = buildPromptArgs(promptMap.get('review_stack_safety'), {
      memberId: 'member_wife',
      fallback: { memberId: 'member_wife' },
    });
    const rssRes = await mcp.getPrompt('review_stack_safety', rssArgs);
    assert.strictEqual(rssRes.status, 200);
    assert.strictEqual(rssRes.error, null);
    const rssText = extractPromptText(rssRes.result);
    assert.ok(rssText.length > 30, 'review_stack_safety prompt must be substantive');
    assert.ok(/safety|interaction|hard.?stop|stack|risk|contraindicat/i.test(rssText));

    // 3. optimize_daily_schedule
    const odsArgs = buildPromptArgs(promptMap.get('optimize_daily_schedule'), {
      memberId: 'member_wife',
      fallback: { memberId: 'member_wife' },
    });
    const odsRes = await mcp.getPrompt('optimize_daily_schedule', odsArgs);
    assert.strictEqual(odsRes.status, 200);
    assert.strictEqual(odsRes.error, null);
    const odsText = extractPromptText(odsRes.result);
    assert.ok(odsText.length > 30, 'optimize_daily_schedule prompt must be substantive');
    assert.ok(/schedule|timing|slot|spread|routine|day|morning|evening/i.test(odsText));
    } finally {
      try {
        await adminApi.patch('/api/v1/sections/peptides', {
          aiResearchPrompt: origPrompt,
          customFields: origCustomFields,
        });
      } catch {
        // Best-effort cleanup so original test failure is never masked
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Immutable Audit Log (Distinct Member & AI Actors + Append-Only Enforcement)
// ---------------------------------------------------------------------------
test('T1-C13: immutable audit log records distinct member:* and ai:* actors, changedFields, timestamps & rejects mutation', async () => {
  await withServer(async (server) => {
    const tag = uid('audit');
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Mutation 1 & 2 via household member/admin token
    const memberComp = await createCompoundApi(
      adminApi,
      fixtures.makeSupplementCompound({
        name: `Vitamin D3 ${tag}`,
        canonicalMolecule: `vitd3-${tag}`,
        aliases: [`Cholecalciferol ${tag}`],
      })
    );
    const patchRes = await adminApi.patch(`/api/v1/compounds/${encodeURIComponent(memberComp.id)}`, {
      notes: `Updated by household member (${tag})`,
    });
    assert.strictEqual(patchRes.status, 200);

    // Mutation 3 via AI actor token (ai:claude)
    const { rawSecret: aiKey } = await mintApiKey(adminApi, {
      name: `Claude Audit Key ${tag}`,
      scope: 'propose',
      actor: 'ai:claude',
    });
    const mcpAi = createMcpClient({ baseUrl: server.baseUrl, token: aiKey });
    await initMcp(mcpAi);
    const aiTools = await getToolMap(mcpAi);
    const aiCreate = await mcpAi.callTool(
      'create_or_propose_compound',
      buildCreateCompoundArgs(
        aiTools.get('create_or_propose_compound'),
        fixtures.makePeptideCompound({
          name: `MOTS-c ${tag}`,
          canonicalMolecule: `motsc-${tag}`,
          aliases: [`MOTS-c Alias ${tag}`],
          provenance: {
            sourceModel: 'ai:claude',
            researchedAt: new Date().toISOString(),
            evidenceTier: 'working_hypothesis',
            confidence: 'medium',
            citations: [{ title: 'Mitochondrial peptide overview', url: 'https://pubmed.ncbi.nlm.nih.gov/25738459/' }],
          },
        })
      )
    );
    assert.strictEqual(aiCreate.status, 200);
    assert.strictEqual(aiCreate.error, null);
    assert.notStrictEqual(aiCreate.result?.isError, true);

    const logRes1 = await adminApi.get('/api/v1/audit-log');
    assert.strictEqual(logRes1.status, 200);
    assertNoStore(logRes1.headers, 'GET /api/v1/audit-log');
    const entries1 = unwrapData(logRes1.json, ['auditLog', 'audit_log', 'entries', 'items']);
    assert.ok(Array.isArray(entries1) && entries1.length >= 2, `expected >= 2 audit entries, got ${entries1?.length}`);

    for (const entry of entries1) {
      assert.ok(typeof entry.actor === 'string' && entry.actor.trim().length > 0, 'audit entry must have actor');
      assert.ok(typeof entry.action === 'string' && entry.action.trim().length > 0, 'audit entry must have action');
      const ts = entry.timestamp ?? entry.createdAt;
      assert.ok(typeof ts === 'string' && !Number.isNaN(Date.parse(ts)), `audit entry must have ISO timestamp, got ${ts}`);
      if (entry.changedFields !== undefined) {
        assert.ok(Array.isArray(entry.changedFields), 'audit entry changedFields must be array');
      }
    }

    const actors = entries1.map((e) => e.actor);
    assert.ok(actors.some((a) => /^ai:/i.test(a)), `audit log must record an ai:* actor, saw ${JSON.stringify(actors)}`);
    assert.ok(
      actors.some((a) => /^(member:|household|admin)/i.test(a)),
      `audit log must record a member/household actor, saw ${JSON.stringify(actors)}`
    );
    assert.ok(new Set(actors).size >= 2, 'audit log must distinguish member vs AI actors');
    assert.ok(
      entries1.some((e) => Array.isArray(e.changedFields) && e.changedFields.length > 0),
      'audit log mutation entries must record non-empty changedFields[]'
    );

    // Monotonic append-only growth after another mutation
    const prevIds = entries1.map((e) => e.id).filter(Boolean);
    const ownPutRes = await adminApi.put(`/api/v1/ownership/${encodeURIComponent(memberComp.id)}`, {
      scope: 'household',
      status: 'have',
    });
    assert.ok(
      [200, 201].includes(ownPutRes.status),
      `PUT /api/v1/ownership failed (${ownPutRes.status}): ${ownPutRes.text}`
    );

    const logRes2 = await adminApi.get('/api/v1/audit-log');
    assert.strictEqual(logRes2.status, 200);
    const entries2 = unwrapData(logRes2.json, ['auditLog', 'audit_log', 'entries', 'items']);
    assert.ok(entries2.length > entries1.length, 'audit log must grow monotonically on new mutations');
    const afterIds = new Set(entries2.map((e) => e.id).filter(Boolean));
    for (const id of prevIds) {
      assert.ok(afterIds.has(id), `audit log entry ${id} must never disappear`);
    }

    // Immutability: DELETE and PUT on /api/v1/audit-log must be rejected (403/404/405)
    const delLog = await adminApi.del('/api/v1/audit-log');
    assert.ok(
      [403, 404, 405].includes(delLog.status),
      `DELETE /api/v1/audit-log must be rejected (403/404/405), got ${delLog.status}`
    );
    const putLog = await adminApi.put('/api/v1/audit-log', { entries: [] });
    assert.ok(
      [403, 404, 405].includes(putLog.status),
      `PUT /api/v1/audit-log must be rejected (403/404/405), got ${putLog.status}`
    );

    const logRes3 = await adminApi.get('/api/v1/audit-log');
    assert.strictEqual(logRes3.status, 200);
    const entries3 = unwrapData(logRes3.json, ['auditLog', 'audit_log', 'entries', 'items']);
    assert.ok(entries3.length >= entries2.length, 'audit log entries must remain intact after rejected mutations');
  });
});

// ---------------------------------------------------------------------------
// 14. OpenAPI 3.1.0, Public llms.txt, Authenticated Context Bundles & AI Prompt Builder
// ---------------------------------------------------------------------------
test('T1-C14: OpenAPI 3.1.0 (/openapi.json), public /llms.txt, context bundles (.md/.json) & schema-strict research prompt', async () => {
  await withServer(async (server) => {
    const tag = uid('disc');
    const pubApi = createApiClient({ baseUrl: server.baseUrl });
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Customize peptides section & seed compound (restored in finally)
    const curPepRes = await adminApi.get('/api/v1/sections/peptides');
    assert.strictEqual(curPepRes.status, 200, `GET peptides section failed: ${curPepRes.text}`);
    const curPep = unwrapData(curPepRes.json, ['section']);
    const origCustomFields = Array.isArray(curPep?.customFields) ? curPep.customFields : [];
    const origPrompt = curPep?.aiResearchPrompt ?? '';
    const customKey = `purity_pct_${tag.slice(-6)}`;
    const customSecPrompt = `Specify reconstitution solvent and shelf life (${tag}).`;
    const patchPepRes = await adminApi.patch('/api/v1/sections/peptides', {
      aiResearchPrompt: customSecPrompt,
      customFields: [
        ...origCustomFields,
        fixtures.makeCustomSectionField({
          key: customKey,
          label: 'Analytical HPLC Purity %',
          fieldType: 'number',
          required: false,
          aiResearchInstruction: 'Provide analytical HPLC purity percentage.',
        }),
      ],
    });
    assert.ok(
      [200, 201].includes(patchPepRes.status),
      `PATCH peptides section failed (${patchPepRes.status}): ${patchPepRes.text}`
    );

    try {
      const seededName = `Epitalon Bundle ${tag}`;
      const seededComp = await createCompoundApi(
        adminApi,
        fixtures.makePeptideCompound({
          name: seededName,
          canonicalMolecule: `epitalon-b-${tag}`,
          aliases: [`Epitalon Bundle Alias ${tag}`],
        })
      );
      const stackSeedRes = await adminApi.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: `Bundle Stack ${tag}`,
          memberId: 'member_wife',
          active: true,
          items: [fixtures.makeStackItem({ compoundId: seededComp.id })],
        })
      );
      assert.ok(
        [200, 201].includes(stackSeedRes.status),
        `POST member_wife stack failed (${stackSeedRes.status}): ${stackSeedRes.text}`
      );

    // 1. GET /openapi.json (public OpenAPI 3.1.0 with unique operationIds)
    const oaRes = await pubApi.get('/openapi.json', { auth: false });
    assert.strictEqual(oaRes.status, 200);
    assert.ok(String(oaRes.headers.get('content-type') || '').toLowerCase().includes('application/json'));
    const oa = oaRes.json;
    assert.strictEqual(oa?.openapi, '3.1.0', 'OpenAPI spec version must be 3.1.0');
    assert.ok(typeof oa?.info?.title === 'string' && oa.info.title.length > 0);
    assert.ok(typeof oa?.info?.version === 'string' && oa.info.version.length > 0);
    assert.ok(oa?.paths && typeof oa.paths === 'object' && Object.keys(oa.paths).length >= 5);

    const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
    const seenOpIds = new Set();
    let opCount = 0;
    for (const [pathKey, pathItem] of Object.entries(oa.paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const [method, op] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;
        opCount += 1;
        assert.ok(
          typeof op?.operationId === 'string' && op.operationId.trim().length > 0,
          `OpenAPI ${method.toUpperCase()} ${pathKey} missing non-empty operationId`
        );
        assert.ok(
          !seenOpIds.has(op.operationId),
          `Duplicate OpenAPI operationId: ${op.operationId}`
        );
        seenOpIds.add(op.operationId);
      }
    }
    assert.ok(opCount >= 10, `expected >= 10 OpenAPI operations, found ${opCount}`);

    // 2. GET /llms.txt (public, zero PII, references /mcp and /openapi.json)
    const llmsRes = await pubApi.get('/llms.txt', { auth: false });
    assert.strictEqual(llmsRes.status, 200);
    assert.ok(
      /text\/(plain|markdown)/i.test(String(llmsRes.headers.get('content-type') || '')),
      `llms.txt must return text/plain or text/markdown, got ${llmsRes.headers.get('content-type')}`
    );
    assert.ok(llmsRes.text.includes('/mcp'), 'llms.txt must reference /mcp endpoint');
    assert.ok(llmsRes.text.includes('/openapi.json'), 'llms.txt must reference /openapi.json endpoint');
    assert.ok(!llmsRes.text.includes(seededName), 'public llms.txt must not leak household compounds');
    assert.ok(!llmsRes.text.includes(server.adminToken), 'public llms.txt must not leak adminToken');

    // 3. Authenticated Context Bundles (.md & .json)
    const mdRes = await adminApi.get('/api/v1/export/context.md');
    assert.strictEqual(mdRes.status, 200);
    assertNoStore(mdRes.headers, 'GET /api/v1/export/context.md');
    assert.ok(/text\/(markdown|plain)/i.test(String(mdRes.headers.get('content-type') || '')));
    assert.ok(mdRes.text.includes(seededName), 'context.md must include seeded compound');

    const jsonRes = await adminApi.get('/api/v1/export/context.json');
    assert.strictEqual(jsonRes.status, 200);
    assertNoStore(jsonRes.headers, 'GET /api/v1/export/context.json');
    assert.ok(String(jsonRes.headers.get('content-type') || '').toLowerCase().includes('application/json'));
    assert.ok(jsonRes.json && typeof jsonRes.json === 'object');
    assert.ok(jsonRes.text.includes(seededName), 'context.json must include seeded compound');

    // 4. Schema-Strict AI Research Prompt Builder (POST /api/v1/ai/research-prompt)
    const targetName = `KPV Peptide ${tag}`;
    const promptRes = await adminApi.post('/api/v1/ai/research-prompt', {
      name: targetName,
      compoundName: targetName,
      sectionId: 'peptides',
      notes: 'Focus on anti-inflammatory tripeptide mechanism',
    });
    assert.strictEqual(promptRes.status, 200, `research-prompt failed (${promptRes.status}): ${promptRes.text}`);
    assertNoStore(promptRes.headers, 'POST /api/v1/ai/research-prompt');
    const promptText =
      promptRes.json?.prompt ??
      promptRes.json?.researchPrompt ??
      promptRes.json?.data?.prompt ??
      promptRes.json?.data?.researchPrompt ??
      promptRes.json?.text ??
      promptRes.json?.data?.text ??
      (typeof promptRes.json === 'string'
        ? promptRes.json
        : promptRes.json === null
          ? promptRes.text
          : '');
    assert.ok(typeof promptText === 'string' && promptText.length > 60, 'research-prompt must return substantive prompt string');
    assert.ok(promptText.includes(targetName), 'research-prompt must include requested compound name');
    assert.ok(/peptides/i.test(promptText), 'research-prompt must reference requested section');
    assert.ok(
      promptText.includes(customKey) || promptText.includes('Analytical HPLC Purity'),
      `research-prompt must reflect section custom field ${customKey}`
    );
    assert.ok(
      promptText.includes(customSecPrompt) || /reconstitution solvent/i.test(promptText),
      'research-prompt must include section aiResearchPrompt'
    );
    assert.ok(
      /mechanism|half.?life|dosage|cycle|json/i.test(promptText),
      'research-prompt must specify core compound profile schema requirements'
    );
    } finally {
      try {
        await adminApi.patch('/api/v1/sections/peptides', {
          aiResearchPrompt: origPrompt,
          customFields: origCustomFields,
        });
      } catch {
        // Best-effort cleanup so original test failure is never masked
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Dual-Runtime Health Metadata & Transport Security Hygiene (F47 / F45)
// ---------------------------------------------------------------------------
test('T1-C15: public GET /health dual-runtime metadata, allowed CORS Origin with Vary: Origin & no-store hygiene', async () => {
  await withServer(async (server) => {
    const pubApi = createApiClient({ baseUrl: server.baseUrl });
    const healthRes = await pubApi.get('/health', { auth: false });
    assert.strictEqual(healthRes.status, 200);
    assert.ok(healthRes.json && typeof healthRes.json === 'object');
    assert.strictEqual(healthRes.json.ok, true, 'GET /health must return ok: true');
    assert.ok(typeof healthRes.json.version === 'string' && healthRes.json.version.length > 0, 'GET /health must include version');
    assert.ok(typeof healthRes.json.storage === 'string' && healthRes.json.storage.length > 0, 'GET /health must include storage');
    assert.ok(typeof healthRes.json.mode === 'string' && healthRes.json.mode.length > 0, 'GET /health must include mode');

    // Allowed CORS origin echoed with Vary: Origin on private REST & MCP endpoints
    const allowedOrigin = 'https://rsemenov81-hash.github.io';
    const adminApi = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    for (const endpoint of [
      '/api/v1/sections',
      '/api/v1/compounds',
      '/api/v1/proposals',
      '/api/v1/audit-log',
      '/api/v1/keys',
      '/api/v1/oauth/clients',
    ]) {
      const res = await adminApi.get(endpoint, { headers: { Origin: allowedOrigin } });
      assert.strictEqual(res.status, 200, `GET ${endpoint} must return 200`);
      assertNoStore(res.headers, `GET ${endpoint}`);
      assert.strictEqual(
        res.headers.get('access-control-allow-origin'),
        allowedOrigin,
        `GET ${endpoint} must echo allowed Origin`
      );
      assert.ok(
        String(res.headers.get('vary') || '').toLowerCase().includes('origin'),
        `GET ${endpoint} must include Vary: Origin`
      );
    }

    const mcp = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
    const mcpPing = await mcp.ping({ headers: { Origin: allowedOrigin } });
    assert.strictEqual(mcpPing.status, 200);
    assertNoStore(mcpPing.headers, 'POST /mcp');
    assert.strictEqual(mcpPing.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.ok(String(mcpPing.headers.get('vary') || '').toLowerCase().includes('origin'));
  });
});
