/**
 * Canonical constants, enums, and default factory helpers for Home Pharmacy.
 * Pure ESM, zero external runtime dependencies (Node 22 + browser + Cloudflare Workers).
 * Public-repo invariant: zero personal names, personal health records, or secrets.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export const HUB_VERSION = '1.0.0';
export const HUB_SCHEMA_VERSION = 'home-pharmacy/v1';
export const HUB_EXPORT_FORMAT = 'home-pharmacy-export/v1';
export const PROTOCOL_OS_EXPORT_FORMAT = 'protocol-os-export/v1';
export const PROTOCOL_OS_FORMAT_RE = /^protocol-os-(export|logs)\/v\d+$/i;

export const TOMBSTONE_TTL_DAYS = 90;
export const TOMBSTONE_RETENTION_DAYS = 90;
export const SNAPSHOT_RETENTION_DAYS = 30;
export const LOW_STOCK_DOSE_THRESHOLD = 3;
export const DEFAULT_CONTEXT_MAX_TOKENS = 16000;

export const SYNC_COLLECTIONS = Object.freeze([
  'members',
  'sections',
  'compounds',
  'ownership',
  'stacks',
  'logs',
  'proposals',
  'auditLog',
]);

const DANGEROUS_CLONE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function _deepClone(value, seen) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof RegExp) {
    const re = new RegExp(value.source, value.flags);
    re.lastIndex = value.lastIndex;
    return re;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    const sliced = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (value instanceof DataView) {
      return new DataView(sliced);
    }
    const Ctor = Object.getPrototypeOf(value)?.constructor;
    return typeof Ctor === 'function' ? new Ctor(sliced) : new Uint8Array(sliced);
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const item of value) {
      out.add(_deepClone(item, seen));
    }
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value.entries()) {
      out.set(_deepClone(k, seen), _deepClone(v, seen));
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, i)) {
        out[i] = _deepClone(value[i], seen);
      }
    }
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_CLONE_KEYS.has(k)) continue;
    if (typeof v !== 'function' && typeof v !== 'symbol') {
      out[k] = _deepClone(v, seen);
    }
  }
  return out;
}

/**
 * Pure prototype-safe deep-clone helper supporting primitives, Dates, RegExps,
 * ArrayBuffers/TypedArrays, Sets, Maps, Arrays, plain Objects (normalizing
 * null-prototype objects to plain objects), and circular refs.
 * Always strips own '__proto__', 'constructor', and 'prototype' keys.
 */
export function deepClone(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  return _deepClone(value, new WeakMap());
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Household Members
// ---------------------------------------------------------------------------

export const DEFAULT_MEMBER_IDS = Object.freeze({
  WIFE: 'member_wife',
  HUSBAND: 'member_husband',
});

export const MEMBER_ROLES = Object.freeze(['admin', 'member']);
export const BIOLOGICAL_SEX_CONTEXTS = Object.freeze(['female', 'male', 'unspecified']);

export const DEFAULT_ROUTINE_ANCHORS = deepFreeze({
  wake: '07:00',
  breakfast: '08:00',
  workout: '06:30',
  workoutDays: [1, 2, 3, 4, 5], // 0=Sun..6=Sat
  lunch: '13:00',
  dinner: '19:00',
  bed: '22:30',
  tz: 'UTC',
});

export const DEFAULT_SAFETY_CONTEXT = deepFreeze({
  pregnancyOrTrying: false,
  biologicalSexContext: 'unspecified',
  allergies: [],
  activeRxMeds: [],
  conditions: [],
});

export const DEFAULT_MEMBERS = deepFreeze([
  {
    id: DEFAULT_MEMBER_IDS.WIFE,
    name: 'Wife',
    avatarInitial: 'W',
    accentColor: '#e3c886',
    role: 'admin',
    routineAnchors: { ...DEFAULT_ROUTINE_ANCHORS, workoutDays: [...DEFAULT_ROUTINE_ANCHORS.workoutDays] },
    safetyContext: {
      pregnancyOrTrying: false,
      biologicalSexContext: 'female',
      allergies: [],
      activeRxMeds: [],
      conditions: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: DEFAULT_MEMBER_IDS.HUSBAND,
    name: 'Husband',
    avatarInitial: 'H',
    accentColor: '#5fdc97',
    role: 'admin',
    routineAnchors: { ...DEFAULT_ROUTINE_ANCHORS, workoutDays: [...DEFAULT_ROUTINE_ANCHORS.workoutDays] },
    safetyContext: {
      pregnancyOrTrying: false,
      biologicalSexContext: 'male',
      allergies: [],
      activeRxMeds: [],
      conditions: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]);

export function createDefaultMembers(nowIso = new Date().toISOString()) {
  return DEFAULT_MEMBERS.map((member) => ({
    ...deepClone(member),
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}

// ---------------------------------------------------------------------------
// Sections & Dynamic Schema Customization Constants
// ---------------------------------------------------------------------------

export const CORE_SECTION_IDS = Object.freeze([
  'peptides',
  'peds',
  'vitamins_supplements',
  'dermatology',
]);

export const CORE_SECTION_ID_SET = new Set(CORE_SECTION_IDS);

export const CUSTOM_FIELD_TYPES = Object.freeze([
  'text',
  'textarea',
  'number',
  'select',
  'multiselect',
  'boolean',
  'url',
  'list',
]);

export const CUSTOM_FIELD_KEY_REGEX = /^[a-z][a-z0-9_]*$/;
export const SECTION_SLUG_REGEX = /^[a-z][a-z0-9_-]{1,47}$/;

export const RESERVED_COMPOUND_KEYS = new Set([
  'id',
  'slug',
  'name',
  'canonicalMolecule',
  'aliases',
  'sectionId',
  'subsection',
  'tags',
  'relatedCompoundIds',
  'summary',
  'detailedDescription',
  'mechanismOfAction',
  'useCaseScenarios',
  'benefits',
  'timingRules',
  'halfLife',
  'dosages',
  'cycles',
  'doNotPairWith',
  'synergies',
  'contraindications',
  'sideEffects',
  'monitoringLabs',
  'storageNotes',
  'sectionData',
  'customFields',
  'archivedCustomFields',
  'profileStatus',
  'provenance',
  'completenessPct',
  'notes',
  'createdAt',
  'updatedAt',
]);

export const NON_HIDEABLE_FIELDS = Object.freeze([
  'name',
  'sectionId',
  'summary',
  'dosages',
  'doNotPairWith',
]);

export const HIDEABLE_OPTIONAL_FIELDS = Object.freeze([
  'detailedDescription',
  'mechanismOfAction',
  'useCaseScenarios',
  'benefits',
  'timingRules',
  'halfLife',
  'cycles',
  'synergies',
  'contraindications',
  'sideEffects',
  'monitoringLabs',
  'storageNotes',
  'citations',
  'notes',
]);

export const DEFAULT_SECTIONS = deepFreeze([
  {
    id: 'peptides',
    name: 'Peptides',
    isCore: true,
    icon: 'syringe',
    accentColor: '#5fdc97',
    description: 'Injectable, pen, nasal, and oral research & clinical peptides.',
    subsections: [
      'GH Secretagogues',
      'Healing & Tissue',
      'GLP-1 & Metabolic',
      'Mitochondrial',
      'Cognitive & Sleep',
      'Immune',
      'Longevity',
      'Cosmetic',
      'Blends & Pens',
    ],
    aiResearchPrompt:
      'Research this peptide thoroughly. Provide receptor/pathway mechanism of action, route-specific elimination vs biological half-life (NEVER fabricate a single half-life for multi-peptide blends — set halfLife.kind to "unmodeled" and valueHours to null), typical vial mg or IU, diluent mL, preferred solvent (PBS for ARA-290, acetic_acid for IGF-1 LR3 & AOD-9604, BAC default), fasting window, cycle/washout pattern, contraindications (including oncogenic, glycemic, or serotonergic risks), monitoring labs, and primary citations (PMID, NCT, or FDA label URLs).',
    hiddenOptionalFields: [],
    customFields: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'peds',
    name: 'Performance Enhancement Drugs',
    isCore: true,
    icon: 'flame',
    accentColor: '#f78c3a',
    description: 'Androgens, TRT, SARMs, HPG ancillaries, AIs/SERMs, and metabolic/vascular performance agents.',
    subsections: [
      'TRT & Androgens',
      'Injectable AAS',
      'Oral AAS',
      'SARMs',
      'HPG Support & Ancillaries',
      'AIs & SERMs',
      'Myostatin & Anabolic',
      'Metabolic & Vascular',
    ],
    aiResearchPrompt:
      'Research this performance-enhancing or endocrine compound with rigorous harm-reduction metadata. Populate pedClass, ester and ester/depot half-life, oilPreMixed and oilConcentrationMgPerMl (if injectable oil), aromatizes, progestogenic, dhtDerived, hepatotoxic17aa, hpgSuppression, requiredBaseOrAncillaries, pctProtocol, clearanceWaitDays, femaleVirilizationRisk, sex-specific dosage notes, mandatory monitoring labs, hard-stop interactions (e.g., stacked 17aa orals, nitrates, pregnancy teratogenicity), and clinical citations.',
    hiddenOptionalFields: [],
    customFields: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'vitamins_supplements',
    name: 'Vitamins & Supplements',
    isCore: true,
    icon: 'pill',
    accentColor: '#4fd6e6',
    description: 'Fat- and water-soluble vitamins, chelated minerals, amino acids, lipids, organ support, and longevity supplements.',
    subsections: [
      'Fat-Soluble Vitamins',
      'Water-Soluble Vitamins',
      'Minerals & Electrolytes',
      'Amino Acids & Protein',
      'Omega & Lipids',
      'Longevity & NAD',
      'Organ & Liver Support',
      'Nootropics & Adaptogens',
      'Gut & Probiotics',
    ],
    aiResearchPrompt:
      'Research this vitamin or supplement carefully. Specify exact chemical salt/chelate form, bioavailability notes, elemental amount vs total compound weight, servingForm, ingredientsList (for multi-ingredient blends), food/fat absorption requirements, Adult Tolerable Upper Intake Level (adultUpperLimit), mineral competition separationHours (e.g., zinc vs copper, iron vs calcium/magnesium/zinc), prescription drug interactions, allergens, and NIH ODS/PubMed citations.',
    hiddenOptionalFields: [],
    customFields: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'dermatology',
    name: 'Dermatology (Skin & Hair)',
    isCore: true,
    icon: 'sparkles',
    accentColor: '#e3c886',
    description: 'Topical serums, creams, retinoids, exfoliants, sunscreens, scalp/hair treatments, and dermatology devices.',
    subsections: [
      'Face Actives',
      'Face Hydration & Barrier',
      'Sunscreens (SPF)',
      'Eye & Lip',
      'Body Topicals',
      'Hair & Scalp Treatments',
      'Shampoos & Cleansers',
      'Devices (Microneedling & LED)',
    ],
    aiResearchPrompt:
      'Research this dermatology topical or device. Populate targetArea (face, neck_chest, eye, body, scalp_hair, brows_lashes), vehicleType, actives (name, concentration, unit, optimalPh), layeringStep (1-7 viscosity/pH order), waitTimeMinutes, amPmSuitability, photosensitivity & SPF requirement, leaveOn boolean, acclimationRamp, skinCyclingRole, pregnancySafety (strict teratogen flagging for retinoids/topical anti-androgens), and incompatible co-layering pairs (e.g., retinoid vs AHA/BHA vs copper peptides vs L-ascorbic acid).',
    hiddenOptionalFields: [],
    customFields: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]);

export function createDefaultSections(nowIso = new Date().toISOString()) {
  return DEFAULT_SECTIONS.map((section) => ({
    ...deepClone(section),
    updatedAt: nowIso,
  }));
}

// ---------------------------------------------------------------------------
// Section-Specific Typed Enums & Schemas
// ---------------------------------------------------------------------------

export const PEPTIDE_FORMS = Object.freeze([
  'lyophilized',
  'pen',
  'nasal',
  'oral',
  'topical',
]);

export const PEPTIDE_SOLVENTS = Object.freeze(['BAC', 'PBS', 'acetic_acid']);

export const SOLVENT_OVERRIDES = Object.freeze({
  'ara-290': 'PBS',
  ara290: 'PBS',
  'igf1-lr3': 'acetic_acid',
  'igf-1-lr3': 'acetic_acid',
  igf1lr3: 'acetic_acid',
  aod9604: 'acetic_acid',
  'aod-9604': 'acetic_acid',
});

export const SOLVENT_LABELS = Object.freeze({
  BAC: 'Bacteriostatic water (BAC)',
  PBS: 'PBS (phosphate-buffered saline)',
  acetic_acid: 'Acetic acid (0.6%)',
});

export const PED_CLASSES = Object.freeze([
  'AAS',
  'TRT',
  'SARM',
  'SERM',
  'AI',
  'HPG_support',
  'myostatin',
  'metabolic',
  'sexual_health',
  'other',
]);

export const RISK_LEVELS = Object.freeze(['none', 'low', 'moderate', 'high']);

export const HPG_SUPPRESSION_LEVELS = Object.freeze([
  'none',
  'mild',
  'moderate',
  'shutdown',
]);

export const SERVING_FORMS = Object.freeze([
  'capsule',
  'softgel',
  'tablet',
  'powder',
  'liquid',
  'gummy',
  'lozenge',
  'other',
]);

export const SUPP_FOOD_REQUIREMENTS = Object.freeze([
  'with_fat_meal',
  'with_meal',
  'fasted',
  'with_vitamin_c',
  'away_from_caffeine',
  'any',
]);

export const DERM_TARGET_AREAS = Object.freeze([
  'face',
  'neck_chest',
  'eye',
  'body',
  'scalp_hair',
  'brows_lashes',
]);

export const DERM_VEHICLE_TYPES = Object.freeze([
  'cleanser',
  'acid_toner',
  'essence',
  'water_serum',
  'anhydrous_serum',
  'gel',
  'emulsion',
  'cream',
  'oil',
  'occlusive',
  'spf',
  'shampoo',
  'scalp_tonic',
  'foam',
  'device',
]);

export const DERM_AM_PM_SUITABILITIES = Object.freeze([
  'am_only',
  'pm_only',
  'am_or_pm',
  'both',
]);

export const DERM_PHOTOSENSITIVITY_LEVELS = Object.freeze([
  'none',
  'mild',
  'high_spf_required',
]);

export const DERM_SKIN_CYCLING_ROLES = Object.freeze([
  'retinoid',
  'exfoliant_aha_bha',
  'benzoyl_peroxide',
  'antioxidant_vit_c',
  'copper_peptide',
  'azelaic',
  'niacinamide',
  'barrier_recovery',
  'spf',
  'cleanser',
  'hair_growth',
  'anti_androgen_topical',
  'microneedling',
  'other',
]);

export const DERM_PREGNANCY_SAFETY_LEVELS = Object.freeze([
  'safe',
  'caution',
  'avoid_teratogen',
]);

export const SECTION_DATA_SCHEMAS = deepFreeze({
  peptides: {
    form: { type: 'enum', values: [...PEPTIDE_FORMS] },
    typicalVialMg: { type: 'number', min: 0, exclusiveMin: true },
    typicalVialIU: { type: 'number', min: 0, exclusiveMin: true },
    defaultDiluentMl: { type: 'number', min: 0, exclusiveMin: true },
    preferredSolvent: { type: 'enum', values: [...PEPTIDE_SOLVENTS] },
    ingredients: { type: 'ratio_map' },
    storageTemp: { type: 'string' },
    reconstitutedStabilityDays: { type: 'number', min: 0, exclusiveMin: true },
    injectionSiteRotation: { type: 'boolean' },
  },
  peds: {
    pedClass: { type: 'enum', values: [...PED_CLASSES] },
    ester: { type: 'string' },
    esterHalfLifeHours: { type: 'number', min: 0, exclusiveMin: true },
    oilPreMixed: { type: 'boolean' },
    oilConcentrationMgPerMl: { type: 'number', min: 0, exclusiveMin: true },
    aromatizes: { type: 'enum', values: [...RISK_LEVELS] },
    progestogenic: { type: 'boolean' },
    dhtDerived: { type: 'boolean' },
    hepatotoxic17aa: { type: 'boolean' },
    hpgSuppression: { type: 'enum', values: [...HPG_SUPPRESSION_LEVELS] },
    requiredBaseOrAncillaries: { type: 'string_array' },
    pctProtocol: { type: 'string' },
    clearanceWaitDays: { type: 'number', min: 0 },
    femaleVirilizationRisk: { type: 'enum', values: [...RISK_LEVELS] },
    mandatoryLabs: { type: 'string_array' },
  },
  vitamins_supplements: {
    chemicalForm: { type: 'string' },
    bioavailabilityNotes: { type: 'string' },
    elementalAmount: { type: 'number', min: 0 },
    elementalUnit: { type: 'string' },
    totalCompoundWeight: { type: 'number', min: 0 },
    servingForm: { type: 'enum', values: [...SERVING_FORMS] },
    ingredientsList: { type: 'ingredients_list' },
    foodRequirement: { type: 'enum', values: [...SUPP_FOOD_REQUIREMENTS] },
    adultUpperLimit: { type: 'upper_limit' },
    allergens: { type: 'string_array' },
    thirdPartyTested: { type: 'string' },
  },
  dermatology: {
    targetArea: { type: 'enum_array', values: [...DERM_TARGET_AREAS] },
    vehicleType: { type: 'enum', values: [...DERM_VEHICLE_TYPES] },
    actives: { type: 'actives_list' },
    layeringStep: { type: 'integer', min: 1, max: 7 },
    waitTimeMinutes: { type: 'number', min: 0, max: 60 },
    amPmSuitability: { type: 'enum', values: [...DERM_AM_PM_SUITABILITIES] },
    photosensitivity: { type: 'enum', values: [...DERM_PHOTOSENSITIVITY_LEVELS] },
    leaveOn: { type: 'boolean' },
    acclimationRamp: { type: 'string' },
    skinCyclingRole: { type: 'enum', values: [...DERM_SKIN_CYCLING_ROLES] },
    pregnancySafety: { type: 'enum', values: [...DERM_PREGNANCY_SAFETY_LEVELS] },
  },
});

// ---------------------------------------------------------------------------
// Units, Routes, Slots, Timing, PK & Interactions
// ---------------------------------------------------------------------------

export const CANONICAL_UNITS = Object.freeze([
  'mcg',
  'mg',
  'g',
  'IU',
  '%',
  'drops',
  'pumps',
  'sprays',
  'caps',
  'scoops',
  'pea_size',
  'mL',
]);

export const MASS_UNITS = Object.freeze(['mcg', 'mg', 'g']);

/**
 * Strictly mass-only conversions. IU is intentionally excluded because
 * International Units are a biological activity dimension independent of mass.
 */
export const MASS_TO_MCG = Object.freeze({
  mcg: 1,
  mg: 1000,
  g: 1_000_000,
});

export const CANONICAL_ROUTES = Object.freeze([
  'SubQ',
  'IM',
  'Oral',
  'SL',
  'Nasal',
  'Topical',
  'Device',
]);

export const INJECTABLE_ROUTES = Object.freeze(['SubQ', 'IM']);

export const ROUTE_ALIASES = Object.freeze({
  subq: 'SubQ',
  sq: 'SubQ',
  sc: 'SubQ',
  subcutaneous: 'SubQ',
  inj: 'SubQ',
  pen: 'SubQ',
  im: 'IM',
  intramuscular: 'IM',
  oral: 'Oral',
  po: 'Oral',
  tablet: 'Oral',
  capsule: 'Oral',
  cap: 'Oral',
  softgel: 'Oral',
  powder: 'Oral',
  sl: 'SL',
  sublingual: 'SL',
  nasal: 'Nasal',
  intranasal: 'Nasal',
  spray: 'Nasal',
  in: 'Nasal',
  topical: 'Topical',
  dermal: 'Topical',
  scalp: 'Topical',
  cream: 'Topical',
  serum: 'Topical',
  lotion: 'Topical',
  gel: 'Topical',
  foam: 'Topical',
  shampoo: 'Topical',
  solution: 'Topical',
  device: 'Device',
  microneedling: 'Device',
  led: 'Device',
});

export const SYSTEMIC_SLOTS = deepFreeze([
  { id: 'waking_fasted', label: 'Waking (Fasted)', anchorKey: 'wake', offsetMinutes: 0, fasted: true, workoutOnly: false, order: 1 },
  { id: 'morning_am', label: 'Morning / Breakfast', anchorKey: 'breakfast', offsetMinutes: 0, fasted: false, workoutOnly: false, order: 2 },
  { id: 'pre_workout', label: 'Pre-Workout', anchorKey: 'workout', offsetMinutes: -30, fasted: false, workoutOnly: true, order: 3 },
  { id: 'intra_post_workout', label: 'Intra / Post-Workout', anchorKey: 'workout', offsetMinutes: 60, fasted: false, workoutOnly: true, order: 4 },
  { id: 'midday_lunch', label: 'Midday / Lunch', anchorKey: 'lunch', offsetMinutes: 0, fasted: false, workoutOnly: false, order: 5 },
  { id: 'evening_dinner', label: 'Evening / Dinner', anchorKey: 'dinner', offsetMinutes: 0, fasted: false, workoutOnly: false, order: 6 },
  { id: 'bedtime_fasted', label: 'Bedtime (Fasted)', anchorKey: 'bed', offsetMinutes: 0, fasted: true, workoutOnly: false, order: 7 },
  { id: 'prn', label: 'As Needed (PRN)', anchorKey: null, offsetMinutes: 0, fasted: false, workoutOnly: false, order: 8 },
]);

export const SYSTEMIC_SLOT_IDS = Object.freeze(SYSTEMIC_SLOTS.map((s) => s.id));

export const DERM_SLOT_IDS = Object.freeze([
  'derm_am',
  'derm_pm',
  'hair_am',
  'hair_pm',
  'derm_weekly',
]);

export const ALL_SLOT_IDS = Object.freeze([...SYSTEMIC_SLOT_IDS, ...DERM_SLOT_IDS]);

export const DERM_LAYERING_STEPS = deepFreeze([
  { step: 1, key: 'cleanser', label: '1. Cleanser', defaultVehicles: ['cleanser', 'shampoo'] },
  { step: 2, key: 'acid_toner', label: '2. Acid Toner / Exfoliant', defaultVehicles: ['acid_toner'] },
  { step: 3, key: 'water_serum', label: '3. Water-Based Serum / Essence', defaultVehicles: ['essence', 'water_serum', 'scalp_tonic'] },
  { step: 4, key: 'active_treatment', label: '4. Active Treatment / Retinoid', defaultVehicles: ['gel', 'anhydrous_serum', 'emulsion', 'foam'] },
  { step: 5, key: 'moisturizer', label: '5. Moisturizer / Barrier Cream', defaultVehicles: ['cream'] },
  { step: 6, key: 'oil_occlusive', label: '6. Facial Oil / Occlusive', defaultVehicles: ['oil', 'occlusive'] },
  { step: 7, key: 'spf', label: '7. Broad-Spectrum SPF (AM Only)', defaultVehicles: ['spf'] },
]);

export const FOOD_STATES = Object.freeze(['fasted', 'with_fat', 'with_meal', 'any']);

export const WORKOUT_RELATIONS = Object.freeze([
  'pre_workout',
  'post_workout',
  'training_days_only',
  'rest_days',
  'any',
]);

export const CIRCADIAN_EFFECTS = Object.freeze(['stimulating', 'neutral', 'sedating']);

export const HALF_LIFE_KINDS = Object.freeze([
  'elimination',
  'depot',
  'biological',
  'unmodeled',
]);

export const INTERACTION_TARGET_TYPES = Object.freeze([
  'compound',
  'class',
  'nutrient',
  'rx_med',
  'food_state',
]);

export const INTERACTION_SEVERITIES = Object.freeze([
  'hard_stop',
  'avoid_same_slot',
  'alternate_days',
  'caution',
]);

export const PK_DISCLAIMER =
  'Estimated dose equivalents remaining from logged doses — not blood concentration, clinical measurement, or redosing advice.';

// ---------------------------------------------------------------------------
// Ownership, Profile Lifecycle, Auth, Rotation & Safety References
// ---------------------------------------------------------------------------

export const OWNERSHIP_STATUSES = Object.freeze([
  'have',
  'dont_have',
  'wishlist',
  'low_stock',
  'ordered',
]);

export const OWNERSHIP_STATUS_META = deepFreeze({
  have: { label: 'Have', tone: 'positive' },
  dont_have: { label: "Don't Have", tone: 'neutral' },
  wishlist: { label: 'Wishlist', tone: 'accent' },
  low_stock: { label: 'Low Stock', tone: 'warning' },
  ordered: { label: 'Ordered', tone: 'info' },
});

export const PROFILE_STATUSES = Object.freeze([
  'verified',
  'ai_draft',
  'needs_review',
]);

export const EVIDENCE_TIERS = Object.freeze([
  'established',
  'working_hypothesis',
  'speculation',
]);

export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

export const INJECTION_SITES = Object.freeze([
  'L abdomen',
  'R abdomen',
  'L thigh',
  'R thigh',
  'L glute',
  'R glute',
  'L delt',
  'R delt',
]);

export const INJECTION_SITE_LABELS = Object.freeze({
  'L abdomen': 'Left Abdomen',
  'R abdomen': 'Right Abdomen',
  'L thigh': 'Left Thigh',
  'R thigh': 'Right Thigh',
  'L glute': 'Left Glute',
  'R glute': 'Right Glute',
  'L delt': 'Left Deltoid',
  'R delt': 'Right Deltoid',
});

export const AI_NEW_COMPOUND_POLICIES = Object.freeze([
  'auto_publish_ai_draft',
  'hold_in_inbox',
]);

export const API_TOKEN_SCOPES = Object.freeze(['read', 'propose', 'write']);

export const SUPPORTED_AI_PLATFORMS = Object.freeze([
  'gemini',
  'claude',
  'grok',
  'gpt',
  'muse',
]);

export const DEFAULT_HOUSEHOLD_SETTINGS = deepFreeze({
  householdName: 'Home Pharmacy',
  aiWritePolicy: {
    newCompoundMode: 'auto_publish_ai_draft',
    verifiedEditMode: 'always_propose',
    stackEditMode: 'always_propose',
    requireCitationsWarning: true,
  },
  defaultOwnershipScope: 'household',
  theme: 'auto',
  textScale: 1,
});

/**
 * Adult Tolerable Upper Intake Levels (NIH ODS / National Academies reference).
 * Used for schema validation and M2 cumulative micronutrient stack warnings.
 */
export const ADULT_UPPER_LIMITS = deepFreeze({
  vitamin_d3: { amount: 4000, unit: 'IU', massEquivMcg: 100, label: 'Vitamin D3' },
  zinc: { amount: 40, unit: 'mg', label: 'Zinc' },
  iron: { amount: 45, unit: 'mg', label: 'Iron' },
  vitamin_a: { amount: 3000, unit: 'mcg', label: 'Preformed Vitamin A (RAE)' },
  copper: { amount: 10, unit: 'mg', label: 'Copper' },
  vitamin_b6: { amount: 100, unit: 'mg', label: 'Vitamin B6' },
  selenium: { amount: 400, unit: 'mcg', label: 'Selenium' },
  calcium: { amount: 2500, unit: 'mg', label: 'Calcium' },
  vitamin_c: { amount: 2000, unit: 'mg', label: 'Vitamin C' },
  vitamin_e: { amount: 1000, unit: 'mg', label: 'Vitamin E (alpha-tocopherol)' },
  niacin: { amount: 35, unit: 'mg', label: 'Niacin (Nicotinic Acid)' },
  folate: { amount: 1000, unit: 'mcg', label: 'Supplemental Folic Acid' },
  magnesium_supplemental: { amount: 350, unit: 'mg', label: 'Supplemental Magnesium' },
});

/**
 * Advisory per-dose / per-week reference ceilings used by the Dose-Sanity Gate.
 * Strictly advisory (downgraded to CONFIRM + needsReview by softenVerdict).
 * HCG is strictly IU-dimensioned (maxMcg: null).
 */
export const DEFAULT_DOSE_CEILINGS = deepFreeze({
  tadalafil: { maxAmount: 20, maxMcg: 20000, per: 'dose', unit: 'mg' },
  testosterone: { maxAmount: 50, maxMcg: 50000, per: 'dose', unit: 'mg' },
  trt: { maxAmount: 50, maxMcg: 50000, per: 'dose', unit: 'mg' },
  'test-cyp': { maxAmount: 500, maxMcg: 500000, per: 'dose', unit: 'mg' },
  'testosterone-cypionate': { maxAmount: 500, maxMcg: 500000, per: 'dose', unit: 'mg' },
  'testosterone-enanthate': { maxAmount: 500, maxMcg: 500000, per: 'dose', unit: 'mg' },
  anavar: { maxAmount: 100, maxMcg: 100000, per: 'dose', unit: 'mg' },
  oxandrolone: { maxAmount: 100, maxMcg: 100000, per: 'dose', unit: 'mg' },
  deca: { maxAmount: 400, maxMcg: 400000, per: 'dose', unit: 'mg' },
  'nandrolone-decanoate': { maxAmount: 400, maxMcg: 400000, per: 'dose', unit: 'mg' },
  npp: { maxAmount: 200, maxMcg: 200000, per: 'dose', unit: 'mg' },
  primobolan: { maxAmount: 400, maxMcg: 400000, per: 'dose', unit: 'mg' },
  hcg: { maxAmount: 1500, maxMcg: null, per: 'dose', unit: 'IU' },
  retatrutide: { maxAmount: 12, maxMcg: 12000, per: 'week', unit: 'mg' },
  tirzepatide: { maxAmount: 15, maxMcg: 15000, per: 'week', unit: 'mg' },
  semaglutide: { maxAmount: 2.4, maxMcg: 2400, per: 'week', unit: 'mg' },
  cagrilintide: { maxAmount: 5, maxMcg: 5000, per: 'dose', unit: 'mg' },
  ipamorelin: { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  'cjc1295-no-dac': { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  'cjc-1295-no-dac': { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  'cjc1295-dac': { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  'cjc-1295-dac': { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  tesamorelin: { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  sermorelin: { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  hexarelin: { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  ghrp: { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
  'ipa-cjc': { maxAmount: 2000, maxMcg: 2000, per: 'dose', unit: 'mcg' },
});
