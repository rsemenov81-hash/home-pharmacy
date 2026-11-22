import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  unwrapData,
  fixtures,
} from '../harness.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertStatus(res, expected, context = '') {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    allowed.includes(res.status),
    `${context ? `${context}: ` : ''}expected HTTP ${allowed.join(' or ')}, got ${res.status} — body: ${String(res.text ?? '').slice(0, 500)}`
  );
}

async function withServer(fn, serverOpts = {}) {
  const server = await startE2EServer(serverOpts);
  try {
    const api = createApiClient({
      baseUrl: server.baseUrl,
      token: server.adminToken,
    });
    return await fn({ server, api });
  } finally {
    await server.stop();
  }
}

function flipLastChar(token) {
  assert.ok(typeof token === 'string' && token.length > 0, 'token must be non-empty string');
  const last = token.slice(-1);
  const replacement = last === 'a' ? 'b' : 'a';
  return `${token.slice(0, -1)}${replacement}`;
}

function resolveOpenApiSchema(openapiJson, schema, seen = new Set()) {
  if (!isPlainObject(schema)) return null;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    if (seen.has(schema.$ref)) return null;
    seen.add(schema.$ref);
    const parts = schema.$ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = openapiJson;
    for (const part of parts) {
      if (!isPlainObject(cur)) return null;
      cur = cur[part];
    }
    return resolveOpenApiSchema(openapiJson, cur, seen);
  }
  return schema;
}

function findOpenApiRequestSchema(openapiJson, pathMatchers, method) {
  const paths = openapiJson?.paths;
  if (!isPlainObject(paths)) return null;
  const lowerMethod = method.toLowerCase();
  for (const [routePath, pathItem] of Object.entries(paths)) {
    const matched = pathMatchers.some((matcher) =>
      typeof matcher === 'string' ? routePath === matcher : matcher.test(routePath)
    );
    if (!matched || !isPlainObject(pathItem)) continue;
    const op = pathItem[lowerMethod];
    const rawSchema =
      op?.requestBody?.content?.['application/json']?.schema ??
      op?.requestBody?.content?.['*/*']?.schema;
    const resolved = resolveOpenApiSchema(openapiJson, rawSchema);
    if (resolved) return resolved;
  }
  return null;
}

function detectKeysScopeField(openapiJson) {
  const schema = findOpenApiRequestSchema(openapiJson, ['/api/v1/keys'], 'post');
  const props = isPlainObject(schema?.properties) ? schema.properties : null;
  if (props) {
    if ('scopes' in props && !('scope' in props)) return 'scopes';
    if ('scope' in props) return 'scope';
  }
  return null;
}

function extractRawSecret(json) {
  const containers = [
    json,
    json?.data,
    json?.key,
    json?.apiKey,
    json?.record,
    json?.data?.key,
    json?.data?.apiKey,
    json?.data?.record,
  ];
  const secretFields = [
    'token',
    'secret',
    'rawSecret',
    'rawKey',
    'rawToken',
    'plainKey',
    'plaintext',
    'apiKey',
    'key',
  ];
  for (const container of containers) {
    if (!isPlainObject(container)) continue;
    for (const field of secretFields) {
      if (typeof container[field] === 'string' && container[field].length >= 16) {
        return container[field];
      }
    }
  }
  return null;
}

function extractKeyMeta(json) {
  if (isPlainObject(json?.key)) return json.key;
  if (isPlainObject(json?.apiKey)) return json.apiKey;
  if (isPlainObject(json?.record)) return json.record;
  if (isPlainObject(json?.data?.key)) return json.data.key;
  if (isPlainObject(json?.data?.apiKey)) return json.data.apiKey;
  if (isPlainObject(json?.data?.record)) return json.data.record;
  if (isPlainObject(json?.data)) return json.data;
  return isPlainObject(json) ? json : {};
}

async function mintScopedKey(api, openapiJson, { name, scope }) {
  const detected = detectKeysScopeField(openapiJson);
  const firstField = detected ?? 'scope';
  const buildBody = (field) => (field === 'scopes' ? { name, scopes: [scope] } : { name, scope });

  let usedField = firstField;
  let res = await api.post('/api/v1/keys', buildBody(firstField));
  if ((res.status === 400 || res.status === 422) && detected === null) {
    usedField = 'scopes';
    res = await api.post('/api/v1/keys', buildBody('scopes'));
  }

  assertStatus(res, [200, 201], `POST /api/v1/keys (${name}, scope=${scope})`);
  const meta = extractKeyMeta(res.json);
  const keyId = meta?.id ?? res.json?.id ?? res.json?.data?.id;
  const rawSecret = extractRawSecret(res.json);

  assert.equal(typeof keyId, 'string', 'minted key must return string id');
  assert.ok(keyId.trim().length > 0, 'minted key id must be non-empty');
  assert.equal(typeof rawSecret, 'string', 'minted key must return raw secret string once');
  assert.ok(rawSecret.length >= 16, `minted raw secret must be at least 16 chars, got ${rawSecret.length}`);

  return { keyId, rawSecret, meta, res, scopeField: usedField };
}

async function createMemberLog(
  api,
  openapiJson,
  memberId,
  { compoundId, amount = 250, unit = 'mcg', notes, slotId = 'morning_am' }
) {
  const nowIso = new Date().toISOString();
  const schema = findOpenApiRequestSchema(
    openapiJson,
    [/^\/api\/v1\/members\/\{[^}]+\}\/logs$/, '/api/v1/members/:memberId/logs'],
    'post'
  );
  const props = isPlainObject(schema?.properties) ? schema.properties : null;
  const hasDoseProp = Boolean(
    props && ('doseAmount' in props || 'dose' in props || 'doseValue' in props || 'amount' in props)
  );

  const primaryPayload = { compoundId, status: 'taken', slotId, notes };
  if (props && hasDoseProp) {
    if ('doseAmount' in props) primaryPayload.doseAmount = amount;
    else if ('doseValue' in props) primaryPayload.doseValue = amount;
    else if ('dose' in props) primaryPayload.dose = amount;
    else primaryPayload.amount = amount;

    if ('doseUnit' in props) primaryPayload.doseUnit = unit;
    else primaryPayload.unit = unit;

    if ('takenAt' in props) primaryPayload.takenAt = nowIso;
    else if ('loggedAt' in props) primaryPayload.loggedAt = nowIso;
    else if ('datetime' in props) primaryPayload.datetime = nowIso;
    else primaryPayload.timestamp = nowIso;
  } else {
    primaryPayload.amount = amount;
    primaryPayload.unit = unit;
    primaryPayload.timestamp = nowIso;
  }

  let usedPayload = primaryPayload;
  let res = await api.post(`/api/v1/members/${encodeURIComponent(memberId)}/logs`, primaryPayload);
  if ((res.status === 400 || res.status === 422) && !hasDoseProp) {
    const altPayloads = [
      {
        compoundId,
        doseAmount: amount,
        doseUnit: unit,
        status: 'taken',
        slotId,
        takenAt: nowIso,
        notes,
      },
      {
        compoundId,
        doseValue: amount,
        doseUnit: unit,
        status: 'taken',
        slotId,
        datetime: nowIso,
        notes,
      },
    ];
    for (const altPayload of altPayloads) {
      if (res.status !== 400 && res.status !== 422) break;
      usedPayload = altPayload;
      res = await api.post(`/api/v1/members/${encodeURIComponent(memberId)}/logs`, altPayload);
    }
  }
  return { res, payload: usedPayload };
}

function extractSettingsObject(household, rawJson = null) {
  return {
    ...(isPlainObject(household) ? household : {}),
    ...(isPlainObject(household?.settings) ? household.settings : {}),
    ...(isPlainObject(rawJson?.settings) ? rawJson.settings : {}),
    ...(isPlainObject(rawJson?.data?.settings) ? rawJson.data.settings : {}),
  };
}

function buildValidSettingsPatchPayload(openapiJson, household, rawJson = null) {
  const settings = extractSettingsObject(household, rawJson);
  const schema = findOpenApiRequestSchema(openapiJson, ['/api/v1/household/settings'], 'patch');
  const props = isPlainObject(schema?.properties) ? schema.properties : {};

  for (const [key, rawProp] of Object.entries(props)) {
    const prop = resolveOpenApiSchema(openapiJson, rawProp) ?? rawProp;
    if (!isPlainObject(prop)) continue;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      const next = prop.enum.find((v) => v !== settings[key]) ?? prop.enum[0];
      return { [key]: next };
    }
    if (prop.type === 'boolean') {
      return { [key]: !(settings[key] === true) };
    }
  }

  for (const [key, val] of Object.entries(settings)) {
    if (/ai|policy|write/i.test(key)) {
      if (typeof val === 'boolean') return { [key]: !val };
      if (typeof val === 'string') return { [key]: val === 'inbox_only' ? 'ai_draft' : 'inbox_only' };
    }
  }

  return { aiWritePolicy: 'inbox_only' };
}

describe('Tier 2 — Area A: Auth Bounds, CORS Spoofing, Validation, Scoped Keys & Zero-Leak Privacy', () => {
  it('T2-A01 (F4, F45): Missing, empty, malformed, invalid, and 1-char-tampered Bearer and ?token= credentials are rejected 401 with zero state leakage', async () => {
    await withServer(async ({ server, api }) => {
      const tamperedToken = flipLastChar(server.adminToken);
      assert.equal(tamperedToken.length, server.adminToken.length);
      assert.notEqual(tamperedToken, server.adminToken);

      const authCases = [
        { label: 'no auth', path: '/api/v1/household', opts: { auth: false } },
        { label: 'empty Bearer', path: '/api/v1/household', opts: { auth: false, headers: { Authorization: 'Bearer ' } } },
        { label: 'Basic scheme', path: '/api/v1/household', opts: { auth: false, headers: { Authorization: 'Basic dXNlcjpwYXNz' } } },
        { label: 'invalid Bearer', path: '/api/v1/household', opts: { auth: false, headers: { Authorization: 'Bearer completely-invalid-token-0000' } } },
        { label: '1-char-tampered Bearer', path: '/api/v1/household', opts: { auth: false, headers: { Authorization: `Bearer ${tamperedToken}` } } },
        { label: 'truncated Bearer', path: '/api/v1/household', opts: { auth: false, headers: { Authorization: `Bearer ${server.adminToken.slice(0, -4)}` } } },
        { label: 'suffixed Bearer', path: '/api/v1/household', opts: { auth: false, headers: { Authorization: `Bearer ${server.adminToken}extra` } } },
        { label: 'empty ?token=', path: '/api/v1/household?token=', opts: { auth: false } },
        { label: 'invalid ?token=', path: '/api/v1/household', opts: { auth: false, query: { token: 'invalid-query-token' } } },
        { label: '1-char-tampered ?token=', path: '/api/v1/household', opts: { auth: false, query: { token: tamperedToken } } },
        { label: 'unauth /api/v1/members', path: '/api/v1/members', opts: { auth: false } },
        { label: 'tampered /api/v1/keys', path: '/api/v1/keys', opts: { auth: false, headers: { Authorization: `Bearer ${tamperedToken}` } } },
      ];

      for (const tc of authCases) {
        const res = await api.get(tc.path, tc.opts);
        assertStatus(res, 401, `auth rejection (${tc.label})`);
        assert.ok(!res.text.includes('member_wife'), `${tc.label}: 401 response must not leak member_wife`);
        assert.ok(!res.text.includes('member_husband'), `${tc.label}: 401 response must not leak member_husband`);
        assert.ok(!res.text.includes('"Wife"'), `${tc.label}: 401 response must not leak Wife`);
        assert.ok(!res.text.includes('"Husband"'), `${tc.label}: 401 response must not leak Husband`);
        assert.ok(!res.text.includes(server.adminToken), `${tc.label}: 401 response must not echo adminToken`);
        assert.ok(!res.text.includes(server.passcode), `${tc.label}: 401 response must not echo passcode`);
      }
    });
  });

  it('T2-A02 (F24, F45): Unauthenticated and invalid-token POST /mcp returns 401 with RFC 9728 WWW-Authenticate pointing to live protected-resource metadata', async () => {
    await withServer(async ({ server, api }) => {
      const initBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-unauth-probe', version: '1.0.0' },
        },
      };

      const unauthRes = await api.post('/mcp', initBody, { auth: false });
      const badTokenRes = await api.post('/mcp', initBody, {
        auth: false,
        headers: { Authorization: 'Bearer invalid-mcp-token-xyz' },
      });

      const validMetadataUris = [
        `${server.origin}/.well-known/oauth-protected-resource`,
        `${server.origin}/.well-known/oauth-protected-resource/mcp`,
      ];

      let extractedUri = null;
      for (const [label, res] of [
        ['unauthenticated POST /mcp', unauthRes],
        ['invalid-token POST /mcp', badTokenRes],
      ]) {
        assertStatus(res, 401, label);
        const wwwAuth = res.headers.get('www-authenticate') ?? '';
        assert.match(wwwAuth, /^Bearer\b/i, `${label} must return Bearer WWW-Authenticate, got "${wwwAuth}"`);
        const match = wwwAuth.match(/resource_metadata="([^"]+)"/i);
        assert.ok(match && match[1], `${label} WWW-Authenticate must include resource_metadata="<uri>", got "${wwwAuth}"`);
        assert.ok(
          validMetadataUris.includes(match[1]),
          `${label} resource_metadata URI must be one of ${validMetadataUris.join(' | ')}, got "${match[1]}"`
        );
        extractedUri = match[1];
      }

      const parsedMetaUrl = new URL(extractedUri);
      assert.equal(parsedMetaUrl.origin, server.origin);
      const metaRes = await api.get(`${parsedMetaUrl.pathname}${parsedMetaUrl.search}`, { auth: false });
      assertStatus(metaRes, 200, `GET ${extractedUri}`);
      assert.ok(isPlainObject(metaRes.json), 'protected-resource metadata must return JSON object');
      assert.ok(
        Array.isArray(metaRes.json.authorization_servers) && metaRes.json.authorization_servers.length > 0,
        'protected-resource metadata must include non-empty authorization_servers array'
      );
    });
  });

  it('T2-A03 (F45): Disallowed CORS origins and origin-spoofing variants receive NO Access-Control-Allow-Origin header', async () => {
    await withServer(async ({ api }) => {
      const disallowedOrigins = [
        'https://evil.example.com',
        'https://rsemenov81-hash.github.io.evil.com',
        'https://evil-rsemenov81-hash.github.io',
        'http://rsemenov81-hash.github.io',
        'http://localhost.evil.com:3000',
        'http://127.0.0.1.evil.com',
        'null',
      ];

      for (const origin of disallowedOrigins) {
        const getRes = await api.get('/api/v1/household', {
          headers: { Origin: origin },
        });
        assert.ok(getRes.status < 500, `GET with disallowed origin "${origin}" must not 500`);
        assert.equal(
          getRes.headers.get('access-control-allow-origin'),
          null,
          `GET with disallowed origin "${origin}" must NOT emit Access-Control-Allow-Origin`
        );

        const optRes = await api.options('/api/v1/household', {
          auth: false,
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'Authorization, Content-Type',
          },
        });
        assert.ok(optRes.status < 500, `OPTIONS with disallowed origin "${origin}" must not 500`);
        assert.equal(
          optRes.headers.get('access-control-allow-origin'),
          null,
          `OPTIONS with disallowed origin "${origin}" must NOT emit Access-Control-Allow-Origin`
        );
      }
    });
  });

  it('T2-A04 (F1): Invalid member payloads (empty name, duplicate id, invalid biologicalSexContext, invalid role) are rejected without corrupting state', async () => {
    await withServer(async ({ api }) => {
      assertStatus(await api.post('/api/v1/members', { name: '' }), [400, 422], 'POST empty member name');
      assertStatus(await api.post('/api/v1/members', { name: '   ' }), [400, 422], 'POST whitespace member name');
      assertStatus(await api.post('/api/v1/members', {}), [400, 422], 'POST empty member object');

      assertStatus(await api.patch('/api/v1/members/member_wife', { name: '' }), [400, 422], 'PATCH empty member name');
      assertStatus(await api.patch('/api/v1/members/member_wife', { name: '   ' }), [400, 422], 'PATCH whitespace member name');

      assertStatus(
        await api.post('/api/v1/members', { id: 'member_wife', name: 'Duplicate Wife' }),
        [409, 400, 422],
        'POST duplicate member id'
      );

      assertStatus(
        await api.post('/api/v1/members', {
          name: 'Bad Sex Member',
          safetyContext: { biologicalSexContext: 'invalid_enum' },
        }),
        [400, 422],
        'POST invalid biologicalSexContext'
      );

      assertStatus(
        await api.patch('/api/v1/members/member_wife', {
          safetyContext: { biologicalSexContext: 'invalid_enum' },
        }),
        [400, 422],
        'PATCH invalid biologicalSexContext'
      );

      assertStatus(
        await api.post('/api/v1/members', { name: 'Bad Role Member', role: 'superroot' }),
        [400, 422],
        'POST invalid role'
      );

      // Verify state remains untouched
      const listRes = await api.get('/api/v1/members');
      assertStatus(listRes, 200, 'GET /api/v1/members after invalid mutations');
      const members = unwrapData(listRes.json, ['members', 'items']);
      assert.equal(members.length, 2, 'invalid member calls must not add members');
      const wife = members.find((m) => m.id === 'member_wife');
      assert.ok(wife);
      assert.equal(wife.name ?? wife.displayName, 'Wife');
      assert.equal(wife.safetyContext?.biologicalSexContext, 'female');
    });
  });

  it('T2-A05 (F1, F3): Nonexistent member operations and cross-spouse stack/log tampering are rejected without leaking or merging across spouses', async () => {
    await withServer(async ({ api }) => {
      const openapiRes = await api.get('/openapi.json', { auth: false });
      assertStatus(openapiRes, 200, 'GET /openapi.json');

      const cmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Isolation Guard Peptide',
          canonicalMolecule: 'isolation-guard-pep',
          aliases: ['IGP-1'],
        })
      );
      assertStatus(cmpRes, [200, 201], 'create compound for isolation test');
      const c1 = unwrapData(cmpRes.json, ['compound']);

      const stackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Protected Stack',
          memberId: 'member_wife',
          active: true,
          items: [fixtures.makeStackItem({ compoundId: c1.id })],
        })
      );
      assertStatus(stackRes, [200, 201], 'create wife stack');
      const wifeStack = unwrapData(stackRes.json, ['stack']);

      const { res: logRes, payload: provenLogPayload } = await createMemberLog(
        api,
        openapiRes.json,
        'member_wife',
        { compoundId: c1.id, amount: 250, unit: 'mcg', notes: 'Wife protected log entry' }
      );
      assertStatus(logRes, [200, 201], 'create wife dose log');
      const wifeLog = unwrapData(logRes.json, ['log']);

      // Nonexistent member operations
      assertStatus(
        await api.patch('/api/v1/members/member_nonexistent_999', { name: 'Ghost' }),
        404,
        'PATCH nonexistent member'
      );
      assertStatus(
        await api.del('/api/v1/members/member_nonexistent_999'),
        404,
        'DELETE nonexistent member'
      );

      const ghostStacksGet = await api.get('/api/v1/members/member_nonexistent_999/stacks');
      assertStatus(ghostStacksGet, [404, 400], 'GET nonexistent member stacks');
      assert.ok(!ghostStacksGet.text.includes(wifeStack.id), 'nonexistent member stacks must not leak wifeStack id');
      assert.ok(!ghostStacksGet.text.includes('Wife Protected Stack'), 'nonexistent member stacks must not leak wifeStack name');

      assertStatus(
        await api.post(
          '/api/v1/members/member_nonexistent_999/stacks',
          fixtures.makeStackPayload({
            name: 'Ghost Stack',
            memberId: 'member_nonexistent_999',
            items: [fixtures.makeStackItem({ compoundId: c1.id })],
          })
        ),
        [404, 400],
        'POST nonexistent member stack'
      );

      const ghostLogsGet = await api.get('/api/v1/members/member_nonexistent_999/logs');
      assertStatus(ghostLogsGet, [404, 400], 'GET nonexistent member logs');
      assert.ok(!ghostLogsGet.text.includes(wifeLog.id), 'nonexistent member logs must not leak wifeLog id');

      assertStatus(
        await api.post('/api/v1/members/member_nonexistent_999/logs', provenLogPayload),
        [404, 400],
        'POST nonexistent member log'
      );

      // Cross-spouse tampering must fail
      assertStatus(
        await api.patch(`/api/v1/members/member_husband/stacks/${encodeURIComponent(wifeStack.id)}`, {
          name: 'Hijacked Stack Name',
        }),
        [404, 403, 400],
        'cross-spouse PATCH stack'
      );
      assertStatus(
        await api.del(`/api/v1/members/member_husband/stacks/${encodeURIComponent(wifeStack.id)}`),
        [404, 403, 400],
        'cross-spouse DELETE stack'
      );
      assertStatus(
        await api.del(`/api/v1/members/member_husband/logs/${encodeURIComponent(wifeLog.id)}`),
        [404, 403, 400],
        'cross-spouse DELETE log'
      );

      // Confirm wife's records are completely intact and husband has zero leaked/merged records
      const [wifeStacksAfterRes, husbandStacksAfterRes, wifeLogsAfterRes, husbandLogsAfterRes] = await Promise.all([
        api.get('/api/v1/members/member_wife/stacks'),
        api.get('/api/v1/members/member_husband/stacks'),
        api.get('/api/v1/members/member_wife/logs'),
        api.get('/api/v1/members/member_husband/logs'),
      ]);
      assertStatus(wifeStacksAfterRes, 200, 'GET member_wife stacks after cross-spouse probes');
      assertStatus(husbandStacksAfterRes, 200, 'GET member_husband stacks after cross-spouse probes');
      assertStatus(wifeLogsAfterRes, 200, 'GET member_wife logs after cross-spouse probes');
      assertStatus(husbandLogsAfterRes, 200, 'GET member_husband logs after cross-spouse probes');

      const wsList = unwrapData(wifeStacksAfterRes.json, ['stacks', 'items']);
      const hsList = unwrapData(husbandStacksAfterRes.json, ['stacks', 'items']);
      const wlList = unwrapData(wifeLogsAfterRes.json, ['logs', 'items']);
      const hlList = unwrapData(husbandLogsAfterRes.json, ['logs', 'items']);

      const preservedStack = wsList.find((s) => s.id === wifeStack.id);
      assert.ok(preservedStack, 'wife stack must still exist');
      assert.equal(preservedStack.name, 'Wife Protected Stack', 'wife stack name must remain unmodified');
      assert.equal(hsList.length, 0, 'husband must still have 0 stacks');

      assert.ok(wlList.some((l) => l.id === wifeLog.id), 'wife log must still exist');
      assert.equal(hlList.length, 0, 'husband must still have 0 logs');
    });
  });

  it('T2-A06 (F1): Default bootstrap member deletion boundary never crashes or collapses the household to zero members', async () => {
    await withServer(async ({ api }) => {
      const delWifeRes = await api.del('/api/v1/members/member_wife');
      assert.ok(
        delWifeRes.status < 500,
        `DELETE /api/v1/members/member_wife must never 500, got ${delWifeRes.status}`
      );

      if ([400, 403, 409, 422].includes(delWifeRes.status)) {
        const listRes = await api.get('/api/v1/members');
        assertStatus(listRes, 200, 'GET /api/v1/members after rejected default delete');
        const members = unwrapData(listRes.json, ['members', 'items']);
        assert.ok(members.some((m) => m.id === 'member_wife'), 'protected member_wife must remain');
        assert.ok(members.some((m) => m.id === 'member_husband'), 'member_husband must remain');
      } else if ([200, 204].includes(delWifeRes.status)) {
        const listAfterOne = await api.get('/api/v1/members');
        assertStatus(listAfterOne, 200, 'GET /api/v1/members after deleting first member');
        const remaining = unwrapData(listAfterOne.json, ['members', 'items']);
        assert.ok(!remaining.some((m) => m.id === 'member_wife'), 'deleted member_wife should be removed');
        assert.ok(remaining.some((m) => m.id === 'member_husband'), 'member_husband should remain');

        // Deleting the final remaining member MUST be rejected so household never drops to 0 members
        const delLastRes = await api.del('/api/v1/members/member_husband');
        assertStatus(delLastRes, [400, 403, 409, 422], 'DELETE last remaining member must be rejected');

        const listAfterSecond = await api.get('/api/v1/members');
        assertStatus(listAfterSecond, 200, 'GET /api/v1/members after attempting zero-member delete');
        const finalMembers = unwrapData(listAfterSecond.json, ['members', 'items']);
        assert.ok(
          finalMembers.some((m) => m.id === 'member_husband'),
          'final remaining member_husband must remain intact'
        );
      } else {
        assert.fail(
          `unexpected HTTP status ${delWifeRes.status} for DELETE /api/v1/members/member_wife — body: ${delWifeRes.text.slice(0, 300)}`
        );
      }
    });
  });

  it('T2-A07 (F2, F9): Ownership validation rejects negative quantities, negative remainingDoses, invalid status enums, invalid/nonexistent scopes, and nonexistent compoundId', async () => {
    await withServer(async ({ api }) => {
      const cmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Ownership Validation Target',
          canonicalMolecule: 'ownership-validation-target',
          aliases: ['OVT-1'],
        })
      );
      assertStatus(cmpRes, [200, 201], 'create compound for ownership bounds');
      const c1 = unwrapData(cmpRes.json, ['compound']);

      const invalidPayloads = [
        { label: 'negative quantity', body: { scope: 'household', status: 'have', quantity: -5 }, allowed: [400, 422] },
        { label: 'negative remainingDoses', body: { scope: 'household', status: 'have', remainingDoses: -1 }, allowed: [400, 422] },
        { label: 'invalid status enum', body: { scope: 'household', status: 'in_cabinet_invalid' }, allowed: [400, 422] },
        { label: 'empty status', body: { scope: 'household', status: '' }, allowed: [400, 422] },
        { label: 'malformed scope global', body: { scope: 'global', status: 'have' }, allowed: [400, 422] },
        { label: 'empty scope', body: { scope: '', status: 'have' }, allowed: [400, 422] },
        { label: 'empty member scope prefix', body: { scope: 'member:', status: 'have' }, allowed: [400, 404, 422] },
        { label: 'nonexistent member scope', body: { scope: 'member:member_ghost_999', status: 'have' }, allowed: [400, 404, 422] },
      ];

      for (const tc of invalidPayloads) {
        const res = await api.put(`/api/v1/ownership/${encodeURIComponent(c1.id)}`, tc.body);
        assertStatus(res, tc.allowed, `PUT ownership (${tc.label})`);
      }

      const ghostCompoundRes = await api.put('/api/v1/ownership/compound_nonexistent_999', {
        scope: 'household',
        status: 'have',
      });
      assertStatus(ghostCompoundRes, [404, 400, 422], 'PUT ownership for nonexistent compoundId');

      const listRes = await api.get('/api/v1/ownership');
      assertStatus(listRes, 200, 'GET /api/v1/ownership after rejected writes');
      const records = unwrapData(listRes.json, ['ownership', 'ownerships', 'records', 'items']);
      assert.equal(records.length, 0, 'zero invalid or orphan ownership records may be persisted');
    });
  });

  it('T2-A08 (F4, F24, F29, F45): Scoped read-only API key exposes raw secret once, permits reads (200), and rejects all mutations (403)', async () => {
    await withServer(async ({ server, api }) => {
      const [openapiRes, hhRes, cmpRes] = await Promise.all([
        api.get('/openapi.json', { auth: false }),
        api.get('/api/v1/household'),
        api.post(
          '/api/v1/compounds',
          fixtures.makeSupplementCompound({
            name: 'Read-Only Key Target Compound',
            canonicalMolecule: 'ro-key-target-cmp',
            aliases: ['ROK-1'],
          })
        ),
      ]);
      assertStatus(openapiRes, 200, 'GET /openapi.json');
      assertStatus(hhRes, 200, 'GET /api/v1/household');
      assertStatus(cmpRes, [200, 201], 'create target compound');
      const household = unwrapData(hhRes.json, ['household']);
      const c1 = unwrapData(cmpRes.json, ['compound']);

      const { keyId, rawSecret, meta, scopeField } = await mintScopedKey(api, openapiRes.json, {
        name: 'E2E Read-Only Key',
        scope: 'read',
      });

      // Verify returned metadata confirms read-only scope (not write)
      const returnedScopes = Array.isArray(meta.scopes)
        ? meta.scopes
        : typeof meta.scope === 'string'
          ? [meta.scope]
          : [];
      assert.ok(returnedScopes.includes('read'), `minted key metadata must include "read" scope, got ${JSON.stringify(returnedScopes)}`);
      assert.ok(!returnedScopes.includes('write'), 'read-only key metadata must not include "write" scope');

      // Raw secret MUST NEVER appear on subsequent GET /api/v1/keys
      const keysListRes = await api.get('/api/v1/keys');
      assertStatus(keysListRes, 200, 'GET /api/v1/keys');
      const keysList = unwrapData(keysListRes.json, ['keys', 'apiKeys', 'items']);
      assert.ok(Array.isArray(keysList), 'GET /api/v1/keys must return an array');
      assert.ok(keysList.some((k) => k.id === keyId), 'minted keyId must appear in GET /api/v1/keys');
      assert.ok(
        !keysListRes.text.includes(rawSecret),
        'GET /api/v1/keys MUST NEVER expose raw API key secret after creation'
      );

      const readApi = createApiClient({
        baseUrl: server.baseUrl,
        token: rawSecret,
      });

      // Reads succeed 200
      for (const readPath of ['/api/v1/household', '/api/v1/members', '/api/v1/compounds', '/api/v1/ownership']) {
        const readRes = await readApi.get(readPath);
        assertStatus(readRes, 200, `read-only key GET ${readPath}`);
      }

      // All valid-payload mutations MUST fail 403 strictly (not 401, not 2xx)
      const validSettingsPatch = buildValidSettingsPatchPayload(openapiRes.json, household, hhRes.json);
      const validMemberBody = fixtures.makeMemberPayload({
        name: 'Unauthorized Member',
        role: 'member',
        routineAnchors: {
          wake: '07:00',
          breakfast: '08:00',
          workout: '09:00',
          workoutDays: [1, 3, 5],
          lunch: '13:00',
          dinner: '19:00',
          bed: '22:30',
          tz: 'UTC',
        },
      });
      const escalationKeyBody =
        scopeField === 'scopes'
          ? { name: 'Privilege Escalation', scopes: ['write'] }
          : { name: 'Privilege Escalation', scope: 'write' };

      const mutationChecks = [
        ['PATCH /api/v1/household/settings', () => readApi.patch('/api/v1/household/settings', validSettingsPatch)],
        ['POST /api/v1/members', () => readApi.post('/api/v1/members', validMemberBody)],
        ['PATCH /api/v1/members/member_wife', () => readApi.patch('/api/v1/members/member_wife', { name: 'Unauthorized Edit' })],
        [
          'POST /api/v1/compounds',
          () =>
            readApi.post(
              '/api/v1/compounds',
              fixtures.makeSupplementCompound({
                name: 'Unauthorized Compound E2E',
                canonicalMolecule: 'unauthorized-compound-e2e',
                aliases: ['UnauthCmp'],
              })
            ),
        ],
        [
          `PUT /api/v1/ownership/${c1.id}`,
          () => readApi.put(`/api/v1/ownership/${encodeURIComponent(c1.id)}`, { scope: 'household', status: 'have', quantity: 5 }),
        ],
        ['POST /api/v1/keys', () => readApi.post('/api/v1/keys', escalationKeyBody)],
        [`DELETE /api/v1/keys/${keyId}`, () => readApi.del(`/api/v1/keys/${encodeURIComponent(keyId)}`)],
      ];

      for (const [label, fn] of mutationChecks) {
        const res = await fn();
        assertStatus(res, 403, `read-only key forbidden on ${label}`);
      }

      // Admin verifies zero unauthorized mutations took effect
      const [membersAfter, compoundsAfter, ownershipAfter, keysAfter] = await Promise.all([
        api.get('/api/v1/members'),
        api.get('/api/v1/compounds'),
        api.get('/api/v1/ownership'),
        api.get('/api/v1/keys'),
      ]);
      assertStatus(membersAfter, 200, 'GET /api/v1/members after read-only mutations');
      assertStatus(compoundsAfter, 200, 'GET /api/v1/compounds after read-only mutations');
      assertStatus(ownershipAfter, 200, 'GET /api/v1/ownership after read-only mutations');
      assertStatus(keysAfter, 200, 'GET /api/v1/keys after read-only mutations');
      const members = unwrapData(membersAfter.json, ['members', 'items']);
      assert.equal(members.length, 2, 'member count must remain 2');
      assert.equal(members.find((m) => m.id === 'member_wife')?.name ?? members.find((m) => m.id === 'member_wife')?.displayName, 'Wife');
      assert.equal(unwrapData(compoundsAfter.json, ['compounds', 'items']).length, 1, 'compound count must remain 1');
      assert.equal(unwrapData(ownershipAfter.json, ['ownership', 'ownerships', 'records', 'items']).length, 0, 'ownership count must remain 0');
      assert.ok(
        unwrapData(keysAfter.json, ['keys', 'apiKeys', 'items']).some((k) => k.id === keyId),
        'read-only key must still exist after rejected self-delete'
      );
    });
  });

  it('T2-A09 (F4, F29): Revoked API key (DELETE /api/v1/keys/:id) is immediately rejected 401 on Bearer and ?token=, and nonexistent key delete returns 404', async () => {
    await withServer(async ({ server, api }) => {
      const openapiRes = await api.get('/openapi.json', { auth: false });
      assertStatus(openapiRes, 200, 'GET /openapi.json');

      const { keyId, rawSecret } = await mintScopedKey(api, openapiRes.json, {
        name: 'E2E Revoke Target',
        scope: 'read',
      });

      const keyBearerClient = createApiClient({ baseUrl: server.baseUrl, token: rawSecret });
      const keyQueryClient = createApiClient({
        baseUrl: server.baseUrl,
        token: rawSecret,
        tokenInQuery: true,
      });

      assertStatus(await keyBearerClient.get('/api/v1/household'), 200, 'key works before revocation');

      const revokeRes = await api.del(`/api/v1/keys/${encodeURIComponent(keyId)}`);
      assertStatus(revokeRes, [200, 204], `DELETE /api/v1/keys/${keyId}`);

      assertStatus(
        await keyBearerClient.get('/api/v1/household'),
        401,
        'revoked key must immediately fail 401 via Authorization Bearer'
      );
      assertStatus(
        await keyQueryClient.get('/api/v1/household'),
        401,
        'revoked key must immediately fail 401 via ?token='
      );

      const keysListRes = await api.get('/api/v1/keys');
      assertStatus(keysListRes, 200, 'GET /api/v1/keys after revoke');
      const keys = unwrapData(keysListRes.json, ['keys', 'apiKeys', 'items']);
      const matchingKey = keys.find((k) => k.id === keyId);
      if (matchingKey) {
        assert.ok(
          matchingKey.revoked === true || Boolean(matchingKey.revokedAt),
          'if revoked key remains listed, it must be marked revoked'
        );
      }

      const ghostDeleteRes = await api.del('/api/v1/keys/key_nonexistent_999');
      assertStatus(ghostDeleteRes, 404, 'DELETE nonexistent key must return 404');
    });
  });

  it('T2-A10 (F4, F29): Invalid API key creation payloads (empty name, invalid scope) are rejected cleanly with zero keys persisted', async () => {
    await withServer(async ({ api }) => {
      const openapiRes = await api.get('/openapi.json', { auth: false });
      assertStatus(openapiRes, 200, 'GET /openapi.json');
      const detected = detectKeysScopeField(openapiRes.json);

      const invalidKeyPayloads =
        detected === 'scopes'
          ? [
              { label: 'empty name', body: { name: '', scopes: ['read'] } },
              { label: 'whitespace name', body: { name: '   ', scopes: ['read'] } },
              { label: 'invalid scope', body: { name: 'Invalid Scope Key', scopes: ['superadmin'] } },
              { label: 'empty scopes array', body: { name: 'Empty Scopes Key', scopes: [] } },
            ]
          : detected === 'scope'
            ? [
                { label: 'empty name', body: { name: '', scope: 'read' } },
                { label: 'whitespace name', body: { name: '   ', scope: 'read' } },
                { label: 'invalid scope', body: { name: 'Invalid Scope Key', scope: 'superadmin' } },
              ]
            : [
                { label: 'empty name', body: { name: '', scope: 'read', scopes: ['read'] } },
                { label: 'whitespace name', body: { name: '   ', scope: 'read', scopes: ['read'] } },
                { label: 'invalid scope', body: { name: 'Invalid Scope Key', scope: 'superadmin', scopes: ['superadmin'] } },
              ];

      for (const tc of invalidKeyPayloads) {
        const res = await api.post('/api/v1/keys', tc.body);
        assertStatus(res, [400, 422], `POST /api/v1/keys (${tc.label})`);
      }

      const listRes = await api.get('/api/v1/keys');
      assertStatus(listRes, 200, 'GET /api/v1/keys after invalid key creation attempts');
      const keys = unwrapData(listRes.json, ['keys', 'apiKeys', 'items']);
      assert.equal(keys.length, 0, 'zero keys may be persisted from invalid creation payloads');
    });
  });

  it('T2-A11 (F4, F45): Seeded synthetic PII and private notes never leak on public /health, /openapi.json, or /llms.txt', async () => {
    await withServer(async ({ server, api }) => {
      const patchWife = await api.patch('/api/v1/members/member_wife', {
        name: 'SyntheticSpouseSentinel4419',
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'female',
          allergies: ['SyntheticAllergySentinel9182'],
          activeRxMeds: ['SyntheticRxSentinel7341'],
          conditions: ['SyntheticConditionSentinel6204'],
        },
      });
      assertStatus(patchWife, 200, 'seed synthetic member sentinels');

      const cmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'SyntheticCompoundSentinel8831',
          canonicalMolecule: 'synthetic-sentinel-8831',
          aliases: ['SynthSentinelAlias'],
          summary: 'SyntheticSummarySentinel3107',
          notes: 'SyntheticPrivateNoteSentinel5520',
        })
      );
      assertStatus(cmpRes, [200, 201], 'seed synthetic compound sentinels');
      const createdCmp = unwrapData(cmpRes.json, ['compound']);

      const ownRes = await api.put(`/api/v1/ownership/${encodeURIComponent(createdCmp.id)}`, {
        scope: 'member:member_wife',
        status: 'have',
        vendor: 'SyntheticVendorSentinel2915',
        notes: 'SyntheticOwnershipNoteSentinel6673',
      });
      assertStatus(ownRes, [200, 201], 'seed synthetic ownership sentinels');

      const forbiddenSentinels = [
        'SyntheticSpouseSentinel4419',
        'SyntheticAllergySentinel9182',
        'SyntheticRxSentinel7341',
        'SyntheticConditionSentinel6204',
        'SyntheticCompoundSentinel8831',
        'SyntheticSummarySentinel3107',
        'SyntheticPrivateNoteSentinel5520',
        'SyntheticVendorSentinel2915',
        'SyntheticOwnershipNoteSentinel6673',
        server.adminToken,
        server.passcode,
      ];

      for (const publicPath of ['/health', '/openapi.json', '/llms.txt']) {
        const res = await api.get(publicPath, { auth: false });
        assertStatus(res, 200, `public GET ${publicPath}`);
        for (const sentinel of forbiddenSentinels) {
          assert.ok(
            !res.text.includes(sentinel),
            `public ${publicPath} body MUST NOT leak private sentinel "${sentinel.slice(0, 24)}..."`
          );
          for (const [headerName, headerValue] of res.headers.entries()) {
            assert.ok(
              !headerValue.includes(sentinel),
              `public ${publicPath} header "${headerName}" MUST NOT leak private sentinel`
            );
          }
        }
      }
    });
  });
});
