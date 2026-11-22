/**
 * Tier 2 E2E Suite — Area D: Stack Builder, Interaction Matrix & Dual-Track
 * Smart Spreader Boundary, Corner-Case, Negative & Safety Invariant Tests
 * (F15, F16, F30–F37).
 *
 * Strictly opaque-box: imports ONLY from ../harness.mjs and Node built-ins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  unwrapData,
  fixtures,
} from '../harness.mjs';

async function withServer(fn, options = {}) {
  const server = await startE2EServer(options);
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

function assertNoStore(res, label) {
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  assert.ok(
    cc.includes('no-store'),
    `${label}: expected Cache-Control to include "no-store", got "${cc}"`,
  );
}

async function createCompound(api, payload) {
  const res = await api.post('/api/v1/compounds', payload);
  assert.ok(
    res.status === 201 || res.status === 200,
    `POST /api/v1/compounds (${payload.name}) expected 200/201, got ${res.status}: ${res.text}`,
  );
  assertNoStore(res, `POST /api/v1/compounds (${payload.name})`);
  const compound = unwrapData(res.json, ['compound']);
  assert.ok(
    compound && typeof compound.id === 'string' && compound.id.length > 0,
    `Created compound (${payload.name}) must have non-empty id: ${res.text}`,
  );
  return compound;
}

async function setOwnership(api, compoundId, ownershipBody) {
  const res = await api.put(
    `/api/v1/ownership/${encodeURIComponent(compoundId)}`,
    ownershipBody,
  );
  assert.ok(
    res.status === 200 || res.status === 201,
    `PUT /api/v1/ownership/${compoundId} expected 200/201, got ${res.status}: ${res.text}`,
  );
  return unwrapData(res.json, ['ownership']);
}

async function createStack(api, memberId, stackPayload) {
  const res = await api.post(
    `/api/v1/members/${encodeURIComponent(memberId)}/stacks`,
    stackPayload,
  );
  assert.ok(
    res.status === 201 || res.status === 200,
    `POST /api/v1/members/${memberId}/stacks expected 200/201, got ${res.status}: ${res.text}`,
  );
  const stack = unwrapData(res.json, ['stack']);
  assert.ok(stack && typeof stack.id === 'string' && stack.id.length > 0);
  return stack;
}

async function computeSchedule(api, memberId, stackId, body = {}, opts = {}) {
  const res = await api.post(
    `/api/v1/members/${encodeURIComponent(memberId)}/stacks/${encodeURIComponent(stackId)}/schedule`,
    body,
    opts,
  );
  assert.equal(
    res.status,
    200,
    `POST .../schedule expected 200, got ${res.status}: ${res.text}`,
  );
  assertNoStore(res, 'POST .../schedule');
  return unwrapData(res.json, ['schedule', 'spread']);
}

async function computeInteractions(api, memberId, stackId, body = {}) {
  const res = await api.post(
    `/api/v1/members/${encodeURIComponent(memberId)}/stacks/${encodeURIComponent(stackId)}/interactions`,
    body,
  );
  assert.equal(
    res.status,
    200,
    `POST .../interactions expected 200, got ${res.status}: ${res.text}`,
  );
  assertNoStore(res, 'POST .../interactions');
  return unwrapData(res.json, ['interactions', 'analysis']);
}

function findSystemicPlacement(spread, compoundId) {
  for (const slot of spread.systemic.slots) {
    const found = (slot.items || []).find((i) => i.compoundId === compoundId);
    if (found) return { slot, item: found };
  }
  return null;
}

function listSlotSystemicCompoundIds(spread) {
  return new Set(
    (spread.systemic.slots || []).flatMap((slot) => (slot.items || []).map((i) => i.compoundId)),
  );
}

function listWeeklyGridDayCompoundIds(spread, dayKey) {
  const entries = spread.systemic.weeklyGrid?.[String(dayKey)] || [];
  return new Set(
    entries
      .map((entry) => (typeof entry === 'string' ? entry : entry?.compoundId))
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
}

function listAllSystemicCompoundIds(spread) {
  const ids = listSlotSystemicCompoundIds(spread);
  for (const entries of Object.values(spread.systemic.weeklyGrid || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = typeof entry === 'string' ? entry : entry?.compoundId;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

function listAllDermCompoundIds(spread) {
  const skin = spread.dermatology?.skin || {};
  const hair = spread.dermatology?.hairScalp || {};
  return new Set([
    ...(skin.am || []).map((s) => s.compoundId),
    ...(skin.pmNights || []).flatMap((n) => (n.steps || []).map((s) => s.compoundId)),
    ...(hair.am || []).map((s) => s.compoundId),
    ...(hair.pm || []).map((s) => s.compoundId),
    ...(hair.weekly || []).map((s) => s.compoundId),
  ]);
}

function entryMatchesAny(entry, needles) {
  const text = JSON.stringify(entry).toLowerCase();
  return needles.some((n) => text.includes(String(n).toLowerCase()));
}

function entryMatchesAll(entry, needleGroups) {
  return needleGroups.every((group) =>
    entryMatchesAny(entry, Array.isArray(group) ? group : [group]),
  );
}

function extractCyclePhaseText(cycleStatus) {
  if (!cycleStatus || typeof cycleStatus !== 'object') return '';
  return [
    cycleStatus.status,
    cycleStatus.phase,
    cycleStatus.state,
    cycleStatus.code,
    cycleStatus.label,
  ]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .join(' ');
}

function extractMintedKeySecret(rawJson, unwrapped) {
  const sources = [rawJson, rawJson?.data, rawJson?.data?.key, unwrapped].filter(
    (s) => s && typeof s === 'object',
  );
  const idVal = unwrapped?.id ?? rawJson?.id ?? rawJson?.key?.id ?? rawJson?.data?.id ?? null;
  for (const src of sources) {
    for (const field of ['secret', 'rawKey', 'plainKey', 'rawSecret', 'token', 'apiKey', 'key']) {
      const val = src[field];
      if (typeof val === 'string' && val.length >= 16 && val !== idVal) {
        return val;
      }
    }
  }
  return null;
}

describe('Tier 2 — Area D: Stack Spreader Boundaries, Edge Cases & Harm-Reduction Invariants', () => {
  it('T1: Hard-stop detection (IGF-1 LR3+Dihexa, duplicate GLP-1, dual 17aa oral AAS) always surfaced & never silently removed', async () => {
    await withServer(async ({ api }) => {
      // Leave doNotPairWith empty to verify the curated global pharmacology interaction bank catches all 3 hazards
      const igf1 = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'IGF-1 LR3',
          canonicalMolecule: 'igf-1-lr3',
          aliases: ['Long R3 IGF-1'],
          tags: ['peptide', 'growth_factor', 'igf1', 'oncogenic_growth_factors'],
          timingRules: { preferredSlots: ['pre_workout', 'morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Growth factor reference' },
          dosages: { defaultAmount: 40, defaultUnit: 'mcg', route: 'SubQ', maxCeiling: 100 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const dihexa = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Dihexa',
          canonicalMolecule: 'dihexa',
          aliases: ['PNB-0408'],
          tags: ['peptide', 'growth_factor', 'hgf_mimetic', 'oncogenic_growth_factors'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'stimulating', timingNotes: 'HGF mimetic reference' },
          dosages: { defaultAmount: 10, defaultUnit: 'mg', route: 'Oral', maxCeiling: 30 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const retatrutide = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Retatrutide',
          canonicalMolecule: 'retatrutide',
          aliases: ['LY3437943'],
          tags: ['peptide', 'glp1', 'incretin', 'triple_agonist'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Weekly GLP-1/GIP/GCG' },
          dosages: { defaultAmount: 2, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 12 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const tirzepatide = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Tirzepatide',
          canonicalMolecule: 'tirzepatide',
          aliases: ['LY3298176'],
          tags: ['peptide', 'glp1', 'incretin', 'dual_agonist'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Weekly GLP-1/GIP' },
          dosages: { defaultAmount: 2.5, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 15 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const oxandrolone = await createCompound(
        api,
        fixtures.makePedCompound({
          name: 'Oxandrolone',
          canonicalMolecule: 'oxandrolone',
          aliases: ['Anavar'],
          tags: ['ped', 'aas', '17aa_oral', 'hepatotoxic'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Oral AAS' },
          dosages: { defaultAmount: 20, defaultUnit: 'mg', route: 'Oral', maxCeiling: 50 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            compoundClass: 'Oral 17aa AAS',
            ester: null,
            oilPreMixed: false,
            c17AlphaAlkylated: true,
            hepatotoxicityRisk: 'moderate',
            femaleVirilizationRisk: 'moderate',
            teratogenicityRisk: 'high',
          },
        }),
      );

      const stanozolol = await createCompound(
        api,
        fixtures.makePedCompound({
          name: 'Stanozolol',
          canonicalMolecule: 'stanozolol',
          aliases: ['Winstrol'],
          tags: ['ped', 'aas', '17aa_oral', 'hepatotoxic'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Oral AAS' },
          dosages: { defaultAmount: 25, defaultUnit: 'mg', route: 'Oral', maxCeiling: 50 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            compoundClass: 'Oral 17aa AAS',
            ester: null,
            oilPreMixed: false,
            c17AlphaAlkylated: true,
            hepatotoxicityRisk: 'high',
            femaleVirilizationRisk: 'high',
            teratogenicityRisk: 'high',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Triple Hard-Stop Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: igf1.id, doseAmount: 40, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: dihexa.id, doseAmount: 10, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: retatrutide.id, doseAmount: 2, doseUnit: 'mg', frequency: 'weekly', cadence: { type: 'weekly', daysOfWeek: [1] } }),
            fixtures.makeStackItem({ compoundId: tirzepatide.id, doseAmount: 2.5, doseUnit: 'mg', frequency: 'weekly', cadence: { type: 'weekly', daysOfWeek: [4] } }),
            fixtures.makeStackItem({ compoundId: oxandrolone.id, doseAmount: 20, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: stanozolol.id, doseAmount: 25, doseUnit: 'mg' }),
          ],
        }),
      );

      const analysis = await computeInteractions(api, 'member_husband', stack.id);
      const spread = await computeSchedule(api, 'member_husband', stack.id, { dateKey: '2026-10-19' });

      for (const [label, hardStops] of [
        ['InteractionAnalysis.hardStops', analysis.hardStops],
        ['SpreadResult.interactions.hardStops', spread.interactions.hardStops],
      ]) {
        assert.ok(
          Array.isArray(hardStops) && hardStops.length >= 3,
          `${label} must surface all 3 hard-stop pairs, got: ${JSON.stringify(hardStops)}`,
        );
        assert.ok(
          hardStops.some((e) => entryMatchesAll(e, [['igf', igf1.id], ['dihexa', dihexa.id]])),
          `${label} must flag IGF-1 LR3 + Dihexa: ${JSON.stringify(hardStops)}`,
        );
        assert.ok(
          hardStops.some((e) =>
            entryMatchesAny(e, ['glp', 'incretin']) ||
            entryMatchesAll(e, [['retatrutide', retatrutide.id], ['tirzepatide', tirzepatide.id]]),
          ),
          `${label} must flag duplicate GLP-1 (Retatrutide + Tirzepatide): ${JSON.stringify(hardStops)}`,
        );
        assert.ok(
          hardStops.some((e) =>
            entryMatchesAny(e, ['17aa', '17-alpha', '17α', 'hepatotox']) ||
            entryMatchesAll(e, [['oxandrolone', oxandrolone.id], ['stanozolol', stanozolol.id]]),
          ),
          `${label} must flag dual 17aa oral AAS (Oxandrolone + Stanozolol): ${JSON.stringify(hardStops)}`,
        );
      }

      // Harm-reduction invariant: hard-stop items MUST NEVER be silently removed from the schedule.
      // Monday-active compounds must remain in Monday's systemic.slots; Thursday-only tirzepatide
      // must remain in systemic.slots OR weeklyGrid["4"] (allowing valid day-filtered slots).
      const mondaySlotIds = listSlotSystemicCompoundIds(spread);
      for (const cmp of [igf1, dihexa, retatrutide, oxandrolone, stanozolol]) {
        assert.ok(
          mondaySlotIds.has(cmp.id),
          `Hard-stop compound ${cmp.name} must NOT be silently deleted from Monday systemic.slots`,
        );
      }
      const thursdayGridIds = listWeeklyGridDayCompoundIds(spread, 4);
      assert.ok(
        mondaySlotIds.has(tirzepatide.id) || thursdayGridIds.has(tirzepatide.id),
        `Thursday-only hard-stop compound ${tirzepatide.name} must NOT be silently deleted from systemic.slots or weeklyGrid["4"]`,
      );
    });
  });

  it('T2: Member safetyContext.activeRxMeds hard-stop (9-Me-BC + Sertraline SSRI AND Tadalafil + Nitrates)', async () => {
    await withServer(async ({ api }) => {
      const patchMember = await api.patch('/api/v1/members/member_husband', {
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'male',
          allergies: [],
          activeRxMeds: ['Sertraline', 'Nitroglycerin', 'Nitrates'],
          conditions: [],
        },
      });
      assert.equal(patchMember.status, 200, `PATCH activeRxMeds failed: ${patchMember.text}`);

      const nineMeBc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: '9-Me-BC',
          canonicalMolecule: '9-me-bc',
          aliases: ['9-Methyl-beta-carboline'],
          tags: ['nootropic', 'maoi', 'ssri_caution'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: ['bedtime_fasted'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'stimulating', timingNotes: 'Morning research nootropic' },
          dosages: { defaultAmount: 15, defaultUnit: 'mg', route: 'Oral', maxCeiling: 30 },
          doNotPairWith: [
            {
              targetType: 'rx_med',
              targetRef: 'ssri',
              severity: 'hard_stop',
              mechanism: 'MAO-A/B inhibition combined with SSRI risks severe serotonin syndrome.',
              recommendation: 'Do not combine 9-Me-BC with SSRIs such as Sertraline.',
            },
          ],
          synergies: [],
        }),
      );

      const tadalafil = await createCompound(
        api,
        fixtures.makePedCompound({
          name: 'Tadalafil',
          canonicalMolecule: 'tadalafil',
          aliases: ['Cialis'],
          tags: ['ped', 'pde5_inhibitor', 'vasodilator'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Daily low-dose PDE5i' },
          dosages: { defaultAmount: 5, defaultUnit: 'mg', route: 'Oral', maxCeiling: 20 },
          doNotPairWith: [
            {
              targetType: 'rx_med',
              targetRef: 'nitrates',
              severity: 'hard_stop',
              mechanism: 'Synergistic NO/cGMP vasodilation can cause fatal hypotension.',
              recommendation: 'Strictly contraindicated with organic nitrates (Nitroglycerin/isosorbide).',
            },
          ],
          synergies: [],
          sectionData: {
            compoundClass: 'PDE5 Inhibitor',
            ester: null,
            oilPreMixed: false,
            c17AlphaAlkylated: false,
            hepatotoxicityRisk: 'low',
            femaleVirilizationRisk: 'none',
            teratogenicityRisk: 'low',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Active Rx Med Hard-Stop Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: nineMeBc.id, doseAmount: 15, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: tadalafil.id, doseAmount: 5, doseUnit: 'mg' }),
          ],
        }),
      );

      const analysis = await computeInteractions(api, 'member_husband', stack.id);
      const spread = await computeSchedule(api, 'member_husband', stack.id, { dateKey: '2026-10-19' });

      const allAlertsAnalysis = [...(analysis.hardStops || []), ...(analysis.safetyAlerts || [])];
      const allAlertsSpread = [
        ...(spread.interactions.hardStops || []),
        ...(spread.interactions.safetyAlerts || []),
      ];

      assert.ok(
        Array.isArray(analysis.hardStops) && analysis.hardStops.length >= 2,
        `Expected >= 2 Rx-med hardStops in analysis, got: ${JSON.stringify(analysis)}`,
      );
      assert.ok(
        allAlertsAnalysis.some((e) =>
          entryMatchesAll(e, [['9-me-bc', '9mebc', nineMeBc.id], ['sertraline', 'ssri', 'serotonin', 'maoi']]),
        ),
        `Must flag 9-Me-BC + Sertraline/SSRI hard-stop: ${JSON.stringify(allAlertsAnalysis)}`,
      );
      assert.ok(
        allAlertsAnalysis.some((e) =>
          entryMatchesAll(e, [['tadalafil', tadalafil.id], ['nitrate', 'nitroglycerin', 'hypotension']]),
        ),
        `Must flag Tadalafil + Nitrates hard-stop: ${JSON.stringify(allAlertsAnalysis)}`,
      );
      assert.ok(
        allAlertsSpread.some((e) =>
          entryMatchesAny(e, ['9-me-bc', '9mebc', 'sertraline', 'ssri', 'maoi', nineMeBc.id]),
        ),
        `SpreadResult.interactions must flag 9-Me-BC + Sertraline/SSRI hard-stop: ${JSON.stringify(spread.interactions)}`,
      );
      assert.ok(
        allAlertsSpread.some((e) =>
          entryMatchesAny(e, ['tadalafil', 'nitrate', 'nitroglycerin', 'hypotension', tadalafil.id]),
        ),
        `SpreadResult.interactions must flag Tadalafil + Nitrates hard-stop: ${JSON.stringify(spread.interactions)}`,
      );

      const scheduledIds = listSlotSystemicCompoundIds(spread);
      assert.ok(scheduledIds.has(nineMeBc.id), '9-Me-BC must remain visible in schedule with alert');
      assert.ok(scheduledIds.has(tadalafil.id), 'Tadalafil must remain visible in schedule with alert');
    });
  });

  it('T3: Member safetyContext.pregnancyOrTrying=true triggers non-hidden teratogen hard-stops (Tretinoin, Finasteride, AAS)', async () => {
    await withServer(async ({ api }) => {
      const patchWife = await api.patch('/api/v1/members/member_wife', {
        safetyContext: {
          pregnancyOrTrying: true,
          biologicalSexContext: 'female',
          allergies: [],
          activeRxMeds: [],
          conditions: [],
        },
      });
      assert.equal(patchWife.status, 200, `PATCH member_wife failed: ${patchWife.text}`);

      const tretinoin = await createCompound(api, fixtures.makeDermCompound());
      const finasteride = await createCompound(
        api,
        fixtures.makePedCompound({
          name: 'Finasteride 1mg',
          canonicalMolecule: 'finasteride',
          aliases: ['Propecia'],
          tags: ['ped', '5ar_inhibitor', 'teratogen'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Oral 5-AR inhibitor' },
          dosages: { defaultAmount: 1, defaultUnit: 'mg', route: 'Oral', maxCeiling: 5 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'pregnancy',
              severity: 'hard_stop',
              mechanism: '5-alpha-reductase inhibition causes severe teratogenicity.',
              recommendation: 'Strictly contraindicated during pregnancy or while trying to conceive.',
            },
          ],
          synergies: [],
          sectionData: {
            compoundClass: '5-Alpha Reductase Inhibitor',
            ester: null,
            oilPreMixed: false,
            c17AlphaAlkylated: false,
            hepatotoxicityRisk: 'low',
            femaleVirilizationRisk: 'none',
            teratogenicityRisk: 'high',
          },
        }),
      );
      const testCyp = await createCompound(api, fixtures.makePedCompound());

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Pregnancy Teratogen Guard Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: tretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
            fixtures.makeStackItem({ compoundId: finasteride.id, doseAmount: 1, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: testCyp.id, doseAmount: 20, doseUnit: 'mg', frequency: '2x_week', cadence: { type: '2x_week', daysOfWeek: [1, 4] } }),
          ],
        }),
      );

      const analysis = await computeInteractions(api, 'member_wife', stack.id);
      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      const alerts = [
        ...(analysis.hardStops || []),
        ...(analysis.safetyAlerts || []),
      ];
      const spreadAlerts = [
        ...(spread.interactions.hardStops || []),
        ...(spread.interactions.safetyAlerts || []),
      ];

      assert.ok(
        (analysis.hardStops || []).length >= 1,
        `Pregnancy teratogens must populate hardStops: ${JSON.stringify(analysis)}`,
      );
      for (const [label, list] of [
        ['InteractionAnalysis', alerts],
        ['SpreadResult.interactions', spreadAlerts],
      ]) {
        assert.ok(
          list.some((e) => entryMatchesAll(e, [['tretinoin', tretinoin.id], ['pregnan', 'teratogen']])),
          `${label} must flag Tretinoin teratogen risk: ${JSON.stringify(list)}`,
        );
        assert.ok(
          list.some((e) => entryMatchesAll(e, [['finasteride', finasteride.id], ['pregnan', 'teratogen']])),
          `${label} must flag Finasteride teratogen risk: ${JSON.stringify(list)}`,
        );
        assert.ok(
          list.some((e) => entryMatchesAll(e, [['testosterone', testCyp.id], ['pregnan', 'teratogen']])),
          `${label} must flag Testosterone Cypionate teratogen risk: ${JSON.stringify(list)}`,
        );
      }

      assert.ok(listAllDermCompoundIds(spread).has(tretinoin.id), 'Tretinoin must not be silently dropped');
      assert.ok(listSlotSystemicCompoundIds(spread).has(finasteride.id), 'Finasteride must not be silently dropped');
      assert.ok(listSlotSystemicCompoundIds(spread).has(testCyp.id), 'Testosterone Cypionate must not be silently dropped');
    });
  });

  it('T4: Female high-virilization warning emitted for biologicalSexContext="female" and absent for "male"', async () => {
    await withServer(async ({ api }) => {
      const patchWife = await api.patch('/api/v1/members/member_wife', {
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'female',
          allergies: [],
          activeRxMeds: [],
          conditions: [],
        },
      });
      assert.equal(patchWife.status, 200, `PATCH member_wife failed: ${patchWife.text}`);

      const patchHusband = await api.patch('/api/v1/members/member_husband', {
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'male',
          allergies: [],
          activeRxMeds: [],
          conditions: [],
        },
      });
      assert.equal(patchHusband.status, 200, `PATCH member_husband failed: ${patchHusband.text}`);

      const testCyp = await createCompound(api, fixtures.makePedCompound());

      const wifeStack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Female Virilization Check',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: testCyp.id, doseAmount: 20, doseUnit: 'mg' })],
        }),
      );
      const husbandStack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Male Control Check',
          memberId: 'member_husband',
          items: [fixtures.makeStackItem({ compoundId: testCyp.id, doseAmount: 60, doseUnit: 'mg' })],
        }),
      );

      const wifeAnalysis = await computeInteractions(api, 'member_wife', wifeStack.id);
      const husbandAnalysis = await computeInteractions(api, 'member_husband', husbandStack.id);

      const wifeAlerts = [
        ...(wifeAnalysis.safetyAlerts || []),
        ...(wifeAnalysis.cautions || []),
        ...(wifeAnalysis.hardStops || []),
      ];
      const husbandAlerts = [
        ...(husbandAnalysis.safetyAlerts || []),
        ...(husbandAnalysis.cautions || []),
        ...(husbandAnalysis.hardStops || []),
      ];

      assert.ok(
        wifeAlerts.some((e) => entryMatchesAny(e, ['viriliz', 'androgen', 'masculiniz'])),
        `Female member selecting high-virilization PED must receive virilization alert: ${JSON.stringify(wifeAlerts)}`,
      );
      assert.ok(
        !husbandAlerts.some((e) => entryMatchesAny(e, ['viriliz'])),
        `Male member must NOT receive female virilization warning: ${JSON.stringify(husbandAlerts)}`,
      );
    });
  });

  it('T5: Adult UL micronutrient summation flags multi-ingredient Zinc > 40 mg and Vitamin D3 > 4,000 IU', async () => {
    await withServer(async ({ api }) => {
      const zincSolo = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Zinc Picolinate 30mg',
          canonicalMolecule: 'zinc',
          aliases: ['Zinc'],
          tags: ['supplement', 'mineral', 'zinc'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning' },
          dosages: { defaultAmount: 30, defaultUnit: 'mg', route: 'Oral', maxCeiling: 40 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Zinc Picolinate',
            elementalWeightMg: 30,
            supplementFacts: [{ nutrient: 'Zinc', amount: 30, unit: 'mg' }],
            adultUpperLimit: { nutrientKey: 'zinc', amount: 40, unit: 'mg', basis: 'total' },
          },
        }),
      );

      const multiVit = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Multi-Ingredient Daily Complex',
          canonicalMolecule: 'daily-multivitamin',
          aliases: ['Multivitamin'],
          tags: ['supplement', 'multivitamin'],
          timingRules: { preferredSlots: ['midday_lunch'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Midday' },
          dosages: { defaultAmount: 2, defaultUnit: 'caps', route: 'Oral', maxCeiling: 4 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Multivitamin Blend',
            supplementFacts: [
              { nutrient: 'Zinc', amount: 25, unit: 'mg' },
              { nutrient: 'Vitamin D3', amount: 2000, unit: 'IU' },
            ],
            adultUpperLimit: null,
          },
        }),
      );

      const vitD3Solo = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3 3000 IU',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_fat', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning with fat' },
          dosages: { defaultAmount: 3000, defaultUnit: 'IU', route: 'Oral', maxCeiling: 10000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Cholecalciferol',
            supplementFacts: [{ nutrient: 'Vitamin D3', amount: 3000, unit: 'IU' }],
            adultUpperLimit: { nutrientKey: 'vitamin_d', amount: 4000, unit: 'IU', basis: 'total' },
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'UL Exceedance Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: zincSolo.id, doseAmount: 30, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: multiVit.id, doseAmount: 2, doseUnit: 'caps' }),
            fixtures.makeStackItem({ compoundId: vitD3Solo.id, doseAmount: 3000, doseUnit: 'IU' }),
          ],
        }),
      );

      const analysis = await computeInteractions(api, 'member_wife', stack.id);
      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      for (const [label, ulWarnings] of [
        ['InteractionAnalysis.ulWarnings', analysis.ulWarnings],
        ['SpreadResult.interactions.ulWarnings', spread.interactions.ulWarnings],
      ]) {
        assert.ok(
          Array.isArray(ulWarnings) && ulWarnings.length >= 2,
          `${label} must flag both Zinc (>40mg) and Vitamin D3 (>4000 IU), got: ${JSON.stringify(ulWarnings)}`,
        );
        assert.ok(
          ulWarnings.some((w) => entryMatchesAny(w, ['zinc'])),
          `${label} must flag cumulative Zinc UL breach (55mg > 40mg): ${JSON.stringify(ulWarnings)}`,
        );
        assert.ok(
          ulWarnings.some((w) => entryMatchesAny(w, ['vitamin_d', 'vitamin d', 'd3'])),
          `${label} must flag cumulative Vitamin D3 UL breach (5000 IU > 4000 IU): ${JSON.stringify(ulWarnings)}`,
        );
      }
    });
  });

  it('T6: Multi-route same-molecule cumulative exposure warning (GHK-Cu SubQ+Topical AND Finasteride Oral+Topical)', async () => {
    await withServer(async ({ api }) => {
      const ghkSubq = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'GHK-Cu Injectable',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Peptide SubQ'],
          tags: ['peptide', 'copper_peptide', 'ghk_cu', 'subq'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'SubQ daily' },
          dosages: { defaultAmount: 1, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 3 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const ghkTopical = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'GHK-Cu 2% Facial Serum',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Peptide Serum'],
          tags: ['dermatology', 'copper_peptide', 'ghk_cu'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Topical PM serum' },
          dosages: { defaultAmount: 3, defaultUnit: 'drops', route: 'Topical', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'serum',
            actives: [{ name: 'GHK-Cu', concentrationPct: 2, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 2,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'PM',
            skinCyclingRole: 'copper_peptide',
            pregnancySafety: 'caution',
          },
        }),
      );

      const finOral = await createCompound(
        api,
        fixtures.makePedCompound({
          name: 'Finasteride Oral',
          canonicalMolecule: 'finasteride',
          aliases: ['Oral Finasteride'],
          tags: ['ped', '5ar_inhibitor'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Oral daily' },
          dosages: { defaultAmount: 1, defaultUnit: 'mg', route: 'Oral', maxCeiling: 5 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            compoundClass: '5-AR Inhibitor',
            ester: null,
            oilPreMixed: false,
            c17AlphaAlkylated: false,
            hepatotoxicityRisk: 'low',
            femaleVirilizationRisk: 'none',
            teratogenicityRisk: 'high',
          },
        }),
      );

      const finTopical = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Finasteride 0.1% Scalp Solution',
          canonicalMolecule: 'finasteride',
          aliases: ['Topical Finasteride'],
          tags: ['dermatology', 'hair', 'scalp', '5ar_inhibitor'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Scalp PM' },
          dosages: { defaultAmount: 1, defaultUnit: 'mL', route: 'Topical', maxCeiling: 2 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'solution',
            actives: [{ name: 'Finasteride', concentrationPct: 0.1, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'PM scalp',
            skinCyclingRole: 'scalp_active',
            pregnancySafety: 'avoid',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Multi-Route Cumulative Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: ghkSubq.id, doseAmount: 1, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: ghkTopical.id, doseAmount: 3, doseUnit: 'drops' }),
            fixtures.makeStackItem({ compoundId: finOral.id, doseAmount: 1, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: finTopical.id, doseAmount: 1, doseUnit: 'mL' }),
          ],
        }),
      );

      const analysis = await computeInteractions(api, 'member_husband', stack.id);
      const spread = await computeSchedule(api, 'member_husband', stack.id, { dateKey: '2026-10-19' });

      const analysisWarnings = [
        ...(analysis.redundancies || []),
        ...(analysis.cautions || []),
        ...(analysis.safetyAlerts || []),
      ];
      const spreadWarnings = [
        ...(spread.interactions.cautions || []),
        ...(spread.interactions.safetyAlerts || []),
        ...(spread.interactions.redundancies || []),
      ];

      assert.ok(
        analysisWarnings.some((w) => entryMatchesAny(w, ['ghk-cu', 'ghk_cu', ghkSubq.id, ghkTopical.id])),
        `Multi-route GHK-Cu cumulative exposure must be warned in InteractionAnalysis: ${JSON.stringify(analysisWarnings)}`,
      );
      assert.ok(
        analysisWarnings.some((w) => entryMatchesAny(w, ['finasteride', finOral.id, finTopical.id])),
        `Multi-route Finasteride cumulative exposure must be warned in InteractionAnalysis: ${JSON.stringify(analysisWarnings)}`,
      );
      assert.ok(
        spreadWarnings.some((w) => entryMatchesAny(w, ['ghk-cu', 'ghk_cu', ghkSubq.id, ghkTopical.id])) &&
          spreadWarnings.some((w) => entryMatchesAny(w, ['finasteride', finOral.id, finTopical.id])),
        `Multi-route cumulative exposure warnings must surface in SpreadResult.interactions: ${JSON.stringify(spreadWarnings)}`,
      );

      // Both tracks remain intact (systemic vs dermatology)
      const systemicIds = listSlotSystemicCompoundIds(spread);
      const dermIds = listAllDermCompoundIds(spread);
      assert.ok(systemicIds.has(ghkSubq.id) && systemicIds.has(finOral.id));
      assert.ok(dermIds.has(ghkTopical.id) && dermIds.has(finTopical.id));
    });
  });

  it('T7: Missing SPF warning emitted when photosensitizing PM active is present with no sunscreen', async () => {
    await withServer(async ({ api }) => {
      const tretinoin = await createCompound(api, fixtures.makeDermCompound());
      const cream = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Simple Barrier Moisturizer',
          canonicalMolecule: 'ceramide-moisturizer',
          aliases: ['Moisturizer'],
          tags: ['dermatology', 'moisturizer'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Daily cream' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'cream',
            actives: [{ name: 'Ceramides', concentrationPct: 1, optimalPh: 5.5 }],
            layeringStep: 5,
            waitTimeMinutes: 0,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily',
            skinCyclingRole: 'recovery',
            pregnancySafety: 'safe',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'No-SPF Photosensitizing Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: tretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
            fixtures.makeStackItem({ compoundId: cream.id, doseAmount: 1, doseUnit: 'pumps' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const spfWarn = spread.dermatology.skin.missingSpfWarning;
      assert.equal(
        typeof spfWarn,
        'string',
        `Expected non-null missingSpfWarning string when SPF is absent, got: ${JSON.stringify(spfWarn)}`,
      );
      assert.match(spfWarn, /spf|sunscreen|uv|photo/i);
    });
  });

  it('T8: Microneedling 12–24h recovery buffer holds irritating actives and populates microneedlingBufferNotes', async () => {
    await withServer(async ({ api }) => {
      const microneedling = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Weekly Microneedling 0.5mm',
          canonicalMolecule: 'microneedling',
          aliases: ['Dermapen'],
          tags: ['dermatology', 'microneedling', 'device'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: ['derm_am'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Weekly PM device session' },
          dosages: { defaultAmount: 1, defaultUnit: 'mL', route: 'Device', frequencyText: 'Once weekly', maxCeiling: 1 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face', 'scalp_hair'],
            vehicleType: 'device',
            actives: [{ name: 'Microneedling 0.5mm', concentrationPct: 0, optimalPh: 7.0 }],
            layeringStep: 1,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: false,
            acclimationRamp: 'Once weekly',
            skinCyclingRole: 'microneedling',
            pregnancySafety: 'caution',
          },
        }),
      );

      const tretinoin = await createCompound(api, fixtures.makeDermCompound());
      const glycolic = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Glycolic Acid 10% Toner',
          canonicalMolecule: 'glycolic-acid',
          aliases: ['AHA'],
          tags: ['dermatology', 'aha', 'aha_bha', 'exfoliant', 'acid', 'photosensitizing', 'pm_only'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: ['derm_am'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'PM acid' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'toner',
            actives: [{ name: 'Glycolic Acid', concentrationPct: 10, optimalPh: 3.5 }],
            layeringStep: 2,
            waitTimeMinutes: 5,
            amPmSuitability: 'pm_only',
            photosensitivity: true,
            leaveOn: true,
            acclimationRamp: '1-2x/week',
            skinCyclingRole: 'exfoliant',
            pregnancySafety: 'caution',
          },
        }),
      );

      const minoxidil = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Topical Minoxidil 5%',
          canonicalMolecule: 'minoxidil',
          aliases: ['Minoxidil'],
          tags: ['dermatology', 'hair', 'scalp', 'minoxidil'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'PM scalp' },
          dosages: { defaultAmount: 1, defaultUnit: 'mL', route: 'Topical', maxCeiling: 2 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'solution',
            actives: [{ name: 'Minoxidil', concentrationPct: 5, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily except microneedling window',
            skinCyclingRole: 'scalp_active',
            pregnancySafety: 'avoid',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Microneedling Buffer Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({
              compoundId: microneedling.id,
              doseAmount: 1,
              doseUnit: 'mL',
              frequency: 'weekly',
              cadence: { type: 'weekly', daysOfWeek: [0] },
            }),
            fixtures.makeStackItem({ compoundId: tretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
            fixtures.makeStackItem({ compoundId: glycolic.id, doseAmount: 4, doseUnit: 'drops' }),
            fixtures.makeStackItem({ compoundId: minoxidil.id, doseAmount: 1, doseUnit: 'mL' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_husband', stack.id, { dateKey: '2026-10-19' });
      const notes = spread.dermatology.skin.microneedlingBufferNotes;

      assert.ok(
        Array.isArray(notes) && notes.length > 0,
        `microneedlingBufferNotes must be non-empty when microneedling is in stack: ${JSON.stringify(spread.dermatology.skin)}`,
      );
      assert.match(
        notes.join(' '),
        /microneedl|12|24|hold|buffer|recover|tretinoin|acid|minoxidil/i,
        `microneedlingBufferNotes must explain holding irritating actives: ${JSON.stringify(notes)}`,
      );

      // Verify microneedling is scheduled in either dermatology.skin.pmNights or dermatology.hairScalp
      const pmNights = spread.dermatology.skin.pmNights || [];
      const hairScalp = spread.dermatology.hairScalp || {};
      const hairItems = [
        ...(hairScalp.weekly || []),
        ...(hairScalp.pm || []),
        ...(hairScalp.am || []),
      ];
      const inSkinPm = pmNights.some((n) =>
        (n.steps || []).some((s) => s.compoundId === microneedling.id),
      );
      const hairMicroneedlingItem = hairItems.find((s) => s.compoundId === microneedling.id);
      assert.ok(
        inSkinPm || Boolean(hairMicroneedlingItem),
        `Microneedling device must appear in dermatology.skin.pmNights or dermatology.hairScalp: ${JSON.stringify(spread.dermatology)}`,
      );

      // Derive microneedling scheduled day(s): skin.pmNights -> hairScalp item -> configured Sunday [0]
      const microneedlingDays = new Set();
      for (const night of pmNights) {
        const stepIds = new Set((night.steps || []).map((s) => s.compoundId));
        if (stepIds.has(microneedling.id) && Array.isArray(night.daysOfWeek)) {
          for (const d of night.daysOfWeek) {
            if (Number.isInteger(d) && d >= 0 && d <= 6) microneedlingDays.add(d);
          }
        }
      }
      if (microneedlingDays.size === 0 && Array.isArray(hairMicroneedlingItem?.daysOfWeek)) {
        for (const d of hairMicroneedlingItem.daysOfWeek) {
          if (Number.isInteger(d) && d >= 0 && d <= 6) microneedlingDays.add(d);
        }
      }
      if (microneedlingDays.size === 0) {
        microneedlingDays.add(0);
      }

      // Ensure NO PM night containing microneedling OR overlapping microneedling's day(s) schedules Tretinoin or Glycolic Acid
      for (const night of pmNights) {
        const ids = new Set((night.steps || []).map((s) => s.compoundId));
        const nightDays = Array.isArray(night.daysOfWeek) ? night.daysOfWeek : [];
        const overlapsMicroneedlingDay = nightDays.some((d) => microneedlingDays.has(d));
        if (ids.has(microneedling.id) || overlapsMicroneedlingDay) {
          assert.ok(
            !ids.has(tretinoin.id) && !ids.has(glycolic.id),
            `PM night "${night.nightLabel}" (days=${JSON.stringify(nightDays)}) overlaps microneedling day(s) ${JSON.stringify([...microneedlingDays])} and must hold Tretinoin and Glycolic Acid: ${JSON.stringify(night)}`,
          );
        }
      }
    });
  });

  it('T9: Conflicting user pin override honors pin (pinned: true) AND emits non-empty pinConflictWarning', async () => {
    await withServer(async ({ api }) => {
      const iron = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Iron Bisglycinate',
          canonicalMolecule: 'iron',
          aliases: ['Iron'],
          tags: ['supplement', 'mineral', 'iron'],
          timingRules: { preferredSlots: ['waking_fasted', 'morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Separate from calcium' },
          dosages: { defaultAmount: 25, defaultUnit: 'mg', route: 'Oral', maxCeiling: 45 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'calcium',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Calcium blocks iron absorption via DMT1 competition.',
              recommendation: 'Separate Iron and Calcium by at least 2 hours.',
            },
          ],
          synergies: [],
          sectionData: { chemicalForm: 'Iron Bisglycinate', supplementFacts: [{ nutrient: 'Iron', amount: 25, unit: 'mg' }], adultUpperLimit: { nutrientKey: 'iron', amount: 45, unit: 'mg', basis: 'total' } },
        }),
      );

      const calcium = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Calcium Citrate',
          canonicalMolecule: 'calcium',
          aliases: ['Calcium'],
          tags: ['supplement', 'mineral', 'calcium'],
          timingRules: { preferredSlots: ['morning_am', 'evening_dinner'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'With meal' },
          dosages: { defaultAmount: 500, defaultUnit: 'mg', route: 'Oral', maxCeiling: 2500 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Calcium Citrate', supplementFacts: [{ nutrient: 'Calcium', amount: 500, unit: 'mg' }], adultUpperLimit: { nutrientKey: 'calcium', amount: 2500, unit: 'mg', basis: 'total' } },
        }),
      );

      // Force both conflicting minerals into morning_am via user pin overrides
      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Conflicting Pin Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: iron.id, doseAmount: 25, doseUnit: 'mg', pinnedSlot: 'morning_am' }),
            fixtures.makeStackItem({ compoundId: calcium.id, doseAmount: 500, doseUnit: 'mg', pinnedSlot: 'morning_am' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const ironPos = findSystemicPlacement(spread, iron.id);
      const calciumPos = findSystemicPlacement(spread, calcium.id);

      assert.ok(ironPos && calciumPos, 'Both pinned items must appear in schedule');
      assert.equal(ironPos.slot.slotId, 'morning_am', 'Iron pin to morning_am must be honored');
      assert.equal(calciumPos.slot.slotId, 'morning_am', 'Calcium pin to morning_am must be honored');
      assert.equal(ironPos.item.pinned, true);
      assert.equal(calciumPos.item.pinned, true);

      const warnings = [ironPos.item.pinConflictWarning, calciumPos.item.pinConflictWarning].filter(
        (w) => typeof w === 'string' && w.trim().length > 0,
      );
      assert.ok(
        warnings.length >= 1,
        `Conflicting pin override must emit non-empty pinConflictWarning on pinned item(s): iron=${JSON.stringify(ironPos.item)}, calcium=${JSON.stringify(calciumPos.item)}`,
      );
      assert.match(warnings.join(' '), /calcium|iron|conflict|separat|pin|hour/i);
    });
  });

  it('T10: Non-workout rest days omit training_days_only items and fall back daily pre_workout items to morning_am', async () => {
    await withServer(async ({ api }) => {
      const patchAnchors = await api.patch('/api/v1/members/member_wife', {
        routineAnchors: {
          wake: '07:00',
          breakfast: '08:00',
          workout: '06:30',
          workoutDays: [1, 2, 3, 4, 5], // Mon–Fri only; Sunday (0) is a rest day
          lunch: '13:00',
          dinner: '19:00',
          bed: '22:30',
          tz: 'UTC',
        },
      });
      assert.equal(patchAnchors.status, 200, `PATCH member_wife routineAnchors failed: ${patchAnchors.text}`);

      const motsc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'MOTS-c Training Only',
          canonicalMolecule: 'mots-c',
          aliases: ['MOTS-c'],
          tags: ['peptide', 'mitochondrial'],
          timingRules: {
            preferredSlots: ['pre_workout'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'training_days_only',
            circadianEffect: 'stimulating',
            timingNotes: 'Only on workout days.',
          },
          dosages: { defaultAmount: 5, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const creatine = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Creatine Monohydrate',
          canonicalMolecule: 'creatine',
          aliases: ['Creatine'],
          tags: ['supplement', 'ergogenic'],
          timingRules: {
            preferredSlots: ['pre_workout'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'pre_workout',
            circadianEffect: 'neutral',
            timingNotes: 'Pre-workout on training days; morning on rest days.',
          },
          dosages: { defaultAmount: 5, defaultUnit: 'g', route: 'Oral', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Creatine Monohydrate', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Workout vs Rest Day Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: motsc.id, doseAmount: 5, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: creatine.id, doseAmount: 5, doseUnit: 'g' }),
          ],
        }),
      );

      // Monday 2026-10-19 (day 1 = training day)
      const trainingSpread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const motscTrain = findSystemicPlacement(trainingSpread, motsc.id);
      const creatineTrain = findSystemicPlacement(trainingSpread, creatine.id);
      assert.ok(motscTrain && motscTrain.slot.slotId === 'pre_workout', 'MOTS-c must be in pre_workout on training day');
      assert.ok(creatineTrain && creatineTrain.slot.slotId === 'pre_workout', 'Creatine must be in pre_workout on training day');
      assert.ok(
        Array.isArray(motscTrain.item.daysOfWeek) &&
          !motscTrain.item.daysOfWeek.includes(0) &&
          !motscTrain.item.daysOfWeek.includes(6),
        `training_days_only MOTS-c daysOfWeek must exclude rest days 0 & 6: ${JSON.stringify(motscTrain.item.daysOfWeek)}`,
      );

      // Sunday 2026-10-25 (day 0 = rest day)
      const restSpread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-25' });
      const sundayGrid = restSpread.systemic.weeklyGrid?.['0'] || [];
      assert.ok(
        !sundayGrid.some((entry) => entry.compoundId === motsc.id || entry === motsc.id),
        `training_days_only MOTS-c must NOT appear on rest-day weeklyGrid["0"]: ${JSON.stringify(sundayGrid)}`,
      );
      const motscRest = findSystemicPlacement(restSpread, motsc.id);
      if (motscRest) {
        assert.ok(
          !motscRest.item.daysOfWeek.includes(0),
          `MOTS-c must not be active on rest day Sunday (0): ${JSON.stringify(motscRest.item)}`,
        );
      }

      const creatineRest = findSystemicPlacement(restSpread, creatine.id);
      assert.ok(creatineRest, 'Daily Creatine must still be scheduled on rest day Sunday');
      assert.equal(
        creatineRest.slot.slotId,
        'morning_am',
        `Daily pre_workout compound must fall back to morning_am on rest day, got "${creatineRest.slot.slotId}"`,
      );
    });
  });

  it('T11: Unresolvable slot constraint (3 mutually incompatible fasted-only items for 2 fasted slots) returns 200 best-effort + explicit conflict alert', async () => {
    await withServer(async ({ api }) => {
      const makeFastedConflicter = (name, slug, avoidRefs) =>
        fixtures.makePeptideCompound({
          name,
          canonicalMolecule: slug,
          aliases: [name],
          tags: ['peptide', slug, 'fasted_only'],
          timingRules: {
            preferredSlots: ['waking_fasted', 'bedtime_fasted'],
            avoidSlots: [
              'morning_am',
              'pre_workout',
              'intra_post_workout',
              'midday_lunch',
              'evening_dinner',
              'prn',
            ],
            foodState: 'fasted',
            fastingWindowHours: 2,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Strictly fasted slot required.',
          },
          dosages: { defaultAmount: 100, defaultUnit: 'mcg', route: 'SubQ', maxCeiling: 500 },
          doNotPairWith: avoidRefs.map((ref) => ({
            targetType: 'compound',
            targetRef: ref,
            severity: 'avoid_same_slot',
            separationHours: 4,
            mechanism: 'Synthetic unresolvable mutual antagonism.',
            recommendation: `Do not share a fasted slot with ${ref}.`,
          })),
          synergies: [],
        });

      const a = await createCompound(
        api,
        makeFastedConflicter('Fasted Conflict Alpha', 'fasted-alpha', ['fasted-beta', 'fasted-gamma']),
      );
      const b = await createCompound(
        api,
        makeFastedConflicter('Fasted Conflict Beta', 'fasted-beta', ['fasted-alpha', 'fasted-gamma']),
      );
      const c = await createCompound(
        api,
        makeFastedConflicter('Fasted Conflict Gamma', 'fasted-gamma', ['fasted-alpha', 'fasted-beta']),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Pigeonhole Unresolvable Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: a.id, doseAmount: 100, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: b.id, doseAmount: 100, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: c.id, doseAmount: 100, doseUnit: 'mcg' }),
          ],
        }),
      );

      // Must complete cleanly in HTTP 200 without hanging or 500
      const spread = await computeSchedule(
        api,
        'member_wife',
        stack.id,
        { dateKey: '2026-10-19' },
        { timeoutMs: 10_000 },
      );

      // All 3 items must remain present in best-effort output
      const scheduledIds = listSlotSystemicCompoundIds(spread);
      assert.ok(scheduledIds.has(a.id), 'Alpha must not be silently dropped');
      assert.ok(scheduledIds.has(b.id), 'Beta must not be silently dropped');
      assert.ok(scheduledIds.has(c.id), 'Gamma must not be silently dropped');

      // Explicit unresolved-conflict alert/explanation must be surfaced (never routine autoSeparated or boilerplate alone)
      const unresolvedSignals = [
        ...(spread.interactions.cautions || []),
        ...(spread.interactions.safetyAlerts || []),
        ...(spread.interactions.hardStops || []),
        ...(spread.explanations || []),
      ];
      const UNRESOLVED_CONFLICT_RE =
        /conflict|unresolv|cannot|could not|unable|competing|overlap|collision|insufficient|same[\s_-]*slot|avoid[\s_-]*slot|fallback|exceeds/i;
      assert.ok(
        unresolvedSignals.some((entry) => {
          const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
          return UNRESOLVED_CONFLICT_RE.test(text);
        }),
        `Unresolvable 3-for-2 fasted conflict must surface an explicit unresolved conflict/collision/fallback alert in cautions/safetyAlerts/hardStops/explanations: ${JSON.stringify(spread)}`,
      );
    });
  });

  it('T12: DST / UTC-noon calendar transition bounds (Spring-Forward 2026-03-08, Fall-Back 2026-11-01 & expired cycle)', async () => {
    await withServer(async ({ api }) => {
      const patchTz = await api.patch('/api/v1/members/member_wife', {
        routineAnchors: {
          wake: '07:00',
          breakfast: '08:00',
          workout: '06:30',
          workoutDays: [1, 2, 3, 4, 5],
          lunch: '13:00',
          dinner: '19:00',
          bed: '22:30',
          tz: 'America/New_York',
        },
      });
      assert.equal(patchTz.status, 200, `PATCH member_wife America/New_York tz failed: ${patchTz.text}`);

      const springPeptide = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Spring DST Peptide',
          canonicalMolecule: 'spring-dst-peptide',
          cycles: { patternText: '14 days on, 7 days off', cycleDays: 14, offDays: 7, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const fallPeptide = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Fall DST Peptide',
          canonicalMolecule: 'fall-dst-peptide',
          cycles: { patternText: '14 days on, 7 days off', cycleDays: 14, offDays: 7, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const expiredPeptide = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Expired Epitalon Cycle',
          canonicalMolecule: 'epitalon',
          cycles: { patternText: '10 days on, 180 days off', cycleDays: 10, offDays: 180, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'DST Boundary Cycle Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({
              compoundId: springPeptide.id,
              doseAmount: 250,
              doseUnit: 'mcg',
              cycleStartDate: '2026-03-01',
              cycle: { startDate: '2026-03-01', cycleDays: 14, offDays: 7 },
            }),
            fixtures.makeStackItem({
              compoundId: fallPeptide.id,
              doseAmount: 250,
              doseUnit: 'mcg',
              cycleStartDate: '2026-10-25',
              cycle: { startDate: '2026-10-25', cycleDays: 14, offDays: 7 },
            }),
            fixtures.makeStackItem({
              compoundId: expiredPeptide.id,
              doseAmount: 1000,
              doseUnit: 'mcg',
              cycleStartDate: '2026-01-01',
              cycle: { startDate: '2026-01-01', cycleDays: 10, offDays: 180 },
            }),
          ],
        }),
      );

      // Spring-Forward DST day in America/New_York: 2026-03-08 (Day 8 of 14 from 2026-03-01)
      const springSpread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-03-08' });
      const springPos = findSystemicPlacement(springSpread, springPeptide.id);
      assert.ok(springPos && springPos.item.cycleStatus, 'Spring peptide must have cycleStatus on 2026-03-08');
      const DAY_8_PHASE_RE = /(?:active_day_|day[\s:_-]+)8(?=[_\s/,-]|$)/i;

      const springStatusStr = extractCyclePhaseText(springPos.item.cycleStatus);
      assert.match(springStatusStr, /active/i, `Spring DST cycle should be active on day 8/14: ${JSON.stringify(springPos.item.cycleStatus)}`);
      const springDayNum =
        springPos.item.cycleStatus.day ??
        springPos.item.cycleStatus.currentDay ??
        springPos.item.cycleStatus.dayOfCycle ??
        springPos.item.cycleStatus.cycleDay ??
        springPos.item.cycleStatus.dayNumber ??
        springPos.item.cycleStatus.elapsedDays;
      if (typeof springDayNum === 'number') {
        assert.equal(springDayNum, 8, `UTC-noon DST day math must compute exact day 8 on 2026-03-08, got ${springDayNum}`);
      } else {
        assert.match(
          springStatusStr,
          DAY_8_PHASE_RE,
          `Expected day 8 in cycleStatus phase text "${springStatusStr}": ${JSON.stringify(springPos.item.cycleStatus)}`,
        );
      }

      const expiredPos = findSystemicPlacement(springSpread, expiredPeptide.id);
      if (expiredPos) {
        assert.match(
          extractCyclePhaseText(expiredPos.item.cycleStatus),
          /off_cycle|expired|off/i,
          `Past-end cycle on 2026-03-08 must report off_cycle or expired: ${JSON.stringify(expiredPos.item.cycleStatus)}`,
        );
      } else {
        const allGridIds = Object.values(springSpread.systemic.weeklyGrid || {})
          .flat()
          .map((e) => (typeof e === 'string' ? e : e?.compoundId));
        assert.ok(
          !allGridIds.includes(expiredPeptide.id),
          'Expired cycle omitted from daily slots must also not be active in weeklyGrid',
        );
      }

      // Fall-Back DST day in America/New_York: 2026-11-01 (Day 8 of 14 from 2026-10-25)
      const fallSpread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-11-01' });
      const fallPos = findSystemicPlacement(fallSpread, fallPeptide.id);
      assert.ok(fallPos && fallPos.item.cycleStatus, 'Fall peptide must have cycleStatus on 2026-11-01');
      const fallStatusStr = extractCyclePhaseText(fallPos.item.cycleStatus);
      assert.match(fallStatusStr, /active/i, `Fall DST cycle should be active on day 8/14: ${JSON.stringify(fallPos.item.cycleStatus)}`);
      const fallDayNum =
        fallPos.item.cycleStatus.day ??
        fallPos.item.cycleStatus.currentDay ??
        fallPos.item.cycleStatus.dayOfCycle ??
        fallPos.item.cycleStatus.cycleDay ??
        fallPos.item.cycleStatus.dayNumber ??
        fallPos.item.cycleStatus.elapsedDays;
      if (typeof fallDayNum === 'number') {
        assert.equal(fallDayNum, 8, `UTC-noon DST day math must compute exact day 8 on 2026-11-01, got ${fallDayNum}`);
      } else {
        assert.match(
          fallStatusStr,
          DAY_8_PHASE_RE,
          `Expected day 8 in cycleStatus phase text "${fallStatusStr}": ${JSON.stringify(fallPos.item.cycleStatus)}`,
        );
      }
    });
  });

  it('T13: have-only stack filtering vs mixed wishlist items accurately populates stockSummary.missing and excludes unowned items when haveOnly=true', async () => {
    await withServer(async ({ api }) => {
      const owned = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Owned BPC-157',
          doNotPairWith: [],
          synergies: [],
        }),
      );
      const wishlist = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Wishlist Magnesium',
          doNotPairWith: [],
          synergies: [],
        }),
      );
      const dontHave = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'DontHave Vitamin D3',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_fat', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning' },
          dosages: { defaultAmount: 2000, defaultUnit: 'IU', route: 'Oral', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Cholecalciferol', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      await setOwnership(api, owned.id, { scope: 'household', status: 'have', quantity: 2 });
      await setOwnership(api, wishlist.id, { scope: 'household', status: 'wishlist' });
      await setOwnership(api, dontHave.id, { scope: 'member:member_wife', status: 'dont_have' });

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Stock Filter Stack',
          memberId: 'member_wife',
          haveOnly: false,
          items: [
            fixtures.makeStackItem({ compoundId: owned.id, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: wishlist.id, doseAmount: 200, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: dontHave.id, doseAmount: 2000, doseUnit: 'IU' }),
          ],
        }),
      );

      // Mode 1: Mixed (haveOnly = false)
      const fullSpread = await computeSchedule(api, 'member_wife', stack.id, {
        dateKey: '2026-10-19',
        haveOnly: false,
      });
      const fullSlotIds = listSlotSystemicCompoundIds(fullSpread);
      assert.ok(fullSlotIds.has(owned.id) && fullSlotIds.has(wishlist.id) && fullSlotIds.has(dontHave.id));
      assert.equal(fullSpread.stockSummary.total, 3);
      assert.equal(fullSpread.stockSummary.have, 1);
      assert.equal(fullSpread.stockSummary.missing.length, 2);

      // Mode 2: haveOnly = true (persisted on stack AND passed on schedule request)
      const patchRes = await api.patch(
        `/api/v1/members/member_wife/stacks/${encodeURIComponent(stack.id)}`,
        { haveOnly: true },
      );
      assert.equal(patchRes.status, 200, `PATCH haveOnly failed: ${patchRes.text}`);

      const haveOnlySpread = await computeSchedule(api, 'member_wife', stack.id, {
        dateKey: '2026-10-19',
        haveOnly: true,
      });
      const haveOnlySlotIds = listSlotSystemicCompoundIds(haveOnlySpread);
      const haveOnlyAllIds = listAllSystemicCompoundIds(haveOnlySpread);
      assert.ok(haveOnlySlotIds.has(owned.id), 'Owned compound must remain scheduled when haveOnly=true');
      assert.ok(!haveOnlyAllIds.has(wishlist.id), 'Wishlist compound must be excluded from active slots & weeklyGrid when haveOnly=true');
      assert.ok(!haveOnlyAllIds.has(dontHave.id), 'dont_have compound must be excluded from active slots & weeklyGrid when haveOnly=true');
    });
  });

  it('T14: Empty stack returns valid empty SpreadResult (200), nonexistent stack/member returns 404, cross-member blocked, unauthenticated returns 401 with Cache-Control: no-store', async () => {
    await withServer(async ({ server, api }) => {
      const emptyStack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Empty Edge Stack',
          memberId: 'member_wife',
          items: [],
        }),
      );

      const emptySpread = await computeSchedule(api, 'member_wife', emptyStack.id, {
        dateKey: '2026-10-19',
      });
      assert.equal(emptySpread.memberId, 'member_wife');
      assert.equal(emptySpread.stackId, emptyStack.id);
      assert.equal(listAllSystemicCompoundIds(emptySpread).size, 0);
      assert.equal(listAllDermCompoundIds(emptySpread).size, 0);
      assert.equal(emptySpread.stockSummary.total, 0);
      assert.equal(emptySpread.stockSummary.have, 0);
      assert.equal(emptySpread.stockSummary.missing.length, 0);
      assert.equal((emptySpread.interactions.hardStops || []).length, 0);

      // Nonexistent stack ID -> 404
      const missingStackRes = await api.post(
        '/api/v1/members/member_wife/stacks/stk_does_not_exist_404/schedule',
        { dateKey: '2026-10-19' },
      );
      assert.equal(
        missingStackRes.status,
        404,
        `Nonexistent stack schedule must return 404, got ${missingStackRes.status}: ${missingStackRes.text}`,
      );

      // Nonexistent member ID -> 404
      const missingMemberRes = await api.post(
        `/api/v1/members/member_does_not_exist_404/stacks/${encodeURIComponent(emptyStack.id)}/schedule`,
        { dateKey: '2026-10-19' },
      );
      assert.equal(
        missingMemberRes.status,
        404,
        `Nonexistent member schedule must return 404, got ${missingMemberRes.status}: ${missingMemberRes.text}`,
      );

      // Cross-member stack ID isolation (accessing Wife's stack via Husband's route) -> 404 or 403
      const crossMemberRes = await api.post(
        `/api/v1/members/member_husband/stacks/${encodeURIComponent(emptyStack.id)}/schedule`,
        { dateKey: '2026-10-19' },
      );
      assert.ok(
        crossMemberRes.status === 404 || crossMemberRes.status === 403,
        `Cross-member stack access must return 404 or 403, got ${crossMemberRes.status}: ${crossMemberRes.text}`,
      );

      // Unauthenticated requests must return 401 with Cache-Control: no-store
      const unauthApi = createApiClient({ baseUrl: server.baseUrl });
      const unauthList = await unauthApi.get('/api/v1/members/member_wife/stacks', { auth: false });
      assert.equal(unauthList.status, 401, `Unauth GET stacks must return 401, got ${unauthList.status}`);
      assertNoStore(unauthList, 'Unauth GET stacks');

      const unauthSchedule = await unauthApi.post(
        `/api/v1/members/member_wife/stacks/${encodeURIComponent(emptyStack.id)}/schedule`,
        { dateKey: '2026-10-19' },
        { auth: false },
      );
      assert.equal(unauthSchedule.status, 401, `Unauth POST schedule must return 401, got ${unauthSchedule.status}`);
      assertNoStore(unauthSchedule, 'Unauth POST schedule');

      const unauthInteractions = await unauthApi.post(
        `/api/v1/members/member_wife/stacks/${encodeURIComponent(emptyStack.id)}/interactions`,
        {},
        { auth: false },
      );
      assert.equal(
        unauthInteractions.status,
        401,
        `Unauth POST interactions must return 401, got ${unauthInteractions.status}`,
      );
      assertNoStore(unauthInteractions, 'Unauth POST interactions');
    });
  });

  it('T15: Read-only scoped API key allows stack reads (200) and denies POST/PATCH/DELETE stack mutations with 403', async () => {
    await withServer(async ({ server, api }) => {
      const cmp = await createCompound(api, fixtures.makePeptideCompound());
      const existingStack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Protected Read-Only Target Stack',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: cmp.id, doseAmount: 250, doseUnit: 'mcg' })],
        }),
      );

      // Mint a real read-only scoped API key
      const mintRes = await api.post('/api/v1/keys', {
        name: 'E2E Stack Read-Only Scope Key',
        scope: 'read',
      });
      assert.ok(
        mintRes.status === 201 || mintRes.status === 200,
        `POST /api/v1/keys expected 200/201, got ${mintRes.status}: ${mintRes.text}`,
      );
      assertNoStore(mintRes, 'POST /api/v1/keys');
      const minted = unwrapData(mintRes.json, ['key', 'apiKey']);
      const readSecret = extractMintedKeySecret(mintRes.json, minted);
      assert.ok(readSecret, `Expected raw API key secret on mint: ${mintRes.text}`);

      const readApi = createApiClient({ baseUrl: server.baseUrl, token: readSecret });

      // Read-only scope MUST be allowed to read stacks
      const readStacksRes = await readApi.get('/api/v1/members/member_wife/stacks');
      assert.equal(
        readStacksRes.status,
        200,
        `Read-only key must be allowed GET stacks, got ${readStacksRes.status}: ${readStacksRes.text}`,
      );
      assertNoStore(readStacksRes, 'Read-only GET stacks');

      // Read-only scope MUST be denied POST/PATCH/DELETE stack writes with 403
      const createDenied = await readApi.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Unauthorized Read-Only Stack Creation',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: cmp.id, doseAmount: 250, doseUnit: 'mcg' })],
        }),
      );
      assert.equal(
        createDenied.status,
        403,
        `Read-only key POST stack must return 403, got ${createDenied.status}: ${createDenied.text}`,
      );
      assertNoStore(createDenied, 'Read-only POST stack');

      const patchDenied = await readApi.patch(
        `/api/v1/members/member_wife/stacks/${encodeURIComponent(existingStack.id)}`,
        { name: 'Tampered By Read-Only Key' },
      );
      assert.equal(
        patchDenied.status,
        403,
        `Read-only key PATCH stack must return 403, got ${patchDenied.status}: ${patchDenied.text}`,
      );
      assertNoStore(patchDenied, 'Read-only PATCH stack');

      const deleteDenied = await readApi.del(
        `/api/v1/members/member_wife/stacks/${encodeURIComponent(existingStack.id)}`,
      );
      assert.equal(
        deleteDenied.status,
        403,
        `Read-only key DELETE stack must return 403, got ${deleteDenied.status}: ${deleteDenied.text}`,
      );
      assertNoStore(deleteDenied, 'Read-only DELETE stack');

      // Confirm existing stack remains completely intact and unmodified
      const verifyStacks = unwrapData(
        (await api.get('/api/v1/members/member_wife/stacks')).json,
        ['stacks'],
      );
      assert.equal(verifyStacks.length, 1, 'Denied read-only writes must not create or delete stacks');
      assert.equal(
        verifyStacks[0].name,
        'Protected Read-Only Target Stack',
        'Denied read-only PATCH must not modify stack name',
      );
    });
  });
});
