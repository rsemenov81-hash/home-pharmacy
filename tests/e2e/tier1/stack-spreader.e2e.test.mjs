/**
 * Tier 1 E2E Suite — Area D: Cross-Section Stack Builder, Interaction Matrix
 * & Dual-Track Smart Spreader (Happy Paths: F15, F30–F37).
 *
 * Strictly opaque-box: communicates solely with the live HTTP server via
 * tests/e2e/harness.mjs. Zero internal imports from src/, dist/, or tools/.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  unwrapData,
  fixtures,
} from '../harness.mjs';

const SYSTEMIC_DAYTIME_SLOTS = new Set([
  'waking_fasted',
  'morning_am',
  'pre_workout',
  'intra_post_workout',
  'midday_lunch',
]);

const MEAL_SLOTS = new Set([
  'morning_am',
  'midday_lunch',
  'evening_dinner',
]);

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
    `Created compound (${payload.name}) must return a non-empty string id, got: ${res.text}`,
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
  assertNoStore(res, `PUT /api/v1/ownership/${compoundId}`);
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
  assertNoStore(res, `POST /api/v1/members/${memberId}/stacks`);
  const stack = unwrapData(res.json, ['stack']);
  assert.ok(
    stack && typeof stack.id === 'string' && stack.id.length > 0,
    `Created stack must return a non-empty string id, got: ${res.text}`,
  );
  return stack;
}

async function computeSchedule(api, memberId, stackId, body = {}) {
  const res = await api.post(
    `/api/v1/members/${encodeURIComponent(memberId)}/stacks/${encodeURIComponent(stackId)}/schedule`,
    body,
  );
  assert.equal(
    res.status,
    200,
    `POST .../schedule expected 200, got ${res.status}: ${res.text}`,
  );
  assertNoStore(res, 'POST .../schedule');
  // Never pass 'interactions' as a candidateKey: SpreadResult itself has an .interactions property.
  const spread = unwrapData(res.json, ['schedule', 'spread']);
  assert.ok(spread && typeof spread === 'object', `SpreadResult must be an object: ${res.text}`);
  assert.ok(
    spread.systemic && Array.isArray(spread.systemic.slots),
    `SpreadResult.systemic.slots must be an array: ${res.text}`,
  );
  assert.ok(
    spread.dermatology && spread.dermatology.skin && spread.dermatology.hairScalp,
    `SpreadResult.dermatology must include skin and hairScalp tracks: ${res.text}`,
  );
  assert.ok(
    spread.interactions && typeof spread.interactions === 'object',
    `SpreadResult.interactions must be an object: ${res.text}`,
  );
  assert.ok(
    spread.stockSummary && typeof spread.stockSummary === 'object',
    `SpreadResult.stockSummary must be an object: ${res.text}`,
  );
  return spread;
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
  const analysis = unwrapData(res.json, ['interactions', 'analysis']);
  assert.ok(analysis && typeof analysis === 'object', `InteractionAnalysis must be an object: ${res.text}`);
  return analysis;
}

function findSystemicPlacement(spread, compoundId) {
  for (const slot of spread.systemic.slots) {
    const items = Array.isArray(slot.items) ? slot.items : [];
    const found = items.find((item) => item.compoundId === compoundId);
    if (found) {
      return { slot, item: found };
    }
  }
  return null;
}

function parseHHMMToMinutes(timeStr, contextLabel) {
  assert.equal(
    typeof timeStr,
    'string',
    `${contextLabel}: expected suggestedTime string, got ${typeof timeStr}`,
  );
  const match = /^(\d{2}):(\d{2})$/.exec(timeStr.trim());
  assert.ok(match, `${contextLabel}: expected HH:MM time format, got "${timeStr}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  assert.ok(
    hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59,
    `${contextLabel}: out-of-range clock time "${timeStr}"`,
  );
  return hours * 60 + minutes;
}

function clockSeparationHours(timeA, timeB) {
  const minsA = parseHHMMToMinutes(timeA, 'slot A');
  const minsB = parseHHMMToMinutes(timeB, 'slot B');
  const linear = Math.abs(minsA - minsB);
  const circular = Math.min(linear, 24 * 60 - linear);
  return circular / 60;
}

function entryMentionsAny(entry, needles) {
  const serialized = JSON.stringify(entry).toLowerCase();
  return needles.some((needle) => serialized.includes(String(needle).toLowerCase()));
}

function entryMentionsAll(entry, needleGroups) {
  return needleGroups.every((group) =>
    entryMentionsAny(entry, Array.isArray(group) ? group : [group]),
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

function makeUnpinnedAutoCadenceItem(compoundId, overrides = {}) {
  const item = fixtures.makeStackItem({ compoundId, ...overrides });
  if (overrides.cadence && !Object.prototype.hasOwnProperty.call(overrides.cadence, 'daysOfWeek')) {
    delete item.cadence.daysOfWeek;
  }
  return item;
}

describe('Tier 1 — Area D: Stack Builder, Interaction Matrix & Dual-Track Smart Spreader', () => {
  it('T1: Named cross-section stack CRUD across all 4 core sections + stock coverage (have vs wishlist/dont_have)', async () => {
    await withServer(async ({ api }) => {
      const peptide = await createCompound(api, fixtures.makePeptideCompound());
      const ped = await createCompound(api, fixtures.makePedCompound());
      const supplement = await createCompound(api, fixtures.makeSupplementCompound());
      const derm = await createCompound(api, fixtures.makeDermCompound());

      await setOwnership(api, peptide.id, { scope: 'household', status: 'have', quantity: 2 });
      await setOwnership(api, ped.id, { scope: 'member:member_husband', status: 'have', quantity: 1 });
      await setOwnership(api, supplement.id, { scope: 'household', status: 'wishlist' });
      await setOwnership(api, derm.id, { scope: 'member:member_husband', status: 'dont_have' });

      const stackPayload = fixtures.makeStackPayload({
        name: 'Four-Pillar Cross-Section Stack',
        memberId: 'member_husband',
        active: true,
        items: [
          fixtures.makeStackItem({ compoundId: peptide.id, doseAmount: 300, doseUnit: 'mcg' }),
          fixtures.makeStackItem({
            compoundId: ped.id,
            doseAmount: 60,
            doseUnit: 'mg',
            frequency: '2x_week',
            cadence: { type: '2x_week', daysOfWeek: [1, 4] },
          }),
          fixtures.makeStackItem({ compoundId: supplement.id, doseAmount: 200, doseUnit: 'mg' }),
          fixtures.makeStackItem({ compoundId: derm.id, doseAmount: 1, doseUnit: 'pea_size' }),
        ],
      });

      const created = await createStack(api, 'member_husband', stackPayload);
      assert.equal(created.name, 'Four-Pillar Cross-Section Stack');
      assert.equal(created.items.length, 4);

      const listRes = await api.get('/api/v1/members/member_husband/stacks');
      assert.equal(listRes.status, 200, `GET stacks expected 200: ${listRes.text}`);
      assertNoStore(listRes, 'GET stacks');
      const stacks = unwrapData(listRes.json, ['stacks']);
      assert.ok(Array.isArray(stacks), 'GET stacks must return an array');
      const listed = stacks.find((s) => s.id === created.id);
      assert.ok(listed, 'Created stack must appear in member stack list');
      assert.equal(listed.items.length, 4);

      const spread = await computeSchedule(api, 'member_husband', created.id, {
        dateKey: '2026-10-19',
      });
      assert.equal(spread.memberId, 'member_husband');
      assert.equal(spread.stackId, created.id);
      assert.equal(spread.stockSummary.total, 4, `stockSummary.total mismatch: ${JSON.stringify(spread.stockSummary)}`);
      assert.equal(spread.stockSummary.have, 2, `stockSummary.have mismatch: ${JSON.stringify(spread.stockSummary)}`);
      assert.ok(Array.isArray(spread.stockSummary.missing), 'stockSummary.missing must be an array');
      assert.equal(spread.stockSummary.missing.length, 2);

      const missingById = new Map(spread.stockSummary.missing.map((m) => [m.compoundId, m]));
      assert.ok(missingById.has(supplement.id), 'Wishlist supplement must be listed in stockSummary.missing');
      assert.equal(missingById.get(supplement.id).status, 'wishlist');
      assert.ok(missingById.has(derm.id), 'dont_have derm item must be listed in stockSummary.missing');
      assert.equal(missingById.get(derm.id).status, 'dont_have');
      assert.ok(!missingById.has(peptide.id), 'Owned peptide must not appear in stockSummary.missing');
      assert.ok(!missingById.has(ped.id), 'Owned PED must not appear in stockSummary.missing');

      const patchRes = await api.patch(
        `/api/v1/members/member_husband/stacks/${encodeURIComponent(created.id)}`,
        {
          name: 'Updated Four-Pillar Stack',
          items: [
            fixtures.makeStackItem({
              compoundId: peptide.id,
              doseAmount: 350,
              doseUnit: 'mcg',
              frequency: '5on_2off',
              cadence: { type: '5on_2off', daysOfWeek: [1, 2, 3, 4, 5] },
            }),
            fixtures.makeStackItem({ compoundId: supplement.id, doseAmount: 200, doseUnit: 'mg' }),
          ],
        },
      );
      assert.equal(patchRes.status, 200, `PATCH stack expected 200: ${patchRes.text}`);
      assertNoStore(patchRes, 'PATCH stack');
      const patched = unwrapData(patchRes.json, ['stack']);
      assert.equal(patched.name, 'Updated Four-Pillar Stack');
      assert.equal(patched.items.length, 2);

      const delRes = await api.del(
        `/api/v1/members/member_husband/stacks/${encodeURIComponent(created.id)}`,
      );
      assert.ok(
        delRes.status === 200 || delRes.status === 204,
        `DELETE stack expected 200/204, got ${delRes.status}: ${delRes.text}`,
      );

      const afterListRes = await api.get('/api/v1/members/member_husband/stacks');
      assert.equal(afterListRes.status, 200);
      const afterStacks = unwrapData(afterListRes.json, ['stacks']);
      assert.ok(
        !afterStacks.some((s) => s.id === created.id),
        'Deleted stack must no longer appear in member stacks',
      );
    });
  });

  it('T2: Deterministic Systemic 8-Slot spreading anchored to member.routineAnchors + anchor shift', async () => {
    await withServer(async ({ api }) => {
      const anchorPatch1 = await api.patch('/api/v1/members/member_wife', {
        routineAnchors: {
          wake: '07:00',
          breakfast: '08:00',
          workout: '06:30',
          workoutDays: [1, 2, 3, 4, 5],
          lunch: '13:00',
          dinner: '19:00',
          bed: '22:30',
          tz: 'UTC',
        },
      });
      assert.equal(anchorPatch1.status, 200, `PATCH member anchors failed: ${anchorPatch1.text}`);

      const tesamorelin = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Tesamorelin',
          canonicalMolecule: 'tesamorelin',
          aliases: ['Egrifta'],
          tags: ['peptide', 'ghrh', 'fasted'],
          timingRules: {
            preferredSlots: ['waking_fasted'],
            avoidSlots: ['morning_am', 'evening_dinner'],
            foodState: 'fasted',
            fastingWindowHours: 1.5,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Administer fasted upon waking.',
          },
          dosages: { defaultAmount: 1, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 2 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const vitaminD3 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3 2000 IU',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['morning_am'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with breakfast fat.',
          },
          dosages: { defaultAmount: 2000, defaultUnit: 'IU', route: 'Oral', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Cholecalciferol',
            supplementFacts: [{ nutrient: 'Vitamin D3', amount: 2000, unit: 'IU' }],
            adultUpperLimit: { nutrientKey: 'vitamin_d', amount: 4000, unit: 'IU', basis: 'total' },
          },
        }),
      );

      const motsc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'MOTS-c',
          canonicalMolecule: 'mots-c',
          aliases: ['Mitochondrial ORF of 12S rRNA-c'],
          tags: ['peptide', 'mitochondrial', 'pre_workout'],
          timingRules: {
            preferredSlots: ['pre_workout'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'training_days_only',
            circadianEffect: 'stimulating',
            timingNotes: 'Administer pre-workout on training days.',
          },
          dosages: { defaultAmount: 5, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const eaa = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Essential Amino Acids (EAA)',
          canonicalMolecule: 'essential-amino-acids',
          aliases: ['EAA Recovery Mix'],
          tags: ['supplement', 'amino_acids', 'post_workout'],
          timingRules: {
            preferredSlots: ['intra_post_workout'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'post_workout',
            circadianEffect: 'neutral',
            timingNotes: 'Consume intra- or post-workout for recovery.',
          },
          dosages: { defaultAmount: 10, defaultUnit: 'g', route: 'Oral', maxCeiling: 30 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Free-Form Essential Amino Acids',
            supplementFacts: [{ nutrient: 'L-Leucine', amount: 3000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const coq10 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'CoQ10 Ubiquinol',
          canonicalMolecule: 'coq10',
          aliases: ['Ubiquinol'],
          tags: ['supplement', 'antioxidant', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['midday_lunch'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with lunch.',
          },
          dosages: { defaultAmount: 100, defaultUnit: 'mg', route: 'Oral', maxCeiling: 400 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Ubiquinol',
            supplementFacts: [{ nutrient: 'CoQ10', amount: 100, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const omega3 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Omega-3 EPA/DHA',
          canonicalMolecule: 'omega-3',
          aliases: ['Fish Oil'],
          tags: ['supplement', 'omega_3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['evening_dinner'],
            avoidSlots: [],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with dinner.',
          },
          dosages: { defaultAmount: 2000, defaultUnit: 'mg', route: 'Oral', maxCeiling: 5000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Triglyceride Form',
            supplementFacts: [{ nutrient: 'Omega-3 EPA/DHA', amount: 2000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const ipamorelin = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Ipamorelin',
          canonicalMolecule: 'ipamorelin',
          aliases: ['NNC 26-0161'],
          tags: ['peptide', 'gh_secretagogue', 'fasted'],
          timingRules: {
            preferredSlots: ['bedtime_fasted'],
            avoidSlots: ['morning_am'],
            foodState: 'fasted',
            fastingWindowHours: 2,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take fasted at bedtime, 2h post-dinner.',
          },
          dosages: { defaultAmount: 200, defaultUnit: 'mcg', route: 'SubQ', maxCeiling: 600 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const electrolytes = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Electrolyte Hydration Mix',
          canonicalMolecule: 'electrolytes',
          aliases: ['Sodium Potassium Mix'],
          tags: ['supplement', 'hydration', 'prn'],
          timingRules: {
            preferredSlots: ['prn'],
            avoidSlots: [],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Use as needed for hydration.',
          },
          dosages: { defaultAmount: 1, defaultUnit: 'scoops', route: 'Oral', maxCeiling: 4 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Electrolyte Blend',
            supplementFacts: [{ nutrient: 'Sodium', amount: 500, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Eight-Slot Anchor Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: tesamorelin.id, doseAmount: 1, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: vitaminD3.id, doseAmount: 2000, doseUnit: 'IU' }),
            fixtures.makeStackItem({ compoundId: motsc.id, doseAmount: 5, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: eaa.id, doseAmount: 10, doseUnit: 'g' }),
            fixtures.makeStackItem({ compoundId: coq10.id, doseAmount: 100, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: omega3.id, doseAmount: 2000, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: ipamorelin.id, doseAmount: 200, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: electrolytes.id, doseAmount: 1, doseUnit: 'scoops' }),
          ],
        }),
      );

      // Monday 2026-10-19 (day 1 = workout day)
      const spread1 = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const spread2 = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      // Determinism: identical inputs produce identical slot assignments and suggested times
      const normalizeSlots = (s) =>
        s.systemic.slots.map((slot) => ({
          slotId: slot.slotId,
          suggestedTime: slot.suggestedTime,
          itemIds: (slot.items || []).map((i) => i.compoundId),
        }));
      assert.deepEqual(
        normalizeSlots(spread1),
        normalizeSlots(spread2),
        'Repeated schedule calls with identical state must be 100% deterministic',
      );

      const presentSlotIds = new Set(spread1.systemic.slots.map((s) => s.slotId));
      const allCanonicalSlots = [
        'waking_fasted',
        'morning_am',
        'pre_workout',
        'intra_post_workout',
        'midday_lunch',
        'evening_dinner',
        'bedtime_fasted',
        'prn',
      ];
      for (const slotId of allCanonicalSlots) {
        assert.ok(
          presentSlotIds.has(slotId),
          `SpreadResult.systemic.slots must include canonical slot "${slotId}", got: ${[...presentSlotIds].join(', ')}`,
        );
      }

      assert.equal(findSystemicPlacement(spread1, tesamorelin.id)?.slot.slotId, 'waking_fasted');
      assert.equal(findSystemicPlacement(spread1, vitaminD3.id)?.slot.slotId, 'morning_am');
      assert.equal(findSystemicPlacement(spread1, motsc.id)?.slot.slotId, 'pre_workout');
      assert.equal(findSystemicPlacement(spread1, eaa.id)?.slot.slotId, 'intra_post_workout');
      assert.equal(findSystemicPlacement(spread1, coq10.id)?.slot.slotId, 'midday_lunch');
      assert.equal(findSystemicPlacement(spread1, omega3.id)?.slot.slotId, 'evening_dinner');
      assert.equal(findSystemicPlacement(spread1, ipamorelin.id)?.slot.slotId, 'bedtime_fasted');
      assert.equal(findSystemicPlacement(spread1, electrolytes.id)?.slot.slotId, 'prn');

      const slotTimeMap1 = new Map(spread1.systemic.slots.map((s) => [s.slotId, s.suggestedTime]));
      const timedSlotIds = [
        'waking_fasted',
        'morning_am',
        'pre_workout',
        'intra_post_workout',
        'midday_lunch',
        'evening_dinner',
        'bedtime_fasted',
      ];
      for (const slotId of timedSlotIds) {
        parseHHMMToMinutes(slotTimeMap1.get(slotId), `Baseline ${slotId}`);
      }

      // Shift member routine anchors earlier by 1.5h and confirm suggestedTime follows anchors
      const anchorPatch2 = await api.patch('/api/v1/members/member_wife', {
        routineAnchors: {
          wake: '05:30',
          breakfast: '06:30',
          workout: '05:00',
          workoutDays: [1, 2, 3, 4, 5],
          lunch: '11:30',
          dinner: '17:30',
          bed: '21:00',
          tz: 'UTC',
        },
      });
      assert.equal(anchorPatch2.status, 200);

      const shifted = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const slotTimeMap2 = new Map(shifted.systemic.slots.map((s) => [s.slotId, s.suggestedTime]));

      for (const slotId of timedSlotIds) {
        const beforeMins = parseHHMMToMinutes(slotTimeMap1.get(slotId), `Before ${slotId}`);
        const afterMins = parseHHMMToMinutes(slotTimeMap2.get(slotId), `After ${slotId}`);
        assert.ok(
          afterMins < beforeMins,
          `Slot "${slotId}" suggestedTime should shift earlier with earlier anchors (before=${slotTimeMap1.get(slotId)}, after=${slotTimeMap2.get(slotId)})`,
        );
      }
    });
  });

  it('T3: Mineral competition auto-separation (Zinc+Copper and Iron+Calcium) with autoSeparated & rationale chips', async () => {
    await withServer(async ({ api }) => {
      const zinc = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Zinc Picolinate',
          canonicalMolecule: 'zinc',
          aliases: ['Zinc'],
          tags: ['supplement', 'mineral', 'zinc'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch', 'evening_dinner'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with a meal to reduce nausea.',
          },
          dosages: { defaultAmount: 30, defaultUnit: 'mg', route: 'Oral', maxCeiling: 40 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'copper',
              severity: 'avoid_same_slot',
              separationHours: 3,
              mechanism: 'Zinc induces metallothionein and competes with intestinal copper uptake.',
              recommendation: 'Separate Zinc and Copper by at least 2-4 hours.',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: 'Zinc Picolinate',
            elementalWeightMg: 30,
            supplementFacts: [{ nutrient: 'Zinc', amount: 30, unit: 'mg' }],
            adultUpperLimit: { nutrientKey: 'zinc', amount: 40, unit: 'mg', basis: 'total' },
          },
        }),
      );

      const copper = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Copper Bisglycinate',
          canonicalMolecule: 'copper',
          aliases: ['Copper'],
          tags: ['supplement', 'mineral', 'copper'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch', 'evening_dinner'],
            avoidSlots: [],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with food away from high-dose zinc.',
          },
          dosages: { defaultAmount: 2, defaultUnit: 'mg', route: 'Oral', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Copper Bisglycinate',
            elementalWeightMg: 2,
            supplementFacts: [{ nutrient: 'Copper', amount: 2, unit: 'mg' }],
            adultUpperLimit: { nutrientKey: 'copper', amount: 10, unit: 'mg', basis: 'total' },
          },
        }),
      );

      const iron = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Iron Bisglycinate',
          canonicalMolecule: 'iron',
          aliases: ['Ferrous Bisglycinate'],
          tags: ['supplement', 'mineral', 'iron'],
          timingRules: {
            preferredSlots: ['waking_fasted', 'morning_am', 'midday_lunch'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Separate from calcium and dairy.',
          },
          dosages: { defaultAmount: 25, defaultUnit: 'mg', route: 'Oral', maxCeiling: 45 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'calcium',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Calcium inhibits DMT1-mediated non-heme and heme iron absorption.',
              recommendation: 'Separate Iron and Calcium by at least 2 hours.',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: 'Iron Bisglycinate',
            elementalWeightMg: 25,
            supplementFacts: [{ nutrient: 'Iron', amount: 25, unit: 'mg' }],
            adultUpperLimit: { nutrientKey: 'iron', amount: 45, unit: 'mg', basis: 'total' },
          },
        }),
      );

      const calcium = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Calcium Citrate',
          canonicalMolecule: 'calcium',
          aliases: ['Calcium'],
          tags: ['supplement', 'mineral', 'calcium'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch', 'evening_dinner'],
            avoidSlots: [],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with a meal away from iron.',
          },
          dosages: { defaultAmount: 500, defaultUnit: 'mg', route: 'Oral', maxCeiling: 2500 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Calcium Citrate',
            elementalWeightMg: 500,
            supplementFacts: [{ nutrient: 'Calcium', amount: 500, unit: 'mg' }],
            adultUpperLimit: { nutrientKey: 'calcium', amount: 2500, unit: 'mg', basis: 'total' },
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Mineral Competition Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: zinc.id, doseAmount: 30, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: copper.id, doseAmount: 2, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: iron.id, doseAmount: 25, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: calcium.id, doseAmount: 500, doseUnit: 'mg' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      const zincPos = findSystemicPlacement(spread, zinc.id);
      const copperPos = findSystemicPlacement(spread, copper.id);
      const ironPos = findSystemicPlacement(spread, iron.id);
      const calciumPos = findSystemicPlacement(spread, calcium.id);

      assert.ok(zincPos && copperPos && ironPos && calciumPos, 'All 4 minerals must be scheduled');
      assert.notEqual(
        zincPos.slot.slotId,
        copperPos.slot.slotId,
        `Zinc and Copper must be separated into distinct slots (both in ${zincPos.slot.slotId})`,
      );
      assert.ok(
        clockSeparationHours(zincPos.slot.suggestedTime, copperPos.slot.suggestedTime) >= 3,
        `Zinc (${zincPos.slot.suggestedTime}) and Copper (${copperPos.slot.suggestedTime}) must be >= 3h apart (matching separationHours: 3)`,
      );

      assert.notEqual(
        ironPos.slot.slotId,
        calciumPos.slot.slotId,
        `Iron and Calcium must be separated into distinct slots (both in ${ironPos.slot.slotId})`,
      );
      assert.ok(
        clockSeparationHours(ironPos.slot.suggestedTime, calciumPos.slot.suggestedTime) >= 2,
        `Iron (${ironPos.slot.suggestedTime}) and Calcium (${calciumPos.slot.suggestedTime}) must be >= 2h apart`,
      );

      const autoSeparated = spread.interactions.autoSeparated;
      assert.ok(
        Array.isArray(autoSeparated) && autoSeparated.length >= 2,
        `Expected >= 2 autoSeparated entries, got: ${JSON.stringify(autoSeparated)}`,
      );
      assert.ok(
        autoSeparated.some((e) => entryMentionsAll(e, [['zinc', zinc.id], ['copper', copper.id]])),
        `autoSeparated must report Zinc/Copper separation: ${JSON.stringify(autoSeparated)}`,
      );
      assert.ok(
        autoSeparated.some((e) => entryMentionsAll(e, [['iron', iron.id], ['calcium', calcium.id]])),
        `autoSeparated must report Iron/Calcium separation: ${JSON.stringify(autoSeparated)}`,
      );

      for (const placement of [zincPos, copperPos, ironPos, calciumPos]) {
        assert.ok(
          Array.isArray(placement.item.rationale) && placement.item.rationale.length > 0,
          `Item ${placement.item.name} must carry human-readable rationale[] chips`,
        );
      }
    });
  });

  it('T4: Synergy co-location (D3+K2+Omega-3 at meal slot; Ipamorelin+CJC-1295 at bedtime_fasted)', async () => {
    await withServer(async ({ api }) => {
      const vitD3 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3 4000 IU',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with dietary fat.',
          },
          dosages: { defaultAmount: 4000, defaultUnit: 'IU', route: 'Oral', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'vitamin-k2', coLocate: true, reason: 'K2 directs D3-mobilized calcium to bone.' },
            { targetRef: 'omega-3', coLocate: true, reason: 'Lipids improve fat-soluble vitamin uptake.' },
          ],
          sectionData: {
            chemicalForm: 'Cholecalciferol',
            supplementFacts: [{ nutrient: 'Vitamin D3', amount: 4000, unit: 'IU' }],
            adultUpperLimit: { nutrientKey: 'vitamin_d', amount: 4000, unit: 'IU', basis: 'total' },
          },
        }),
      );

      const vitK2 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Vitamin K2 MK-7',
          canonicalMolecule: 'vitamin-k2',
          aliases: ['Menaquinone-7'],
          tags: ['supplement', 'vitamin', 'vitamin_k2', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['midday_lunch', 'morning_am'],
            avoidSlots: [],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Co-locate with Vitamin D3 and meal fat.',
          },
          dosages: { defaultAmount: 100, defaultUnit: 'mcg', route: 'Oral', maxCeiling: 500 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'vitamin-d3', coLocate: true, reason: 'Synergistic bone/vascular calcium handling.' },
          ],
          sectionData: {
            chemicalForm: 'MK-7',
            supplementFacts: [{ nutrient: 'Vitamin K2', amount: 100, unit: 'mcg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const omega3 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Omega-3 Concentrate',
          canonicalMolecule: 'omega-3',
          aliases: ['EPA DHA'],
          tags: ['supplement', 'omega_3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['evening_dinner', 'morning_am', 'midday_lunch'],
            avoidSlots: [],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Lipid carrier for fat-soluble micronutrients.',
          },
          dosages: { defaultAmount: 2000, defaultUnit: 'mg', route: 'Oral', maxCeiling: 5000 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'vitamin-d3', coLocate: true, reason: 'Enhances fat-soluble D3/K2 absorption.' },
          ],
          sectionData: {
            chemicalForm: 'rTG Fish Oil',
            supplementFacts: [{ nutrient: 'Omega-3', amount: 2000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const ipa = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Ipamorelin',
          canonicalMolecule: 'ipamorelin',
          aliases: ['Ipa'],
          tags: ['peptide', 'gh_secretagogue', 'ghrp'],
          timingRules: {
            preferredSlots: ['bedtime_fasted'],
            avoidSlots: ['morning_am'],
            foodState: 'fasted',
            fastingWindowHours: 2,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Bedtime fasted GH pulse.',
          },
          dosages: { defaultAmount: 200, defaultUnit: 'mcg', route: 'SubQ', maxCeiling: 600 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'cjc-1295', coLocate: true, reason: 'GHRP + GHRH co-administration amplifies pulsatile GH release.' },
          ],
        }),
      );

      const cjc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'CJC-1295 No DAC',
          canonicalMolecule: 'cjc-1295',
          aliases: ['Mod GRF 1-29'],
          tags: ['peptide', 'gh_secretagogue', 'ghrh'],
          timingRules: {
            preferredSlots: ['bedtime_fasted'],
            avoidSlots: ['morning_am'],
            foodState: 'fasted',
            fastingWindowHours: 2,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Co-administer with Ipamorelin fasted at bedtime.',
          },
          dosages: { defaultAmount: 100, defaultUnit: 'mcg', route: 'SubQ', maxCeiling: 300 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'ipamorelin', coLocate: true, reason: 'Synergistic GHRH + GHRP GH pulse.' },
          ],
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Synergy Co-Location Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: vitD3.id, doseAmount: 4000, doseUnit: 'IU' }),
            fixtures.makeStackItem({ compoundId: vitK2.id, doseAmount: 100, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: omega3.id, doseAmount: 2000, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: ipa.id, doseAmount: 200, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: cjc.id, doseAmount: 100, doseUnit: 'mcg' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      const d3Pos = findSystemicPlacement(spread, vitD3.id);
      const k2Pos = findSystemicPlacement(spread, vitK2.id);
      const o3Pos = findSystemicPlacement(spread, omega3.id);
      const ipaPos = findSystemicPlacement(spread, ipa.id);
      const cjcPos = findSystemicPlacement(spread, cjc.id);

      assert.ok(d3Pos && k2Pos && o3Pos && ipaPos && cjcPos, 'All 5 synergy items must be scheduled');

      assert.ok(
        MEAL_SLOTS.has(d3Pos.slot.slotId),
        `Fat-soluble D3 must be in a meal slot, got ${d3Pos.slot.slotId}`,
      );
      assert.equal(k2Pos.slot.slotId, d3Pos.slot.slotId, 'Vitamin K2 must co-locate with Vitamin D3');
      assert.equal(o3Pos.slot.slotId, d3Pos.slot.slotId, 'Omega-3 must co-locate with Vitamin D3 + K2');

      assert.equal(ipaPos.slot.slotId, 'bedtime_fasted', 'Ipamorelin must be placed at bedtime_fasted');
      assert.equal(cjcPos.slot.slotId, 'bedtime_fasted', 'CJC-1295 must co-locate with Ipamorelin at bedtime_fasted');

      const synergies = spread.interactions.synergies;
      assert.ok(
        Array.isArray(synergies) && synergies.length >= 2,
        `Expected >= 2 reported synergies, got: ${JSON.stringify(synergies)}`,
      );
      assert.ok(
        synergies.some((e) => entryMentionsAny(e, ['vitamin-d3', 'vitamin d3', vitD3.id])),
        `Synergies must include D3/K2/Omega-3 group: ${JSON.stringify(synergies)}`,
      );
      assert.ok(
        synergies.some((e) => entryMentionsAll(e, [['ipamorelin', ipa.id], ['cjc', cjc.id]])),
        `Synergies must include Ipamorelin + CJC-1295: ${JSON.stringify(synergies)}`,
      );
    });
  });

  it('T5: Stimulant circadian sleep protection (Semax, NAD+, B-Complex never placed in evening_dinner or bedtime_fasted)', async () => {
    await withServer(async ({ api }) => {
      const semax = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Semax Nasal Spray',
          canonicalMolecule: 'semax',
          aliases: ['ACTH 4-10 analog'],
          tags: ['peptide', 'nootropic', 'stimulating'],
          timingRules: {
            preferredSlots: ['morning_am'],
            avoidSlots: ['evening_dinner', 'bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'stimulating',
            timingNotes: 'Morning cognitive support; avoid late afternoon/evening.',
          },
          dosages: { defaultAmount: 300, defaultUnit: 'mcg', route: 'Nasal', maxCeiling: 1200 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      // Deliberately omit preferredSlots & avoidSlots so the solver must enforce circadianEffect: 'stimulating'
      const nadPlus = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'NAD+ SubQ',
          canonicalMolecule: 'nad-plus',
          aliases: ['Nicotinamide Adenine Dinucleotide'],
          tags: ['peptide', 'coenzyme', 'stimulating'],
          timingRules: {
            preferredSlots: [],
            avoidSlots: [],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'stimulating',
            timingNotes: 'Energizing cellular cofactor; daytime only.',
          },
          dosages: { defaultAmount: 50, defaultUnit: 'mg', route: 'SubQ', maxCeiling: 200 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const bComplex = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Methylated B-Complex',
          canonicalMolecule: 'b-complex',
          aliases: ['B Vitamins'],
          tags: ['supplement', 'b_vitamins', 'stimulating'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'stimulating',
            timingNotes: 'Energizing B vitamins; take in morning or lunch.',
          },
          dosages: { defaultAmount: 1, defaultUnit: 'caps', route: 'Oral', maxCeiling: 2 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Methylated B-Complex',
            supplementFacts: [{ nutrient: 'Vitamin B12', amount: 500, unit: 'mcg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const magGlyc = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Circadian Protection Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: semax.id, doseAmount: 300, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: nadPlus.id, doseAmount: 50, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: bComplex.id, doseAmount: 1, doseUnit: 'caps' }),
            fixtures.makeStackItem({ compoundId: magGlyc.id, doseAmount: 200, doseUnit: 'mg' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      for (const stim of [semax, nadPlus, bComplex]) {
        const placement = findSystemicPlacement(spread, stim.id);
        assert.ok(placement, `Stimulant ${stim.name} must be scheduled`);
        assert.ok(
          SYSTEMIC_DAYTIME_SLOTS.has(placement.slot.slotId),
          `Stimulant ${stim.name} must be in a morning/midday slot, got "${placement.slot.slotId}"`,
        );
        assert.notEqual(placement.slot.slotId, 'bedtime_fasted');
        assert.notEqual(placement.slot.slotId, 'evening_dinner');
      }

      const magPos = findSystemicPlacement(spread, magGlyc.id);
      assert.ok(magPos, 'Sedating Magnesium Glycinate must be scheduled');
      assert.ok(
        magPos.slot.slotId === 'evening_dinner' || magPos.slot.slotId === 'bedtime_fasted',
        `Sedating Magnesium Glycinate should be placed in evening_dinner or bedtime_fasted, got "${magPos.slot.slotId}"`,
      );
    });
  });

  it('T6: Dermatology AM/PM layering steps 1–7, PM photosensitivity routing, wait times & null missingSpfWarning', async () => {
    await withServer(async ({ api }) => {
      const cleanser = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Gentle Amino Cleanser',
          canonicalMolecule: 'amino-cleanser',
          aliases: ['Hydrating Face Wash'],
          tags: ['dermatology', 'cleanser'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Step 1 AM/PM' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'cleanser',
            actives: [{ name: 'Glycerin', concentrationPct: 5, optimalPh: 5.5 }],
            layeringStep: 1,
            waitTimeMinutes: 0,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: false,
            acclimationRamp: 'Daily',
            skinCyclingRole: 'cleanser',
            pregnancySafety: 'safe',
          },
        }),
      );

      const vitC = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Vitamin C 15% L-Ascorbic Serum',
          canonicalMolecule: 'vitamin-c-topical',
          aliases: ['L-Ascorbic Acid Serum'],
          tags: ['dermatology', 'antioxidant', 'vitamin_c', 'am_only'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'AM antioxidant serum' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'serum',
            actives: [{ name: 'L-Ascorbic Acid', concentrationPct: 15, optimalPh: 3.2 }],
            layeringStep: 3,
            waitTimeMinutes: 2,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily AM',
            skinCyclingRole: 'antioxidant',
            pregnancySafety: 'safe',
          },
        }),
      );

      const moisturizer = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Ceramide Barrier Cream',
          canonicalMolecule: 'ceramide-moisturizer',
          aliases: ['Ceramide Cream'],
          tags: ['dermatology', 'moisturizer', 'barrier'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Seal hydration AM/PM' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'cream',
            actives: [{ name: 'Ceramide NP', concentrationPct: 1, optimalPh: 5.5 }],
            layeringStep: 5,
            waitTimeMinutes: 1,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily',
            skinCyclingRole: 'recovery',
            pregnancySafety: 'safe',
          },
        }),
      );

      const spf = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Broad-Spectrum Mineral SPF 50',
          canonicalMolecule: 'mineral-spf-50',
          aliases: ['Zinc Oxide Sunscreen'],
          tags: ['dermatology', 'sunscreen', 'spf', 'am_only'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Final AM step' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'sunscreen',
            actives: [{ name: 'Zinc Oxide', concentrationPct: 20, optimalPh: 7.0 }],
            layeringStep: 7,
            waitTimeMinutes: 0,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily AM',
            skinCyclingRole: 'spf',
            pregnancySafety: 'safe',
          },
        }),
      );

      const tretinoin = await createCompound(api, fixtures.makeDermCompound());

      // Deliberately add stack items out of layeringStep order (7, 5, 3, 1, tret) to verify engine sorting
      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Derm AM/PM Layering Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: spf.id, doseAmount: 2, doseUnit: 'pumps' }),
            fixtures.makeStackItem({ compoundId: moisturizer.id, doseAmount: 1, doseUnit: 'pumps' }),
            fixtures.makeStackItem({ compoundId: vitC.id, doseAmount: 4, doseUnit: 'drops' }),
            fixtures.makeStackItem({ compoundId: cleanser.id, doseAmount: 1, doseUnit: 'pumps' }),
            fixtures.makeStackItem({ compoundId: tretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const skin = spread.dermatology.skin;

      assert.ok(Array.isArray(skin.am) && skin.am.length === 4, `Expected 4 AM steps, got: ${JSON.stringify(skin.am)}`);
      assert.ok(
        !skin.am.some((s) => s.compoundId === tretinoin.id),
        'Photosensitizing Tretinoin must NEVER be placed in skin.am',
      );

      // Verify strict ascending layering step order: Cleanser (1) -> Vit C (3) -> Moisturizer (5) -> SPF (7)
      const amOrder = skin.am.map((s) => s.compoundId);
      assert.deepEqual(
        amOrder,
        [cleanser.id, vitC.id, moisturizer.id, spf.id],
        `AM steps must be ordered strictly ascending by layeringStep (1 -> 3 -> 5 -> 7), got: ${JSON.stringify(skin.am)}`,
      );
      for (let i = 1; i < skin.am.length; i++) {
        assert.ok(
          skin.am[i].step >= skin.am[i - 1].step,
          `AM step numbers must be non-decreasing: ${skin.am[i - 1].step} -> ${skin.am[i].step}`,
        );
      }

      // Verify Tretinoin is routed to PM nights with waitTimeMinutes callout
      assert.ok(Array.isArray(skin.pmNights) && skin.pmNights.length >= 1, 'PM routine must include at least 1 night');
      const allPmSteps = skin.pmNights.flatMap((night) => night.steps || []);
      const tretStep = allPmSteps.find((s) => s.compoundId === tretinoin.id);
      assert.ok(tretStep, 'Tretinoin must appear in dermatology.skin.pmNights');
      assert.ok(
        typeof tretStep.waitTimeMinutes === 'number' && tretStep.waitTimeMinutes > 0,
        `Tretinoin PM step must preserve waitTimeMinutes callout, got: ${JSON.stringify(tretStep)}`,
      );

      assert.equal(
        skin.missingSpfWarning,
        null,
        `missingSpfWarning must be null when SPF 50 is in stack, got: ${JSON.stringify(skin.missingSpfWarning)}`,
      );
    });
  });

  it('T7: Dermatology alternating-night skin cycling (Tretinoin vs Glycolic Acid vs GHK-Cu; BPO wash in AM)', async () => {
    await withServer(async ({ api }) => {
      const tretinoin = await createCompound(
        api,
        fixtures.makeDermCompound({
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'aha_bha',
              severity: 'alternate_days',
              mechanism: 'Compounded barrier irritation and low-pH destabilization.',
              recommendation: 'Use AHA exfoliants on separate nights from retinoids.',
            },
            {
              targetType: 'class',
              targetRef: 'copper_peptide',
              severity: 'alternate_days',
              mechanism: 'Overlapping remodeling actives increase irritation risk.',
              recommendation: 'Alternate nights between Tretinoin and GHK-Cu serum.',
            },
            {
              targetType: 'compound',
              targetRef: 'benzoyl-peroxide',
              severity: 'avoid_same_slot',
              separationHours: 12,
              mechanism: 'Benzoyl peroxide oxidizes tretinoin on co-application.',
              recommendation: 'Use Benzoyl Peroxide in AM and Tretinoin in PM.',
            },
          ],
        }),
      );

      const glycolic = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Glycolic Acid 10% AHA Toner',
          canonicalMolecule: 'glycolic-acid',
          aliases: ['AHA Exfoliant'],
          tags: ['dermatology', 'aha', 'aha_bha', 'exfoliant', 'acid', 'photosensitizing', 'pm_only', 'skin_cycling_active'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: ['derm_am'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'PM exfoliation night' },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'retinoid',
              severity: 'alternate_days',
              mechanism: 'Concurrent strong AHA + retinoid damages stratum corneum.',
              recommendation: 'Schedule on alternating nights.',
            },
            {
              targetType: 'class',
              targetRef: 'copper_peptide',
              severity: 'alternate_days',
              mechanism: 'Low-pH glycolic acid dissociates copper peptide complexes.',
              recommendation: 'Keep on separate PM nights from GHK-Cu.',
            },
          ],
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
            acclimationRamp: '1-2 nights/week',
            skinCyclingRole: 'exfoliant',
            pregnancySafety: 'caution',
          },
        }),
      );

      const ghkSerum = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'GHK-Cu 2% Peptide Serum',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Tripeptide-1 Serum'],
          tags: ['dermatology', 'copper_peptide', 'ghk_cu', 'pm_only', 'skin_cycling_active'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'PM peptide recovery/remodeling night' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'serum',
            actives: [{ name: 'GHK-Cu', concentrationPct: 2, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 2,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: '2-3 nights/week',
            skinCyclingRole: 'copper_peptide',
            pregnancySafety: 'caution',
          },
        }),
      );

      const bpoWash = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Benzoyl Peroxide 4% Wash',
          canonicalMolecule: 'benzoyl-peroxide',
          aliases: ['BPO 4% Cleanser'],
          tags: ['dermatology', 'benzoyl_peroxide', 'cleanser'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Use in AM to avoid oxidizing PM tretinoin.' },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'retinoid',
              severity: 'avoid_same_slot',
              separationHours: 12,
              mechanism: 'Oxidative degradation of tretinoin.',
              recommendation: 'Place BPO wash in AM and Tretinoin in PM.',
            },
          ],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'cleanser',
            actives: [{ name: 'Benzoyl Peroxide', concentrationPct: 4, optimalPh: 5.5 }],
            layeringStep: 1,
            waitTimeMinutes: 1,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: false,
            acclimationRamp: 'AM wash',
            skinCyclingRole: 'cleanser',
            pregnancySafety: 'caution',
          },
        }),
      );

      const spf = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Daily Mineral SPF 50',
          canonicalMolecule: 'mineral-spf-50',
          aliases: ['SPF 50'],
          tags: ['dermatology', 'sunscreen', 'spf', 'am_only'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'AM SPF' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'sunscreen',
            actives: [{ name: 'Zinc Oxide', concentrationPct: 20, optimalPh: 7.0 }],
            layeringStep: 7,
            waitTimeMinutes: 0,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily',
            skinCyclingRole: 'spf',
            pregnancySafety: 'safe',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Skin Cycling Rotation Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: tretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
            fixtures.makeStackItem({ compoundId: glycolic.id, doseAmount: 5, doseUnit: 'drops' }),
            fixtures.makeStackItem({ compoundId: ghkSerum.id, doseAmount: 3, doseUnit: 'drops' }),
            fixtures.makeStackItem({ compoundId: bpoWash.id, doseAmount: 1, doseUnit: 'pumps' }),
            fixtures.makeStackItem({ compoundId: spf.id, doseAmount: 2, doseUnit: 'pumps' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const skin = spread.dermatology.skin;

      // BPO wash must be in AM and NEVER co-scheduled with Tretinoin on a PM night
      assert.ok(
        skin.am.some((s) => s.compoundId === bpoWash.id),
        `Benzoyl Peroxide wash must be routed to AM routine: ${JSON.stringify(skin.am)}`,
      );

      assert.ok(
        Array.isArray(skin.pmNights) && skin.pmNights.length >= 3,
        `Skin cycling with Tretinoin + Glycolic Acid + GHK-Cu must split into >= 3 distinct PM nights, got ${skin.pmNights?.length}: ${JSON.stringify(skin.pmNights)}`,
      );

      const incompatibleActives = [
        { id: tretinoin.id, label: 'Tretinoin' },
        { id: glycolic.id, label: 'Glycolic Acid' },
        { id: ghkSerum.id, label: 'GHK-Cu Serum' },
      ];
      const incompatibleIds = incompatibleActives.map((a) => a.id);
      const assignedDaysByActive = new Map(incompatibleIds.map((id) => [id, new Set()]));

      for (const night of skin.pmNights) {
        assert.ok(
          Array.isArray(night.daysOfWeek) && night.daysOfWeek.length > 0,
          `PM night "${night.nightLabel}" must specify daysOfWeek`,
        );
        for (const d of night.daysOfWeek) {
          assert.ok(
            Number.isInteger(d) && d >= 0 && d <= 6,
            `PM night "${night.nightLabel}" contains invalid dayOfWeek ${JSON.stringify(d)} (expected integer 0..6)`,
          );
        }
        const stepIds = new Set((night.steps || []).map((s) => s.compoundId));
        const presentIncompatibles = incompatibleIds.filter((id) => stepIds.has(id));
        assert.ok(
          presentIncompatibles.length <= 1,
          `PM night "${night.nightLabel}" must NOT mix incompatible actives (found ${presentIncompatibles.join(', ')})`,
        );
        if (stepIds.has(tretinoin.id)) {
          assert.ok(
            !stepIds.has(bpoWash.id),
            `Benzoyl Peroxide must NEVER share a PM night with Tretinoin ("${night.nightLabel}")`,
          );
        }
        for (const id of presentIncompatibles) {
          for (const d of night.daysOfWeek) {
            assignedDaysByActive.get(id).add(d);
          }
        }
      }

      for (const active of incompatibleActives) {
        assert.ok(
          assignedDaysByActive.get(active.id).size >= 1,
          `Incompatible PM active ${active.label} (${active.id}) must be scheduled on >= 1 alternating night`,
        );
      }

      // Pairwise disjointness: no two incompatible PM actives may share any dayOfWeek
      for (let i = 0; i < incompatibleActives.length; i++) {
        for (let j = i + 1; j < incompatibleActives.length; j++) {
          const a = incompatibleActives[i];
          const b = incompatibleActives[j];
          const daysA = assignedDaysByActive.get(a.id);
          const daysB = assignedDaysByActive.get(b.id);
          const overlap = [...daysA].filter((d) => daysB.has(d));
          assert.equal(
            overlap.length,
            0,
            `Alternating-night skin cycling must keep ${a.label} (${JSON.stringify([...daysA])}) and ${b.label} (${JSON.stringify([...daysB])}) pairwise disjoint; overlap=${JSON.stringify(overlap)}`,
          );
        }
      }

      assert.ok(
        Array.isArray(spread.interactions.alternateDayPairs) &&
          spread.interactions.alternateDayPairs.length > 0,
        `interactions.alternateDayPairs must report separated PM actives: ${JSON.stringify(spread.interactions)}`,
      );
    });
  });

  it('T8: Dermatology Hair/Scalp separation (Minoxidil & Ketoconazole isolated in hairScalp, never in skin)', async () => {
    await withServer(async ({ api }) => {
      const minoxidil = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Topical Minoxidil 5% Solution',
          canonicalMolecule: 'minoxidil',
          subsection: 'Hair & Scalp',
          aliases: ['Rogaine 5%'],
          tags: ['dermatology', 'hair', 'scalp', 'minoxidil'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Apply to dry scalp.' },
          dosages: { defaultAmount: 1, defaultUnit: 'mL', route: 'Topical', frequencyText: 'Once or twice daily', maxCeiling: 2 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'solution',
            actives: [{ name: 'Minoxidil', concentrationPct: 5, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily scalp application',
            skinCyclingRole: 'scalp_active',
            pregnancySafety: 'avoid',
          },
        }),
      );

      const ketoconazole = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Ketoconazole 2% Scalp Shampoo',
          canonicalMolecule: 'ketoconazole',
          subsection: 'Hair & Scalp',
          aliases: ['Nizoral 2%'],
          tags: ['dermatology', 'hair', 'scalp', 'shampoo', 'antifungal'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Leave on scalp 5 minutes twice weekly.' },
          dosages: { defaultAmount: 5, defaultUnit: 'mL', route: 'Topical', frequencyText: 'Twice weekly', maxCeiling: 15 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'shampoo',
            actives: [{ name: 'Ketoconazole', concentrationPct: 2, optimalPh: 6.5 }],
            layeringStep: 1,
            waitTimeMinutes: 5,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: false,
            acclimationRamp: '2x/week',
            skinCyclingRole: 'scalp_wash',
            pregnancySafety: 'caution',
          },
        }),
      );

      const tretinoin = await createCompound(api, fixtures.makeDermCompound());
      const spf = await createCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Facial Mineral SPF 50',
          canonicalMolecule: 'mineral-spf-50',
          aliases: ['SPF 50'],
          tags: ['dermatology', 'sunscreen', 'spf', 'am_only'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'AM facial SPF' },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'sunscreen',
            actives: [{ name: 'Zinc Oxide', concentrationPct: 20, optimalPh: 7.0 }],
            layeringStep: 7,
            waitTimeMinutes: 0,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: true,
            acclimationRamp: 'Daily',
            skinCyclingRole: 'spf',
            pregnancySafety: 'safe',
          },
        }),
      );

      const stack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Face + Hair/Scalp Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: minoxidil.id, doseAmount: 1, doseUnit: 'mL' }),
            fixtures.makeStackItem({
              compoundId: ketoconazole.id,
              doseAmount: 5,
              doseUnit: 'mL',
              frequency: '2x_week',
              cadence: { type: '2x_week', daysOfWeek: [1, 4] },
            }),
            fixtures.makeStackItem({ compoundId: tretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
            fixtures.makeStackItem({ compoundId: spf.id, doseAmount: 2, doseUnit: 'pumps' }),
          ],
        }),
      );

      const spread = await computeSchedule(api, 'member_husband', stack.id, { dateKey: '2026-10-19' });
      const skinIds = new Set([
        ...(spread.dermatology.skin.am || []).map((s) => s.compoundId),
        ...(spread.dermatology.skin.pmNights || []).flatMap((n) => (n.steps || []).map((s) => s.compoundId)),
      ]);
      const hairScalp = spread.dermatology.hairScalp;
      assert.ok(
        Array.isArray(hairScalp.am) && Array.isArray(hairScalp.pm) && Array.isArray(hairScalp.weekly),
        `hairScalp must expose am/pm/weekly arrays: ${JSON.stringify(hairScalp)}`,
      );
      const hairIds = new Set([
        ...hairScalp.am.map((s) => s.compoundId),
        ...hairScalp.pm.map((s) => s.compoundId),
        ...hairScalp.weekly.map((s) => s.compoundId),
      ]);

      assert.ok(hairIds.has(minoxidil.id), 'Topical Minoxidil must be placed in dermatology.hairScalp');
      assert.ok(hairIds.has(ketoconazole.id), 'Ketoconazole Shampoo must be placed in dermatology.hairScalp');
      assert.ok(!skinIds.has(minoxidil.id), 'Topical Minoxidil must NEVER be mixed into facial dermatology.skin');
      assert.ok(!skinIds.has(ketoconazole.id), 'Ketoconazole Shampoo must NEVER be mixed into facial dermatology.skin');

      assert.ok(skinIds.has(tretinoin.id), 'Facial Tretinoin must remain in dermatology.skin');
      assert.ok(skinIds.has(spf.id), 'Facial SPF 50 must remain in dermatology.skin');
      assert.ok(!hairIds.has(tretinoin.id), 'Facial Tretinoin must NEVER leak into dermatology.hairScalp');
      assert.ok(!hairIds.has(spf.id), 'Facial SPF 50 must NEVER leak into dermatology.hairScalp');
    });
  });

  it('T9: Cycle-phase awareness (cycleStatus) & weekly injection load balancing (weeklyGrid, injectionLoadByDay)', async () => {
    await withServer(async ({ api }) => {
      const testCyp = await createCompound(
        api,
        fixtures.makePedCompound({
          cycles: { patternText: '8 weeks on, 4 weeks off', cycleDays: 56, offDays: 28, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const tb500 = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'TB-500',
          canonicalMolecule: 'tb-500',
          aliases: ['Thymosin Beta-4 Fragment'],
          tags: ['peptide', 'healing', 'subq'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Twice weekly SubQ.' },
          dosages: { defaultAmount: 2.5, defaultUnit: 'mg', route: 'SubQ', frequencyText: '2x/week', maxCeiling: 10 },
          cycles: { patternText: '6 weeks on, 2 weeks off', cycleDays: 42, offDays: 14, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const motsc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'MOTS-c Injectable',
          canonicalMolecule: 'mots-c',
          aliases: ['MOTS-c'],
          tags: ['peptide', 'mitochondrial', 'subq'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Twice weekly SubQ.' },
          dosages: { defaultAmount: 5, defaultUnit: 'mg', route: 'SubQ', frequencyText: '2x/week', maxCeiling: 15 },
          cycles: { patternText: '6 weeks on, 4 weeks off', cycleDays: 42, offDays: 28, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const upcomingBpc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'BPC-157 Future Cycle',
          canonicalMolecule: 'bpc-157',
          aliases: ['BPC-157'],
          cycles: { patternText: '6 weeks on, 3 weeks off', cycleDays: 42, offDays: 21, continuous: false },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const stack = await createStack(
        api,
        'member_husband',
        fixtures.makeStackPayload({
          name: 'Cycle & Injection Load Stack',
          memberId: 'member_husband',
          items: [
            makeUnpinnedAutoCadenceItem(testCyp.id, {
              doseAmount: 60,
              doseUnit: 'mg',
              frequency: '2x_week',
              cadence: { type: '2x_week' },
              cycleStartDate: '2026-10-01',
              cycle: { startDate: '2026-10-01', cycleDays: 56, offDays: 28 },
            }),
            makeUnpinnedAutoCadenceItem(tb500.id, {
              doseAmount: 2.5,
              doseUnit: 'mg',
              frequency: '2x_week',
              cadence: { type: '2x_week' },
              cycleStartDate: '2026-09-10',
              cycle: { startDate: '2026-09-10', cycleDays: 42, offDays: 14 },
            }),
            makeUnpinnedAutoCadenceItem(motsc.id, {
              doseAmount: 5,
              doseUnit: 'mg',
              frequency: '2x_week',
              cadence: { type: '2x_week' },
              cycleStartDate: '2026-10-05',
              cycle: { startDate: '2026-10-05', cycleDays: 42, offDays: 28 },
            }),
            makeUnpinnedAutoCadenceItem(upcomingBpc.id, {
              doseAmount: 250,
              doseUnit: 'mcg',
              frequency: 'mwf',
              cadence: { type: 'mwf' },
              cycleStartDate: '2026-11-05',
              cycle: { startDate: '2026-11-05', cycleDays: 42, offDays: 21 },
            }),
          ],
        }),
      );

      // Reference date: 2026-10-20 -> Test Cyp active (day 20/56), TB-500 ending_soon (day 41/42),
      // MOTS-c active (day 16/42), BPC-157 upcoming (starts 2026-11-05).
      const spread = await computeSchedule(api, 'member_husband', stack.id, { dateKey: '2026-10-20' });

      assert.ok(spread.systemic.weeklyGrid && typeof spread.systemic.weeklyGrid === 'object');
      assert.ok(spread.systemic.injectionLoadByDay && typeof spread.systemic.injectionLoadByDay === 'object');

      let totalWeeklyInjections = 0;
      let daysWithInjections = 0;
      let peakDayLoad = 0;

      for (let d = 0; d <= 6; d++) {
        const key = String(d);
        assert.ok(
          Array.isArray(spread.systemic.weeklyGrid[key]),
          `weeklyGrid["${key}"] must be an array`,
        );
        const load = spread.systemic.injectionLoadByDay[key];
        assert.ok(
          typeof load === 'number' && Number.isInteger(load) && load >= 0,
          `injectionLoadByDay["${key}"] must be a non-negative integer, got ${load}`,
        );
        totalWeeklyInjections += load;
        if (load > 0) daysWithInjections += 1;
        if (load > peakDayLoad) peakDayLoad = load;
      }

      // Three active 2x/week injectables produce >= 6 weekly injections distributed across >= 3 days
      // with balanced peak load (never piling all 3 onto the exact same day).
      assert.ok(
        totalWeeklyInjections >= 6,
        `Expected >= 6 total weekly injections across 3 active 2x/wk injectables, got ${totalWeeklyInjections} (${JSON.stringify(spread.systemic.injectionLoadByDay)})`,
      );
      assert.ok(
        daysWithInjections >= 3,
        `Injections must be spread across >= 3 days, got ${daysWithInjections} (${JSON.stringify(spread.systemic.injectionLoadByDay)})`,
      );
      assert.ok(
        peakDayLoad <= 2,
        `Weekly injection load balancer should avoid piling all 3 2x/wk injectables onto one day; peak=${peakDayLoad} (${JSON.stringify(spread.systemic.injectionLoadByDay)})`,
      );

      // Verify cycleStatus objects on active, ending_soon, and upcoming items
      const testPos = findSystemicPlacement(spread, testCyp.id);
      const tbPos = findSystemicPlacement(spread, tb500.id);
      const bpcPos = findSystemicPlacement(spread, upcomingBpc.id);

      assert.ok(testPos && testPos.item.cycleStatus && typeof testPos.item.cycleStatus === 'object');
      assert.match(
        extractCyclePhaseText(testPos.item.cycleStatus),
        /active/i,
        `Test Cyp on day 20/56 must report active cycleStatus: ${JSON.stringify(testPos.item.cycleStatus)}`,
      );

      assert.ok(tbPos && tbPos.item.cycleStatus && typeof tbPos.item.cycleStatus === 'object');
      assert.ok(
        /ending/i.test(extractCyclePhaseText(tbPos.item.cycleStatus)) ||
          tbPos.item.cycleStatus.endingSoon === true,
        `TB-500 on day 41/42 (1 day remaining) must report ending_soon cycleStatus (or endingSoon=true): ${JSON.stringify(tbPos.item.cycleStatus)}`,
      );

      if (bpcPos) {
        assert.ok(bpcPos.item.cycleStatus && typeof bpcPos.item.cycleStatus === 'object');
        assert.match(
          extractCyclePhaseText(bpcPos.item.cycleStatus),
          /upcoming/i,
          `Future-start BPC-157 must report upcoming cycleStatus: ${JSON.stringify(bpcPos.item.cycleStatus)}`,
        );
      } else {
        const allGridIds = Object.values(spread.systemic.weeklyGrid)
          .flat()
          .map((e) => (typeof e === 'string' ? e : e?.compoundId));
        assert.ok(
          !allGridIds.includes(upcomingBpc.id),
          'Future-start BPC-157 omitted from slots must also not be scheduled as active in weeklyGrid',
        );
      }
    });
  });

  it('T10: Explainable placement rationale (rationale[]) + user pin override honored & reversible via unpin', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          timingRules: {
            preferredSlots: ['waking_fasted'],
            avoidSlots: [],
            foodState: 'fasted',
            fastingWindowHours: 1,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Fasted waking administration.',
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const mag = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Pin Override Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: bpc.id, doseAmount: 250, doseUnit: 'mcg', pinnedSlot: null }),
            fixtures.makeStackItem({ compoundId: mag.id, doseAmount: 200, doseUnit: 'mg', pinnedSlot: 'midday_lunch' }),
          ],
        }),
      );

      const spreadPinned = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });

      const bpcPos = findSystemicPlacement(spreadPinned, bpc.id);
      const magPinnedPos = findSystemicPlacement(spreadPinned, mag.id);

      assert.ok(bpcPos && magPinnedPos, 'Both items must be scheduled');
      assert.equal(bpcPos.slot.slotId, 'waking_fasted');
      assert.equal(bpcPos.item.pinned, false);
      assert.ok(
        Array.isArray(bpcPos.item.rationale) &&
          bpcPos.item.rationale.length > 0 &&
          bpcPos.item.rationale.every((r) => typeof r === 'string' && r.trim().length > 0),
        `Unpinned item must include non-empty rationale[] strings: ${JSON.stringify(bpcPos.item)}`,
      );

      // Pinned Magnesium must override its default evening slot and land in midday_lunch
      assert.equal(
        magPinnedPos.slot.slotId,
        'midday_lunch',
        `Pinned Magnesium Glycinate must honor pinnedSlot="midday_lunch", got "${magPinnedPos.slot.slotId}"`,
      );
      assert.equal(magPinnedPos.item.pinned, true);
      assert.ok(
        Array.isArray(magPinnedPos.item.rationale) && magPinnedPos.item.rationale.length > 0,
        `Pinned item must still carry rationale[] chips: ${JSON.stringify(magPinnedPos.item)}`,
      );

      // Unpin Magnesium and verify solver restores it to evening_dinner / bedtime_fasted
      const unpinRes = await api.patch(
        `/api/v1/members/member_wife/stacks/${encodeURIComponent(stack.id)}`,
        {
          items: [
            fixtures.makeStackItem({ compoundId: bpc.id, doseAmount: 250, doseUnit: 'mcg', pinnedSlot: null }),
            fixtures.makeStackItem({ compoundId: mag.id, doseAmount: 200, doseUnit: 'mg', pinnedSlot: null }),
          ],
        },
      );
      assert.equal(unpinRes.status, 200, `PATCH unpin failed: ${unpinRes.text}`);

      const spreadUnpinned = await computeSchedule(api, 'member_wife', stack.id, { dateKey: '2026-10-19' });
      const magUnpinnedPos = findSystemicPlacement(spreadUnpinned, mag.id);
      assert.ok(magUnpinnedPos);
      assert.equal(magUnpinnedPos.item.pinned, false);
      assert.ok(
        magUnpinnedPos.slot.slotId === 'evening_dinner' || magUnpinnedPos.slot.slotId === 'bedtime_fasted',
        `Unpinned Magnesium Glycinate should return to evening_dinner/bedtime_fasted, got "${magUnpinnedPos.slot.slotId}"`,
      );
    });
  });

  it('T11: Non-mutating What-If wishlist simulation previews slots, conflicts & shopping list without altering persisted stack', async () => {
    await withServer(async ({ api }) => {
      const vitD3 = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3 2000 IU',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_fat', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning with fat' },
          dosages: { defaultAmount: 2000, defaultUnit: 'IU', route: 'Oral', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Cholecalciferol', supplementFacts: [{ nutrient: 'Vitamin D3', amount: 2000, unit: 'IU' }], adultUpperLimit: { nutrientKey: 'vitamin_d', amount: 4000, unit: 'IU', basis: 'total' } },
        }),
      );

      const zinc = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Zinc Picolinate',
          canonicalMolecule: 'zinc',
          aliases: ['Zinc'],
          tags: ['supplement', 'mineral', 'zinc'],
          timingRules: { preferredSlots: ['morning_am', 'midday_lunch'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'With meal' },
          dosages: { defaultAmount: 30, defaultUnit: 'mg', route: 'Oral', maxCeiling: 40 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'copper',
              severity: 'avoid_same_slot',
              separationHours: 3,
              mechanism: 'Competitive intestinal absorption.',
              recommendation: 'Separate Zinc and Copper by 2-4 hours.',
            },
          ],
          synergies: [],
          sectionData: { chemicalForm: 'Zinc Picolinate', supplementFacts: [{ nutrient: 'Zinc', amount: 30, unit: 'mg' }], adultUpperLimit: { nutrientKey: 'zinc', amount: 40, unit: 'mg', basis: 'total' } },
        }),
      );

      const wishlistCopper = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Copper Wishlist Supplement',
          canonicalMolecule: 'copper',
          aliases: ['Copper'],
          tags: ['supplement', 'mineral', 'copper'],
          timingRules: { preferredSlots: ['morning_am', 'midday_lunch', 'evening_dinner'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Separate from Zinc' },
          dosages: { defaultAmount: 2, defaultUnit: 'mg', route: 'Oral', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Copper Bisglycinate', supplementFacts: [{ nutrient: 'Copper', amount: 2, unit: 'mg' }], adultUpperLimit: { nutrientKey: 'copper', amount: 10, unit: 'mg', basis: 'total' } },
        }),
      );

      await setOwnership(api, vitD3.id, { scope: 'household', status: 'have' });
      await setOwnership(api, zinc.id, { scope: 'household', status: 'have' });
      await setOwnership(api, wishlistCopper.id, { scope: 'household', status: 'wishlist' });

      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'What-If Baseline Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: vitD3.id, doseAmount: 2000, doseUnit: 'IU' }),
            fixtures.makeStackItem({ compoundId: zinc.id, doseAmount: 30, doseUnit: 'mg' }),
          ],
        }),
      );

      const whatIfSpread = await computeSchedule(api, 'member_wife', stack.id, {
        dateKey: '2026-10-19',
        whatIfCompounds: [
          { compoundId: wishlistCopper.id, doseAmount: 2, doseUnit: 'mg', frequency: 'daily' },
        ],
      });

      const copperPos = findSystemicPlacement(whatIfSpread, wishlistCopper.id);
      const zincPos = findSystemicPlacement(whatIfSpread, zinc.id);
      const d3Pos = findSystemicPlacement(whatIfSpread, vitD3.id);

      assert.ok(copperPos, 'What-If wishlist compound must be included in preview schedule');
      assert.equal(copperPos.item.isWhatIf, true, 'What-If compound must be tagged isWhatIf === true');
      assert.equal(zincPos.item.isWhatIf, false, 'Existing stack item must have isWhatIf === false');
      assert.equal(d3Pos.item.isWhatIf, false, 'Existing stack item must have isWhatIf === false');

      assert.notEqual(
        zincPos.slot.slotId,
        copperPos.slot.slotId,
        'What-If simulation must run the full conflict solver and separate Zinc from What-If Copper',
      );
      assert.ok(
        whatIfSpread.stockSummary.missing.some((m) => m.compoundId === wishlistCopper.id),
        `What-If wishlist item must appear in stockSummary.missing: ${JSON.stringify(whatIfSpread.stockSummary)}`,
      );
      assert.equal(whatIfSpread.stockSummary.total, 3);
      assert.equal(whatIfSpread.stockSummary.have, 2);

      // Confirm persisted stack was NOT mutated by What-If simulation
      const stacksAfterRes = await api.get('/api/v1/members/member_wife/stacks');
      assert.equal(stacksAfterRes.status, 200);
      const stacksAfter = unwrapData(stacksAfterRes.json, ['stacks']);
      const persisted = stacksAfter.find((s) => s.id === stack.id);
      assert.ok(persisted, 'Baseline stack must still exist');
      assert.equal(persisted.items.length, 2, 'What-If simulation must NEVER mutate persisted stack item count');
      assert.ok(
        !persisted.items.some((i) => i.compoundId === wishlistCopper.id),
        'What-If compound must NEVER be persisted onto the stack',
      );
    });
  });

  it('T12: Bidirectional interaction analysis endpoint returns complete categorized InteractionAnalysis', async () => {
    await withServer(async ({ api }) => {
      // Only compound A declares rules; B, C, D, and E have empty rule arrays to prove bidirectional detection.
      const betaMineral = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Beta Synthetic Mineral',
          canonicalMolecule: 'beta-synthetic-mineral',
          aliases: ['BetaMin'],
          tags: ['synthetic_beta'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning' },
          dosages: { defaultAmount: 10, defaultUnit: 'mg', route: 'Oral', maxCeiling: 50 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Synthetic Chelate', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      const gammaBotanical = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Gamma Botanical Extract',
          canonicalMolecule: 'gamma-botanical',
          aliases: ['GammaExt'],
          tags: ['gamma_class'],
          timingRules: { preferredSlots: ['midday_lunch'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Midday' },
          dosages: { defaultAmount: 200, defaultUnit: 'mg', route: 'Oral', maxCeiling: 600 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Extract', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      const deltaCofactor = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Delta Enzymatic Cofactor',
          canonicalMolecule: 'delta-cofactor',
          aliases: ['DeltaCo'],
          tags: ['synthetic_delta'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning' },
          dosages: { defaultAmount: 50, defaultUnit: 'mg', route: 'Oral', maxCeiling: 200 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Active Cofactor', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      const epsilonAlternate = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Epsilon Alternate-Day Active',
          canonicalMolecule: 'epsilon-alternate',
          aliases: ['EpsilonAlt'],
          tags: ['synthetic_epsilon'],
          timingRules: { preferredSlots: ['evening_dinner'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Evening' },
          dosages: { defaultAmount: 25, defaultUnit: 'mg', route: 'Oral', maxCeiling: 100 },
          doNotPairWith: [],
          synergies: [],
          sectionData: { chemicalForm: 'Synthetic Active', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      const alphaChelate = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Alpha Synthetic Chelate',
          canonicalMolecule: 'alpha-synthetic-chelate',
          aliases: ['AlphaChe'],
          tags: ['synthetic_alpha'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Morning' },
          dosages: { defaultAmount: 15, defaultUnit: 'mg', route: 'Oral', maxCeiling: 60 },
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef: 'beta-synthetic-mineral',
              severity: 'avoid_same_slot',
              separationHours: 3,
              mechanism: 'Shared divalent uptake carrier.',
              recommendation: 'Separate Alpha and Beta by 3 hours.',
            },
            {
              targetType: 'compound',
              targetRef: 'epsilon-alternate',
              severity: 'alternate_days',
              mechanism: 'Overlapping receptor desensitization pathway.',
              recommendation: 'Use Alpha and Epsilon on alternating days.',
            },
            {
              targetType: 'class',
              targetRef: 'gamma_class',
              severity: 'caution',
              mechanism: 'Additive mild gastrointestinal sensitivity.',
              recommendation: 'Monitor GI tolerance when combining.',
            },
          ],
          synergies: [
            {
              targetRef: 'delta-cofactor',
              coLocate: true,
              reason: 'Delta acts as direct enzymatic cofactor for Alpha.',
            },
          ],
          sectionData: { chemicalForm: 'Synthetic Chelate', supplementFacts: [], adultUpperLimit: null },
        }),
      );

      // Put Beta/Gamma/Delta/Epsilon BEFORE Alpha in items[] to prove order-independent bidirectional matching
      const stack = await createStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Bidirectional Analysis Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: betaMineral.id, doseAmount: 10, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: gammaBotanical.id, doseAmount: 200, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: deltaCofactor.id, doseAmount: 50, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: epsilonAlternate.id, doseAmount: 25, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: alphaChelate.id, doseAmount: 15, doseUnit: 'mg' }),
          ],
        }),
      );

      const analysis = await computeInteractions(api, 'member_wife', stack.id);

      const requiredArrayKeys = [
        'hardStops',
        'avoidSameSlot',
        'alternateDays',
        'cautions',
        'synergies',
        'ulWarnings',
        'redundancies',
        'safetyAlerts',
      ];
      for (const key of requiredArrayKeys) {
        assert.ok(
          Array.isArray(analysis[key]),
          `InteractionAnalysis.${key} must be an array, got: ${JSON.stringify(analysis)}`,
        );
      }
      assert.ok(
        analysis.summary !== undefined && analysis.summary !== null,
        `InteractionAnalysis.summary must be defined: ${JSON.stringify(analysis)}`,
      );

      assert.equal(analysis.hardStops.length, 0, 'No hard-stops should be reported for benign synthetic pair');
      assert.ok(
        analysis.avoidSameSlot.some((e) =>
          entryMentionsAll(e, [
            ['alpha', alphaChelate.id],
            ['beta', betaMineral.id],
          ]),
        ),
        `Bidirectional avoidSameSlot must match Alpha <-> Beta: ${JSON.stringify(analysis.avoidSameSlot)}`,
      );
      assert.ok(
        analysis.alternateDays.some((e) =>
          entryMentionsAll(e, [
            ['alpha', alphaChelate.id],
            ['epsilon', epsilonAlternate.id],
          ]),
        ),
        `Bidirectional alternateDays must match Alpha <-> Epsilon: ${JSON.stringify(analysis.alternateDays)}`,
      );
      assert.ok(
        analysis.cautions.some((e) =>
          entryMentionsAll(e, [
            ['alpha', alphaChelate.id],
            ['gamma', gammaBotanical.id],
          ]),
        ),
        `Class-tag caution must match Alpha <-> Gamma: ${JSON.stringify(analysis.cautions)}`,
      );
      assert.ok(
        analysis.synergies.some((e) =>
          entryMentionsAll(e, [
            ['alpha', alphaChelate.id],
            ['delta', deltaCofactor.id],
          ]),
        ),
        `Synergies must match Alpha <-> Delta: ${JSON.stringify(analysis.synergies)}`,
      );
    });
  });
});
