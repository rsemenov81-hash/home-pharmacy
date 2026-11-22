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

function assertRejected(res, allowed = [400, 422], context = '') {
  assertStatus(res, allowed, context);
  assert.ok(
    String(res.text ?? '').trim().length > 0,
    `${context ? `${context}: ` : ''}rejection response must include diagnostic error payload`
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

function extractConflictCompoundId(json) {
  if (!isPlainObject(json)) return null;
  const direct =
    json.compoundId ??
    json.existingCompoundId ??
    json.existing?.id ??
    json.existingCompound?.id ??
    json.conflict?.compoundId ??
    json.conflict?.id ??
    json.details?.compoundId ??
    json.details?.existingCompoundId ??
    json.error?.compoundId ??
    json.error?.existingCompoundId ??
    json.error?.details?.compoundId ??
    json.error?.details?.existingCompoundId ??
    json.error?.existing?.id ??
    json.error?.existingCompound?.id ??
    json.error?.matches?.[0]?.compoundId ??
    json.error?.matches?.[0]?.id ??
    json.data?.compoundId ??
    json.data?.existingCompoundId ??
    json.data?.existing?.id ??
    json.data?.existingCompound?.id ??
    json.data?.matches?.[0]?.compoundId ??
    json.data?.matches?.[0]?.id ??
    json.matches?.[0]?.compoundId ??
    json.matches?.[0]?.id;
  return typeof direct === 'string' && direct.trim().length > 0 ? direct : null;
}

function hasRunOutWarning(proj) {
  if (proj === true) return true;
  if (typeof proj === 'string' && proj.trim().length > 0) return true;
  if (isPlainObject(proj)) {
    if (
      proj.isLow === false ||
      proj.lowStock === false ||
      proj.isLowStock === false ||
      proj.warning === false
    ) {
      return false;
    }
    return (
      proj.isLow === true ||
      proj.lowStock === true ||
      proj.isLowStock === true ||
      proj.warning === true ||
      (typeof proj.warning === 'string' && proj.warning.trim().length > 0) ||
      (typeof proj.message === 'string' && proj.message.trim().length > 0)
    );
  }
  return false;
}

function hasLowStockIndicator(obj) {
  if (!isPlainObject(obj)) return false;
  for (const f of ['lowStockWarning', 'lowStockAlert', 'runOutWarning', 'warning']) {
    if (obj[f] === true || (typeof obj[f] === 'string' && obj[f].trim().length > 0)) {
      return true;
    }
  }
  return (
    obj.status === 'low_stock' ||
    obj.lowStock === true ||
    obj.isLowStock === true ||
    (Array.isArray(obj.warnings) && obj.warnings.length > 0) ||
    hasRunOutWarning(obj.runOutProjection)
  );
}

describe('Tier 2 — Area B: Section Schema Bounds, Archival, Compound Validation, 409 Dedup, Reconstitution & Idempotency', () => {
  it('T2-B01 (F5, F7, F8): Unknown sectionId is rejected on compound creation without persisting any record', async () => {
    await withServer(async ({ api }) => {
      const payload = fixtures.makePeptideCompound({
        name: 'Invalid Section Substance',
        canonicalMolecule: 'invalid-section-substance',
        aliases: ['ISS-1'],
        sectionId: 'does_not_exist_sec',
      });

      const res = await api.post('/api/v1/compounds', payload);
      assertRejected(res, [400, 422], 'POST compound with unknown sectionId');

      const listRes = await api.get('/api/v1/compounds');
      assertStatus(listRes, 200, 'GET /api/v1/compounds after unknown sectionId rejection');
      const compounds = unwrapData(listRes.json, ['compounds', 'items']);
      assert.equal(compounds.length, 0, 'invalid compound must not be persisted');
    });
  });

  it('T2-B02 (F5, F7): Core section and non-empty custom section deletion or isCore invalidation is prevented cleanly', async () => {
    await withServer(async ({ api }) => {
      // (a) Core section deletion must never succeed or 500
      const delCoreRes = await api.del('/api/v1/sections/peptides');
      assertStatus(
        delCoreRes,
        [400, 403, 404, 405, 409],
        'DELETE core section peptides must be rejected'
      );
      const coreAfter = unwrapData((await api.get('/api/v1/sections/peptides')).json, ['section']);
      assert.equal(coreAfter.id, 'peptides');
      assert.equal(coreAfter.isCore, true);

      // (b) Non-empty custom section deletion must never succeed or destroy its compound
      const secRes = await api.post('/api/v1/sections', {
        id: 'nonempty_guard_sec',
        name: 'Non-Empty Guard Section',
        icon: 'shield',
        accentColor: '#5B7C99',
        description: 'Section holding an active compound',
        subsections: ['General'],
        aiResearchPrompt: 'Educational notes.',
        customFields: [],
      });
      assertStatus(secRes, [200, 201], 'create nonempty_guard_sec');

      const cmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Guarded Custom Section Compound',
          canonicalMolecule: 'guarded-custom-sec-cmp',
          aliases: ['GCSC-1'],
          sectionId: 'nonempty_guard_sec',
          subsection: 'General',
        })
      );
      assertStatus(cmpRes, [200, 201], 'create compound inside nonempty_guard_sec');
      const guardedCmp = unwrapData(cmpRes.json, ['compound']);

      const delNonEmptyRes = await api.del('/api/v1/sections/nonempty_guard_sec');
      assertStatus(
        delNonEmptyRes,
        [400, 403, 404, 405, 409],
        'DELETE non-empty custom section must be rejected'
      );
      assertStatus(await api.get('/api/v1/sections/nonempty_guard_sec'), 200, 'non-empty section must still exist');
      assertStatus(
        await api.get(`/api/v1/compounds/${encodeURIComponent(guardedCmp.id)}`),
        200,
        'compound inside non-empty section must remain intact'
      );

      // (c) Attempting to flip isCore: false on core section cannot strip isCore === true
      const stripCoreRes = await api.patch('/api/v1/sections/peptides', { isCore: false });
      assert.ok(stripCoreRes.status < 500, 'PATCH isCore:false must never 500');
      const reloadedCore = unwrapData((await api.get('/api/v1/sections/peptides')).json, ['section']);
      assert.equal(reloadedCore.isCore, true, 'peptides.isCore must remain immutable true');

      // (d) Duplicate core section ID creation must be rejected
      const dupCoreRes = await api.post('/api/v1/sections', {
        id: 'peptides',
        name: 'Fake Peptides',
        icon: 'flask',
        accentColor: '#000000',
        description: 'Duplicate core ID attempt',
      });
      assertRejected(dupCoreRes, [400, 409, 422], 'POST duplicate core section id');
    });
  });

  it('T2-B03 (F6): Invalid custom field definitions (bad keys, unsupported fieldType, empty select options) are rejected cleanly', async () => {
    await withServer(async ({ api }) => {
      const invalidCases = [
        ['key with spaces/uppercase/punctuation', [{ key: 'Bad Key!', label: 'Bad', fieldType: 'text' }]],
        ['key starting with digit', [{ key: '123start', label: 'Digit Start', fieldType: 'text' }]],
        ['key with hyphen', [{ key: 'bad-key', label: 'Hyphen Key', fieldType: 'text' }]],
        ['unsupported fieldType', [{ key: 'good_key', label: 'Binary', fieldType: 'binary' }]],
        ['select with empty options', [{ key: 'empty_select', label: 'Empty Select', fieldType: 'select', options: [] }]],
      ];

      for (const [label, customFields] of invalidCases) {
        const res = await api.patch('/api/v1/sections/peptides', { customFields });
        assertRejected(res, [400, 422], `PATCH peptides invalid customFields (${label})`);
      }

      const secRes = await api.get('/api/v1/sections/peptides');
      assertStatus(secRes, 200, 'GET peptides after rejected customFields');
      const section = unwrapData(secRes.json, ['section']);
      const persistedKeys = new Set((section.customFields ?? []).map((f) => f.key));
      for (const badKey of ['Bad Key!', '123start', 'bad-key', 'good_key', 'empty_select']) {
        assert.ok(!persistedKeys.has(badKey), `rejected custom field key "${badKey}" must not persist`);
      }
    });
  });

  it('T2-B04 (F6): Non-destructive custom field removal archives compound values under archivedCustomFields and re-adding retains/restores access', async () => {
    await withServer(async ({ api }) => {
      const legacyField = { key: 'legacy_cert', label: 'Legacy Cert', fieldType: 'text', showOnCard: false };
      const activeField = { key: 'active_cert', label: 'Active Cert', fieldType: 'text', showOnCard: true };

      assertStatus(
        await api.patch('/api/v1/sections/vitamins_supplements', {
          customFields: [legacyField, activeField],
        }),
        200,
        'add two custom fields to vitamins_supplements'
      );

      const createRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Archive Check Vitamin',
          canonicalMolecule: 'archive-check-vitamin',
          aliases: ['ACV-Archive'],
          customFields: {
            legacy_cert: 'CERT-ARCHIVE-42',
            active_cert: 'CERT-KEEP-99',
          },
        })
      );
      assertStatus(createRes, [200, 201], 'create compound with customFields');
      const cmp = unwrapData(createRes.json, ['compound']);

      const initialGet = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(cmp.id)}`)).json, ['compound']);
      assert.equal(initialGet.customFields?.legacy_cert, 'CERT-ARCHIVE-42');
      assert.equal(initialGet.customFields?.active_cert, 'CERT-KEEP-99');

      // Remove legacy_cert from section schema (keeping only active_cert)
      assertStatus(
        await api.patch('/api/v1/sections/vitamins_supplements', {
          customFields: [activeField],
        }),
        200,
        'remove legacy_cert from section customFields'
      );

      const archivedGet = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(cmp.id)}`)).json, ['compound']);
      assert.equal(archivedGet.customFields?.active_cert, 'CERT-KEEP-99', 'remaining custom field must stay active');
      assert.equal(
        archivedGet.customFields?.legacy_cert,
        undefined,
        'removed custom field key must move out of active customFields'
      );
      assert.ok(
        isPlainObject(archivedGet.archivedCustomFields),
        'removed custom field value must be preserved in archivedCustomFields object'
      );
      assert.equal(
        archivedGet.archivedCustomFields.legacy_cert,
        'CERT-ARCHIVE-42',
        'archivedCustomFields.legacy_cert must preserve original value without data loss'
      );

      // Re-add legacy_cert to section schema and verify value access is restored/retained
      assertStatus(
        await api.patch('/api/v1/sections/vitamins_supplements', {
          customFields: [activeField, legacyField],
        }),
        200,
        're-add legacy_cert to section customFields'
      );

      const restoredGet = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(cmp.id)}`)).json, ['compound']);
      assert.equal(restoredGet.customFields?.active_cert, 'CERT-KEEP-99');
      assert.equal(
        restoredGet.customFields?.legacy_cert ?? restoredGet.archivedCustomFields?.legacy_cert,
        'CERT-ARCHIVE-42',
        're-adding custom field must restore or retain archived value'
      );
    });
  });

  it('T2-B05 (F8, F17): Missing or blank required compound fields (name, sectionId, empty object) are rejected with actionable details', async () => {
    await withServer(async ({ api }) => {
      // Build full fixture copies and explicitly delete required fields (deepMerge ignores undefined)
      const missingName = fixtures.makePeptideCompound();
      delete missingName.name;

      const missingNameRes = await api.post('/api/v1/compounds', missingName);
      assertRejected(missingNameRes, [400, 422], 'POST compound missing name');
      assert.match(missingNameRes.text, /\bname\b/i, 'missing-name error must mention "name"');

      const blankName = fixtures.makePeptideCompound({ name: '   ' });
      const blankNameRes = await api.post('/api/v1/compounds', blankName);
      assertRejected(blankNameRes, [400, 422], 'POST compound blank whitespace name');

      const missingSection = fixtures.makePeptideCompound({
        name: 'Missing Section Compound',
        canonicalMolecule: 'missing-section-cmp',
        aliases: [],
      });
      delete missingSection.sectionId;

      const missingSectionRes = await api.post('/api/v1/compounds', missingSection);
      assertRejected(missingSectionRes, [400, 422], 'POST compound missing sectionId');
      assert.match(
        missingSectionRes.text,
        /sectionId|section/i,
        'missing-sectionId error must mention "sectionId" or "section"'
      );

      const emptyObjRes = await api.post('/api/v1/compounds', {});
      assertRejected(emptyObjRes, [400, 422], 'POST compound empty object');
      assert.ok(isPlainObject(emptyObjRes.json), 'empty-object error must return structured JSON');

      const listRes = await api.get('/api/v1/compounds');
      assert.equal(unwrapData(listRes.json, ['compounds', 'items']).length, 0);
    });
  });

  it('T2-B06 (F8, F10, F18): Invalid compound enum values (profileStatus, evidenceTier, foodState, halfLife.kind, doNotPairWith.severity) are rejected on create and patch', async () => {
    await withServer(async ({ api }) => {
      const invalidCreateCases = [
        ['invalid profileStatus', fixtures.makePeptideCompound({ name: 'Bad Status Cmp', canonicalMolecule: 'bad-status-1', aliases: [], profileStatus: 'permanently_approved' })],
        [
          'invalid provenance.evidenceTier',
          fixtures.makePeptideCompound({
            name: 'Bad Tier Cmp',
            canonicalMolecule: 'bad-tier-2',
            aliases: [],
            provenance: { evidenceTier: 'anecdotal_rumor' },
          }),
        ],
        [
          'invalid timingRules.foodState',
          fixtures.makePeptideCompound({
            name: 'Bad FoodState Cmp',
            canonicalMolecule: 'bad-food-3',
            aliases: [],
            timingRules: { foodState: 'with_espresso' },
          }),
        ],
        [
          'invalid halfLife.kind',
          fixtures.makePeptideCompound({
            name: 'Bad HalfLife Kind Cmp',
            canonicalMolecule: 'bad-hl-4',
            aliases: [],
            halfLife: { kind: 'eternal' },
          }),
        ],
        [
          'invalid doNotPairWith.severity',
          fixtures.makePeptideCompound({
            name: 'Bad Severity Cmp',
            canonicalMolecule: 'bad-sev-5',
            aliases: [],
            doNotPairWith: [
              {
                targetType: 'class',
                targetRef: 'retinoid',
                severity: 'mild_hint',
                mechanism: 'Invalid severity test',
                recommendation: 'Should fail validation',
              },
            ],
          }),
        ],
      ];

      for (const [label, body] of invalidCreateCases) {
        const res = await api.post('/api/v1/compounds', body);
        assertRejected(res, [400, 422], `POST compound (${label})`);
      }

      // Create valid compound and verify invalid PATCH enum mutations are rejected without altering state
      const validRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Valid Enum Control Compound',
          canonicalMolecule: 'valid-enum-ctrl',
          aliases: ['VEC-1'],
        })
      );
      assertStatus(validRes, [200, 201], 'create valid enum control compound');
      const valid = unwrapData(validRes.json, ['compound']);

      assertRejected(
        await api.patch(`/api/v1/compounds/${encodeURIComponent(valid.id)}`, { profileStatus: 'bogus_status' }),
        [400, 422],
        'PATCH invalid profileStatus'
      );
      assertRejected(
        await api.patch(`/api/v1/compounds/${encodeURIComponent(valid.id)}`, {
          timingRules: { ...valid.timingRules, foodState: 'invalid_food' },
        }),
        [400, 422],
        'PATCH invalid timingRules.foodState'
      );

      const afterGet = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(valid.id)}`)).json, ['compound']);
      assert.equal(afterGet.profileStatus, 'ai_draft');
      assert.equal(afterGet.timingRules?.foodState, 'fasted');

      const allAfterRes = await api.get('/api/v1/compounds');
      assertStatus(allAfterRes, 200, 'GET /api/v1/compounds after enum rejections');
      const allAfter = unwrapData(allAfterRes.json, ['compounds', 'items']);
      assert.equal(allAfter.length, 1, 'only the single valid enum control compound may be persisted');
      assert.equal(allAfter[0].id, valid.id);
    });
  });

  it('T2-B07 (F16, F20): Exact duplicate and alias collisions (Oxandrolone <-> Anavar and Tretinoin <-> Retin-A) return 409 Conflict with existing compoundId', async () => {
    await withServer(async ({ api }) => {
      const oralOxBase = {
        sectionId: 'peds',
        subsection: 'Oral Androgens',
        tags: ['ped', 'androgen', 'aas', '17aa_oral', 'oral_aas', 'hpg_suppressive'],
        halfLife: {
          valueHours: 9,
          minHours: 8,
          maxHours: 10,
          displayText: '~9-10 hours (oral elimination)',
          route: 'Oral',
          kind: 'elimination',
          effectDurationNote: 'Short oral half-life typically split across daily dosing.',
          sourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/',
        },
        dosages: {
          rangeText: '10 mg daily oral',
          defaultAmount: 10,
          defaultUnit: 'mg',
          route: 'Oral',
          frequencyText: 'Daily',
          maxCeiling: 40,
        },
        sectionData: {
          compoundClass: 'Oral AAS (DHT-Derived 17-alpha-Alkylated)',
          ester: null,
          esterHalfLifeDays: null,
          oilPreMixed: false,
          concentrationMgPerMl: null,
          vialMl: null,
          aromatizes: false,
          progestogenic: false,
          dhtDerived: true,
          c17AlphaAlkylated: true,
          hepatotoxicityRisk: 'moderate',
          hpgSuppression: 'moderate',
          requiresTestosteroneBase: false,
          femaleVirilizationRisk: 'moderate',
          teratogenicityRisk: 'high',
          mandatoryLabs: ['Lipid Panel', 'ALT/AST'],
        },
      };

      const oxRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          ...oralOxBase,
          name: 'Oxandrolone',
          canonicalMolecule: 'oxandrolone',
          aliases: ['Anavar', 'Var'],
        })
      );
      assertStatus(oxRes, [200, 201], 'create Oxandrolone');
      const ox = unwrapData(oxRes.json, ['compound']);

      // Collision 1: exact case/whitespace duplicate
      const exactDupRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          ...oralOxBase,
          name: '  oxandrolone  ',
          canonicalMolecule: 'oxandrolone',
          aliases: [],
        })
      );
      assertStatus(exactDupRes, 409, 'exact normalized duplicate must return 409 Conflict');
      assert.equal(
        extractConflictCompoundId(exactDupRes.json),
        ox.id,
        `409 exact duplicate must include existing compoundId ${ox.id}, got: ${exactDupRes.text}`
      );

      // Collision 2: alias collision (Anavar -> Oxandrolone)
      const aliasDupRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          ...oralOxBase,
          name: 'Anavar',
          canonicalMolecule: 'anavar',
          aliases: [],
        })
      );
      assertStatus(aliasDupRes, 409, 'alias collision Anavar vs Oxandrolone must return 409 Conflict');
      assert.equal(
        extractConflictCompoundId(aliasDupRes.json),
        ox.id,
        `409 alias collision must include existing compoundId ${ox.id}, got: ${aliasDupRes.text}`
      );

      // Collision 3: Tretinoin <-> Retin-A in dermatology/Topical
      const tretRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Tretinoin',
          canonicalMolecule: 'tretinoin',
          aliases: ['Retin-A', 'All-trans retinoic acid'],
          sectionId: 'dermatology',
        })
      );
      assertStatus(tretRes, [200, 201], 'create Tretinoin');
      const tret = unwrapData(tretRes.json, ['compound']);

      const retinADupRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Retin-A',
          canonicalMolecule: 'retin-a',
          aliases: [],
          sectionId: 'dermatology',
        })
      );
      assertStatus(retinADupRes, 409, 'alias collision Retin-A vs Tretinoin must return 409 Conflict');
      assert.equal(
        extractConflictCompoundId(retinADupRes.json),
        tret.id,
        `409 Retin-A collision must include existing compoundId ${tret.id}, got: ${retinADupRes.text}`
      );

      // Verify zero duplicate rows created
      const allCompounds = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds', 'items']);
      assert.equal(allCompounds.length, 2, 'only the 2 original compounds may exist after 409 rejections');
    });
  });

  it('T2-B08 (F8, F15): Self-referencing doNotPairWith entries (by name, slug, or id) are rejected on create and patch', async () => {
    await withServer(async ({ api }) => {
      // Case 1: self-reference on POST
      const postSelfRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'SelfLoop Peptide',
          canonicalMolecule: 'selfloop-peptide',
          aliases: [],
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef: 'SelfLoop Peptide',
              severity: 'caution',
              mechanism: 'Invalid self-reference',
              recommendation: 'Must be rejected',
            },
          ],
        })
      );
      assertRejected(postSelfRes, [400, 422], 'POST self-referencing doNotPairWith');

      // Case 2: self-reference on PATCH by id, slug, and name
      const cleanRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'CleanLoop Peptide',
          canonicalMolecule: 'cleanloop-peptide',
          aliases: [],
          doNotPairWith: [],
        })
      );
      assertStatus(cleanRes, [200, 201], 'create CleanLoop Peptide');
      const clean = unwrapData(cleanRes.json, ['compound']);

      for (const [label, targetRef] of [
        ['self id', clean.id],
        ['self slug', clean.slug],
        ['self name', clean.name],
      ]) {
        const res = await api.patch(`/api/v1/compounds/${encodeURIComponent(clean.id)}`, {
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef,
              severity: 'caution',
              mechanism: `Self-reference by ${label}`,
              recommendation: 'Must be rejected',
            },
          ],
        });
        assertRejected(res, [400, 422], `PATCH doNotPairWith referencing ${label}`);
      }

      const afterGet = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(clean.id)}`)).json, ['compound']);
      assert.deepEqual(afterGet.doNotPairWith, [], 'self-referencing doNotPairWith must not persist');

      const allAfterRes = await api.get('/api/v1/compounds');
      assertStatus(allAfterRes, 200, 'GET /api/v1/compounds after self-referencing rejections');
      const allAfter = unwrapData(allAfterRes.json, ['compounds', 'items']);
      assert.equal(allAfter.length, 1, 'only the single valid control compound may exist');
      assert.equal(allAfter[0].id, clean.id);
    });
  });

  it('T2-B09 (F18): Malformed citation URLs and unsafe URI schemes (not-a-url, javascript:, data:) are rejected while valid HTTPS citations succeed', async () => {
    await withServer(async ({ api }) => {
      const badCitationCases = [
        ['not-a-url', 'not-a-url'],
        ['javascript: XSS URI', 'javascript:alert(1)'],
        ['data: HTML URI', 'data:text/html,<script>alert(1)</script>'],
      ];

      for (const [label, badUrl] of badCitationCases) {
        const res = await api.post(
          '/api/v1/compounds',
          fixtures.makePeptideCompound({
            name: `Bad Citation ${label}`,
            canonicalMolecule: `bad-cit-${label.replace(/[^a-z0-9]/gi, '')}`,
            aliases: [],
            provenance: {
              sourceModel: 'manual',
              researchedAt: '2026-11-01T12:00:00.000Z',
              evidenceTier: 'working_hypothesis',
              confidence: 'medium',
              citations: [{ title: 'Invalid Citation', url: badUrl }],
            },
          })
        );
        assertRejected(res, [400, 422], `POST compound with malformed citation URL (${label})`);
      }

      // Unsafe URI in halfLife.sourceUrl
      const badSourceUrlRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Bad HalfLife SourceUrl Peptide',
          canonicalMolecule: 'bad-hl-source-url',
          aliases: [],
          halfLife: {
            sourceUrl: 'javascript:void(0)',
          },
        })
      );
      assertRejected(badSourceUrlRes, [400, 422], 'POST compound with javascript: halfLife.sourceUrl');

      // Control: valid HTTPS citation succeeds
      const validControlRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Valid HTTPS Citation Control',
          canonicalMolecule: 'valid-https-cit-ctrl',
          aliases: [],
          provenance: {
            sourceModel: 'manual',
            researchedAt: '2026-11-01T12:00:00.000Z',
            evidenceTier: 'working_hypothesis',
            confidence: 'medium',
            citations: [
              {
                title: 'Valid PubMed Reference',
                url: 'https://pubmed.ncbi.nlm.nih.gov/30915550/',
                pmid: '30915550',
              },
            ],
          },
        })
      );
      assertStatus(validControlRes, [200, 201], 'control valid HTTPS citation must succeed');
      const validControl = unwrapData(validControlRes.json, ['compound']);

      const allAfterRes = await api.get('/api/v1/compounds');
      assertStatus(allAfterRes, 200, 'GET /api/v1/compounds after bad citation URL rejections');
      const allAfter = unwrapData(allAfterRes.json, ['compounds', 'items']);
      assert.equal(allAfter.length, 1, 'only the single valid HTTPS citation control compound may exist');
      assert.equal(allAfter[0].id, validControl.id);
    });
  });

  it('T2-B10 (F10, F11): Non-positive halfLife valueHours (0, -5) are rejected while unmodeled blends with valueHours null succeed without fabricating a number', async () => {
    await withServer(async ({ api }) => {
      // Negative case 1: valueHours: 0
      const zeroRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Zero HalfLife Peptide',
          canonicalMolecule: 'zero-hl-pep',
          aliases: [],
          halfLife: {
            valueHours: 0,
            minHours: null,
            maxHours: null,
            displayText: '0 hours',
            route: 'SubQ',
            kind: 'elimination',
          },
        })
      );
      assertRejected(zeroRes, [400, 422], 'POST compound with halfLife.valueHours = 0');

      // Negative case 2: valueHours: -5
      const negRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Negative HalfLife Peptide',
          canonicalMolecule: 'neg-hl-pep',
          aliases: [],
          halfLife: {
            valueHours: -5,
            minHours: null,
            maxHours: null,
            displayText: '-5 hours',
            route: 'SubQ',
            kind: 'elimination',
          },
        })
      );
      assertRejected(negRes, [400, 422], 'POST compound with halfLife.valueHours = -5');

      // Positive boundary: multi-peptide blend with kind: 'unmodeled' and valueHours: null
      const blendRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'CJC-1295 + Ipamorelin Blend',
          canonicalMolecule: 'cjc1295-ipamorelin-blend',
          aliases: ['CJC/Ipa Blend'],
          halfLife: {
            valueHours: null,
            minHours: null,
            maxHours: null,
            displayText: 'Unmodeled multi-peptide blend',
            route: 'SubQ',
            kind: 'unmodeled',
          },
          sectionData: {
            form: 'lyophilized',
            vialMg: 10,
            vialIU: null,
            diluentMl: 2,
            solvent: 'BAC',
            isBlend: true,
            blendComponents: [
              { name: 'CJC-1295 (no DAC)', amountMg: 5 },
              { name: 'Ipamorelin', amountMg: 5 },
            ],
          },
        })
      );
      assertStatus(blendRes, [200, 201], 'POST unmodeled multi-peptide blend must succeed');
      const createdBlend = unwrapData(blendRes.json, ['compound']);

      const fetchedBlend = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(createdBlend.id)}`)).json,
        ['compound']
      );
      assert.equal(fetchedBlend.halfLife?.kind, 'unmodeled');
      assert.equal(
        fetchedBlend.halfLife?.valueHours,
        null,
        'unmodeled blend must preserve halfLife.valueHours === null (never fabricate a number)'
      );

      const allAfterRes = await api.get('/api/v1/compounds');
      assertStatus(allAfterRes, 200, 'GET /api/v1/compounds after half-life bounds');
      const allAfter = unwrapData(allAfterRes.json, ['compounds', 'items']);
      assert.equal(allAfter.length, 1, 'only the valid unmodeled blend compound may exist');
      assert.equal(allAfter[0].id, createdBlend.id);
    });
  });

  it('T2-B11 (F9, F11, F12): Reconstitution and oil concentration boundary validation rejects zero/negative diluent and negative vial/concentration values', async () => {
    await withServer(async ({ api }) => {
      const pepRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Reconstitution Bounds Peptide',
          canonicalMolecule: 'recon-bounds-pep',
          aliases: ['RBP-1'],
        })
      );
      assertStatus(pepRes, [200, 201], 'create peptide for reconstitution bounds');
      const pep = unwrapData(pepRes.json, ['compound']);

      // Ownership reconstitution bounds
      const badOwnershipRecon = [
        ['diluentMl = 0', { scope: 'household', status: 'have', reconstitution: { vialMg: 5, diluentMl: 0, solvent: 'BAC' } }],
        ['diluentMl = -2', { scope: 'household', status: 'have', reconstitution: { vialMg: 5, diluentMl: -2, solvent: 'BAC' } }],
        ['vialMg = -5', { scope: 'household', status: 'have', reconstitution: { vialMg: -5, diluentMl: 2, solvent: 'BAC' } }],
        ['vialIU = -100', { scope: 'household', status: 'have', reconstitution: { vialIU: -100, diluentMl: 2, solvent: 'BAC' } }],
      ];

      for (const [label, body] of badOwnershipRecon) {
        const res = await api.put(`/api/v1/ownership/${encodeURIComponent(pep.id)}`, body);
        assertRejected(res, [400, 422], `PUT ownership invalid reconstitution (${label})`);
      }

      // Control valid ownership reconstitution succeeds
      const validReconRes = await api.put(`/api/v1/ownership/${encodeURIComponent(pep.id)}`, {
        scope: 'household',
        status: 'have',
        reconstitution: { vialMg: 5, diluentMl: 2, solvent: 'BAC' },
      });
      assertStatus(validReconRes, [200, 201], 'PUT ownership valid reconstitution control');

      // Compound sectionData peptide reconstitution bounds
      const badSectionReconCases = [
        [
          'peptide sectionData negative vialMg',
          fixtures.makePeptideCompound({
            name: 'Neg Vial SectionData Pep',
            canonicalMolecule: 'neg-vial-sd-pep',
            aliases: [],
            sectionData: { form: 'lyophilized', vialMg: -5, diluentMl: 2, solvent: 'BAC' },
          }),
        ],
        [
          'peptide sectionData zero diluentMl',
          fixtures.makePeptideCompound({
            name: 'Zero Diluent SectionData Pep',
            canonicalMolecule: 'zero-dil-sd-pep',
            aliases: [],
            sectionData: { form: 'lyophilized', vialMg: 5, diluentMl: 0, solvent: 'BAC' },
          }),
        ],
        [
          'peptide sectionData negative diluentMl',
          fixtures.makePeptideCompound({
            name: 'Neg Diluent SectionData Pep',
            canonicalMolecule: 'neg-dil-sd-pep',
            aliases: [],
            sectionData: { form: 'lyophilized', vialMg: 5, diluentMl: -2, solvent: 'BAC' },
          }),
        ],
        [
          'PED sectionData negative oil concentration',
          fixtures.makePedCompound({
            name: 'Neg Oil Concentration PED',
            canonicalMolecule: 'neg-oil-conc-ped',
            aliases: [],
            sectionData: {
              oilPreMixed: true,
              concentrationMgPerMl: -200,
            },
          }),
        ],
      ];

      for (const [label, body] of badSectionReconCases) {
        const res = await api.post('/api/v1/compounds', body);
        assertRejected(res, [400, 422], `POST compound (${label})`);
      }

      const allAfterRes = await api.get('/api/v1/compounds');
      assertStatus(allAfterRes, 200, 'GET /api/v1/compounds after invalid reconstitution/oil rejections');
      const allAfter = unwrapData(allAfterRes.json, ['compounds', 'items']);
      assert.equal(allAfter.length, 1, 'only the single valid reconstitution control peptide may exist');
      assert.equal(allAfter[0].id, pep.id);
    });
  });

  it('T2-B12 (F9): Stock quantity and remainingDoses reject negatives, accept 0 lower bound, and reflect low stock when remainingDoses <= 3', async () => {
    await withServer(async ({ api }) => {
      const cmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Stock Boundary Supplement',
          canonicalMolecule: 'stock-boundary-supp',
          aliases: ['SBS-1'],
        })
      );
      assertStatus(cmpRes, [200, 201], 'create stock boundary compound');
      const cmp = unwrapData(cmpRes.json, ['compound']);

      // Negative quantities & invalid status rejected
      assertRejected(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cmp.id)}`, {
          scope: 'household',
          status: 'have',
          quantity: -1,
        }),
        [400, 422],
        'PUT ownership negative quantity'
      );
      assertRejected(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cmp.id)}`, {
          scope: 'household',
          status: 'have',
          remainingDoses: -3,
        }),
        [400, 422],
        'PUT ownership negative remainingDoses'
      );
      assertRejected(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cmp.id)}`, {
          scope: 'household',
          status: 'invalid_status_xyz',
        }),
        [400, 422],
        'PUT ownership invalid status enum'
      );

      // Valid zero lower bound with explicit low_stock status
      const zeroBoundRes = await api.put(`/api/v1/ownership/${encodeURIComponent(cmp.id)}`, {
        scope: 'household',
        status: 'low_stock',
        quantity: 0,
        remainingDoses: 0,
      });
      assertStatus(zeroBoundRes, [200, 201], 'PUT ownership valid 0 lower bound');
      const zeroRec = unwrapData(zeroBoundRes.json, ['ownership', 'record']);
      assert.equal(zeroRec.remainingDoses, 0);
      assert.equal(zeroRec.status, 'low_stock');

      const lowStockFilter = unwrapData(
        (await api.get('/api/v1/compounds', { query: { ownership: 'low_stock' } })).json,
        ['compounds', 'items']
      );
      assert.ok(
        lowStockFilter.some((c) => c.id === cmp.id),
        'compound with status low_stock must appear under ?ownership=low_stock'
      );

      // Low-stock threshold reflection when remainingDoses <= 3
      const lowThresholdRes = await api.put(`/api/v1/ownership/${encodeURIComponent(cmp.id)}`, {
        scope: 'household',
        status: 'have',
        quantity: 1,
        remainingDoses: 2,
      });
      assertStatus(lowThresholdRes, [200, 201], 'PUT ownership remainingDoses = 2');
      const lowRec = unwrapData(lowThresholdRes.json, ['ownership', 'record']);
      assert.equal(lowRec.remainingDoses, 2);

      const lowStockReflectedOnPut =
        hasLowStockIndicator(lowThresholdRes.json) ||
        hasLowStockIndicator(lowThresholdRes.json?.data) ||
        hasLowStockIndicator(lowRec);

      // Also inspect GET /api/v1/ownership and ?ownership=low_stock filter
      const getOwnRes = await api.get('/api/v1/ownership');
      assertStatus(getOwnRes, 200, 'GET /api/v1/ownership after remainingDoses=2');
      const listedOwn = unwrapData(getOwnRes.json, ['ownership', 'ownerships', 'records', 'items']);
      const fetchedRec = listedOwn.find((r) => r.compoundId === cmp.id && r.scope === 'household') ?? {};
      const lowStockReflectedOnGet =
        hasLowStockIndicator(getOwnRes.json) ||
        hasLowStockIndicator(getOwnRes.json?.data) ||
        hasLowStockIndicator(fetchedRec);

      const lowFilterAfterRes = await api.get('/api/v1/compounds', { query: { ownership: 'low_stock' } });
      assertStatus(lowFilterAfterRes, 200, 'GET /api/v1/compounds?ownership=low_stock after remainingDoses=2');
      const lowFilterAfter = unwrapData(lowFilterAfterRes.json, ['compounds', 'items']);
      const reflectedInLowStockFilter = Array.isArray(lowFilterAfter) && lowFilterAfter.some((c) => c.id === cmp.id);

      assert.ok(
        lowStockReflectedOnPut || lowStockReflectedOnGet || reflectedInLowStockFilter,
        `remainingDoses <= 3 must be reflected via low_stock status, low-stock/run-out warning, or ?ownership=low_stock filter; got PUT=${JSON.stringify(lowThresholdRes.json)}, GET=${JSON.stringify(fetchedRec)}`
      );
    });
  });

  it('T2-B13 (F5, F8, F19): Nonexistent compound and section endpoints consistently return 404', async () => {
    await withServer(async ({ api }) => {
      assertStatus(await api.get('/api/v1/compounds/does-not-exist'), 404, 'GET nonexistent compound');
      assertStatus(
        await api.patch('/api/v1/compounds/does-not-exist', { notes: 'ghost update' }),
        404,
        'PATCH nonexistent compound'
      );
      assertStatus(await api.del('/api/v1/compounds/does-not-exist'), 404, 'DELETE nonexistent compound');
      assertStatus(
        await api.post('/api/v1/compounds/does-not-exist/verify', {}),
        404,
        'POST verify nonexistent compound'
      );
      assertStatus(await api.get('/api/v1/sections/does-not-exist'), 404, 'GET nonexistent section');
    });
  });

  it('T2-B14 (F40): Search and filter edge cases (empty/whitespace q, SQL/regex metacharacters, invalid filter enums) never return 500', async () => {
    await withServer(async ({ api }) => {
      assertStatus(
        await api.post(
          '/api/v1/compounds',
          fixtures.makePeptideCompound({
            name: 'Search Edge Peptide One',
            canonicalMolecule: 'search-edge-1',
            aliases: ['SEP-1'],
          })
        ),
        [200, 201],
        'seed edge compound 1'
      );
      assertStatus(
        await api.post(
          '/api/v1/compounds',
          fixtures.makeSupplementCompound({
            name: 'Search Edge Supplement Two',
            canonicalMolecule: 'search-edge-2',
            aliases: ['SES-2'],
          })
        ),
        [200, 201],
        'seed edge compound 2'
      );

      const emptyQRes = await api.get('/api/v1/compounds', { query: { q: '' } });
      assertStatus(emptyQRes, 200, 'GET /api/v1/compounds?q=');
      assert.equal(unwrapData(emptyQRes.json, ['compounds', 'items']).length, 2, 'empty q must return full list');

      const spaceQRes = await api.get('/api/v1/compounds', { query: { q: '   ' } });
      assertStatus(spaceQRes, 200, 'GET /api/v1/compounds?q=   ');
      assert.equal(unwrapData(spaceQRes.json, ['compounds', 'items']).length, 2, 'whitespace q must return full list');

      const noMatchQueries = [
        'nonexistent_token_9999',
        "' OR 1=1 --",
        '[unclosed(regex*',
      ];
      for (const q of noMatchQueries) {
        const res = await api.get('/api/v1/compounds', { query: { q } });
        assertStatus(res, 200, `GET /api/v1/compounds?q=${q}`);
        const list = unwrapData(res.json, ['compounds', 'items']);
        assert.ok(Array.isArray(list));
        assert.equal(list.length, 0, `query "${q}" must safely return 0 items without crashing`);
      }

      // Invalid filter enums must either return 400/422 or safe 200 [] (never 500, never return unrelated rows)
      const invalidFilters = [
        { status: 'not_a_status' },
        { evidenceTier: 'not_a_tier' },
        { ownership: 'not_an_ownership' },
      ];
      for (const query of invalidFilters) {
        const res = await api.get('/api/v1/compounds', { query });
        assert.ok(
          [200, 400, 422].includes(res.status),
          `invalid filter ${JSON.stringify(query)} must return 400/422 or safe 200 [], got ${res.status}`
        );
        if (res.status === 200) {
          const list = unwrapData(res.json, ['compounds', 'items']);
          assert.ok(Array.isArray(list) && list.length === 0, `invalid filter ${JSON.stringify(query)} returning 200 must return []`);
        }
      }
    });
  });

  it('T2-B15 (F46): Repeated POST /api/v1/seed/starter calls are strictly idempotent with zero duplicate clones', async () => {
    await withServer(async ({ api }) => {
      const initialList = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds', 'items']);
      assert.equal(initialList.length, 0, 'fresh server must start with 0 compounds');

      assertStatus(await api.post('/api/v1/seed/starter', {}), [200, 201], 'seed #1');
      const list1 = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds', 'items']);
      assert.ok(list1.length >= 4, `first seed must populate >= 4 compounds, got ${list1.length}`);
      const ids1 = list1.map((c) => c.id).sort();

      assertStatus(await api.post('/api/v1/seed/starter', {}), [200, 201], 'seed #2');
      const list2 = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds', 'items']);
      const ids2 = list2.map((c) => c.id).sort();

      assertStatus(await api.post('/api/v1/seed/starter', {}), [200, 201], 'seed #3');
      const list3 = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds', 'items']);
      const ids3 = list3.map((c) => c.id).sort();

      assert.equal(list2.length, list1.length, 'second seed must not add duplicate rows');
      assert.equal(list3.length, list1.length, 'third seed must not add duplicate rows');
      assert.deepEqual(ids2, ids1, 'second seed must preserve identical compound IDs');
      assert.deepEqual(ids3, ids1, 'third seed must preserve identical compound IDs');

      const sectionSlugPairs = new Set(list3.map((c) => `${c.sectionId}::${c.slug}`));
      assert.equal(sectionSlugPairs.size, list3.length, 'every seeded compound must have a unique (sectionId, slug) pair');
    });
  });

  it('T2-B16 (F8): Partial PATCH preserves untouched nested profile fields and rejects invalid sectionId reassignment', async () => {
    await withServer(async ({ api }) => {
      const createRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Partial Patch Integrity Peptide',
          canonicalMolecule: 'partial-patch-integrity-pep',
          aliases: ['PPIP-1'],
        })
      );
      assertStatus(createRes, [200, 201], 'create compound for partial PATCH check');
      const original = unwrapData(createRes.json, ['compound']);

      const patchNotesRes = await api.patch(`/api/v1/compounds/${encodeURIComponent(original.id)}`, {
        notes: 'Only notes changed',
      });
      assertStatus(patchNotesRes, 200, 'partial PATCH notes only');

      const afterNotes = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(original.id)}`)).json,
        ['compound']
      );
      assert.equal(afterNotes.notes, 'Only notes changed');
      assert.deepEqual(afterNotes.timingRules, original.timingRules, 'timingRules must remain untouched');
      assert.deepEqual(afterNotes.halfLife, original.halfLife, 'halfLife must remain untouched');
      assert.deepEqual(afterNotes.dosages, original.dosages, 'dosages must remain untouched');
      assert.deepEqual(afterNotes.cycles, original.cycles, 'cycles must remain untouched');
      assert.deepEqual(afterNotes.sectionData, original.sectionData, 'sectionData must remain untouched');
      assert.deepEqual(afterNotes.provenance, original.provenance, 'provenance must remain untouched');

      const badSectionPatch = await api.patch(`/api/v1/compounds/${encodeURIComponent(original.id)}`, {
        sectionId: 'unknown_target_section',
      });
      assertRejected(badSectionPatch, [400, 422], 'PATCH compound to unknown sectionId');

      const afterBadPatch = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(original.id)}`)).json,
        ['compound']
      );
      assert.equal(afterBadPatch.sectionId, 'peptides', 'original sectionId must remain intact');
    });
  });
});
