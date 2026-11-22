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

const CORE_SECTION_IDS = ['peptides', 'peds', 'vitamins_supplements', 'dermatology'];

const ALL_CUSTOM_FIELD_DEFS = [
  {
    key: 'batch_lot',
    label: 'Batch Lot',
    fieldType: 'text',
    showOnCard: false,
    aiResearchInstruction: 'Optional synthetic lot identifier',
  },
  {
    key: 'synthesis_notes',
    label: 'Synthesis Notes',
    fieldType: 'textarea',
    showOnCard: false,
  },
  {
    key: 'purity_pct',
    label: 'HPLC Purity',
    fieldType: 'number',
    unit: '%',
    showOnCard: true,
  },
  {
    key: 'storage_tier',
    label: 'Storage Tier',
    fieldType: 'select',
    options: ['Room Temp', '2-8C Fridge', '-20C Freezer'],
    required: false,
    showOnCard: true,
  },
  {
    key: 'lab_assays',
    label: 'Lab Assays',
    fieldType: 'multiselect',
    options: ['HPLC', 'Mass Spec', 'Endotoxin', 'Sterility'],
    showOnCard: false,
  },
  {
    key: 'cold_chain_required',
    label: 'Cold Chain Required',
    fieldType: 'boolean',
    showOnCard: true,
  },
  fixtures.makeCustomSectionField({
    key: 'coa_url',
    label: 'COA Link',
    fieldType: 'url',
    required: false,
    showOnCard: false,
    aiResearchInstruction: 'Provide HTTPS COA URL if published',
  }),
  {
    key: 'stability_bullets',
    label: 'Stability Bullets',
    fieldType: 'list',
    showOnCard: false,
  },
];

function collectIds(value, out) {
  if (!value) return;
  if (typeof value === 'string' && value.trim().length > 0) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of ['compoundId', 'id', 'existingCompoundId']) {
      if (typeof value[key] === 'string' && value[key].trim().length > 0) {
        out.add(value[key]);
      }
    }
    if (isPlainObject(value.compound)) collectIds(value.compound, out);
    if (isPlainObject(value.existingCompound)) collectIds(value.existingCompound, out);
  }
}

function analyzeDupCheck(json) {
  const body = isPlainObject(json?.data) ? json.data : (isPlainObject(json) ? json : {});
  const matchedIds = new Set();
  const relatedVariantIds = new Set();

  collectIds(body.compoundId, matchedIds);
  collectIds(body.existingCompoundId, matchedIds);
  collectIds(body.existing, matchedIds);
  collectIds(body.existingCompound, matchedIds);
  collectIds(body.compound, matchedIds);
  collectIds(body.conflict, matchedIds);
  collectIds(body.exactMatch, matchedIds);
  collectIds(body.exactMatches, matchedIds);
  collectIds(body.match, matchedIds);
  collectIds(body.duplicates, matchedIds);

  collectIds(body.sameMoleculeOtherRoute, relatedVariantIds);
  collectIds(body.sameMoleculeVariants, relatedVariantIds);
  collectIds(body.sameMolecule, relatedVariantIds);
  collectIds(body.sameMoleculeMatches, relatedVariantIds);
  collectIds(body.multiRouteVariants, relatedVariantIds);
  collectIds(body.relatedCompoundIds, relatedVariantIds);
  collectIds(body.relatedVariants, relatedVariantIds);
  collectIds(body.relatedMatches, relatedVariantIds);
  collectIds(body.variants, relatedVariantIds);
  collectIds(body.siblings, relatedVariantIds);
  collectIds(body.related, relatedVariantIds);
  collectIds(body.relatedCompounds, relatedVariantIds);
  collectIds(body.otherRoutes, relatedVariantIds);

  const explicitBool =
    typeof body.isDuplicate === 'boolean'
      ? body.isDuplicate
      : typeof body.duplicate === 'boolean'
        ? body.duplicate
        : null;

  const blockingTypePattern =
    /^(exact|exact.?name|exact.?match|normalized.?name|name|alias|alias.?match|slug|duplicate|exact.?or.?alias|fingerprint)$/i;
  const explicitVariantPattern = /other.?route|different.?route|multi.?route|sibling|variant|related/i;
  const moleculeTypePattern = /same.?molecule|canonical.?molecule|^molecule$|^canonical$/i;

  let hasBlockingMatchEntry = false;
  if (Array.isArray(body.matches)) {
    for (const m of body.matches) {
      if (!isPlainObject(m)) continue;
      const structuredType = String(
        m.matchType ?? m.type ?? m.kind ?? m.relation ?? m.classification ?? ''
      ).trim();
      const reasonText = String(m.reason ?? '').trim();
      const isBlockingType = blockingTypePattern.test(structuredType);
      const isExplicitBlocking =
        m.isDuplicate === true || m.duplicate === true || m.blocking === true;
      const isExplicitNonBlocking =
        m.sameMoleculeOtherRoute === true ||
        m.isDuplicate === false ||
        m.duplicate === false ||
        m.blocking === false;

      const isRelatedEntry = isExplicitBlocking
        ? false
        : isExplicitNonBlocking ||
          (!isBlockingType &&
            (explicitVariantPattern.test(structuredType) ||
              explicitVariantPattern.test(reasonText) ||
              (explicitBool !== true &&
                (moleculeTypePattern.test(structuredType) || explicitBool === false))));

      if (isRelatedEntry) {
        collectIds(m, relatedVariantIds);
      } else {
        collectIds(m, matchedIds);
        if (isExplicitBlocking || isBlockingType) {
          hasBlockingMatchEntry = true;
        }
      }
    }
  }

  const statusStr = String(body.status ?? body.outcome ?? body.result ?? '').toLowerCase();
  const isDuplicate =
    explicitBool !== null
      ? explicitBool
      : Boolean(body.exactMatch) ||
        statusStr === 'duplicate' ||
        statusStr === 'conflict' ||
        statusStr === 'exact' ||
        statusStr === 'alias' ||
        hasBlockingMatchEntry;

  return {
    body,
    isDuplicate,
    matchedIds: [...matchedIds],
    relatedVariantIds: [...relatedVariantIds],
  };
}

describe('Tier 1 — Area B: Sections, Dynamic Schemas, Compound Profiles, Dedup, Search & Starter Catalog', () => {
  it('T1-B01 (F5): All 4 core sections bootstrap cleanly with isCore true, metadata, and subsections', async () => {
    await withServer(async ({ api }) => {
      const listRes = await api.get('/api/v1/sections');
      assertStatus(listRes, 200, 'GET /api/v1/sections');
      const sections = unwrapData(listRes.json, ['sections', 'items']);
      assert.ok(Array.isArray(sections), 'GET /api/v1/sections must return an array');

      const byId = new Map(sections.map((s) => [s.id, s]));
      for (const coreId of CORE_SECTION_IDS) {
        const listed = byId.get(coreId);
        assert.ok(listed, `core section "${coreId}" must be present in GET /api/v1/sections`);

        const detailRes = await api.get(`/api/v1/sections/${coreId}`);
        assertStatus(detailRes, 200, `GET /api/v1/sections/${coreId}`);
        const section = unwrapData(detailRes.json, ['section']);
        assert.ok(isPlainObject(section), `GET /api/v1/sections/${coreId} must return an object`);

        assert.equal(section.id, coreId);
        assert.equal(section.isCore, true, `${coreId}.isCore must be true`);
        assert.equal(typeof section.name, 'string');
        assert.ok(section.name.trim().length > 0, `${coreId}.name must be non-empty`);
        assert.equal(typeof section.icon, 'string');
        assert.ok(section.icon.trim().length > 0, `${coreId}.icon must be non-empty`);
        assert.equal(typeof section.accentColor, 'string');
        assert.ok(section.accentColor.trim().length > 0, `${coreId}.accentColor must be non-empty`);
        assert.equal(typeof section.description, 'string');
        assert.ok(section.description.trim().length > 0, `${coreId}.description must be non-empty`);
        assert.ok(
          Array.isArray(section.subsections) && section.subsections.length > 0,
          `${coreId}.subsections must be a non-empty array`
        );
        assert.ok(Array.isArray(section.customFields), `${coreId}.customFields must be an array`);
        assert.ok(Array.isArray(section.hiddenOptionalFields), `${coreId}.hiddenOptionalFields must be an array`);
        assert.equal(typeof section.aiResearchPrompt, 'string', `${coreId}.aiResearchPrompt must be a string`);
      }
    });
  });

  it('T1-B02 (F6, F7): Dynamic section schema customization adds all 7+ custom field types and updates aiResearchPrompt, subsections, and hiddenOptionalFields', async () => {
    await withServer(async ({ api }) => {
      const initialRes = await api.get('/api/v1/sections/peptides');
      assertStatus(initialRes, 200, 'GET /api/v1/sections/peptides initial');
      const initialSection = unwrapData(initialRes.json, ['section']);
      const updatedSubsections = [
        ...(Array.isArray(initialSection.subsections) ? initialSection.subsections : []),
        'Mitochondrial & Longevity',
      ];
      const newPrompt = 'Include reconstitution solvent compatibility, cold-chain notes, and PubMed PMIDs.';
      const hiddenFields = ['maleDoseNote', 'washoutNote'];

      const patchRes = await api.patch('/api/v1/sections/peptides', {
        customFields: ALL_CUSTOM_FIELD_DEFS,
        aiResearchPrompt: newPrompt,
        subsections: updatedSubsections,
        hiddenOptionalFields: hiddenFields,
      });
      assertStatus(patchRes, 200, 'PATCH /api/v1/sections/peptides');

      const reloadRes = await api.get('/api/v1/sections/peptides');
      assertStatus(reloadRes, 200, 'GET /api/v1/sections/peptides reloaded');
      const updated = unwrapData(reloadRes.json, ['section']);

      assert.equal(updated.isCore, true, 'peptides must remain isCore: true');
      assert.equal(updated.aiResearchPrompt, newPrompt);
      assert.ok(
        updated.subsections.includes('Mitochondrial & Longevity'),
        'custom subsection must persist'
      );
      assert.ok(updated.hiddenOptionalFields.includes('maleDoseNote'));
      assert.ok(updated.hiddenOptionalFields.includes('washoutNote'));
      assert.equal(updated.customFields.length, ALL_CUSTOM_FIELD_DEFS.length);

      const fieldsByKey = new Map(updated.customFields.map((f) => [f.key, f]));
      for (const expectedDef of ALL_CUSTOM_FIELD_DEFS) {
        const persisted = fieldsByKey.get(expectedDef.key);
        assert.ok(persisted, `custom field "${expectedDef.key}" must be persisted`);
        assert.equal(persisted.label, expectedDef.label);
        assert.equal(persisted.fieldType, expectedDef.fieldType);
        if (expectedDef.unit !== undefined) assert.equal(persisted.unit, expectedDef.unit);
        if (expectedDef.options !== undefined) assert.deepEqual(persisted.options, expectedDef.options);
        if (expectedDef.showOnCard !== undefined) assert.equal(persisted.showOnCard, expectedDef.showOnCard);
        if (expectedDef.aiResearchInstruction !== undefined) {
          assert.equal(persisted.aiResearchInstruction, expectedDef.aiResearchInstruction);
        }
      }
    });
  });

  it('T1-B03 (F6, F8): Compound profile round-trips all custom field types (text, textarea, number, select, multiselect, boolean, url, list) verbatim', async () => {
    await withServer(async ({ api }) => {
      const patchSec = await api.patch('/api/v1/sections/peptides', {
        customFields: ALL_CUSTOM_FIELD_DEFS,
      });
      assertStatus(patchSec, 200, 'configure custom fields on peptides');

      const populatedCustomFields = {
        batch_lot: 'LOT-2026-09A',
        synthesis_notes: 'Solid-phase peptide synthesis, lyophilized acetate salt',
        purity_pct: 99.4,
        storage_tier: '2-8C Fridge',
        lab_assays: ['HPLC', 'Endotoxin'],
        cold_chain_required: true,
        coa_url: 'https://example.org/reports/coa-sample-99.pdf',
        stability_bullets: ['Protect from light', 'Use within 28 days reconstituted'],
      };

      const createRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Custom Fields Peptide Reference',
          canonicalMolecule: 'custom-fields-peptide-ref',
          aliases: ['CFP-Ref'],
          customFields: populatedCustomFields,
        })
      );
      assertStatus(createRes, [200, 201], 'POST peptide compound with all custom fields');
      const created = unwrapData(createRes.json, ['compound']);
      assert.ok(created?.id);

      const getRes = await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`);
      assertStatus(getRes, 200, 'GET compound with populated customFields');
      const fetched = unwrapData(getRes.json, ['compound']);

      assert.deepEqual(fetched.customFields, populatedCustomFields, 'all 8 customFields must round-trip with exact types and values');
      assert.equal(typeof fetched.customFields.purity_pct, 'number');
      assert.equal(typeof fetched.customFields.cold_chain_required, 'boolean');
      assert.ok(Array.isArray(fetched.customFields.lab_assays));
      assert.ok(Array.isArray(fetched.customFields.stability_bullets));

      const delRes = await api.del(`/api/v1/compounds/${encodeURIComponent(created.id)}`);
      assertStatus(delRes, [200, 204], 'DELETE custom-field test compound');
    });
  });

  it('T1-B04 (F7): User-defined custom section lifecycle (create rx_meds, store/filter compound, clean up)', async () => {
    await withServer(async ({ api }) => {
      const sectionPayload = {
        id: 'rx_meds',
        name: 'Prescription Reference',
        icon: 'pill',
        accentColor: '#6E8B74',
        description: 'Educational Rx reference for interaction checks',
        subsections: ['Cardiovascular', 'Endocrine'],
        aiResearchPrompt: 'Summarize FDA label mechanism of action and CYP450 interactions.',
        customFields: [
          { key: 'drug_class', label: 'Drug Class', fieldType: 'text', showOnCard: true },
        ],
      };

      const createSecRes = await api.post('/api/v1/sections', sectionPayload);
      assertStatus(createSecRes, [200, 201], 'POST /api/v1/sections (rx_meds)');
      const createdSec = unwrapData(createSecRes.json, ['section']);
      assert.equal(createdSec.id, 'rx_meds');
      assert.equal(createdSec.isCore, false, 'user-created section must have isCore === false');

      const listSecRes = await api.get('/api/v1/sections');
      assertStatus(listSecRes, 200, 'GET /api/v1/sections after custom create');
      const allSections = unwrapData(listSecRes.json, ['sections', 'items']);
      assert.ok(allSections.some((s) => s.id === 'rx_meds'), 'rx_meds must appear in section list');
      for (const coreId of CORE_SECTION_IDS) {
        assert.ok(allSections.some((s) => s.id === coreId), `core section ${coreId} must still exist`);
      }

      const detailSecRes = await api.get('/api/v1/sections/rx_meds');
      assertStatus(detailSecRes, 200, 'GET /api/v1/sections/rx_meds');
      const detailSec = unwrapData(detailSecRes.json, ['section']);
      assert.equal(detailSec.name, 'Prescription Reference');
      assert.deepEqual(detailSec.subsections, ['Cardiovascular', 'Endocrine']);

      const cmpRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Rosuvastatin Reference',
          canonicalMolecule: 'rosuvastatin-ref',
          aliases: ['Crestor Reference'],
          sectionId: 'rx_meds',
          subsection: 'Cardiovascular',
          customFields: { drug_class: 'Statin' },
        })
      );
      assertStatus(cmpRes, [200, 201], 'POST compound in custom section rx_meds');
      const rxCompound = unwrapData(cmpRes.json, ['compound']);
      assert.equal(rxCompound.sectionId, 'rx_meds');
      assert.equal(rxCompound.customFields?.drug_class, 'Statin');

      const filteredRes = await api.get('/api/v1/compounds', { query: { section: 'rx_meds' } });
      assertStatus(filteredRes, 200, 'GET /api/v1/compounds?section=rx_meds');
      const filtered = unwrapData(filteredRes.json, ['compounds', 'items']);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].id, rxCompound.id);

      // Clean up compound, then test empty custom section deletion
      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(rxCompound.id)}`), [200, 204], 'DELETE rx compound');

      const delSecRes = await api.del('/api/v1/sections/rx_meds');
      assert.ok(delSecRes.status < 500, `DELETE /api/v1/sections/rx_meds must not 500, got ${delSecRes.status}`);
      if ([200, 204].includes(delSecRes.status)) {
        assertStatus(await api.get('/api/v1/sections/rx_meds'), 404, 'GET deleted custom section must 404');
        const postDelList = unwrapData((await api.get('/api/v1/sections')).json, ['sections', 'items']);
        assert.ok(!postDelList.some((s) => s.id === 'rx_meds'), 'deleted rx_meds must be absent from sections list');
      } else {
        assertStatus(delSecRes, [404, 405], 'DELETE /api/v1/sections/rx_meds if route not exposed');
      }
    });
  });

  it('T1-B05 (F8, F10, F11, F18): Full CRUD and schema round-trip for Peptides including lyophilized reconstitution fields, blends, provenance, and completenessPct', async () => {
    await withServer(async ({ api }) => {
      const payload = fixtures.makePeptideCompound({
        name: 'BPC-157 Reference',
        canonicalMolecule: 'bpc-157',
        aliases: ['Body Protection Compound 157', 'PL 14736'],
        sectionData: {
          form: 'lyophilized',
          vialMg: 5,
          vialIU: null,
          diluentMl: 2,
          solvent: 'BAC',
          solventNote:
            'Reconstitute gently along vial wall with bacteriostatic water (0.9% benzyl alcohol); do not shake.',
          isBlend: false,
          blendComponents: [],
          siteRotationRecommended: true,
          recommendedSites: [
            'abdomen_left',
            'abdomen_right',
            'thigh_left',
            'thigh_right',
            'flank_left',
            'flank_right',
            'glute_left',
            'glute_right',
          ],
        },
        profileStatus: 'ai_draft',
        provenance: {
          sourceModel: 'ai:claude',
          researchedAt: '2026-11-01T12:00:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [
            {
              title: 'Pentadecapeptide BPC 157 Preclinical Review',
              url: 'https://pubmed.ncbi.nlm.nih.gov/36137574/',
              pmid: '36137574',
            },
          ],
        },
      });

      const createRes = await api.post('/api/v1/compounds', payload);
      assertStatus(createRes, [200, 201], 'POST peptide compound');
      const created = unwrapData(createRes.json, ['compound']);

      assert.equal(typeof created.id, 'string');
      assert.ok(created.id.length > 0);
      assert.equal(typeof created.slug, 'string');
      assert.ok(created.slug.length > 0);
      assert.equal(typeof created.createdAt, 'string');
      assert.equal(typeof created.updatedAt, 'string');
      assert.equal(typeof created.completenessPct, 'number');
      assert.ok(
        created.completenessPct > 50 && created.completenessPct <= 100,
        `expected completenessPct in (50, 100], got ${created.completenessPct}`
      );

      const getRes = await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`);
      assertStatus(getRes, 200, 'GET created peptide');
      const fetched = unwrapData(getRes.json, ['compound']);

      assert.equal(fetched.name, 'BPC-157 Reference');
      assert.equal(fetched.sectionId, 'peptides');
      assert.equal(fetched.summary, payload.summary);
      assert.equal(fetched.mechanismOfAction, payload.mechanismOfAction);
      assert.deepEqual(fetched.useCaseScenarios, payload.useCaseScenarios);
      assert.equal(fetched.timingRules?.foodState, 'fasted');
      assert.deepEqual(fetched.timingRules?.preferredSlots, ['waking_fasted', 'bedtime_fasted']);
      assert.equal(fetched.halfLife?.valueHours, 4);
      assert.equal(fetched.halfLife?.kind, 'elimination');
      assert.equal(fetched.dosages?.defaultAmount, 250);
      assert.equal(fetched.dosages?.defaultUnit, 'mcg');
      assert.equal(fetched.dosages?.route, 'SubQ');
      assert.equal(fetched.cycles?.cycleDays, 42);
      assert.equal(fetched.cycles?.offDays, 21);
      assert.equal(fetched.cycles?.continuous, false);
      assert.equal(fetched.doNotPairWith?.length, 1);
      assert.equal(fetched.synergies?.length, 1);
      assert.equal(fetched.sectionData?.form, 'lyophilized');
      assert.equal(fetched.sectionData?.vialMg ?? fetched.sectionData?.vialAmount, 5);
      assert.equal(fetched.sectionData?.diluentMl, 2);
      assert.equal(fetched.sectionData?.solvent ?? fetched.sectionData?.diluentType, 'BAC');
      assert.equal(fetched.provenance?.evidenceTier, 'working_hypothesis');
      assert.equal(fetched.provenance?.citations?.[0]?.pmid, '36137574');

      // PATCH update nested dosages, sectionData, and notes
      const patchRes = await api.patch(`/api/v1/compounds/${encodeURIComponent(created.id)}`, {
        dosages: { ...fetched.dosages, defaultAmount: 300 },
        sectionData: { ...fetched.sectionData, diluentMl: 2.5 },
        notes: 'Updated peptide protocol note',
      });
      assertStatus(patchRes, 200, 'PATCH peptide compound');

      const reloaded = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`)).json, ['compound']);
      assert.equal(reloaded.dosages?.defaultAmount, 300);
      assert.equal(reloaded.sectionData?.diluentMl, 2.5);
      assert.equal(reloaded.notes, 'Updated peptide protocol note');
      assert.equal(reloaded.mechanismOfAction, payload.mechanismOfAction, 'untouched fields must remain intact');

      // Verify blend peptide with multiple blend ingredients round-trips cleanly
      const blendRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Wolverine Blend (BPC-157 + TB-500)',
          canonicalMolecule: 'bpc157-tb500-blend',
          aliases: ['BPC/TB Blend'],
          halfLife: {
            valueHours: null,
            minHours: null,
            maxHours: null,
            displayText: 'Multi-peptide blend (unmodeled single half-life)',
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
              { name: 'BPC-157', amountMg: 5 },
              { name: 'TB-500', amountMg: 5 },
            ],
          },
        })
      );
      assertStatus(blendRes, [200, 201], 'POST blend peptide');
      const blend = unwrapData(blendRes.json, ['compound']);
      const blendList = blend.sectionData?.blendComponents ?? blend.sectionData?.blendIngredients;
      assert.ok(Array.isArray(blendList) && blendList.length === 2, 'blend peptide must preserve 2 blend ingredients');
      assert.equal(blend.halfLife?.kind, 'unmodeled');
      assert.equal(blend.halfLife?.valueHours, null);

      // DELETE & confirm 404
      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(created.id)}`), [200, 204], 'DELETE peptide');
      assertStatus(await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`), 404, 'GET deleted peptide must 404');
      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(blend.id)}`), [200, 204], 'DELETE blend peptide');
    });
  });

  it('T1-B06 (F8, F10, F12, F18): Full CRUD and schema round-trip for PEDs including oilPreMixed, concentration, ester half-life, harm-reduction flags, and mandatoryLabs', async () => {
    await withServer(async ({ api }) => {
      const mandatoryLabs = [
        'Total & Free Testosterone',
        'Sensitive Estradiol (LC-MS/MS)',
        'CBC / Hematocrit',
        'Lipid Panel (HDL/LDL/ApoB)',
      ];
      const payload = fixtures.makePedCompound({
        name: 'Testosterone Cypionate Reference',
        canonicalMolecule: 'testosterone-cypionate',
        sectionData: {
          compoundClass: 'Injectable AAS (Testosterone Ester)',
          ester: 'Cypionate',
          esterHalfLifeDays: 8,
          oilPreMixed: true,
          concentrationMgPerMl: 200,
          vialMl: 10,
          aromatizes: true,
          progestogenic: false,
          dhtDerived: false,
          c17AlphaAlkylated: false,
          hepatotoxicityRisk: 'low',
          hpgSuppression: 'high',
          requiresTestosteroneBase: false,
          ancillaries: [
            'HCG (gonadal support)',
            'Lab-guided aromatase inhibitor only if symptomatic with elevated sensitive E2',
          ],
          pctRequired: true,
          pctNotes:
            'Wait ~4-5 weeks after last cypionate injection for ester clearance prior to physician-supervised HPG recovery.',
          femaleVirilizationRisk: 'high',
          teratogenicityRisk: 'high',
          mandatoryLabs,
        },
      });

      const createRes = await api.post('/api/v1/compounds', payload);
      assertStatus(createRes, [200, 201], 'POST PED compound');
      const created = unwrapData(createRes.json, ['compound']);

      const getRes = await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`);
      assertStatus(getRes, 200, 'GET created PED');
      const fetched = unwrapData(getRes.json, ['compound']);

      assert.equal(fetched.sectionId, 'peds');
      assert.equal(fetched.dosages?.route, 'IM');
      assert.equal(fetched.halfLife?.kind, 'depot');
      assert.equal(fetched.halfLife?.valueHours, 192);
      assert.equal(fetched.provenance?.evidenceTier, 'established');

      const sd = fetched.sectionData ?? {};
      assert.equal(sd.oilPreMixed, true, 'PED oilPreMixed must be true');
      assert.equal(sd.oilConcentrationMgPerMl ?? sd.concentrationMgPerMl, 200, 'PED oil concentration must be 200 mg/mL');
      assert.equal(sd.ester, 'Cypionate');
      assert.ok(sd.esterHalfLifeDays === 8 || sd.esterHalfLifeHours === 192, 'PED ester half-life must round-trip');
      assert.equal(sd.aromatizes, true);
      assert.equal(sd.hepatotoxic17aa ?? sd.c17AlphaAlkylated, false);
      assert.equal(sd.femaleVirilizationRisk, 'high');
      assert.ok(Array.isArray(sd.mandatoryLabs) && sd.mandatoryLabs.length >= 4);
      assert.ok(sd.mandatoryLabs.includes('CBC / Hematocrit'));

      const patchRes = await api.patch(`/api/v1/compounds/${encodeURIComponent(created.id)}`, {
        notes: 'Updated PED harm-reduction note',
      });
      assertStatus(patchRes, 200, 'PATCH PED compound');
      const reloaded = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`)).json, ['compound']);
      assert.equal(reloaded.notes, 'Updated PED harm-reduction note');

      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(created.id)}`), [200, 204], 'DELETE PED');
      assertStatus(await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`), 404, 'GET deleted PED must 404');
    });
  });

  it('T1-B07 (F8, F13, F18): Full CRUD and schema round-trip for Vitamins & Supplements including chemicalForm, elementalWeightMg, supplementFacts, adultUpperLimit, allergens, and foodCondition', async () => {
    await withServer(async ({ api }) => {
      const payload = fixtures.makeSupplementCompound({
        name: 'Magnesium Bisglycinate Reference',
        canonicalMolecule: 'magnesium',
        timingRules: {
          preferredSlots: ['evening_dinner'],
          avoidSlots: ['pre_workout'],
          foodState: 'with_meal',
          workoutRelation: 'any',
          circadianEffect: 'sedating',
          timingNotes: 'Take with evening meal to support GI tolerability and calm.',
        },
        sectionData: {
          chemicalForm: 'Magnesium Bisglycinate Chelate',
          bioavailabilityNote:
            'High absorption and low laxative potential relative to magnesium oxide.',
          elementalWeightMg: 200,
          totalCompoundWeightMg: 1430,
          servingForm: 'capsule',
          servingSize: '2 capsules',
          supplementFacts: [
            {
              nutrient: 'Magnesium (as Magnesium Bisglycinate)',
              amount: 200,
              unit: 'mg',
              percentDailyValue: 48,
            },
          ],
          foodCondition: 'With meal',
          adultUpperLimit: {
            nutrientKey: 'magnesium_supplemental',
            amount: 350,
            unit: 'mg',
            basis: 'supplemental_only',
            sourceUrl: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
          },
          allergens: [],
          thirdPartyTestedNote: 'Select USP, NSF, or ISO-17025 third-party verified products.',
        },
      });

      const createRes = await api.post('/api/v1/compounds', payload);
      assertStatus(createRes, [200, 201], 'POST supplement compound');
      const created = unwrapData(createRes.json, ['compound']);

      const getRes = await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`);
      assertStatus(getRes, 200, 'GET created supplement');
      const fetched = unwrapData(getRes.json, ['compound']);

      assert.equal(fetched.sectionId, 'vitamins_supplements');
      assert.equal(fetched.dosages?.route, 'Oral');
      assert.equal(fetched.cycles?.continuous, true);
      assert.equal(fetched.provenance?.evidenceTier, 'established');

      const sd = fetched.sectionData ?? {};
      assert.equal(sd.chemicalForm, 'Magnesium Bisglycinate Chelate');
      assert.equal(sd.elementalAmount ?? sd.elementalWeightMg, 200);
      const ingredients = sd.ingredientsList ?? sd.supplementFacts;
      assert.ok(Array.isArray(ingredients) && ingredients.length >= 1, 'ingredientsList/supplementFacts must round-trip');
      assert.ok(isPlainObject(sd.adultUpperLimit), 'adultUpperLimit must be present');
      assert.equal(sd.adultUpperLimit.amount ?? sd.adultUpperLimit.value, 350);
      assert.equal(sd.adultUpperLimit.unit, 'mg');
      assert.ok(Array.isArray(sd.allergens), 'allergens must be an array');
      const foodReq = sd.foodRequirement ?? sd.foodCondition;
      assert.ok(typeof foodReq === 'string' && foodReq.length > 0, 'foodRequirement/foodCondition must round-trip');

      const patchRes = await api.patch(`/api/v1/compounds/${encodeURIComponent(created.id)}`, {
        dosages: { ...fetched.dosages, defaultAmount: 300 },
      });
      assertStatus(patchRes, 200, 'PATCH supplement compound');
      const reloaded = unwrapData((await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`)).json, ['compound']);
      assert.equal(reloaded.dosages?.defaultAmount, 300);

      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(created.id)}`), [200, 204], 'DELETE supplement');
      assertStatus(await api.get(`/api/v1/compounds/${encodeURIComponent(created.id)}`), 404, 'GET deleted supplement must 404');
    });
  });

  it('T1-B08 (F8, F14, F18): Full CRUD and schema round-trip for Dermatology covering all 11 canonical facial fields plus scalp/hair topical targetArea', async () => {
    await withServer(async ({ api }) => {
      const facePayload = fixtures.makeDermCompound({
        name: 'Tretinoin 0.05% Cream Reference',
        canonicalMolecule: 'tretinoin',
        sectionData: {
          targetArea: ['face', 'neck'],
          vehicleType: 'cream',
          actives: [{ name: 'Tretinoin', concentrationPct: 0.05, optimalPh: 5.5 }],
          layeringStep: 5,
          waitTimeMinutes: 20,
          amPmSuitability: 'pm_only',
          photosensitivity: true,
          leaveOn: true,
          acclimationRamp: '2 nights/week -> 3 nights/week -> alternate nights',
          skinCyclingRole: 'retinoid',
          pregnancySafety: 'avoid',
        },
      });

      const createFace = await api.post('/api/v1/compounds', facePayload);
      assertStatus(createFace, [200, 201], 'POST facial derm compound');
      const createdFace = unwrapData(createFace.json, ['compound']);

      const fetchedFace = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(createdFace.id)}`)).json,
        ['compound']
      );
      assert.equal(fetchedFace.sectionId, 'dermatology');
      assert.equal(fetchedFace.dosages?.route, 'Topical');
      assert.deepEqual(fetchedFace.timingRules?.preferredSlots, ['derm_pm']);

      const sd = fetchedFace.sectionData ?? {};
      assert.deepEqual(sd.targetArea, ['face', 'neck']);
      assert.equal(sd.vehicleType, 'cream');
      assert.deepEqual(sd.actives, [{ name: 'Tretinoin', concentrationPct: 0.05, optimalPh: 5.5 }]);
      assert.equal(sd.layeringStep, 5);
      assert.equal(sd.waitTimeMinutes, 20);
      assert.equal(sd.amPmSuitability, 'pm_only');
      assert.equal(sd.photosensitivity, true);
      assert.equal(sd.leaveOn, true);
      assert.equal(sd.acclimationRamp, '2 nights/week -> 3 nights/week -> alternate nights');
      assert.equal(sd.skinCyclingRole, 'retinoid');
      assert.equal(sd.pregnancySafety, 'avoid');

      const patchFace = await api.patch(`/api/v1/compounds/${encodeURIComponent(createdFace.id)}`, {
        sectionData: { ...sd, waitTimeMinutes: 15 },
      });
      assertStatus(patchFace, 200, 'PATCH facial derm waitTimeMinutes');
      const patchedFace = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(createdFace.id)}`)).json,
        ['compound']
      );
      assert.equal(patchedFace.sectionData?.waitTimeMinutes, 15);

      // Scalp / hair topical profile
      const scalpPayload = fixtures.makeDermCompound({
        name: 'Minoxidil 5% Foam Reference',
        canonicalMolecule: 'minoxidil',
        aliases: ['Rogaine 5% Foam Reference'],
        subsection: 'Scalp & Hair Growth',
        tags: ['dermatology', 'scalp_hair', 'vasodilator'],
        timingRules: {
          preferredSlots: ['derm_am', 'derm_pm'],
          avoidSlots: [],
          foodState: 'any',
          workoutRelation: 'any',
          circadianEffect: 'neutral',
          timingNotes: 'Apply to dry scalp morning and/or evening; allow foam to dry.',
        },
        dosages: {
          rangeText: 'Half capful (1 pump) to dry scalp 1-2x daily',
          defaultAmount: 1,
          defaultUnit: 'pumps',
          route: 'Topical',
          frequencyText: 'Once or twice daily',
          maxCeiling: 2,
        },
        sectionData: {
          targetArea: ['scalp_hair'],
          vehicleType: 'foam',
          actives: [{ name: 'Minoxidil', concentrationPct: 5.0 }],
          layeringStep: 3,
          waitTimeMinutes: 10,
          amPmSuitability: 'both',
          photosensitivity: false,
          leaveOn: true,
          acclimationRamp: 'Once daily for 2 weeks before twice daily if desired',
          skinCyclingRole: 'none',
          pregnancySafety: 'avoid',
        },
      });

      const createScalp = await api.post('/api/v1/compounds', scalpPayload);
      assertStatus(createScalp, [200, 201], 'POST scalp/hair derm compound');
      const createdScalp = unwrapData(createScalp.json, ['compound']);
      const fetchedScalp = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(createdScalp.id)}`)).json,
        ['compound']
      );
      assert.deepEqual(fetchedScalp.sectionData?.targetArea, ['scalp_hair']);
      assert.equal(fetchedScalp.sectionData?.vehicleType, 'foam');

      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(createdFace.id)}`), [200, 204], 'DELETE facial derm');
      assertStatus(await api.get(`/api/v1/compounds/${encodeURIComponent(createdFace.id)}`), 404, 'GET deleted facial derm must 404');
      assertStatus(await api.del(`/api/v1/compounds/${encodeURIComponent(createdScalp.id)}`), [200, 204], 'DELETE scalp derm');
    });
  });

  it('T1-B09 (F16, F20): Multi-route same-substance siblings (GHK-Cu SubQ vs GHK-Cu 2% Serum Topical) coexist with shared canonicalMolecule and bidirectional relatedCompoundIds', async () => {
    await withServer(async ({ api }) => {
      const subqRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'GHK-Cu',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Tripeptide-1'],
          sectionId: 'peptides',
          dosages: {
            rangeText: '1-2 mg daily SubQ',
            defaultAmount: 1,
            defaultUnit: 'mg',
            route: 'SubQ',
            frequencyText: 'Once daily',
            maxCeiling: 5,
          },
        })
      );
      assertStatus(subqRes, [200, 201], 'POST GHK-Cu SubQ');
      const subq = unwrapData(subqRes.json, ['compound']);

      // Must succeed (201) — NOT return 409 — because section & route differ
      const topicalRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'GHK-Cu 2% Serum',
          canonicalMolecule: 'ghk-cu',
          aliases: ['GHK-Cu Topical Serum'],
          sectionId: 'dermatology',
          subsection: 'Peptide Serums',
          tags: ['dermatology', 'peptide', 'copper', 'topical', 'serum'],
          relatedCompoundIds: [subq.id],
          timingRules: {
            preferredSlots: ['derm_am', 'derm_pm'],
            avoidSlots: [],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Apply AM or PM away from direct exfoliating acids or retinoids.',
          },
          dosages: {
            rangeText: '2-3 drops AM or PM',
            defaultAmount: 3,
            defaultUnit: 'drops',
            route: 'Topical',
            frequencyText: 'Once daily',
            maxCeiling: 6,
          },
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'serum',
            actives: [{ name: 'GHK-Cu', concentrationPct: 2, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 5,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily tolerance',
            skinCyclingRole: 'recovery',
            pregnancySafety: 'caution',
          },
        })
      );
      assertStatus(topicalRes, [200, 201], 'POST GHK-Cu 2% Serum sibling must not 409');
      const topical = unwrapData(topicalRes.json, ['compound']);
      assert.notEqual(subq.id, topical.id, 'multi-route siblings must have distinct IDs');

      const linkRes = await api.patch(`/api/v1/compounds/${encodeURIComponent(subq.id)}`, {
        relatedCompoundIds: [topical.id],
      });
      assertStatus(linkRes, 200, 'PATCH GHK-Cu SubQ relatedCompoundIds');

      const [reSubqRes, reTopicalRes] = await Promise.all([
        api.get(`/api/v1/compounds/${encodeURIComponent(subq.id)}`),
        api.get(`/api/v1/compounds/${encodeURIComponent(topical.id)}`),
      ]);
      const reSubq = unwrapData(reSubqRes.json, ['compound']);
      const reTopical = unwrapData(reTopicalRes.json, ['compound']);

      assert.equal(reSubq.sectionId, 'peptides');
      assert.equal(reSubq.dosages?.route, 'SubQ');
      assert.equal(reSubq.canonicalMolecule, 'ghk-cu');
      assert.ok(reSubq.relatedCompoundIds.includes(topical.id), 'SubQ sibling must link to Topical sibling');

      assert.equal(reTopical.sectionId, 'dermatology');
      assert.equal(reTopical.dosages?.route, 'Topical');
      assert.equal(reTopical.canonicalMolecule, 'ghk-cu');
      assert.ok(reTopical.relatedCompoundIds.includes(subq.id), 'Topical sibling must link to SubQ sibling');
    });
  });

  it('T1-B10 (F8, F18, F19): POST /api/v1/compounds/:id/verify promotes ai_draft to verified while preserving profile data and updating status filters', async () => {
    await withServer(async ({ api }) => {
      const payload = fixtures.makePeptideCompound({
        name: 'Epitalon Research Draft',
        canonicalMolecule: 'epitalon-ref',
        aliases: ['Epithalon'],
        profileStatus: 'ai_draft',
        provenance: {
          sourceModel: 'ai:gemini',
          researchedAt: '2026-11-01T10:00:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [
            {
              title: 'Tetrapeptide Epitalon Preclinical Literature Summary',
              url: 'https://pubmed.ncbi.nlm.nih.gov/29000001/',
              pmid: '29000001',
            },
          ],
        },
      });

      const createRes = await api.post('/api/v1/compounds', payload);
      assertStatus(createRes, [200, 201], 'POST ai_draft compound');
      const draft = unwrapData(createRes.json, ['compound']);

      const preVerify = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(draft.id)}`)).json,
        ['compound']
      );
      assert.equal(preVerify.profileStatus, 'ai_draft');

      const verifyRes = await api.post(`/api/v1/compounds/${encodeURIComponent(draft.id)}/verify`, {});
      assertStatus(verifyRes, 200, 'POST /api/v1/compounds/:id/verify');

      const postVerify = unwrapData(
        (await api.get(`/api/v1/compounds/${encodeURIComponent(draft.id)}`)).json,
        ['compound']
      );
      assert.equal(postVerify.profileStatus, 'verified');
      assert.equal(typeof postVerify.updatedAt, 'string');
      assert.equal(postVerify.summary, payload.summary, 'summary must be preserved after verify');
      assert.equal(postVerify.dosages?.defaultAmount, payload.dosages.defaultAmount);
      assert.equal(postVerify.provenance?.citations?.[0]?.pmid, '29000001');

      const verifiedList = unwrapData(
        (await api.get('/api/v1/compounds', { query: { status: 'verified' } })).json,
        ['compounds', 'items']
      );
      const draftList = unwrapData(
        (await api.get('/api/v1/compounds', { query: { status: 'ai_draft' } })).json,
        ['compounds', 'items']
      );
      assert.ok(verifiedList.some((c) => c.id === draft.id), 'verified compound must appear under ?status=verified');
      assert.ok(!draftList.some((c) => c.id === draft.id), 'verified compound must leave ?status=ai_draft');
    });
  });

  it('T1-B11 (F16, F20): POST /api/v1/compounds/check-duplicate detects exact normalized name, alias match (Oxandrolone <-> Anavar), same-molecule-other-route, and novel compounds', async () => {
    await withServer(async ({ api }) => {
      const oxRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          name: 'Oxandrolone',
          canonicalMolecule: 'oxandrolone',
          aliases: ['Anavar', 'Var'],
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
            rangeText: '5-20 mg/day oral reference',
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
        })
      );
      assertStatus(oxRes, [200, 201], 'seed Oxandrolone');
      const ox = unwrapData(oxRes.json, ['compound']);

      const finOralRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          name: 'Finasteride Oral',
          canonicalMolecule: 'finasteride',
          aliases: ['Propecia', 'Proscar'],
          sectionId: 'peds',
          subsection: 'Ancillaries & Support',
          tags: ['ped', '5ar_inhibitor', 'teratogen'],
          halfLife: {
            valueHours: 6,
            minHours: 5,
            maxHours: 8,
            displayText: '~6 hours plasma (longer tissue 5-alpha-reductase binding)',
            route: 'Oral',
            kind: 'elimination',
            effectDurationNote: 'Tissue DHT suppression persists for days after plasma clearance.',
            sourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/',
          },
          dosages: {
            rangeText: '1 mg daily oral',
            defaultAmount: 1,
            defaultUnit: 'mg',
            route: 'Oral',
            frequencyText: 'Once daily',
            maxCeiling: 5,
          },
          sectionData: {
            compoundClass: '5-Alpha-Reductase Inhibitor (Ancillary)',
            ester: null,
            esterHalfLifeDays: null,
            oilPreMixed: false,
            concentrationMgPerMl: null,
            vialMl: null,
            aromatizes: false,
            progestogenic: false,
            dhtDerived: false,
            c17AlphaAlkylated: false,
            hepatotoxicityRisk: 'low',
            hpgSuppression: 'none',
            requiresTestosteroneBase: false,
            pctRequired: false,
            femaleVirilizationRisk: 'none',
            teratogenicityRisk: 'high',
            mandatoryLabs: ['DHT', 'PSA'],
          },
        })
      );
      assertStatus(finOralRes, [200, 201], 'seed Finasteride Oral');
      const finOral = unwrapData(finOralRes.json, ['compound']);

      // 1. Exact normalized name match
      const exactRes = await api.post('/api/v1/compounds/check-duplicate', {
        name: '  oxandrolone ',
        sectionId: 'peds',
        route: 'Oral',
      });
      assertStatus(exactRes, 200, 'check-duplicate exact normalized name');
      const exactInfo = analyzeDupCheck(exactRes.json);
      assert.equal(exactInfo.isDuplicate, true, `expected exact match to flag duplicate, got: ${exactRes.text}`);
      assert.ok(
        exactInfo.matchedIds.includes(ox.id),
        `expected exact match to reference Oxandrolone id ${ox.id}, got ${JSON.stringify(exactInfo.matchedIds)}`
      );

      // 2. Alias match (Anavar -> Oxandrolone)
      const aliasRes = await api.post('/api/v1/compounds/check-duplicate', {
        name: 'Anavar',
        sectionId: 'peds',
        route: 'Oral',
      });
      assertStatus(aliasRes, 200, 'check-duplicate alias match');
      const aliasInfo = analyzeDupCheck(aliasRes.json);
      assert.equal(aliasInfo.isDuplicate, true, `expected Anavar alias to flag duplicate, got: ${aliasRes.text}`);
      assert.ok(
        aliasInfo.matchedIds.includes(ox.id),
        `expected Anavar alias match to reference Oxandrolone id ${ox.id}, got ${JSON.stringify(aliasInfo.matchedIds)}`
      );

      // 3. Same-molecule-other-route distinction (Finasteride Topical vs Oral)
      const otherRouteRes = await api.post('/api/v1/compounds/check-duplicate', {
        name: 'Finasteride 0.1% Topical Solution',
        canonicalMolecule: 'finasteride',
        sectionId: 'dermatology',
        route: 'Topical',
      });
      assertStatus(otherRouteRes, 200, 'check-duplicate same-molecule-other-route');
      const otherRouteInfo = analyzeDupCheck(otherRouteRes.json);
      assert.equal(
        otherRouteInfo.isDuplicate,
        false,
        `same-molecule-other-route must NOT flag blocking duplicate, got: ${otherRouteRes.text}`
      );
      assert.ok(
        otherRouteInfo.relatedVariantIds.includes(finOral.id),
        `expected same-molecule-other-route to identify Finasteride Oral id ${finOral.id}, got: ${otherRouteRes.text}`
      );

      // Confirm creating the Topical sibling succeeds (201)
      const createTopicalFin = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Finasteride 0.1% Topical Solution',
          canonicalMolecule: 'finasteride',
          aliases: ['Topical Finasteride'],
          sectionId: 'dermatology',
          subsection: 'Scalp & Hair Growth',
          tags: ['dermatology', 'scalp_hair', '5ar_inhibitor', 'teratogen'],
          timingRules: {
            preferredSlots: ['derm_pm'],
            avoidSlots: [],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Apply to dry scalp once daily in the evening.',
          },
          dosages: {
            rangeText: '1 mL scalp daily',
            defaultAmount: 1,
            defaultUnit: 'mL',
            route: 'Topical',
            frequencyText: 'Once daily',
            maxCeiling: 2,
          },
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'solution',
            actives: [{ name: 'Finasteride', concentrationPct: 0.1 }],
            layeringStep: 2,
            waitTimeMinutes: 5,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily application',
            skinCyclingRole: 'none',
            pregnancySafety: 'avoid',
          },
        })
      );
      assertStatus(createTopicalFin, [200, 201], 'create Finasteride Topical sibling');

      // 4. Novel compound returns non-duplicate with zero matches
      const novelRes = await api.post('/api/v1/compounds/check-duplicate', {
        name: 'Completely Novel Unlisted Compound X99',
        sectionId: 'vitamins_supplements',
        route: 'Oral',
      });
      assertStatus(novelRes, 200, 'check-duplicate novel compound');
      const novelInfo = analyzeDupCheck(novelRes.json);
      assert.equal(novelInfo.isDuplicate, false, 'novel compound must not be flagged duplicate');
      assert.equal(novelInfo.matchedIds.length, 0, 'novel compound must have zero duplicate matches');
      assert.equal(novelInfo.relatedVariantIds.length, 0, 'novel compound must have zero related matches');
    });
  });

  it('T1-B12 (F40): Unified full-text search (?q=) matches across aliases, mechanismOfAction, useCaseScenarios, notes, and summary', async () => {
    await withServer(async ({ api }) => {
      const aRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Ergothioneine Search Target A',
          canonicalMolecule: 'ergothioneine-search-a',
          aliases: ['L-Ergothioneine-Alias-77'],
          mechanismOfAction: 'Selective OCTN1 uptake modulating mTORC1_sentinel_pathway redox balance.',
          tags: ['supplement', 'antioxidant_probe'],
        })
      );
      assertStatus(aRes, [200, 201], 'create Search Target A');
      const cmpA = unwrapData(aRes.json, ['compound']);

      const bRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Recovery Peptide Search Target B',
          canonicalMolecule: 'recovery-pep-search-b',
          aliases: ['RPSB-2'],
          useCaseScenarios: ['Controlled tendon_remodeling_probe reference scenario'],
          notes: 'Always apply reconstitute_cold_probe handling.',
        })
      );
      assertStatus(bRes, [200, 201], 'create Search Target B');
      const cmpB = unwrapData(bRes.json, ['compound']);

      const cRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Exfoliant Serum Search Target C',
          canonicalMolecule: 'exfoliant-search-c',
          aliases: ['ESSC-3'],
          summary: 'Leave-on acid formulated for keratolytic_surface_probe refinement.',
        })
      );
      assertStatus(cRes, [200, 201], 'create Search Target C');
      const cmpC = unwrapData(cRes.json, ['compound']);

      const queries = [
        ['alias match', 'L-Ergothioneine-Alias-77', cmpA.id],
        ['mechanismOfAction match', 'mTORC1_sentinel_pathway', cmpA.id],
        ['useCaseScenarios match', 'tendon_remodeling_probe', cmpB.id],
        ['notes match', 'reconstitute_cold_probe', cmpB.id],
        ['summary match', 'keratolytic_surface_probe', cmpC.id],
      ];

      for (const [label, q, expectedId] of queries) {
        const res = await api.get('/api/v1/compounds', { query: { q } });
        assertStatus(res, 200, `GET /api/v1/compounds?q=${q} (${label})`);
        const hits = unwrapData(res.json, ['compounds', 'items']);
        assert.ok(Array.isArray(hits), `${label}: response must be an array`);
        assert.equal(
          hits.length,
          1,
          `${label}: expected exactly 1 hit for "${q}", got ${hits.length} (${hits.map((h) => h.name).join(', ')})`
        );
        assert.equal(hits[0].id, expectedId, `${label}: matched unexpected compound`);
      }
    });
  });

  it('T1-B13 (F9, F40): Multi-faceted filtering supports section, ownership, member, inStack, status, evidenceTier, route, slot, tag, and combined intersections', async () => {
    await withServer(async ({ api }) => {
      // Compound 1: Dermatology, Topical, derm_pm, verified, established, tag facet_probe_tag, owned 'have', in wife's active stack
      const dermRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Facet Probe Retinoid',
          canonicalMolecule: 'facet-probe-retinoid',
          aliases: ['FPR-1'],
          tags: ['dermatology', 'facet_probe_tag'],
          profileStatus: 'verified',
          provenance: {
            sourceModel: 'manual',
            researchedAt: '2026-11-01T12:00:00.000Z',
            evidenceTier: 'established',
            confidence: 'high',
            citations: [
              { title: 'Facet Derm Citation', url: 'https://pubmed.ncbi.nlm.nih.gov/17515510/' },
            ],
          },
        })
      );
      assertStatus(dermRes, [200, 201], 'create facet derm compound');
      const cDerm = unwrapData(dermRes.json, ['compound']);
      if (cDerm.profileStatus !== 'verified') {
        assertStatus(
          await api.post(`/api/v1/compounds/${encodeURIComponent(cDerm.id)}/verify`, {}),
          200,
          'verify cDerm for verified filter test'
        );
      }

      // Compound 2: Peptides, SubQ, waking_fasted, ai_draft, working_hypothesis, owned 'wishlist', NOT in stack
      const pepRes = await api.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Facet Probe Peptide',
          canonicalMolecule: 'facet-probe-peptide',
          aliases: ['FPP-2'],
          tags: ['peptide', 'other_probe_tag'],
          profileStatus: 'ai_draft',
          provenance: {
            sourceModel: 'ai:claude',
            researchedAt: '2026-11-01T12:00:00.000Z',
            evidenceTier: 'working_hypothesis',
            confidence: 'medium',
            citations: [
              { title: 'Facet Peptide Citation', url: 'https://pubmed.ncbi.nlm.nih.gov/36137574/' },
            ],
          },
        })
      );
      assertStatus(pepRes, [200, 201], 'create facet peptide compound');
      const cPep = unwrapData(pepRes.json, ['compound']);

      // Compound 3: Supplements, Oral, evening_dinner, verified, speculation, owned 'dont_have', NOT in stack
      const suppRes = await api.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Facet Probe Supplement',
          canonicalMolecule: 'facet-probe-supplement',
          aliases: ['FPS-3'],
          tags: ['supplement'],
          profileStatus: 'verified',
          provenance: {
            sourceModel: 'manual',
            researchedAt: '2026-11-01T12:00:00.000Z',
            evidenceTier: 'speculation',
            confidence: 'low',
            citations: [],
          },
        })
      );
      assertStatus(suppRes, [200, 201], 'create facet supplement compound');
      const cSupp = unwrapData(suppRes.json, ['compound']);
      if (cSupp.profileStatus !== 'verified') {
        assertStatus(
          await api.post(`/api/v1/compounds/${encodeURIComponent(cSupp.id)}/verify`, {}),
          200,
          'verify cSupp for verified filter test'
        );
      }

      // Set ownership statuses
      assertStatus(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cDerm.id)}`, {
          scope: 'household',
          status: 'have',
          quantity: 1,
          remainingDoses: 30,
        }),
        [200, 201],
        'set cDerm household ownership=have'
      );
      assertStatus(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cDerm.id)}`, {
          scope: 'member:member_wife',
          status: 'have',
          quantity: 1,
          remainingDoses: 30,
        }),
        [200, 201],
        'set cDerm wife ownership=have'
      );
      assertStatus(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cPep.id)}`, {
          scope: 'household',
          status: 'wishlist',
        }),
        [200, 201],
        'set cPep household ownership=wishlist'
      );
      assertStatus(
        await api.put(`/api/v1/ownership/${encodeURIComponent(cSupp.id)}`, {
          scope: 'household',
          status: 'dont_have',
        }),
        [200, 201],
        'set cSupp household ownership=dont_have'
      );

      // Put cDerm in member_wife's active stack
      assertStatus(
        await api.post(
          '/api/v1/members/member_wife/stacks',
          fixtures.makeStackPayload({
            name: 'Facet Wife Active Stack',
            memberId: 'member_wife',
            active: true,
            items: [
              fixtures.makeStackItem({
                compoundId: cDerm.id,
                doseAmount: 1,
                doseUnit: 'pea_size',
                frequency: 'daily',
              }),
            ],
          })
        ),
        [200, 201],
        'create member_wife stack with cDerm'
      );

      const queryList = async (query, label) => {
        const res = await api.get('/api/v1/compounds', { query });
        assertStatus(res, 200, `GET /api/v1/compounds (${label})`);
        const items = unwrapData(res.json, ['compounds', 'items']);
        assert.ok(Array.isArray(items), `${label}: must return array`);
        return items;
      };

      const bySection = await queryList({ section: 'dermatology' }, 'section=dermatology');
      assert.equal(bySection.length, 1);
      assert.equal(bySection[0].id, cDerm.id);

      const byHave = await queryList({ ownership: 'have' }, 'ownership=have');
      assert.ok(byHave.some((c) => c.id === cDerm.id));
      assert.ok(!byHave.some((c) => c.id === cPep.id));
      assert.ok(!byHave.some((c) => c.id === cSupp.id));

      const byWishlist = await queryList({ ownership: 'wishlist' }, 'ownership=wishlist');
      assert.ok(byWishlist.some((c) => c.id === cPep.id));
      assert.ok(!byWishlist.some((c) => c.id === cDerm.id));

      const byMemberHave = await queryList({ member: 'member_wife', ownership: 'have' }, 'member+ownership=have');
      assert.ok(byMemberHave.some((c) => c.id === cDerm.id));
      assert.ok(!byMemberHave.some((c) => c.id === cPep.id));

      const byInStack = await queryList({ member: 'member_wife', inStack: 'true' }, 'member+inStack=true');
      assert.ok(byInStack.some((c) => c.id === cDerm.id));
      assert.ok(!byInStack.some((c) => c.id === cPep.id));
      assert.ok(!byInStack.some((c) => c.id === cSupp.id));

      const byStatus = await queryList({ status: 'verified' }, 'status=verified');
      assert.ok(byStatus.length >= 2);
      assert.ok(byStatus.every((c) => c.profileStatus === 'verified'));
      assert.ok(!byStatus.some((c) => c.id === cPep.id));

      const byTier = await queryList({ evidenceTier: 'established' }, 'evidenceTier=established');
      assert.equal(byTier.length, 1);
      assert.equal(byTier[0].id, cDerm.id);

      const byRoute = await queryList({ route: 'Topical' }, 'route=Topical');
      assert.equal(byRoute.length, 1);
      assert.equal(byRoute[0].id, cDerm.id);

      const bySlot = await queryList({ slot: 'derm_pm' }, 'slot=derm_pm');
      assert.equal(bySlot.length, 1);
      assert.equal(bySlot[0].id, cDerm.id);

      const byTag = await queryList({ tag: 'facet_probe_tag' }, 'tag=facet_probe_tag');
      assert.equal(byTag.length, 1);
      assert.equal(byTag[0].id, cDerm.id);

      // Combined multi-facet intersection
      const combined = await queryList(
        {
          section: 'dermatology',
          route: 'Topical',
          slot: 'derm_pm',
          status: 'verified',
          evidenceTier: 'established',
          tag: 'facet_probe_tag',
          ownership: 'have',
        },
        'multi-facet intersection'
      );
      assert.equal(combined.length, 1, 'combined multi-facet query must return exact single match');
      assert.equal(combined[0].id, cDerm.id);
    });
  });

  it('T1-B14 (F5, F46): Clean-slate default has zero compounds and optional POST /api/v1/seed/starter populates non-personal educational profiles across all 4 core sections', async () => {
    await withServer(async ({ server, api }) => {
      // Clean-slate verification BEFORE seeding
      const preSections = unwrapData((await api.get('/api/v1/sections')).json, ['sections', 'items']);
      for (const coreId of CORE_SECTION_IDS) {
        assert.ok(preSections.some((s) => s.id === coreId), `clean-slate must include core section ${coreId}`);
      }

      const preCompoundsRes = await api.get('/api/v1/compounds');
      assertStatus(preCompoundsRes, 200, 'GET /api/v1/compounds clean-slate');
      const preCompounds = unwrapData(preCompoundsRes.json, ['compounds', 'items']);
      assert.ok(Array.isArray(preCompounds));
      assert.equal(preCompounds.length, 0, 'clean-slate server must start with 0 compounds before seeding');

      // Seed starter catalog
      const seedRes = await api.post('/api/v1/seed/starter', {});
      assertStatus(seedRes, [200, 201], 'POST /api/v1/seed/starter');

      const postCompoundsRes = await api.get('/api/v1/compounds');
      assertStatus(postCompoundsRes, 200, 'GET /api/v1/compounds after starter seed');
      const seeded = unwrapData(postCompoundsRes.json, ['compounds', 'items']);
      assert.ok(Array.isArray(seeded), 'seeded catalog must be an array');
      assert.ok(seeded.length >= 4, `expected at least 4 starter compounds across core sections, got ${seeded.length}`);

      // Every one of the 4 core sections must have >= 1 seeded profile
      for (const coreId of CORE_SECTION_IDS) {
        const countInSection = seeded.filter((c) => c.sectionId === coreId).length;
        assert.ok(countInSection >= 1, `starter catalog must seed >= 1 compound in "${coreId}", got ${countInSection}`);
      }

      // Structural completeness & non-personal integrity
      for (const c of seeded) {
        assert.equal(typeof c.id, 'string');
        assert.ok(c.id.length > 0);
        assert.equal(typeof c.name, 'string');
        assert.ok(c.name.trim().length > 0);
        assert.equal(typeof c.sectionId, 'string');
        assert.equal(typeof c.summary, 'string');
        assert.ok(c.summary.trim().length > 0, `seeded compound "${c.name}" must have non-empty summary`);
        assert.ok(isPlainObject(c.dosages), `seeded compound "${c.name}" must have dosages object`);
        assert.ok(isPlainObject(c.halfLife), `seeded compound "${c.name}" must have halfLife object`);
        assert.ok(isPlainObject(c.timingRules), `seeded compound "${c.name}" must have timingRules object`);
        assert.ok(isPlainObject(c.provenance), `seeded compound "${c.name}" must have provenance object`);
        assert.ok(
          typeof c.completenessPct === 'number' && c.completenessPct > 0,
          `seeded compound "${c.name}" must have completenessPct > 0`
        );
      }

      assert.ok(!postCompoundsRes.text.includes(server.adminToken), 'starter catalog must not contain adminToken');
      assert.ok(!postCompoundsRes.text.includes(server.passcode), 'starter catalog must not contain passcode');
      assert.doesNotMatch(
        postCompoundsRes.text,
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
        'starter catalog must not contain hardcoded personal email addresses'
      );
    });
  });
});
