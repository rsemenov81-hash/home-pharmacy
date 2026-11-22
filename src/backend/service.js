/**
 * Canonical Home Pharmacy Business Logic Service (`src/backend/service.js`).
 * Shared across REST API v1, Universal Remote Streamable HTTP MCP, and Sync/Export routes.
 * Pure Web Standards (no Node-only dependencies — runs identically on Node 22 & Cloudflare Workers).
 */

import {
  API_TOKEN_SCOPES,
  CORE_SECTION_ID_SET,
  DEFAULT_HOUSEHOLD_SETTINGS,
  HUB_VERSION,
  LOW_STOCK_DOSE_THRESHOLD,
  OWNERSHIP_STATUSES,
  buildContextBundle,
  checkDuplicateCompound,
  createCustomSection,
  deepClone,
  deleteSection as coreDeleteSection,
  dkToday,
  dkValid,
  evaluateAdvisoryDose,
  exportCompoundsCsv,
  exportHubJson,
  generateId,
  getSectionSchemaDescriptor,
  importHubJson,
  importProtocolOsExport,
  isValidHttpUrl,
  linkRelatedCompounds,
  mergeStates,
  normName,
  normRoute,
  parseFiniteNumber,
  resolveEffectiveOwnership,
  seedStarterCatalog,
  slugify,
  stripSecrets,
  updateSectionConfig,
  validateCompoundProfile,
  validateCustomFieldDef,
  validateHubExport,
  validateMember,
  validateOwnershipRecord,
  validateProtocolOsExport,
  validateStack,
} from '../core/index.js';
import {
  analyzeStackInteractions,
  suggestStackSchedule,
} from '../scheduler/index.js';
import {
  normalizeAiActorName,
  randomToken,
  sha256Hex,
} from './auth.js';

export class HubError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const storageWriteQueues = new WeakMap();

const BYOK_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
  'LLM_API_KEY',
  'BYOK_API_KEY',
  'BYOK_LLM_API_KEY',
  'AI_API_KEY',
  'MUSE_API_KEY',
];

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function deepMergePlain(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return deepClone(patch);
  const out = deepClone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMergePlain(out[k], v);
    } else {
      out[k] = deepClone(v);
    }
  }
  return out;
}

function isEmptyFieldValue(val) {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string') return val.trim() === '';
  if (Array.isArray(val)) return val.length === 0;
  if (isPlainObject(val)) return Object.values(val).every(isEmptyFieldValue);
  return false;
}

function detectVerifiedOverwrites(existing, patch) {
  const conflicts = [];
  const check = (cur, next, pathPrefix = '') => {
    if (!isPlainObject(next)) return;
    for (const [k, v] of Object.entries(next)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (k === 'updatedAt' || k === 'createdAt' || k === 'id' || k === 'provenance') continue;
      if (v === undefined) continue;
      const curVal = cur?.[k];
      const fieldPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (isPlainObject(v) && isPlainObject(curVal)) {
        check(curVal, v, fieldPath);
      } else if (!isEmptyFieldValue(curVal) && JSON.stringify(curVal) !== JSON.stringify(v)) {
        conflicts.push({ field: fieldPath, before: deepClone(curVal), after: deepClone(v) });
      }
    }
  };
  check(existing, patch);
  return conflicts;
}

function buildDiff(existing, patch) {
  const diff = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    diff[k] = {
      before: existing ? deepClone(existing[k]) : undefined,
      after: deepClone(v),
    };
  }
  return diff;
}

function mapCompoundsById(compounds) {
  return new Map((compounds || []).map((c) => [c.id, c]));
}

function mapMembersById(members) {
  return new Map((members || []).map((m) => [m.id, m]));
}

export function createHubService({ storage, env = {} }) {
  async function loadState() {
    const state = await storage.getHubState();
    state._rev = Number.isInteger(state._rev) && state._rev >= 0 ? state._rev : 0;
    state.members = Array.isArray(state.members) ? state.members : [];
    state.sections = Array.isArray(state.sections) ? state.sections : [];
    state.compounds = Array.isArray(state.compounds) ? state.compounds : [];
    state.ownership = Array.isArray(state.ownership) ? state.ownership : [];
    state.stacks = Array.isArray(state.stacks) ? state.stacks : [];
    state.logs = Array.isArray(state.logs) ? state.logs : [];
    state.proposals = Array.isArray(state.proposals) ? state.proposals : [];
    state.auditLog = Array.isArray(state.auditLog) ? state.auditLog : [];
    state.meta = isPlainObject(state.meta) ? state.meta : {};
    state.meta.tombstones = isPlainObject(state.meta.tombstones) ? state.meta.tombstones : {};
    state.tombstones = state.meta.tombstones;
    state.settings = {
      ...deepClone(DEFAULT_HOUSEHOLD_SETTINGS),
      ...(isPlainObject(state.settings) ? state.settings : {}),
      aiWritePolicy: {
        ...deepClone(DEFAULT_HOUSEHOLD_SETTINGS.aiWritePolicy),
        ...(isPlainObject(state.settings?.aiWritePolicy) ? state.settings.aiWritePolicy : {}),
      },
    };
    return state;
  }

  function appendAudit(state, { actor = 'member:admin', action, targetType, targetId = null, changedFields = [], summary = '' }) {
    state.auditLog.push({
      id: generateId('aud'),
      timestamp: new Date().toISOString(),
      actor: actor || 'member:admin',
      action,
      targetType,
      targetId,
      changedFields,
      summary,
    });
    if (state.auditLog.length > 1000) {
      state.auditLog = state.auditLog.slice(-1000);
    }
  }

  function recordTombstone(state, collection, id, nowIso = new Date().toISOString()) {
    if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    if (!state.meta.tombstones || typeof state.meta.tombstones !== 'object') state.meta.tombstones = {};
    if (!state.meta.tombstones[collection] || typeof state.meta.tombstones[collection] !== 'object') {
      state.meta.tombstones[collection] = {};
    }
    state.meta.tombstones[collection][id] = nowIso;
    state.tombstones = state.meta.tombstones;
  }

  async function persistMutation(state, { skipSnapshot = false } = {}) {
    state._rev = (Number.isInteger(state._rev) ? state._rev : 0) + 1;
    state.updatedAt = new Date().toISOString();
    const saved = await storage.saveHubState(state);
    if (!skipSnapshot) {
      const todayKey = dkToday('UTC');
      await storage.saveSnapshot(todayKey, saved);
    }
    return saved;
  }

  function requireMember(state, memberId) {
    const m = state.members.find((x) => x.id === memberId);
    if (!m) {
      throw new HubError(404, 'MEMBER_NOT_FOUND', `Household member "${memberId}" not found.`);
    }
    return m;
  }

  function requireSection(state, sectionId) {
    const s = state.sections.find((x) => x.id === sectionId);
    if (!s) {
      throw new HubError(404, 'SECTION_NOT_FOUND', `Section "${sectionId}" not found.`);
    }
    return s;
  }

  function requireCompound(state, compoundId) {
    const c = state.compounds.find((x) => x.id === compoundId || x.slug === compoundId);
    if (!c) {
      throw new HubError(404, 'COMPOUND_NOT_FOUND', `Compound "${compoundId}" not found.`);
    }
    return c;
  }

  // -------------------------------------------------------------------------
  // Household & Settings
  // -------------------------------------------------------------------------

  async function getHousehold() {
    const state = await loadState();
    const countsBySec = new Map();
    for (const c of state.compounds) {
      countsBySec.set(c.sectionId, (countsBySec.get(c.sectionId) || 0) + 1);
    }
    return {
      version: HUB_VERSION,
      rev: state._rev,
      _rev: state._rev,
      settings: state.settings,
      members: state.members,
      sections: state.sections.map((s) => ({
        id: s.id,
        name: s.name,
        isCore: Boolean(s.isCore),
        compoundCount: countsBySec.get(s.id) || 0,
      })),
      sectionCount: state.sections.length,
      compoundCount: state.compounds.length,
      pendingProposalCount: state.proposals.filter((p) => p.status === 'pending').length,
      updatedAt: state.updatedAt,
    };
  }

  async function updateHouseholdSettings(patch, auth) {
    if (!isPlainObject(patch)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Settings patch must be an object.');
    }
    const state = await loadState();
    const nextSettings = deepMergePlain(state.settings, patch);

    // Validate aiWritePolicy enums if supplied
    const pol = nextSettings.aiWritePolicy || {};
    if (
      pol.newCompoundMode &&
      !['auto_publish_ai_draft', 'hold_in_inbox'].includes(pol.newCompoundMode)
    ) {
      throw new HubError(422, 'INVALID_POLICY', `Invalid newCompoundMode "${pol.newCompoundMode}".`);
    }
    if (
      pol.verifiedEditMode &&
      !['always_propose', 'allow_blank_fill'].includes(pol.verifiedEditMode)
    ) {
      throw new HubError(422, 'INVALID_POLICY', `Invalid verifiedEditMode "${pol.verifiedEditMode}".`);
    }

    state.settings = nextSettings;
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'update_household_settings',
      targetType: 'household',
      changedFields: Object.keys(patch),
      summary: 'Updated household settings',
    });
    await persistMutation(state);
    return { settings: state.settings, _rev: state._rev };
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  async function listMembers() {
    const state = await loadState();
    return state.members;
  }

  async function createMember(input, auth) {
    const state = await loadState();
    const res = validateMember(input, { existingMembers: state.members });
    if (!res.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', res.errors[0]?.message || 'Invalid member payload.', {
        errors: res.errors,
      });
    }
    if (state.members.some((m) => m.id === res.normalized.id)) {
      throw new HubError(409, 'DUPLICATE_MEMBER', `Member id "${res.normalized.id}" already exists.`);
    }
    state.members.push(res.normalized);
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'create_member',
      targetType: 'member',
      targetId: res.normalized.id,
      summary: `Added household member "${res.normalized.name}"`,
    });
    await persistMutation(state);
    return res.normalized;
  }

  async function updateMember(memberId, patch, auth) {
    if (!isPlainObject(patch)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Member patch must be an object.');
    }
    const state = await loadState();
    const idx = state.members.findIndex((m) => m.id === memberId);
    if (idx === -1) {
      throw new HubError(404, 'MEMBER_NOT_FOUND', `Member "${memberId}" not found.`);
    }
    if (patch.id !== undefined && patch.id !== memberId) {
      throw new HubError(400, 'IMMUTABLE_ID', 'Member id cannot be changed.');
    }
    const merged = deepMergePlain(state.members[idx], patch);
    merged.id = memberId;
    const res = validateMember(merged, {
      existingMembers: state.members.filter((m) => m.id !== memberId),
    });
    if (!res.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', res.errors[0]?.message || 'Invalid member update.', {
        errors: res.errors,
      });
    }
    res.normalized.createdAt = state.members[idx].createdAt;
    res.normalized.updatedAt = new Date().toISOString();
    state.members[idx] = res.normalized;
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'update_member',
      targetType: 'member',
      targetId: memberId,
      changedFields: Object.keys(patch),
      summary: `Updated member "${res.normalized.name}"`,
    });
    await persistMutation(state);
    return res.normalized;
  }

  async function deleteMember(memberId, auth) {
    const state = await loadState();
    const idx = state.members.findIndex((m) => m.id === memberId);
    if (idx === -1) {
      throw new HubError(404, 'MEMBER_NOT_FOUND', `Member "${memberId}" not found.`);
    }
    if (state.members.length <= 1) {
      throw new HubError(409, 'CANNOT_DELETE_LAST_MEMBER', 'Household must retain at least one member.');
    }
    const [removed] = state.members.splice(idx, 1);
    const nowIso = new Date().toISOString();
    recordTombstone(state, 'members', memberId, nowIso);
    // Clean up member-scoped stacks, logs, ownership
    state.stacks = state.stacks.filter((s) => s.memberId !== memberId);
    state.logs = state.logs.filter((l) => l.memberId !== memberId);
    state.ownership = state.ownership.filter((o) => o.scope !== `member:${memberId}`);
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'delete_member',
      targetType: 'member',
      targetId: memberId,
      summary: `Removed member "${removed.name}"`,
    });
    await persistMutation(state);
    return { deleted: true, id: memberId };
  }

  // -------------------------------------------------------------------------
  // Sections & Dynamic Schema Customization
  // -------------------------------------------------------------------------

  async function listSections() {
    const state = await loadState();
    return state.sections;
  }

  async function getSection(sectionId) {
    const state = await loadState();
    const section = requireSection(state, sectionId);
    return {
      ...section,
      schema: getSectionSchemaDescriptor(section),
    };
  }

  async function createSection(input, auth) {
    const state = await loadState();
    const res = createCustomSection(state.sections, input);
    if (!res.ok) {
      const hasDup = res.errors.some((e) => e.code === 'DUPLICATE_SECTION' || e.code === 'SECTION_EXISTS');
      throw new HubError(hasDup ? 409 : 422, hasDup ? 'DUPLICATE_SECTION' : 'VALIDATION_ERROR', res.errors[0]?.message || 'Invalid section.', {
        errors: res.errors,
      });
    }
    state.sections = res.sections;
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'create_section',
      targetType: 'section',
      targetId: res.section.id,
      summary: `Created custom section "${res.section.name}"`,
    });
    await persistMutation(state);
    return res.section;
  }

  async function updateSection(sectionId, patch, auth) {
    if (!isPlainObject(patch)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Section patch must be an object.');
    }
    const state = await loadState();
    const idx = state.sections.findIndex((s) => s.id === sectionId);
    if (idx === -1) {
      throw new HubError(404, 'SECTION_NOT_FOUND', `Section "${sectionId}" not found.`);
    }

    const current = state.sections[idx];
    const nowIso = new Date().toISOString();

    // Base metadata update (name, description, icon, accentColor, aiResearchPrompt, subsections, hiddenOptionalFields)
    const baseRes = updateSectionConfig(current, patch, { now: nowIso });
    if (!baseRes.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', baseRes.errors[0]?.message || 'Invalid section update.', {
        errors: baseRes.errors,
      });
    }
    const nextSection = baseRes.section;

    // Handle full customFields replacement with non-destructive archival & restoration!
    if (patch.customFields !== undefined) {
      if (!Array.isArray(patch.customFields)) {
        throw new HubError(422, 'INVALID_CUSTOM_FIELDS', 'customFields must be an array.');
      }
      const validatedFields = [];
      for (const def of patch.customFields) {
        const vr = validateCustomFieldDef(def, validatedFields);
        if (!vr.ok) {
          throw new HubError(422, 'INVALID_CUSTOM_FIELD', vr.errors[0]?.message || 'Invalid custom field definition.', {
            errors: vr.errors,
          });
        }
        validatedFields.push(vr.normalized);
      }

      const oldKeys = new Set((current.customFields || []).map((f) => f.key));
      const newKeys = new Set(validatedFields.map((f) => f.key));

      const removedKeys = [...oldKeys].filter((k) => !newKeys.has(k));
      const addedKeys = [...newKeys].filter((k) => !oldKeys.has(k));

      // Non-destructively archive removed keys & restore re-added keys on section compounds
      if (removedKeys.length > 0 || addedKeys.length > 0) {
        for (const cmp of state.compounds) {
          if (cmp.sectionId !== sectionId) continue;
          if (!isPlainObject(cmp.customFields)) cmp.customFields = {};
          if (!isPlainObject(cmp.archivedCustomFields)) cmp.archivedCustomFields = {};

          for (const rk of removedKeys) {
            if (Object.hasOwn(cmp.customFields, rk)) {
              cmp.archivedCustomFields[rk] = deepClone(cmp.customFields[rk]);
              delete cmp.customFields[rk];
              cmp.updatedAt = nowIso;
            }
          }
          for (const ak of addedKeys) {
            if (!Object.hasOwn(cmp.customFields, ak) && Object.hasOwn(cmp.archivedCustomFields, ak)) {
              cmp.customFields[ak] = deepClone(cmp.archivedCustomFields[ak]);
              cmp.updatedAt = nowIso;
            }
          }
        }
      }
      nextSection.customFields = validatedFields;
      nextSection.updatedAt = nowIso;
    }

    state.sections[idx] = nextSection;
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'configure_section',
      targetType: 'section',
      targetId: sectionId,
      changedFields: Object.keys(patch),
      summary: `Configured section "${nextSection.name}"`,
    });
    await persistMutation(state);
    return nextSection;
  }

  async function deleteSection(sectionId, auth) {
    const state = await loadState();
    const sec = state.sections.find((s) => s.id === sectionId);
    if (!sec) {
      throw new HubError(404, 'SECTION_NOT_FOUND', `Section "${sectionId}" not found.`);
    }
    if (sec.isCore || CORE_SECTION_ID_SET.has(sectionId)) {
      throw new HubError(400, 'CORE_SECTION_PROTECTED', `Core section "${sectionId}" cannot be deleted.`);
    }
    const res = coreDeleteSection(state.sections, sectionId, { compounds: state.compounds });
    if (!res.ok) {
      const code = res.errors[0]?.code || 'CANNOT_DELETE_SECTION';
      const status = code === 'SECTION_NOT_EMPTY' ? 409 : 400;
      throw new HubError(status, code, res.errors[0]?.message || 'Cannot delete section.', {
        errors: res.errors,
      });
    }
    state.sections = res.sections;
    recordTombstone(state, 'sections', sectionId);
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'delete_section',
      targetType: 'section',
      targetId: sectionId,
      summary: `Deleted custom section "${sec.name}"`,
    });
    await persistMutation(state);
    return { deleted: true, id: sectionId };
  }

  // -------------------------------------------------------------------------
  // Compounds, Duplicate Detection, Search/Filtering & Verification
  // -------------------------------------------------------------------------

  async function listCompounds(query = {}) {
    const state = await loadState();
    let results = [...state.compounds];

    const section = typeof query.section === 'string' && query.section.trim() ? query.section.trim() : null;
    if (section) {
      results = results.filter((c) => c.sectionId === section);
    }

    const status = typeof query.status === 'string' && query.status.trim() ? query.status.trim() : null;
    if (status) {
      results = results.filter((c) => c.profileStatus === status);
    }

    const evidenceTier = typeof query.evidenceTier === 'string' && query.evidenceTier.trim() ? query.evidenceTier.trim() : null;
    if (evidenceTier) {
      results = results.filter((c) => c.provenance?.evidenceTier === evidenceTier);
    }

    const route = typeof query.route === 'string' && query.route.trim() ? normRoute(query.route.trim()) : null;
    if (route) {
      results = results.filter((c) => normRoute(c.dosages?.route || '') === route);
    }

    const slot = typeof query.slot === 'string' && query.slot.trim() ? query.slot.trim() : null;
    if (slot) {
      results = results.filter((c) => (c.timingRules?.preferredSlots || []).includes(slot));
    }

    const tag = typeof query.tag === 'string' && query.tag.trim() ? query.tag.trim().toLowerCase() : null;
    if (tag) {
      results = results.filter((c) =>
        (c.tags || []).some((t) => String(t).toLowerCase() === tag),
      );
    }

    const memberId = typeof query.member === 'string' && query.member.trim() ? query.member.trim() : null;
    const ownershipFilter = typeof query.ownership === 'string' && query.ownership.trim() ? query.ownership.trim() : null;
    if (ownershipFilter) {
      results = results.filter((c) => {
        if (memberId) {
          const eff = resolveEffectiveOwnership(c.id, memberId, state.ownership);
          const effStatus = eff?.status || 'dont_have';
          if (effStatus === ownershipFilter) return true;
          if (
            ownershipFilter === 'low_stock' &&
            eff &&
            typeof eff.remainingDoses === 'number' &&
            eff.remainingDoses <= LOW_STOCK_DOSE_THRESHOLD &&
            (effStatus === 'have' || effStatus === 'low_stock')
          ) {
            return true;
          }
          return false;
        }
        // Check any matching ownership record across scopes (or default dont_have if none)
        const recs = state.ownership.filter((o) => o.compoundId === c.id);
        if (recs.length === 0) return ownershipFilter === 'dont_have';
        return recs.some((r) => {
          if (r.status === ownershipFilter) return true;
          if (
            ownershipFilter === 'low_stock' &&
            typeof r.remainingDoses === 'number' &&
            r.remainingDoses <= LOW_STOCK_DOSE_THRESHOLD &&
            (r.status === 'have' || r.status === 'low_stock')
          ) {
            return true;
          }
          return false;
        });
      });
    }

    const inStack = query.inStack === 'true' || query.inStack === true || (typeof query.inStack === 'string' && query.inStack.trim() && query.inStack !== 'false');
    if (inStack) {
      const stackTargetId = typeof query.inStack === 'string' && query.inStack !== 'true' ? query.inStack.trim() : null;
      const relevantStacks = state.stacks.filter((st) => {
        if (stackTargetId && st.id !== stackTargetId) return false;
        if (memberId && st.memberId !== memberId) return false;
        return true;
      });
      const inStackIds = new Set(relevantStacks.flatMap((st) => (st.items || []).map((i) => i.compoundId)));
      results = results.filter((c) => inStackIds.has(c.id));
    }

    const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    if (q) {
      results = results.filter((c) => {
        const hayParts = [
          c.name,
          c.slug,
          c.canonicalMolecule,
          c.subsection,
          c.summary,
          c.detailedDescription,
          c.mechanismOfAction,
          c.notes,
          c.storageNotes,
          ...(c.aliases || []),
          ...(c.useCaseScenarios || []),
          ...(c.benefits || []),
          ...(c.tags || []),
          ...(c.monitoringLabs || []),
          ...(c.contraindications || []),
          ...(c.sideEffects || []),
          JSON.stringify(c.sectionData || {}),
          JSON.stringify(c.customFields || {}),
        ];
        return hayParts.some((part) => typeof part === 'string' && part.toLowerCase().includes(q));
      });
    }

    return results;
  }

  async function getCompound(compoundId) {
    const state = await loadState();
    return requireCompound(state, compoundId);
  }

  async function checkDuplicate(candidate) {
    const state = await loadState();
    const res = checkDuplicateCompound(candidate || {}, state.compounds);
    const primaryMatch = res.matches?.[0] || res.siblingVariants?.[0] || null;
    return {
      ...res,
      duplicate: Boolean(res.isDuplicate),
      existingCompoundId: res.existingCompoundId || primaryMatch?.compoundId || primaryMatch?.id || null,
      existingId: res.existingCompoundId || primaryMatch?.compoundId || primaryMatch?.id || null,
      sameMoleculeDifferentRoute: Boolean(res.hasSiblingVariant || (res.siblingVariants && res.siblingVariants.length > 0)),
    };
  }

  async function createCompound(input, auth, { isAi = false, forceStatus = null } = {}) {
    if (!isPlainObject(input)) {
      throw new HubError(422, 'INVALID_PAYLOAD', 'Compound profile must be a JSON object.', {
        missingFields: ['name', 'sectionId'],
      });
    }
    const state = await loadState();
    const sectionId = typeof input.sectionId === 'string' ? input.sectionId.trim() : '';
    const section = state.sections.find((s) => s.id === sectionId);
    if (!section) {
      throw new HubError(422, 'SECTION_NOT_FOUND', `Unknown or missing sectionId "${sectionId}".`, {
        missingFields: sectionId ? [] : ['sectionId'],
        errors: [{ field: 'sectionId', code: 'SECTION_NOT_FOUND', message: `Unknown sectionId "${sectionId}".` }],
      });
    }

    const validation = validateCompoundProfile(input, {
      section,
      sections: state.sections,
      strict: isAi,
    });
    if (!validation.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', validation.errors[0]?.message || 'Compound profile validation failed.', {
        errors: validation.errors,
        warnings: validation.warnings,
        missingFields: validation.missingFields,
        completenessPct: validation.completenessPct,
      });
    }

    const compound = validation.normalized;
    const dup = checkDuplicateCompound(compound, state.compounds);
    let isRealDup = dup.isDuplicate;
    if (isRealDup && dup.matches?.length > 0 && input.canonicalMolecule && typeof input.canonicalMolecule === 'string' && input.canonicalMolecule.trim()) {
      const candMol = normName(input.canonicalMolecule);
      const candName = normName(compound.name);
      const allDistinctCanonical = dup.matches.every((m) => {
        const ex = state.compounds.find((c) => c.id === m.compoundId);
        if (!ex || !ex.canonicalMolecule) return false;
        const exMol = normName(ex.canonicalMolecule);
        const exName = normName(ex.name);
        const exAliases = new Set((ex.aliases || []).map((a) => normName(a)));
        return (
          exMol !== candMol &&
          exName !== candName &&
          exName !== candMol &&
          exMol !== candName &&
          !exAliases.has(candName) &&
          !exAliases.has(candMol)
        );
      });
      if (allDistinctCanonical) isRealDup = false;
    }
    if (isRealDup) {
      const existingId = dup.existingCompoundId || dup.matches?.[0]?.compoundId || dup.matches?.[0]?.id || null;
      throw new HubError(409, 'DUPLICATE_COMPOUND', `Duplicate compound detected (${dup.matchType || 'exact'}): already exists as "${existingId}".`, {
        existingCompoundId: existingId,
        matchType: dup.matchType,
        matches: dup.matches,
      });
    }

    if (forceStatus) {
      compound.profileStatus = forceStatus;
    } else if (isAi) {
      compound.profileStatus = 'ai_draft';
    }

    if (isAi) {
      if (!compound.provenance) compound.provenance = {};
      if (!compound.provenance.sourceModel || compound.provenance.sourceModel === 'manual') {
        compound.provenance.sourceModel = auth?.actor || 'ai:client';
      }
      if (!compound.provenance.researchedAt) {
        compound.provenance.researchedAt = new Date().toISOString();
      }
    }

    // Check AI write policy: hold_in_inbox vs auto_publish_ai_draft
    if (isAi && state.settings?.aiWritePolicy?.newCompoundMode === 'hold_in_inbox') {
      const proposal = {
        id: generateId('prop'),
        type: 'create_compound',
        targetType: 'compound',
        targetId: compound.id,
        compoundId: compound.id,
        status: 'pending',
        actor: auth?.actor || compound.provenance?.sourceModel || 'ai:client',
        summary: `Propose new ${section.name} compound: ${compound.name}`,
        rationale: input.rationale || `AI-researched ${compound.name} held for review per household AI write policy.`,
        proposedPayload: compound,
        proposedPatch: compound,
        completenessPct: compound.completenessPct,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        resolvedBy: null,
      };
      state.proposals.push(proposal);
      appendAudit(state, {
        actor: proposal.actor,
        action: 'propose_compound',
        targetType: 'proposal',
        targetId: proposal.id,
        summary: `Proposed new compound "${compound.name}" (held in inbox)`,
      });
      await persistMutation(state);
      return {
        status: 'proposed',
        routedToProposals: true,
        proposal,
        completenessPct: compound.completenessPct,
        warnings: validation.warnings,
      };
    }

    state.compounds.push(compound);
    // Link multi-route sibling variants bidirectionally (e.g., GHK-Cu SubQ <-> Topical)
    state.compounds = linkRelatedCompounds(state.compounds, compound);
    const linked = state.compounds.find((c) => c.id === compound.id) || compound;

    appendAudit(state, {
      actor: auth?.actor || (isAi ? compound.provenance?.sourceModel : 'member:admin') || 'member:admin',
      action: isAi ? 'ai_create_compound' : 'create_compound',
      targetType: 'compound',
      targetId: linked.id,
      summary: `Created compound "${linked.name}" (${linked.profileStatus})`,
    });
    await persistMutation(state);
    return {
      status: 'created',
      compound: linked,
      completenessPct: linked.completenessPct,
      warnings: validation.warnings,
    };
  }

  async function updateCompound(compoundId, patch, auth) {
    if (!isPlainObject(patch)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Compound patch must be an object.');
    }
    const state = await loadState();
    const idx = state.compounds.findIndex((c) => c.id === compoundId);
    if (idx === -1) {
      throw new HubError(404, 'COMPOUND_NOT_FOUND', `Compound "${compoundId}" not found.`);
    }
    const existing = state.compounds[idx];

    if (patch.sectionId !== undefined && patch.sectionId !== existing.sectionId) {
      const targetSec = state.sections.find((s) => s.id === patch.sectionId);
      if (!targetSec) {
        throw new HubError(422, 'SECTION_NOT_FOUND', `Unknown target sectionId "${patch.sectionId}".`);
      }
    }

    const merged = deepMergePlain(existing, patch);
    merged.id = existing.id;
    merged.createdAt = existing.createdAt;
    // Preserve arrays replaced directly in patch (deepMergePlain replaces arrays)
    const section = state.sections.find((s) => s.id === merged.sectionId);
    const validation = validateCompoundProfile(merged, {
      section,
      sections: state.sections,
      strict: false,
    });
    if (!validation.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', validation.errors[0]?.message || 'Invalid compound update.', {
        errors: validation.errors,
        missingFields: validation.missingFields,
      });
    }

    const dup = checkDuplicateCompound(validation.normalized, state.compounds, { excludeId: existing.id });
    if (dup.isDuplicate) {
      throw new HubError(409, 'DUPLICATE_COMPOUND', 'Update would collide with an existing compound.', {
        existingCompoundId: dup.existingCompoundId || dup.matches?.[0]?.compoundId || null,
      });
    }

    validation.normalized.id = existing.id;
    validation.normalized.createdAt = existing.createdAt;
    validation.normalized.updatedAt = new Date().toISOString();
    state.compounds[idx] = validation.normalized;
    state.compounds = linkRelatedCompounds(state.compounds, validation.normalized);

    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'update_compound',
      targetType: 'compound',
      targetId: compoundId,
      changedFields: Object.keys(patch),
      summary: `Updated compound "${validation.normalized.name}"`,
    });
    await persistMutation(state);
    return state.compounds.find((c) => c.id === compoundId);
  }

  async function enrichCompound(compoundId, patch, auth, { rationale = '', provenance = null } = {}) {
    if (!isPlainObject(patch)) {
      throw new HubError(422, 'INVALID_PAYLOAD', 'Enrichment patch must be an object.');
    }
    const state = await loadState();
    const idx = state.compounds.findIndex((c) => c.id === compoundId || c.slug === compoundId);
    if (idx === -1) {
      throw new HubError(404, 'COMPOUND_NOT_FOUND', `Compound "${compoundId}" not found.`);
    }
    const existing = state.compounds[idx];
    const actor =
      provenance?.sourceModel ||
      patch?.provenance?.sourceModel ||
      auth?.actor ||
      'ai:client';

    // Verified-field protection (F19, F21): NEVER silently overwrite existing fields on a verified profile!
    if (existing.profileStatus === 'verified') {
      const overwrites = detectVerifiedOverwrites(existing, patch);
      const mustPropose =
        overwrites.length > 0 || state.settings?.aiWritePolicy?.verifiedEditMode === 'always_propose';

      if (mustPropose) {
        const proposal = {
          id: generateId('prop'),
          type: 'enrich_compound',
          targetType: 'compound',
          targetId: existing.id,
          compoundId: existing.id,
          compoundName: existing.name,
          status: 'pending',
          actor,
          summary: `Proposed enrichment to verified profile "${existing.name}"`,
          rationale: rationale || 'AI proposed update to verified compound profile.',
          proposedPatch: deepClone(patch),
          diff: buildDiff(existing, patch),
          conflictingFields: overwrites.map((c) => c.field),
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          resolvedBy: null,
        };
        state.proposals.push(proposal);
        appendAudit(state, {
          actor,
          action: 'propose_compound_enrichment',
          targetType: 'proposal',
          targetId: proposal.id,
          changedFields: Object.keys(patch),
          summary: `Routed AI edit to verified "${existing.name}" into Proposals Inbox`,
        });
        await persistMutation(state);
        return {
          status: 'proposed',
          routedToProposals: true,
          proposal,
          compound: existing,
          completenessPct: existing.completenessPct,
        };
      }
    }

    // Apply enrichment directly on ai_draft / needs_review (or blank-fill when policy permits)
    const merged = deepMergePlain(existing, patch);
    merged.id = existing.id;
    merged.createdAt = existing.createdAt;
    // Never let enrich_compound silently promote an ai_draft to verified
    if (existing.profileStatus !== 'verified') {
      merged.profileStatus = existing.profileStatus;
    }
    const section = state.sections.find((s) => s.id === merged.sectionId);
    const validation = validateCompoundProfile(merged, {
      section,
      sections: state.sections,
      strict: false,
    });
    if (!validation.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', validation.errors[0]?.message || 'Invalid enrichment fields.', {
        errors: validation.errors,
        missingFields: validation.missingFields,
      });
    }
    validation.normalized.id = existing.id;
    validation.normalized.createdAt = existing.createdAt;
    validation.normalized.updatedAt = new Date().toISOString();
    state.compounds[idx] = validation.normalized;
    appendAudit(state, {
      actor,
      action: 'enrich_compound',
      targetType: 'compound',
      targetId: existing.id,
      changedFields: Object.keys(patch),
      summary: `Enriched "${existing.name}" (${validation.completenessPct}% complete)`,
    });
    await persistMutation(state);
    return {
      status: 'enriched',
      routedToProposals: false,
      compound: validation.normalized,
      completenessPct: validation.completenessPct,
    };
  }

  async function verifyCompound(compoundId, auth) {
    const state = await loadState();
    const idx = state.compounds.findIndex((c) => c.id === compoundId);
    if (idx === -1) {
      throw new HubError(404, 'COMPOUND_NOT_FOUND', `Compound "${compoundId}" not found.`);
    }
    state.compounds[idx].profileStatus = 'verified';
    state.compounds[idx].updatedAt = new Date().toISOString();
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'verify_compound',
      targetType: 'compound',
      targetId: compoundId,
      changedFields: ['profileStatus'],
      summary: `Verified compound "${state.compounds[idx].name}"`,
    });
    await persistMutation(state);
    return state.compounds[idx];
  }

  async function deleteCompound(compoundId, auth) {
    const state = await loadState();
    const idx = state.compounds.findIndex((c) => c.id === compoundId);
    if (idx === -1) {
      throw new HubError(404, 'COMPOUND_NOT_FOUND', `Compound "${compoundId}" not found.`);
    }
    const [removed] = state.compounds.splice(idx, 1);
    const nowIso = new Date().toISOString();
    recordTombstone(state, 'compounds', compoundId, nowIso);
    // Clean up relatedCompoundIds pointers
    for (const c of state.compounds) {
      if (Array.isArray(c.relatedCompoundIds)) {
        c.relatedCompoundIds = c.relatedCompoundIds.filter((id) => id !== compoundId);
      }
    }
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'delete_compound',
      targetType: 'compound',
      targetId: compoundId,
      summary: `Deleted compound "${removed.name}"`,
    });
    await persistMutation(state);
    return { deleted: true, id: compoundId };
  }

  // -------------------------------------------------------------------------
  // Ownership & Stock Inventory
  // -------------------------------------------------------------------------

  async function listOwnership(query = {}) {
    const state = await loadState();
    let list = [...state.ownership];
    if (query.compoundId) list = list.filter((o) => o.compoundId === query.compoundId);
    if (query.scope) list = list.filter((o) => o.scope === query.scope);
    if (query.status) list = list.filter((o) => o.status === query.status);
    if (query.memberId || query.member) {
      const mid = query.memberId || query.member;
      list = list.filter((o) => o.scope === 'household' || o.scope === `member:${mid}`);
    }
    return list.map((rec) => ({
      ...rec,
      lowStock:
        rec.status === 'low_stock' ||
        (typeof rec.remainingDoses === 'number' && rec.remainingDoses <= LOW_STOCK_DOSE_THRESHOLD && rec.status === 'have'),
    }));
  }

  async function upsertOwnership(compoundId, input, auth) {
    if (!isPlainObject(input)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Ownership payload must be an object.');
    }
    const state = await loadState();
    requireCompound(state, compoundId);

    if (input.scope !== undefined && (typeof input.scope !== 'string' || !input.scope.trim())) {
      throw new HubError(422, 'INVALID_SCOPE', 'scope must be "household" or "member:<memberId>".');
    }
    const scope = input.scope === undefined ? (state.settings?.defaultOwnershipScope || 'household') : input.scope.trim();
    const candidate = {
      ...input,
      compoundId,
      scope,
    };

    const res = validateOwnershipRecord(candidate, {
      compoundsById: mapCompoundsById(state.compounds),
      membersById: mapMembersById(state.members),
    });
    if (!res.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', res.errors[0]?.message || 'Invalid ownership record.', {
        errors: res.errors,
      });
    }

    const rec = res.normalized;
    // Reflect low-stock alert flag when remainingDoses <= 3
    const lowStockWarning =
      typeof rec.remainingDoses === 'number' &&
      rec.remainingDoses <= LOW_STOCK_DOSE_THRESHOLD &&
      (rec.status === 'have' || rec.status === 'low_stock')
        ? `Low stock: only ${rec.remainingDoses} dose(s) remaining.`
        : null;

    const existingIdx = state.ownership.findIndex(
      (o) => o.compoundId === compoundId && o.scope === rec.scope,
    );
    if (existingIdx !== -1) {
      rec.id = state.ownership[existingIdx].id;
      state.ownership[existingIdx] = rec;
    } else {
      state.ownership.push(rec);
    }

    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'update_ownership',
      targetType: 'ownership',
      targetId: rec.id,
      summary: `Set ownership for ${compoundId} (${rec.scope}) to ${rec.status}`,
    });
    await persistMutation(state);

    return {
      ...rec,
      lowStock: rec.status === 'low_stock' || Boolean(lowStockWarning),
      lowStockWarning,
    };
  }

  // -------------------------------------------------------------------------
  // Member Stacks & Dual-Track Stack Spreading
  // -------------------------------------------------------------------------

  async function listMemberStacks(memberId) {
    const state = await loadState();
    requireMember(state, memberId);
    return state.stacks.filter((s) => s.memberId === memberId);
  }

  async function createMemberStack(memberId, input, auth) {
    if (!isPlainObject(input)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Stack payload must be an object.');
    }
    const state = await loadState();
    requireMember(state, memberId);

    const payload = {
      ...input,
      memberId,
      onlyOwned: input.haveOnly !== undefined ? Boolean(input.haveOnly) : Boolean(input.onlyOwned),
    };
    const res = validateStack(payload, {
      membersById: mapMembersById(state.members),
      compoundsById: mapCompoundsById(state.compounds),
    });
    if (!res.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', res.errors[0]?.message || 'Invalid stack payload.', {
        errors: res.errors,
      });
    }
    const stack = {
      ...res.normalized,
      haveOnly: Boolean(input.haveOnly ?? res.normalized.onlyOwned),
      onlyOwned: Boolean(input.haveOnly ?? res.normalized.onlyOwned),
    };
    state.stacks.push(stack);
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'create_stack',
      targetType: 'stack',
      targetId: stack.id,
      summary: `Created stack "${stack.name}" for ${memberId}`,
    });
    await persistMutation(state);
    return stack;
  }

  async function updateMemberStack(memberId, stackId, patch, auth) {
    if (!isPlainObject(patch)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Stack patch must be an object.');
    }
    const state = await loadState();
    requireMember(state, memberId);

    const idx = state.stacks.findIndex((s) => s.id === stackId);
    if (idx === -1) {
      throw new HubError(404, 'STACK_NOT_FOUND', `Stack "${stackId}" not found.`);
    }
    if (state.stacks[idx].memberId !== memberId) {
      throw new HubError(403, 'CROSS_MEMBER_FORBIDDEN', `Stack "${stackId}" does not belong to member "${memberId}".`);
    }

    const current = state.stacks[idx];
    const nextHaveOnly =
      patch.haveOnly !== undefined
        ? Boolean(patch.haveOnly)
        : patch.onlyOwned !== undefined
          ? Boolean(patch.onlyOwned)
          : Boolean(current.haveOnly ?? current.onlyOwned);

    const merged = {
      ...current,
      ...patch,
      id: stackId,
      memberId,
      haveOnly: nextHaveOnly,
      onlyOwned: nextHaveOnly,
      items: patch.items !== undefined ? patch.items : current.items,
      updatedAt: new Date().toISOString(),
    };

    const res = validateStack(merged, {
      membersById: mapMembersById(state.members),
      compoundsById: mapCompoundsById(state.compounds),
    });
    if (!res.ok) {
      throw new HubError(422, 'VALIDATION_ERROR', res.errors[0]?.message || 'Invalid stack update.', {
        errors: res.errors,
      });
    }
    const updated = {
      ...res.normalized,
      haveOnly: nextHaveOnly,
      onlyOwned: nextHaveOnly,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    state.stacks[idx] = updated;
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'update_stack',
      targetType: 'stack',
      targetId: stackId,
      changedFields: Object.keys(patch),
      summary: `Updated stack "${updated.name}" for ${memberId}`,
    });
    await persistMutation(state);
    return updated;
  }

  async function deleteMemberStack(memberId, stackId, auth) {
    const state = await loadState();
    requireMember(state, memberId);
    const idx = state.stacks.findIndex((s) => s.id === stackId);
    if (idx === -1) {
      throw new HubError(404, 'STACK_NOT_FOUND', `Stack "${stackId}" not found.`);
    }
    if (state.stacks[idx].memberId !== memberId) {
      throw new HubError(403, 'CROSS_MEMBER_FORBIDDEN', `Stack "${stackId}" does not belong to member "${memberId}".`);
    }
    const [removed] = state.stacks.splice(idx, 1);
    recordTombstone(state, 'stacks', stackId);
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'delete_stack',
      targetType: 'stack',
      targetId: stackId,
      summary: `Deleted stack "${removed.name}"`,
    });
    await persistMutation(state);
    return { deleted: true, id: stackId };
  }

  async function computeStackSchedule(memberId, stackId, options = {}) {
    const state = await loadState();
    const member = requireMember(state, memberId);
    const stack = stackId
      ? state.stacks.find((s) => s.id === stackId)
      : state.stacks.find((s) => s.memberId === memberId && s.active !== false) ||
        state.stacks.find((s) => s.memberId === memberId);

    if (stackId && !stack) {
      throw new HubError(404, 'STACK_NOT_FOUND', `Stack "${stackId}" not found.`);
    }
    if (stack && stack.memberId !== memberId) {
      throw new HubError(403, 'CROSS_MEMBER_FORBIDDEN', `Stack "${stackId}" does not belong to member "${memberId}".`);
    }

    const effectiveStack = stack || { id: `empty_${memberId}`, memberId, name: 'Empty Stack', items: [] };
    return suggestStackSchedule({
      stack: effectiveStack,
      compoundsById: mapCompoundsById(state.compounds),
      member,
      ownershipByCompound: state.ownership,
      dateKey: options.dateKey || null,
      whatIfCompounds: Array.isArray(options.whatIfCompounds) ? options.whatIfCompounds : [],
      haveOnly: typeof options.haveOnly === 'boolean' ? options.haveOnly : undefined,
    });
  }

  async function computeStackInteractions(memberId, stackId, options = {}) {
    const state = await loadState();
    const member = requireMember(state, memberId);
    const stack = stackId
      ? state.stacks.find((s) => s.id === stackId)
      : state.stacks.find((s) => s.memberId === memberId && s.active !== false) ||
        state.stacks.find((s) => s.memberId === memberId);

    if (stackId && !stack) {
      throw new HubError(404, 'STACK_NOT_FOUND', `Stack "${stackId}" not found.`);
    }
    if (stack && stack.memberId !== memberId) {
      throw new HubError(403, 'CROSS_MEMBER_FORBIDDEN', `Stack "${stackId}" does not belong to member "${memberId}".`);
    }

    const items = Array.isArray(options.items)
      ? options.items
      : [
          ...(stack?.items || []),
          ...(Array.isArray(options.whatIfCompounds)
            ? options.whatIfCompounds.map((w) => (typeof w === 'string' ? { compoundId: w } : w))
            : []),
        ];

    return analyzeStackInteractions({
      items,
      compoundsById: mapCompoundsById(state.compounds),
      member,
      ownershipByCompound: state.ownership,
    });
  }

  // -------------------------------------------------------------------------
  // Dose Logs, Advisory Dose-Sanity Gate & Adherence
  // -------------------------------------------------------------------------

  async function listMemberLogs(memberId, query = {}) {
    const state = await loadState();
    requireMember(state, memberId);
    let logs = state.logs.filter((l) => l.memberId === memberId);
    if (query.compoundId) logs = logs.filter((l) => l.compoundId === query.compoundId);
    if (query.from) logs = logs.filter((l) => (l.takenAt || '') >= query.from);
    if (query.to) logs = logs.filter((l) => (l.takenAt || '') <= query.to);
    return logs.sort((a, b) => String(b.takenAt || '').localeCompare(String(a.takenAt || '')));
  }

  async function createMemberLog(memberId, input, auth) {
    if (!isPlainObject(input)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Dose log payload must be an object.');
    }
    const state = await loadState();
    requireMember(state, memberId);

    const compoundId = typeof input.compoundId === 'string' ? input.compoundId.trim() : '';
    if (!compoundId) {
      throw new HubError(422, 'REQUIRED', 'compoundId is required for dose logs.');
    }
    const compound = state.compounds.find((c) => c.id === compoundId);
    if (!compound) {
      throw new HubError(404, 'COMPOUND_NOT_FOUND', `Compound "${compoundId}" not found.`);
    }

    const skipped = Boolean(input.skipped);
    const rawAmount = input.dose ?? input.doseAmount ?? input.amount;
    const doseNum = parseFiniteNumber(rawAmount);
    const unit =
      (typeof input.unit === 'string' && input.unit.trim()) ||
      (typeof input.doseUnit === 'string' && input.doseUnit.trim()) ||
      compound.dosages?.defaultUnit ||
      '';

    // Hard-block <= 0 or missing/NaN dose when skipped !== true (F38)
    if (!skipped) {
      if (!Number.isFinite(doseNum) || doseNum <= 0) {
        throw new HubError(
          422,
          'INVALID_DOSE',
          'Dose amount must be a positive number > 0 (or set skipped: true).',
        );
      }
    }

    let sanity = {
      verdict: 'ALLOW',
      needsReview: false,
      warnings: [],
      reasons: [],
      hardBlocked: false,
    };

    if (!skipped) {
      const priorLogs = state.logs
        .filter((l) => l.memberId === memberId && l.compoundId === compoundId && !l.skipped)
        .map((l) => ({
          ...l,
          amount: l.dose ?? l.doseAmount,
          dose: l.dose ?? l.doseAmount,
          unit: l.unit ?? l.doseUnit,
          ts: l.takenAt,
        }));

      const customCeilings = {};
      if (compound.dosages?.maxCeiling > 0) {
        const key = slugify(compound.canonicalMolecule || compound.name);
        customCeilings[key] = {
          maxAmount: compound.dosages.maxCeiling,
          unit: compound.dosages.defaultUnit || unit,
          per: 'dose',
        };
      }

      const evalRes = evaluateAdvisoryDose(
        {
          compoundId: compound.id,
          compoundName: compound.name,
          canonicalMolecule: compound.canonicalMolecule || compound.name,
          doseAmount: doseNum,
          doseUnit: unit,
          amount: doseNum,
          dose: doseNum,
          unit,
          takenAt: input.takenAt || new Date().toISOString(),
        },
        {
          compound,
          defaultUnit: compound.dosages?.defaultUnit || unit,
          priorLogs,
          logs: priorLogs,
          ceilings: customCeilings,
        },
      );

      const rawEvalWarnings = [...(evalRes.warnings || []), ...(evalRes.reasons || [])].filter(Boolean);
      // Keep real pharmacological/safety warnings (jump, unit, ceiling, ratio, invalid), ignoring benign ad-hoc info when no schedule plan was passed
      const warnings = rawEvalWarnings.filter(
        (w) => !/^(ad-hoc or off-schedule dose|differs from scheduled dose)$/i.test(String(w).trim()),
      );
      // Explicit independent safety checks (guaranteed coverage for >=5x jump, unit switch, maxCeiling breach)
      const lastLog = priorLogs.sort((a, b) => String(b.takenAt || '').localeCompare(String(a.takenAt || '')))[0];
      if (lastLog) {
        const prevUnit = lastLog.unit || lastLog.doseUnit;
        const prevAmt = parseFiniteNumber(lastLog.dose ?? lastLog.doseAmount);
        if (prevUnit && unit && prevUnit !== unit && !warnings.some((w) => /unit/i.test(String(w)))) {
          warnings.push(`Unit changed from ${prevUnit} to ${unit}.`);
        }
        if (
          prevAmt > 0 &&
          prevUnit === unit &&
          doseNum >= prevAmt * 5 &&
          !warnings.some((w) => /5x|jump|spike/i.test(String(w)))
        ) {
          warnings.push(`Dose ${doseNum} ${unit} is >=5x prior dose (${prevAmt} ${prevUnit}).`);
        }
      }
      if (
        compound.dosages?.maxCeiling > 0 &&
        (!compound.dosages.defaultUnit || compound.dosages.defaultUnit === unit) &&
        doseNum > compound.dosages.maxCeiling &&
        !warnings.some((w) => /ceiling|max/i.test(String(w)))
      ) {
        warnings.push(`Dose ${doseNum} ${unit} exceeds configured ceiling (${compound.dosages.maxCeiling} ${compound.dosages.defaultUnit || unit}).`);
      }

      const flagged = warnings.length > 0;
      sanity = {
        verdict: flagged ? 'CONFIRM' : 'ALLOW',
        needsReview: flagged,
        warnings,
        reasons: warnings,
        hardBlocked: false,
      };
    }

    const nowIso = new Date().toISOString();
    const takenIso = typeof input.takenAt === 'string' && input.takenAt.trim() ? input.takenAt : nowIso;
    const log = {
      id: generateId('log'),
      memberId,
      compoundId,
      compoundName: compound.name,
      dose: skipped ? null : doseNum,
      doseAmount: skipped ? null : doseNum,
      unit: skipped ? (unit || null) : unit,
      doseUnit: skipped ? (unit || null) : unit,
      slot: typeof input.slot === 'string' ? input.slot : null,
      takenAt: takenIso,
      datetime: takenIso,
      skipped,
      skipReason: typeof input.skipReason === 'string' ? input.skipReason : typeof input.reason === 'string' ? input.reason : null,
      injectionSite: input.injectionSite ?? input.site ?? null,
      site: input.injectionSite ?? input.site ?? null,
      volumeMl: parseFiniteNumber(input.volumeMl ?? input.doseMl),
      doseMl: parseFiniteNumber(input.volumeMl ?? input.doseMl),
      notes: typeof input.notes === 'string' ? input.notes : '',
      needsReview: sanity.needsReview,
      verdict: sanity.verdict,
      sanityWarnings: sanity.warnings,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    state.logs.push(log);
    appendAudit(state, {
      actor: auth?.actor || `member:${memberId}`,
      action: skipped ? 'log_skip' : 'log_dose',
      targetType: 'log',
      targetId: log.id,
      summary: skipped
        ? `Skipped ${compound.name}${log.skipReason ? ` (${log.skipReason})` : ''}`
        : `Logged ${doseNum} ${unit} ${compound.name}`,
    });
    await persistMutation(state);

    return {
      log,
      sanity,
      verdict: sanity.verdict,
      needsReview: sanity.needsReview,
      warnings: sanity.warnings,
    };
  }

  async function deleteMemberLog(memberId, logId, auth) {
    const state = await loadState();
    requireMember(state, memberId);
    const idx = state.logs.findIndex((l) => l.id === logId);
    if (idx === -1) {
      throw new HubError(404, 'LOG_NOT_FOUND', `Log "${logId}" not found.`);
    }
    if (state.logs[idx].memberId !== memberId) {
      throw new HubError(403, 'CROSS_MEMBER_FORBIDDEN', `Log "${logId}" does not belong to member "${memberId}".`);
    }
    state.logs.splice(idx, 1);
    recordTombstone(state, 'logs', logId);
    appendAudit(state, {
      actor: auth?.actor || `member:${memberId}`,
      action: 'delete_log',
      targetType: 'log',
      targetId: logId,
      summary: `Deleted dose log ${logId}`,
    });
    await persistMutation(state);
    return { deleted: true, id: logId };
  }

  async function getMemberAdherence(memberId) {
    const state = await loadState();
    requireMember(state, memberId);
    const logs = state.logs.filter((l) => l.memberId === memberId);
    const nowMs = Date.now();
    const DAY = 86_400_000;

    const buildWindow = (days) => {
      const cutoff = nowMs - days * DAY;
      const inWin = logs.filter((l) => {
        const ts = Date.parse(l.takenAt || l.createdAt || '');
        return Number.isFinite(ts) && ts >= cutoff;
      });
      const taken = inWin.filter((l) => !l.skipped).length;
      const skipped = inWin.filter((l) => l.skipped).length;
      const total = taken + skipped;
      const rate = total > 0 ? Math.round((taken / total) * 10000) / 10000 : 0;
      const adherencePct = Math.round(rate * 10000) / 100;
      return { days, taken, skipped, total, rate, adherencePct };
    };

    const w7 = buildWindow(7);
    const w30 = buildWindow(30);
    const w90 = buildWindow(90);

    return {
      memberId,
      windows: {
        '7d': w7,
        '30d': w30,
        '90d': w90,
      },
      '7d': w7,
      '30d': w30,
      '90d': w90,
      d7: w7,
      d30: w30,
      d90: w90,
    };
  }

  // -------------------------------------------------------------------------
  // Proposals Inbox & Immutable Audit Log
  // -------------------------------------------------------------------------

  async function listProposals(query = {}) {
    const state = await loadState();
    let list = [...state.proposals];
    if (query.status && String(query.status).toLowerCase() !== 'all') {
      list = list.filter((p) => p.status === query.status);
    }
    if (query.type) list = list.filter((p) => p.type === query.type);
    if (query.memberId) list = list.filter((p) => p.memberId === query.memberId);
    return list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  async function createProposal(input, auth) {
    if (!isPlainObject(input)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Proposal payload must be an object.');
    }
    const state = await loadState();
    const rawType = String(input.type || input.kind || input.proposalType || input.action || 'stack_change').trim().toLowerCase();
    const normalizedType = ['compound_create', 'create_compound', 'new_compound'].includes(rawType)
      ? 'create_compound'
      : ['compound_edit', 'compound_update', 'edit_compound', 'enrich_compound'].includes(rawType)
        ? 'enrich_compound'
        : rawType;
    const rawPayload = input.proposedPayload || input.payload || input.compound || input.data || input.proposedPatch || input.changes || {};
    const proposal = {
      id: generateId('prop'),
      type: normalizedType,
      targetType: input.targetType || (input.stackId ? 'stack' : 'compound'),
      targetId: input.targetId || input.stackId || input.compoundId || null,
      memberId: input.memberId || null,
      stackId: input.stackId || null,
      compoundId: input.compoundId || null,
      status: 'pending',
      actor: input.sourceModel || input.actor || auth?.actor || 'ai:client',
      sourceModel: input.sourceModel || input.actor || auth?.actor || 'ai:client',
      summary: input.summary || input.rationale || 'Proposed change',
      rationale: input.rationale || input.summary || '',
      changes: deepClone(input.changes || input.proposedPatch || rawPayload),
      proposedPatch: deepClone(input.proposedPatch || input.changes || rawPayload),
      proposedPayload: deepClone(rawPayload),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    state.proposals.push(proposal);
    appendAudit(state, {
      actor: proposal.actor,
      action: 'create_proposal',
      targetType: 'proposal',
      targetId: proposal.id,
      summary: proposal.summary,
    });
    await persistMutation(state);
    return proposal;
  }

  async function proposeStackChange(args, auth) {
    const state = await loadState();
    const memberId = args.memberId || args.member || auth?.memberId;
    if (!memberId) {
      throw new HubError(422, 'REQUIRED', 'memberId is required to propose a stack change.');
    }
    requireMember(state, memberId);

    const stack = args.stackId
      ? state.stacks.find((s) => s.id === args.stackId && s.memberId === memberId)
      : state.stacks.find((s) => s.memberId === memberId && s.active !== false) ||
        state.stacks.find((s) => s.memberId === memberId);

    // Normalize proposed stack additions/removals/items
    let addItems = [];
    let removeIds = [];
    let replaceItems = null;

    if (Array.isArray(args.changes)) {
      for (const ch of args.changes) {
        if (ch.action === 'remove' && ch.compoundId) removeIds.push(ch.compoundId);
        else if (ch.compoundId) addItems.push(ch);
      }
    } else if (isPlainObject(args.changes)) {
      if (Array.isArray(args.changes.add)) addItems.push(...args.changes.add);
      if (Array.isArray(args.changes.remove)) removeIds.push(...args.changes.remove);
      if (Array.isArray(args.changes.items)) replaceItems = args.changes.items;
    }
    if (Array.isArray(args.add)) {
      addItems.push(...args.add.map((a) => (typeof a === 'string' ? { compoundId: a } : a)));
    }
    if (Array.isArray(args.remove)) {
      removeIds.push(...args.remove);
    }
    if (Array.isArray(args.items) && addItems.length === 0 && !replaceItems) {
      addItems.push(...args.items);
    }
    if (args.item && isPlainObject(args.item)) {
      addItems.push(args.item);
    } else if (args.compoundId && addItems.length === 0) {
      if (args.action === 'remove') removeIds.push(args.compoundId);
      else addItems.push({ compoundId: args.compoundId, doseAmount: args.doseAmount, doseUnit: args.doseUnit });
    }

    const proposal = {
      id: generateId('prop'),
      type: 'stack_change',
      targetType: 'stack',
      targetId: stack?.id || null,
      memberId,
      stackId: stack?.id || null,
      status: 'pending',
      actor: args.provenance?.sourceModel || auth?.actor || 'ai:client',
      summary: args.rationale || args.summary || `Proposed stack update for ${memberId}`,
      rationale: args.rationale || args.summary || args.reason || 'AI stack recommendation',
      changes: {
        add: addItems,
        remove: removeIds,
        ...(replaceItems ? { items: replaceItems } : {}),
      },
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };

    state.proposals.push(proposal);
    appendAudit(state, {
      actor: proposal.actor,
      action: 'propose_stack_change',
      targetType: 'proposal',
      targetId: proposal.id,
      summary: proposal.summary,
    });
    await persistMutation(state);
    return proposal;
  }

  async function resolveProposal(proposalId, { action, edits = null } = {}, auth) {
    const state = await loadState();
    const idx = state.proposals.findIndex((p) => p.id === proposalId);
    if (idx === -1) {
      throw new HubError(404, 'PROPOSAL_NOT_FOUND', `Proposal "${proposalId}" not found.`);
    }
    const proposal = state.proposals[idx];
    const normAction = String(action || '').toLowerCase().trim();
    if (!['approve', 'dismiss', 'reject'].includes(normAction)) {
      throw new HubError(422, 'INVALID_ACTION', 'action must be "approve" or "dismiss".');
    }
    if (proposal.status !== 'pending') {
      throw new HubError(409, 'ALREADY_RESOLVED', `Proposal "${proposalId}" is already ${proposal.status}.`);
    }

    const nowIso = new Date().toISOString();
    const resolver = auth?.actor || 'member:admin';
    let appliedEntity = null;

    if (normAction === 'approve') {
      if (proposal.type === 'create_compound') {
        const basePayload = deepMergePlain(proposal.proposedPayload || proposal.proposedPatch || {}, isPlainObject(edits) ? edits : {});
        const section = state.sections.find((s) => s.id === basePayload.sectionId);
        const val = validateCompoundProfile(basePayload, { section, sections: state.sections });
        if (!val.ok) {
          throw new HubError(422, 'VALIDATION_ERROR', val.errors[0]?.message || 'Approved compound invalid.', { errors: val.errors });
        }
        val.normalized.profileStatus = 'verified';
        state.compounds.push(val.normalized);
        state.compounds = linkRelatedCompounds(state.compounds, val.normalized);
        appliedEntity = state.compounds.find((c) => c.id === val.normalized.id);
      } else if (proposal.type === 'enrich_compound') {
        const cIdx = state.compounds.findIndex((c) => c.id === (proposal.compoundId || proposal.targetId));
        if (cIdx === -1) {
          throw new HubError(404, 'COMPOUND_NOT_FOUND', 'Target compound for proposal no longer exists.');
        }
        const effectivePatch = isPlainObject(edits)
          ? deepMergePlain(proposal.proposedPatch || {}, edits)
          : proposal.proposedPatch || {};
        const merged = deepMergePlain(state.compounds[cIdx], effectivePatch);
        merged.id = state.compounds[cIdx].id;
        merged.createdAt = state.compounds[cIdx].createdAt;
        const section = state.sections.find((s) => s.id === merged.sectionId);
        const val = validateCompoundProfile(merged, { section, sections: state.sections });
        if (!val.ok) {
          throw new HubError(422, 'VALIDATION_ERROR', val.errors[0]?.message || 'Approved enrichment invalid.', { errors: val.errors });
        }
        val.normalized.id = state.compounds[cIdx].id;
        val.normalized.createdAt = state.compounds[cIdx].createdAt;
        val.normalized.updatedAt = nowIso;
        state.compounds[cIdx] = val.normalized;
        appliedEntity = val.normalized;
      } else if (proposal.type === 'stack_change') {
        const memberId = proposal.memberId;
        let sIdx = proposal.stackId
          ? state.stacks.findIndex((s) => s.id === proposal.stackId && s.memberId === memberId)
          : state.stacks.findIndex((s) => s.memberId === memberId && s.active !== false);

        if (sIdx === -1) {
          // Auto-create default active stack for member if none existed
          const newStack = {
            id: generateId('stk'),
            memberId,
            name: 'Primary Stack',
            description: '',
            active: true,
            haveOnly: false,
            onlyOwned: false,
            items: [],
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          state.stacks.push(newStack);
          sIdx = state.stacks.length - 1;
        }

        const st = deepClone(state.stacks[sIdx]);
        const changes = isPlainObject(edits) ? deepMergePlain(proposal.changes || {}, edits) : proposal.changes || {};
        if (Array.isArray(changes.items) && (!changes.add || changes.add.length === 0)) {
          st.items = deepClone(changes.items);
        } else {
          if (Array.isArray(changes.remove) && changes.remove.length > 0) {
            const remSet = new Set(changes.remove);
            st.items = st.items.filter((i) => !remSet.has(i.compoundId));
          }
          if (Array.isArray(changes.add)) {
            for (const addItem of changes.add) {
              if (!addItem?.compoundId) continue;
              const existingIdx = st.items.findIndex((i) => i.compoundId === addItem.compoundId);
              if (existingIdx !== -1) st.items[existingIdx] = { ...st.items[existingIdx], ...addItem };
              else st.items.push({ id: generateId('si'), ...addItem });
            }
          }
        }
        st.updatedAt = nowIso;
        state.stacks[sIdx] = st;
        appliedEntity = st;
      }

      proposal.status = 'approved';
      proposal.resolvedAt = nowIso;
      proposal.resolvedBy = resolver;
      if (edits) proposal.appliedEdits = deepClone(edits);
      appendAudit(state, {
        actor: resolver,
        action: 'approve_proposal',
        targetType: 'proposal',
        targetId: proposalId,
        summary: `Approved proposal "${proposal.summary}"`,
      });
    } else {
      proposal.status = 'dismissed';
      proposal.resolvedAt = nowIso;
      proposal.resolvedBy = resolver;
      appendAudit(state, {
        actor: resolver,
        action: 'dismiss_proposal',
        targetType: 'proposal',
        targetId: proposalId,
        summary: `Dismissed proposal "${proposal.summary}"`,
      });
    }

    state.proposals[idx] = proposal;
    await persistMutation(state);
    return { proposal, applied: appliedEntity };
  }

  async function listAuditLog(query = {}) {
    const state = await loadState();
    let entries = [...state.auditLog];
    if (query.actor) entries = entries.filter((e) => e.actor === query.actor);
    if (query.targetId) entries = entries.filter((e) => e.targetId === query.targetId);
    const limit = parseFiniteNumber(query.limit);
    entries.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    if (limit && limit > 0) entries = entries.slice(0, Math.trunc(limit));
    return entries;
  }

  // -------------------------------------------------------------------------
  // API Keys & OAuth Clients Management (Isolated AuthStore)
  // -------------------------------------------------------------------------

  async function listApiKeys() {
    const authStore = await storage.getAuthStore();
    return (authStore.apiKeys || [])
      .filter((k) => !k.revokedAt)
      .map(({ keyHash, ...safe }) => safe);
  }

  async function createApiKey(input, auth) {
    if (!isPlainObject(input)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'API key payload must be an object.');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const scope = typeof input.scope === 'string' ? input.scope.trim().toLowerCase() : '';
    if (!name) {
      throw new HubError(422, 'REQUIRED', 'API key name is required.');
    }
    if (!API_TOKEN_SCOPES.includes(scope)) {
      throw new HubError(422, 'INVALID_SCOPE', `API key scope must be one of: ${API_TOKEN_SCOPES.join(', ')}.`);
    }

    const rawSecret = `hp_key_${randomToken(28)}`;
    const keyHash = await sha256Hex(rawSecret);
    const nowIso = new Date().toISOString();
    const record = {
      id: generateId('key'),
      name,
      scope,
      actor: typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : normalizeAiActorName(name),
      memberId: typeof input.memberId === 'string' && input.memberId.trim() ? input.memberId.trim() : null,
      prefix: rawSecret.slice(0, 12),
      keyHash,
      createdAt: nowIso,
      lastUsedAt: null,
      revokedAt: null,
    };

    const authStore = await storage.getAuthStore();
    authStore.apiKeys.push(record);
    await storage.saveAuthStore(authStore);

    const state = await loadState();
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'mint_api_key',
      targetType: 'api_key',
      targetId: record.id,
      summary: `Minted ${scope} API key "${name}"`,
    });
    await persistMutation(state);

    const { keyHash: _omitted, ...publicKey } = record;
    return {
      key: publicKey,
      id: publicKey.id,
      name: publicKey.name,
      scope: publicKey.scope,
      prefix: publicKey.prefix,
      secret: rawSecret, // Shown ONCE!
      rawKey: rawSecret,
    };
  }

  async function revokeApiKey(keyId, auth) {
    const authStore = await storage.getAuthStore();
    const rec = (authStore.apiKeys || []).find((k) => k.id === keyId && !k.revokedAt);
    if (!rec) {
      throw new HubError(404, 'KEY_NOT_FOUND', `API key "${keyId}" not found.`);
    }
    rec.revokedAt = new Date().toISOString();
    await storage.saveAuthStore(authStore);

    const state = await loadState();
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'revoke_api_key',
      targetType: 'api_key',
      targetId: keyId,
      summary: `Revoked API key "${rec.name}"`,
    });
    await persistMutation(state);
    return { revoked: true, id: keyId };
  }

  async function listOAuthClients() {
    const authStore = await storage.getAuthStore();
    return (authStore.oauthClients || [])
      .filter((c) => !c.revokedAt)
      .map(({ client_secret_hash, ...safe }) => ({
        ...safe,
        id: safe.client_id,
        activeGrants: (authStore.oauthTokens || []).filter((t) => t.clientId === safe.client_id && !t.revokedAt).length,
      }));
  }

  async function revokeOAuthClient(clientId, auth) {
    const authStore = await storage.getAuthStore();
    const client = (authStore.oauthClients || []).find((c) => c.client_id === clientId && !c.revokedAt);
    if (!client) {
      throw new HubError(404, 'CLIENT_NOT_FOUND', `OAuth client "${clientId}" not found.`);
    }
    const nowIso = new Date().toISOString();
    client.revokedAt = nowIso;
    for (const tok of authStore.oauthTokens || []) {
      if (tok.clientId === clientId && !tok.revokedAt) tok.revokedAt = nowIso;
    }
    await storage.saveAuthStore(authStore);

    const state = await loadState();
    appendAudit(state, {
      actor: auth?.actor || 'member:admin',
      action: 'revoke_oauth_client',
      targetType: 'oauth_client',
      targetId: clientId,
      summary: `Revoked OAuth client "${client.client_name}" and all its grants`,
    });
    await persistMutation(state);
    return { revoked: true, client_id: clientId };
  }

  // -------------------------------------------------------------------------
  // Sync, Daily Snapshots, Export, Import & Starter Seed
  // -------------------------------------------------------------------------

  async function getSyncState() {
    const state = await loadState();
    return stripSecrets(state);
  }

  async function pushSyncState(clientState, { ifMatch = null } = {}, auth) {
    if (!isPlainObject(clientState)) {
      throw new HubError(400, 'INVALID_PAYLOAD', 'Sync state must be an object.');
    }
    const serverState = await loadState();

    // Parse expected revision from If-Match header OR body._rev
    let expectedRev = null;
    if (ifMatch !== null && ifMatch !== undefined && String(ifMatch).trim() !== '' && String(ifMatch).trim() !== '*') {
      const cleaned = String(ifMatch).replace(/^W\//i, '').replace(/^"+|"+$/g, '').trim();
      const parsed = Number(cleaned);
      if (Number.isInteger(parsed)) expectedRev = parsed;
    }
    if (expectedRev === null && Number.isInteger(clientState._rev)) {
      expectedRev = clientState._rev;
    }

    if (expectedRev !== null && expectedRev !== serverState._rev) {
      throw new HubError(409, 'SYNC_CONFLICT', `Sync conflict: expected _rev ${expectedRev}, current server _rev is ${serverState._rev}.`, {
        currentRev: serverState._rev,
        _rev: serverState._rev,
        state: stripSecrets(serverState),
      });
    }

    const merged = mergeStates(serverState, stripSecrets(clientState));
    merged._rev = serverState._rev; // persistMutation increments _rev by 1
    appendAudit(merged, {
      actor: auth?.actor || 'member:admin',
      action: 'sync_push',
      targetType: 'hub',
      summary: `Merged cloud sync push`,
    });
    const saved = await persistMutation(merged);
    return stripSecrets(saved);
  }

  async function listSnapshots() {
    return storage.listSnapshots();
  }

  async function restoreSnapshot(dateKey, auth) {
    if (typeof dateKey !== 'string' || !dkValid(dateKey)) {
      throw new HubError(400, 'INVALID_DATE_KEY', `Invalid snapshot dateKey "${dateKey}". Expected YYYY-MM-DD.`);
    }
    const snapState = await storage.getSnapshot(dateKey);
    if (!snapState) {
      throw new HubError(404, 'SNAPSHOT_NOT_FOUND', `No snapshot found for date "${dateKey}".`);
    }
    const current = await loadState();
    const restored = deepClone(snapState);
    restored._rev = current._rev; // monotonic rev increment on restore
    appendAudit(restored, {
      actor: auth?.actor || 'member:admin',
      action: 'restore_snapshot',
      targetType: 'snapshot',
      targetId: dateKey,
      summary: `Restored hub state from daily snapshot ${dateKey}`,
    });
    const saved = await persistMutation(restored, { skipSnapshot: true });
    return { restored: true, dateKey, _rev: saved._rev, state: stripSecrets(saved) };
  }

  async function exportHub() {
    const state = await loadState();
    return exportHubJson(stripSecrets(state));
  }

  async function exportCsv() {
    const state = await loadState();
    return exportCompoundsCsv(stripSecrets(state));
  }

  async function exportContext({ memberId = null, sectionId = null, sectionIds = null, format = 'md' } = {}) {
    const state = await loadState();
    const safeState = stripSecrets(state);
    const fmt = format === 'json' ? 'json' : 'md';
    const effectiveSectionIds =
      Array.isArray(sectionIds) && sectionIds.length > 0
        ? sectionIds
        : sectionId
          ? [sectionId]
          : null;
    const bundle = buildContextBundle(safeState, {
      memberId: memberId || null,
      sectionIds: effectiveSectionIds,
      includeLogs: true,
      includeFullProfiles: true,
      format: fmt,
    });
    if (fmt === 'json') {
      return bundle.data || bundle;
    }
    return {
      markdown: bundle.content || '',
      content: bundle.content || '',
      data: bundle.data,
      estimatedTokens: bundle.estimatedTokens,
    };
  }

  async function importHub(payload, auth) {
    const val = validateHubExport(payload);
    if (!val.ok) {
      throw new HubError(422, 'INVALID_HUB_EXPORT', val.errors[0]?.message || 'Malformed Home Pharmacy export.', {
        errors: val.errors,
      });
    }
    const current = await loadState();
    const imported = importHubJson(current, payload, { mode: 'replace' });
    if (!imported.ok) {
      throw new HubError(422, 'IMPORT_FAILED', imported.errors?.[0]?.message || 'Import failed.', {
        errors: imported.errors,
      });
    }
    const nextState = stripSecrets(imported.state);
    nextState._rev = current._rev;
    appendAudit(nextState, {
      actor: auth?.actor || 'member:admin',
      action: 'import_hub',
      targetType: 'hub',
      summary: `Imported Home Pharmacy archive (${nextState.compounds.length} compounds)`,
    });
    const saved = await persistMutation(nextState);
    return {
      imported: true,
      counts: {
        members: saved.members.length,
        sections: saved.sections.length,
        compounds: saved.compounds.length,
        stacks: saved.stacks.length,
        logs: saved.logs.length,
      },
      _rev: saved._rev,
    };
  }

  async function importProtocolOs(payload, { memberId = 'member_husband' } = {}, auth) {
    const val = validateProtocolOsExport(payload);
    if (!val.ok) {
      throw new HubError(422, 'INVALID_PROTOCOL_OS_EXPORT', val.errors[0]?.message || 'Malformed protocol-os export.', {
        errors: val.errors,
      });
    }
    const current = await loadState();
    const targetMemberId = current.members.some((m) => m.id === memberId)
      ? memberId
      : current.members[0]?.id || 'member_husband';
    const res = importProtocolOsExport(current, payload, {
      memberId: targetMemberId,
    });
    if (!res.ok) {
      throw new HubError(422, 'IMPORT_FAILED', res.errors?.[0]?.message || 'protocol-os import failed.', {
        errors: res.errors,
      });
    }
    const nextState = stripSecrets(res.state);
    nextState._rev = current._rev;
    appendAudit(nextState, {
      actor: auth?.actor || 'member:admin',
      action: 'import_protocol_os',
      targetType: 'hub',
      summary: `Imported protocol-os archive (+${res.summary?.compoundsAdded ?? 0} compounds, +${res.summary?.logsAdded ?? 0} logs)`,
    });
    const saved = await persistMutation(nextState);
    return {
      imported: true,
      stats: res.summary || {},
      summary: res.summary || {},
      counts: {
        compounds: saved.compounds.length,
        ownership: saved.ownership.length,
        stacks: saved.stacks.length,
        logs: saved.logs.length,
      },
      _rev: saved._rev,
    };
  }

  async function seedStarter(auth) {
    const current = await loadState();
    const res = seedStarterCatalog(current);
    const nextState = res.state || current;
    nextState._rev = current._rev;
    const addedCount = Number(res.added ?? res.addedCount ?? 0);
    const skippedCount = Number(res.skipped ?? res.skippedCount ?? 0);
    if (addedCount > 0) {
      appendAudit(nextState, {
        actor: auth?.actor || 'member:admin',
        action: 'seed_starter_catalog',
        targetType: 'hub',
        summary: `Loaded ${addedCount} non-personal starter reference compound profiles`,
      });
      await persistMutation(nextState);
    }
    return {
      seeded: true,
      added: addedCount,
      addedCount,
      skipped: skippedCount,
      skippedCount,
      totalCompounds: nextState.compounds.length,
    };
  }

  // -------------------------------------------------------------------------
  // AI Research Prompt Builder & Optional BYOK Autofill (F48)
  // -------------------------------------------------------------------------

  async function buildResearchPrompt({ name, compoundName, sectionId = 'peptides' } = {}) {
    const targetName = String(compoundName || name || '').trim();
    if (!targetName) {
      throw new HubError(422, 'REQUIRED', 'Compound name is required to build a research prompt.');
    }
    const state = await loadState();
    const section = requireSection(state, sectionId);
    const schemaDesc = getSectionSchemaDescriptor(section);

    const customFieldsBlock =
      (section.customFields || []).length > 0
        ? `\nSection Custom Fields to populate under "customFields":\n${section.customFields
            .map(
              (f) =>
                `- "${f.key}" (${f.fieldType}${f.required ? ', REQUIRED' : ''}): ${f.label}${
                  f.options?.length ? ` [options: ${f.options.join(', ')}]` : ''
                }${f.aiResearchInstruction ? ` — ${f.aiResearchInstruction}` : ''}`,
            )
            .join('\n')}`
        : '';

    const prompt = [
      `You are researching "${targetName}" for the "${section.name}" (${section.id}) section of Home Pharmacy.`,
      section.aiResearchPrompt ? `\nSection Research Instructions:\n${section.aiResearchPrompt}` : '',
      customFieldsBlock,
      `\nReturn ONLY a single valid JSON object matching the canonical Home Pharmacy Compound Profile schema:`,
      `- Required: name, sectionId ("${section.id}"), summary (what it is), mechanismOfAction, useCaseScenarios[], timingRules{preferredSlots, avoidSlots, foodState, workoutRelation, circadianEffect, timingNotes}, halfLife{valueHours, displayText, kind}, dosages{rangeText, defaultAmount, defaultUnit, route, frequencyText}, cycles{patternText, cycleDays, offDays, continuous}, doNotPairWith[{targetType, targetRef, severity, separationHours?, mechanism, recommendation}], synergies[{targetRef, coLocate, reason}], contraindications[], sideEffects[], monitoringLabs[], storageNotes, sectionData{}, customFields{}, provenance{sourceModel, evidenceTier, confidence, citations[{title, url, pmid?, nct?}]}.`,
      `- Use only valid https:// citation URLs (PubMed, ClinicalTrials.gov, FDA/NIH).`,
      `- NEVER fabricate a single half-life number for multi-ingredient blends (set halfLife.kind = "unmodeled", valueHours = null).`,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      compoundName: targetName,
      sectionId: section.id,
      sectionName: section.name,
      prompt,
      schema: schemaDesc,
    };
  }

  async function autofillCompound(input = {}) {
    const hasByok = BYOK_ENV_KEYS.some((k) => typeof env?.[k] === 'string' && env[k].trim().length > 0);
    const name = String(input.compoundName || input.name || 'Requested Compound').trim();
    const sectionId = typeof input.sectionId === 'string' && input.sectionId.trim() ? input.sectionId.trim() : 'peptides';
    let promptData = null;
    try {
      promptData = await buildResearchPrompt({ name, sectionId });
    } catch {
      promptData = { prompt: `Research ${name} for section ${sectionId} and return Home Pharmacy JSON.` };
    }

    if (!hasByok) {
      throw new HubError(
        501,
        'BYOK_NOT_CONFIGURED',
        'No server-side BYOK LLM API key is configured. Use the generated schema-aware research prompt in Gemini, Claude, Grok, ChatGPT, or Muse and import the JSON response.',
        {
          fallbackPrompt: promptData.prompt,
          prompt: promptData.prompt,
          sectionId,
          compoundName: name,
          supportedProviders: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'],
        },
      );
    }

    // Even if a key is set, avoid making unmocked external network calls in offline tests unless configured
    throw new HubError(501, 'BYOK_EXTERNAL_DISABLED', 'External BYOK call requires provider endpoint configuration; use fallbackPrompt.', {
      fallbackPrompt: promptData.prompt,
      prompt: promptData.prompt,
    });
  }

  // -------------------------------------------------------------------------
  // Web Push Reminders Config & Subscriptions (F39)
  // -------------------------------------------------------------------------

  async function getPushConfig() {
    const publicKey = typeof env?.VAPID_PUBLIC_KEY === 'string' && env.VAPID_PUBLIC_KEY.trim() ? env.VAPID_PUBLIC_KEY.trim() : null;
    return {
      enabled: Boolean(publicKey),
      configured: Boolean(publicKey),
      vapidPublicKey: publicKey,
      supported: true,
    };
  }

  async function subscribePush(input, auth) {
    if (!isPlainObject(input)) {
      throw new HubError(422, 'INVALID_SUBSCRIPTION', 'Push subscription must be an object.');
    }
    const sub = isPlainObject(input.subscription) ? input.subscription : input;
    const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
    if (!endpoint || !isValidHttpUrl(endpoint) || !endpoint.startsWith('https://')) {
      throw new HubError(422, 'INVALID_ENDPOINT', 'Push subscription endpoint must be a valid https:// URL.');
    }

    const authStore = await storage.getAuthStore();
    const memberId = input.memberId || auth?.memberId || 'member_wife';
    const existing = authStore.pushSubscriptions.find((s) => s.endpoint === endpoint);
    const nowIso = new Date().toISOString();
    if (existing) {
      existing.keys = isPlainObject(sub.keys) ? deepClone(sub.keys) : existing.keys;
      existing.memberId = memberId;
      existing.updatedAt = nowIso;
      await storage.saveAuthStore(authStore);
      return { subscribed: true, subscription: existing };
    }

    const rec = {
      id: generateId('push'),
      memberId,
      endpoint,
      keys: isPlainObject(sub.keys) ? deepClone(sub.keys) : {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    authStore.pushSubscriptions.push(rec);
    await storage.saveAuthStore(authStore);
    return { subscribed: true, subscription: rec };
  }

  async function unsubscribePush(input) {
    const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
    const id = typeof input?.id === 'string' ? input.id.trim() : '';
    const authStore = await storage.getAuthStore();
    const before = authStore.pushSubscriptions.length;
    authStore.pushSubscriptions = authStore.pushSubscriptions.filter(
      (s) => (endpoint ? s.endpoint !== endpoint : true) && (id ? s.id !== id : true),
    );
    const removed = authStore.pushSubscriptions.length < before;
    if (removed) {
      await storage.saveAuthStore(authStore);
    }
    return { unsubscribed: true, removed };
  }

  const serialized = (fn) => (...args) => {
    const prev = storageWriteQueues.get(storage) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn(...args));
    storageWriteQueues.set(storage, next.catch(() => {}));
    return next;
  };

  return {
    loadState,
    getHousehold,
    updateHouseholdSettings: serialized(updateHouseholdSettings),
    listMembers,
    createMember: serialized(createMember),
    updateMember: serialized(updateMember),
    deleteMember: serialized(deleteMember),
    listSections,
    getSection,
    createSection: serialized(createSection),
    updateSection: serialized(updateSection),
    deleteSection: serialized(deleteSection),
    listCompounds,
    getCompound,
    checkDuplicate,
    createCompound: serialized(createCompound),
    updateCompound: serialized(updateCompound),
    enrichCompound: serialized(enrichCompound),
    verifyCompound: serialized(verifyCompound),
    deleteCompound: serialized(deleteCompound),
    listOwnership,
    upsertOwnership: serialized(upsertOwnership),
    listMemberStacks,
    createMemberStack: serialized(createMemberStack),
    updateMemberStack: serialized(updateMemberStack),
    deleteMemberStack: serialized(deleteMemberStack),
    computeStackSchedule,
    computeStackInteractions,
    listMemberLogs,
    createMemberLog: serialized(createMemberLog),
    deleteMemberLog: serialized(deleteMemberLog),
    getMemberAdherence,
    listProposals,
    createProposal: serialized(createProposal),
    proposeStackChange: serialized(proposeStackChange),
    resolveProposal: serialized(resolveProposal),
    listAuditLog,
    listApiKeys,
    createApiKey: serialized(createApiKey),
    revokeApiKey: serialized(revokeApiKey),
    listOAuthClients,
    revokeOAuthClient: serialized(revokeOAuthClient),
    getSyncState,
    pushSyncState: serialized(pushSyncState),
    listSnapshots,
    restoreSnapshot: serialized(restoreSnapshot),
    exportHub,
    exportCsv,
    exportContext,
    importHub: serialized(importHub),
    importProtocolOs: serialized(importProtocolOs),
    seedStarter: serialized(seedStarter),
    buildResearchPrompt,
    autofillCompound,
    getPushConfig,
    subscribePush: serialized(subscribePush),
    unsubscribePush: serialized(unsubscribePush),
  };
}
