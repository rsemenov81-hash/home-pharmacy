import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  unwrapData,
  fixtures,
} from '../harness.mjs';

function assertNoStore(res, label) {
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /no-store/i, `${label}: expected Cache-Control: no-store, got "${cc}"`);
}

function assertStatusIn(res, allowed, label) {
  assert.ok(
    allowed.includes(res.status),
    `${label}: expected HTTP status in [${allowed.join(', ')}], got ${res.status} (${res.text.slice(0, 400)})`,
  );
}

function getId(obj) {
  return obj?.id ?? obj?.compoundId ?? obj?.stackId ?? null;
}

function collectSystemicItems(spread) {
  return (spread?.systemic?.slots ?? []).flatMap((slot) =>
    (slot.items ?? []).map((item) => ({
      ...item,
      slotId: slot.slotId,
      suggestedTime: slot.suggestedTime,
    })),
  );
}

function collectDermSkinAmIds(spread) {
  return (spread?.dermatology?.skin?.am ?? []).map((i) => i.compoundId).filter(Boolean);
}

function collectDermSkinPmIds(spread) {
  return (spread?.dermatology?.skin?.pmNights ?? []).flatMap((night) =>
    (night.steps ?? []).map((step) => step.compoundId).filter(Boolean),
  );
}

function collectHairScalpIds(spread) {
  const hs = spread?.dermatology?.hairScalp ?? {};
  return [...(hs.am ?? []), ...(hs.pm ?? []), ...(hs.weekly ?? [])]
    .map((item) => item.compoundId)
    .filter(Boolean);
}

const CANONICAL_SYSTEMIC_SLOTS = new Set([
  'waking_fasted',
  'morning_am',
  'pre_workout',
  'intra_post_workout',
  'midday_lunch',
  'evening_dinner',
  'bedtime_fasted',
  'prn',
]);

function collectWeeklyGridCompoundIds(spread) {
  const grid = spread?.systemic?.weeklyGrid;
  if (!grid || typeof grid !== 'object') return [];
  const ids = [];
  for (const entries of Object.values(grid)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const cid = typeof entry === 'string' ? entry : entry?.compoundId ?? entry?.id;
      if (cid) ids.push(cid);
    }
  }
  return ids;
}

function collectAllScheduledCompoundIds(spread) {
  return new Set([
    ...collectSystemicItems(spread).map((i) => i.compoundId).filter(Boolean),
    ...collectWeeklyGridCompoundIds(spread),
    ...collectDermSkinAmIds(spread),
    ...collectDermSkinPmIds(spread),
    ...collectHairScalpIds(spread),
  ]);
}

function assertAscendingSteps(items, label) {
  let prev = 0;
  for (let i = 0; i < items.length; i += 1) {
    const step = items[i]?.step;
    assert.ok(
      Number.isInteger(step) && step >= 1 && step <= 7,
      `${label}: every derm item must carry an integer layering step in 1..7, got ${JSON.stringify(items[i])}`,
    );
    assert.ok(
      step >= prev,
      `${label}: steps must be in ascending order (step ${prev} before step ${step})`,
    );
    prev = step;
  }
}

function normalizeSpreadForDeterminism(spread) {
  return {
    systemic: (spread?.systemic?.slots ?? []).map((s) => ({
      slotId: s.slotId,
      suggestedTime: s.suggestedTime,
      items: (s.items ?? []).map((i) => i.compoundId).sort(),
    })),
    dermAm: (spread?.dermatology?.skin?.am ?? []).map((i) => ({ step: i.step, compoundId: i.compoundId })),
    dermPm: (spread?.dermatology?.skin?.pmNights ?? []).map((n) => ({
      theme: n.theme,
      daysOfWeek: n.daysOfWeek,
      steps: (n.steps ?? []).map((s) => ({ step: s.step, compoundId: s.compoundId })),
    })),
    hairScalp: {
      am: (spread?.dermatology?.hairScalp?.am ?? []).map((i) => i.compoundId).sort(),
      pm: (spread?.dermatology?.hairScalp?.pm ?? []).map((i) => i.compoundId).sort(),
      weekly: (spread?.dermatology?.hairScalp?.weekly ?? []).map((i) => i.compoundId).sort(),
    },
  };
}

function assertAlertMatches(entries, pattern, label) {
  assert.ok(Array.isArray(entries) && entries.length > 0, `${label}: expected non-empty alert list`);
  const match = entries.find((entry) => pattern.test(JSON.stringify(entry)));
  assert.ok(match, `${label}: expected alert matching ${pattern}, got ${JSON.stringify(entries)}`);
  const text =
    typeof match === 'string'
      ? match
      : match.recommendation || match.mechanism || match.message || match.reason || match.summary || JSON.stringify(match);
  assert.ok(typeof text === 'string' && text.trim().length > 0, `${label}: alert must include non-empty rationale`);
  return match;
}

function assertMultiRouteAlert(alerts, moleculeRe, idA, idB, label) {
  assert.ok(Array.isArray(alerts) && alerts.length > 0, `${label}: expected non-empty alert list`);
  const multiRouteSemanticsRe =
    /multi.?route|cumulative|same.?molecule|dual.?route|multiple.?route|systemic.*topical|topical.*systemic|overlap|redundan/i;
  const matched = alerts.find((entry) => {
    const serialized = JSON.stringify(entry);
    const hasMolecule = moleculeRe.test(serialized) || serialized.includes(idA) || serialized.includes(idB);
    const hasMultiRouteSemantics =
      multiRouteSemanticsRe.test(serialized) || (serialized.includes(idA) && serialized.includes(idB));
    return hasMolecule && hasMultiRouteSemantics;
  });
  assert.ok(
    matched,
    `${label}: expected a single alert matching both molecule identity and multi-route/cumulative semantics (or referencing both ${idA} & ${idB}), got ${JSON.stringify(alerts)}`,
  );
  return matched;
}

describe('Tier 4 — Complex Cross-Section Stack Spreading & High-Risk Safety Scenarios', () => {
  it('Scenario 5 — Comprehensive 24-compound anti-aging & performance stack across all 4 sections (skin cycling, mineral separation, microneedling buffer, hair/scalp, What-If & pin override)', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      // Configure Husband routineAnchors explicitly for deterministic clock checks
      assert.equal(
        (
          await admin.patch('/api/v1/members/member_husband', {
            name: 'Marcus',
            routineAnchors: {
              wake: '07:00',
              breakfast: '08:00',
              workout: '06:30',
              workoutDays: [1, 3, 5],
              lunch: '13:00',
              dinner: '19:00',
              bed: '22:30',
              tz: 'UTC',
            },
            safetyContext: {
              pregnancyOrTrying: false,
              biologicalSexContext: 'male',
              allergies: [],
              activeRxMeds: [],
              conditions: [],
            },
          })
        ).status,
        200,
      );

      const createCompound = async (payload, ownershipStatus = 'have') => {
        const res = await admin.post('/api/v1/compounds', payload);
        assertStatusIn(res, [200, 201], `Create ${payload.name}`);
        const cmp = unwrapData(res.json, ['compound']);
        const id = getId(cmp);
        assert.ok(id, `Expected ID for ${payload.name}`);
        const ownRes = await admin.put(`/api/v1/ownership/${id}`, {
          scope: 'member:member_husband',
          status: ownershipStatus,
        });
        assertStatusIn(ownRes, [200, 201], `Set ownership for ${payload.name}`);
        return id;
      };

      // --- PEPTIDES (4) ---
      const tesamorelinId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'Tesamorelin',
          canonicalMolecule: 'tesamorelin',
          aliases: ['Egrifta'],
          tags: ['peptide', 'ghrh', 'fasted_am', 'subq'],
          timingRules: {
            preferredSlots: ['waking_fasted'],
            avoidSlots: ['morning_am', 'midday_lunch', 'evening_dinner'],
            foodState: 'fasted',
            fastingWindowHours: 1,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Administer fasted upon waking.',
          },
          doNotPairWith: [],
          synergies: [],
          dosages: { rangeText: '1 mg daily SubQ', defaultAmount: 1, defaultUnit: 'mg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 2 },
        }),
      );

      const ipamorelinId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'Ipamorelin',
          canonicalMolecule: 'ipamorelin',
          aliases: ['NNC 26-0161'],
          tags: ['peptide', 'ghrp', 'fasted_bedtime', 'subq'],
          timingRules: {
            preferredSlots: ['bedtime_fasted'],
            avoidSlots: ['morning_am', 'midday_lunch'],
            foodState: 'fasted',
            fastingWindowHours: 2,
            workoutRelation: 'any',
            circadianEffect: 'sedating',
            timingNotes: 'Take fasted at bedtime alongside CJC-1295.',
          },
          doNotPairWith: [],
          synergies: [{ targetRef: 'cjc-1295', coLocate: true, reason: 'Synergistic GHRH + GHRP nocturnal pulse' }],
          dosages: { rangeText: '200 mcg bedtime SubQ', defaultAmount: 200, defaultUnit: 'mcg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 500 },
        }),
      );

      const cjc1295Id = await createCompound(
        fixtures.makePeptideCompound({
          name: 'CJC-1295',
          canonicalMolecule: 'cjc-1295',
          aliases: ['Mod GRF 1-29'],
          tags: ['peptide', 'ghrh', 'fasted_bedtime', 'subq'],
          timingRules: {
            preferredSlots: ['bedtime_fasted'],
            avoidSlots: ['morning_am', 'midday_lunch'],
            foodState: 'fasted',
            fastingWindowHours: 2,
            workoutRelation: 'any',
            circadianEffect: 'sedating',
            timingNotes: 'Co-administer fasted at bedtime with Ipamorelin.',
          },
          doNotPairWith: [],
          synergies: [{ targetRef: 'ipamorelin', coLocate: true, reason: 'Synergistic GHRH + GHRP nocturnal pulse' }],
          dosages: { rangeText: '100 mcg bedtime SubQ', defaultAmount: 100, defaultUnit: 'mcg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 300 },
        }),
      );

      const ghkSubqId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'GHK-Cu',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Tripeptide-1'],
          tags: ['peptide', 'copper_peptide', 'subq'],
          timingRules: {
            preferredSlots: ['morning_am'],
            avoidSlots: [],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Morning SubQ administration.',
          },
          doNotPairWith: [],
          synergies: [],
          dosages: { rangeText: '1.5 mg daily SubQ', defaultAmount: 1.5, defaultUnit: 'mg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 5 },
        }),
      );

      // --- PEDs (1) ---
      const testCypId = await createCompound(
        fixtures.makePedCompound({
          name: 'Testosterone Cypionate',
          canonicalMolecule: 'testosterone-cypionate',
          dosages: { rangeText: '60 mg 2x/week IM', defaultAmount: 60, defaultUnit: 'mg', route: 'IM', frequencyText: '2x/week', maxCeiling: 250 },
        }),
      );

      // --- VITAMINS & SUPPLEMENTS (9) ---
      const vitD3Id = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with a fat-containing meal alongside K2 and Omega-3.',
          },
          dosages: { rangeText: '2000 IU daily', defaultAmount: 2000, defaultUnit: 'IU', route: 'Oral', frequencyText: 'Daily', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'vitamin-k2', coLocate: true, reason: 'Calcium trafficking synergy' },
            { targetRef: 'omega-3', coLocate: true, reason: 'Enhanced lipid-soluble absorption' },
          ],
          sectionData: {
            chemicalForm: 'Cholecalciferol (Vitamin D3)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Vitamin D3 (Cholecalciferol)', amount: 2000, unit: 'IU' }],
            adultUpperLimit: {
              nutrientKey: 'vitamin_d',
              amount: 4000,
              unit: 'IU',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/',
            },
          },
        }),
      );

      const vitK2Id = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Vitamin K2 (MK-7)',
          canonicalMolecule: 'vitamin-k2',
          aliases: ['Menaquinone-7'],
          tags: ['supplement', 'vitamin', 'vitamin_k2', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with fat alongside Vitamin D3 and Omega-3.',
          },
          dosages: { rangeText: '100 mcg daily', defaultAmount: 100, defaultUnit: 'mcg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 500 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'vitamin-d3', coLocate: true, reason: 'Co-locate with Vitamin D3' },
            { targetRef: 'omega-3', coLocate: true, reason: 'Fat-soluble absorption synergy' },
          ],
          sectionData: {
            chemicalForm: 'Menaquinone-7 (MK-7)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Vitamin K2 (as MK-7)', amount: 100, unit: 'mcg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const omega3Id = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Omega-3 Fish Oil',
          canonicalMolecule: 'omega-3',
          aliases: ['EPA/DHA', 'Fish Oil'],
          tags: ['supplement', 'omega3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch'],
            avoidSlots: [],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Provides dietary lipids for fat-soluble vitamins.',
          },
          dosages: { rangeText: '2000 mg daily', defaultAmount: 2000, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [
            { targetRef: 'vitamin-d3', coLocate: true, reason: 'Lipid carrier for Vitamin D3' },
            { targetRef: 'vitamin-k2', coLocate: true, reason: 'Lipid carrier for Vitamin K2' },
          ],
          sectionData: {
            chemicalForm: 'Triglyceride Fish Oil (EPA/DHA)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Omega-3 Fatty Acids (EPA/DHA)', amount: 2000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      const zincId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Zinc Picolinate',
          canonicalMolecule: 'zinc',
          aliases: ['Zinc'],
          tags: ['supplement', 'mineral', 'zinc'],
          timingRules: {
            preferredSlots: ['morning_am', 'midday_lunch'],
            avoidSlots: [],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with food; separate from copper.',
          },
          dosages: { rangeText: '30 mg daily', defaultAmount: 30, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 40 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'copper',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Metallothionein induction competes with copper uptake',
              recommendation: 'Separate Zinc and Copper by at least 2 hours',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: 'Zinc Picolinate',
            elementalWeightMg: 30,
            supplementFacts: [{ nutrient: 'Zinc (as Zinc Picolinate)', amount: 30, unit: 'mg' }],
            adultUpperLimit: {
              nutrientKey: 'zinc',
              amount: 40,
              unit: 'mg',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/Zinc-HealthProfessional/',
            },
          },
        }),
      );

      const copperId = await createCompound(
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
            timingNotes: 'Separate from zinc by >=2 hours.',
          },
          dosages: { rangeText: '2 mg daily', defaultAmount: 2, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 10 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'zinc',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Competitive intestinal absorption with zinc',
              recommendation: 'Separate Copper from Zinc by >=2 hours',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: 'Copper Bisglycinate Chelate',
            elementalWeightMg: 2,
            supplementFacts: [{ nutrient: 'Copper (as Copper Bisglycinate)', amount: 2, unit: 'mg' }],
            adultUpperLimit: {
              nutrientKey: 'copper',
              amount: 10,
              unit: 'mg',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/Copper-HealthProfessional/',
            },
          },
        }),
      );

      const ironId = await createCompound(
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
            timingNotes: 'Separate from calcium and magnesium by >=2 hours.',
          },
          dosages: { rangeText: '25 mg daily', defaultAmount: 25, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 45 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'calcium',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Calcium inhibits DMT1 intestinal iron transport',
              recommendation: 'Separate Iron and Calcium by >=2 hours',
            },
            {
              targetType: 'nutrient',
              targetRef: 'magnesium',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Divalent mineral absorption competition',
              recommendation: 'Separate Iron and Magnesium by >=2 hours',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: 'Ferrous Bisglycinate Chelate',
            elementalWeightMg: 25,
            supplementFacts: [{ nutrient: 'Iron (as Ferrous Bisglycinate)', amount: 25, unit: 'mg' }],
            adultUpperLimit: {
              nutrientKey: 'iron',
              amount: 45,
              unit: 'mg',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/Iron-HealthProfessional/',
            },
          },
        }),
      );

      const calciumId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Calcium Citrate',
          canonicalMolecule: 'calcium',
          aliases: ['Calcium'],
          tags: ['supplement', 'mineral', 'calcium'],
          timingRules: {
            preferredSlots: ['midday_lunch', 'evening_dinner'],
            avoidSlots: [],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Separate from iron by >=2 hours.',
          },
          dosages: { rangeText: '500 mg daily', defaultAmount: 500, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 2000 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'iron',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Blocks non-heme iron absorption',
              recommendation: 'Separate Calcium from Iron by >=2 hours',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: 'Calcium Citrate',
            elementalWeightMg: 500,
            supplementFacts: [{ nutrient: 'Calcium (as Calcium Citrate)', amount: 500, unit: 'mg' }],
            adultUpperLimit: {
              nutrientKey: 'calcium',
              amount: 2500,
              unit: 'mg',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/',
            },
          },
        }),
      );

      const magnesiumId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Magnesium Glycinate',
          canonicalMolecule: 'magnesium',
          timingRules: {
            preferredSlots: ['evening_dinner', 'bedtime_fasted'],
            avoidSlots: ['pre_workout'],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'sedating',
            timingNotes: 'Evening or bedtime for sleep support.',
          },
        }),
      );

      const semaxId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Semax',
          canonicalMolecule: 'semax',
          aliases: ['ACTH 4-10 Heptapeptide'],
          subsection: 'Nootropics',
          tags: ['nootropic', 'stimulating', 'semax'],
          timingRules: {
            preferredSlots: ['waking_fasted', 'morning_am'],
            avoidSlots: ['evening_dinner', 'bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'stimulating',
            timingNotes: 'Stimulating neurotrophic peptide; avoid evening/bedtime to protect sleep.',
          },
          dosages: { rangeText: '300 mcg AM Nasal', defaultAmount: 300, defaultUnit: 'mcg', route: 'Nasal', frequencyText: 'Daily AM', maxCeiling: 1200 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Synthetic Heptapeptide (Nasal Solution)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Semax (ACTH 4-10 analog)', amount: 300, unit: 'mcg' }],
            adultUpperLimit: null,
          },
        }),
      );

      // --- DERMATOLOGY (10: Face AM/PM + Microneedling Device + Hair/Scalp) ---
      const bpoId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Benzoyl Peroxide 4% Wash',
          canonicalMolecule: 'benzoyl-peroxide',
          aliases: ['BPO 4%'],
          subsection: 'Cleansers',
          tags: ['dermatology', 'benzoyl_peroxide', 'cleanser'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'AM wash only; oxidizes PM Tretinoin.' },
          dosages: { rangeText: '1 pump AM wash', defaultAmount: 1, defaultUnit: 'pumps', route: 'Topical', frequencyText: 'Daily AM', maxCeiling: 2 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'retinoid',
              severity: 'avoid_same_slot',
              separationHours: 12,
              mechanism: 'Benzoyl peroxide oxidizes tretinoin on contact',
              recommendation: 'Use BPO in AM and Tretinoin in PM',
            },
          ],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'cleanser',
            actives: [{ name: 'Benzoyl Peroxide', concentrationPct: 4, optimalPh: 5.5 }],
            layeringStep: 1,
            waitTimeMinutes: 0,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: false,
            skinCyclingRole: 'cleanser',
            pregnancySafety: 'caution',
          },
        }),
      );

      const vitCId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Vitamin C 15% (L-Ascorbic Acid)',
          canonicalMolecule: 'ascorbic-acid-topical',
          aliases: ['L-Ascorbic Acid 15%'],
          subsection: 'Antioxidant Serums',
          tags: ['dermatology', 'vitamin_c', 'antioxidant', 'l_ascorbic_acid'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'AM antioxidant serum; keep separate from PM GHK-Cu.' },
          dosages: { rangeText: '4 drops AM', defaultAmount: 4, defaultUnit: 'drops', route: 'Topical', frequencyText: 'Daily AM', maxCeiling: 6 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'copper_peptide',
              severity: 'avoid_same_slot',
              separationHours: 12,
              mechanism: 'Low-pH L-ascorbic acid destabilizes copper peptide complex',
              recommendation: 'Use Vitamin C in AM and GHK-Cu in PM',
            },
          ],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'water_serum',
            actives: [{ name: 'L-Ascorbic Acid', concentrationPct: 15, optimalPh: 3.2 }],
            layeringStep: 2,
            waitTimeMinutes: 2,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'antioxidant',
            pregnancySafety: 'safe',
          },
        }),
      );

      const niacinamideId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Niacinamide 5% Serum',
          canonicalMolecule: 'niacinamide-topical',
          aliases: ['Vitamin B3 Serum'],
          subsection: 'Barrier Serums',
          tags: ['dermatology', 'niacinamide', 'barrier'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Versatile AM/PM barrier serum.' },
          dosages: { rangeText: '3 drops AM/PM', defaultAmount: 3, defaultUnit: 'drops', route: 'Topical', frequencyText: 'Daily', maxCeiling: 6 },
          doNotPairWith: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'water_serum',
            actives: [{ name: 'Niacinamide', concentrationPct: 5, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'barrier',
            pregnancySafety: 'safe',
          },
        }),
      );

      const tretinoinId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Tretinoin 0.05% Cream',
          canonicalMolecule: 'tretinoin',
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'cream',
            actives: [{ name: 'Tretinoin', concentrationPct: 0.05, optimalPh: 5.5 }],
            layeringStep: 4,
            waitTimeMinutes: 15,
            amPmSuitability: 'pm_only',
            photosensitivity: true,
            leaveOn: true,
            skinCyclingRole: 'retinoid',
            pregnancySafety: 'avoid',
          },
          doNotPairWith: [
            { targetType: 'class', targetRef: 'aha_bha', severity: 'alternate_days', mechanism: 'Additive barrier irritation', recommendation: 'Alternate PM nights with Glycolic Acid' },
            { targetType: 'class', targetRef: 'copper_peptide', severity: 'alternate_days', mechanism: 'Retinoid + copper peptide irritation / active clash', recommendation: 'Alternate PM nights with GHK-Cu Serum' },
            { targetType: 'compound', targetRef: 'benzoyl-peroxide', severity: 'avoid_same_slot', separationHours: 12, mechanism: 'Oxidation', recommendation: 'BPO AM, Tretinoin PM' },
          ],
        }),
      );

      const glycolicId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Glycolic Acid 10% Toner',
          canonicalMolecule: 'glycolic-acid',
          aliases: ['AHA 10% Toner'],
          subsection: 'Chemical Exfoliants',
          tags: ['dermatology', 'aha_bha', 'exfoliant', 'photosensitizing', 'pm_only', 'skin_cycling_active'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: ['derm_am'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'PM exfoliation night; alternate from retinoids and copper peptides.' },
          dosages: { rangeText: '1 pad PM', defaultAmount: 1, defaultUnit: 'mL', route: 'Topical', frequencyText: 'Alternating PM', maxCeiling: 2 },
          doNotPairWith: [
            { targetType: 'class', targetRef: 'retinoid', severity: 'alternate_days', mechanism: 'Barrier disruption', recommendation: 'Alternate PM nights with Tretinoin' },
            { targetType: 'class', targetRef: 'copper_peptide', severity: 'alternate_days', mechanism: 'Low pH degrades copper peptides', recommendation: 'Alternate PM nights with GHK-Cu Serum' },
          ],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'acid_toner',
            actives: [{ name: 'Glycolic Acid', concentrationPct: 10, optimalPh: 3.5 }],
            layeringStep: 2,
            waitTimeMinutes: 5,
            amPmSuitability: 'pm_only',
            photosensitivity: true,
            leaveOn: true,
            skinCyclingRole: 'exfoliant',
            pregnancySafety: 'caution',
          },
        }),
      );

      const ghkSerumId = await createCompound(
        fixtures.makeDermCompound({
          name: 'GHK-Cu 2% Serum',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Peptide 2% Facial Serum'],
          subsection: 'Peptide Serums',
          tags: ['dermatology', 'copper_peptide', 'skin_cycling_active'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'PM peptide night; alternate from Tretinoin and Glycolic Acid.' },
          dosages: { rangeText: '3 drops PM', defaultAmount: 3, defaultUnit: 'drops', route: 'Topical', frequencyText: 'Alternating PM', maxCeiling: 6 },
          doNotPairWith: [
            { targetType: 'class', targetRef: 'retinoid', severity: 'alternate_days', mechanism: 'Active irritation', recommendation: 'Alternate PM nights with Tretinoin' },
            { targetType: 'class', targetRef: 'aha_bha', severity: 'alternate_days', mechanism: 'Acidic pH chelates copper peptide', recommendation: 'Alternate PM nights with Glycolic Acid' },
            { targetType: 'class', targetRef: 'vitamin_c', severity: 'avoid_same_slot', separationHours: 12, mechanism: 'Acidic oxidation', recommendation: 'Vitamin C AM, GHK-Cu PM' },
          ],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'water_serum',
            actives: [{ name: 'GHK-Cu', concentrationPct: 2, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'copper_peptide',
            pregnancySafety: 'caution',
          },
        }),
      );

      const ceramideId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Ceramide Barrier Cream',
          canonicalMolecule: 'ceramide-moisturizer',
          aliases: ['Barrier Moisturizer'],
          subsection: 'Moisturizers',
          tags: ['dermatology', 'ceramide', 'barrier', 'moisturizer'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Barrier moisturizer step 5 AM and PM.' },
          dosages: { rangeText: '1 pump AM/PM', defaultAmount: 1, defaultUnit: 'pumps', route: 'Topical', frequencyText: 'Daily', maxCeiling: 4 },
          doNotPairWith: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'cream',
            actives: [{ name: 'Ceramides NP/AP/EOP', concentrationPct: 3, optimalPh: 5.5 }],
            layeringStep: 5,
            waitTimeMinutes: 0,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'barrier',
            pregnancySafety: 'safe',
          },
        }),
      );

      const spf50Id = await createCompound(
        fixtures.makeDermCompound({
          name: 'Mineral SPF 50',
          canonicalMolecule: 'zinc-oxide-spf50',
          aliases: ['Sunscreen SPF 50'],
          subsection: 'Sun Protection',
          tags: ['dermatology', 'spf', 'sunscreen'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Final AM layering step 7.' },
          dosages: { rangeText: '2 finger-lengths AM', defaultAmount: 2, defaultUnit: 'mL', route: 'Topical', frequencyText: 'Daily AM', maxCeiling: 10 },
          doNotPairWith: [],
          sectionData: {
            targetArea: ['face', 'neck'],
            vehicleType: 'spf',
            actives: [{ name: 'Zinc Oxide', concentrationPct: 20, optimalPh: 6.5 }],
            layeringStep: 7,
            waitTimeMinutes: 0,
            amPmSuitability: 'am_only',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'spf',
            pregnancySafety: 'safe',
          },
        }),
      );

      const microneedlingId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Weekly Microneedling 0.5mm',
          canonicalMolecule: 'microneedling',
          aliases: ['Dermastamp 0.5mm'],
          subsection: 'Devices',
          tags: ['dermatology', 'microneedling', 'device'],
          timingRules: { preferredSlots: ['derm_pm'], avoidSlots: ['derm_am'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Weekly PM device session; hold retinoids, acids, and topical minoxidil for 24h.' },
          dosages: { rangeText: '1 session weekly', defaultAmount: 1, defaultUnit: 'mL', route: 'Device', frequencyText: 'Weekly', maxCeiling: 1 },
          doNotPairWith: [
            { targetType: 'class', targetRef: 'retinoid', severity: 'alternate_days', separationHours: 24, mechanism: 'Microneedling disrupts stratum corneum', recommendation: 'Hold Tretinoin for 24h around microneedling' },
            { targetType: 'class', targetRef: 'aha_bha', severity: 'alternate_days', separationHours: 24, mechanism: 'Chemical burn risk on micro-channels', recommendation: 'Hold Glycolic Acid for 24h around microneedling' },
          ],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'device',
            actives: [],
            layeringStep: 4,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: true,
            leaveOn: false,
            skinCyclingRole: 'device',
            pregnancySafety: 'caution',
          },
        }),
      );

      const minoxidilId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Topical Minoxidil 5% Foam',
          canonicalMolecule: 'minoxidil-topical',
          aliases: ['Minoxidil 5% Scalp Foam'],
          subsection: 'Hair & Scalp Treatments',
          tags: ['dermatology', 'hair_growth', 'minoxidil', 'scalp_hair'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [], foodState: 'any', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Apply strictly to dry scalp, separate from facial routine.' },
          dosages: { rangeText: '1 capful AM/PM scalp', defaultAmount: 1, defaultUnit: 'pumps', route: 'Topical', frequencyText: 'Daily', maxCeiling: 2 },
          doNotPairWith: [],
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'foam',
            actives: [{ name: 'Minoxidil', concentrationPct: 5, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'both',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'hair_growth',
            pregnancySafety: 'avoid',
          },
        }),
      );

      // Wishlist #25 (NOT in saved stack) for non-mutating What-If simulation
      const coq10Id = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'CoQ10 Ubiquinol',
          canonicalMolecule: 'coq10',
          aliases: ['Ubiquinol'],
          tags: ['supplement', 'antioxidant', 'mitochondrial'],
          timingRules: { preferredSlots: ['morning_am', 'midday_lunch'], avoidSlots: ['bedtime_fasted'], foodState: 'with_fat', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'Take with fatty meal.' },
          dosages: { rangeText: '100 mg daily', defaultAmount: 100, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 300 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Ubiquinol (Reduced CoQ10)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'CoQ10 (as Ubiquinol)', amount: 100, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
        'wishlist',
      );

      // Build the 24-compound cross-section stack (testing missing-SPF alert first with 23 items, then adding SPF 50)
      const spfItem = fixtures.makeStackItem({ compoundId: spf50Id, doseAmount: 2, doseUnit: 'mL' });
      const stackItemsWithoutSpf = [
        fixtures.makeStackItem({ compoundId: tesamorelinId, doseAmount: 1, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: ipamorelinId, doseAmount: 200, doseUnit: 'mcg' }),
        fixtures.makeStackItem({ compoundId: cjc1295Id, doseAmount: 100, doseUnit: 'mcg' }),
        fixtures.makeStackItem({ compoundId: ghkSubqId, doseAmount: 1.5, doseUnit: 'mg' }),
        fixtures.makeStackItem({
          compoundId: testCypId,
          doseAmount: 60,
          doseUnit: 'mg',
          frequency: '2x_weekly',
          cadence: { type: 'weekly', daysOfWeek: [1, 4] },
        }),
        fixtures.makeStackItem({ compoundId: vitD3Id, doseAmount: 2000, doseUnit: 'IU' }),
        fixtures.makeStackItem({ compoundId: vitK2Id, doseAmount: 100, doseUnit: 'mcg' }),
        fixtures.makeStackItem({ compoundId: omega3Id, doseAmount: 2000, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: zincId, doseAmount: 30, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: copperId, doseAmount: 2, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: ironId, doseAmount: 25, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: calciumId, doseAmount: 500, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: magnesiumId, doseAmount: 200, doseUnit: 'mg' }),
        fixtures.makeStackItem({ compoundId: semaxId, doseAmount: 300, doseUnit: 'mcg' }),
        fixtures.makeStackItem({ compoundId: bpoId, doseAmount: 1, doseUnit: 'pumps' }),
        fixtures.makeStackItem({ compoundId: vitCId, doseAmount: 4, doseUnit: 'drops' }),
        fixtures.makeStackItem({ compoundId: niacinamideId, doseAmount: 3, doseUnit: 'drops' }),
        fixtures.makeStackItem({ compoundId: tretinoinId, doseAmount: 1, doseUnit: 'pea_size' }),
        fixtures.makeStackItem({ compoundId: glycolicId, doseAmount: 1, doseUnit: 'mL' }),
        fixtures.makeStackItem({ compoundId: ghkSerumId, doseAmount: 3, doseUnit: 'drops' }),
        fixtures.makeStackItem({ compoundId: ceramideId, doseAmount: 1, doseUnit: 'pumps' }),
        fixtures.makeStackItem({
          compoundId: microneedlingId,
          doseAmount: 1,
          doseUnit: 'mL',
          frequency: 'weekly',
          cadence: { type: 'weekly', daysOfWeek: [0] },
        }),
        fixtures.makeStackItem({ compoundId: minoxidilId, doseAmount: 1, doseUnit: 'pumps' }),
      ];
      const stackItems = [...stackItemsWithoutSpf, spfItem];
      assert.equal(stackItems.length, 24, 'Scenario 5 must exercise >=16 compounds across all 4 sections');

      // 0. Missing-SPF alert check (photosensitizing Tretinoin & Glycolic Acid WITHOUT AM SPF 50)
      const stackRes = await admin.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Full 4-Section Longevity & Performance Stack',
          memberId: 'member_husband',
          items: stackItemsWithoutSpf,
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'Create 23-compound stack without SPF');
      const stackId = getId(unwrapData(stackRes.json, ['stack']));

      const noSpfSchedRes = await admin.post(`/api/v1/members/member_husband/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(noSpfSchedRes.status, 200, `Missing-SPF schedule failed: ${noSpfSchedRes.text}`);
      const noSpfSpread = unwrapData(noSpfSchedRes.json, ['schedule']);
      assert.ok(
        typeof noSpfSpread.dermatology?.skin?.missingSpfWarning === 'string' &&
          noSpfSpread.dermatology.skin.missingSpfWarning.trim().length > 0,
        `Photosensitizing actives without AM SPF MUST emit missingSpfWarning, got ${JSON.stringify(noSpfSpread.dermatology?.skin?.missingSpfWarning)}`,
      );
      assert.match(
        noSpfSpread.dermatology.skin.missingSpfWarning,
        /spf|sunscreen|uv|photo/i,
        `missingSpfWarning should recommend SPF protection: "${noSpfSpread.dermatology.skin.missingSpfWarning}"`,
      );

      // Add Mineral SPF 50 (now 24 compounds across all 4 sections) -> verify missingSpfWarning clears
      const addSpfRes = await admin.patch(`/api/v1/members/member_husband/stacks/${stackId}`, {
        items: stackItems,
      });
      assert.equal(addSpfRes.status, 200, `PATCH stack to add SPF 50 failed: ${addSpfRes.text}`);

      // 1. Determinism check across two identical schedule runs
      const schedRes1 = await admin.post(`/api/v1/members/member_husband/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      const schedRes2 = await admin.post(`/api/v1/members/member_husband/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(schedRes1.status, 200, `Schedule failed: ${schedRes1.text}`);
      assert.equal(schedRes2.status, 200);
      assertNoStore(schedRes1, 'POST /schedule');
      const spread = unwrapData(schedRes1.json, ['schedule']);
      const spread2 = unwrapData(schedRes2.json, ['schedule']);
      assert.deepEqual(
        normalizeSpreadForDeterminism(spread),
        normalizeSpreadForDeterminism(spread2),
        'Dual-track spreader must be strictly deterministic',
      );

      // 2. Zero silent drops across systemic + dermatology + hair/scalp
      const scheduledIds = collectAllScheduledCompoundIds(spread);
      const nonDeviceIds = [
        tesamorelinId, ipamorelinId, cjc1295Id, ghkSubqId, testCypId,
        vitD3Id, vitK2Id, omega3Id, zincId, copperId, ironId, calciumId, magnesiumId, semaxId,
        bpoId, vitCId, niacinamideId, tretinoinId, glycolicId, ghkSerumId, ceramideId, spf50Id, minoxidilId,
      ];
      for (const cid of nonDeviceIds) {
        assert.ok(scheduledIds.has(cid), `Zero Silent Drops violation: compound ${cid} missing from schedule`);
      }

      // 3. Systemic track placement invariants (canonical 8-slot vocabulary + explainable rationale)
      for (const slot of spread.systemic?.slots ?? []) {
        assert.ok(
          CANONICAL_SYSTEMIC_SLOTS.has(slot.slotId),
          `Unexpected non-canonical systemic slotId "${slot.slotId}"`,
        );
      }
      const sysItems = collectSystemicItems(spread);
      for (const item of sysItems) {
        assert.ok(
          Array.isArray(item.rationale) && item.rationale.length > 0,
          `Systemic item "${item.name}" must include explainable "Why here?" rationale[]`,
        );
      }
      const slotOf = (cid) => {
        const found = sysItems.find((i) => i.compoundId === cid);
        assert.ok(found, `Expected systemic compound ${cid} to be placed in a systemic slot`);
        return found.slotId;
      };

      assert.equal(slotOf(tesamorelinId), 'waking_fasted', 'Tesamorelin (fasted AM) must be placed in waking_fasted');
      assert.equal(slotOf(ipamorelinId), 'bedtime_fasted', 'Ipamorelin must be placed in bedtime_fasted');
      assert.equal(slotOf(cjc1295Id), 'bedtime_fasted', 'CJC-1295 must co-locate with Ipamorelin in bedtime_fasted');

      const d3Slot = slotOf(vitD3Id);
      const k2Slot = slotOf(vitK2Id);
      const omegaSlot = slotOf(omega3Id);
      assert.ok(
        ['morning_am', 'midday_lunch', 'evening_dinner'].includes(d3Slot),
        `Vitamin D3 must be in a meal/fat slot, got ${d3Slot}`,
      );
      assert.equal(k2Slot, d3Slot, `Vitamin K2 (${k2Slot}) must co-locate with Vitamin D3 (${d3Slot})`);
      assert.equal(omegaSlot, d3Slot, `Omega-3 (${omegaSlot}) must co-locate with Vitamin D3 (${d3Slot})`);

      const zincSlot = slotOf(zincId);
      const copperSlot = slotOf(copperId);
      assert.notEqual(zincSlot, copperSlot, `Zinc (${zincSlot}) and Copper (${copperSlot}) must be auto-separated into different slots`);

      const ironSlot = slotOf(ironId);
      const calciumSlot = slotOf(calciumId);
      const magSlot = slotOf(magnesiumId);
      assert.notEqual(ironSlot, calciumSlot, `Iron (${ironSlot}) and Calcium (${calciumSlot}) must be separated`);
      assert.notEqual(ironSlot, magSlot, `Iron (${ironSlot}) and Magnesium (${magSlot}) must be separated`);
      assert.ok(
        ['evening_dinner', 'bedtime_fasted'].includes(magSlot),
        `Sedating Magnesium Glycinate must be in evening_dinner or bedtime_fasted, got ${magSlot}`,
      );

      const semaxSlot = slotOf(semaxId);
      assert.ok(
        !['evening_dinner', 'bedtime_fasted'].includes(semaxSlot),
        `Stimulating Semax must NOT be placed in evening_dinner/bedtime_fasted (sleep protection), got ${semaxSlot}`,
      );

      // 4. Weekly cadence & injection load balancing (verify 2x/wk Testosterone Cypionate cadence precisely)
      assert.ok(spread.systemic?.weeklyGrid && typeof spread.systemic.weeklyGrid === 'object', 'weeklyGrid must be populated');
      const testCypGridDays = Object.entries(spread.systemic.weeklyGrid)
        .filter(([, entries]) =>
          Array.isArray(entries) &&
          entries.some((entry) => (typeof entry === 'string' ? entry : entry?.compoundId ?? entry?.id) === testCypId),
        )
        .map(([day]) => day);
      const testCypSlotItem = sysItems.find((i) => i.compoundId === testCypId);
      const testCypItemDays = Array.isArray(testCypSlotItem?.daysOfWeek) ? testCypSlotItem.daysOfWeek : [];
      if (testCypGridDays.length > 0) {
        assert.equal(
          testCypGridDays.length,
          2,
          `2x/wk Testosterone Cypionate must appear on exactly 2 days in weeklyGrid, got ${testCypGridDays.length} (${JSON.stringify(testCypGridDays)})`,
        );
      }
      if (testCypItemDays.length > 0) {
        assert.equal(
          testCypItemDays.length,
          2,
          `2x/wk Testosterone Cypionate item.daysOfWeek must have length 2, got ${JSON.stringify(testCypItemDays)}`,
        );
      }
      assert.ok(
        testCypGridDays.length === 2 || testCypItemDays.length === 2,
        `2x/wk Testosterone Cypionate must schedule on exactly 2 days/week (weeklyGridDays=${JSON.stringify(testCypGridDays)}, itemDaysOfWeek=${JSON.stringify(testCypItemDays)})`,
      );
      const injLoad = spread.systemic?.injectionLoadByDay ?? {};
      const activeInjectionDays = Object.values(injLoad).filter((n) => Number(n) > 0).length;
      assert.ok(activeInjectionDays >= 2, `Expected >=2 injection days in injectionLoadByDay, got ${JSON.stringify(injLoad)}`);

      // 5. Dermatology AM routine (steps 1..7 ascending + explicit order BPO < Vit C < SPF 50, SPF present -> missingSpfWarning falsy)
      const skinAm = spread.dermatology?.skin?.am ?? [];
      const skinAmIds = skinAm.map((i) => i.compoundId);
      assert.ok(skinAmIds.includes(bpoId), 'BPO 4% Wash must be routed to AM');
      assert.ok(skinAmIds.includes(vitCId), 'Vitamin C 15% must be routed to AM');
      assert.ok(skinAmIds.includes(spf50Id), 'Mineral SPF 50 must be routed to AM');
      assertAscendingSteps(skinAm, 'dermatology.skin.am');
      assert.ok(
        skinAmIds.indexOf(bpoId) < skinAmIds.indexOf(vitCId) && skinAmIds.indexOf(vitCId) < skinAmIds.indexOf(spf50Id),
        `AM derm layering must strictly order BPO Wash < Vitamin C < Mineral SPF 50, got ${JSON.stringify(skinAm.map((i) => ({ id: i.compoundId, step: i.step })))}`,
      );
      assert.ok(
        !spread.dermatology?.skin?.missingSpfWarning,
        `With Mineral SPF 50 present, missingSpfWarning must be null/falsy, got "${spread.dermatology?.skin?.missingSpfWarning}"`,
      );

      // 6. Dermatology PM alternating-night skin cycling (Tretinoin, Glycolic Acid, GHK-Cu Serum & Microneedling NEVER share a PM night)
      const pmNights = spread.dermatology?.skin?.pmNights ?? [];
      assert.ok(pmNights.length >= 2, `Expected alternating PM skin cycling nights, got ${pmNights.length}`);
      const pmActives = new Set([tretinoinId, glycolicId, ghkSerumId, microneedlingId]);
      const seenPmActives = new Set();
      for (const night of pmNights) {
        const steps = night.steps ?? [];
        assertAscendingSteps(steps, `dermatology.skin.pmNights (${night.nightLabel || night.theme})`);
        const nightIds = steps.map((s) => s.compoundId);
        const activesInThisNight = nightIds.filter((id) => pmActives.has(id));
        assert.ok(
          activesInThisNight.length <= 1,
          `PM night "${night.nightLabel || night.theme}" combined conflicting actives (${activesInThisNight.join(', ')})! Tretinoin, Glycolic Acid, GHK-Cu Serum, and Microneedling must alternate nights.`,
        );
        for (const id of activesInThisNight) seenPmActives.add(id);
        assert.ok(!nightIds.includes(bpoId), 'BPO Wash must stay AM, never mixed into PM Tretinoin nights');
        assert.ok(!nightIds.includes(vitCId), 'Vitamin C must stay AM, never mixed into PM GHK-Cu nights');
      }
      assert.ok(seenPmActives.has(tretinoinId), 'Tretinoin must appear in PM skin cycling nights');
      assert.ok(seenPmActives.has(glycolicId), 'Glycolic Acid must appear in PM skin cycling nights');
      assert.ok(seenPmActives.has(ghkSerumId), 'GHK-Cu 2% Serum must appear in PM skin cycling nights');
      const tretStep = pmNights.flatMap((n) => n.steps ?? []).find((s) => s.compoundId === tretinoinId);
      assert.ok(
        Number(tretStep?.waitTimeMinutes ?? 0) > 0,
        `Tretinoin PM step must preserve waitTimeMinutes callout, got ${JSON.stringify(tretStep)}`,
      );

      // 7. Weekly microneedling recovery buffer notes
      const bufferNotes = spread.dermatology?.skin?.microneedlingBufferNotes ?? [];
      assert.ok(
        Array.isArray(bufferNotes) && bufferNotes.length >= 1,
        'Weekly Microneedling must emit non-empty microneedlingBufferNotes',
      );
      assert.match(
        bufferNotes.join(' '),
        /microneedl|24|12|hold|buffer|recover/i,
        `Microneedling buffer notes must describe active hold/recovery window: ${JSON.stringify(bufferNotes)}`,
      );

      // 8. Isolated Hair & Scalp track (Minoxidil in hairScalp ONLY, NEVER in facial skin.am or skin.pmNights)
      const hairIds = collectHairScalpIds(spread);
      assert.ok(hairIds.includes(minoxidilId), 'Topical Minoxidil 5% Foam must appear in dermatology.hairScalp');
      assert.ok(!skinAmIds.includes(minoxidilId), 'Hair/scalp Minoxidil must NEVER leak into facial skin.am');
      assert.ok(!collectDermSkinPmIds(spread).includes(minoxidilId), 'Hair/scalp Minoxidil must NEVER leak into facial skin.pmNights');

      // 9. Multi-route GHK-Cu cumulative exposure warning surfaces (strict single-entry dual check)
      const multiRouteAlerts = [
        ...(spread.interactions?.cautions ?? []),
        ...(spread.interactions?.safetyAlerts ?? []),
        ...(spread.interactions?.redundancies ?? []),
        ...(spread.interactions?.hardStops ?? []),
      ];
      assertMultiRouteAlert(
        multiRouteAlerts,
        /ghk.?cu|copper.?tripeptide/i,
        ghkSubqId,
        ghkSerumId,
        'Scenario 5 spread.interactions multi-route GHK-Cu warning',
      );

      // 10. Non-mutating What-If wishlist preview
      const stackBeforeWhatIf = unwrapData((await admin.get('/api/v1/members/member_husband/stacks')).json, ['stacks']).find(
        (s) => getId(s) === stackId,
      );
      const whatIfRes = await admin.post(`/api/v1/members/member_husband/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
        whatIfCompounds: [{ compoundId: coq10Id, doseAmount: 100, doseUnit: 'mg', frequency: 'daily' }],
      });
      assert.equal(whatIfRes.status, 200);
      const whatIfSpread = unwrapData(whatIfRes.json, ['schedule']);
      const whatIfCoq10 = collectSystemicItems(whatIfSpread).find((i) => i.compoundId === coq10Id);
      assert.ok(whatIfCoq10, 'What-If CoQ10 must appear in preview schedule');
      assert.equal(whatIfCoq10.isWhatIf, true, 'What-If CoQ10 must carry isWhatIf: true');
      assert.ok(
        (whatIfSpread.stockSummary?.missing ?? []).some((m) => (m.compoundId ?? m.id) === coq10Id),
        'What-If wishlist CoQ10 must appear in stockSummary.missing',
      );
      const stackAfterWhatIf = unwrapData((await admin.get('/api/v1/members/member_husband/stacks')).json, ['stacks']).find(
        (s) => getId(s) === stackId,
      );
      assert.equal(
        (stackAfterWhatIf?.items ?? []).length,
        (stackBeforeWhatIf?.items ?? []).length,
        'What-If simulation must NOT mutate saved stack',
      );

      // 11. Conflicting Pin Override — pin BOTH Zinc and Copper into the same slot so conflict is unresolvable
      const pinnedItems = (stackAfterWhatIf?.items ?? stackItems).map((item) =>
        item.compoundId === copperId || item.compoundId === zincId
          ? { ...item, pinnedSlot: zincSlot }
          : item,
      );
      const pinPatchRes = await admin.patch(`/api/v1/members/member_husband/stacks/${stackId}`, {
        items: pinnedItems,
      });
      assert.equal(pinPatchRes.status, 200, `PATCH stack with pinnedSlot failed: ${pinPatchRes.text}`);

      const pinnedSchedRes = await admin.post(`/api/v1/members/member_husband/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(pinnedSchedRes.status, 200);
      const pinnedSpread = unwrapData(pinnedSchedRes.json, ['schedule']);
      const pinnedSysItems = collectSystemicItems(pinnedSpread);
      const pinnedCopper = pinnedSysItems.find((i) => i.compoundId === copperId);
      const pinnedZinc = pinnedSysItems.find((i) => i.compoundId === zincId);
      assert.ok(pinnedCopper, 'Pinned Copper must NEVER be silently dropped');
      assert.ok(pinnedZinc, 'Pinned Zinc must NEVER be silently dropped');
      assert.equal(pinnedCopper.slotId, zincSlot, `Solver must honor user pin keeping Copper in ${zincSlot}`);
      assert.equal(pinnedZinc.slotId, zincSlot, `Solver must honor user pin keeping Zinc in ${zincSlot}`);
      assert.equal(pinnedCopper.pinned, true, 'Pinned Copper must report pinned: true');
      assert.equal(pinnedZinc.pinned, true, 'Pinned Zinc must report pinned: true');
      const pinWarning = pinnedCopper.pinConflictWarning || pinnedZinc.pinConflictWarning || '';
      assert.ok(
        typeof pinWarning === 'string' && pinWarning.trim().length > 0,
        `Pinning Copper & Zinc into the same slot MUST emit non-empty pinConflictWarning, got Copper=${JSON.stringify(pinnedCopper)}, Zinc=${JSON.stringify(pinnedZinc)}`,
      );
    } finally {
      await server.stop();
    }
  });

  it('Scenario 6 — High-Risk Safety Contexts (Pregnancy/Teratogen, Active SSRI, Oncogenic Growth Factors, Duplicate GLP-1, Dual 17aa Oral AAS, Female Virilization, Multi-Route GHK-Cu, Adult UL & Zero Silent Drops)', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const createCompound = async (payload) => {
        const res = await admin.post('/api/v1/compounds', payload);
        assertStatusIn(res, [200, 201], `Create ${payload.name}`);
        return getId(unwrapData(res.json, ['compound']));
      };

      // =========================================================================
      // PART A — WIFE:
      //   Step A1: biologicalSexContext: 'female', pregnancyOrTrying: false -> proves female virilization independently
      //   Step A2: biologicalSexContext: 'female', pregnancyOrTrying: true  -> proves Tretinoin & Finasteride pregnancy hardStops
      // =========================================================================
      assert.equal(
        (
          await admin.patch('/api/v1/members/member_wife', {
            name: 'Clara',
            safetyContext: {
              biologicalSexContext: 'female',
              pregnancyOrTrying: false,
              allergies: [],
              activeRxMeds: [],
              conditions: [],
            },
          })
        ).status,
        200,
      );

      const tretId = await createCompound(
        fixtures.makeDermCompound({
          name: 'Tretinoin 0.05% Cream',
          canonicalMolecule: 'tretinoin',
          tags: ['dermatology', 'retinoid', 'photosensitizing', 'teratogen', 'pm_only'],
          sectionData: { pregnancySafety: 'avoid' },
        }),
      );

      const finasterideId = await createCompound(
        fixtures.makePedCompound({
          name: 'Finasteride',
          canonicalMolecule: 'finasteride',
          aliases: ['Propecia'],
          subsection: '5-Alpha Reductase Inhibitors',
          tags: ['ped', '5ar_inhibitor', 'finasteride', 'teratogen'],
          halfLife: {
            valueHours: 6,
            minHours: 5,
            maxHours: 8,
            displayText: '~6 hours (oral)',
            route: 'Oral',
            kind: 'elimination',
          },
          dosages: { rangeText: '1 mg daily oral', defaultAmount: 1, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 5 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'pregnancy',
              severity: 'hard_stop',
              mechanism: '5-alpha-reductase inhibition causes severe teratogenic risk in male fetuses.',
              recommendation: 'Hard-stop contraindication during pregnancy or trying to conceive.',
            },
          ],
          synergies: [],
          sectionData: {
            compoundClass: '5-Alpha Reductase Inhibitor',
            ester: null,
            esterHalfLifeDays: null,
            oilPreMixed: false,
            c17AlphaAlkylated: false,
            femaleVirilizationRisk: 'none',
            teratogenicityRisk: 'high',
          },
        }),
      );

      const testCypId = await createCompound(
        fixtures.makePedCompound({
          name: 'Testosterone Cypionate',
          canonicalMolecule: 'testosterone-cypionate',
          tags: ['ped', 'androgen', 'aas', 'testosterone', 'injectable_oil', 'virilization_risk', 'teratogen'],
          sectionData: { femaleVirilizationRisk: 'high', teratogenicityRisk: 'high' },
        }),
      );

      const wifeStackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife High-Risk Safety Check Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: tretId, doseAmount: 1, doseUnit: 'pea_size' }),
            fixtures.makeStackItem({ compoundId: finasterideId, doseAmount: 1, doseUnit: 'mg' }),
            fixtures.makeStackItem({
              compoundId: testCypId,
              doseAmount: 50,
              doseUnit: 'mg',
              frequency: '2x_weekly',
              cadence: { type: 'weekly', daysOfWeek: [1, 4] },
            }),
          ],
        }),
      );
      assertStatusIn(wifeStackRes, [200, 201], 'Create Wife High-Risk Safety Check Stack');
      const wifeStackId = getId(unwrapData(wifeStackRes.json, ['stack']));

      // Step A1: Non-pregnant female context MUST independently trigger female virilization alert for Testosterone Cypionate
      const wifeNonPregInterRes = await admin.post(`/api/v1/members/member_wife/stacks/${wifeStackId}/interactions`, {});
      assert.equal(wifeNonPregInterRes.status, 200, `POST Wife non-pregnant /interactions failed: ${wifeNonPregInterRes.text}`);
      assertNoStore(wifeNonPregInterRes, 'POST Wife non-pregnant /interactions');
      const wifeNonPregInter = unwrapData(wifeNonPregInterRes.json, ['interactions']);
      const wifeNonPregAlerts = [
        ...(wifeNonPregInter.hardStops ?? []),
        ...(wifeNonPregInter.safetyAlerts ?? []),
        ...(wifeNonPregInter.cautions ?? []),
      ];
      const virilAlert = assertAlertMatches(
        wifeNonPregAlerts,
        /viriliz|female.*(androgen|testosterone|ped)|(androgen|testosterone).*female/i,
        'Wife (biologicalSexContext=female, pregnancyOrTrying=false) high-virilization PED warning',
      );
      assert.doesNotMatch(
        JSON.stringify(virilAlert),
        /\bfetal\b/i,
        `Female virilization alert when pregnancyOrTrying=false must not rely on a fetal/pregnancy rule: ${JSON.stringify(virilAlert)}`,
      );

      // Step A2: Enable pregnancyOrTrying: true -> Tretinoin & Finasteride pregnancy teratogen hardStops fire in BOTH /interactions and /schedule
      assert.equal(
        (
          await admin.patch('/api/v1/members/member_wife', {
            safetyContext: {
              biologicalSexContext: 'female',
              pregnancyOrTrying: true,
              allergies: [],
              activeRxMeds: [],
              conditions: [],
            },
          })
        ).status,
        200,
      );

      const wifeInterRes = await admin.post(`/api/v1/members/member_wife/stacks/${wifeStackId}/interactions`, {});
      const wifeSchedRes = await admin.post(`/api/v1/members/member_wife/stacks/${wifeStackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(wifeInterRes.status, 200);
      assert.equal(wifeSchedRes.status, 200);
      assertNoStore(wifeInterRes, 'POST Wife /interactions');
      assertNoStore(wifeSchedRes, 'POST Wife /schedule');

      const wifeInter = unwrapData(wifeInterRes.json, ['interactions']);
      const wifeSpread = unwrapData(wifeSchedRes.json, ['schedule']);

      assert.ok((wifeInter.hardStops ?? []).length >= 2, `Wife pregnancy stack must emit >=2 hardStops, got ${JSON.stringify(wifeInter)}`);
      assertAlertMatches(wifeInter.hardStops ?? [], /tretinoin|retinoid/i, 'Wife /interactions Tretinoin pregnancy teratogen hard-stop');
      assertAlertMatches(wifeInter.hardStops ?? [], /finasteride/i, 'Wife /interactions Finasteride pregnancy teratogen hard-stop');

      // Verify Wife schedule ALSO surfaces Tretinoin & Finasteride hardStops AND preserves ZERO SILENT DROPS
      assert.ok((wifeSpread.interactions?.hardStops ?? []).length >= 2, 'Wife schedule must surface non-hidden hardStops');
      assertAlertMatches(
        wifeSpread.interactions?.hardStops ?? [],
        /tretinoin|retinoid/i,
        'Wife /schedule.interactions Tretinoin pregnancy teratogen hard-stop',
      );
      assertAlertMatches(
        wifeSpread.interactions?.hardStops ?? [],
        /finasteride/i,
        'Wife /schedule.interactions Finasteride pregnancy teratogen hard-stop',
      );
      const wifeScheduledIds = collectAllScheduledCompoundIds(wifeSpread);
      for (const cid of [tretId, finasterideId, testCypId]) {
        assert.ok(wifeScheduledIds.has(cid), `Wife Zero Silent Drops violation: ${cid} dropped from schedule`);
      }

      // =========================================================================
      // PART B — HUSBAND: biologicalSexContext: 'male', activeRxMeds: ['Sertraline']
      // =========================================================================
      assert.equal(
        (
          await admin.patch('/api/v1/members/member_husband', {
            name: 'Marcus',
            safetyContext: {
              biologicalSexContext: 'male',
              pregnancyOrTrying: false,
              allergies: [],
              activeRxMeds: ['Sertraline'],
              conditions: [],
            },
          })
        ).status,
        200,
      );

      // 1. 9-Me-BC (MAOI + SSRI Sertraline hard-stop)
      const nineMeBcId = await createCompound(
        fixtures.makeSupplementCompound({
          name: '9-Me-BC',
          canonicalMolecule: '9-me-bc',
          aliases: ['9-Methyl-beta-carboline'],
          subsection: 'Nootropics',
          tags: ['nootropic', 'maoi', 'ssri_caution', '9_me_bc'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: ['bedtime_fasted'], foodState: 'any', workoutRelation: 'any', circadianEffect: 'stimulating', timingNotes: 'Morning only.' },
          dosages: { rangeText: '15 mg daily', defaultAmount: 15, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 30 },
          doNotPairWith: [
            {
              targetType: 'rx_med',
              targetRef: 'sertraline',
              severity: 'hard_stop',
              mechanism: 'MAOI activity combined with SSRI Sertraline risks life-threatening serotonin syndrome.',
              recommendation: 'Hard-stop: contraindicated with Sertraline or any SSRI.',
            },
            {
              targetType: 'class',
              targetRef: 'ssri',
              severity: 'hard_stop',
              mechanism: 'MAOI + SSRI serotonin toxicity',
              recommendation: 'Do not combine 9-Me-BC with SSRIs.',
            },
          ],
          synergies: [],
          sectionData: {
            chemicalForm: '9-Methyl-beta-carboline Freebase',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: '9-Me-BC', amount: 15, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );

      // 2 & 3. IGF-1 LR3 + Dihexa (oncogenic growth-factor hard-stop)
      const igf1Id = await createCompound(
        fixtures.makePeptideCompound({
          name: 'IGF-1 LR3',
          canonicalMolecule: 'igf-1-lr3',
          aliases: ['Long R3 IGF-1'],
          tags: ['peptide', 'growth_factor', 'oncogenic_growth_factors', 'igf1'],
          dosages: { rangeText: '40 mcg SubQ', defaultAmount: 40, defaultUnit: 'mcg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 100 },
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef: 'dihexa',
              severity: 'hard_stop',
              mechanism: 'Dual oncogenic/proliferative growth-factor signaling (IGF-1R + HGF/c-Met).',
              recommendation: 'Hard-stop: never stack IGF-1 LR3 with Dihexa.',
            },
          ],
          synergies: [],
        }),
      );

      const dihexaId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'Dihexa',
          canonicalMolecule: 'dihexa',
          aliases: ['PNB-0408'],
          tags: ['peptide', 'growth_factor', 'oncogenic_growth_factors', 'dihexa'],
          dosages: { rangeText: '10 mg oral', defaultAmount: 10, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 20 },
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef: 'igf-1-lr3',
              severity: 'hard_stop',
              mechanism: 'Additive HGF/c-Met + IGF-1R proliferative/oncogenic pathway risk.',
              recommendation: 'Hard-stop: do not combine Dihexa with IGF-1 LR3.',
            },
          ],
          synergies: [],
        }),
      );

      // 4 & 5. Retatrutide + Tirzepatide (duplicate GLP-1 hard-stop)
      const retatrutideId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'Retatrutide',
          canonicalMolecule: 'retatrutide',
          aliases: ['LY3437943'],
          subsection: 'Metabolic / Incretins',
          tags: ['peptide', 'glp1', 'glp1_agonist', 'incretin'],
          dosages: { rangeText: '2 mg weekly SubQ', defaultAmount: 2, defaultUnit: 'mg', route: 'SubQ', frequencyText: 'Weekly', maxCeiling: 12 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'glp1',
              severity: 'hard_stop',
              mechanism: 'Duplicate GLP-1 receptor agonist class stacking risks severe GI toxicity and pancreatitis.',
              recommendation: 'Hard-stop: do not combine two GLP-1 receptor agonists.',
            },
          ],
          synergies: [],
        }),
      );

      const tirzepatideId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'Tirzepatide',
          canonicalMolecule: 'tirzepatide',
          aliases: ['Mounjaro', 'Zepbound'],
          subsection: 'Metabolic / Incretins',
          tags: ['peptide', 'glp1', 'glp1_agonist', 'incretin'],
          dosages: { rangeText: '2.5 mg weekly SubQ', defaultAmount: 2.5, defaultUnit: 'mg', route: 'SubQ', frequencyText: 'Weekly', maxCeiling: 15 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'glp1',
              severity: 'hard_stop',
              mechanism: 'Duplicate GLP-1 receptor agonist class redundancy and toxicity.',
              recommendation: 'Hard-stop: choose a single incretin/GLP-1 agonist.',
            },
          ],
          synergies: [],
        }),
      );

      // 6 & 7. Oxandrolone + Stanozolol (dual 17aa oral AAS hard-stop)
      const oxandroloneId = await createCompound(
        fixtures.makePedCompound({
          name: 'Oxandrolone',
          canonicalMolecule: 'oxandrolone',
          aliases: ['Anavar'],
          subsection: 'Oral AAS',
          tags: ['ped', 'aas', '17aa_oral', 'hepatotoxic'],
          halfLife: {
            valueHours: 9,
            minHours: 8,
            maxHours: 10,
            displayText: '~9 hours (oral)',
            route: 'Oral',
            kind: 'elimination',
            effectDurationNote: 'Oral C17-alpha-alkylated elimination half-life.',
          },
          dosages: { rangeText: '20 mg daily oral', defaultAmount: 20, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 50 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: '17aa_oral',
              severity: 'hard_stop',
              mechanism: 'Additive cholestatic hepatotoxicity from stacking dual C17-alpha-alkylated oral steroids.',
              recommendation: 'Hard-stop: never stack two 17aa oral AAS compounds.',
            },
          ],
          synergies: [],
          sectionData: {
            compoundClass: 'Oral AAS',
            ester: null,
            esterHalfLifeDays: null,
            oilPreMixed: false,
            concentrationMgPerMl: null,
            vialMl: null,
            c17AlphaAlkylated: true,
            hepatotoxicityRisk: 'moderate',
          },
        }),
      );

      const stanozololId = await createCompound(
        fixtures.makePedCompound({
          name: 'Stanozolol',
          canonicalMolecule: 'stanozolol',
          aliases: ['Winstrol'],
          subsection: 'Oral AAS',
          tags: ['ped', 'aas', '17aa_oral', 'hepatotoxic'],
          halfLife: {
            valueHours: 9,
            minHours: 8,
            maxHours: 10,
            displayText: '~9 hours (oral)',
            route: 'Oral',
            kind: 'elimination',
            effectDurationNote: 'Oral C17-alpha-alkylated elimination half-life.',
          },
          dosages: { rangeText: '20 mg daily oral', defaultAmount: 20, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 50 },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: '17aa_oral',
              severity: 'hard_stop',
              mechanism: 'Severe additive hepatotoxicity from dual C17-alpha-alkylated oral AAS.',
              recommendation: 'Hard-stop: avoid combining two 17aa oral AAS.',
            },
          ],
          synergies: [],
          sectionData: {
            compoundClass: 'Oral AAS',
            ester: null,
            esterHalfLifeDays: null,
            oilPreMixed: false,
            concentrationMgPerMl: null,
            vialMl: null,
            c17AlphaAlkylated: true,
            hepatotoxicityRisk: 'high',
          },
        }),
      );

      // 8 & 9. Multi-route GHK-Cu (SubQ + Topical Serum)
      const ghkSubqId = await createCompound(
        fixtures.makePeptideCompound({
          name: 'GHK-Cu',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Tripeptide-1'],
          tags: ['peptide', 'copper_peptide', 'subq'],
          dosages: { rangeText: '2 mg daily SubQ', defaultAmount: 2, defaultUnit: 'mg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 5 },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const ghkSerumId = await createCompound(
        fixtures.makeDermCompound({
          name: 'GHK-Cu 2% Serum',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Peptide 2% Serum'],
          tags: ['dermatology', 'copper_peptide'],
          dosages: { rangeText: '3 drops PM', defaultAmount: 3, defaultUnit: 'drops', route: 'Topical', frequencyText: 'Daily PM', maxCeiling: 6 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            targetArea: ['face'],
            vehicleType: 'water_serum',
            actives: [{ name: 'GHK-Cu', concentrationPct: 2, optimalPh: 6.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'copper_peptide',
            pregnancySafety: 'caution',
          },
        }),
      );

      // 10, 11 & 12. Adult UL Breaches (single-item AND multi-item cumulative):
      // Vitamin D3 (5,000 IU + Multi 1,000 IU > 4,000 IU UL) + Zinc (50 mg + Multi 15 mg > 40 mg UL)
      const vitDHighId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3 5000 IU',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol 5000'],
          tags: ['supplement', 'vitamin', 'vitamin_d3'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: ['bedtime_fasted'], foodState: 'with_fat', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'With breakfast.' },
          dosages: { rangeText: '5000 IU daily', defaultAmount: 5000, defaultUnit: 'IU', route: 'Oral', frequencyText: 'Daily', maxCeiling: 10000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Cholecalciferol (Vitamin D3)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Vitamin D3', amount: 5000, unit: 'IU' }],
            adultUpperLimit: {
              nutrientKey: 'vitamin_d',
              amount: 4000,
              unit: 'IU',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/',
            },
          },
        }),
      );

      const zincHighId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Zinc Picolinate 50mg',
          canonicalMolecule: 'zinc',
          aliases: ['Zinc 50mg'],
          tags: ['supplement', 'mineral', 'zinc'],
          timingRules: { preferredSlots: ['midday_lunch'], avoidSlots: [], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'With lunch.' },
          dosages: { rangeText: '50 mg daily', defaultAmount: 50, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 100 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Zinc Picolinate',
            elementalWeightMg: 50,
            supplementFacts: [{ nutrient: 'Zinc', amount: 50, unit: 'mg' }],
            adultUpperLimit: {
              nutrientKey: 'zinc',
              amount: 40,
              unit: 'mg',
              basis: 'total_daily',
              sourceUrl: 'https://ods.od.nih.gov/factsheets/Zinc-HealthProfessional/',
            },
          },
        }),
      );

      const multiVitId = await createCompound(
        fixtures.makeSupplementCompound({
          name: 'Daily Multivitamin Complex',
          canonicalMolecule: 'multivitamin-complex',
          aliases: ['Daily Multi'],
          tags: ['supplement', 'multivitamin'],
          timingRules: { preferredSlots: ['morning_am'], avoidSlots: ['bedtime_fasted'], foodState: 'with_meal', workoutRelation: 'any', circadianEffect: 'neutral', timingNotes: 'With breakfast.' },
          dosages: { rangeText: '2 caps daily', defaultAmount: 2, defaultUnit: 'caps', route: 'Oral', frequencyText: 'Daily', maxCeiling: 4 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Multivitamin Capsule Complex',
            elementalWeightMg: null,
            supplementFacts: [
              { nutrient: 'Vitamin D3', amount: 1000, unit: 'IU' },
              { nutrient: 'Zinc', amount: 15, unit: 'mg' },
            ],
            adultUpperLimit: null,
          },
        }),
      );

      const husbandCompoundIds = [
        nineMeBcId,
        igf1Id,
        dihexaId,
        retatrutideId,
        tirzepatideId,
        oxandroloneId,
        stanozololId,
        ghkSubqId,
        ghkSerumId,
        vitDHighId,
        zincHighId,
        multiVitId,
      ];

      const husbandStackRes = await admin.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Husband Comprehensive Safety Matrix Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: nineMeBcId, doseAmount: 15, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: igf1Id, doseAmount: 40, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: dihexaId, doseAmount: 10, doseUnit: 'mg' }),
            fixtures.makeStackItem({
              compoundId: retatrutideId,
              doseAmount: 2,
              doseUnit: 'mg',
              frequency: 'weekly',
              cadence: { type: 'weekly', daysOfWeek: [1] },
            }),
            fixtures.makeStackItem({
              compoundId: tirzepatideId,
              doseAmount: 2.5,
              doseUnit: 'mg',
              frequency: 'weekly',
              cadence: { type: 'weekly', daysOfWeek: [1] },
            }),
            fixtures.makeStackItem({ compoundId: oxandroloneId, doseAmount: 20, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: stanozololId, doseAmount: 20, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: ghkSubqId, doseAmount: 2, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: ghkSerumId, doseAmount: 3, doseUnit: 'drops' }),
            fixtures.makeStackItem({ compoundId: vitDHighId, doseAmount: 5000, doseUnit: 'IU' }),
            fixtures.makeStackItem({ compoundId: zincHighId, doseAmount: 50, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: multiVitId, doseAmount: 2, doseUnit: 'caps' }),
          ],
        }),
      );
      assertStatusIn(husbandStackRes, [200, 201], 'Create Husband Comprehensive Safety Matrix Stack');
      const husbandStackId = getId(unwrapData(husbandStackRes.json, ['stack']));

      const husbInterRes = await admin.post(`/api/v1/members/member_husband/stacks/${husbandStackId}/interactions`, {});
      const husbSchedRes = await admin.post(`/api/v1/members/member_husband/stacks/${husbandStackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(husbInterRes.status, 200, `Husband /interactions failed: ${husbInterRes.text}`);
      assert.equal(husbSchedRes.status, 200, `Husband /schedule failed: ${husbSchedRes.text}`);
      assertNoStore(husbInterRes, 'POST Husband /interactions');
      assertNoStore(husbSchedRes, 'POST Husband /schedule');

      const husbInter = unwrapData(husbInterRes.json, ['interactions']);
      const husbSpread = unwrapData(husbSchedRes.json, ['schedule']);

      // Verify ALL 7 safety rules across BOTH /interactions AND /schedule.interactions
      const checkSafetySurface = (surface, label) => {
        const hardStops = surface.hardStops ?? [];
        const safetyAlerts = surface.safetyAlerts ?? [];
        const redundancies = surface.redundancies ?? [];
        const cautions = surface.cautions ?? [];
        const ulWarnings = surface.ulWarnings ?? [];

        assertAlertMatches(
          [...hardStops, ...safetyAlerts],
          /9.?me.?bc|sertraline|ssri|maoi|serotonin/i,
          `${label}: 9-Me-BC + Sertraline (MAOI + SSRI) hard-stop`,
        );
        assertAlertMatches(
          hardStops,
          /igf|dihexa|oncogenic|proliferat|growth.?factor/i,
          `${label}: IGF-1 LR3 + Dihexa oncogenic hard-stop`,
        );
        assertAlertMatches(
          hardStops,
          /retatrutide|tirzepatide|glp.?1|incretin/i,
          `${label}: Retatrutide + Tirzepatide duplicate GLP-1 hard-stop`,
        );
        assertAlertMatches(
          hardStops,
          /oxandrolone|stanozolol|17.?aa|17α|alkylat|hepato|liver/i,
          `${label}: Dual 17aa oral AAS hard-stop`,
        );
        assertMultiRouteAlert(
          [...cautions, ...safetyAlerts, ...redundancies, ...hardStops],
          /ghk.?cu|copper.?tripeptide/i,
          ghkSubqId,
          ghkSerumId,
          `${label}: Multi-route GHK-Cu cumulative exposure warning`,
        );
        const vitDMatch = assertAlertMatches(
          ulWarnings,
          /vitamin.?d|cholecalciferol/i,
          `${label}: Vitamin D3 Adult UL (>4,000 IU) warning`,
        );
        const zincMatch = assertAlertMatches(
          ulWarnings,
          /\bzinc\b/i,
          `${label}: Zinc Adult UL (>40 mg) warning`,
        );
        assert.notEqual(
          vitDMatch,
          zincMatch,
          `${label}: Vitamin D3 UL and Zinc UL must be distinct warning entries`,
        );
      };

      checkSafetySurface(husbInter, '/interactions');
      checkSafetySurface(husbSpread.interactions ?? {}, '/schedule.interactions');

      // ZERO SILENT DROPS — every single one of Husband's 12 compounds must remain in the schedule!
      const husbandScheduledIds = collectAllScheduledCompoundIds(husbSpread);
      for (const cid of husbandCompoundIds) {
        assert.ok(
          husbandScheduledIds.has(cid),
          `Husband Zero Silent Drops violation: high-risk compound ${cid} was silently removed from schedule!`,
        );
      }
    } finally {
      await server.stop();
    }
  });
});
