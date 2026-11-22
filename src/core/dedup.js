/**
 * Compound deduplication, canonical alias resolution, blend fingerprinting,
 * and multi-route same-molecule variant detection.
 * Pure ESM, imports only constants.js (acyclic DAG Layer 1).
 */

import { ROUTE_ALIASES, deepClone } from './constants.js';

/**
 * Normalize a compound name or alias for canonical matching:
 * NFKD diacritic strip, lowercase, remove all non-alphanumeric characters.
 */
export function normName(str) {
  if (typeof str !== 'string' && typeof str !== 'number') return '';
  if (typeof str === 'number' && !Number.isFinite(str)) return '';
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Normalize administration route to canonical lowercase identifier for dedup.
 * Returns null when empty or unrecognized.
 */
export function normRoute(route) {
  if (typeof route !== 'string') return null;
  const cleaned = route.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!cleaned) return null;
  const canonical = Object.hasOwn(ROUTE_ALIASES, cleaned) ? ROUTE_ALIASES[cleaned] : null;
  return typeof canonical === 'string' ? canonical.toLowerCase() : null;
}

/**
 * Curated canonical molecule -> aliases dictionary across all 4 core sections.
 * Deliberately separates pharmacologically distinct variants such as
 * `cjc-1295-no-dac` vs `cjc-1295-dac` and `nandrolone-decanoate` vs `nandrolone-phenylpropionate`.
 */
export const CANONICAL_ALIAS_GROUPS = Object.freeze(
  Object.assign(Object.create(null), {
  // Peptides
  elamipretide: ['elamipretide', 'ss-31', 'ss31', 'bendavia', 'mtp-131', 'mtp131'],
  'bpc-157': ['bpc-157', 'bpc157', 'body protection compound 157', 'bpc-157 arginate', 'bpc157 arginate'],
  'tb-500': ['tb-500', 'tb500', 'thymosin beta-4', 'thymosin beta 4', 'tb4'],
  'ghk-cu': [
    'ghk-cu',
    'ghkcu',
    'copper tripeptide-1',
    'copper tripeptide 1',
    'copper peptide',
    'ghk-cu copper peptide',
    'ghk copper',
  ],
  tirzepatide: ['tirzepatide', 'mounjaro', 'zepbound', 'ly3298176'],
  semaglutide: ['semaglutide', 'ozempic', 'wegovy', 'rybelsus'],
  retatrutide: ['retatrutide', 'ly3437943', 'ly-3437943'],
  cagrilintide: ['cagrilintide', 'am833', 'am-833'],
  ipamorelin: ['ipamorelin', 'nnc 26-0161'],
  'cjc-1295-no-dac': [
    'cjc-1295-no-dac',
    'cjc-1295 no dac',
    'cjc 1295 no dac',
    'cjc1295 no dac',
    'cjc-1295 (no dac)',
    'cjc-1295 without dac',
    'mod grf 1-29',
    'mod grf (1-29)',
    'modified grf 1-29',
  ],
  'cjc-1295-dac': [
    'cjc-1295-dac',
    'cjc-1295 dac',
    'cjc 1295 dac',
    'cjc1295 dac',
    'cjc-1295 (dac)',
    'cjc-1295 with dac',
    'cjc-1295 (with dac)',
  ],
  tesamorelin: ['tesamorelin', 'egrifta'],
  sermorelin: ['sermorelin', 'geref'],
  epitalon: ['epitalon', 'epithalon', 'epithalamin'],
  'mots-c': ['mots-c', 'motsc'],
  'thymosin-alpha-1': ['thymosin-alpha-1', 'thymosin alpha-1', 'thymosin alpha 1', 'ta-1', 'ta1', 'zadaxin'],
  'pt-141': ['pt-141', 'pt141', 'bremelanotide', 'vyleesi'],
  'melanotan-2': ['melanotan-2', 'melanotan 2', 'melanotan ii', 'mt-2', 'mt2'],
  semax: ['semax', 'n-acetyl semax', 'na-semax'],
  selank: ['selank', 'n-acetyl selank', 'na-selank'],
  'aod-9604': ['aod-9604', 'aod9604'],
  'igf-1-lr3': ['igf-1-lr3', 'igf-1 lr3', 'igf1-lr3', 'igf1 lr3', 'long r3 igf-1', 'long r3 igf1'],
  'ara-290': ['ara-290', 'ara290', 'cibinetide'],
  kpv: ['kpv', 'lys-pro-val'],

  // PEDs
  oxandrolone: ['oxandrolone', 'anavar', 'oxandrin', 'oxandrolone (anavar)'],
  'testosterone-cypionate': [
    'testosterone-cypionate',
    'testosterone cypionate',
    'test cyp',
    'test-cyp',
    'depo-testosterone',
  ],
  'testosterone-enanthate': [
    'testosterone-enanthate',
    'testosterone enanthate',
    'test e',
    'test-e',
    'delatestryl',
  ],
  'nandrolone-decanoate': [
    'nandrolone-decanoate',
    'nandrolone decanoate',
    'deca',
    'deca-durabolin',
    'deca durabolin',
    'nandrolone decanoate (deca)',
  ],
  'nandrolone-phenylpropionate': [
    'nandrolone-phenylpropionate',
    'nandrolone phenylpropionate',
    'npp',
    'durabolin',
  ],
  'methenolone-enanthate': ['methenolone-enanthate', 'methenolone enanthate', 'primobolan', 'primo'],
  'drostanolone-propionate': ['drostanolone-propionate', 'drostanolone propionate', 'masteron'],
  'lgd-4033': ['lgd-4033', 'lgd4033', 'ligandrol', 'vk5211'],
  'mk-2866': ['mk-2866', 'mk2866', 'ostarine', 'enobosarm'],
  'rad-140': ['rad-140', 'rad140', 'testolone'],
  'mk-677': ['mk-677', 'mk677', 'ibutamoren'],
  hcg: ['hcg', 'human chorionic gonadotropin', 'human chorionic gonadotropin (hcg)', 'pregnyl', 'novarel', 'ovidrel'],
  anastrozole: ['anastrozole', 'arimidex'],
  exemestane: ['exemestane', 'aromasin'],
  enclomiphene: ['enclomiphene', 'enclomiphene citrate', 'androxal'],
  tamoxifen: ['tamoxifen', 'nolvadex'],
  tadalafil: ['tadalafil', 'cialis', 'adcirca'],
  finasteride: ['finasteride', 'propecia', 'proscar'],
  dutasteride: ['dutasteride', 'avodart'],
  'slu-pp-332': ['slu-pp-332', 'slupp332'],

  // Vitamins & Supplements
  'vitamin-d3': ['vitamin-d3', 'vitamin d3', 'cholecalciferol', 'd3'],
  'vitamin-k2-mk7': ['vitamin-k2-mk7', 'vitamin k2', 'vitamin k2 (mk-7)', 'menaquinone-7', 'mk-7', 'mk7'],
  'magnesium-glycinate': [
    'magnesium-glycinate',
    'magnesium glycinate',
    'magnesium bisglycinate',
    'magnesium bisglycinate chelate',
  ],
  'omega-3': ['omega-3', 'omega 3', 'omega-3 fish oil', 'omega-3 fish oil (epa/dha)', 'fish oil', 'epa/dha'],
  'creatine-monohydrate': ['creatine-monohydrate', 'creatine monohydrate', 'creatine'],
  coq10: ['coq10', 'co-q10', 'coenzyme q10', 'ubiquinol', 'ubiquinone'],
  nac: ['nac', 'n-acetyl cysteine', 'n-acetylcysteine', 'n-acetyl-l-cysteine'],
  tudca: ['tudca', 'tauroursodeoxycholic acid'],
  zinc: ['zinc', 'zinc picolinate', 'zinc bisglycinate', 'zinc glycinate', 'zinc citrate'],
  copper: ['copper', 'copper bisglycinate', 'copper glycinate'],
  iron: ['iron', 'ferrous bisglycinate', 'iron bisglycinate', 'ferrous sulfate'],
  'vitamin-b12': ['vitamin-b12', 'vitamin b12', 'methylcobalamin', 'cyanocobalamin', 'cobalamin'],
  berberine: ['berberine', 'berberine hcl', 'dihydroberberine'],
  'l-theanine': ['l-theanine', 'l theanine', 'theanine'],

  // Dermatology (Skin & Hair)
  tretinoin: ['tretinoin', 'retin-a', 'retina', 'all-trans retinoic acid', 'atra', 'altreno', 'renova'],
  adapalene: ['adapalene', 'differin'],
  tazarotene: ['tazarotene', 'tazorac', 'arazlo'],
  minoxidil: ['minoxidil', 'rogaine', 'regaine'],
  ketoconazole: ['ketoconazole', 'nizoral'],
  'azelaic-acid': ['azelaic-acid', 'azelaic acid', 'finacea', 'azelex'],
  'benzoyl-peroxide': ['benzoyl-peroxide', 'benzoyl peroxide', 'bpo', 'panoxyl'],
  'salicylic-acid': ['salicylic-acid', 'salicylic acid', 'bha'],
  'glycolic-acid': ['glycolic-acid', 'glycolic acid'],
  'vitamin-c-laa': [
    'vitamin-c-laa',
    'l-ascorbic acid',
    'ascorbic acid',
    'vitamin c serum',
    'l-ascorbic acid vitamin c',
    'l-ascorbic acid 15% vitamin c serum',
  ],
  niacinamide: ['niacinamide', 'nicotinamide', 'vitamin b3'],
  'hyaluronic-acid': ['hyaluronic-acid', 'hyaluronic acid', 'sodium hyaluronate'],
  ru58841: ['ru58841', 'ru-58841'],
  }),
);

const _aliasToCanonical = Object.create(null);
for (const [canonical, aliases] of Object.entries(CANONICAL_ALIAS_GROUPS)) {
  _aliasToCanonical[normName(canonical)] = canonical;
  for (const alias of aliases) {
    const k = normName(alias);
    if (k) _aliasToCanonical[k] = canonical;
  }
}

export const ALIAS_TO_CANONICAL = Object.freeze(_aliasToCanonical);

function lookupAlias(normKey) {
  return typeof normKey === 'string' && normKey && Object.hasOwn(ALIAS_TO_CANONICAL, normKey)
    ? ALIAS_TO_CANONICAL[normKey]
    : null;
}

const ROUTE_FORM_PAREN_RE =
  /\((?:injectable|subq|subcutaneous|im|intramuscular|oral|po|topical|dermal|transdermal|nasal|intranasal|sl|sublingual|pens?|vials?|serum|cream|foam|gel|lotion|solution|toner|shampoo|caps?|capsules?|tabs?|tablets?|powder|liquid|softgels?|drops?|sprays?|pumps?|scoops?|lozenges?)\)/gi;

// Captures comma-formatted numbers (5,000 IU), spaced concentration slashes (200 mg / mL),
// and singular/plural numeric denominators (2.5 mg / 0.5 mL, 5000 IU / 2 mL, 30 mg / 2 capsules,
// 500 mcg / 2 sprays) without matching molecule codes (BPC-157, MK-7, LGD-4033) or active-vs-active
// slashes (BPC-157 / TB-500). Bounded comma groups keep matching strictly O(N).
const STRENGTH_RE =
  /\b\d+(?:,\d{3}){0,4}(?:\.\d+)?\s*(?:%|(?:(?:mg|mcg|ug|µg|μg|iu|g|ml)\s*\/\s*(?:\d+(?:,\d{3}){0,4}(?:\.\d+)?\s*)?(?:mls?|l|g|doses?|sprays?|pumps?|drops?|caps?|capsules?|tabs?|tablets?|softgels?|vials?|servings?|scoops?|lozenges?|gummy|gummies|droppers?|actuations?|clicks?|packets?|sachets?)|mg|mcg|ug|µg|μg|iu|g|ml)\b)/gi;

const VEHICLE_QUALIFIER_RE =
  /\b(?:topical|dermal|transdermal|oral|po|injectable|subcutaneous|subq|sc|sq|intramuscular|im|sublingual|sl|nasal|intranasal|scalp|facial|face|body|exfoliating|broad-spectrum|mineral|pens?|vials?|serum|cream|foam|gel|lotion|solution|toner|shampoo|tonic|oil|ointment|emulsion|essence|drops?|sprays?|pumps?|scoops?|caps?|tabs?|tablets?|capsules?|softgels?|lozenges?|powder|chelate|liquid)\b/gi;

const SALT_QUALIFIER_RE =
  /\b(?:acetate|trifluoroacetate|tfa|hcl|hydrochloride|dihydrochloride|sodium|disodium|potassium|tartrate|bitartrate|sulfate|sulphate|citrate|mesylate|maleate|fumarate|succinate|besylate|phosphate)\b/gi;

const EDGE_PUNCT_CHAR_RE = /[\s\-–—,/]/;

function trimEdgePunct(str) {
  let start = 0;
  let end = str.length;
  while (start < end && EDGE_PUNCT_CHAR_RE.test(str[start])) start++;
  while (end > start && EDGE_PUNCT_CHAR_RE.test(str[end - 1])) end--;
  return str.slice(start, end);
}

function stripParentheticals(str) {
  if (!str || !str.includes('(')) return str;
  const lastClose = str.lastIndexOf(')');
  if (lastClose < 0) return str;
  return str.slice(0, lastClose + 1).replace(/\([^)]*\)/g, ' ') + str.slice(lastClose + 1);
}

function extractParentheticals(str) {
  if (!str || !str.includes('(')) return [];
  const lastClose = str.lastIndexOf(')');
  if (lastClose < 0) return [];
  const out = [];
  for (const pm of str.slice(0, lastClose + 1).matchAll(/\(([^)]+)\)/g)) {
    const inner = pm[1].trim();
    if (inner) out.push(inner);
  }
  return out;
}

function stripStrengthAndRouteParens(name) {
  if (!name || typeof name !== 'string') return '';
  let s = name.trim().replace(/\s+/g, ' ');
  if (s.includes('(')) s = s.replace(ROUTE_FORM_PAREN_RE, ' ');
  s = s.replace(STRENGTH_RE, ' ');
  s = s.replace(/\s+/g, ' ');
  if (s.includes('(') && s.includes(')')) s = s.replace(/\( ?\)/g, ' ');
  return trimEdgePunct(s.replace(/\s+/g, ' '));
}

/**
 * Strip strength, vehicle/route, and (optionally) common pharmaceutical salt qualifiers
 * as a fallback lookup helper while preserving core molecule tokens (BPC-157, SS-31,
 * D3, B12, CJC-1295 no DAC vs DAC, MK-7, LGD-4033, Magnesium Glycinate, etc.).
 */
export function stripFormulationSuffixes(name, { stripSalts = false } = {}) {
  if (!name || typeof name !== 'string') return '';
  let s = stripStrengthAndRouteParens(name);
  s = s.replace(VEHICLE_QUALIFIER_RE, ' ');
  if (stripSalts) {
    s = s.replace(SALT_QUALIFIER_RE, ' ');
  }
  s = s.replace(/\s+/g, ' ');
  if (s.includes('(') && s.includes(')')) s = s.replace(/\( ?\)/g, ' ');
  return trimEdgePunct(s.replace(/\s+/g, ' '));
}

function lookupStrippedAlias(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Pass 1: Strength + route/form parens ONLY
  const p1 = stripStrengthAndRouteParens(raw);
  const k1 = normName(p1);
  const m1 = lookupAlias(k1);
  if (m1) return { canonical: m1, normalizedTerm: k1 };

  // Pass 2: Strength + route/form parens + vehicle qualifiers (BEFORE salt stripping!)
  const p2 = stripFormulationSuffixes(raw, { stripSalts: false });
  const k2 = normName(p2);
  const m2 = lookupAlias(k2);
  if (m2) return { canonical: m2, normalizedTerm: k2 };

  // Pass 3: Also strip generic pharmaceutical salt qualifiers
  const p3 = stripFormulationSuffixes(raw, { stripSalts: true });
  const k3 = normName(p3);
  const m3 = lookupAlias(k3);
  if (m3) return { canonical: m3, normalizedTerm: k3 };

  return null;
}

function hasMultiComponentSeparator(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Direct registered alias (e.g., "EPA/DHA" or "EPA/DHA Softgels") is never a blend separator
  if (lookupAlias(normName(trimmed))) return false;
  const vehStripped = stripFormulationSuffixes(trimmed, { stripSalts: false });
  if (vehStripped && lookupAlias(normName(vehStripped))) return false;

  // Collapse whitespace once so all subsequent patterns are strictly O(N)
  const collapsed = trimmed.replace(/\s+/g, ' ');

  // 1. Infix '+' (e.g., "BPC-157 + TB-500", "A+B"), explicitly NOT trailing '+' ("NAD+", "SPF 50+")
  if (collapsed.includes('+')) {
    if (collapsed.includes(' + ') || /[a-z0-9]\+[a-z0-9]/i.test(collapsed)) return true;
  }

  // 2. Ampersand '&' (e.g., "Vitamin D3 & K2", "NAD+ & Glutathione")
  if (collapsed.includes('&') && /[a-z0-9+] ?& ?[a-z0-9]/i.test(collapsed)) return true;

  // 3. Conjunction word 'and' (e.g., "BPC-157 and TB-500", "Vitamin D3 and K2")
  if (/[a-z0-9+] and [a-z0-9]/i.test(collapsed)) return true;

  // 4. Comma ',' separator (evaluated after stripping vehicles so "Retin-A, Cream" does not false-positive)
  if (collapsed.includes(',')) {
    const noVeh = collapsed.replace(VEHICLE_QUALIFIER_RE, ' ').replace(/\s+/g, ' ');
    if (/[a-z0-9+] ?, [a-z0-9]/i.test(noVeh) || /[a-z0-9]{2},[a-z0-9]{2}/i.test(noVeh)) {
      return true;
    }
  }

  // 5. Slash '/' separator — O(N) non-backtracking scan preserving aliases ("EPA/DHA") & route pairs ("SubQ/IM", "AM/PM")
  if (collapsed.includes('/')) {
    for (const m of collapsed.matchAll(/[a-z0-9+-]+(?: ?\/ ?[a-z0-9+-]+)*/gi)) {
      const grp = m[0];
      if (!grp.includes('/')) continue;
      if (lookupAlias(normName(grp))) continue;
      const parts = grp.split('/').map((p) => p.trim()).filter(Boolean);
      if (
        parts.length >= 2 &&
        parts.every((p) => normRoute(p) !== null || /^(?:am|pm|day|night)$/i.test(p))
      ) {
        continue;
      }
      return true;
    }
  }

  return false;
}

function isMultiComponentName(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;

  // Fast-path: exact or formulation-stripped known single-molecule alias
  if (lookupAlias(normName(trimmed))) return false;
  const s1 = stripStrengthAndRouteParens(trimmed);
  if (s1 && lookupAlias(normName(s1))) return false;
  const s2 = stripFormulationSuffixes(trimmed, { stripSalts: false });
  if (s2 && lookupAlias(normName(s2))) return false;

  // Strip strength/concentration notations BEFORE inspecting separators
  const withoutStrength = trimmed.replace(/\s+/g, ' ').replace(STRENGTH_RE, ' ');
  const outer = stripParentheticals(withoutStrength);

  if (hasMultiComponentSeparator(outer)) return true;
  if (/\b(?:blend|mix)\b/i.test(outer)) return true;

  // Inspect ALL parentheticals (not just the first)
  const foundCanonicals = new Set();
  const outerHit = lookupStrippedAlias(outer);
  if (outerHit) foundCanonicals.add(outerHit.canonical);

  for (const inner of extractParentheticals(withoutStrength)) {
    if (hasMultiComponentSeparator(inner)) return true;
    if (/\b(?:blend|mix)\b/i.test(inner)) return true;
    const innerCanon = lookupAlias(normName(inner)) || lookupStrippedAlias(inner)?.canonical || null;
    if (innerCanon) foundCanonicals.add(innerCanon);
  }

  if (foundCanonicals.size >= 2) return true;

  return false;
}

/**
 * Resolve a known canonical molecule slug from a compound object or name + aliases.
 * Returns null if unknown and no explicit canonicalMolecule is supplied,
 * or if the candidate is a multi-ingredient blend without an explicit canonicalMolecule.
 */
export function resolveCanonicalMolecule(nameOrCandidate, aliases = []) {
  if (!nameOrCandidate) return null;

  let explicit = null;
  let name = '';
  let aliasList = Array.isArray(aliases) ? [...aliases] : [];

  if (typeof nameOrCandidate === 'string') {
    name = nameOrCandidate;
  } else if (typeof nameOrCandidate === 'object' && !Array.isArray(nameOrCandidate)) {
    explicit = nameOrCandidate.canonicalMolecule || null;
    name =
      (typeof nameOrCandidate.name === 'string' && nameOrCandidate.name.trim() ? nameOrCandidate.name : '') ||
      (typeof nameOrCandidate.slug === 'string' && nameOrCandidate.slug.trim() ? nameOrCandidate.slug : '') ||
      (typeof nameOrCandidate.id === 'string' && nameOrCandidate.id.trim() ? nameOrCandidate.id : '');
    if (Array.isArray(nameOrCandidate.aliases)) {
      aliasList = [...nameOrCandidate.aliases, ...aliasList];
    }
  } else {
    return null;
  }

  // 1. Explicit canonicalMolecule
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    const nk = normName(explicit);
    const directExplicit = lookupAlias(nk);
    if (directExplicit) return directExplicit;
    const slugged = explicit
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return slugged || null;
  }

  // Guard: multi-ingredient blends without an explicit canonicalMolecule must NEVER collapse to one constituent
  if (typeof nameOrCandidate === 'object') {
    const ingMap = extractIngredientsMap(nameOrCandidate, { allowRawMap: false });
    if (
      isBlendCompound(nameOrCandidate) ||
      (ingMap && Object.keys(ingMap).length >= 2) ||
      (Array.isArray(nameOrCandidate.sectionData?.ingredientsList) &&
        nameOrCandidate.sectionData.ingredientsList.length >= 2)
    ) {
      return null;
    }
  }

  // 2. Direct lookup on name
  const nameKey = normName(name);
  const directName = lookupAlias(nameKey);
  if (directName) {
    return directName;
  }

  // String-level blend guard before checking aliases or stripped forms
  if (typeof name === 'string' && isMultiComponentName(name)) {
    return null;
  }

  // 3. Direct lookup on aliases
  for (const alias of aliasList) {
    const ak = normName(alias);
    const directAlias = lookupAlias(ak);
    if (directAlias) {
      return directAlias;
    }
  }

  // 4. Stripped formulation fallback on name & aliases (only when NOT a multi-active blend)
  const candidatesToStrip = [name, ...aliasList];
  for (const raw of candidatesToStrip) {
    if (!raw || typeof raw !== 'string') continue;
    // Do not strip multi-ingredient blend names into a single constituent
    if (isMultiComponentName(raw)) continue;
    const hit = lookupStrippedAlias(raw);
    if (hit) {
      return hit.canonical;
    }
    // Check all parentheticals + stripped outer text; accept only when exactly 1 distinct canonical matches
    const parenInners = extractParentheticals(raw);
    if (parenInners.length > 0) {
      const found = new Set();
      for (const inner of parenInners) {
        const innerCanon = lookupAlias(normName(inner)) || lookupStrippedAlias(inner)?.canonical || null;
        if (innerCanon) found.add(innerCanon);
      }
      const outerRaw = stripParentheticals(raw);
      const outerCanon = lookupAlias(normName(outerRaw)) || lookupStrippedAlias(outerRaw)?.canonical || null;
      if (outerCanon) found.add(outerCanon);
      if (found.size === 1) {
        return [...found][0];
      }
    }
  }

  return null;
}

const NON_RAW_MAP_KEYS = new Set([
  'name',
  'sectionId',
  'id',
  'slug',
  'halfLife',
  'valueHours',
  'minHours',
  'maxHours',
  'displayText',
  'kind',
  'dosages',
  'timingRules',
  'cycles',
  'provenance',
  'sectionData',
  'route',
]);

function parsePositiveIngredientValue(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? v : NaN;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : NaN;
  }
  return NaN;
}

/**
 * Extract a clean map of `{ [ingredientKey]: positiveNumber }` from a compound,
 * sectionData.ingredients, penComponents, or raw map. Returns null if none.
 */
export function extractIngredientsMap(compoundOrMap, { allowRawMap = true } = {}) {
  if (!compoundOrMap || typeof compoundOrMap !== 'object' || Array.isArray(compoundOrMap)) {
    return null;
  }

  let raw = null;
  if (
    compoundOrMap.sectionData &&
    compoundOrMap.sectionData.ingredients &&
    typeof compoundOrMap.sectionData.ingredients === 'object' &&
    !Array.isArray(compoundOrMap.sectionData.ingredients)
  ) {
    raw = compoundOrMap.sectionData.ingredients;
  } else if (
    compoundOrMap.ingredients &&
    typeof compoundOrMap.ingredients === 'object' &&
    !Array.isArray(compoundOrMap.ingredients)
  ) {
    raw = compoundOrMap.ingredients;
  } else if (Array.isArray(compoundOrMap.sectionData?.penComponents) && compoundOrMap.sectionData.penComponents.length > 0) {
    const out = {};
    for (const c of compoundOrMap.sectionData.penComponents) {
      if (!c || typeof c !== 'object') continue;
      const rawK = c.id || c.compoundId || c.peptideId || c.name;
      if (!rawK) continue;
      const key = String(rawK);
      if (key === '__proto__') continue;
      const v = parsePositiveIngredientValue(c.fraction ?? c.mg ?? c.mcg ?? c.amount);
      if (Number.isFinite(v) && v > 0) {
        const prev = Object.hasOwn(out, key) ? out[key] : 0;
        out[key] = prev + v;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } else if (Array.isArray(compoundOrMap.penComponents) && compoundOrMap.penComponents.length > 0) {
    const out = {};
    for (const c of compoundOrMap.penComponents) {
      if (!c || typeof c !== 'object') continue;
      const rawK = c.id || c.compoundId || c.peptideId || c.name;
      if (!rawK) continue;
      const key = String(rawK);
      if (key === '__proto__') continue;
      const v = parsePositiveIngredientValue(c.fraction ?? c.mg ?? c.mcg ?? c.amount);
      if (Number.isFinite(v) && v > 0) {
        const prev = Object.hasOwn(out, key) ? out[key] : 0;
        out[key] = prev + v;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } else if (allowRawMap) {
    const keys = Object.keys(compoundOrMap);
    const hasNonMapKey = keys.some((k) => NON_RAW_MAP_KEYS.has(k));
    if (!hasNonMapKey && keys.length > 0) {
      // Looks like a raw ratio/mass map e.g. { 'bpc-157': 10, 'tb-500': 10 }
      raw = compoundOrMap;
    }
  }

  if (!raw) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || k === '__proto__') continue;
    if (Array.isArray(v) || typeof v === 'boolean' || v === null || v === undefined || typeof v === 'object') {
      continue;
    }
    const n = parsePositiveIngredientValue(v);
    if (Number.isFinite(n) && n > 0) {
      out[k] = n;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Determine whether a compound or metadata object represents a multi-component blend.
 * Deliberately guards against trailing '+' (e.g., "NAD+", "SPF 50+") so single
 * molecules ending in '+' are NEVER misclassified as blends.
 */
export function isBlendCompound(compoundOrMeta) {
  if (!compoundOrMeta || typeof compoundOrMeta !== 'object' || Array.isArray(compoundOrMeta)) return false;
  if (compoundOrMeta.isBlend === true || compoundOrMeta.sectionData?.isBlend === true) {
    return true;
  }

  const ingMap = extractIngredientsMap(compoundOrMeta, { allowRawMap: false });
  if (ingMap && Object.keys(ingMap).length >= 2) {
    return true;
  }

  if (
    Array.isArray(compoundOrMeta.sectionData?.ingredientsList) &&
    compoundOrMeta.sectionData.ingredientsList.length >= 2
  ) {
    return true;
  }

  if (
    compoundOrMeta.isPen === true &&
    (!Array.isArray(compoundOrMeta.penComponents) || compoundOrMeta.penComponents.length !== 1)
  ) {
    return true;
  }

  const ids = [compoundOrMeta.id, compoundOrMeta.slug, compoundOrMeta.peptideId]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());

  for (const id of ids) {
    if (id === '__pen__' || /^blend[_-]/i.test(id)) return true;
  }

  const name = typeof compoundOrMeta.name === 'string' ? compoundOrMeta.name.trim() : '';
  if (name) {
    if (isMultiComponentName(name)) {
      return true;
    }
    if (/\b(blend|mix|klow|glow|coremend|neurolux)\b/i.test(name)) {
      return true;
    }
    if (/\b(?:multi[- ]?peptide\s+pen|pen\s+mix)\b/i.test(name)) {
      return true;
    }
  }

  return false;
}

/**
 * Deterministic composition fingerprint for blends and single compounds.
 * Normalizes ingredient keys via canonical aliases and normalizes weights to
 * fractions summing to 1.000, sorted lexicographically (`key:0.500|key2:0.500`).
 */
export function compoundFingerprint(compoundOrMap) {
  if (!compoundOrMap) return '';
  if (typeof compoundOrMap === 'string') {
    const key = resolveCanonicalMolecule(compoundOrMap) || normName(compoundOrMap);
    return key ? `${key}:1.000` : '';
  }

  const ingMap = extractIngredientsMap(compoundOrMap);
  if (ingMap && Object.keys(ingMap).length >= 1) {
    const merged = Object.create(null);
    let sum = 0;
    for (const [rawKey, rawVal] of Object.entries(ingMap)) {
      const canon = resolveCanonicalMolecule(rawKey) || normName(rawKey);
      if (!canon) continue;
      merged[canon] = (merged[canon] || 0) + rawVal;
      sum += rawVal;
    }
    if (!Number.isFinite(sum) || sum <= 0) return '';
    const keys = Object.keys(merged).sort((a, b) => a.localeCompare(b));
    return keys.map((k) => `${k}:${(merged[k] / sum).toFixed(3)}`).join('|');
  }

  const singleKey =
    resolveCanonicalMolecule(compoundOrMap) ||
    normName(compoundOrMap.slug || compoundOrMap.id || compoundOrMap.name || '');
  return singleKey ? `${singleKey}:1.000` : '';
}

function collectNormalizedTerms(compound) {
  const terms = new Set();
  const add = (val) => {
    const n = normName(val);
    if (n) terms.add(n);
  };
  if (compound?.name) {
    add(compound.name);
    // Also add stripped form only when NOT a multi-ingredient blend
    if (!isBlendCompound(compound) && !isMultiComponentName(compound.name)) {
      const hit = lookupStrippedAlias(compound.name);
      if (hit && hit.normalizedTerm && hit.normalizedTerm.length >= 2) {
        terms.add(hit.normalizedTerm);
      }
    }
  }
  if (Array.isArray(compound?.aliases)) {
    for (const a of compound.aliases) add(a);
  }
  const canon = resolveCanonicalMolecule(compound);
  if (canon) {
    add(canon);
    const group = Object.hasOwn(CANONICAL_ALIAS_GROUPS, canon) ? CANONICAL_ALIAS_GROUPS[canon] : null;
    if (Array.isArray(group)) {
      for (const a of group) add(a);
    }
  }
  return terms;
}

const MATCH_PRIORITY = Object.freeze(
  Object.assign(Object.create(null), {
    same_molecule_other_route: 0,
    blend_fingerprint_match: 1,
    alias_match: 2,
    exact_duplicate: 3,
  }),
);

/**
 * Classify a candidate compound against existing catalog entries.
 * Distinguishes blocking duplicates (`exact_duplicate`, `alias_match`, `blend_fingerprint_match`)
 * from valid multi-route / cross-section sibling variants (`same_molecule_other_route`).
 */
export function checkDuplicateCompound(candidate, existingCompounds = [], { excludeId = null } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      isDuplicate: false,
      isSiblingVariant: false,
      classification: 'unique',
      httpStatusHint: 200,
      existingCompoundId: null,
      relatedCompoundIds: [],
      canonicalMolecule: null,
      matches: [],
      recommendation: 'No candidate compound supplied.',
    };
  }

  const candNormName = normName(candidate.name || '');
  const candSection = typeof candidate.sectionId === 'string' && candidate.sectionId.trim() ? candidate.sectionId.trim() : null;
  const candRoute = normRoute(candidate.route ?? candidate.dosages?.route ?? null);
  let resolvedCanonical = resolveCanonicalMolecule(candidate);
  const candTerms = collectNormalizedTerms(candidate);

  const candIngMap = extractIngredientsMap(candidate);
  const candIsRatioBlend = Boolean(candIngMap && Object.keys(candIngMap).length >= 2);
  const candFp = candIsRatioBlend ? compoundFingerprint(candidate) : '';

  const matches = [];

  for (const ex of Array.isArray(existingCompounds) ? existingCompounds : []) {
    if (!ex || typeof ex !== 'object') continue;
    if (excludeId != null && ex.id === excludeId) continue;

    const exNormName = normName(ex.name || '');
    const exSection = typeof ex.sectionId === 'string' && ex.sectionId.trim() ? ex.sectionId.trim() : null;
    const exRoute = normRoute(ex.route ?? ex.dosages?.route ?? null);
    const exCanonical = resolveCanonicalMolecule(ex);

    const sameSection = !candSection || !exSection || candSection === exSection;
    const distinctRoute = Boolean(candRoute && exRoute && candRoute !== exRoute);
    const isSameVariant = sameSection && !distinctRoute;

    let matchType = null;
    let matchedOn = null;

    // 1. Exact normalized name match
    if (candNormName && exNormName && candNormName === exNormName) {
      matchType = isSameVariant ? 'exact_duplicate' : 'same_molecule_other_route';
      matchedOn = 'name';
    } else {
      // 2. Canonical molecule or alias set intersection
      if (resolvedCanonical && exCanonical && resolvedCanonical === exCanonical) {
        matchType = isSameVariant ? 'alias_match' : 'same_molecule_other_route';
        matchedOn = `canonical:${resolvedCanonical}`;
      } else {
        const exTerms = collectNormalizedTerms(ex);
        let sharedTerm = null;
        for (const t of candTerms) {
          if (exTerms.has(t)) {
            sharedTerm = t;
            break;
          }
        }
        if (sharedTerm) {
          matchType = isSameVariant ? 'alias_match' : 'same_molecule_other_route';
          matchedOn = `alias:${sharedTerm}`;
          if (!resolvedCanonical && exCanonical) {
            resolvedCanonical = exCanonical;
          }
        }
      }

      // 3. Blend composition fingerprint match (both must have >=2 ingredient ratio maps)
      if (!matchType && candIsRatioBlend && candFp) {
        const exIngMap = extractIngredientsMap(ex);
        if (exIngMap && Object.keys(exIngMap).length >= 2) {
          const exFp = compoundFingerprint(ex);
          if (exFp && exFp === candFp) {
            matchType = isSameVariant ? 'blend_fingerprint_match' : 'same_molecule_other_route';
            matchedOn = `fingerprint:${candFp}`;
          }
        }
      }
    }

    if (matchType) {
      matches.push({
        compoundId: ex.id,
        name: ex.name,
        sectionId: exSection,
        route:
          (typeof ex.dosages?.route === 'string' && ex.dosages.route) ||
          (typeof ex.route === 'string' && ex.route) ||
          null,
        matchType,
        matchedOn,
      });
    }
  }

  let topBlocking = null;
  const relatedSet = new Set();

  for (const m of matches) {
    if (m.matchType === 'same_molecule_other_route') {
      if (m.compoundId != null) relatedSet.add(m.compoundId);
    } else {
      const mPrio = Object.hasOwn(MATCH_PRIORITY, m.matchType) ? MATCH_PRIORITY[m.matchType] : -1;
      const topPrio =
        topBlocking && Object.hasOwn(MATCH_PRIORITY, topBlocking.matchType)
          ? MATCH_PRIORITY[topBlocking.matchType]
          : -1;
      if (!topBlocking || mPrio > topPrio) {
        topBlocking = m;
      }
    }
  }

  const isDuplicate = Boolean(topBlocking);
  const relatedCompoundIds = [...relatedSet];
  const isSiblingVariant = !isDuplicate && relatedCompoundIds.length > 0;
  const classification = topBlocking
    ? topBlocking.matchType
    : isSiblingVariant
      ? 'same_molecule_other_route'
      : 'unique';

  let recommendation;
  if (isDuplicate) {
    recommendation = `Duplicate detected (${topBlocking.matchType}) matching existing compound "${topBlocking.name}" (${topBlocking.compoundId}). Enrich or update the existing profile instead of creating a duplicate.`;
  } else if (isSiblingVariant) {
    recommendation = `Allowed multi-route/cross-section variant of existing compound(s) [${relatedCompoundIds.join(', ')}]. Link via canonicalMolecule "${resolvedCanonical || ''}" and relatedCompoundIds.`;
  } else {
    recommendation = 'No duplicate found. Safe to create a new compound profile.';
  }

  return {
    isDuplicate,
    isSiblingVariant,
    classification,
    httpStatusHint: isDuplicate ? 409 : 200,
    existingCompoundId: topBlocking ? topBlocking.compoundId : null,
    relatedCompoundIds,
    canonicalMolecule: resolvedCanonical,
    matches,
    recommendation,
  };
}

/**
 * Find all sibling variants in `compounds` that share the same `canonicalMolecule`
 * (excluding self).
 */
export function findSiblingVariants(compound, compounds = []) {
  if (!compound || typeof compound !== 'object' || Array.isArray(compound) || !Array.isArray(compounds)) return [];
  const canon = resolveCanonicalMolecule(compound);
  if (!canon) return [];
  return compounds.filter((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
    if (c === compound || (compound.id != null && c.id === compound.id)) return false;
    return resolveCanonicalMolecule(c) === canon;
  });
}

/**
 * Return a new `compounds` array where `targetCompound` and all same-molecule
 * sibling variants have mutually linked, sorted, deduplicated `relatedCompoundIds`
 * (never self-referencing) and consistent `canonicalMolecule`.
 * Pure / non-mutating.
 */
export function linkRelatedCompounds(compounds = [], targetCompound = null) {
  const list = deepClone(Array.isArray(compounds) ? compounds : []);
  if (!targetCompound || typeof targetCompound !== 'object' || Array.isArray(targetCompound)) return list;

  const targetIdx = targetCompound.id != null ? list.findIndex((c) => c && c.id === targetCompound.id) : -1;
  const workingTarget = deepClone(targetCompound);
  if (targetIdx >= 0) {
    list[targetIdx] = workingTarget;
  } else {
    list.push(workingTarget);
  }

  const canon = resolveCanonicalMolecule(workingTarget);
  if (!canon) return list;

  const groupIndices = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    const cCanon = resolveCanonicalMolecule(c);
    if (cCanon === canon) {
      groupIndices.push(i);
    }
  }

  if (groupIndices.length < 2) {
    // Still stamp canonicalMolecule if resolved
    if (groupIndices.length === 1 && !list[groupIndices[0]].canonicalMolecule) {
      list[groupIndices[0]].canonicalMolecule = canon;
    }
    return list;
  }

  const groupIds = groupIndices.map((i) => list[i].id).filter(Boolean);
  for (const idx of groupIndices) {
    const c = list[idx];
    c.canonicalMolecule = canon;
    const merged = new Set(
      Array.isArray(c.relatedCompoundIds)
        ? c.relatedCompoundIds.filter((x) => typeof x === 'string' && x.trim())
        : [],
    );
    for (const gid of groupIds) {
      if (gid !== c.id) merged.add(gid);
    }
    merged.delete(c.id);
    c.relatedCompoundIds = [...merged].sort((a, b) => String(a).localeCompare(String(b)));
  }

  return list;
}
