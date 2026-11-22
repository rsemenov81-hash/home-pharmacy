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

function extractSettingsObject(household, rawJson = null) {
  return {
    ...(isPlainObject(household) ? household : {}),
    ...(isPlainObject(household?.settings) ? household.settings : {}),
    ...(isPlainObject(rawJson?.settings) ? rawJson.settings : {}),
    ...(isPlainObject(rawJson?.data?.settings) ? rawJson.data.settings : {}),
  };
}

function buildSettingsCandidates(openapiJson, currentSettings) {
  const schema = findOpenApiRequestSchema(
    openapiJson,
    ['/api/v1/household/settings'],
    'patch'
  );
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  const candidates = [];

  // 1. Prefer OpenAPI-declared AI write policy property (enum or boolean)
  const sortedOpenApiEntries = Object.entries(props).sort(([a], [b]) => {
    const aPolicy = /ai|policy|write|inbox|propos/i.test(a) ? 0 : 1;
    const bPolicy = /ai|policy|write|inbox|propos/i.test(b) ? 0 : 1;
    return aPolicy - bPolicy;
  });

  for (const [key, rawProp] of sortedOpenApiEntries) {
    const prop = resolveOpenApiSchema(openapiJson, rawProp) ?? rawProp;
    if (!isPlainObject(prop)) continue;
    const currentValue = currentSettings[key];
    if (Array.isArray(prop.enum) && prop.enum.length >= 2) {
      for (const value of prop.enum) {
        if (value !== currentValue) {
          candidates.push({ key, currentValue, nextValue: value });
        }
      }
    } else if (prop.type === 'boolean') {
      const nextValue = typeof currentValue === 'boolean' ? !currentValue : true;
      candidates.push({ key, currentValue, nextValue });
    }
  }

  // 2. Fall back to keys discovered directly in GET /api/v1/household settings
  const policyValues = [
    'inbox_only',
    'inbox',
    'pending_review',
    'proposal_only',
    'proposals_only',
    'proposals',
    'always_propose',
    'hold_in_inbox',
    'propose',
    'require_approval',
    'ai_draft',
    'auto_draft',
    'draft',
    'direct_draft',
  ];

  for (const [key, currentValue] of Object.entries(currentSettings)) {
    if (!/ai|policy|write|inbox|propos/i.test(key)) continue;
    if (typeof currentValue === 'boolean') {
      candidates.push({ key, currentValue, nextValue: !currentValue });
    } else if (typeof currentValue === 'string') {
      for (const value of policyValues) {
        if (value !== currentValue) {
          candidates.push({ key, currentValue, nextValue: value });
        }
      }
    }
  }

  // 3. Canonical F19 default fallback if neither OpenAPI nor settings exposed keys yet
  if (candidates.length === 0) {
    for (const key of ['aiWritePolicy', 'aiPolicy']) {
      for (const value of policyValues) {
        candidates.push({ key, currentValue: currentSettings[key], nextValue: value });
      }
    }
  }

  // Deduplicate by (key, nextValue)
  const seen = new Set();
  return candidates.filter((c) => {
    const sig = `${c.key}::${JSON.stringify(c.nextValue)}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
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
      res = await api.post(`/api/v1/members/${encodeURIComponent(memberId)}/logs`, altPayload);
    }
  }
  return res;
}

describe('Tier 1 — Area A: Household, Members, Ownership, Auth & Headers', () => {
  it('T1-A01 (F45): GET /health returns 200 with { ok: true, version, storage, mode } and zero PII', async () => {
    await withServer(async ({ server, api }) => {
      const res = await api.get('/health', { auth: false });
      assertStatus(res, 200, 'GET /health');
      assert.ok(isPlainObject(res.json), 'GET /health must return a JSON object');
      assert.equal(res.json.ok, true, 'health.ok must be true');
      assert.equal(typeof res.json.version, 'string', 'health.version must be a string');
      assert.ok(res.json.version.trim().length > 0, 'health.version must be non-empty');
      assert.equal(typeof res.json.storage, 'string', 'health.storage must be a string');
      assert.ok(res.json.storage.trim().length > 0, 'health.storage must be non-empty');
      assert.equal(typeof res.json.mode, 'string', 'health.mode must be a string');
      assert.ok(res.json.mode.trim().length > 0, 'health.mode must be non-empty');

      assert.equal(res.json.members, undefined, 'health must not include members');
      assert.equal(res.json.compounds, undefined, 'health must not include compounds');
      assert.ok(!res.text.includes(server.adminToken), 'health must not leak adminToken');
      assert.ok(!res.text.includes(server.passcode), 'health must not leak passcode');
      assert.ok(!res.text.includes('member_wife'), 'health must not leak member_wife');
      assert.ok(!res.text.includes('member_husband'), 'health must not leak member_husband');
    });
  });

  it('T1-A02 (F27, F28, F45): Public GET /openapi.json and GET /llms.txt succeed unauthenticated with valid schemas and zero private leaks', async () => {
    await withServer(async ({ server, api }) => {
      const openapiRes = await api.get('/openapi.json', { auth: false });
      assertStatus(openapiRes, 200, 'GET /openapi.json');
      assert.ok(isPlainObject(openapiRes.json), 'openapi.json must be a JSON object');
      assert.equal(typeof openapiRes.json.openapi, 'string', 'openapi version must be a string');
      assert.ok(
        openapiRes.json.openapi.startsWith('3.1'),
        `expected OpenAPI 3.1.x, got ${openapiRes.json.openapi}`
      );
      assert.equal(typeof openapiRes.json.info?.title, 'string', 'openapi.info.title must be a string');
      assert.ok(openapiRes.json.info.title.trim().length > 0, 'openapi.info.title must be non-empty');
      assert.ok(isPlainObject(openapiRes.json.paths), 'openapi.paths must be an object');

      const pathKeys = Object.keys(openapiRes.json.paths);
      assert.ok(pathKeys.length > 0, 'openapi.paths must be non-empty');

      const expectedCoreRoutes = [
        '/api/v1/household',
        '/api/v1/members',
        '/api/v1/compounds',
        '/api/v1/ownership',
      ];
      for (const route of expectedCoreRoutes) {
        const matchedKey = pathKeys.find((k) => k === route || k.startsWith(`${route}/`));
        assert.ok(matchedKey, `openapi.paths must document ${route}`);
        const pathItem = openapiRes.json.paths[route] ?? openapiRes.json.paths[matchedKey];
        const ops = ['get', 'post', 'put', 'patch', 'delete']
          .map((m) => pathItem?.[m])
          .filter(Boolean);
        assert.ok(ops.length > 0, `openapi route ${matchedKey} must define HTTP operations`);
        for (const op of ops) {
          assert.equal(typeof op.operationId, 'string', `operation on ${matchedKey} must have string operationId`);
          assert.ok(op.operationId.trim().length > 0, `operationId on ${matchedKey} must be non-empty`);
        }
      }

      assert.ok(!openapiRes.text.includes(server.adminToken), 'openapi.json must not leak adminToken');
      assert.ok(!openapiRes.text.includes(server.passcode), 'openapi.json must not leak passcode');

      const llmsRes = await api.get('/llms.txt', { auth: false });
      assertStatus(llmsRes, 200, 'GET /llms.txt');
      const contentType = llmsRes.headers.get('content-type') ?? '';
      assert.ok(
        /\btext\/(plain|markdown)\b/i.test(contentType),
        `expected text/plain or text/markdown for /llms.txt, got "${contentType}"`
      );
      assert.ok(llmsRes.text.trim().length > 20, '/llms.txt must be non-empty descriptive text');
      assert.match(
        llmsRes.text,
        /\/mcp|\/openapi\.json|\/api\/v1/i,
        '/llms.txt must reference hub integration endpoints (/mcp, /openapi.json, or /api/v1)'
      );
      assert.ok(!llmsRes.text.includes(server.adminToken), '/llms.txt must not leak adminToken');
      assert.ok(!llmsRes.text.includes(server.passcode), '/llms.txt must not leak passcode');
    });
  });

  it('T1-A03 (F1): Clean-slate bootstrap creates default 2-spouse household (member_wife & member_husband) with canonical routineAnchors and safetyContext', async () => {
    await withServer(async ({ api }) => {
      const hhRes = await api.get('/api/v1/household');
      assertStatus(hhRes, 200, 'GET /api/v1/household');
      const household = unwrapData(hhRes.json, ['household']);
      assert.ok(isPlainObject(household), 'GET /api/v1/household must return an object');

      const membersRes = await api.get('/api/v1/members');
      assertStatus(membersRes, 200, 'GET /api/v1/members');
      const members = unwrapData(membersRes.json, ['members', 'items']);
      assert.ok(Array.isArray(members), 'GET /api/v1/members must return an array');
      assert.equal(members.length, 2, `expected exactly 2 default members, got ${members.length}`);

      const wife = members.find((m) => m.id === 'member_wife');
      const husband = members.find((m) => m.id === 'member_husband');
      assert.ok(wife, 'default member_wife must exist');
      assert.ok(husband, 'default member_husband must exist');

      assert.equal(wife.name ?? wife.displayName, 'Wife');
      assert.equal(wife.role, 'admin');
      assert.equal(wife.safetyContext?.biologicalSexContext, 'female');
      assert.equal(wife.safetyContext?.pregnancyOrTrying, false);
      assert.deepEqual(wife.safetyContext?.allergies, []);
      assert.deepEqual(wife.safetyContext?.activeRxMeds, []);
      assert.deepEqual(wife.safetyContext?.conditions, []);

      assert.equal(husband.name ?? husband.displayName, 'Husband');
      assert.equal(husband.role, 'admin');
      assert.equal(husband.safetyContext?.biologicalSexContext, 'male');
      assert.equal(husband.safetyContext?.pregnancyOrTrying, false);
      assert.deepEqual(husband.safetyContext?.allergies, []);
      assert.deepEqual(husband.safetyContext?.activeRxMeds, []);
      assert.deepEqual(husband.safetyContext?.conditions, []);

      for (const member of [wife, husband]) {
        const anchors = member.routineAnchors;
        assert.ok(isPlainObject(anchors), `${member.id} must have routineAnchors object`);
        for (const anchorKey of ['wake', 'breakfast', 'workout', 'lunch', 'dinner', 'bed', 'tz']) {
          assert.equal(
            typeof anchors[anchorKey],
            'string',
            `${member.id}.routineAnchors.${anchorKey} must be a string`
          );
          assert.ok(
            anchors[anchorKey].trim().length > 0,
            `${member.id}.routineAnchors.${anchorKey} must be non-empty`
          );
        }
        assert.ok(Array.isArray(anchors.workoutDays), `${member.id}.routineAnchors.workoutDays must be an array`);
        for (const day of anchors.workoutDays) {
          assert.ok(
            Number.isInteger(day) && day >= 0 && day <= 6,
            `${member.id}.routineAnchors.workoutDays element must be integer 0..6, got ${day}`
          );
        }
      }
    });
  });

  it('T1-A04 (F1): PATCH /api/v1/members/:id updates display name, routineAnchors, and safetyContext cleanly without mutating the other spouse', async () => {
    await withServer(async ({ api }) => {
      const updatePayload = {
        name: 'Spouse Alpha',
        avatarInitial: 'A',
        accentColor: '#B89552',
        routineAnchors: {
          wake: '06:30',
          workout: '07:15',
          breakfast: '08:30',
          workoutDays: [1, 3, 5],
          lunch: '12:30',
          dinner: '18:30',
          bed: '22:00',
          tz: 'America/Los_Angeles',
        },
        safetyContext: {
          pregnancyOrTrying: true,
          biologicalSexContext: 'female',
          allergies: ['SyntheticAllergenA'],
          activeRxMeds: ['SyntheticRxA'],
          conditions: ['SyntheticCondA'],
        },
      };

      const patchRes = await api.patch('/api/v1/members/member_wife', updatePayload);
      assertStatus(patchRes, 200, 'PATCH /api/v1/members/member_wife');

      const listRes = await api.get('/api/v1/members');
      assertStatus(listRes, 200, 'GET /api/v1/members after PATCH');
      const members = unwrapData(listRes.json, ['members', 'items']);
      assert.equal(members.length, 2);

      const wife = members.find((m) => m.id === 'member_wife');
      const husband = members.find((m) => m.id === 'member_husband');
      assert.ok(wife && husband);

      assert.equal(wife.name ?? wife.displayName, 'Spouse Alpha');
      assert.equal(wife.avatarInitial, 'A');
      assert.equal(wife.accentColor, '#B89552');
      assert.equal(wife.routineAnchors?.wake, '06:30');
      assert.equal(wife.routineAnchors?.workout, '07:15');
      assert.equal(wife.routineAnchors?.breakfast, '08:30');
      assert.deepEqual(wife.routineAnchors?.workoutDays, [1, 3, 5]);
      assert.equal(wife.routineAnchors?.lunch, '12:30');
      assert.equal(wife.routineAnchors?.dinner, '18:30');
      assert.equal(wife.routineAnchors?.bed, '22:00');
      assert.equal(wife.routineAnchors?.tz, 'America/Los_Angeles');

      assert.equal(wife.safetyContext?.pregnancyOrTrying, true);
      assert.equal(wife.safetyContext?.biologicalSexContext, 'female');
      assert.deepEqual(wife.safetyContext?.allergies, ['SyntheticAllergenA']);
      assert.deepEqual(wife.safetyContext?.activeRxMeds, ['SyntheticRxA']);
      assert.deepEqual(wife.safetyContext?.conditions, ['SyntheticCondA']);

      // Husband must remain completely unmodified
      assert.equal(husband.name ?? husband.displayName, 'Husband');
      assert.equal(husband.safetyContext?.biologicalSexContext, 'male');
      assert.equal(husband.safetyContext?.pregnancyOrTrying, false);
      assert.deepEqual(husband.safetyContext?.allergies, []);
      assert.deepEqual(husband.safetyContext?.activeRxMeds, []);
      assert.deepEqual(husband.safetyContext?.conditions, []);
    });
  });

  it('T1-A05 (F1): POST /api/v1/members and DELETE /api/v1/members/:id create and remove an extensible 3rd household member', async () => {
    await withServer(async ({ api }) => {
      const payload = fixtures.makeMemberPayload({
        id: 'member_guest',
        name: 'Guest Member',
        avatarInitial: 'G',
        accentColor: '#4A7C59',
        role: 'member',
        routineAnchors: {
          wake: '08:00',
          breakfast: '09:00',
          workout: '17:00',
          workoutDays: [2, 4, 6],
          lunch: '13:30',
          dinner: '19:30',
          bed: '23:00',
          tz: 'UTC',
        },
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'unspecified',
          allergies: [],
          activeRxMeds: [],
          conditions: [],
        },
      });

      const createRes = await api.post('/api/v1/members', payload);
      assertStatus(createRes, [200, 201], 'POST /api/v1/members');
      const created = unwrapData(createRes.json, ['member']);
      assert.ok(isPlainObject(created), 'created member must be an object');
      assert.equal(typeof created.id, 'string');
      assert.ok(created.id.trim().length > 0, 'created member must have non-empty id');
      assert.equal(created.name ?? created.displayName, 'Guest Member');
      assert.equal(created.role, 'member');
      assert.equal(created.safetyContext?.biologicalSexContext, 'unspecified');

      const afterCreateRes = await api.get('/api/v1/members');
      assertStatus(afterCreateRes, 200, 'GET /api/v1/members after create');
      const membersAfterCreate = unwrapData(afterCreateRes.json, ['members', 'items']);
      assert.equal(membersAfterCreate.length, 3, 'household should now contain 3 members');
      assert.ok(
        membersAfterCreate.some((m) => m.id === created.id),
        `created member ${created.id} must appear in GET /api/v1/members`
      );

      const delRes = await api.del(`/api/v1/members/${encodeURIComponent(created.id)}`);
      assertStatus(delRes, [200, 204], `DELETE /api/v1/members/${created.id}`);

      const afterDeleteRes = await api.get('/api/v1/members');
      assertStatus(afterDeleteRes, 200, 'GET /api/v1/members after delete');
      const membersAfterDelete = unwrapData(afterDeleteRes.json, ['members', 'items']);
      assert.equal(membersAfterDelete.length, 2, 'household should return to 2 members');
      assert.ok(
        !membersAfterDelete.some((m) => m.id === created.id),
        `deleted member ${created.id} must no longer appear`
      );
      assert.ok(membersAfterDelete.some((m) => m.id === 'member_wife'));
      assert.ok(membersAfterDelete.some((m) => m.id === 'member_husband'));
    });
  });

  it('T1-A06 (F1, F19): PATCH /api/v1/household/settings persists household settings (AI write policy) and restores cleanly', async () => {
    await withServer(async ({ api }) => {
      const [hhRes, openapiRes] = await Promise.all([
        api.get('/api/v1/household'),
        api.get('/openapi.json', { auth: false }),
      ]);
      assertStatus(hhRes, 200, 'GET /api/v1/household initial');
      assertStatus(openapiRes, 200, 'GET /openapi.json');

      const initialHousehold = unwrapData(hhRes.json, ['household']);
      const initialSettings = extractSettingsObject(initialHousehold, hhRes.json);
      const candidates = buildSettingsCandidates(openapiRes.json, initialSettings);
      assert.ok(candidates.length > 0, 'must identify at least one candidate household setting to update');

      let applied = null;
      const attemptLog = [];

      for (const candidate of candidates) {
        const patchRes = await api.patch('/api/v1/household/settings', {
          [candidate.key]: candidate.nextValue,
        });
        attemptLog.push(`${candidate.key}=${JSON.stringify(candidate.nextValue)}->${patchRes.status}`);
        assert.ok(
          patchRes.status < 500,
          `PATCH /api/v1/household/settings (${candidate.key}=${JSON.stringify(candidate.nextValue)}) must never return 5xx, got ${patchRes.status} — body: ${String(patchRes.text ?? '').slice(0, 300)}`
        );
        if (patchRes.status !== 200) continue;

        const verifyRes = await api.get('/api/v1/household');
        assertStatus(verifyRes, 200, 'GET /api/v1/household after settings PATCH');
        const updatedHousehold = unwrapData(verifyRes.json, ['household']);
        const updatedSettings = extractSettingsObject(updatedHousehold, verifyRes.json);

        if (
          updatedSettings[candidate.key] === candidate.nextValue &&
          updatedSettings[candidate.key] !== candidate.currentValue
        ) {
          applied = { ...candidate, originalValue: candidate.currentValue };
          break;
        }
      }

      assert.ok(
        applied !== null,
        `expected PATCH /api/v1/household/settings to persist a changed policy value; attempts: ${attemptLog.join(', ')}`
      );

      // Restore original setting value if it was defined originally
      if (applied.originalValue !== undefined) {
        const restoreRes = await api.patch('/api/v1/household/settings', {
          [applied.key]: applied.originalValue,
        });
        assertStatus(restoreRes, 200, 'PATCH /api/v1/household/settings restore');

        const verifyRestoreRes = await api.get('/api/v1/household');
        assertStatus(verifyRestoreRes, 200, 'GET /api/v1/household after restore');
        const restoredHousehold = unwrapData(verifyRestoreRes.json, ['household']);
        const restoredSettings = extractSettingsObject(restoredHousehold, verifyRestoreRes.json);
        assert.equal(
          restoredSettings[applied.key],
          applied.originalValue,
          `restored ${applied.key} must match original value`
        );
      }
    });
  });

  it('T1-A07 (F2, F9): Shared (household) vs personal (member:member_wife, member:member_husband) ownership coexist independently with full inventory fields', async () => {
    await withServer(async ({ api }) => {
      const sharedRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Shared Magnesium Bisglycinate',
          canonicalMolecule: 'shared-magnesium-e2e',
          aliases: ['Shared Mg'],
        })
      );
      assertStatus(sharedRes, [200, 201], 'create shared compound');
      const cShared = unwrapData(sharedRes.json, ['compound']);

      const personalRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Personal BPC-157 Vial',
          canonicalMolecule: 'personal-bpc157-e2e',
          aliases: ['Personal BPC'],
        })
      );
      assertStatus(personalRes, [200, 201], 'create personal compound');
      const cPersonal = unwrapData(personalRes.json, ['compound']);

      const putShared = await api.put(`/api/v1/ownership/${encodeURIComponent(cShared.id)}`, {
        scope: 'household',
        status: 'have',
        quantity: 90,
        unit: 'caps',
        vendor: 'SyntheticNutra',
        expiryDate: '2028-12-31',
        openedAt: '2026-11-01',
        remainingDoses: 45,
        notes: 'Shared cabinet supplement',
      });
      assertStatus(putShared, [200, 201], 'PUT household ownership');

      const putWife = await api.put(`/api/v1/ownership/${encodeURIComponent(cPersonal.id)}`, {
        scope: 'member:member_wife',
        status: 'have',
        quantity: 2,
        unit: 'vials',
        vendor: 'SyntheticPeptideLab',
        expiryDate: '2027-08-15',
        remainingDoses: 12,
        reconstitution: { vialMg: 5, diluentMl: 2, solvent: 'BAC' },
        notes: 'Wife personal vial',
      });
      assertStatus(putWife, [200, 201], 'PUT member_wife ownership');

      const putHusband = await api.put(`/api/v1/ownership/${encodeURIComponent(cPersonal.id)}`, {
        scope: 'member:member_husband',
        status: 'wishlist',
        notes: 'Husband evaluating',
      });
      assertStatus(putHusband, [200, 201], 'PUT member_husband ownership');

      const listRes = await api.get('/api/v1/ownership');
      assertStatus(listRes, 200, 'GET /api/v1/ownership');
      const records = unwrapData(listRes.json, ['ownership', 'ownerships', 'records', 'items']);
      assert.ok(Array.isArray(records), 'ownership list must be an array');
      assert.equal(records.length, 3, `expected 3 distinct ownership records, got ${records.length}`);

      const recShared = records.find((r) => r.compoundId === cShared.id && r.scope === 'household');
      const recWife = records.find((r) => r.compoundId === cPersonal.id && r.scope === 'member:member_wife');
      const recHusband = records.find((r) => r.compoundId === cPersonal.id && r.scope === 'member:member_husband');

      assert.ok(recShared, 'household ownership record must exist');
      assert.equal(recShared.status, 'have');
      assert.equal(recShared.quantity, 90);
      assert.equal(recShared.unit, 'caps');
      assert.equal(recShared.vendor, 'SyntheticNutra');
      assert.equal(recShared.expiryDate, '2028-12-31');
      assert.equal(recShared.remainingDoses, 45);
      assert.equal(recShared.notes, 'Shared cabinet supplement');

      assert.ok(recWife, 'member:member_wife ownership record must exist');
      assert.equal(recWife.status, 'have');
      assert.equal(recWife.quantity, 2);
      assert.equal(recWife.remainingDoses, 12);
      assert.equal(recWife.reconstitution?.vialMg, 5);
      assert.equal(recWife.reconstitution?.diluentMl, 2);
      assert.equal(recWife.reconstitution?.solvent, 'BAC');
      assert.equal(recWife.notes, 'Wife personal vial');

      assert.ok(recHusband, 'member:member_husband ownership record must exist');
      assert.equal(recHusband.status, 'wishlist');
      assert.equal(recHusband.notes, 'Husband evaluating');
    });
  });

  it('T1-A08 (F2, F9): All 5 canonical ownership statuses (have, dont_have, wishlist, low_stock, ordered) persist, upsert idempotently, and filter cleanly', async () => {
    await withServer(async ({ api }) => {
      const statusSpecs = [
        { key: 'have', status: 'have', scope: 'household', extra: { quantity: 60, unit: 'caps', remainingDoses: 30 } },
        { key: 'dont_have', status: 'dont_have', scope: 'household', extra: {} },
        { key: 'wishlist', status: 'wishlist', scope: 'member:member_wife', extra: { notes: 'On research list' } },
        { key: 'low_stock', status: 'low_stock', scope: 'member:member_husband', extra: { quantity: 1, remainingDoses: 2 } },
        { key: 'ordered', status: 'ordered', scope: 'household', extra: { vendor: 'SyntheticVendor', notes: 'Shipment pending' } },
      ];

      const createdByStatus = {};
      for (const spec of statusSpecs) {
        const res = await api.post(
          '/api/v1/compounds',
          fixtures.makeSupplementCompound({
            name: `Ownership Status Probe ${spec.key}`,
            canonicalMolecule: `ownership-probe-${spec.key}`,
            aliases: [`OSP-${spec.key}`],
          })
        );
        assertStatus(res, [200, 201], `create compound for status ${spec.key}`);
        const cmp = unwrapData(res.json, ['compound']);
        createdByStatus[spec.key] = cmp;

        const putRes = await api.put(`/api/v1/ownership/${encodeURIComponent(cmp.id)}`, {
          scope: spec.scope,
          status: spec.status,
          ...spec.extra,
        });
        assertStatus(putRes, [200, 201], `PUT ownership status=${spec.status}`);
      }

      const list1Res = await api.get('/api/v1/ownership');
      assertStatus(list1Res, 200, 'GET /api/v1/ownership initial');
      const list1 = unwrapData(list1Res.json, ['ownership', 'ownerships', 'records', 'items']);
      assert.equal(list1.length, 5, 'all 5 ownership records must persist');

      for (const spec of statusSpecs) {
        const rec = list1.find(
          (r) => r.compoundId === createdByStatus[spec.key].id && r.scope === spec.scope
        );
        assert.ok(rec, `record for status ${spec.status} must exist`);
        assert.equal(rec.status, spec.status);
      }

      // Idempotent in-place upsert on the same (compoundId, scope)
      const orderedCmp = createdByStatus.ordered;
      const upsertRes = await api.put(`/api/v1/ownership/${encodeURIComponent(orderedCmp.id)}`, {
        scope: 'household',
        status: 'low_stock',
        quantity: 1,
        remainingDoses: 2,
        notes: 'Delivered low stock',
      });
      assertStatus(upsertRes, [200, 201], 'PUT upsert ordered -> low_stock');

      const list2Res = await api.get('/api/v1/ownership');
      assertStatus(list2Res, 200, 'GET /api/v1/ownership after upsert');
      const list2 = unwrapData(list2Res.json, ['ownership', 'ownerships', 'records', 'items']);
      assert.equal(list2.length, 5, 'upsert must update in place without creating duplicates');
      const updatedRec = list2.find(
        (r) => r.compoundId === orderedCmp.id && r.scope === 'household'
      );
      assert.ok(updatedRec);
      assert.equal(updatedRec.status, 'low_stock');
      assert.equal(updatedRec.remainingDoses, 2);

      // Cross-check compounds ownership filter
      const haveFilterRes = await api.get('/api/v1/compounds', { query: { ownership: 'have' } });
      assertStatus(haveFilterRes, 200, 'GET /api/v1/compounds?ownership=have');
      const haveCompounds = unwrapData(haveFilterRes.json, ['compounds', 'items']);
      assert.ok(Array.isArray(haveCompounds));
      const haveIds = new Set(haveCompounds.map((c) => c.id));
      assert.ok(haveIds.has(createdByStatus.have.id), 'have compound must be returned by ?ownership=have');
      assert.ok(!haveIds.has(createdByStatus.dont_have.id), 'dont_have compound must be excluded from ?ownership=have');
      assert.ok(!haveIds.has(createdByStatus.wishlist.id), 'wishlist compound must be excluded from ?ownership=have');
    });
  });

  it('T1-A09 (F3, F30, F38): Per-member stack and dose-log isolation between member_wife and member_husband', async () => {
    await withServer(async ({ api }) => {
      const openapiRes = await api.get('/openapi.json', { auth: false });
      assertStatus(openapiRes, 200, 'GET /openapi.json');

      const wifeCmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Wife Topical Reference',
          canonicalMolecule: 'wife-topical-e2e',
          aliases: ['WifeTopical'],
        })
      );
      assertStatus(wifeCmpRes, [200, 201], 'create wife compound');
      const cWife = unwrapData(wifeCmpRes.json, ['compound']);

      const husbandCmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Husband Mineral Reference',
          canonicalMolecule: 'husband-mineral-e2e',
          aliases: ['HusbandMineral'],
        })
      );
      assertStatus(husbandCmpRes, [200, 201], 'create husband compound');
      const cHusband = unwrapData(husbandCmpRes.json, ['compound']);

      const wifeStackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Morning Protocol',
          memberId: 'member_wife',
          active: true,
          items: [
            fixtures.makeStackItem({
              compoundId: cWife.id,
              doseAmount: 1,
              doseUnit: 'pea_size',
              frequency: 'daily',
            }),
          ],
        })
      );
      assertStatus(wifeStackRes, [200, 201], 'POST member_wife stack');
      const wifeStack = unwrapData(wifeStackRes.json, ['stack']);
      assert.ok(isPlainObject(wifeStack) && wifeStack.id, 'wife stack must have an id');

      const husbandStackRes = await api.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Husband Daily Protocol',
          memberId: 'member_husband',
          active: true,
          items: [
            fixtures.makeStackItem({
              compoundId: cHusband.id,
              doseAmount: 200,
              doseUnit: 'mg',
              frequency: 'daily',
            }),
          ],
        })
      );
      assertStatus(husbandStackRes, [200, 201], 'POST member_husband stack');
      const husbandStack = unwrapData(husbandStackRes.json, ['stack']);
      assert.ok(isPlainObject(husbandStack) && husbandStack.id, 'husband stack must have an id');
      assert.notEqual(wifeStack.id, husbandStack.id, 'spouse stacks must have distinct IDs');

      const wifeLogRes = await createMemberLog(api, openapiRes.json, 'member_wife', {
        compoundId: cWife.id,
        amount: 1,
        unit: 'pea_size',
        notes: 'Wife isolated dose',
        slotId: 'derm_pm',
      });
      assertStatus(wifeLogRes, [200, 201], 'POST member_wife dose log');
      const wifeLog = unwrapData(wifeLogRes.json, ['log']);
      assert.ok(isPlainObject(wifeLog) && wifeLog.id, 'wife log must have an id');

      const husbandLogRes = await createMemberLog(api, openapiRes.json, 'member_husband', {
        compoundId: cHusband.id,
        amount: 200,
        unit: 'mg',
        notes: 'Husband isolated dose',
        slotId: 'evening_dinner',
      });
      assertStatus(husbandLogRes, [200, 201], 'POST member_husband dose log');
      const husbandLog = unwrapData(husbandLogRes.json, ['log']);
      assert.ok(isPlainObject(husbandLog) && husbandLog.id, 'husband log must have an id');
      assert.notEqual(wifeLog.id, husbandLog.id, 'spouse dose logs must have distinct IDs');

      // Verify strict stack isolation
      const [wifeStacksRes, husbandStacksRes] = await Promise.all([
        api.get('/api/v1/members/member_wife/stacks'),
        api.get('/api/v1/members/member_husband/stacks'),
      ]);
      assertStatus(wifeStacksRes, 200, 'GET member_wife stacks');
      assertStatus(husbandStacksRes, 200, 'GET member_husband stacks');

      const wifeStacks = unwrapData(wifeStacksRes.json, ['stacks', 'items']);
      const husbandStacks = unwrapData(husbandStacksRes.json, ['stacks', 'items']);

      assert.ok(wifeStacks.some((s) => s.id === wifeStack.id), 'wife stacks must contain wifeStack');
      assert.ok(!wifeStacks.some((s) => s.id === husbandStack.id), 'wife stacks must NOT contain husbandStack');
      assert.ok(!wifeStacksRes.text.includes('Husband Daily Protocol'), 'wife stacks response must not leak husband stack');

      assert.ok(husbandStacks.some((s) => s.id === husbandStack.id), 'husband stacks must contain husbandStack');
      assert.ok(!husbandStacks.some((s) => s.id === wifeStack.id), 'husband stacks must NOT contain wifeStack');
      assert.ok(!husbandStacksRes.text.includes('Wife Morning Protocol'), 'husband stacks response must not leak wife stack');

      // Verify strict dose-log isolation
      const [wifeLogsRes, husbandLogsRes] = await Promise.all([
        api.get('/api/v1/members/member_wife/logs'),
        api.get('/api/v1/members/member_husband/logs'),
      ]);
      assertStatus(wifeLogsRes, 200, 'GET member_wife logs');
      assertStatus(husbandLogsRes, 200, 'GET member_husband logs');

      const wifeLogs = unwrapData(wifeLogsRes.json, ['logs', 'items']);
      const husbandLogs = unwrapData(husbandLogsRes.json, ['logs', 'items']);

      assert.ok(wifeLogs.some((l) => l.id === wifeLog.id && l.compoundId === cWife.id), 'wife logs must contain wifeLog');
      assert.ok(!wifeLogs.some((l) => l.id === husbandLog.id), 'wife logs must NOT contain husbandLog');
      assert.ok(!wifeLogsRes.text.includes('Husband isolated dose'), 'wife logs response must not leak husband log');

      assert.ok(husbandLogs.some((l) => l.id === husbandLog.id && l.compoundId === cHusband.id), 'husband logs must contain husbandLog');
      assert.ok(!husbandLogs.some((l) => l.id === wifeLog.id), 'husband logs must NOT contain wifeLog');
      assert.ok(!husbandLogsRes.text.includes('Wife isolated dose'), 'husband logs response must not leak wife log');
    });
  });

  it('T1-A10 (F4, F24): Dual authentication succeeds with both Authorization Bearer header and ?token= query fallback on /api/v1/*', async () => {
    await withServer(async ({ server, api }) => {
      const queryClient = createApiClient({
        baseUrl: server.baseUrl,
        token: server.adminToken,
        tokenInQuery: true,
      });

      const bearerRes = await api.get('/api/v1/household');
      assertStatus(bearerRes, 200, 'Bearer GET /api/v1/household');
      const bearerHh = unwrapData(bearerRes.json, ['household']);
      assert.ok(isPlainObject(bearerHh));

      const queryHhRes = await queryClient.get('/api/v1/household');
      assertStatus(queryHhRes, 200, '?token= GET /api/v1/household');
      const queryHh = unwrapData(queryHhRes.json, ['household']);
      assert.ok(isPlainObject(queryHh));
      assert.deepEqual(queryHh, bearerHh, 'Bearer and ?token= auth must return equivalent household state');

      const queryMembersRes = await queryClient.get('/api/v1/members');
      assertStatus(queryMembersRes, 200, '?token= GET /api/v1/members');
      const members = unwrapData(queryMembersRes.json, ['members', 'items']);
      assert.equal(members.length, 2);
      assert.ok(members.some((m) => m.id === 'member_wife'));
      assert.ok(members.some((m) => m.id === 'member_husband'));
    });
  });

  it('T1-A11 (F45): Security and CORS headers enforce Cache-Control no-store, echo allowed origins with Vary Origin, and honor OPTIONS preflight', async () => {
    await withServer(async ({ server, api }) => {
      const privateEndpoints = [
        '/api/v1/household',
        '/api/v1/members',
        '/api/v1/ownership',
        '/api/v1/keys',
      ];

      for (const ep of privateEndpoints) {
        const res = await api.get(ep);
        assertStatus(res, 200, `GET ${ep} for Cache-Control check`);
        const cacheControl = res.headers.get('cache-control') ?? '';
        assert.match(
          cacheControl,
          /\bno-store\b/i,
          `${ep} must set Cache-Control containing no-store, got "${cacheControl}"`
        );
      }

      // Per PROJECT.md §2 and harness.mjs ALLOWED_ORIGINS, github.io + localhost:<port> + 127.0.0.1:<port> are allowed
      const allowedOrigins = [
        'https://rsemenov81-hash.github.io',
        `http://localhost:${server.port}`,
        `http://127.0.0.1:${server.port}`,
      ];

      for (const origin of allowedOrigins) {
        const res = await api.get('/api/v1/household', {
          headers: { Origin: origin },
        });
        assertStatus(res, 200, `GET /api/v1/household with Origin ${origin}`);
        const acao = res.headers.get('access-control-allow-origin');
        assert.equal(
          acao,
          origin,
          `Access-Control-Allow-Origin must echo exact allowed origin "${origin}" (never "*"), got "${acao}"`
        );
        const vary = res.headers.get('vary') ?? '';
        assert.match(
          vary,
          /\bOrigin\b/i,
          `Vary header must include Origin for allowed origin "${origin}", got "${vary}"`
        );
      }

      const preflightRes = await api.options('/api/v1/household', {
        auth: false,
        headers: {
          Origin: 'https://rsemenov81-hash.github.io',
          'Access-Control-Request-Method': 'PATCH',
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      });
      assertStatus(preflightRes, [200, 204], 'OPTIONS /api/v1/household preflight');
      assert.equal(
        preflightRes.headers.get('access-control-allow-origin'),
        'https://rsemenov81-hash.github.io',
        'preflight must echo exact allowed origin'
      );
      assert.match(
        preflightRes.headers.get('vary') ?? '',
        /\bOrigin\b/i,
        'preflight must include Vary: Origin'
      );
      assert.match(
        preflightRes.headers.get('access-control-allow-methods') ?? '',
        /\bPATCH\b/i,
        'preflight must allow PATCH method'
      );
      assert.match(
        preflightRes.headers.get('access-control-allow-headers') ?? '',
        /\bauthorization\b/i,
        'preflight must allow Authorization header'
      );
    });
  });
});
