/**
 * Core domain schemas, dynamic section customization engine, profile/member/ownership/stack
 * validators, completeness scoring, and state factories for Home Pharmacy.
 * Pure ESM, immutable/non-mutating, zero external runtime dependencies.
 * Acyclic DAG Layer 3 (imports only constants.js and dedup.js).
 */

import {
  HUB_SCHEMA_VERSION,
  SYNC_COLLECTIONS,
  LOW_STOCK_DOSE_THRESHOLD,
  DEFAULT_ROUTINE_ANCHORS,
  DEFAULT_SAFETY_CONTEXT,
  DEFAULT_HOUSEHOLD_SETTINGS,
  DEFAULT_SECTIONS,
  MEMBER_ROLES,
  BIOLOGICAL_SEX_CONTEXTS,
  CORE_SECTION_IDS,
  CORE_SECTION_ID_SET,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_KEY_REGEX,
  SECTION_SLUG_REGEX,
  RESERVED_COMPOUND_KEYS,
  NON_HIDEABLE_FIELDS,
  SECTION_DATA_SCHEMAS,
  CANONICAL_UNITS,
  CANONICAL_ROUTES,
  ROUTE_ALIASES,
  ALL_SLOT_IDS,
  FOOD_STATES,
  WORKOUT_RELATIONS,
  CIRCADIAN_EFFECTS,
  HALF_LIFE_KINDS,
  INTERACTION_TARGET_TYPES,
  INTERACTION_SEVERITIES,
  OWNERSHIP_STATUSES,
  PROFILE_STATUSES,
  EVIDENCE_TIERS,
  CONFIDENCE_LEVELS,
  PEPTIDE_FORMS,
  PEPTIDE_SOLVENTS,
  PED_CLASSES,
  RISK_LEVELS,
  HPG_SUPPRESSION_LEVELS,
  SERVING_FORMS,
  SUPP_FOOD_REQUIREMENTS,
  DERM_TARGET_AREAS,
  DERM_VEHICLE_TYPES,
  DERM_AM_PM_SUITABILITIES,
  DERM_PHOTOSENSITIVITY_LEVELS,
  DERM_SKIN_CYCLING_ROLES,
  DERM_PREGNANCY_SAFETY_LEVELS,
  createDefaultMembers,
  createDefaultSections,
  deepClone,
} from './constants.js';
import { normName, normRoute, resolveCanonicalMolecule, stripFormulationSuffixes } from './dedup.js';

// ---------------------------------------------------------------------------
// 1. Utility Helpers
// ---------------------------------------------------------------------------

export function slugify(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateId(prefix = 'id') {
  const safePrefix = typeof prefix === 'string' ? prefix : 'id';
  const cleanPrefix = safePrefix.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'id';
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    const hex = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    return `${cleanPrefix}_${hex}`;
  }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${cleanPrefix}_${ts}${rand}`;
}

export function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return false;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function isValidTimeHHMM(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const CANONICAL_ROUTE_SET = new Set(CANONICAL_ROUTES);

export function normalizeRoute(route) {
  if (typeof route !== 'string') return null;
  const raw = route.trim();
  if (!raw) return null;
  if (CANONICAL_ROUTE_SET.has(raw)) return raw;
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key && Object.hasOwn(ROUTE_ALIASES, key) ? ROUTE_ALIASES[key] : null;
}

const DANGEROUS_PROTO_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

function hasLookupEntry(collection, key) {
  if (!collection || typeof key !== 'string' || !key) return false;
  if (collection instanceof Map || collection instanceof Set) return collection.has(key);
  if (typeof collection === 'object') {
    return Object.hasOwn(collection, key) && Boolean(collection[key]);
  }
  return false;
}

const ROUTE_QUALIFIER_TOKEN_MAP = Object.freeze(
  Object.assign(Object.create(null), {
    subq: ['subq'],
    sq: ['subq'],
    sc: ['subq'],
    subcutaneous: ['subq'],
    pen: ['subq'],
    im: ['im'],
    intramuscular: ['im'],
    injectable: ['subq', 'im'],
    injection: ['subq', 'im'],
    inj: ['subq', 'im'],
    oral: ['oral'],
    po: ['oral'],
    tablet: ['oral'],
    tablets: ['oral'],
    capsule: ['oral'],
    capsules: ['oral'],
    softgel: ['oral'],
    softgels: ['oral'],
    powder: ['oral'],
    sl: ['sl'],
    sublingual: ['sl'],
    troche: ['sl'],
    lozenge: ['sl'],
    nasal: ['nasal'],
    intranasal: ['nasal'],
    spray: ['nasal'],
    sprays: ['nasal'],
    topical: ['topical'],
    dermal: ['topical'],
    transdermal: ['topical'],
    scalp: ['topical'],
    serum: ['topical'],
    cream: ['topical'],
    foam: ['topical'],
    gel: ['topical'],
    lotion: ['topical'],
    shampoo: ['topical'],
    toner: ['topical'],
    ointment: ['topical'],
    emulsion: ['topical'],
    essence: ['topical'],
    solution: ['topical'],
    tonic: ['topical'],
    device: ['device'],
    microneedling: ['device'],
    led: ['device'],
  }),
);

function extractRouteQualifiers(text) {
  const routes = new Set();
  if (typeof text !== 'string' || !text.trim()) return routes;
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok && Object.hasOwn(ROUTE_QUALIFIER_TOKEN_MAP, tok)) {
      for (const r of ROUTE_QUALIFIER_TOKEN_MAP[tok]) routes.add(r);
    }
  }
  return routes;
}

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function createEmptyTombstonesMap() {
  const out = {};
  for (const col of SYNC_COLLECTIONS) out[col] = {};
  return out;
}

function hasNonEmptyValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  if (typeof val === 'number') return Number.isFinite(val);
  if (typeof val === 'boolean') return true;
  if (Array.isArray(val)) {
    return val.some((item) =>
      typeof item === 'string' ? item.trim().length > 0 : item !== null && item !== undefined,
    );
  }
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return false;
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (
    v instanceof Date ||
    v instanceof RegExp ||
    v instanceof Map ||
    v instanceof Set ||
    v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v)
  ) {
    return false;
  }
  return Object.prototype.toString.call(v) === '[object Object]';
}

function nonEmptyTimestampOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------
// 2. Hub State Factories & Normalization
// ---------------------------------------------------------------------------

/**
 * Create a clean-slate HubState with default 2 household members (Wife & Husband),
 * 4 immutable core sections, and 0 compounds (F46 clean-slate default).
 */
export function createEmptyHubState({ now = new Date().toISOString() } = {}) {
  return {
    schemaVersion: HUB_SCHEMA_VERSION,
    _schemaVersion: 1,
    _rev: 0,
    _syncedAt: null,
    settings: {
      ...deepClone(DEFAULT_HOUSEHOLD_SETTINGS),
      createdAt: now,
      updatedAt: now,
    },
    members: createDefaultMembers(now),
    sections: createDefaultSections(now),
    compounds: [],
    ownership: [],
    stacks: [],
    logs: [],
    proposals: [],
    auditLog: [],
    meta: {
      migrations: [],
      tombstones: createEmptyTombstonesMap(),
      createdAt: now,
      updatedAt: now,
    },
  };
}

export const createDefaultHubState = createEmptyHubState;

/**
 * Safely hydrate a partial, legacy, or deserialized HubState while preserving
 * user data and ensuring all 4 core sections and required structural keys exist.
 */
export function normalizeHubState(raw, { now = new Date().toISOString() } = {}) {
  const base = createEmptyHubState({ now });
  if (!isPlainObject(raw)) return base;

  const src = deepClone(raw);

  // Merge settings (also tolerating legacy `raw.household` property)
  const incomingSettings = isPlainObject(src.settings)
    ? src.settings
    : isPlainObject(src.household)
      ? src.household
      : {};
  const mergedPolicy = isPlainObject(incomingSettings.aiWritePolicy)
    ? { ...base.settings.aiWritePolicy, ...incomingSettings.aiWritePolicy }
    : base.settings.aiWritePolicy;

  const settings = {
    ...base.settings,
    ...incomingSettings,
    aiWritePolicy: mergedPolicy,
    createdAt: nonEmptyTimestampOr(incomingSettings.createdAt, base.settings.createdAt),
    updatedAt: nonEmptyTimestampOr(incomingSettings.updatedAt, base.settings.updatedAt),
  };

  // Members: preserve if provided as array, else default 2 members
  const members = Array.isArray(src.members) ? src.members : base.members;

  // Sections: guarantee all 4 core sections exist alongside any custom sections
  const incomingSections = Array.isArray(src.sections) ? src.sections : [];
  const sectionById = new Map();
  for (const s of incomingSections) {
    if (isPlainObject(s) && typeof s.id === 'string' && s.id.trim()) {
      const secId = s.id.trim();
      sectionById.set(secId, { ...s, id: secId });
    }
  }
  const mergedSections = [];
  for (const coreDef of base.sections) {
    const existing = sectionById.get(coreDef.id);
    if (existing) {
      mergedSections.push({
        ...coreDef,
        ...existing,
        id: coreDef.id,
        isCore: true,
        customFields: Array.isArray(existing.customFields) ? existing.customFields : [],
        subsections: Array.isArray(existing.subsections) ? existing.subsections : coreDef.subsections,
        hiddenOptionalFields: Array.isArray(existing.hiddenOptionalFields) ? existing.hiddenOptionalFields : [],
        updatedAt: nonEmptyTimestampOr(existing.updatedAt, coreDef.updatedAt),
      });
      sectionById.delete(coreDef.id);
    } else {
      mergedSections.push(coreDef);
    }
  }
  for (const custom of sectionById.values()) {
    mergedSections.push({
      ...custom,
      isCore: false,
      customFields: Array.isArray(custom.customFields) ? custom.customFields : [],
      subsections: Array.isArray(custom.subsections) ? custom.subsections : [],
      hiddenOptionalFields: Array.isArray(custom.hiddenOptionalFields) ? custom.hiddenOptionalFields : [],
      updatedAt: nonEmptyTimestampOr(custom.updatedAt, now),
    });
  }

  // Tombstones normalization
  const tombstones = createEmptyTombstonesMap();
  const rawTombs = src.meta?.tombstones;
  if (isPlainObject(rawTombs)) {
    for (const col of SYNC_COLLECTIONS) {
      if (Object.hasOwn(rawTombs, col) && isPlainObject(rawTombs[col])) {
        const safeMap = {};
        for (const [k, v] of Object.entries(rawTombs[col])) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          safeMap[k] = v;
        }
        tombstones[col] = safeMap;
      }
    }
  }

  const rawRev = typeof src._rev === 'boolean' ? NaN : Number(src._rev);
  const rev = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;

  return {
    schemaVersion: typeof src.schemaVersion === 'string' && src.schemaVersion ? src.schemaVersion : HUB_SCHEMA_VERSION,
    _schemaVersion: Number.isInteger(src._schemaVersion) && src._schemaVersion > 0 ? src._schemaVersion : 1,
    _rev: rev,
    _syncedAt: typeof src._syncedAt === 'string' ? src._syncedAt : null,
    settings,
    members,
    sections: mergedSections,
    compounds: Array.isArray(src.compounds) ? src.compounds : [],
    ownership: Array.isArray(src.ownership) ? src.ownership : [],
    stacks: Array.isArray(src.stacks) ? src.stacks : [],
    logs: Array.isArray(src.logs) ? src.logs : [],
    proposals: Array.isArray(src.proposals) ? src.proposals : [],
    auditLog: Array.isArray(src.auditLog) ? src.auditLog : [],
    meta: {
      migrations: Array.isArray(src.meta?.migrations) ? [...src.meta.migrations] : [],
      tombstones,
      createdAt: nonEmptyTimestampOr(src.meta?.createdAt, now),
      updatedAt: nonEmptyTimestampOr(src.meta?.updatedAt, now),
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Dynamic Section Schema Customization Engine (F6, F7)
// ---------------------------------------------------------------------------

const CUSTOM_FIELD_TYPE_SET = new Set(CUSTOM_FIELD_TYPES);
const NON_HIDEABLE_SET = new Set(NON_HIDEABLE_FIELDS);

export function validateCustomFieldDef(def, existingFields = [], { ignoreKey = null } = {}) {
  const errors = [];
  if (!isPlainObject(def)) {
    errors.push({ field: 'customField', code: 'INVALID_OBJECT', message: 'Custom field definition must be an object.' });
    return { ok: false, valid: false, errors, normalized: null };
  }

  const key = typeof def.key === 'string' ? def.key.trim() : '';
  if (!key) {
    errors.push({ field: 'key', code: 'REQUIRED', message: 'Custom field key is required.' });
  } else if (key.length > 64) {
    errors.push({ field: 'key', code: 'MAX_LENGTH', message: 'Custom field key must be <= 64 characters.' });
  } else if (!CUSTOM_FIELD_KEY_REGEX.test(key)) {
    errors.push({
      field: 'key',
      code: 'INVALID_KEY_FORMAT',
      message: 'Custom field key must match /^[a-z][a-z0-9_]*$/.',
    });
  } else if (RESERVED_COMPOUND_KEYS.has(key) || DANGEROUS_PROTO_KEYS.has(key)) {
    errors.push({
      field: 'key',
      code: 'RESERVED_KEY',
      message: `Key "${key}" is reserved by the core compound schema.`,
    });
  } else if (
    Array.isArray(existingFields) &&
    existingFields.some((f) => f && f.key === key && f.key !== ignoreKey)
  ) {
    errors.push({
      field: 'key',
      code: 'DUPLICATE_KEY',
      message: `Custom field key "${key}" already exists in this section.`,
    });
  }

  const label = typeof def.label === 'string' ? def.label.trim() : '';
  if (!label) {
    errors.push({ field: 'label', code: 'REQUIRED', message: 'Custom field label is required.' });
  } else if (label.length > 80) {
    errors.push({ field: 'label', code: 'MAX_LENGTH', message: 'Custom field label must be <= 80 characters.' });
  }

  const fieldType = typeof def.fieldType === 'string' ? def.fieldType.trim() : '';
  if (!CUSTOM_FIELD_TYPE_SET.has(fieldType)) {
    errors.push({
      field: 'fieldType',
      code: 'INVALID_FIELD_TYPE',
      message: `fieldType must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}.`,
    });
  }

  const needsOptions = fieldType === 'select' || fieldType === 'multiselect';
  let normalizedOptions;
  if (needsOptions) {
    if (!Array.isArray(def.options) || def.options.length === 0) {
      errors.push({
        field: 'options',
        code: 'OPTIONS_REQUIRED',
        message: `Field type "${fieldType}" requires a non-empty options array.`,
      });
    } else {
      const seen = new Set();
      normalizedOptions = [];
      for (const opt of def.options) {
        if (typeof opt !== 'string' || !opt.trim()) {
          errors.push({ field: 'options', code: 'INVALID_OPTION', message: 'All options must be non-empty strings.' });
          break;
        }
        const trimmed = opt.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          normalizedOptions.push(trimmed);
        }
      }
      if (normalizedOptions.length === 0 && errors.every((e) => e.field !== 'options')) {
        errors.push({ field: 'options', code: 'OPTIONS_REQUIRED', message: 'options must contain at least one entry.' });
      }
    }
  } else if (def.options !== undefined && def.options !== null) {
    if (!Array.isArray(def.options) || !def.options.every((o) => typeof o === 'string')) {
      errors.push({ field: 'options', code: 'INVALID_OPTION', message: 'options must be an array of strings.' });
    } else {
      normalizedOptions = def.options.map((o) => o.trim()).filter(Boolean);
    }
  }

  let unit;
  if (def.unit !== undefined && def.unit !== null) {
    if (typeof def.unit !== 'string') {
      errors.push({ field: 'unit', code: 'INVALID_TYPE', message: 'unit must be a string.' });
    } else if (def.unit.trim().length > 24) {
      errors.push({ field: 'unit', code: 'MAX_LENGTH', message: 'unit must be <= 24 characters.' });
    } else if (def.unit.trim()) {
      unit = def.unit.trim();
    }
  }

  if (def.required !== undefined && typeof def.required !== 'boolean') {
    errors.push({ field: 'required', code: 'INVALID_TYPE', message: 'required must be a boolean.' });
  }
  if (def.showOnCard !== undefined && typeof def.showOnCard !== 'boolean') {
    errors.push({ field: 'showOnCard', code: 'INVALID_TYPE', message: 'showOnCard must be a boolean.' });
  }

  let aiResearchInstruction;
  if (def.aiResearchInstruction !== undefined && def.aiResearchInstruction !== null) {
    if (typeof def.aiResearchInstruction !== 'string') {
      errors.push({
        field: 'aiResearchInstruction',
        code: 'INVALID_TYPE',
        message: 'aiResearchInstruction must be a string.',
      });
    } else if (def.aiResearchInstruction.trim().length > 500) {
      errors.push({
        field: 'aiResearchInstruction',
        code: 'MAX_LENGTH',
        message: 'aiResearchInstruction must be <= 500 characters.',
      });
    } else if (def.aiResearchInstruction.trim()) {
      aiResearchInstruction = def.aiResearchInstruction.trim();
    }
  }

  const ok = errors.length === 0;
  const normalized = ok
    ? {
        key,
        label,
        fieldType,
        ...(unit !== undefined ? { unit } : {}),
        ...(normalizedOptions !== undefined ? { options: normalizedOptions } : {}),
        required: Boolean(def.required),
        showOnCard: Boolean(def.showOnCard),
        ...(aiResearchInstruction !== undefined ? { aiResearchInstruction } : {}),
      }
    : null;

  return { ok, valid: ok, errors, normalized };
}

export function validateSection(section) {
  const errors = [];
  if (!isPlainObject(section)) {
    errors.push({ field: 'section', code: 'INVALID_OBJECT', message: 'Section must be an object.' });
    return { ok: false, valid: false, errors };
  }
  const id = typeof section.id === 'string' ? section.id.trim() : '';
  if (!id || !SECTION_SLUG_REGEX.test(id)) {
    errors.push({ field: 'id', code: 'INVALID_SECTION_ID', message: 'Section id must match /^[a-z][a-z0-9_-]{1,47}$/.' });
  }
  const name = typeof section.name === 'string' ? section.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', code: 'REQUIRED', message: 'Section name is required.' });
  }
  if (CORE_SECTION_ID_SET.has(id) && section.isCore !== true) {
    errors.push({ field: 'isCore', code: 'IMMUTABLE_CORE_SECTION', message: `Core section "${id}" must have isCore: true.` });
  } else if (id && !CORE_SECTION_ID_SET.has(id) && section.isCore === true) {
    errors.push({ field: 'isCore', code: 'INVALID_CORE_SECTION', message: `Custom section "${id}" cannot have isCore: true.` });
  }
  if (section.description !== undefined && section.description !== null && typeof section.description !== 'string') {
    errors.push({ field: 'description', code: 'INVALID_TYPE', message: 'description must be a string.' });
  }
  if (
    section.aiResearchPrompt !== undefined &&
    section.aiResearchPrompt !== null &&
    typeof section.aiResearchPrompt !== 'string'
  ) {
    errors.push({ field: 'aiResearchPrompt', code: 'INVALID_TYPE', message: 'aiResearchPrompt must be a string.' });
  }
  if (section.icon !== undefined && section.icon !== null && (typeof section.icon !== 'string' || !section.icon.trim())) {
    errors.push({ field: 'icon', code: 'INVALID_TYPE', message: 'icon must be a non-empty string.' });
  }
  if (
    section.accentColor !== undefined &&
    section.accentColor !== null &&
    (typeof section.accentColor !== 'string' || !section.accentColor.trim())
  ) {
    errors.push({ field: 'accentColor', code: 'INVALID_TYPE', message: 'accentColor must be a non-empty string.' });
  }
  if (section.subsections !== undefined) {
    if (!Array.isArray(section.subsections) || ![...section.subsections].every((s) => typeof s === 'string' && s.trim())) {
      errors.push({
        field: 'subsections',
        code: 'INVALID_SUBSECTIONS',
        message: 'subsections must be an array of non-empty strings.',
      });
    }
  }
  if (section.hiddenOptionalFields !== undefined) {
    if (
      !Array.isArray(section.hiddenOptionalFields) ||
      ![...section.hiddenOptionalFields].every((f) => typeof f === 'string')
    ) {
      errors.push({
        field: 'hiddenOptionalFields',
        code: 'INVALID_TYPE',
        message: 'hiddenOptionalFields must be an array of strings.',
      });
    } else {
      for (const f of section.hiddenOptionalFields) {
        const trimmed = f.trim();
        if (NON_HIDEABLE_SET.has(trimmed)) {
          errors.push({
            field: 'hiddenOptionalFields',
            code: 'CANNOT_HIDE_REQUIRED_FIELD',
            message: `Mandatory field "${trimmed}" cannot be hidden.`,
          });
        }
      }
    }
  }
  if (section.customFields !== undefined) {
    if (!Array.isArray(section.customFields)) {
      errors.push({
        field: 'customFields',
        code: 'INVALID_TYPE',
        message: 'customFields must be an array.',
      });
    } else {
      const seen = [];
      for (const cf of section.customFields) {
        const res = validateCustomFieldDef(cf, seen);
        if (!res.ok) errors.push(...res.errors);
        else seen.push(res.normalized);
      }
    }
  }
  const ok = errors.length === 0;
  return { ok, valid: ok, errors };
}

/**
 * Add a custom field to a section. Automatically restores any previously archived
 * compound values matching the key from `archivedCustomFields[key]`.
 */
export function addCustomField(section, fieldDef, { compounds = [], now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const existing = Array.isArray(section.customFields) ? section.customFields : [];
  const check = validateCustomFieldDef(fieldDef, existing);
  if (!check.ok) {
    return { ok: false, errors: check.errors };
  }

  const field = check.normalized;
  const nextSection = {
    ...deepClone(section),
    customFields: [...deepClone(existing), field],
    updatedAt: now,
  };

  let restoredCount = 0;
  const nextCompounds = (Array.isArray(compounds) ? compounds : []).map((c) => {
    if (!c || c.sectionId !== section.id) return deepClone(c);
    const archived = c.archivedCustomFields;
    if (isPlainObject(archived) && Object.hasOwn(archived, field.key)) {
      const cloned = deepClone(c);
      cloned.customFields = isPlainObject(cloned.customFields) ? cloned.customFields : {};
      cloned.customFields[field.key] = cloned.archivedCustomFields[field.key];
      delete cloned.archivedCustomFields[field.key];
      cloned.updatedAt = now;
      restoredCount++;
      return cloned;
    }
    return deepClone(c);
  });

  return {
    ok: true,
    section: nextSection,
    field,
    compounds: nextCompounds,
    restoredCount,
  };
}

/**
 * Update an existing custom field definition, optionally renaming its key
 * (migrating values across compounds) or moving it to `patch.orderIndex`.
 */
export function updateCustomField(section, fieldKey, patch, { compounds = [], now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const existing = Array.isArray(section.customFields) ? section.customFields : [];
  const idx = existing.findIndex((f) => f && f.key === fieldKey);
  if (idx < 0) {
    return {
      ok: false,
      errors: [{ field: 'key', code: 'NOT_FOUND', message: `Custom field "${fieldKey}" not found.` }],
    };
  }

  const { orderIndex, ...fieldPatch } = isPlainObject(patch) ? deepClone(patch) : {};
  const merged = { ...existing[idx], ...fieldPatch };
  const check = validateCustomFieldDef(merged, existing, { ignoreKey: fieldKey });
  if (!check.ok) {
    return { ok: false, errors: check.errors };
  }

  const nextField = check.normalized;
  const nextFields = deepClone(existing);
  nextFields[idx] = nextField;

  if (typeof orderIndex === 'number' && Number.isFinite(orderIndex)) {
    const clamped = Math.max(0, Math.min(nextFields.length - 1, Math.trunc(orderIndex)));
    const [moved] = nextFields.splice(idx, 1);
    nextFields.splice(clamped, 0, moved);
  }

  const nextSection = {
    ...deepClone(section),
    customFields: nextFields,
    updatedAt: now,
  };

  const renamed = nextField.key !== fieldKey;
  const nextCompounds = (Array.isArray(compounds) ? compounds : []).map((c) => {
    const cloned = deepClone(c);
    if (!renamed || !cloned || cloned.sectionId !== section.id) return cloned;
    let touched = false;
    if (isPlainObject(cloned.customFields) && Object.hasOwn(cloned.customFields, fieldKey)) {
      cloned.customFields[nextField.key] = cloned.customFields[fieldKey];
      delete cloned.customFields[fieldKey];
      touched = true;
    }
    if (isPlainObject(cloned.archivedCustomFields) && Object.hasOwn(cloned.archivedCustomFields, fieldKey)) {
      cloned.archivedCustomFields[nextField.key] = cloned.archivedCustomFields[fieldKey];
      delete cloned.archivedCustomFields[fieldKey];
      touched = true;
    }
    if (touched) cloned.updatedAt = now;
    return cloned;
  });

  return {
    ok: true,
    section: nextSection,
    field: nextField,
    compounds: nextCompounds,
  };
}

export function reorderCustomFields(section, orderedKeys, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const existing = Array.isArray(section.customFields) ? section.customFields : [];
  if (!Array.isArray(orderedKeys) || orderedKeys.length !== existing.length) {
    return {
      ok: false,
      errors: [{ field: 'orderedKeys', code: 'INVALID_PERMUTATION', message: 'orderedKeys must contain every custom field key exactly once.' }],
    };
  }

  const byKey = new Map(
    existing
      .filter((f) => isPlainObject(f) && typeof f.key === 'string')
      .map((f) => [f.key, f]),
  );
  const seen = new Set();
  const reordered = [];
  for (const k of orderedKeys) {
    if (!byKey.has(k) || seen.has(k)) {
      return {
        ok: false,
        errors: [{ field: 'orderedKeys', code: 'INVALID_PERMUTATION', message: `Invalid or duplicate key "${k}" in orderedKeys.` }],
      };
    }
    seen.add(k);
    reordered.push(deepClone(byKey.get(k)));
  }

  return {
    ok: true,
    section: {
      ...deepClone(section),
      customFields: reordered,
      updatedAt: now,
    },
  };
}

/**
 * Non-destructively remove a custom field from a section.
 * Archives any existing compound values for `fieldKey` into `archivedCustomFields[fieldKey]`.
 */
export function removeCustomField(section, fieldKey, { compounds = [], now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const existing = Array.isArray(section.customFields) ? section.customFields : [];
  if (!existing.some((f) => f && f.key === fieldKey)) {
    return {
      ok: false,
      errors: [{ field: 'key', code: 'NOT_FOUND', message: `Custom field "${fieldKey}" not found.` }],
    };
  }

  const nextSection = {
    ...deepClone(section),
    customFields: deepClone(existing.filter((f) => f && f.key !== fieldKey)),
    updatedAt: now,
  };

  let archivedCount = 0;
  const nextCompounds = (Array.isArray(compounds) ? compounds : []).map((c) => {
    const cloned = deepClone(c);
    if (!cloned || cloned.sectionId !== section.id) return cloned;
    if (isPlainObject(cloned.customFields) && Object.hasOwn(cloned.customFields, fieldKey)) {
      cloned.archivedCustomFields = isPlainObject(cloned.archivedCustomFields) ? cloned.archivedCustomFields : {};
      cloned.archivedCustomFields[fieldKey] = cloned.customFields[fieldKey];
      delete cloned.customFields[fieldKey];
      cloned.updatedAt = now;
      archivedCount++;
    }
    return cloned;
  });

  return {
    ok: true,
    section: nextSection,
    removedKey: fieldKey,
    compounds: nextCompounds,
    archivedCount,
  };
}

export function updateSectionConfig(section, patch, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const p = isPlainObject(patch) ? patch : {};
  const errors = [];

  if (p.id !== undefined && p.id !== section.id) {
    errors.push({ field: 'id', code: 'IMMUTABLE_SECTION_ID', message: 'Section id cannot be modified.' });
  }
  const isCoreSec = Boolean(section.isCore || CORE_SECTION_ID_SET.has(section.id));
  if (p.isCore !== undefined) {
    if (isCoreSec && p.isCore !== true) {
      errors.push({ field: 'isCore', code: 'IMMUTABLE_CORE_SECTION', message: 'Cannot unset isCore on a core section.' });
    } else if (!isCoreSec && p.isCore === true) {
      errors.push({ field: 'isCore', code: 'IMMUTABLE_CORE_SECTION', message: 'Cannot set isCore: true on a custom section.' });
    }
  }

  const next = deepClone(section);

  if (p.name !== undefined) {
    if (typeof p.name !== 'string' || !p.name.trim()) {
      errors.push({ field: 'name', code: 'REQUIRED', message: 'Section name must be a non-empty string.' });
    } else {
      next.name = p.name.trim();
    }
  }
  if (p.description !== undefined) {
    if (typeof p.description !== 'string') {
      errors.push({ field: 'description', code: 'INVALID_TYPE', message: 'description must be a string.' });
    } else {
      next.description = p.description.trim();
    }
  }
  if (p.icon !== undefined) {
    if (typeof p.icon !== 'string' || !p.icon.trim()) {
      errors.push({ field: 'icon', code: 'INVALID_TYPE', message: 'icon must be a non-empty string.' });
    } else {
      next.icon = p.icon.trim();
    }
  }
  if (p.accentColor !== undefined) {
    if (typeof p.accentColor !== 'string' || !p.accentColor.trim()) {
      errors.push({ field: 'accentColor', code: 'INVALID_TYPE', message: 'accentColor must be a non-empty string.' });
    } else {
      next.accentColor = p.accentColor.trim();
    }
  }
  if (p.aiResearchPrompt !== undefined) {
    if (typeof p.aiResearchPrompt !== 'string') {
      errors.push({ field: 'aiResearchPrompt', code: 'INVALID_TYPE', message: 'aiResearchPrompt must be a string.' });
    } else {
      next.aiResearchPrompt = p.aiResearchPrompt.trim();
    }
  }
  if (p.subsections !== undefined) {
    if (!Array.isArray(p.subsections) || ![...p.subsections].every((s) => typeof s === 'string' && s.trim())) {
      errors.push({ field: 'subsections', code: 'INVALID_SUBSECTIONS', message: 'subsections must be an array of non-empty strings.' });
    } else {
      const seen = new Set();
      const deduped = [];
      for (const s of p.subsections) {
        const trimmed = s.trim();
        const lower = trimmed.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          deduped.push(trimmed);
        }
      }
      next.subsections = deduped;
    }
  }
  if (p.hiddenOptionalFields !== undefined) {
    if (!Array.isArray(p.hiddenOptionalFields) || ![...p.hiddenOptionalFields].every((s) => typeof s === 'string')) {
      errors.push({ field: 'hiddenOptionalFields', code: 'INVALID_TYPE', message: 'hiddenOptionalFields must be an array of strings.' });
    } else {
      const normalizedHidden = [];
      const seenHidden = new Set();
      for (const f of p.hiddenOptionalFields) {
        const trimmed = f.trim();
        if (!trimmed) continue;
        if (NON_HIDEABLE_SET.has(trimmed)) {
          errors.push({
            field: 'hiddenOptionalFields',
            code: 'CANNOT_HIDE_REQUIRED_FIELD',
            message: `Mandatory field "${trimmed}" cannot be hidden.`,
          });
        } else if (!seenHidden.has(trimmed)) {
          seenHidden.add(trimmed);
          normalizedHidden.push(trimmed);
        }
      }
      next.hiddenOptionalFields = normalizedHidden;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  next.updatedAt = now;
  return { ok: true, section: next };
}

export function addCustomSubsection(section, name, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    return { ok: false, errors: [{ field: 'subsection', code: 'REQUIRED', message: 'Subsection name is required.' }] };
  }
  const cloned = deepClone(section);
  const existing = Array.isArray(cloned.subsections) ? cloned.subsections : [];
  if (existing.some((s) => typeof s === 'string' && s.toLowerCase() === trimmed.toLowerCase())) {
    return {
      ok: false,
      errors: [{ field: 'subsection', code: 'DUPLICATE_SUBSECTION', message: `Subsection "${trimmed}" already exists.` }],
    };
  }
  return {
    ok: true,
    section: {
      ...cloned,
      subsections: [...existing, trimmed],
      updatedAt: now,
    },
  };
}

export function removeCustomSubsection(section, name, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(section)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section is required.' }] };
  }
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const cloned = deepClone(section);
  const existing = Array.isArray(cloned.subsections) ? cloned.subsections : [];
  const nextSubs = existing.filter((s) => !(typeof s === 'string' && s.toLowerCase() === trimmed.toLowerCase()));
  if (nextSubs.length === existing.length) {
    return {
      ok: false,
      errors: [{ field: 'subsection', code: 'NOT_FOUND', message: `Subsection "${trimmed}" not found.` }],
    };
  }
  return {
    ok: true,
    section: {
      ...cloned,
      subsections: nextSubs,
      updatedAt: now,
    },
  };
}

export function createCustomSection(sections = [], def = {}, { now = new Date().toISOString() } = {}) {
  const errors = [];
  if (!isPlainObject(def)) {
    return { ok: false, errors: [{ field: 'section', code: 'INVALID_OBJECT', message: 'Section definition is required.' }] };
  }

  const name = typeof def.name === 'string' ? def.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', code: 'REQUIRED', message: 'Section name is required.' });
  }

  const derivedId =
    typeof def.id === 'string' && def.id.trim()
      ? def.id.trim().toLowerCase()
      : slugify(name).replace(/-/g, '_');

  if (!derivedId || !SECTION_SLUG_REGEX.test(derivedId)) {
    errors.push({
      field: 'id',
      code: 'INVALID_SECTION_ID',
      message: 'Section id must match /^[a-z][a-z0-9_-]{1,47}$/.',
    });
  } else if (CORE_SECTION_ID_SET.has(derivedId)) {
    errors.push({
      field: 'id',
      code: 'RESERVED_CORE_SECTION',
      message: `Section id "${derivedId}" is reserved for a core section.`,
    });
  } else if (Array.isArray(sections) && sections.some((s) => s && s.id === derivedId)) {
    errors.push({
      field: 'id',
      code: 'DUPLICATE_SECTION',
      message: `Section id "${derivedId}" already exists.`,
    });
  }

  const normalizedCustomFields = [];
  if (def.customFields !== undefined) {
    if (!Array.isArray(def.customFields)) {
      errors.push({ field: 'customFields', code: 'INVALID_TYPE', message: 'customFields must be an array.' });
    } else {
      for (const cf of def.customFields) {
        const check = validateCustomFieldDef(cf, normalizedCustomFields);
        if (!check.ok) errors.push(...check.errors);
        else normalizedCustomFields.push(check.normalized);
      }
    }
  }

  let normalizedSubsections = [];
  if (def.subsections !== undefined) {
    if (!Array.isArray(def.subsections) || ![...def.subsections].every((s) => typeof s === 'string' && s.trim())) {
      errors.push({
        field: 'subsections',
        code: 'INVALID_SUBSECTIONS',
        message: 'subsections must be an array of non-empty strings.',
      });
    } else {
      const seenSubs = new Set();
      for (const s of def.subsections) {
        const trimmed = s.trim();
        const lower = trimmed.toLowerCase();
        if (!seenSubs.has(lower)) {
          seenSubs.add(lower);
          normalizedSubsections.push(trimmed);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const section = {
    id: derivedId,
    name,
    isCore: false,
    icon: typeof def.icon === 'string' && def.icon.trim() ? def.icon.trim() : 'folder',
    accentColor: typeof def.accentColor === 'string' && def.accentColor.trim() ? def.accentColor.trim() : '#8fa39b',
    description: typeof def.description === 'string' ? def.description.trim() : '',
    subsections: normalizedSubsections,
    aiResearchPrompt:
      typeof def.aiResearchPrompt === 'string' && def.aiResearchPrompt.trim()
        ? def.aiResearchPrompt.trim()
        : `Research this ${name} entry thoroughly including summary, mechanism of action, timing, half-life, dosage, cycles, interactions, contraindications, and citations.`,
    hiddenOptionalFields: [],
    customFields: normalizedCustomFields,
    updatedAt: now,
  };

  return {
    ok: true,
    section,
    sections: [...deepClone(Array.isArray(sections) ? sections : []), deepClone(section)],
  };
}

/**
 * Strict section deletion guard:
 * - NEVER deletes any core section (empty or non-empty)
 * - NEVER deletes a non-empty custom section
 * - Allows deleting an empty custom section
 */
export function deleteSection(sections = [], sectionId, { compounds = [] } = {}) {
  if (typeof sectionId !== 'string' || !sectionId) {
    return {
      ok: false,
      errors: [{ field: 'sectionId', code: 'NOT_FOUND', message: 'Section not found.' }],
    };
  }
  const list = Array.isArray(sections) ? sections : [];
  const target = list.find((s) => s && s.id === sectionId);
  if (!target) {
    return {
      ok: false,
      errors: [{ field: 'sectionId', code: 'NOT_FOUND', message: `Section "${sectionId}" not found.` }],
    };
  }

  const count = (Array.isArray(compounds) ? compounds : []).filter((c) => c && c.sectionId === sectionId).length;

  if (target.isCore || CORE_SECTION_ID_SET.has(sectionId)) {
    return {
      ok: false,
      errors: [
        {
          field: 'sectionId',
          code: count > 0 ? 'CORE_SECTION_NON_EMPTY' : 'CANNOT_DELETE_CORE_SECTION',
          message: `Core section "${sectionId}" is immutable and cannot be deleted.`,
        },
      ],
    };
  }

  if (count > 0) {
    return {
      ok: false,
      errors: [
        {
          field: 'sectionId',
          code: 'SECTION_NOT_EMPTY',
          message: `Cannot delete section "${sectionId}" because it still contains ${count} compound(s).`,
        },
      ],
    };
  }

  return {
    ok: true,
    deletedId: sectionId,
    sections: deepClone(list.filter((s) => s && s.id !== sectionId)),
  };
}

export function getSectionSchemaDescriptor(section) {
  if (!isPlainObject(section)) return null;
  const hidden = new Set(Array.isArray(section.hiddenOptionalFields) ? section.hiddenOptionalFields : []);
  const coreFields = [
    { key: 'name', required: true, hidden: false },
    { key: 'sectionId', required: true, hidden: false },
    { key: 'subsection', required: false, hidden: false },
    { key: 'summary', required: true, hidden: false },
    { key: 'detailedDescription', required: false, hidden: hidden.has('detailedDescription') },
    { key: 'mechanismOfAction', required: true, hidden: hidden.has('mechanismOfAction') },
    { key: 'useCaseScenarios', required: true, hidden: hidden.has('useCaseScenarios') },
    { key: 'benefits', required: false, hidden: hidden.has('benefits') },
    { key: 'timingRules', required: true, hidden: hidden.has('timingRules') },
    { key: 'halfLife', required: true, hidden: hidden.has('halfLife') },
    { key: 'dosages', required: true, hidden: false },
    { key: 'cycles', required: true, hidden: hidden.has('cycles') },
    { key: 'doNotPairWith', required: true, hidden: false },
    { key: 'synergies', required: false, hidden: hidden.has('synergies') },
    { key: 'contraindications', required: false, hidden: hidden.has('contraindications') },
    { key: 'sideEffects', required: false, hidden: hidden.has('sideEffects') },
    { key: 'monitoringLabs', required: false, hidden: hidden.has('monitoringLabs') },
    { key: 'storageNotes', required: false, hidden: hidden.has('storageNotes') },
    { key: 'provenance', required: false, hidden: hidden.has('citations') },
    { key: 'notes', required: false, hidden: hidden.has('notes') },
  ];

  return {
    section: deepClone(section),
    coreFields,
    sectionDataFields:
      typeof section.id === 'string' && Object.hasOwn(SECTION_DATA_SCHEMAS, section.id)
        ? deepClone(SECTION_DATA_SCHEMAS[section.id])
        : {},
    customFields: deepClone(Array.isArray(section.customFields) ? section.customFields : []),
    enums: {
      units: [...CANONICAL_UNITS],
      routes: [...CANONICAL_ROUTES],
      slots: [...ALL_SLOT_IDS],
      foodStates: [...FOOD_STATES],
      workoutRelations: [...WORKOUT_RELATIONS],
      circadianEffects: [...CIRCADIAN_EFFECTS],
      halfLifeKinds: [...HALF_LIFE_KINDS],
      interactionTargetTypes: [...INTERACTION_TARGET_TYPES],
      interactionSeverities: [...INTERACTION_SEVERITIES],
      evidenceTiers: [...EVIDENCE_TIERS],
      confidenceLevels: [...CONFIDENCE_LEVELS],
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Compound Profile Normalization, Completeness & Validation (F8, F11-F14, F18)
// ---------------------------------------------------------------------------

const ALL_SLOT_SET = new Set(ALL_SLOT_IDS);
const FOOD_STATE_SET = new Set(FOOD_STATES);
const WORKOUT_REL_SET = new Set(WORKOUT_RELATIONS);
const CIRCADIAN_SET = new Set(CIRCADIAN_EFFECTS);
const HL_KIND_SET = new Set(HALF_LIFE_KINDS);
const UNIT_SET = new Set(CANONICAL_UNITS);
const INT_TARGET_SET = new Set(INTERACTION_TARGET_TYPES);
const INT_SEV_SET = new Set(INTERACTION_SEVERITIES);
const PROFILE_STATUS_SET = new Set(PROFILE_STATUSES);
const EVIDENCE_TIER_SET = new Set(EVIDENCE_TIERS);
const CONFIDENCE_SET = new Set(CONFIDENCE_LEVELS);

const PEPTIDE_FORM_SET = new Set(PEPTIDE_FORMS);
const PEPTIDE_SOLVENT_SET = new Set(PEPTIDE_SOLVENTS);
const PED_CLASS_SET = new Set(PED_CLASSES);
const RISK_LEVEL_SET = new Set(RISK_LEVELS);
const HPG_SUPP_SET = new Set(HPG_SUPPRESSION_LEVELS);
const SERVING_FORM_SET = new Set(SERVING_FORMS);
const SUPP_FOOD_SET = new Set(SUPP_FOOD_REQUIREMENTS);
const DERM_AREA_SET = new Set(DERM_TARGET_AREAS);
const DERM_VEHICLE_SET = new Set(DERM_VEHICLE_TYPES);
const DERM_AMPM_SET = new Set(DERM_AM_PM_SUITABILITIES);
const DERM_PHOTO_SET = new Set(DERM_PHOTOSENSITIVITY_LEVELS);
const DERM_ROLE_SET = new Set(DERM_SKIN_CYCLING_ROLES);
const DERM_PREG_SET = new Set(DERM_PREGNANCY_SAFETY_LEVELS);

export function computeCompoundCompleteness(compound, section = null) {
  if (!isPlainObject(compound)) return 0;

  let earned = 0;
  let total = 100;

  // 1. summary (10)
  if (typeof compound.summary === 'string' && compound.summary.trim().length > 0) earned += 10;
  // 2. mechanismOfAction (12)
  if (typeof compound.mechanismOfAction === 'string' && compound.mechanismOfAction.trim().length > 0) earned += 12;
  // 3. useCaseScenarios (8)
  if (Array.isArray(compound.useCaseScenarios) && compound.useCaseScenarios.filter((x) => typeof x === 'string' && x.trim()).length >= 1) earned += 8;
  // 4. timingRules (10)
  const tr = compound.timingRules || {};
  if (
    (Array.isArray(tr.preferredSlots) && tr.preferredSlots.length >= 1) ||
    (typeof tr.timingNotes === 'string' && tr.timingNotes.trim().length > 0)
  ) {
    earned += 10;
  }
  // 5. halfLife (10)
  const hl = compound.halfLife || {};
  if (
    (isFiniteNum(hl.valueHours) && hl.valueHours > 0) ||
    (isFiniteNum(hl.minHours) && hl.minHours > 0) ||
    (typeof hl.displayText === 'string' && hl.displayText.trim().length > 0)
  ) {
    earned += 10;
  }
  // 6. dosages (12)
  const ds = compound.dosages || {};
  const hasDose =
    (typeof ds.rangeText === 'string' && ds.rangeText.trim().length > 0) ||
    (isFiniteNum(ds.defaultAmount) && ds.defaultAmount > 0);
  const hasRoute = typeof ds.route === 'string' && ds.route.trim().length > 0;
  if (hasDose && hasRoute) earned += 12;

  // 7. cycles (8)
  const cy = compound.cycles || {};
  if ((typeof cy.patternText === 'string' && cy.patternText.trim().length > 0) || cy.continuous === true) {
    earned += 8;
  }

  // 8. Safety metadata (10)
  if (
    (Array.isArray(compound.doNotPairWith) && compound.doNotPairWith.length > 0) ||
    (Array.isArray(compound.contraindications) && compound.contraindications.length > 0) ||
    (Array.isArray(compound.sideEffects) && compound.sideEffects.length > 0)
  ) {
    earned += 10;
  }

  // 9. Citations (10)
  if (Array.isArray(compound.provenance?.citations) && compound.provenance.citations.length >= 1) {
    earned += 10;
  }

  // 10. Section-specific or custom fields populated (10)
  const sd = isPlainObject(compound.sectionData) ? compound.sectionData : {};
  const sdPopulated = Object.values(sd).filter(hasNonEmptyValue).length;
  const cf = isPlainObject(compound.customFields) ? compound.customFields : {};
  const cfPopulated = Object.values(cf).filter(hasNonEmptyValue).length;
  const isCoreSec = CORE_SECTION_ID_SET.has(compound.sectionId);
  if ((isCoreSec && sdPopulated >= 2) || (!isCoreSec && (cfPopulated >= 1 || sdPopulated >= 1))) {
    earned += 10;
  }

  // 11. Extended detail & storageNotes (10)
  total += 10;
  if (typeof compound.detailedDescription === 'string' && compound.detailedDescription.trim().length > 0) earned += 5;
  if (typeof compound.storageNotes === 'string' && compound.storageNotes.trim().length > 0) earned += 5;

  // Required section custom fields add +10 each to denominator & numerator
  const customFieldDefs = Array.isArray(section?.customFields) ? section.customFields : [];
  for (const fieldDef of customFieldDefs) {
    if (fieldDef && fieldDef.required) {
      total += 10;
      if (Object.hasOwn(cf, fieldDef.key) && hasNonEmptyValue(cf[fieldDef.key])) {
        earned += 10;
      }
    }
  }

  return Math.max(0, Math.min(100, Math.round((earned / total) * 100)));
}

export function normalizeCompoundProfile(input, { section = null, now = new Date().toISOString() } = {}) {
  const src = isPlainObject(input) ? deepClone(input) : {};
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  const slug = typeof src.slug === 'string' && src.slug.trim() ? slugify(src.slug) : slugify(name);
  const id = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : slug || generateId('cmp');

  const rawDosages = isPlainObject(src.dosages) ? src.dosages : {};
  const normalizedRouteVal =
    typeof rawDosages.route === 'string' && rawDosages.route.trim()
      ? normalizeRoute(rawDosages.route) || rawDosages.route.trim()
      : '';

  const rawTiming = isPlainObject(src.timingRules) ? src.timingRules : {};
  const rawHalfLife = isPlainObject(src.halfLife) ? src.halfLife : {};
  const rawCycles = isPlainObject(src.cycles) ? src.cycles : {};
  const rawProv = isPlainObject(src.provenance) ? src.provenance : {};

  const hlPopulated =
    (isFiniteNum(rawHalfLife.valueHours) && rawHalfLife.valueHours > 0) ||
    (isFiniteNum(rawHalfLife.minHours) && rawHalfLife.minHours > 0);

  const cleanStrList = (arr) =>
    Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];

  const normalized = {
    id,
    slug,
    name,
    canonicalMolecule:
      typeof src.canonicalMolecule === 'string' && src.canonicalMolecule.trim()
        ? src.canonicalMolecule.trim()
        : resolveCanonicalMolecule(src) || undefined,
    aliases: cleanStrList(src.aliases),
    sectionId: typeof src.sectionId === 'string' ? src.sectionId.trim() : '',
    subsection: typeof src.subsection === 'string' ? src.subsection.trim() : '',
    tags: [...new Set(cleanStrList(src.tags))],
    relatedCompoundIds: [...new Set(cleanStrList(src.relatedCompoundIds).filter((r) => r !== id))],
    summary: typeof src.summary === 'string' ? src.summary.trim() : '',
    detailedDescription: typeof src.detailedDescription === 'string' ? src.detailedDescription.trim() : '',
    mechanismOfAction: typeof src.mechanismOfAction === 'string' ? src.mechanismOfAction.trim() : '',
    useCaseScenarios: cleanStrList(src.useCaseScenarios),
    benefits: cleanStrList(src.benefits),
    timingRules: {
      preferredSlots: Array.isArray(rawTiming.preferredSlots) ? [...rawTiming.preferredSlots] : [],
      avoidSlots: Array.isArray(rawTiming.avoidSlots) ? [...rawTiming.avoidSlots] : [],
      foodState: FOOD_STATE_SET.has(rawTiming.foodState) ? rawTiming.foodState : 'any',
      ...(rawTiming.fastingWindowHours !== undefined ? { fastingWindowHours: rawTiming.fastingWindowHours } : {}),
      workoutRelation: WORKOUT_REL_SET.has(rawTiming.workoutRelation) ? rawTiming.workoutRelation : 'any',
      circadianEffect: CIRCADIAN_SET.has(rawTiming.circadianEffect) ? rawTiming.circadianEffect : 'neutral',
      timingNotes: typeof rawTiming.timingNotes === 'string' ? rawTiming.timingNotes.trim() : '',
    },
    halfLife: {
      valueHours: rawHalfLife.valueHours !== undefined ? rawHalfLife.valueHours : null,
      ...(rawHalfLife.minHours !== undefined ? { minHours: rawHalfLife.minHours } : {}),
      ...(rawHalfLife.maxHours !== undefined ? { maxHours: rawHalfLife.maxHours } : {}),
      displayText: typeof rawHalfLife.displayText === 'string' ? rawHalfLife.displayText.trim() : '',
      ...(rawHalfLife.route !== undefined ? { route: rawHalfLife.route } : {}),
      kind: HL_KIND_SET.has(rawHalfLife.kind) ? rawHalfLife.kind : hlPopulated ? 'elimination' : 'unmodeled',
      ...(rawHalfLife.effectDurationNote !== undefined ? { effectDurationNote: rawHalfLife.effectDurationNote } : {}),
      ...(rawHalfLife.sourceUrl !== undefined ? { sourceUrl: rawHalfLife.sourceUrl } : {}),
    },
    dosages: {
      rangeText: typeof rawDosages.rangeText === 'string' ? rawDosages.rangeText.trim() : '',
      defaultAmount: rawDosages.defaultAmount !== undefined ? rawDosages.defaultAmount : null,
      defaultUnit: typeof rawDosages.defaultUnit === 'string' ? rawDosages.defaultUnit.trim() : '',
      route: normalizedRouteVal,
      frequencyText: typeof rawDosages.frequencyText === 'string' ? rawDosages.frequencyText.trim() : '',
      ...(rawDosages.femaleDoseNote !== undefined ? { femaleDoseNote: rawDosages.femaleDoseNote } : {}),
      ...(rawDosages.maleDoseNote !== undefined ? { maleDoseNote: rawDosages.maleDoseNote } : {}),
      ...(rawDosages.titrationSchedule !== undefined ? { titrationSchedule: rawDosages.titrationSchedule } : {}),
      ...(rawDosages.maxCeiling !== undefined ? { maxCeiling: rawDosages.maxCeiling } : {}),
    },
    cycles: {
      patternText: typeof rawCycles.patternText === 'string' ? rawCycles.patternText.trim() : '',
      cycleDays: rawCycles.cycleDays !== undefined ? rawCycles.cycleDays : null,
      offDays: rawCycles.offDays !== undefined ? rawCycles.offDays : null,
      continuous: Boolean(rawCycles.continuous),
      ...(rawCycles.washoutNote !== undefined ? { washoutNote: rawCycles.washoutNote } : {}),
    },
    doNotPairWith: Array.isArray(src.doNotPairWith) ? src.doNotPairWith : [],
    synergies: Array.isArray(src.synergies) ? src.synergies : [],
    contraindications: cleanStrList(src.contraindications),
    sideEffects: cleanStrList(src.sideEffects),
    monitoringLabs: cleanStrList(src.monitoringLabs),
    storageNotes: typeof src.storageNotes === 'string' ? src.storageNotes.trim() : '',
    sectionData: isPlainObject(src.sectionData) ? src.sectionData : {},
    customFields: isPlainObject(src.customFields) ? src.customFields : {},
    archivedCustomFields: isPlainObject(src.archivedCustomFields) ? src.archivedCustomFields : {},
    profileStatus: PROFILE_STATUS_SET.has(src.profileStatus) ? src.profileStatus : 'ai_draft',
    provenance: {
      sourceModel: typeof rawProv.sourceModel === 'string' && rawProv.sourceModel.trim() ? rawProv.sourceModel.trim() : 'manual',
      researchedAt: nonEmptyTimestampOr(rawProv.researchedAt, now),
      evidenceTier: EVIDENCE_TIER_SET.has(rawProv.evidenceTier) ? rawProv.evidenceTier : 'working_hypothesis',
      confidence: CONFIDENCE_SET.has(rawProv.confidence) ? rawProv.confidence : 'medium',
      citations: Array.isArray(rawProv.citations) ? rawProv.citations : [],
    },
    completenessPct: 0,
    notes: typeof src.notes === 'string' ? src.notes.trim() : '',
    createdAt: nonEmptyTimestampOr(src.createdAt, now),
    updatedAt: nonEmptyTimestampOr(src.updatedAt, now),
  };

  if (normalized.canonicalMolecule === undefined) {
    delete normalized.canonicalMolecule;
  }

  normalized.completenessPct = computeCompoundCompleteness(normalized, section);
  return normalized;
}

function validateSectionSpecificData(sectionId, sd, compound, errors, warnings) {
  if (!isPlainObject(sd)) return;

  if (sectionId === 'peptides') {
    if (sd.form !== undefined && sd.form !== null && !PEPTIDE_FORM_SET.has(sd.form)) {
      errors.push({ field: 'sectionData.form', code: 'INVALID_ENUM', message: `Peptide form must be one of: ${PEPTIDE_FORMS.join(', ')}.` });
    }
    for (const numField of ['typicalVialMg', 'typicalVialIU', 'defaultDiluentMl', 'reconstitutedStabilityDays', 'vialMg', 'vialIU', 'diluentMl']) {
      if (sd[numField] !== undefined && sd[numField] !== null && !(isFiniteNum(sd[numField]) && sd[numField] > 0)) {
        errors.push({ field: `sectionData.${numField}`, code: 'INVALID_NUMBER', message: `sectionData.${numField} must be a positive finite number.` });
      }
    }
    if (sd.preferredSolvent !== undefined && sd.preferredSolvent !== null && !PEPTIDE_SOLVENT_SET.has(sd.preferredSolvent)) {
      errors.push({
        field: 'sectionData.preferredSolvent',
        code: 'INVALID_SOLVENT',
        message: `preferredSolvent must be one of: ${PEPTIDE_SOLVENTS.join(', ')}.`,
      });
    }
    if (sd.storageTemp !== undefined && sd.storageTemp !== null && typeof sd.storageTemp !== 'string') {
      errors.push({ field: 'sectionData.storageTemp', code: 'INVALID_TYPE', message: 'sectionData.storageTemp must be a string.' });
    }
    if (sd.injectionSiteRotation !== undefined && typeof sd.injectionSiteRotation !== 'boolean') {
      errors.push({ field: 'sectionData.injectionSiteRotation', code: 'INVALID_TYPE', message: 'injectionSiteRotation must be a boolean.' });
    }
    if (sd.ingredients !== undefined && sd.ingredients !== null) {
      if (!isPlainObject(sd.ingredients)) {
        errors.push({ field: 'sectionData.ingredients', code: 'INVALID_TYPE', message: 'ingredients must be a ratio map object.' });
      } else {
        const vals = Object.entries(sd.ingredients)
          .filter(([k]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
          .map(([, v]) => v);
        let sum = 0;
        let badVal = false;
        for (const v of vals) {
          if (!isFiniteNum(v) || v <= 0 || v > 1) {
            badVal = true;
          } else {
            sum += v;
          }
        }
        if (badVal) {
          errors.push({
            field: 'sectionData.ingredients',
            code: 'INVALID_INGREDIENT_RATIO',
            message: 'Each peptide blend ingredient fraction must be in (0, 1].',
          });
        } else if (vals.length > 0 && (sum < 0.95 || sum > 1.05)) {
          errors.push({
            field: 'sectionData.ingredients',
            code: 'INVALID_INGREDIENT_SUM',
            message: `Peptide blend ingredient fractions must sum to ~1.0 (got ${sum.toFixed(3)}).`,
          });
        }
        if (vals.length >= 2 && isFiniteNum(compound?.halfLife?.valueHours) && compound.halfLife.valueHours > 0) {
          warnings.push({
            field: 'halfLife.valueHours',
            code: 'BLEND_HALF_LIFE_CAUTION',
            message: 'Multi-ingredient peptide blend carries a numeric halfLife.valueHours; PK engine will refuse single-curve modeling.',
          });
        }
      }
    }
  } else if (sectionId === 'peds') {
    if (sd.pedClass !== undefined && sd.pedClass !== null && !PED_CLASS_SET.has(sd.pedClass)) {
      errors.push({ field: 'sectionData.pedClass', code: 'INVALID_ENUM', message: `pedClass must be one of: ${PED_CLASSES.join(', ')}.` });
    }
    for (const strField of ['ester', 'pctProtocol']) {
      if (sd[strField] !== undefined && sd[strField] !== null && typeof sd[strField] !== 'string') {
        errors.push({ field: `sectionData.${strField}`, code: 'INVALID_TYPE', message: `sectionData.${strField} must be a string.` });
      }
    }
    for (const posNum of ['esterHalfLifeHours', 'oilConcentrationMgPerMl', 'concentrationMgPerMl']) {
      if (sd[posNum] !== undefined && sd[posNum] !== null && !(isFiniteNum(sd[posNum]) && sd[posNum] > 0)) {
        errors.push({ field: `sectionData.${posNum}`, code: 'INVALID_NUMBER', message: `sectionData.${posNum} must be > 0.` });
      }
    }
    if (sd.clearanceWaitDays !== undefined && sd.clearanceWaitDays !== null && !(isFiniteNum(sd.clearanceWaitDays) && sd.clearanceWaitDays >= 0)) {
      errors.push({ field: 'sectionData.clearanceWaitDays', code: 'INVALID_NUMBER', message: 'clearanceWaitDays must be >= 0.' });
    }
    for (const boolField of ['oilPreMixed', 'progestogenic', 'dhtDerived', 'hepatotoxic17aa', 'c17AlphaAlkylated']) {
      if (sd[boolField] !== undefined && typeof sd[boolField] !== 'boolean') {
        errors.push({ field: `sectionData.${boolField}`, code: 'INVALID_TYPE', message: `sectionData.${boolField} must be a boolean.` });
      }
    }
    if (sd.aromatizes !== undefined && sd.aromatizes !== null && typeof sd.aromatizes !== 'boolean' && !RISK_LEVEL_SET.has(sd.aromatizes)) {
      errors.push({ field: 'sectionData.aromatizes', code: 'INVALID_ENUM', message: `aromatizes must be a boolean or one of: ${RISK_LEVELS.join(', ')}.` });
    }
    if (sd.femaleVirilizationRisk !== undefined && sd.femaleVirilizationRisk !== null && !RISK_LEVEL_SET.has(sd.femaleVirilizationRisk)) {
      errors.push({ field: 'sectionData.femaleVirilizationRisk', code: 'INVALID_ENUM', message: `femaleVirilizationRisk must be one of: ${RISK_LEVELS.join(', ')}.` });
    }
    if (sd.hpgSuppression !== undefined && sd.hpgSuppression !== null && sd.hpgSuppression !== 'high' && !HPG_SUPP_SET.has(sd.hpgSuppression)) {
      errors.push({ field: 'sectionData.hpgSuppression', code: 'INVALID_ENUM', message: `hpgSuppression must be one of: ${HPG_SUPPRESSION_LEVELS.join(', ')}.` });
    }
    for (const arrField of ['requiredBaseOrAncillaries', 'mandatoryLabs']) {
      if (sd[arrField] !== undefined && (!Array.isArray(sd[arrField]) || ![...sd[arrField]].every((x) => typeof x === 'string'))) {
        errors.push({ field: `sectionData.${arrField}`, code: 'INVALID_TYPE', message: `sectionData.${arrField} must be an array of strings.` });
      }
    }
  } else if (sectionId === 'vitamins_supplements') {
    for (const strField of ['chemicalForm', 'bioavailabilityNotes', 'elementalUnit', 'thirdPartyTested']) {
      if (sd[strField] !== undefined && sd[strField] !== null && typeof sd[strField] !== 'string') {
        errors.push({ field: `sectionData.${strField}`, code: 'INVALID_TYPE', message: `sectionData.${strField} must be a string.` });
      }
    }
    if (sd.servingForm !== undefined && sd.servingForm !== null && !SERVING_FORM_SET.has(sd.servingForm)) {
      errors.push({ field: 'sectionData.servingForm', code: 'INVALID_ENUM', message: `servingForm must be one of: ${SERVING_FORMS.join(', ')}.` });
    }
    if (sd.foodRequirement !== undefined && sd.foodRequirement !== null && !SUPP_FOOD_SET.has(sd.foodRequirement)) {
      errors.push({ field: 'sectionData.foodRequirement', code: 'INVALID_ENUM', message: `foodRequirement must be one of: ${SUPP_FOOD_REQUIREMENTS.join(', ')}.` });
    }
    if (sd.elementalAmount !== undefined && sd.elementalAmount !== null && !(isFiniteNum(sd.elementalAmount) && sd.elementalAmount >= 0)) {
      errors.push({ field: 'sectionData.elementalAmount', code: 'INVALID_NUMBER', message: 'elementalAmount must be >= 0.' });
    }
    if (sd.totalCompoundWeight !== undefined && sd.totalCompoundWeight !== null && !(isFiniteNum(sd.totalCompoundWeight) && sd.totalCompoundWeight >= 0)) {
      errors.push({ field: 'sectionData.totalCompoundWeight', code: 'INVALID_NUMBER', message: 'totalCompoundWeight must be >= 0.' });
    }
    if (
      isFiniteNum(sd.elementalAmount) &&
      isFiniteNum(sd.totalCompoundWeight) &&
      sd.elementalAmount > sd.totalCompoundWeight
    ) {
      errors.push({
        field: 'sectionData.elementalAmount',
        code: 'ELEMENTAL_EXCEEDS_TOTAL',
        message: 'elementalAmount cannot exceed totalCompoundWeight.',
      });
    }
    if (sd.ingredientsList !== undefined) {
      if (!Array.isArray(sd.ingredientsList)) {
        errors.push({ field: 'sectionData.ingredientsList', code: 'INVALID_TYPE', message: 'ingredientsList must be an array.' });
      } else {
        for (let idx = 0; idx < sd.ingredientsList.length; idx++) {
          const item = sd.ingredientsList[idx];
          if (!isPlainObject(item) || typeof item.name !== 'string' || !item.name.trim()) {
            errors.push({ field: `sectionData.ingredientsList[${idx}].name`, code: 'REQUIRED', message: 'Each ingredient requires a name.' });
          }
          if (item && item.amount !== undefined && item.amount !== null && !(isFiniteNum(item.amount) && item.amount >= 0)) {
            errors.push({ field: `sectionData.ingredientsList[${idx}].amount`, code: 'INVALID_NUMBER', message: 'Ingredient amount must be >= 0.' });
          }
        }
      }
    }
    if (sd.adultUpperLimit !== undefined && sd.adultUpperLimit !== null) {
      const ul = sd.adultUpperLimit;
      if (!isPlainObject(ul) || !(isFiniteNum(ul.amount) && ul.amount > 0) || typeof ul.unit !== 'string' || !ul.unit.trim()) {
        errors.push({
          field: 'sectionData.adultUpperLimit',
          code: 'INVALID_UPPER_LIMIT',
          message: 'adultUpperLimit must have positive finite amount and non-empty unit.',
        });
      }
    }
    if (sd.allergens !== undefined && (!Array.isArray(sd.allergens) || ![...sd.allergens].every((x) => typeof x === 'string'))) {
      errors.push({ field: 'sectionData.allergens', code: 'INVALID_TYPE', message: 'allergens must be an array of strings.' });
    }
  } else if (sectionId === 'dermatology') {
    const DERM_AREA_EXT = new Set([...DERM_TARGET_AREAS, 'neck', 'chest', 'scalp', 'hair', 'lips']);
    const DERM_VEHICLE_EXT = new Set([...DERM_VEHICLE_TYPES, 'serum', 'toner', 'liquid_toner', 'sunscreen', 'solution', 'lotion', 'moisturizer', 'wash', 'balm', 'ointment', 'mist', 'mask', 'spray', 'drops', 'patch']);
    const DERM_ROLE_EXT = new Set([...DERM_SKIN_CYCLING_ROLES, 'none', 'exfoliant', 'antioxidant', 'recovery', 'barrier', 'device', 'scalp_active', 'scalp_wash', 'hydration', 'active', 'treatment']);
    const DERM_PREG_EXT = new Set([...DERM_PREGNANCY_SAFETY_LEVELS, 'avoid', 'contraindicated']);

    if (sd.targetArea !== undefined) {
      if (!Array.isArray(sd.targetArea) || [...sd.targetArea].some((a) => !DERM_AREA_EXT.has(a))) {
        errors.push({
          field: 'sectionData.targetArea',
          code: 'INVALID_ENUM',
          message: `targetArea entries must be in: ${DERM_TARGET_AREAS.join(', ')}.`,
        });
      }
    }
    if (sd.vehicleType !== undefined && sd.vehicleType !== null && !DERM_VEHICLE_EXT.has(sd.vehicleType)) {
      errors.push({ field: 'sectionData.vehicleType', code: 'INVALID_ENUM', message: `vehicleType must be one of: ${DERM_VEHICLE_TYPES.join(', ')}.` });
    }
    if (sd.layeringStep !== undefined && sd.layeringStep !== null) {
      if (!Number.isInteger(sd.layeringStep) || sd.layeringStep < 1 || sd.layeringStep > 7) {
        errors.push({ field: 'sectionData.layeringStep', code: 'INVALID_RANGE', message: 'layeringStep must be an integer between 1 and 7.' });
      }
    }
    if (sd.waitTimeMinutes !== undefined && sd.waitTimeMinutes !== null) {
      if (!isFiniteNum(sd.waitTimeMinutes) || sd.waitTimeMinutes < 0 || sd.waitTimeMinutes > 60) {
        errors.push({ field: 'sectionData.waitTimeMinutes', code: 'INVALID_RANGE', message: 'waitTimeMinutes must be in [0, 60].' });
      }
    }
    if (sd.amPmSuitability !== undefined && sd.amPmSuitability !== null && !DERM_AMPM_SET.has(sd.amPmSuitability)) {
      errors.push({ field: 'sectionData.amPmSuitability', code: 'INVALID_ENUM', message: `amPmSuitability must be one of: ${DERM_AM_PM_SUITABILITIES.join(', ')}.` });
    }
    if (sd.photosensitivity !== undefined && sd.photosensitivity !== null && typeof sd.photosensitivity !== 'boolean' && !DERM_PHOTO_SET.has(sd.photosensitivity)) {
      errors.push({ field: 'sectionData.photosensitivity', code: 'INVALID_ENUM', message: `photosensitivity must be a boolean or one of: ${DERM_PHOTOSENSITIVITY_LEVELS.join(', ')}.` });
    }
    if (sd.leaveOn !== undefined && typeof sd.leaveOn !== 'boolean') {
      errors.push({ field: 'sectionData.leaveOn', code: 'INVALID_TYPE', message: 'leaveOn must be a boolean.' });
    }
    if (sd.acclimationRamp !== undefined && sd.acclimationRamp !== null && typeof sd.acclimationRamp !== 'string') {
      errors.push({ field: 'sectionData.acclimationRamp', code: 'INVALID_TYPE', message: 'sectionData.acclimationRamp must be a string.' });
    }
    if (sd.skinCyclingRole !== undefined && sd.skinCyclingRole !== null && !DERM_ROLE_EXT.has(sd.skinCyclingRole)) {
      errors.push({ field: 'sectionData.skinCyclingRole', code: 'INVALID_ENUM', message: `skinCyclingRole must be one of: ${DERM_SKIN_CYCLING_ROLES.join(', ')}.` });
    }
    if (sd.pregnancySafety !== undefined && sd.pregnancySafety !== null && !DERM_PREG_EXT.has(sd.pregnancySafety)) {
      errors.push({ field: 'sectionData.pregnancySafety', code: 'INVALID_ENUM', message: `pregnancySafety must be one of: ${DERM_PREGNANCY_SAFETY_LEVELS.join(', ')}.` });
    }
    if (sd.actives !== undefined) {
      if (!Array.isArray(sd.actives)) {
        errors.push({ field: 'sectionData.actives', code: 'INVALID_TYPE', message: 'actives must be an array.' });
      } else {
        for (let idx = 0; idx < sd.actives.length; idx++) {
          const act = sd.actives[idx];
          if (!isPlainObject(act) || typeof act.name !== 'string' || !act.name.trim()) {
            errors.push({ field: `sectionData.actives[${idx}].name`, code: 'REQUIRED', message: 'Each active ingredient requires a name.' });
          }
          if (act && act.concentration !== undefined && act.concentration !== null && !(isFiniteNum(act.concentration) && act.concentration >= 0)) {
            errors.push({ field: `sectionData.actives[${idx}].concentration`, code: 'INVALID_NUMBER', message: 'Active concentration must be >= 0.' });
          }
          if (act && act.concentrationPct !== undefined && act.concentrationPct !== null && !(isFiniteNum(act.concentrationPct) && act.concentrationPct >= 0)) {
            errors.push({ field: `sectionData.actives[${idx}].concentrationPct`, code: 'INVALID_NUMBER', message: 'Active concentrationPct must be >= 0.' });
          }
        }
      }
    }
  }
}

export function validateCompoundProfile(
  input,
  { section = null, sections = null, strict = false, now = new Date().toISOString() } = {},
) {
  const errors = [];
  const warnings = [];
  const missingFields = [];

  if (!isPlainObject(input)) {
    errors.push({ field: 'compound', code: 'INVALID_OBJECT', message: 'Compound profile must be an object.' });
    return { ok: false, valid: false, errors, warnings, missingFields: ['name', 'sectionId'], completenessPct: 0, normalized: null };
  }

  const availableSections = Array.isArray(sections) && sections.length > 0 ? sections : DEFAULT_SECTIONS;
  const sectionId = typeof input.sectionId === 'string' ? input.sectionId.trim() : '';
  const resolvedSection =
    section && section.id === sectionId
      ? section
      : availableSections.find((s) => s && s.id === sectionId) || (section && !sectionId ? section : null);

  // Core required: name & sectionId
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', code: 'REQUIRED', message: 'Compound name is required.' });
    missingFields.push('name');
  } else if (name.length > 160) {
    errors.push({ field: 'name', code: 'MAX_LENGTH', message: 'Compound name must be <= 160 characters.' });
  }

  if (!sectionId) {
    errors.push({ field: 'sectionId', code: 'REQUIRED', message: 'sectionId is required.' });
    missingFields.push('sectionId');
  } else if (!resolvedSection) {
    const validIds = availableSections.map((s) => s.id).join(', ');
    errors.push({
      field: 'sectionId',
      code: 'INVALID_SECTION',
      message: `Unknown sectionId "${sectionId}". Valid sections: ${validIds}.`,
    });
  }

  // Strict mode additional required checks
  if (strict) {
    if (typeof input.summary !== 'string' || !input.summary.trim()) {
      errors.push({ field: 'summary', code: 'REQUIRED', message: 'summary ("What it is") is required in strict mode.' });
      missingFields.push('summary');
    }
    if (typeof input.mechanismOfAction !== 'string' || !input.mechanismOfAction.trim()) {
      errors.push({ field: 'mechanismOfAction', code: 'REQUIRED', message: 'mechanismOfAction is required in strict mode.' });
      missingFields.push('mechanismOfAction');
    }
    if (!Array.isArray(input.useCaseScenarios) || input.useCaseScenarios.filter((x) => typeof x === 'string' && x.trim()).length === 0) {
      errors.push({ field: 'useCaseScenarios', code: 'REQUIRED', message: 'At least one useCaseScenario is required in strict mode.' });
      missingFields.push('useCaseScenarios');
    }
    const tr = input.timingRules || {};
    if (!(Array.isArray(tr.preferredSlots) && tr.preferredSlots.length > 0) && !(typeof tr.timingNotes === 'string' && tr.timingNotes.trim())) {
      errors.push({ field: 'timingRules', code: 'REQUIRED', message: 'timingRules (preferredSlots or timingNotes) is required in strict mode.' });
      missingFields.push('timingRules');
    }
    const hl = input.halfLife || {};
    if (!(typeof hl.displayText === 'string' && hl.displayText.trim()) && !(isFiniteNum(hl.valueHours) && hl.valueHours > 0)) {
      errors.push({ field: 'halfLife', code: 'REQUIRED', message: 'halfLife (displayText or valueHours) is required in strict mode.' });
      missingFields.push('halfLife');
    }
    const ds = input.dosages || {};
    if (!(typeof ds.rangeText === 'string' && ds.rangeText.trim()) && !(isFiniteNum(ds.defaultAmount) && ds.defaultAmount > 0)) {
      errors.push({ field: 'dosages', code: 'REQUIRED', message: 'dosages (rangeText or defaultAmount) is required in strict mode.' });
      missingFields.push('dosages');
    }
    if (typeof ds.route !== 'string' || !ds.route.trim()) {
      errors.push({ field: 'dosages.route', code: 'REQUIRED', message: 'dosages.route is required in strict mode.' });
      missingFields.push('dosages.route');
    }
    const cy = input.cycles || {};
    if (!(typeof cy.patternText === 'string' && cy.patternText.trim()) && cy.continuous !== true) {
      errors.push({ field: 'cycles', code: 'REQUIRED', message: 'cycles (patternText or continuous: true) is required in strict mode.' });
      missingFields.push('cycles');
    }
  }

  // timingRules validation
  if (input.timingRules !== undefined && input.timingRules !== null) {
    const tr = input.timingRules;
    if (!isPlainObject(tr)) {
      errors.push({ field: 'timingRules', code: 'INVALID_TYPE', message: 'timingRules must be an object.' });
    } else {
      const pref = Array.isArray(tr.preferredSlots) ? tr.preferredSlots : [];
      const avoid = Array.isArray(tr.avoidSlots) ? tr.avoidSlots : [];
      if (tr.preferredSlots !== undefined && !Array.isArray(tr.preferredSlots)) {
        errors.push({ field: 'timingRules.preferredSlots', code: 'INVALID_TYPE', message: 'preferredSlots must be an array.' });
      }
      if (tr.avoidSlots !== undefined && !Array.isArray(tr.avoidSlots)) {
        errors.push({ field: 'timingRules.avoidSlots', code: 'INVALID_TYPE', message: 'avoidSlots must be an array.' });
      }
      for (const s of pref) {
        if (!ALL_SLOT_SET.has(s)) {
          errors.push({ field: 'timingRules.preferredSlots', code: 'INVALID_SLOT', message: `Unknown slot "${s}".` });
        }
      }
      for (const s of avoid) {
        if (!ALL_SLOT_SET.has(s)) {
          errors.push({ field: 'timingRules.avoidSlots', code: 'INVALID_SLOT', message: `Unknown slot "${s}".` });
        }
      }
      const prefSet = new Set(pref);
      for (const s of avoid) {
        if (prefSet.has(s)) {
          errors.push({
            field: 'timingRules',
            code: 'CONFLICTING_SLOTS',
            message: `Slot "${s}" appears in both preferredSlots and avoidSlots.`,
          });
        }
      }
      if (tr.foodState !== undefined && !FOOD_STATE_SET.has(tr.foodState)) {
        errors.push({ field: 'timingRules.foodState', code: 'INVALID_ENUM', message: `foodState must be one of: ${FOOD_STATES.join(', ')}.` });
      }
      if (tr.fastingWindowHours !== undefined && tr.fastingWindowHours !== null) {
        if (!isFiniteNum(tr.fastingWindowHours) || tr.fastingWindowHours < 0 || tr.fastingWindowHours > 24) {
          errors.push({ field: 'timingRules.fastingWindowHours', code: 'INVALID_RANGE', message: 'fastingWindowHours must be in [0, 24].' });
        }
      }
      if (tr.workoutRelation !== undefined && !WORKOUT_REL_SET.has(tr.workoutRelation)) {
        errors.push({ field: 'timingRules.workoutRelation', code: 'INVALID_ENUM', message: `workoutRelation must be one of: ${WORKOUT_RELATIONS.join(', ')}.` });
      }
      if (tr.circadianEffect !== undefined && !CIRCADIAN_SET.has(tr.circadianEffect)) {
        errors.push({ field: 'timingRules.circadianEffect', code: 'INVALID_ENUM', message: `circadianEffect must be one of: ${CIRCADIAN_EFFECTS.join(', ')}.` });
      }
    }
  }

  // halfLife validation
  if (input.halfLife !== undefined && input.halfLife !== null) {
    const hl = input.halfLife;
    if (!isPlainObject(hl)) {
      errors.push({ field: 'halfLife', code: 'INVALID_TYPE', message: 'halfLife must be an object.' });
    } else {
      for (const key of ['valueHours', 'minHours', 'maxHours']) {
        if (hl[key] !== undefined && hl[key] !== null && !(isFiniteNum(hl[key]) && hl[key] > 0)) {
          errors.push({ field: `halfLife.${key}`, code: 'INVALID_HALF_LIFE', message: `halfLife.${key} must be strictly > 0.` });
        }
      }
      if (isFiniteNum(hl.minHours) && isFiniteNum(hl.maxHours) && hl.minHours > hl.maxHours) {
        errors.push({ field: 'halfLife', code: 'INVALID_RANGE', message: 'halfLife.minHours cannot exceed halfLife.maxHours.' });
      }
      if (hl.kind !== undefined && !HL_KIND_SET.has(hl.kind)) {
        errors.push({ field: 'halfLife.kind', code: 'INVALID_ENUM', message: `halfLife.kind must be one of: ${HALF_LIFE_KINDS.join(', ')}.` });
      }
      for (const strKey of ['route', 'effectDurationNote', 'displayText']) {
        if (hl[strKey] !== undefined && hl[strKey] !== null && typeof hl[strKey] !== 'string') {
          errors.push({ field: `halfLife.${strKey}`, code: 'INVALID_TYPE', message: `halfLife.${strKey} must be a string.` });
        }
      }
      if (
        hl.sourceUrl !== undefined &&
        hl.sourceUrl !== null &&
        (typeof hl.sourceUrl !== 'string' || hl.sourceUrl.trim() !== '')
      ) {
        if (!isValidHttpUrl(hl.sourceUrl)) {
          errors.push({ field: 'halfLife.sourceUrl', code: 'INVALID_URL', message: 'halfLife.sourceUrl must be a valid http(s) URL.' });
        }
      }
    }
  }

  // dosages validation
  if (input.dosages !== undefined && input.dosages !== null) {
    const ds = input.dosages;
    if (!isPlainObject(ds)) {
      errors.push({ field: 'dosages', code: 'INVALID_TYPE', message: 'dosages must be an object.' });
    } else {
      if (ds.defaultAmount !== undefined && ds.defaultAmount !== null && !(isFiniteNum(ds.defaultAmount) && ds.defaultAmount > 0)) {
        errors.push({ field: 'dosages.defaultAmount', code: 'INVALID_NUMBER', message: 'dosages.defaultAmount must be > 0.' });
      }
      if (ds.defaultUnit !== undefined && ds.defaultUnit !== null) {
        if (typeof ds.defaultUnit !== 'string' || (ds.defaultUnit.trim() !== '' && !UNIT_SET.has(ds.defaultUnit))) {
          errors.push({
            field: 'dosages.defaultUnit',
            code: 'INVALID_UNIT',
            message: `defaultUnit must be one of: ${CANONICAL_UNITS.join(', ')}.`,
          });
        }
      }
      if (ds.route !== undefined && ds.route !== null) {
        if (typeof ds.route !== 'string') {
          errors.push({
            field: 'dosages.route',
            code: 'INVALID_ROUTE',
            message: `Route must be a string. Valid routes: ${CANONICAL_ROUTES.join(', ')}.`,
          });
        } else if (ds.route.trim() !== '' && !normalizeRoute(ds.route)) {
          errors.push({
            field: 'dosages.route',
            code: 'INVALID_ROUTE',
            message: `Unrecognized route "${ds.route}". Valid routes: ${CANONICAL_ROUTES.join(', ')}.`,
          });
        }
      }
      for (const strKey of ['rangeText', 'frequencyText', 'femaleDoseNote', 'maleDoseNote', 'titrationSchedule']) {
        if (ds[strKey] !== undefined && ds[strKey] !== null && typeof ds[strKey] !== 'string') {
          errors.push({ field: `dosages.${strKey}`, code: 'INVALID_TYPE', message: `dosages.${strKey} must be a string.` });
        }
      }
      if (ds.maxCeiling !== undefined && ds.maxCeiling !== null) {
        if (!(isFiniteNum(ds.maxCeiling) && ds.maxCeiling > 0)) {
          errors.push({ field: 'dosages.maxCeiling', code: 'INVALID_NUMBER', message: 'dosages.maxCeiling must be > 0.' });
        } else if (isFiniteNum(ds.defaultAmount) && ds.defaultAmount > ds.maxCeiling) {
          warnings.push({
            field: 'dosages.defaultAmount',
            code: 'EXCEEDS_MAX_CEILING',
            message: `defaultAmount (${ds.defaultAmount}) exceeds maxCeiling (${ds.maxCeiling}).`,
          });
        }
      }
    }
  }

  // cycles validation
  if (input.cycles !== undefined && input.cycles !== null) {
    const cy = input.cycles;
    if (!isPlainObject(cy)) {
      errors.push({ field: 'cycles', code: 'INVALID_TYPE', message: 'cycles must be an object.' });
    } else {
      if (cy.cycleDays !== undefined && cy.cycleDays !== null && (!Number.isInteger(cy.cycleDays) || cy.cycleDays <= 0)) {
        errors.push({ field: 'cycles.cycleDays', code: 'INVALID_INTEGER', message: 'cycleDays must be a positive integer.' });
      }
      if (cy.offDays !== undefined && cy.offDays !== null && (!Number.isInteger(cy.offDays) || cy.offDays < 0)) {
        errors.push({ field: 'cycles.offDays', code: 'INVALID_INTEGER', message: 'offDays must be a non-negative integer.' });
      }
      if (cy.continuous !== undefined && typeof cy.continuous !== 'boolean') {
        errors.push({ field: 'cycles.continuous', code: 'INVALID_TYPE', message: 'cycles.continuous must be a boolean.' });
      }
      for (const strKey of ['patternText', 'washoutNote']) {
        if (cy[strKey] !== undefined && cy[strKey] !== null && typeof cy[strKey] !== 'string') {
          errors.push({ field: `cycles.${strKey}`, code: 'INVALID_TYPE', message: `cycles.${strKey} must be a string.` });
        }
      }
    }
  }

  // doNotPairWith validation
  const selfCanon = resolveCanonicalMolecule(input);
  const selfExplicitRoute = normRoute(input.dosages?.route);
  const selfRoutes = selfExplicitRoute
    ? new Set([selfExplicitRoute])
    : new Set([
        ...extractRouteQualifiers(name),
        ...extractRouteQualifiers(input.id),
        ...extractRouteQualifiers(input.slug),
      ]);
  const selfStrippedNorm = normName(stripFormulationSuffixes(name, { stripSalts: false }));
  const selfNormSet = new Set(
    [
      normName(name),
      normName(input.slug),
      normName(input.id),
      selfCanon ? normName(selfCanon) : '',
      ...(Array.isArray(input.aliases) ? input.aliases.map((a) => normName(a)) : []),
    ].filter(Boolean),
  );
  if (input.doNotPairWith !== undefined) {
    if (!Array.isArray(input.doNotPairWith)) {
      errors.push({ field: 'doNotPairWith', code: 'INVALID_TYPE', message: 'doNotPairWith must be an array.' });
    } else {
      for (let idx = 0; idx < input.doNotPairWith.length; idx++) {
        const rule = input.doNotPairWith[idx];
        if (!isPlainObject(rule)) {
          errors.push({ field: `doNotPairWith[${idx}]`, code: 'INVALID_OBJECT', message: 'Interaction rule must be an object.' });
          continue;
        }
        if (!INT_TARGET_SET.has(rule.targetType)) {
          errors.push({ field: `doNotPairWith[${idx}].targetType`, code: 'INVALID_ENUM', message: `targetType must be one of: ${INTERACTION_TARGET_TYPES.join(', ')}.` });
        }
        if (typeof rule.targetRef !== 'string' || !rule.targetRef.trim()) {
          errors.push({ field: `doNotPairWith[${idx}].targetRef`, code: 'REQUIRED', message: 'targetRef is required.' });
        } else if (rule.targetType === 'compound') {
          const targetNorm = normName(rule.targetRef);
          const targetCanon = resolveCanonicalMolecule(rule.targetRef);
          const targetStrippedNorm = normName(stripFormulationSuffixes(rule.targetRef, { stripSalts: false }));
          const targetRoutes = extractRouteQualifiers(rule.targetRef);
          const isDistinctRouteSibling =
            targetRoutes.size > 0 &&
            selfRoutes.size > 0 &&
            ![...targetRoutes].some((r) => selfRoutes.has(r));
          const distinctCanonicals = Boolean(selfCanon && targetCanon && selfCanon !== targetCanon);
          const sameMolecule =
            !distinctCanonicals &&
            (Boolean(selfCanon && targetCanon && targetCanon === selfCanon) ||
              Boolean(selfStrippedNorm && targetStrippedNorm && targetStrippedNorm === selfStrippedNorm));
          const isSelfRef =
            selfNormSet.has(targetNorm) || (sameMolecule && !isDistinctRouteSibling);
          if (isSelfRef) {
            errors.push({
              field: `doNotPairWith[${idx}].targetRef`,
              code: 'SELF_REFERENCE_INTERACTION',
              message: 'Compound cannot list itself in doNotPairWith.',
            });
          }
        }
        if (!INT_SEV_SET.has(rule.severity)) {
          errors.push({ field: `doNotPairWith[${idx}].severity`, code: 'INVALID_ENUM', message: `severity must be one of: ${INTERACTION_SEVERITIES.join(', ')}.` });
        }
        if (rule.separationHours !== undefined && rule.separationHours !== null) {
          if (!isFiniteNum(rule.separationHours) || rule.separationHours <= 0 || rule.separationHours > 72) {
            errors.push({ field: `doNotPairWith[${idx}].separationHours`, code: 'INVALID_RANGE', message: 'separationHours must be in (0, 72].' });
          }
        }
        if (rule.citation !== undefined && rule.citation !== null) {
          if (typeof rule.citation !== 'string') {
            errors.push({
              field: `doNotPairWith[${idx}].citation`,
              code: 'INVALID_TYPE',
              message: 'Interaction citation must be a string.',
            });
          } else if (rule.citation.trim()) {
            const cit = rule.citation.trim();
            const compactCit = cit.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
            const looksLikeUrlOrScheme =
              /:[/\\]{2}/.test(compactCit) ||
              /^[/\\]{2}/.test(compactCit) ||
              /^(?:https?|javascript|vbscript|data|file|ftp|blob):/i.test(compactCit);
            if (looksLikeUrlOrScheme && !isValidHttpUrl(cit)) {
              errors.push({
                field: `doNotPairWith[${idx}].citation`,
                code: 'INVALID_CITATION_URL',
                message: 'Interaction citation URL must be a valid http(s) URL.',
              });
            }
          }
        }
        if (strict) {
          if (typeof rule.mechanism !== 'string' || !rule.mechanism.trim()) {
            errors.push({ field: `doNotPairWith[${idx}].mechanism`, code: 'REQUIRED', message: 'mechanism is required in strict mode.' });
          }
          if (typeof rule.recommendation !== 'string' || !rule.recommendation.trim()) {
            errors.push({ field: `doNotPairWith[${idx}].recommendation`, code: 'REQUIRED', message: 'recommendation is required in strict mode.' });
          }
        }
      }
    }
  }

  // synergies validation
  if (input.synergies !== undefined) {
    if (!Array.isArray(input.synergies)) {
      errors.push({ field: 'synergies', code: 'INVALID_TYPE', message: 'synergies must be an array.' });
    } else {
      for (let idx = 0; idx < input.synergies.length; idx++) {
        const syn = input.synergies[idx];
        if (!isPlainObject(syn) || typeof syn.targetRef !== 'string' || !syn.targetRef.trim()) {
          errors.push({ field: `synergies[${idx}].targetRef`, code: 'REQUIRED', message: 'Synergy targetRef is required.' });
        }
        if (syn && syn.coLocate !== undefined && typeof syn.coLocate !== 'boolean') {
          errors.push({ field: `synergies[${idx}].coLocate`, code: 'INVALID_TYPE', message: 'coLocate must be a boolean.' });
        }
      }
    }
  }

  // profileStatus & provenance
  if (input.profileStatus !== undefined && !PROFILE_STATUS_SET.has(input.profileStatus)) {
    errors.push({ field: 'profileStatus', code: 'INVALID_ENUM', message: `profileStatus must be one of: ${PROFILE_STATUSES.join(', ')}.` });
  }

  const prov = input.provenance;
  if (prov !== undefined && prov !== null) {
    if (!isPlainObject(prov)) {
      errors.push({ field: 'provenance', code: 'INVALID_TYPE', message: 'provenance must be an object.' });
    } else {
      if (prov.evidenceTier !== undefined && !EVIDENCE_TIER_SET.has(prov.evidenceTier)) {
        errors.push({ field: 'provenance.evidenceTier', code: 'INVALID_ENUM', message: `evidenceTier must be one of: ${EVIDENCE_TIERS.join(', ')}.` });
      }
      if (prov.confidence !== undefined && !CONFIDENCE_SET.has(prov.confidence)) {
        errors.push({ field: 'provenance.confidence', code: 'INVALID_ENUM', message: `confidence must be one of: ${CONFIDENCE_LEVELS.join(', ')}.` });
      }
      if (prov.citations !== undefined) {
        if (!Array.isArray(prov.citations)) {
          errors.push({ field: 'provenance.citations', code: 'INVALID_TYPE', message: 'citations must be an array.' });
        } else {
          if (prov.citations.length === 0) {
            warnings.push({ field: 'provenance.citations', code: 'NO_CITATIONS', message: 'Profile has no primary citations.' });
          }
          for (let idx = 0; idx < prov.citations.length; idx++) {
            const cit = prov.citations[idx];
            if (!isPlainObject(cit)) {
              errors.push({ field: `provenance.citations[${idx}]`, code: 'INVALID_OBJECT', message: 'Citation must be an object.' });
              continue;
            }
            if (typeof cit.title !== 'string' || !cit.title.trim()) {
              errors.push({ field: `provenance.citations[${idx}].title`, code: 'REQUIRED', message: 'Citation title is required.' });
            }
            if (!isValidHttpUrl(cit.url)) {
              errors.push({
                field: `provenance.citations[${idx}].url`,
                code: 'INVALID_CITATION_URL',
                message: `Citation URL "${cit.url}" must be a valid http(s) URL.`,
              });
            }
            if (cit.pmid !== undefined && cit.pmid !== null) {
              if (typeof cit.pmid !== 'string' && !(typeof cit.pmid === 'number' && Number.isInteger(cit.pmid) && cit.pmid > 0)) {
                errors.push({ field: `provenance.citations[${idx}].pmid`, code: 'INVALID_PMID', message: 'pmid must contain digits only.' });
              } else if (typeof cit.pmid === 'string' && cit.pmid.trim() !== '' && !/^\d+$/.test(cit.pmid.trim())) {
                errors.push({ field: `provenance.citations[${idx}].pmid`, code: 'INVALID_PMID', message: 'pmid must contain digits only.' });
              }
            }
            if (cit.nct !== undefined && cit.nct !== null) {
              if (typeof cit.nct !== 'string') {
                errors.push({ field: `provenance.citations[${idx}].nct`, code: 'INVALID_NCT', message: 'nct must match NCT########.' });
              } else if (cit.nct.trim() !== '' && !/^NCT\d+$/i.test(cit.nct.trim())) {
                errors.push({ field: `provenance.citations[${idx}].nct`, code: 'INVALID_NCT', message: 'nct must match NCT########.' });
              }
            }
          }
        }
      } else {
        warnings.push({ field: 'provenance.citations', code: 'NO_CITATIONS', message: 'Profile has no primary citations.' });
      }
    }
  } else {
    warnings.push({ field: 'provenance.citations', code: 'NO_CITATIONS', message: 'Profile has no primary citations.' });
  }

  // Section-specific data validation
  if (input.sectionData !== undefined && input.sectionData !== null) {
    if (!isPlainObject(input.sectionData)) {
      errors.push({ field: 'sectionData', code: 'INVALID_TYPE', message: 'sectionData must be a plain object.' });
    } else if (resolvedSection) {
      validateSectionSpecificData(resolvedSection.id, input.sectionData, input, errors, warnings);
    }
  }

  // Dynamic customFields validation
  let cfValues = {};
  if (input.customFields !== undefined && input.customFields !== null) {
    if (!isPlainObject(input.customFields)) {
      errors.push({ field: 'customFields', code: 'INVALID_TYPE', message: 'customFields must be a plain object.' });
    } else {
      cfValues = input.customFields;
    }
  }
  const cfDefs = Array.isArray(resolvedSection?.customFields) ? resolvedSection.customFields : [];
  const cfDefKeys = new Set(cfDefs.map((d) => d.key));

  for (const def of cfDefs) {
    const val = Object.hasOwn(cfValues, def.key) ? cfValues[def.key] : undefined;
    const isStringField =
      def.fieldType === 'text' ||
      def.fieldType === 'textarea' ||
      def.fieldType === 'url' ||
      def.fieldType === 'select';
    const isArrayField = def.fieldType === 'multiselect' || def.fieldType === 'list';
    const isOmitted =
      val === undefined ||
      val === null ||
      (isStringField && typeof val === 'string' && val.trim() === '') ||
      (isArrayField &&
        Array.isArray(val) &&
        (val.length === 0 ||
          (def.fieldType === 'list' &&
            [...val].every((item) => typeof item === 'string' && item.trim() === ''))));

    if (isOmitted) {
      if (def.required) {
        errors.push({
          field: `customFields.${def.key}`,
          code: 'REQUIRED_CUSTOM_FIELD',
          message: `Required custom field "${def.label}" (${def.key}) is missing.`,
        });
        missingFields.push(`customFields.${def.key}`);
      }
      continue;
    }

    switch (def.fieldType) {
      case 'text':
      case 'textarea':
        if (typeof val !== 'string') {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be a string.` });
        }
        break;
      case 'number':
        if (!isFiniteNum(val)) {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be a finite number.` });
        }
        break;
      case 'boolean':
        if (typeof val !== 'boolean') {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be a boolean.` });
        }
        break;
      case 'url':
        if (typeof val !== 'string') {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be a string URL.` });
        } else if (!isValidHttpUrl(val)) {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_URL', message: `"${def.key}" must be a valid http(s) URL.` });
        }
        break;
      case 'select':
        if (typeof val !== 'string') {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be a string option.` });
        } else if (!Array.isArray(def.options) || !def.options.includes(val)) {
          errors.push({
            field: `customFields.${def.key}`,
            code: 'INVALID_CUSTOM_FIELD_OPTION',
            message: `"${def.key}" must be one of: ${(def.options || []).join(', ')}.`,
          });
        }
        break;
      case 'multiselect':
        if (!Array.isArray(val)) {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be an array of options.` });
        } else if (!Array.isArray(def.options) || [...val].some((item) => !def.options.includes(item))) {
          errors.push({
            field: `customFields.${def.key}`,
            code: 'INVALID_CUSTOM_FIELD_OPTION',
            message: `"${def.key}" items must be subset of: ${(def.options || []).join(', ')}.`,
          });
        }
        break;
      case 'list':
        if (!Array.isArray(val) || ![...val].every((item) => typeof item === 'string')) {
          errors.push({ field: `customFields.${def.key}`, code: 'INVALID_CUSTOM_FIELD_TYPE', message: `"${def.key}" must be an array of strings.` });
        }
        break;
    }
  }

  for (const key of Object.keys(cfValues)) {
    if (!cfDefKeys.has(key)) {
      warnings.push({
        field: `customFields.${key}`,
        code: 'UNKNOWN_CUSTOM_FIELD',
        message: `Custom field "${key}" is not defined on section "${sectionId}" (preserved).`,
      });
    }
  }

  const normalized = normalizeCompoundProfile(input, { section: resolvedSection, now });
  const completenessPct = computeCompoundCompleteness(normalized, resolvedSection);
  normalized.completenessPct = completenessPct;

  const ok = errors.length === 0;
  return {
    ok,
    valid: ok,
    errors,
    warnings,
    missingFields,
    completenessPct,
    normalized,
  };
}

// ---------------------------------------------------------------------------
// 5. Member, Ownership & Stack Validators + Helpers (F1, F2, F9, F30)
// ---------------------------------------------------------------------------

const MEMBER_ROLE_SET = new Set(MEMBER_ROLES);
const SEX_CONTEXT_SET = new Set(BIOLOGICAL_SEX_CONTEXTS);
const OWNERSHIP_STATUS_SET = new Set(OWNERSHIP_STATUSES);
const MEMBER_SCOPE_RE = /^member:[a-z][a-z0-9_-]{1,47}$/;

export function validateMember(
  input,
  existingMembers = [],
  { isUpdate = false, now = new Date().toISOString() } = {},
) {
  const errors = [];
  if (!isPlainObject(input)) {
    errors.push({ field: 'member', code: 'INVALID_OBJECT', message: 'Member must be an object.' });
    return { ok: false, valid: false, errors, normalized: null };
  }

  if (input.id !== undefined && input.id !== null && typeof input.id !== 'string') {
    errors.push({ field: 'id', code: 'INVALID_TYPE', message: 'Member id must be a string.' });
  }
  if (input.avatarInitial !== undefined && input.avatarInitial !== null && typeof input.avatarInitial !== 'string') {
    errors.push({ field: 'avatarInitial', code: 'INVALID_TYPE', message: 'avatarInitial must be a string.' });
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', code: 'REQUIRED', message: 'Member name is required.' });
  } else if (name.length > 64) {
    errors.push({ field: 'name', code: 'MAX_LENGTH', message: 'Member name must be <= 64 characters.' });
  }

  const rawAutoSlug = slugify(name).replace(/-/g, '_');
  const trimmedAutoSlug = rawAutoSlug ? rawAutoSlug.slice(0, 40).replace(/_+$/, '') : '';
  const id =
    typeof input.id === 'string' && input.id.trim()
      ? input.id.trim().toLowerCase()
      : `member_${trimmedAutoSlug || generateId('m')}`;

  if (!SECTION_SLUG_REGEX.test(id)) {
    errors.push({ field: 'id', code: 'INVALID_ID', message: 'Member id must match /^[a-z][a-z0-9_-]{1,47}$/.' });
  } else if (!isUpdate && Array.isArray(existingMembers) && existingMembers.some((m) => m && m.id === id)) {
    errors.push({ field: 'id', code: 'DUPLICATE_MEMBER', message: `Member id "${id}" already exists.` });
  }

  const role = input.role ?? 'admin';
  if (!MEMBER_ROLE_SET.has(role)) {
    errors.push({ field: 'role', code: 'INVALID_ENUM', message: `role must be one of: ${MEMBER_ROLES.join(', ')}.` });
  }

  if (input.accentColor !== undefined && input.accentColor !== null) {
    if (typeof input.accentColor !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(input.accentColor.trim())) {
      errors.push({ field: 'accentColor', code: 'INVALID_COLOR', message: 'accentColor must be a valid hex color.' });
    }
  }

  const defaultAnchors = deepClone(DEFAULT_ROUTINE_ANCHORS);
  let rawAnchors = {};
  if (input.routineAnchors !== undefined && input.routineAnchors !== null) {
    if (!isPlainObject(input.routineAnchors)) {
      errors.push({ field: 'routineAnchors', code: 'INVALID_TYPE', message: 'routineAnchors must be a plain object.' });
    } else {
      rawAnchors = deepClone(input.routineAnchors);
    }
  }
  const anchors = {
    wake: Object.hasOwn(rawAnchors, 'wake') && rawAnchors.wake !== undefined ? rawAnchors.wake : defaultAnchors.wake,
    breakfast:
      Object.hasOwn(rawAnchors, 'breakfast') && rawAnchors.breakfast !== undefined
        ? rawAnchors.breakfast
        : defaultAnchors.breakfast,
    workout:
      Object.hasOwn(rawAnchors, 'workout') && rawAnchors.workout !== undefined
        ? rawAnchors.workout
        : defaultAnchors.workout,
    workoutDays:
      Object.hasOwn(rawAnchors, 'workoutDays') && rawAnchors.workoutDays !== undefined
        ? rawAnchors.workoutDays
        : defaultAnchors.workoutDays,
    lunch: Object.hasOwn(rawAnchors, 'lunch') && rawAnchors.lunch !== undefined ? rawAnchors.lunch : defaultAnchors.lunch,
    dinner:
      Object.hasOwn(rawAnchors, 'dinner') && rawAnchors.dinner !== undefined ? rawAnchors.dinner : defaultAnchors.dinner,
    bed: Object.hasOwn(rawAnchors, 'bed') && rawAnchors.bed !== undefined ? rawAnchors.bed : defaultAnchors.bed,
    tz: Object.hasOwn(rawAnchors, 'tz') && rawAnchors.tz !== undefined ? rawAnchors.tz : defaultAnchors.tz,
  };
  for (const key of ['wake', 'breakfast', 'workout', 'lunch', 'dinner', 'bed']) {
    if (!isValidTimeHHMM(anchors[key])) {
      errors.push({ field: `routineAnchors.${key}`, code: 'INVALID_TIME', message: `${key} must be valid HH:MM (24-hour).` });
    }
  }
  if (!Array.isArray(anchors.workoutDays) || [...anchors.workoutDays].some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.push({ field: 'routineAnchors.workoutDays', code: 'INVALID_DAYS', message: 'workoutDays must be integers in 0..6.' });
  } else {
    anchors.workoutDays = [...new Set(anchors.workoutDays)].sort((a, b) => a - b);
  }
  if (!isValidTimeZone(anchors.tz)) {
    errors.push({ field: 'routineAnchors.tz', code: 'INVALID_TIMEZONE', message: `Invalid IANA timezone "${anchors.tz}".` });
  } else {
    anchors.tz = anchors.tz.trim();
  }

  const defaultSafety = deepClone(DEFAULT_SAFETY_CONTEXT);
  let rawSafety = {};
  if (input.safetyContext !== undefined && input.safetyContext !== null) {
    if (!isPlainObject(input.safetyContext)) {
      errors.push({ field: 'safetyContext', code: 'INVALID_TYPE', message: 'safetyContext must be a plain object.' });
    } else {
      rawSafety = deepClone(input.safetyContext);
    }
  }
  const safety = {
    pregnancyOrTrying:
      Object.hasOwn(rawSafety, 'pregnancyOrTrying') && rawSafety.pregnancyOrTrying !== undefined
        ? rawSafety.pregnancyOrTrying
        : defaultSafety.pregnancyOrTrying,
    biologicalSexContext:
      Object.hasOwn(rawSafety, 'biologicalSexContext') && rawSafety.biologicalSexContext !== undefined
        ? rawSafety.biologicalSexContext
        : defaultSafety.biologicalSexContext,
    allergies:
      Object.hasOwn(rawSafety, 'allergies') && rawSafety.allergies !== undefined
        ? rawSafety.allergies
        : defaultSafety.allergies,
    activeRxMeds:
      Object.hasOwn(rawSafety, 'activeRxMeds') && rawSafety.activeRxMeds !== undefined
        ? rawSafety.activeRxMeds
        : defaultSafety.activeRxMeds,
    conditions:
      Object.hasOwn(rawSafety, 'conditions') && rawSafety.conditions !== undefined
        ? rawSafety.conditions
        : defaultSafety.conditions,
  };
  if (typeof safety.pregnancyOrTrying !== 'boolean') {
    errors.push({ field: 'safetyContext.pregnancyOrTrying', code: 'INVALID_TYPE', message: 'pregnancyOrTrying must be a boolean.' });
  }
  if (!SEX_CONTEXT_SET.has(safety.biologicalSexContext)) {
    errors.push({
      field: 'safetyContext.biologicalSexContext',
      code: 'INVALID_ENUM',
      message: `biologicalSexContext must be one of: ${BIOLOGICAL_SEX_CONTEXTS.join(', ')}.`,
    });
  }
  for (const arrField of ['allergies', 'activeRxMeds', 'conditions']) {
    if (!Array.isArray(safety[arrField]) || ![...safety[arrField]].every((x) => typeof x === 'string')) {
      errors.push({ field: `safetyContext.${arrField}`, code: 'INVALID_TYPE', message: `${arrField} must be an array of strings.` });
    } else {
      safety[arrField] = safety[arrField].map((x) => x.trim()).filter(Boolean);
    }
  }

  const ok = errors.length === 0;
  const normalized = ok
    ? {
        id,
        name,
        avatarInitial:
          typeof input.avatarInitial === 'string' && input.avatarInitial.trim()
            ? input.avatarInitial.trim().slice(0, 2).toUpperCase()
            : name.slice(0, 1).toUpperCase(),
        accentColor: typeof input.accentColor === 'string' && input.accentColor.trim() ? input.accentColor.trim() : '#5fdc97',
        role,
        routineAnchors: anchors,
        safetyContext: safety,
        createdAt: nonEmptyTimestampOr(input.createdAt, now),
        updatedAt: nonEmptyTimestampOr(input.updatedAt, now),
      }
    : null;

  return { ok, valid: ok, errors, normalized };
}

export function validateOwnershipRecord(
  input,
  { compoundsById = null, membersById = null, now = new Date().toISOString() } = {},
) {
  const errors = [];
  if (!isPlainObject(input)) {
    errors.push({ field: 'ownership', code: 'INVALID_OBJECT', message: 'Ownership record must be an object.' });
    return { ok: false, valid: false, errors, normalized: null };
  }

  if (input.id !== undefined && input.id !== null && typeof input.id !== 'string') {
    errors.push({ field: 'id', code: 'INVALID_TYPE', message: 'id must be a string.' });
  }

  const compoundId = typeof input.compoundId === 'string' ? input.compoundId.trim() : '';
  if (!compoundId) {
    errors.push({ field: 'compoundId', code: 'REQUIRED', message: 'compoundId is required.' });
  } else if (compoundsById) {
    const exists = hasLookupEntry(compoundsById, compoundId);
    if (!exists) {
      errors.push({ field: 'compoundId', code: 'NOT_FOUND', message: `Unknown compoundId "${compoundId}".` });
    }
  }

  let scope = 'household';
  let scopeTypeError = false;
  if (input.scope !== undefined && input.scope !== null) {
    if (typeof input.scope !== 'string') {
      errors.push({ field: 'scope', code: 'INVALID_TYPE', message: 'scope must be a string.' });
      scopeTypeError = true;
    } else if (input.scope.trim()) {
      scope = input.scope.trim();
    }
  }
  if (!scopeTypeError && scope !== 'household') {
    if (!MEMBER_SCOPE_RE.test(scope)) {
      errors.push({ field: 'scope', code: 'INVALID_SCOPE', message: 'scope must be "household" or "member:<memberId>".' });
    } else if (membersById) {
      const mId = scope.slice('member:'.length);
      const exists = hasLookupEntry(membersById, mId);
      if (!exists) {
        errors.push({ field: 'scope', code: 'MEMBER_NOT_FOUND', message: `Unknown member "${mId}" in scope.` });
      }
    }
  }

  const status = typeof input.status === 'string' ? input.status.trim() : '';
  if (!OWNERSHIP_STATUS_SET.has(status)) {
    errors.push({ field: 'status', code: 'INVALID_STATUS', message: `status must be one of: ${OWNERSHIP_STATUSES.join(', ')}.` });
  }

  if (input.quantity !== undefined && input.quantity !== null && !(isFiniteNum(input.quantity) && input.quantity >= 0)) {
    errors.push({ field: 'quantity', code: 'INVALID_NUMBER', message: 'quantity must be a non-negative finite number.' });
  }
  if (input.remainingDoses !== undefined && input.remainingDoses !== null && !(isFiniteNum(input.remainingDoses) && input.remainingDoses >= 0)) {
    errors.push({ field: 'remainingDoses', code: 'INVALID_NUMBER', message: 'remainingDoses must be a non-negative finite number.' });
  }
  for (const strField of ['unit', 'vendor', 'notes']) {
    if (input[strField] !== undefined && input[strField] !== null && typeof input[strField] !== 'string') {
      errors.push({
        field: strField,
        code: 'INVALID_TYPE',
        message: `${strField} must be a string.`,
      });
    }
  }
  for (const dateField of ['expiryDate', 'openedAt']) {
    const rawDate = input[dateField];
    if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
      if (typeof rawDate !== 'string') {
        errors.push({ field: dateField, code: 'INVALID_TYPE', message: `${dateField} must be a string (YYYY-MM-DD).` });
      } else if (!isValidIsoDate(rawDate)) {
        errors.push({ field: dateField, code: 'INVALID_DATE', message: `${dateField} must be valid YYYY-MM-DD.` });
      }
    }
  }

  if (input.reconstitution !== undefined && input.reconstitution !== null) {
    const r = input.reconstitution;
    if (!isPlainObject(r)) {
      errors.push({ field: 'reconstitution', code: 'INVALID_TYPE', message: 'reconstitution must be an object.' });
    } else {
      for (const k of ['vialMg', 'vialIU', 'diluentMl']) {
        if (r[k] !== undefined && r[k] !== null && !(isFiniteNum(r[k]) && r[k] > 0)) {
          errors.push({ field: `reconstitution.${k}`, code: 'INVALID_NUMBER', message: `reconstitution.${k} must be > 0.` });
        }
      }
      if (r.solvent !== undefined && r.solvent !== null && !PEPTIDE_SOLVENT_SET.has(r.solvent)) {
        errors.push({ field: 'reconstitution.solvent', code: 'INVALID_SOLVENT', message: `solvent must be one of: ${PEPTIDE_SOLVENTS.join(', ')}.` });
      }
    }
  }

  const ok = errors.length === 0;
  const normalized = ok
    ? {
        id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `own_${compoundId}_${scope.replace(':', '_')}`,
        compoundId,
        scope,
        status,
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.unit !== undefined ? { unit: input.unit === null ? null : input.unit.trim() } : {}),
        ...(input.vendor !== undefined ? { vendor: input.vendor === null ? null : input.vendor.trim() } : {}),
        ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
        ...(input.openedAt !== undefined ? { openedAt: input.openedAt } : {}),
        ...(input.remainingDoses !== undefined ? { remainingDoses: input.remainingDoses } : {}),
        ...(input.reconstitution !== undefined ? { reconstitution: deepClone(input.reconstitution) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes === null ? null : input.notes.trim() } : {}),
        updatedAt: nonEmptyTimestampOr(input.updatedAt, now),
      }
    : null;

  return { ok, valid: ok, errors, normalized };
}

const OWNERSHIP_AVAILABILITY_RANK = Object.freeze(
  Object.assign(Object.create(null), {
    have: 5,
    low_stock: 4,
    ordered: 3,
    wishlist: 2,
    dont_have: 1,
  }),
);

function ownershipRankOf(status) {
  return typeof status === 'string' && Object.hasOwn(OWNERSHIP_AVAILABILITY_RANK, status)
    ? OWNERSHIP_AVAILABILITY_RANK[status]
    : 0;
}

function pickBestOwnershipRecord(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let best = candidates[0];
  let bestRank = ownershipRankOf(best.status);
  let bestTs = typeof best.updatedAt === 'string' ? Date.parse(best.updatedAt) : NaN;

  for (let i = 1; i < candidates.length; i++) {
    const cur = candidates[i];
    const curRank = ownershipRankOf(cur.status);
    const curTs = typeof cur.updatedAt === 'string' ? Date.parse(cur.updatedAt) : NaN;
    if (curRank > bestRank) {
      best = cur;
      bestRank = curRank;
      bestTs = curTs;
    } else if (curRank === bestRank) {
      const curValid = Number.isFinite(curTs);
      const bestValid = Number.isFinite(bestTs);
      if ((curValid && !bestValid) || (curValid && bestValid && curTs > bestTs)) {
        best = cur;
        bestRank = curRank;
        bestTs = curTs;
      }
    }
  }
  return best;
}

/**
 * Resolve effective ownership status for `(compoundId, memberId)`:
 * Personal record (`member:<memberId>`) takes precedence over shared (`household`),
 * selecting the highest-availability record within each scope (`have` > `low_stock` >
 * `ordered` > `wishlist` > `dont_have`, tie-breaking by newest `updatedAt`),
 * falling back to `dont_have`. Surfaces partner records separately without granting deduction rights.
 */
export function resolveEffectiveOwnership(compoundId, memberId, ownershipRecords = []) {
  if (typeof compoundId !== 'string' || !compoundId.trim()) {
    return {
      status: 'dont_have',
      scope: 'none',
      record: null,
      personalRecord: null,
      householdRecord: null,
      otherMemberRecords: [],
    };
  }
  const records = (Array.isArray(ownershipRecords) ? ownershipRecords : []).filter(
    (r) => isPlainObject(r) && r.compoundId === compoundId,
  );
  const personalScope = typeof memberId === 'string' && memberId.trim() ? `member:${memberId.trim()}` : null;
  const personalRecord = personalScope
    ? pickBestOwnershipRecord(records.filter((r) => r.scope === personalScope))
    : null;
  const householdRecord = pickBestOwnershipRecord(records.filter((r) => r.scope === 'household'));
  const otherMemberRecords = records.filter(
    (r) => r.scope !== 'household' && r.scope !== personalScope,
  );

  if (personalRecord) {
    return {
      status: personalRecord.status,
      scope: personalRecord.scope,
      record: personalRecord,
      personalRecord,
      householdRecord,
      otherMemberRecords,
    };
  }
  if (householdRecord) {
    return {
      status: householdRecord.status,
      scope: 'household',
      record: householdRecord,
      personalRecord: null,
      householdRecord,
      otherMemberRecords,
    };
  }
  return {
    status: 'dont_have',
    scope: 'none',
    record: null,
    personalRecord: null,
    householdRecord: null,
    otherMemberRecords,
  };
}

/**
 * Pure ownership stock deduction: clamps remainingDoses at 0 and auto-transitions
 * status to `dont_have` (0) or `low_stock` (<= LOW_STOCK_DOSE_THRESHOLD).
 */
export function deductOwnershipDose(record, doses = 1, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(record)) {
    return { ok: false, errors: [{ field: 'record', code: 'INVALID_OBJECT', message: 'Ownership record is required.' }] };
  }
  if (!isFiniteNum(doses) || doses <= 0) {
    return { ok: false, errors: [{ field: 'doses', code: 'INVALID_DOSES', message: 'doses must be a finite number > 0.' }] };
  }

  const next = deepClone(record);
  if (next.remainingDoses === null || next.remainingDoses === undefined) {
    return { ok: true, record: next };
  }
  if (!isFiniteNum(next.remainingDoses) || next.remainingDoses < 0) {
    return {
      ok: false,
      errors: [{ field: 'remainingDoses', code: 'INVALID_NUMBER', message: 'record.remainingDoses must be a non-negative finite number.' }],
    };
  }

  const rawRem = next.remainingDoses - doses;
  const remaining = rawRem <= 1e-12 ? 0 : rawRem;
  next.remainingDoses = remaining;
  if (remaining === 0) {
    next.status = 'dont_have';
  } else if (remaining <= LOW_STOCK_DOSE_THRESHOLD) {
    next.status = 'low_stock';
  }
  next.updatedAt = now;

  return { ok: true, record: next };
}

export function validateStack(input, { membersById = null, compoundsById = null, now = new Date().toISOString() } = {}) {
  const errors = [];
  if (!isPlainObject(input)) {
    errors.push({ field: 'stack', code: 'INVALID_OBJECT', message: 'Stack must be an object.' });
    return { ok: false, valid: false, errors, normalized: null };
  }

  if (input.id !== undefined && input.id !== null && typeof input.id !== 'string') {
    errors.push({ field: 'id', code: 'INVALID_TYPE', message: 'Stack id must be a string.' });
  }
  if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
    errors.push({ field: 'description', code: 'INVALID_TYPE', message: 'Stack description must be a string.' });
  }

  const memberId = typeof input.memberId === 'string' ? input.memberId.trim() : '';
  if (!memberId) {
    errors.push({ field: 'memberId', code: 'REQUIRED', message: 'memberId is required for strict per-member stack isolation.' });
  } else if (membersById) {
    const exists = hasLookupEntry(membersById, memberId);
    if (!exists) {
      errors.push({ field: 'memberId', code: 'MEMBER_NOT_FOUND', message: `Unknown memberId "${memberId}".` });
    }
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    errors.push({ field: 'name', code: 'REQUIRED', message: 'Stack name is required.' });
  }

  const items = Array.isArray(input.items) ? input.items : [];
  if (input.items !== undefined && !Array.isArray(input.items)) {
    errors.push({ field: 'items', code: 'INVALID_TYPE', message: 'stack.items must be an array.' });
  } else {
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!isPlainObject(item)) {
        errors.push({ field: `items[${idx}]`, code: 'INVALID_OBJECT', message: 'Stack item must be an object.' });
        continue;
      }
      if (typeof item.compoundId !== 'string' || !item.compoundId.trim()) {
        errors.push({ field: `items[${idx}].compoundId`, code: 'REQUIRED', message: 'Stack item compoundId is required.' });
      } else if (compoundsById) {
        const exists = hasLookupEntry(compoundsById, item.compoundId.trim());
        if (!exists) {
          errors.push({ field: `items[${idx}].compoundId`, code: 'COMPOUND_NOT_FOUND', message: `Unknown compoundId "${item.compoundId}".` });
        }
      }
      if (item.pinnedSlot !== undefined && item.pinnedSlot !== null && item.pinnedSlot !== '' && !ALL_SLOT_SET.has(item.pinnedSlot)) {
        errors.push({ field: `items[${idx}].pinnedSlot`, code: 'INVALID_SLOT', message: `Unknown pinnedSlot "${item.pinnedSlot}".` });
      }
    }
  }

  const ok = errors.length === 0;
  const normalized = ok
    ? {
        id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : generateId('stk'),
        memberId,
        name,
        description: typeof input.description === 'string' ? input.description.trim() : '',
        active: input.active !== false,
        onlyOwned: Boolean(input.onlyOwned),
        items: deepClone(items),
        createdAt: nonEmptyTimestampOr(input.createdAt, now),
        updatedAt: nonEmptyTimestampOr(input.updatedAt, now),
      }
    : null;

  return { ok, valid: ok, errors, normalized };
}

export function validateHubState(state) {
  const errors = [];
  if (!isPlainObject(state)) {
    errors.push({ field: 'state', code: 'INVALID_OBJECT', message: 'Hub state must be an object.' });
    return { ok: false, valid: false, errors };
  }

  if (!Array.isArray(state.members) || state.members.length === 0) {
    errors.push({ field: 'members', code: 'REQUIRED', message: 'Hub state requires at least one household member.' });
  } else {
    const seen = [];
    for (const m of state.members) {
      const res = validateMember(m, seen);
      if (!res.ok) errors.push(...res.errors);
      else seen.push(res.normalized);
    }
  }

  if (!Array.isArray(state.sections)) {
    errors.push({ field: 'sections', code: 'REQUIRED', message: 'sections must be an array.' });
  } else {
    const seenSecIds = new Set();
    for (const sec of state.sections) {
      const res = validateSection(sec);
      if (!res.ok) errors.push(...res.errors);
      const secId = typeof sec?.id === 'string' ? sec.id.trim() : '';
      if (secId) {
        if (seenSecIds.has(secId)) {
          errors.push({ field: 'sections', code: 'DUPLICATE_SECTION', message: `Duplicate section id "${secId}".` });
        } else {
          seenSecIds.add(secId);
        }
      }
    }
    for (const coreId of CORE_SECTION_IDS) {
      if (!seenSecIds.has(coreId)) {
        errors.push({ field: 'sections', code: 'MISSING_CORE_SECTION', message: `Core section "${coreId}" is missing.` });
      }
    }
  }

  const membersById = new Map();
  if (Array.isArray(state.members)) {
    for (const m of state.members) {
      if (isPlainObject(m) && typeof m.id === 'string' && m.id.trim()) {
        membersById.set(m.id.trim(), m);
      }
    }
  }

  if (Array.isArray(state.compounds)) {
    for (const c of state.compounds) {
      const res = validateCompoundProfile(c, { sections: state.sections });
      if (!res.ok) errors.push(...res.errors);
    }
  } else {
    errors.push({ field: 'compounds', code: 'INVALID_TYPE', message: 'compounds must be an array.' });
  }

  if (Array.isArray(state.ownership)) {
    for (const o of state.ownership) {
      const res = validateOwnershipRecord(o, { membersById });
      if (!res.ok) errors.push(...res.errors);
    }
  } else {
    errors.push({ field: 'ownership', code: 'INVALID_TYPE', message: 'ownership must be an array.' });
  }

  if (Array.isArray(state.stacks)) {
    for (const s of state.stacks) {
      const res = validateStack(s, { membersById });
      if (!res.ok) errors.push(...res.errors);
    }
  } else {
    errors.push({ field: 'stacks', code: 'INVALID_TYPE', message: 'stacks must be an array.' });
  }

  const ok = errors.length === 0;
  return { ok, valid: ok, errors };
}
