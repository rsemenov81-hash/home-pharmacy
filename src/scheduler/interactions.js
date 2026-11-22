/**
 * Curated Global Pharmacology & Dermatology Interaction Matrix + Bidirectional
 * Stack Interaction Analyzer (F12, F13, F14, F15, F16, F34).
 *
 * Pure ESM, zero UI/DOM/Node-only dependencies.
 */

import {
  ADULT_UPPER_LIMITS,
  MASS_TO_MCG,
  normName,
  normRoute,
  resolveCanonicalMolecule,
  toMassMcg,
  parseFiniteNumber,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// Curated Global Pharmacology & Dermatology Interaction Bank
// ---------------------------------------------------------------------------

export const CURATED_PAIR_INTERACTIONS = Object.freeze([
  // HARD STOPS
  {
    id: 'hs_igf1_dihexa',
    a: ['igf-1-lr3', 'igf1-lr3', 'igf-1', 'igf1', 'igf1lr3', 'long r3 igf-1'],
    b: ['dihexa', 'pnb-0408', 'hgf_mimetic'],
    severity: 'hard_stop',
    mechanism:
      'Dual mitogenic growth-factor pathway amplification (IGF-1R + HGF/c-Met) carries compounding theoretical oncogenic proliferation risk.',
    recommendation:
      'Hard stop: do not co-administer IGF-1 LR3 and Dihexa concurrently.',
    citation: 'Pathway pharmacology harm-reduction reference (IGF-1R / HGF-cMet)',
  },
  {
    id: 'hs_duplicate_glp1',
    sameClass: ['glp1', 'incretin', 'glp-1', 'glp1_agonist', 'triple_agonist', 'dual_agonist'],
    sameMolecules: ['retatrutide', 'tirzepatide', 'semaglutide', 'liraglutide', 'dulaglutide', 'mazdutide', 'survodutide'],
    severity: 'hard_stop',
    mechanism:
      'Stacking two GLP-1 / incretin receptor agonists causes additive severe gastroparesis, dehydration, hypoglycemia, and pancreatitis risk.',
    recommendation:
      'Hard stop: select a single GLP-1 / incretin agent; do not combine multiple GLP-1 agonists.',
    citation: 'FDA GLP-1 RA prescribing class warnings',
  },
  {
    id: 'hs_dual_17aa_oral',
    predicate: (a, b) => is17aaOral(a) && is17aaOral(b),
    severity: 'hard_stop',
    mechanism:
      'Combining two 17α-alkylated oral androgens causes synergistic cholestatic hepatotoxicity, transaminase elevation, and severe HDL suppression.',
    recommendation:
      'Hard stop: never stack two 17α-alkylated oral AAS simultaneously; monitor CMP/GGT/lipids.',
    citation: 'Endocrine & hepatotoxicity harm-reduction reference (17α-alkylated AAS)',
  },

  // MINERAL & ABSORPTION SEPARATION (avoid_same_slot)
  {
    id: 'sep_zinc_copper',
    a: ['zinc', 'zinc-picolinate', 'zinc-bisglycinate', 'zinc-citrate'],
    b: ['copper', 'copper-bisglycinate', 'copper-glycinate', 'copper-gluconate'],
    systemicOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 2,
    mechanism:
      'Zinc induces intestinal metallothionein, competitively blocking copper absorption.',
    recommendation: 'Separate oral Zinc and Copper by at least 2 hours.',
    citation: 'NIH ODS Zinc & Copper Health Professional Fact Sheets',
  },
  {
    id: 'sep_iron_calcium',
    a: ['iron', 'ferrous-bisglycinate', 'iron-bisglycinate', 'ferrous-sulfate'],
    b: ['calcium', 'calcium-citrate', 'calcium-carbonate'],
    systemicOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 2,
    mechanism:
      'Calcium inhibits DMT1-mediated intestinal iron transport for both heme and non-heme iron.',
    recommendation: 'Separate Iron and Calcium by at least 2 hours.',
    citation: 'NIH ODS Iron Health Professional Fact Sheet',
  },
  {
    id: 'sep_iron_magnesium',
    a: ['iron', 'ferrous-bisglycinate', 'iron-bisglycinate'],
    b: ['magnesium', 'magnesium-glycinate', 'magnesium-l-threonate', 'magnesium-citrate'],
    systemicOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 2,
    mechanism: 'Divalent cations compete for intestinal absorption when co-ingested.',
    recommendation: 'Separate Iron and Magnesium by at least 2 hours.',
  },
  {
    id: 'sep_iron_zinc',
    a: ['iron', 'ferrous-bisglycinate', 'iron-bisglycinate'],
    b: ['zinc', 'zinc-picolinate', 'zinc-bisglycinate'],
    systemicOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 2,
    mechanism: 'High-dose elemental Iron and Zinc compete for DMT1 intestinal transport.',
    recommendation: 'Separate Iron and Zinc by at least 2 hours.',
  },
  {
    id: 'sep_thyroid_minerals',
    a: ['levothyroxine', 'thyroid', 't4', 't3', 'liothyronine'],
    b: ['iron', 'calcium', 'magnesium'],
    systemicOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 4,
    mechanism: 'Polyvalent cations chelate thyroid hormones in the GI tract and impair absorption.',
    recommendation: 'Separate thyroid hormone from Iron/Calcium/Magnesium by at least 4 hours.',
  },

  // DERMATOLOGY CO-LAYERING CONFLICTS
  {
    id: 'derm_bpo_retinoid',
    a: ['benzoyl-peroxide', 'benzoyl_peroxide', 'bpo'],
    b: ['retinoid', 'tretinoin', 'retinol', 'retinaldehyde', 'tazarotene'],
    dermOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 12,
    mechanism: 'Benzoyl peroxide oxidizes and degrades tretinoin/retinoids upon co-application.',
    recommendation: 'Use Benzoyl Peroxide in AM and Retinoid in PM (never same routine).',
  },
  {
    id: 'derm_vitc_copper_peptide',
    a: ['vitamin-c-topical', 'l-ascorbic-acid', 'antioxidant_vit_c', 'vitamin_c'],
    b: ['ghk-cu', 'copper_peptide', 'copper-tripeptide-1'],
    dermOnly: true,
    severity: 'avoid_same_slot',
    separationHours: 12,
    mechanism: 'Low-pH L-ascorbic acid destabilizes and oxidizes copper peptide complexes.',
    recommendation: 'Place Vitamin C serum in AM and GHK-Cu topical serum in PM.',
  },
  {
    id: 'derm_retinoid_aha_bha',
    a: ['retinoid', 'tretinoin', 'adapalene', 'tazarotene', 'retinol', 'retinaldehyde'],
    b: ['exfoliant_aha_bha', 'exfoliant', 'aha_bha', 'aha', 'bha', 'glycolic-acid', 'salicylic-acid', 'lactic-acid', 'mandelic-acid'],
    dermOnly: true,
    severity: 'alternate_days',
    mechanism: 'Combining retinoids and strong AHA/BHA acids on the same night compounds stratum corneum barrier disruption.',
    recommendation: 'Use Retinoid and AHA/BHA exfoliants on alternating PM skin-cycling nights.',
  },
  {
    id: 'derm_retinoid_copper_peptide',
    a: ['retinoid', 'tretinoin', 'adapalene', 'tazarotene', 'retinol'],
    b: ['ghk-cu', 'copper_peptide', 'copper-tripeptide-1'],
    dermOnly: true,
    severity: 'alternate_days',
    mechanism: 'Co-layering potent remodeling actives increases skin sensitivity and reduces tolerability.',
    recommendation: 'Alternate PM nights between Retinoid and GHK-Cu topical serum.',
  },
  {
    id: 'derm_aha_copper_peptide',
    a: ['exfoliant_aha_bha', 'exfoliant', 'aha_bha', 'aha', 'bha', 'glycolic-acid', 'salicylic-acid', 'lactic-acid'],
    b: ['ghk-cu', 'copper_peptide', 'copper-tripeptide-1'],
    dermOnly: true,
    severity: 'alternate_days',
    mechanism: 'Acidic AHA/BHA pH (<3.8) dissociates copper ions from GHK-Cu peptide complexes.',
    recommendation: 'Schedule AHA/BHA exfoliants and GHK-Cu serum on alternating PM nights.',
  },
  {
    id: 'derm_microneedling_irritants',
    a: ['microneedling', 'dermapen', 'dermaroller'],
    b: ['retinoid', 'tretinoin', 'exfoliant_aha_bha', 'exfoliant', 'aha_bha', 'glycolic-acid', 'salicylic-acid', 'benzoyl-peroxide', 'vitamin-c-topical', 'minoxidil'],
    dermOnly: true,
    severity: 'alternate_days',
    separationHours: 24,
    mechanism: 'Micro-channels increase transdermal penetration and irritation risk from acids, retinoids, BPO, and minoxidil.',
    recommendation: 'Hold irritating actives and topical Minoxidil for 12–24 hours after microneedling.',
  },
]);

export const CURATED_SYNERGIES = Object.freeze([
  {
    id: 'syn_d3_k2',
    a: ['vitamin-d3', 'vitamin_d3', 'cholecalciferol'],
    b: ['vitamin-k2', 'vitamin_k2', 'menaquinone-7', 'mk-7'],
    coLocate: true,
    reason: 'Vitamin K2 directs Vitamin D3-mobilized calcium into bone rather than soft tissue.',
  },
  {
    id: 'syn_d3_omega3',
    a: ['vitamin-d3', 'vitamin_d3', 'cholecalciferol'],
    b: ['omega-3', 'omega_3', 'omega3', 'fish-oil', 'epa-dha'],
    coLocate: true,
    reason: 'Dietary lipids in Omega-3 enhance fat-soluble Vitamin D3 absorption.',
  },
  {
    id: 'syn_k2_omega3',
    a: ['vitamin-k2', 'vitamin_k2', 'menaquinone-7'],
    b: ['omega-3', 'omega_3', 'omega3', 'fish-oil'],
    coLocate: true,
    reason: 'Fat-soluble Vitamin K2 absorbs best alongside Omega-3 lipids.',
  },
  {
    id: 'syn_ipa_cjc',
    a: ['ipamorelin'],
    b: ['cjc-1295', 'cjc1295-no-dac', 'cjc-1295-no-dac', 'mod-grf-1-29'],
    coLocate: true,
    reason: 'GHRP (Ipamorelin) + GHRH (CJC-1295) co-administration synergistically amplifies pulsatile GH release.',
  },
  {
    id: 'syn_bpc_tb500',
    a: ['bpc-157'],
    b: ['tb-500', 'tb500', 'thymosin-beta-4'],
    coLocate: true,
    reason: 'Complementary tissue-repair and angiogenesis pathways.',
  },
  {
    id: 'syn_iron_vitc',
    a: ['iron', 'iron-bisglycinate', 'ferrous-bisglycinate'],
    b: ['vitamin-c', 'ascorbic-acid'],
    systemicOnly: true,
    coLocate: true,
    reason: 'Oral Vitamin C enhances non-heme iron absorption.',
  },
]);

// Rx Medication Synonym Groups for member.safetyContext.activeRxMeds
const RX_MED_SYNONYM_GROUPS = Object.freeze({
  ssri: [
    'ssri', 'snri', 'sertraline', 'zoloft', 'fluoxetine', 'prozac',
    'escitalopram', 'lexapro', 'citalopram', 'celexa', 'paroxetine', 'paxil',
    'fluvoxamine', 'venlafaxine', 'effexor', 'duloxetine', 'cymbalta', 'desvenlafaxine',
  ],
  nitrates: [
    'nitrate', 'nitrates', 'nitroglycerin', 'nitrostat', 'isosorbide',
    'isosorbide mononitrate', 'isosorbide dinitrate', 'imdur', 'amyl nitrite', 'poppers',
  ],
  anticoagulant: [
    'anticoagulant', 'blood thinner', 'warfarin', 'coumadin',
    'apixaban', 'eliquis', 'rivaroxaban', 'xarelto', 'dabigatran', 'heparin', 'clopidogrel',
  ],
  maoi: ['maoi', 'phenelzine', 'tranylcypromine', 'selegiline', 'rasagiline', 'linezolid', 'moclobemide'],
});

const CURATED_RX_INTERACTIONS = Object.freeze([
  {
    id: 'rx_ssri_maoi_serotonin',
    rxGroup: 'ssri',
    compoundRefs: ['9-me-bc', '9mebc', 'maoi', 'ssri_caution', 'methylene-blue', 'st-johns-wort', '5-htp', 'harmaline'],
    severity: 'hard_stop',
    mechanism:
      'MAO inhibition / serotonergic activity combined with an SSRI/SNRI risks life-threatening serotonin syndrome.',
    recommendation:
      'Hard stop: do not combine with SSRI/SNRI prescription medications (e.g., Sertraline).',
  },
  {
    id: 'rx_nitrates_pde5',
    rxGroup: 'nitrates',
    compoundRefs: ['tadalafil', 'sildenafil', 'vardenafil', 'avanafil', 'pde5_inhibitor', 'cialis', 'viagra'],
    severity: 'hard_stop',
    mechanism:
      'Synergistic nitric oxide / cGMP vasodilation causes severe, potentially fatal hypotension.',
    recommendation:
      'Hard stop: strictly contraindicated with organic nitrates (Nitroglycerin, Isosorbide).',
  },
]);

// ---------------------------------------------------------------------------
// Matching & Normalization Helpers
// ---------------------------------------------------------------------------

function normToken(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function normLoose(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, '');
}

function getCompoundTokens(compound) {
  const tokens = new Set();
  const add = (val) => {
    if (!val || typeof val !== 'string') return;
    const t = normToken(val);
    const l = normLoose(val);
    const n = normName(val);
    if (t) tokens.add(t);
    if (l) tokens.add(l);
    if (n) tokens.add(n);
    // Also add underscore variant
    const u = t.replace(/-/g, '_');
    if (u) tokens.add(u);
  };

  add(compound.id);
  add(compound.slug);
  add(compound.name);
  add(compound.canonicalMolecule);
  const resolved = resolveCanonicalMolecule(compound.canonicalMolecule || compound.name, compound.aliases || []);
  add(resolved);

  for (const a of compound.aliases || []) add(a);
  for (const tag of compound.tags || []) add(tag);
  if (compound.subsection) add(compound.subsection);

  const sd = compound.sectionData || {};
  add(sd.pedClass);
  add(sd.compoundClass);
  add(sd.skinCyclingRole);
  add(sd.chemicalForm);
  add(sd.vehicleType);

  const facts = Array.isArray(sd.ingredientsList)
    ? sd.ingredientsList
    : Array.isArray(sd.supplementFacts)
      ? sd.supplementFacts
      : [];
  for (const f of facts) {
    add(f?.name);
    add(f?.nutrient);
  }
  if (Array.isArray(sd.actives)) {
    for (const act of sd.actives) add(act?.name);
  }
  return tokens;
}

function compoundMatchesRef(compound, ref, targetType = null) {
  if (!compound || !ref) return false;
  const rToken = normToken(ref);
  const rLoose = normLoose(ref);
  const rNorm = normName(ref);
  if (!rToken && !rLoose) return false;

  const tokens = getCompoundTokens(compound);
  if (tokens.has(rToken) || tokens.has(rLoose) || (rNorm && tokens.has(rNorm))) {
    return true;
  }

  // Handle synonym shortcuts (e.g., targetRef: 'aha_bha' matching 'exfoliant_aha_bha' or 'glycolic-acid')
  if (rLoose === 'ahabha' || rLoose === 'exfoliantahabha' || rLoose === 'exfoliant') {
    for (const k of ['ahabha', 'exfoliantahabha', 'exfoliant', 'aha', 'bha', 'glycolicacid', 'salicylicacid', 'lacticacid']) {
      if (tokens.has(k)) return true;
    }
  }
  if (rLoose === 'retinoid') {
    for (const k of ['retinoid', 'tretinoin', 'retinol', 'adapalene', 'tazarotene', 'retinaldehyde']) {
      if (tokens.has(k)) return true;
    }
  }
  if (rLoose === 'copperpeptide' || rLoose === 'ghkcu') {
    for (const k of ['copperpeptide', 'ghkcu', 'coppertripeptide1']) {
      if (tokens.has(k)) return true;
    }
  }
  if (rLoose === 'glp1' || rLoose === 'incretin') {
    for (const k of ['glp1', 'incretin', 'retatrutide', 'tirzepatide', 'semaglutide', 'liraglutide']) {
      if (tokens.has(k)) return true;
    }
  }
  if (targetType === 'nutrient') {
    const nk = normalizeNutrientKey(ref);
    if (nk) {
      const cnk = normalizeNutrientKey(compound.canonicalMolecule || compound.name);
      if (cnk === nk) return true;
    }
  }
  return false;
}

function compoundMatchesAnyRef(compound, refs = []) {
  return refs.some((r) => compoundMatchesRef(compound, r));
}

export function isDermatologyCompound(compound) {
  if (!compound) return false;
  if (compound.sectionId === 'dermatology') return true;
  const route = normRoute(compound.dosages?.route || '');
  if (route === 'Topical' || route === 'Device') {
    if (Array.isArray(compound.sectionData?.targetArea) && compound.sectionData.targetArea.length > 0) {
      return true;
    }
  }
  return false;
}

function is17aaOral(compound) {
  if (!compound) return false;
  const sd = compound.sectionData || {};
  if (sd.hepatotoxic17aa === true || sd.c17AlphaAlkylated === true) return true;
  const tokens = getCompoundTokens(compound);
  for (const k of [
    '17aaoral', '17aa', 'oxandrolone', 'anavar', 'stanozolol', 'winstrol',
    'dianabol', 'methandrostenolone', 'anadrol', 'oxymetholone', 'turinabol',
    'superdrol', 'halotestin',
  ]) {
    if (tokens.has(k)) return true;
  }
  return false;
}

function isTeratogenRisk(compound) {
  if (!compound) return false;
  const sd = compound.sectionData || {};
  if (sd.pregnancySafety === 'avoid_teratogen' || sd.pregnancySafety === 'avoid') return true;
  if (sd.teratogenicityRisk === 'high') return true;
  if (compound.sectionId === 'peds' && sd.teratogenicityRisk !== 'none') return true;
  if (
    (compound.doNotPairWith || []).some(
      (r) =>
        normLoose(r.targetRef).includes('pregnan') ||
        normLoose(r.mechanism).includes('teratogen') ||
        normLoose(r.recommendation).includes('pregnan'),
    )
  ) {
    return true;
  }
  const tokens = getCompoundTokens(compound);
  for (const k of [
    'teratogen', 'retinoid', 'tretinoin', 'adapalene', 'tazarotene', 'isotretinoin',
    'retinol', 'finasteride', 'dutasteride', '5arinhibitor', 'aas', 'sarm',
    'testosterone', 'testosteronecypionate', 'testosteroneenanthate', 'oxandrolone',
    'stanozolol', 'nandrolone', 'trenbolone', 'minoxidil',
  ]) {
    if (tokens.has(k)) return true;
  }
  return false;
}

function isFemaleVirilizationRisk(compound) {
  if (!compound) return false;
  const sd = compound.sectionData || {};
  if (sd.femaleVirilizationRisk === 'high' || sd.femaleVirilizationRisk === 'moderate') return true;
  if (sd.femaleVirilizationRisk === 'none') return false;
  const pedClass = normLoose(sd.pedClass || sd.compoundClass || '');
  if (['aas', 'trt', 'injectableaas', 'oralaas', 'androgen'].some((c) => pedClass.includes(c))) {
    return true;
  }
  const tokens = getCompoundTokens(compound);
  for (const k of [
    'testosterone', 'testosteronecypionate', 'testosteroneenanthate', 'trenbolone',
    'stanozolol', 'winstrol', 'nandrolone', 'masteron', 'drostanolone', 'anadrol',
    'dianabol', 'oxandrolone', 'primobolan',
  ]) {
    if (tokens.has(k)) return true;
  }
  return false;
}

function rxMedMatchesTarget(rxMed, targetRef) {
  const mTok = normLoose(rxMed);
  const tTok = normLoose(targetRef);
  if (!mTok || !tTok) return false;
  if (mTok === tTok || mTok.includes(tTok) || tTok.includes(mTok)) return true;
  for (const [group, synonyms] of Object.entries(RX_MED_SYNONYM_GROUPS)) {
    const normSyns = synonyms.map(normLoose);
    const medInGroup = mTok === group || normSyns.some((s) => mTok.includes(s) || s.includes(mTok));
    const targetInGroup = tTok === group || normSyns.some((s) => tTok.includes(s) || s.includes(tTok));
    if (medInGroup && targetInGroup) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Adult UL Micronutrient Normalization & Daily Summation
// ---------------------------------------------------------------------------

const NUTRIENT_KEY_ALIASES = Object.freeze({
  vitamind: 'vitamin_d3',
  vitamind3: 'vitamin_d3',
  cholecalciferol: 'vitamin_d3',
  d3: 'vitamin_d3',
  zinc: 'zinc',
  iron: 'iron',
  vitamina: 'vitamin_a',
  retinol: 'vitamin_a',
  copper: 'copper',
  vitaminb6: 'vitamin_b6',
  pyridoxine: 'vitamin_b6',
  p5p: 'vitamin_b6',
  selenium: 'selenium',
  calcium: 'calcium',
  vitaminc: 'vitamin_c',
  ascorbicacid: 'vitamin_c',
  vitamine: 'vitamin_e',
  niacin: 'niacin',
  vitaminb3: 'niacin',
  folate: 'folate',
  folicacid: 'folate',
  magnesium: 'magnesium_supplemental',
  magnesiumsupplemental: 'magnesium_supplemental',
});

export function normalizeNutrientKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const loose = normLoose(raw);
  if (NUTRIENT_KEY_ALIASES[loose]) return NUTRIENT_KEY_ALIASES[loose];
  // Substring match for phrases like "Zinc (as Zinc Picolinate)" or "Vitamin D3 (Cholecalciferol)"
  if (loose.includes('vitamind3') || loose.includes('cholecalciferol') || /\bvitamind\b/i.test(raw)) {
    return 'vitamin_d3';
  }
  if (loose.startsWith('zinc') || loose.includes('zinc(')) return 'zinc';
  if (loose.startsWith('iron') || loose.includes('ferrous')) return 'iron';
  if (loose.startsWith('copper') && !loose.includes('peptide') && !loose.includes('tripeptide')) return 'copper';
  if (loose.startsWith('calcium')) return 'calcium';
  if (loose.startsWith('selenium')) return 'selenium';
  if (loose.startsWith('vitaminb6') || loose.includes('pyridox')) return 'vitamin_b6';
  if (loose.startsWith('vitamina')) return 'vitamin_a';
  if (loose.startsWith('vitaminc') || loose.includes('ascorbic')) return 'vitamin_c';
  if (loose.startsWith('vitamine')) return 'vitamin_e';
  if (loose.startsWith('niacin')) return 'niacin';
  if (loose.startsWith('folate') || loose.includes('folicacid')) return 'folate';
  return null;
}

function convertToUlUnit(amount, unit, ulSpec) {
  const num = parseFiniteNumber(amount);
  if (num === null || num <= 0) return null;
  const u = String(unit || '').trim();
  const target = ulSpec.unit;

  if (u.toLowerCase() === target.toLowerCase()) return num;

  // Mass <-> Mass conversions
  if (MASS_TO_MCG[u] && MASS_TO_MCG[target]) {
    const mcg = toMassMcg(num, u);
    return mcg / MASS_TO_MCG[target];
  }

  // Vitamin D3 mcg <-> IU (1 mcg = 40 IU)
  if (ulSpec.massEquivMcg && target === 'IU' && MASS_TO_MCG[u]) {
    const mcg = toMassMcg(num, u);
    return mcg * 40;
  }
  return null;
}

function computeNutrientContributions(items, compoundsById) {
  // nutrientKey -> { total, unit, limit, label, sources: [{ compoundId, name, amount, unit }] }
  const totals = new Map();

  const addContribution = (nutrientKey, amount, unit, compound, customLimit = null) => {
    const ulSpec = ADULT_UPPER_LIMITS[nutrientKey] || customLimit;
    if (!ulSpec || !(ulSpec.amount > 0)) return;
    const converted = convertToUlUnit(amount, unit, ulSpec);
    if (converted === null || converted <= 0) return;

    if (!totals.has(nutrientKey)) {
      totals.set(nutrientKey, {
        nutrientKey,
        label: ulSpec.label || nutrientKey,
        total: 0,
        unit: ulSpec.unit,
        limit: ulSpec.amount,
        sources: [],
      });
    }
    const bucket = totals.get(nutrientKey);
    bucket.total += converted;
    bucket.sources.push({
      compoundId: compound.id,
      name: compound.name,
      amount: converted,
      unit: ulSpec.unit,
    });
  };

  for (const item of items) {
    const compound = lookupCompound(compoundsById, item.compoundId);
    if (!compound) continue;
    // Skip topical / dermatology products from oral micronutrient Adult UL summation
    if (isDermatologyCompound(compound) || normRoute(compound.dosages?.route || '') === 'Topical') {
      continue;
    }

    const sd = compound.sectionData || {};
    const facts = Array.isArray(sd.ingredientsList) && sd.ingredientsList.length > 0
      ? sd.ingredientsList
      : Array.isArray(sd.supplementFacts) && sd.supplementFacts.length > 0
        ? sd.supplementFacts
        : null;

    // Determine multiplier if user changed stack dose vs compound defaultAmount
    const itemAmount = parseFiniteNumber(item.doseAmount ?? item.dose?.amount);
    const itemUnit = item.doseUnit ?? item.dose?.unit ?? compound.dosages?.defaultUnit;
    const defAmount = parseFiniteNumber(compound.dosages?.defaultAmount);
    const defUnit = compound.dosages?.defaultUnit;

    let servingScale = 1;
    if (
      itemAmount !== null &&
      itemAmount > 0 &&
      defAmount !== null &&
      defAmount > 0 &&
      (!itemUnit || !defUnit || String(itemUnit).toLowerCase() === String(defUnit).toLowerCase())
    ) {
      servingScale = itemAmount / defAmount;
    }

    if (facts) {
      for (const entry of facts) {
        const nk = normalizeNutrientKey(entry?.nutrientKey || entry?.name || entry?.nutrient || '');
        if (!nk) continue;
        const amt = parseFiniteNumber(entry?.amount);
        if (amt === null || amt <= 0) continue;
        addContribution(nk, amt * servingScale, entry?.unit || itemUnit, compound);
      }
      continue;
    }

    // Fallback for single-ingredient supplement without supplementFacts/ingredientsList
    const explicitKey = normalizeNutrientKey(sd.adultUpperLimit?.nutrientKey || '');
    const inferredKey = explicitKey || normalizeNutrientKey(compound.canonicalMolecule || compound.name);
    if (inferredKey) {
      const elemental = parseFiniteNumber(sd.elementalAmount ?? sd.elementalWeightMg);
      const amt = itemAmount !== null && itemAmount > 0 ? itemAmount : elemental ?? defAmount;
      const unit = itemUnit || sd.elementalUnit || defUnit || ADULT_UPPER_LIMITS[inferredKey]?.unit;
      const customLimit =
        sd.adultUpperLimit && parseFiniteNumber(sd.adultUpperLimit.amount) > 0
          ? {
              amount: parseFiniteNumber(sd.adultUpperLimit.amount),
              unit: sd.adultUpperLimit.unit || unit,
              label: compound.name,
            }
          : null;
      if (amt !== null && amt > 0) {
        addContribution(inferredKey, amt, unit, compound, customLimit);
      }
    }
  }

  const ulWarnings = [];
  for (const bucket of totals.values()) {
    // Flag strict UL exceedance (total > limit)
    if (bucket.total > bucket.limit + 1e-9) {
      const rounded = Math.round(bucket.total * 100) / 100;
      ulWarnings.push({
        nutrientKey: bucket.nutrientKey,
        nutrient: bucket.label,
        totalAmount: rounded,
        upperLimit: bucket.limit,
        unit: bucket.unit,
        compoundIds: bucket.sources.map((s) => s.compoundId),
        sources: bucket.sources,
        severity: 'caution',
        mechanism: `Cumulative daily ${bucket.label} intake (${rounded} ${bucket.unit}) exceeds the Adult Tolerable Upper Intake Level (${bucket.limit} ${bucket.unit}).`,
        recommendation: `Reduce combined ${bucket.label} sources to stay at or below ${bucket.limit} ${bucket.unit}/day unless clinically supervised.`,
      });
    }
  }

  return ulWarnings;
}

// ---------------------------------------------------------------------------
// Lookup Utility
// ---------------------------------------------------------------------------

export function lookupCompound(compoundsById, compoundId) {
  if (!compoundsById || !compoundId) return null;
  if (compoundsById instanceof Map) return compoundsById.get(compoundId) || null;
  if (Array.isArray(compoundsById)) {
    return compoundsById.find((c) => c && (c.id === compoundId || c.slug === compoundId)) || null;
  }
  return compoundsById[compoundId] || null;
}

function makePairKey(idA, idB, suffix = '') {
  const [first, second] = [String(idA), String(idB)].sort();
  return `${first}::${second}::${suffix}`;
}

// ---------------------------------------------------------------------------
// Main Interaction Analyzer
// ---------------------------------------------------------------------------

/**
 * Bidirectional Interaction & Safety Context Analyzer.
 *
 * @param {object} params
 * @param {Array<object>} params.items - Stack items ([{ compoundId, ... }])
 * @param {Map|object|Array} params.compoundsById - Compound catalog lookup
 * @param {object} [params.member] - Household member with safetyContext
 * @param {Map|object|Array} [params.ownershipByCompound] - Optional ownership records
 * @returns {{
 *   hardStops: Array,
 *   avoidSameSlot: Array,
 *   alternateDays: Array,
 *   cautions: Array,
 *   synergies: Array,
 *   ulWarnings: Array,
 *   redundancies: Array,
 *   safetyAlerts: Array,
 *   summary: object
 * }}
 */
export function analyzeStackInteractions({
  items = [],
  compoundsById = {},
  member = null,
  ownershipByCompound = null, // eslint-disable-line no-unused-vars
} = {}) {
  const hardStops = [];
  const avoidSameSlot = [];
  const alternateDays = [];
  const cautions = [];
  const synergies = [];
  const redundancies = [];
  const safetyAlerts = [];

  const resolvedItems = [];
  const seenCompoundIds = new Set();
  for (const item of items || []) {
    if (!item || !item.compoundId) continue;
    const compound = lookupCompound(compoundsById, item.compoundId);
    if (!compound) continue;
    resolvedItems.push({ item, compound });
    seenCompoundIds.add(compound.id);
  }

  const seenPairs = new Map(); // pairKey -> entry
  const seenSynergies = new Set();

  const recordPairInteraction = (a, b, rule, source = 'compound') => {
    const sev = rule.severity || 'caution';
    const key = makePairKey(a.id, b.id, sev);
    const existing = seenPairs.get(key);
    const sepHours = parseFiniteNumber(rule.separationHours);

    if (existing) {
      // Keep stricter separationHours if both directions declare it
      if (sepHours !== null && (existing.separationHours == null || sepHours > existing.separationHours)) {
        existing.separationHours = sepHours;
      }
      return;
    }

    const entry = {
      id: rule.id || `pair_${a.id}_${b.id}_${sev}`,
      compoundIds: [a.id, b.id].sort(),
      compounds: [
        { id: a.id, name: a.name, sectionId: a.sectionId },
        { id: b.id, name: b.name, sectionId: b.sectionId },
      ],
      severity: sev,
      separationHours: sepHours !== null ? sepHours : sev === 'avoid_same_slot' ? 2 : null,
      mechanism: rule.mechanism || 'Declared compound interaction.',
      recommendation: rule.recommendation || 'Review pairing carefully.',
      citation: rule.citation || null,
      source,
    };

    seenPairs.set(key, entry);
    if (sev === 'hard_stop') hardStops.push(entry);
    else if (sev === 'avoid_same_slot') avoidSameSlot.push(entry);
    else if (sev === 'alternate_days') alternateDays.push(entry);
    else cautions.push(entry);
  };

  const recordSynergy = (a, b, rule, source = 'compound') => {
    const key = makePairKey(a.id, b.id, 'synergy');
    if (seenSynergies.has(key)) return;
    seenSynergies.add(key);
    synergies.push({
      id: rule.id || `syn_${a.id}_${b.id}`,
      compoundIds: [a.id, b.id].sort(),
      compounds: [
        { id: a.id, name: a.name, sectionId: a.sectionId },
        { id: b.id, name: b.name, sectionId: b.sectionId },
      ],
      coLocate: rule.coLocate !== false,
      reason: rule.reason || 'Synergistic co-administration.',
      source,
    });
  };

  // 1. Pairwise Evaluation (Bidirectional compound rules + Curated Global Bank)
  for (let i = 0; i < resolvedItems.length; i++) {
    for (let j = i + 1; j < resolvedItems.length; j++) {
      const a = resolvedItems[i].compound;
      const b = resolvedItems[j].compound;
      if (a.id === b.id) continue;

      const bothSystemic = !isDermatologyCompound(a) && !isDermatologyCompound(b);
      const bothDerm = isDermatologyCompound(a) && isDermatologyCompound(b);

      // 1a. Bidirectional compound-declared doNotPairWith (A -> B and B -> A)
      for (const [src, dst] of [
        [a, b],
        [b, a],
      ]) {
        for (const rule of src.doNotPairWith || []) {
          if (!rule || rule.targetType === 'rx_med' || rule.targetType === 'food_state') continue;
          if (compoundMatchesRef(dst, rule.targetRef, rule.targetType)) {
            recordPairInteraction(src, dst, rule, 'compound');
          }
        }
        for (const syn of src.synergies || []) {
          if (!syn || !syn.targetRef) continue;
          if (compoundMatchesRef(dst, syn.targetRef)) {
            recordSynergy(src, dst, syn, 'compound');
          }
        }
      }

      // 1b. Curated Global Interaction Bank
      for (const rule of CURATED_PAIR_INTERACTIONS) {
        if (rule.systemicOnly && !bothSystemic) continue;
        if (rule.dermOnly && !bothDerm) continue;

        let matched = false;
        if (typeof rule.predicate === 'function') {
          matched = rule.predicate(a, b);
        } else if (rule.sameClass || rule.sameMolecules) {
          const refs = [...(rule.sameClass || []), ...(rule.sameMolecules || [])];
          matched = compoundMatchesAnyRef(a, refs) && compoundMatchesAnyRef(b, refs);
        } else if (rule.a && rule.b) {
          matched =
            (compoundMatchesAnyRef(a, rule.a) && compoundMatchesAnyRef(b, rule.b)) ||
            (compoundMatchesAnyRef(a, rule.b) && compoundMatchesAnyRef(b, rule.a));
        }

        if (matched) {
          recordPairInteraction(a, b, rule, 'curated_bank');
        }
      }

      // 1c. Curated Synergies
      for (const syn of CURATED_SYNERGIES) {
        if (syn.systemicOnly && !bothSystemic) continue;
        const matched =
          (compoundMatchesAnyRef(a, syn.a) && compoundMatchesAnyRef(b, syn.b)) ||
          (compoundMatchesAnyRef(a, syn.b) && compoundMatchesAnyRef(b, syn.a));
        if (matched) {
          recordSynergy(a, b, syn, 'curated_bank');
        }
      }
    }
  }

  // 2. Member Safety Context Checks (activeRxMeds, pregnancyOrTrying, biologicalSexContext, allergies)
  const safetyCtx = member?.safetyContext || {};
  const activeRxMeds = Array.isArray(safetyCtx.activeRxMeds) ? safetyCtx.activeRxMeds : [];
  const allergies = Array.isArray(safetyCtx.allergies) ? safetyCtx.allergies : [];
  const seenSafetyKeys = new Set();

  for (const { compound } of resolvedItems) {
    // 2a. Active Rx Meds (compound rules + curated Rx bank)
    for (const rxMed of activeRxMeds) {
      if (!rxMed || typeof rxMed !== 'string') continue;

      // Compound-declared rx_med rules
      for (const rule of compound.doNotPairWith || []) {
        if (!rule || rule.targetType !== 'rx_med') continue;
        if (rxMedMatchesTarget(rxMed, rule.targetRef)) {
          const sk = `rx:${compound.id}:${normLoose(rxMed)}:${rule.severity}`;
          if (!seenSafetyKeys.has(sk)) {
            seenSafetyKeys.add(sk);
            const alert = {
              id: sk,
              type: 'rx_med_interaction',
              compoundId: compound.id,
              compoundIds: [compound.id],
              compoundName: compound.name,
              rxMed,
              targetRef: rule.targetRef,
              severity: rule.severity || 'hard_stop',
              mechanism: rule.mechanism || `Interaction between ${compound.name} and prescription medication ${rxMed}.`,
              recommendation: rule.recommendation || `Avoid combining ${compound.name} with ${rxMed}; consult prescribing clinician.`,
              source: 'compound_rx',
            };
            safetyAlerts.push(alert);
            if (alert.severity === 'hard_stop') hardStops.push(alert);
            else cautions.push(alert);
          }
        }
      }

      // Curated Rx bank
      for (const rxRule of CURATED_RX_INTERACTIONS) {
        if (
          rxMedMatchesTarget(rxMed, rxRule.rxGroup) &&
          compoundMatchesAnyRef(compound, rxRule.compoundRefs)
        ) {
          const sk = `rx:${compound.id}:${normLoose(rxMed)}:${rxRule.severity}`;
          if (!seenSafetyKeys.has(sk)) {
            seenSafetyKeys.add(sk);
            const alert = {
              id: sk,
              type: 'rx_med_interaction',
              compoundId: compound.id,
              compoundIds: [compound.id],
              compoundName: compound.name,
              rxMed,
              targetRef: rxRule.rxGroup,
              severity: rxRule.severity,
              mechanism: rxRule.mechanism,
              recommendation: rxRule.recommendation,
              source: 'curated_rx_bank',
            };
            safetyAlerts.push(alert);
            if (alert.severity === 'hard_stop') hardStops.push(alert);
            else cautions.push(alert);
          }
        }
      }
    }

    // 2b. Pregnancy / Trying to Conceive Teratogen Hard-Stops
    if (safetyCtx.pregnancyOrTrying === true && isTeratogenRisk(compound)) {
      const sk = `pregnancy:${compound.id}`;
      if (!seenSafetyKeys.has(sk)) {
        seenSafetyKeys.add(sk);
        const alert = {
          id: sk,
          type: 'pregnancy_teratogen',
          compoundId: compound.id,
          compoundIds: [compound.id],
          compoundName: compound.name,
          severity: 'hard_stop',
          mechanism: `${compound.name} carries teratogenicity / pregnancy contraindication risk while member safetyContext.pregnancyOrTrying is enabled.`,
          recommendation: `Hard stop: strictly avoid ${compound.name} during pregnancy or while trying to conceive.`,
          source: 'safety_context',
        };
        hardStops.push(alert);
        safetyAlerts.push(alert);
      }
    }

    // 2c. Female Virilization Warning (strictly when biologicalSexContext === 'female')
    if (safetyCtx.biologicalSexContext === 'female' && isFemaleVirilizationRisk(compound)) {
      const sk = `virilization:${compound.id}`;
      if (!seenSafetyKeys.has(sk)) {
        seenSafetyKeys.add(sk);
        const alert = {
          id: sk,
          type: 'female_virilization',
          compoundId: compound.id,
          compoundIds: [compound.id],
          compoundName: compound.name,
          riskLevel: compound.sectionData?.femaleVirilizationRisk || 'high',
          severity: 'caution',
          mechanism: `${compound.name} carries significant female virilization / androgenic masculinization risk (voice deepening, hirsutism, clitoromegaly).`,
          recommendation: `High female virilization warning: evaluate lower female-specific alternatives and endocrine monitoring before using ${compound.name}.`,
          source: 'safety_context',
        };
        safetyAlerts.push(alert);
        cautions.push(alert);
      }
    }

    // 2d. Member Allergies Check
    for (const allergy of allergies) {
      if (!allergy || typeof allergy !== 'string') continue;
      const aNorm = normLoose(allergy);
      if (!aNorm) continue;
      const tokens = getCompoundTokens(compound);
      const allergens = (compound.sectionData?.allergens || []).map(normLoose);
      if (
        tokens.has(aNorm) ||
        allergens.some((al) => al.includes(aNorm) || aNorm.includes(al))
      ) {
        const sk = `allergy:${compound.id}:${aNorm}`;
        if (!seenSafetyKeys.has(sk)) {
          seenSafetyKeys.add(sk);
          const alert = {
            id: sk,
            type: 'allergy_match',
            compoundId: compound.id,
            compoundIds: [compound.id],
            compoundName: compound.name,
            allergy,
            severity: 'hard_stop',
            mechanism: `${compound.name} matches recorded member allergy "${allergy}".`,
            recommendation: `Avoid ${compound.name} due to documented allergy (${allergy}).`,
            source: 'safety_context',
          };
          hardStops.push(alert);
          safetyAlerts.push(alert);
        }
      }
    }
  }

  // 3. Multi-Route Same-Molecule Cumulative Exposure & Redundancy Detection (F16)
  const byMolecule = new Map();
  for (const { compound } of resolvedItems) {
    const rawMol = compound.canonicalMolecule || resolveCanonicalMolecule(compound.name, compound.aliases || []);
    const molKey = normToken(rawMol);
    if (!molKey) continue;
    if (!byMolecule.has(molKey)) byMolecule.set(molKey, []);
    byMolecule.get(molKey).push(compound);
  }

  for (const [molKey, group] of byMolecule.entries()) {
    const uniqueCompounds = [];
    const seenIds = new Set();
    for (const c of group) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        uniqueCompounds.push(c);
      }
    }
    if (uniqueCompounds.length < 2) continue;

    const routes = [...new Set(uniqueCompounds.map((c) => normRoute(c.dosages?.route || 'unknown')))];
    const isMultiRoute = routes.length > 1 || new Set(uniqueCompounds.map((c) => c.sectionId)).size > 1;
    const names = uniqueCompounds.map((c) => `${c.name} (${c.dosages?.route || c.sectionId})`).join(' + ');

    const entry = {
      id: `redundant_${molKey}`,
      type: isMultiRoute ? 'multi_route_cumulative' : 'duplicate_molecule',
      canonicalMolecule: molKey,
      compoundIds: uniqueCompounds.map((c) => c.id),
      compounds: uniqueCompounds.map((c) => ({
        id: c.id,
        name: c.name,
        sectionId: c.sectionId,
        route: c.dosages?.route || null,
      })),
      routes,
      severity: 'caution',
      mechanism: isMultiRoute
        ? `Multi-route cumulative exposure for same molecule "${molKey}" across ${routes.join(' + ')} (${names}).`
        : `Duplicate molecule "${molKey}" appears multiple times in stack (${names}).`,
      recommendation: isMultiRoute
        ? `Track total cumulative exposure for ${molKey} across systemic and topical routes (${names}).`
        : `Verify whether multiple ${molKey} entries are intentional to avoid unintended double dosing.`,
      source: 'multi_route_detector',
    };
    redundancies.push(entry);
    cautions.push(entry);
  }

  // 4. Adult UL Cumulative Micronutrient Summation (F13)
  const ulWarnings = computeNutrientContributions(
    resolvedItems.map((r) => r.item),
    compoundsById,
  );

  // Deduplicate summary metrics
  const summary = {
    totalCompounds: seenCompoundIds.size,
    hardStopCount: hardStops.length,
    avoidSameSlotCount: avoidSameSlot.length,
    alternateDaysCount: alternateDays.length,
    cautionCount: cautions.length,
    synergyCount: synergies.length,
    ulWarningCount: ulWarnings.length,
    redundancyCount: redundancies.length,
    safetyAlertCount: safetyAlerts.length,
    hasHardStops: hardStops.length > 0,
  };

  return {
    hardStops,
    avoidSameSlot,
    alternateDays,
    cautions,
    synergies,
    ulWarnings,
    redundancies,
    safetyAlerts,
    summary,
  };
}
