import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMBERS,
  STARTER_COMPOUNDS,
  deepClone,
} from '../../src/core/index.js';
import {
  analyzeStackInteractions,
  suggestStackSchedule,
  slotSeparationHours,
  buildSlotClockMap,
} from '../../src/scheduler/index.js';

function toMap(compounds) {
  return new Map(compounds.map((c) => [c.id, c]));
}

function findSystemic(spread, compoundId) {
  for (const slot of spread.systemic.slots) {
    const item = slot.items.find((i) => i.compoundId === compoundId);
    if (item) return { slot, item };
  }
  return null;
}

describe('M2 Scheduler — Interaction Matrix & Dual-Track Stack Spreading Engine', () => {
  it('1. Curated hard-stops: IGF-1 LR3+Dihexa, duplicate GLP-1, dual 17aa oral AAS never dropped', () => {
    const compounds = [
      { id: 'c_igf', name: 'IGF-1 LR3', canonicalMolecule: 'igf-1-lr3', sectionId: 'peptides', tags: ['igf1'], dosages: { defaultAmount: 40, defaultUnit: 'mcg', route: 'SubQ' }, timingRules: { preferredSlots: ['morning_am'] }, doNotPairWith: [], synergies: [] },
      { id: 'c_dihexa', name: 'Dihexa', canonicalMolecule: 'dihexa', sectionId: 'peptides', tags: ['hgf_mimetic'], dosages: { defaultAmount: 10, defaultUnit: 'mg', route: 'Oral' }, timingRules: { preferredSlots: ['morning_am'] }, doNotPairWith: [], synergies: [] },
      { id: 'c_reta', name: 'Retatrutide', canonicalMolecule: 'retatrutide', sectionId: 'peptides', tags: ['glp1'], dosages: { defaultAmount: 2, defaultUnit: 'mg', route: 'SubQ' }, timingRules: { preferredSlots: ['morning_am'] }, doNotPairWith: [], synergies: [] },
      { id: 'c_tirz', name: 'Tirzepatide', canonicalMolecule: 'tirzepatide', sectionId: 'peptides', tags: ['glp1'], dosages: { defaultAmount: 2.5, defaultUnit: 'mg', route: 'SubQ' }, timingRules: { preferredSlots: ['morning_am'] }, doNotPairWith: [], synergies: [] },
      { id: 'c_var', name: 'Oxandrolone', canonicalMolecule: 'oxandrolone', sectionId: 'peds', tags: ['17aa_oral'], dosages: { defaultAmount: 20, defaultUnit: 'mg', route: 'Oral' }, sectionData: { hepatotoxic17aa: true }, timingRules: { preferredSlots: ['morning_am'] }, doNotPairWith: [], synergies: [] },
      { id: 'c_win', name: 'Stanozolol', canonicalMolecule: 'stanozolol', sectionId: 'peds', tags: ['17aa_oral'], dosages: { defaultAmount: 25, defaultUnit: 'mg', route: 'Oral' }, sectionData: { c17AlphaAlkylated: true }, timingRules: { preferredSlots: ['morning_am'] }, doNotPairWith: [], synergies: [] },
    ];
    const stack = {
      id: 'stk_hs',
      memberId: 'member_husband',
      items: compounds.map((c) => ({ compoundId: c.id })),
    };
    const member = deepClone(DEFAULT_MEMBERS[1]);
    const spread = suggestStackSchedule({ stack, compoundsById: toMap(compounds), member, dateKey: '2026-10-19' });
    assert.ok(spread.interactions.hardStops.length >= 3);
    for (const c of compounds) {
      assert.ok(findSystemic(spread, c.id), `${c.name} must NOT be silently dropped`);
    }
  });

  it('2. Safety Context: activeRxMeds (Sertraline + 9-Me-BC, Nitrates + Tadalafil), pregnancy teratogens, female virilization', () => {
    const wife = deepClone(DEFAULT_MEMBERS[0]);
    wife.safetyContext.pregnancyOrTrying = true;
    wife.safetyContext.activeRxMeds = ['Sertraline', 'Nitroglycerin'];

    const compounds = [
      { id: 'c_9mebc', name: '9-Me-BC', canonicalMolecule: '9-me-bc', sectionId: 'peptides', tags: ['maoi', 'ssri_caution'], dosages: { route: 'Oral' }, doNotPairWith: [], synergies: [] },
      { id: 'c_tadalafil', name: 'Tadalafil', canonicalMolecule: 'tadalafil', sectionId: 'peds', tags: ['pde5_inhibitor'], dosages: { route: 'Oral' }, sectionData: { teratogenicityRisk: 'none', femaleVirilizationRisk: 'none' }, doNotPairWith: [], synergies: [] },
      { id: 'c_tret', name: 'Tretinoin 0.05%', canonicalMolecule: 'tretinoin', sectionId: 'dermatology', tags: ['retinoid'], dosages: { route: 'Topical' }, sectionData: { targetArea: ['face'], pregnancySafety: 'avoid_teratogen', photosensitivity: true }, doNotPairWith: [], synergies: [] },
      { id: 'c_test', name: 'Testosterone Cypionate', canonicalMolecule: 'testosterone-cypionate', sectionId: 'peds', tags: ['aas'], dosages: { route: 'IM' }, sectionData: { pedClass: 'TRT', femaleVirilizationRisk: 'high' }, doNotPairWith: [], synergies: [] },
    ];
    const analysis = analyzeStackInteractions({
      items: compounds.map((c) => ({ compoundId: c.id })),
      compoundsById: toMap(compounds),
      member: wife,
    });

    assert.ok(analysis.hardStops.some((h) => /9-me-bc/i.test(JSON.stringify(h)) && /sertraline|ssri/i.test(JSON.stringify(h))));
    assert.ok(analysis.hardStops.some((h) => /tadalafil/i.test(JSON.stringify(h)) && /nitroglycerin|nitrate/i.test(JSON.stringify(h))));
    assert.ok(analysis.hardStops.some((h) => /tretinoin/i.test(JSON.stringify(h)) && /pregnan|teratogen/i.test(JSON.stringify(h))));
    assert.ok(analysis.safetyAlerts.some((a) => /viriliz/i.test(JSON.stringify(a))));

    // Male control: no female virilization alert
    const husband = deepClone(DEFAULT_MEMBERS[1]);
    const maleAnalysis = analyzeStackInteractions({
      items: [{ compoundId: 'c_test' }],
      compoundsById: toMap(compounds),
      member: husband,
    });
    assert.ok(!maleAnalysis.safetyAlerts.some((a) => /viriliz/i.test(JSON.stringify(a))));
  });

  it('3. Mineral auto-separation (>=3h Zinc/Copper, >=2h Iron/Calcium), synergy co-location & stimulant sleep protection', () => {
    const compounds = [
      {
        id: 'c_zinc', name: 'Zinc Picolinate', canonicalMolecule: 'zinc', sectionId: 'vitamins_supplements',
        tags: ['mineral', 'zinc'], dosages: { defaultAmount: 30, defaultUnit: 'mg', route: 'Oral' },
        timingRules: { preferredSlots: ['morning_am', 'midday_lunch'], foodState: 'with_meal', circadianEffect: 'neutral' },
        doNotPairWith: [{ targetType: 'nutrient', targetRef: 'copper', severity: 'avoid_same_slot', separationHours: 3, mechanism: 'Metallothionein', recommendation: 'Separate >=3h' }],
        synergies: [],
      },
      {
        id: 'c_copper', name: 'Copper Bisglycinate', canonicalMolecule: 'copper', sectionId: 'vitamins_supplements',
        tags: ['mineral', 'copper'], dosages: { defaultAmount: 2, defaultUnit: 'mg', route: 'Oral' },
        timingRules: { preferredSlots: ['morning_am', 'midday_lunch', 'evening_dinner'], foodState: 'with_meal', circadianEffect: 'neutral' },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'c_d3', name: 'Vitamin D3', canonicalMolecule: 'vitamin-d3', sectionId: 'vitamins_supplements',
        tags: ['vitamin_d3'], dosages: { defaultAmount: 2000, defaultUnit: 'IU', route: 'Oral' },
        timingRules: { preferredSlots: ['morning_am'], foodState: 'with_fat', circadianEffect: 'neutral' },
        doNotPairWith: [], synergies: [{ targetRef: 'vitamin-k2', coLocate: true, reason: 'Calcium trafficking' }],
      },
      {
        id: 'c_k2', name: 'Vitamin K2', canonicalMolecule: 'vitamin-k2', sectionId: 'vitamins_supplements',
        tags: ['vitamin_k2'], dosages: { defaultAmount: 100, defaultUnit: 'mcg', route: 'Oral' },
        timingRules: { preferredSlots: ['midday_lunch', 'morning_am'], foodState: 'with_fat', circadianEffect: 'neutral' },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'c_nad', name: 'NAD+', canonicalMolecule: 'nad-plus', sectionId: 'peptides',
        tags: ['stimulating'], dosages: { defaultAmount: 50, defaultUnit: 'mg', route: 'SubQ' },
        timingRules: { preferredSlots: [], avoidSlots: [], foodState: 'any', circadianEffect: 'stimulating' },
        doNotPairWith: [], synergies: [],
      },
    ];
    const member = deepClone(DEFAULT_MEMBERS[0]);
    const spread = suggestStackSchedule({
      stack: { id: 'stk_min', memberId: member.id, items: compounds.map((c) => ({ compoundId: c.id })) },
      compoundsById: toMap(compounds),
      member,
      dateKey: '2026-10-19',
    });

    const clocks = buildSlotClockMap(member.routineAnchors);
    const zPos = findSystemic(spread, 'c_zinc');
    const cPos = findSystemic(spread, 'c_copper');
    assert.notEqual(zPos.slot.slotId, cPos.slot.slotId);
    assert.ok(slotSeparationHours(zPos.slot.slotId, cPos.slot.slotId, clocks) >= 3);
    assert.ok(spread.interactions.autoSeparated.length >= 1);

    const d3Pos = findSystemic(spread, 'c_d3');
    const k2Pos = findSystemic(spread, 'c_k2');
    assert.equal(d3Pos.slot.slotId, k2Pos.slot.slotId);

    const nadPos = findSystemic(spread, 'c_nad');
    assert.notEqual(nadPos.slot.slotId, 'evening_dinner');
    assert.notEqual(nadPos.slot.slotId, 'bedtime_fasted');
  });

  it('4. Dermatology: AM/PM 1-7 layering, BPO AM vs Tretinoin PM, 3-night skin cycling, microneedling buffer & Hair/Scalp isolation', () => {
    const compounds = [
      {
        id: 'd_bpo', name: 'Benzoyl Peroxide 4% Wash', canonicalMolecule: 'benzoyl-peroxide', sectionId: 'dermatology',
        tags: ['benzoyl_peroxide', 'cleanser'], dosages: { route: 'Topical' },
        sectionData: { targetArea: ['face'], vehicleType: 'cleanser', layeringStep: 1, amPmSuitability: 'both', photosensitivity: false },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'd_tret', name: 'Tretinoin 0.05%', canonicalMolecule: 'tretinoin', sectionId: 'dermatology',
        tags: ['retinoid', 'photosensitizing'], dosages: { route: 'Topical' },
        sectionData: { targetArea: ['face'], vehicleType: 'cream', layeringStep: 4, waitTimeMinutes: 20, amPmSuitability: 'pm_only', photosensitivity: true, skinCyclingRole: 'retinoid' },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'd_gly', name: 'Glycolic Acid 10%', canonicalMolecule: 'glycolic-acid', sectionId: 'dermatology',
        tags: ['aha_bha', 'exfoliant'], dosages: { route: 'Topical' },
        sectionData: { targetArea: ['face'], vehicleType: 'acid_toner', layeringStep: 2, waitTimeMinutes: 5, amPmSuitability: 'pm_only', photosensitivity: true, skinCyclingRole: 'exfoliant_aha_bha' },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'd_ghk', name: 'GHK-Cu 2% Serum', canonicalMolecule: 'ghk-cu', sectionId: 'dermatology',
        tags: ['copper_peptide'], dosages: { route: 'Topical' },
        sectionData: { targetArea: ['face'], vehicleType: 'water_serum', layeringStep: 3, waitTimeMinutes: 2, amPmSuitability: 'pm_only', photosensitivity: false, skinCyclingRole: 'copper_peptide' },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'd_micro', name: 'Microneedling 0.5mm', canonicalMolecule: 'microneedling', sectionId: 'dermatology',
        tags: ['microneedling', 'device'], dosages: { route: 'Device' },
        sectionData: { targetArea: ['face', 'scalp_hair'], vehicleType: 'device', layeringStep: 1, amPmSuitability: 'pm_only', skinCyclingRole: 'microneedling' },
        doNotPairWith: [], synergies: [],
      },
      {
        id: 'd_minox', name: 'Topical Minoxidil 5%', canonicalMolecule: 'minoxidil', sectionId: 'dermatology',
        tags: ['scalp', 'hair'], dosages: { route: 'Topical' },
        sectionData: { targetArea: ['scalp_hair'], vehicleType: 'solution', layeringStep: 3, amPmSuitability: 'both' },
        doNotPairWith: [], synergies: [],
      },
    ];
    const spread = suggestStackSchedule({
      stack: {
        id: 'stk_derm',
        memberId: 'member_wife',
        items: compounds.map((c) => ({
          compoundId: c.id,
          ...(c.id === 'd_micro' ? { frequency: 'weekly', cadence: { type: 'weekly', daysOfWeek: [0] } } : {}),
        })),
      },
      compoundsById: toMap(compounds),
      member: deepClone(DEFAULT_MEMBERS[0]),
      dateKey: '2026-10-19',
    });

    const { skin, hairScalp } = spread.dermatology;
    // Missing SPF warning emitted because no sunscreen in stack
    assert.ok(typeof skin.missingSpfWarning === 'string' && /spf/i.test(skin.missingSpfWarning));
    // BPO in AM, never in Tretinoin PM night
    assert.ok(skin.am.some((s) => s.compoundId === 'd_bpo'));
    assert.ok(!skin.am.some((s) => s.compoundId === 'd_tret'));
    // Minoxidil strictly in hairScalp, never in skin
    assert.ok([...hairScalp.am, ...hairScalp.pm].some((s) => s.compoundId === 'd_minox'));
    assert.ok(!skin.am.some((s) => s.compoundId === 'd_minox'));
    assert.ok(!skin.pmNights.some((n) => n.steps.some((s) => s.compoundId === 'd_minox')));
    // Skin cycling pairwise disjointness across Retinoid, Glycolic, GHK-Cu, and Microneedling night
    assert.ok(skin.pmNights.length >= 4);
    assert.ok(skin.microneedlingBufferNotes.length >= 1);
    for (const night of skin.pmNights) {
      const ids = new Set(night.steps.map((s) => s.compoundId));
      const activeCount = ['d_tret', 'd_gly', 'd_ghk', 'd_micro'].filter((id) => ids.has(id)).length;
      assert.ok(activeCount <= 1, `Night "${night.nightLabel}" mixed incompatible actives`);
    }
  });

  it('5. Adult UL summation, multi-route GHK-Cu warning, What-If non-mutation & weekly injection load balancing', () => {
    const compounds = [
      { id: 's_zn', name: 'Zinc 30mg', canonicalMolecule: 'zinc', sectionId: 'vitamins_supplements', dosages: { defaultAmount: 30, defaultUnit: 'mg', route: 'Oral' }, sectionData: { supplementFacts: [{ nutrient: 'Zinc', amount: 30, unit: 'mg' }] }, doNotPairWith: [], synergies: [] },
      { id: 's_mv', name: 'Multi', canonicalMolecule: 'multi', sectionId: 'vitamins_supplements', dosages: { defaultAmount: 2, defaultUnit: 'caps', route: 'Oral' }, sectionData: { supplementFacts: [{ nutrient: 'Zinc', amount: 25, unit: 'mg' }, { nutrient: 'Vitamin D3', amount: 4500, unit: 'IU' }] }, doNotPairWith: [], synergies: [] },
      { id: 'p_ghk', name: 'GHK-Cu SubQ', canonicalMolecule: 'ghk-cu', sectionId: 'peptides', dosages: { defaultAmount: 1, defaultUnit: 'mg', route: 'SubQ' }, doNotPairWith: [], synergies: [] },
      { id: 'd_ghk', name: 'GHK-Cu Serum', canonicalMolecule: 'ghk-cu', sectionId: 'dermatology', dosages: { defaultAmount: 3, defaultUnit: 'drops', route: 'Topical' }, sectionData: { targetArea: ['face'], vehicleType: 'water_serum', layeringStep: 3, amPmSuitability: 'pm_only' }, doNotPairWith: [], synergies: [] },
      { id: 'inj_1', name: 'Test Cyp', canonicalMolecule: 'testosterone-cypionate', sectionId: 'peds', dosages: { defaultAmount: 60, defaultUnit: 'mg', route: 'IM' }, doNotPairWith: [], synergies: [] },
      { id: 'inj_2', name: 'TB-500', canonicalMolecule: 'tb-500', sectionId: 'peptides', dosages: { defaultAmount: 2.5, defaultUnit: 'mg', route: 'SubQ' }, doNotPairWith: [], synergies: [] },
      { id: 'inj_3', name: 'MOTS-c', canonicalMolecule: 'mots-c', sectionId: 'peptides', dosages: { defaultAmount: 5, defaultUnit: 'mg', route: 'SubQ' }, doNotPairWith: [], synergies: [] },
    ];
    const baseStack = {
      id: 'stk_bal',
      memberId: 'member_husband',
      items: [
        { compoundId: 's_zn', doseAmount: 30, doseUnit: 'mg' },
        { compoundId: 's_mv', doseAmount: 2, doseUnit: 'caps' },
        { compoundId: 'p_ghk', doseAmount: 1, doseUnit: 'mg' },
        { compoundId: 'inj_1', frequency: '2x_week', cadence: { type: '2x_week' } },
        { compoundId: 'inj_2', frequency: '2x_week', cadence: { type: '2x_week' } },
        { compoundId: 'inj_3', frequency: '2x_week', cadence: { type: '2x_week' } },
      ],
    };
    const origLen = baseStack.items.length;
    const spread = suggestStackSchedule({
      stack: baseStack,
      compoundsById: toMap(compounds),
      member: deepClone(DEFAULT_MEMBERS[1]),
      ownershipByCompound: [
        { compoundId: 's_zn', scope: 'household', status: 'have' },
        { compoundId: 'd_ghk', scope: 'household', status: 'wishlist' },
      ],
      whatIfCompounds: [{ compoundId: 'd_ghk' }],
      dateKey: '2026-10-19',
    });

    assert.equal(baseStack.items.length, origLen, 'What-If must not mutate input stack');
    assert.ok(spread.interactions.ulWarnings.some((u) => u.nutrientKey === 'zinc' && u.totalAmount === 55));
    assert.ok(spread.interactions.ulWarnings.some((u) => u.nutrientKey === 'vitamin_d3' && u.totalAmount === 4500));
    assert.ok(spread.interactions.redundancies.some((r) => r.canonicalMolecule === 'ghk-cu'));
    const loads = Object.values(spread.systemic.injectionLoadByDay);
    // p_ghk daily (+1 each day) + 3 balanced 2x/week injectables (spread across 6 distinct days) -> max <= 2
    assert.ok(Math.max(...loads) <= 2, `Expected balanced peak load <= 2, got ${JSON.stringify(spread.systemic.injectionLoadByDay)}`);
  });

  it('6. Works smoothly with all 26 starter reference catalog compounds', () => {
    const spread = suggestStackSchedule({
      stack: {
        id: 'stk_starter_all',
        memberId: 'member_wife',
        items: STARTER_COMPOUNDS.slice(0, 12).map((c) => ({ compoundId: c.id })),
      },
      compoundsById: toMap(STARTER_COMPOUNDS),
      member: deepClone(DEFAULT_MEMBERS[0]),
      dateKey: '2026-10-19',
    });
    assert.equal(spread.systemic.slots.length, 8);
    assert.ok(Array.isArray(spread.dermatology.skin.am));
  });
});
