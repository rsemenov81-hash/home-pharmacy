import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as core from '../../src/core/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, '../../src/core');

// ---------------------------------------------------------------------------
// 1. Barrel Export & Purity
// ---------------------------------------------------------------------------
describe('Barrel Export & Purity', () => {
  it('loads all 6 core modules via src/core/index.js with zero export collisions', () => {
    const requiredExports = [
      // constants.js
      'HUB_VERSION', 'HUB_SCHEMA_VERSION', 'HUB_EXPORT_FORMAT', 'CORE_SECTION_IDS',
      'SYSTEMIC_SLOTS', 'DERM_LAYERING_STEPS', 'OWNERSHIP_STATUSES', 'MASS_TO_MCG',
      'SOLVENT_OVERRIDES', 'INJECTION_SITES', 'DEFAULT_DOSE_CEILINGS', 'deepClone',
      // dedup.js
      'normName', 'normRoute', 'resolveCanonicalMolecule', 'isBlendCompound',
      'compoundFingerprint', 'checkDuplicateCompound', 'findSiblingVariants', 'linkRelatedCompounds',
      // calculators.js
      'parseFiniteNumber', 'toMassMcg', 'canonicalizeDose', 'getPreferredSolvent', 'getSolventInfo',
      'vialMath', 'oilDrawMath', 'blendBreakdown', 'rotateSite', 'nextInjectionSite',
      'parseDoseTime', 'extractHalfLifeHours', 'remainingAt', 'levelSeries', 'levelSeriesWithBand',
      'buildCompoundLevels', 'formatLevel', 'dkParse', 'dkAdd', 'dkDiff', 'dkDow',
      'planAt', 'nextPlanRevision', 'materializePlan', 'applyRevision', 'removeRevision', 'cycleStatus',
      'deductSupply', 'projectSupplyRunOut', 'evaluateDose', 'softenVerdict', 'evaluateAdvisoryDose', 'computeAdherence',
      // schema.js
      'createEmptyHubState', 'createDefaultHubState', 'normalizeHubState', 'validateHubState',
      'addCustomField', 'updateCustomField', 'reorderCustomFields', 'removeCustomField',
      'updateSectionConfig', 'addCustomSubsection', 'removeCustomSubsection',
      'createCustomSection', 'deleteSection', 'getSectionSchemaDescriptor',
      'computeCompoundCompleteness', 'normalizeCompoundProfile', 'validateCompoundProfile',
      'validateMember', 'validateOwnershipRecord', 'resolveEffectiveOwnership', 'deductOwnershipDose', 'validateStack',
      // starter-catalog.js
      'STARTER_COMPOUNDS', 'STARTER_STACK_TEMPLATES', 'getStarterCatalog', 'seedStarterCatalog',
      // sync.js
      'stableStringify', 'parseRevision', 'nextRevision', 'pruneTombstones', 'snapshotState',
      'prepareSyncState', 'mergeStates', 'upsertById', 'stripSecrets', 'redactSensitiveText',
      'exportHubJson', 'validateHubExport', 'importHubJson', 'validateProtocolOsExport',
      'importProtocolOsExport', 'escapeCsvCell', 'exportCompoundsCsv', 'exportLogsCsv', 'buildContextBundle',
    ];

    for (const key of requiredExports) {
      assert.notEqual(core[key], undefined, `Missing expected export: ${key}`);
    }
  });

  it('has zero duplicate export names across all 6 core modules', async () => {
    const files = ['constants.js', 'dedup.js', 'calculators.js', 'schema.js', 'starter-catalog.js', 'sync.js'];
    const seen = new Map();
    const collisions = [];
    for (const f of files) {
      const mod = await import(`../../src/core/${f}`);
      for (const k of Object.keys(mod)) {
        if (seen.has(k)) collisions.push(`${k} (${seen.get(k)} & ${f})`);
        else seen.set(k, f);
      }
    }
    assert.deepEqual(collisions, [], `Duplicate star-exports detected: ${collisions.join(', ')}`);
  });

  it('contains zero Node-only imports and zero DOM/browser globals across src/core/', () => {
    const files = ['constants.js', 'dedup.js', 'calculators.js', 'schema.js', 'starter-catalog.js', 'sync.js', 'index.js'];
    for (const f of files) {
      const src = readFileSync(path.join(CORE_DIR, f), 'utf8');
      assert.equal(/from\s+['"]node:/.test(src), false, `Forbidden node:* import in src/core/${f}`);
      assert.equal(
        /\b(?:window|document|localStorage|sessionStorage)\s*\.|\btypeof\s+(?:window|document|localStorage|sessionStorage)\b/.test(src),
        false,
        `Forbidden browser global access in src/core/${f}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Constants & Default Bootstrap
// ---------------------------------------------------------------------------
describe('Constants & Default Bootstrap', () => {
  it('provides 2 generic co-admin default members (Wife female, Husband male) and immutable isolation', () => {
    const members = core.createDefaultMembers('2026-11-21T00:00:00.000Z');
    assert.equal(members.length, 2);
    assert.equal(members[0].id, 'member_wife');
    assert.equal(members[0].name, 'Wife');
    assert.equal(members[0].role, 'admin');
    assert.equal(members[0].safetyContext.biologicalSexContext, 'female');
    assert.equal(members[1].id, 'member_husband');
    assert.equal(members[1].name, 'Husband');
    assert.equal(members[1].role, 'admin');
    assert.equal(members[1].safetyContext.biologicalSexContext, 'male');

    // Mutating returned array/objects must not pollute DEFAULT_MEMBERS
    members[0].name = 'Mutated';
    members[0].routineAnchors.workoutDays.push(6);
    assert.equal(core.DEFAULT_MEMBERS[0].name, 'Wife');
    assert.deepEqual(core.DEFAULT_MEMBERS[0].routineAnchors.workoutDays, [1, 2, 3, 4, 5]);
  });

  it('defines 4 immutable core sections, 8 systemic slots, 7 derm steps, 5 ownership statuses, and IU excluded from MASS_TO_MCG', () => {
    assert.deepEqual(core.CORE_SECTION_IDS, ['peptides', 'peds', 'vitamins_supplements', 'dermatology']);
    const sections = core.createDefaultSections('2026-11-21T00:00:00.000Z');
    assert.equal(sections.length, 4);
    for (const s of sections) {
      assert.equal(s.isCore, true);
      assert.ok(s.subsections.length >= 5);
      assert.ok(s.aiResearchPrompt.length > 40);
      assert.ok(s.icon && s.accentColor);
    }

    assert.equal(core.SYSTEMIC_SLOTS.length, 8);
    assert.equal(core.DERM_LAYERING_STEPS.length, 7);
    assert.deepEqual(core.OWNERSHIP_STATUSES, ['have', 'dont_have', 'wishlist', 'low_stock', 'ordered']);
    assert.equal(core.MASS_TO_MCG.IU, undefined);
    assert.equal(core.MASS_TO_MCG.mg, 1000);
    assert.equal(core.MASS_TO_MCG.g, 1_000_000);
  });
});

// ---------------------------------------------------------------------------
// 3. Schema & Dynamic Section Customization
// ---------------------------------------------------------------------------
describe('Schema & Dynamic Section Customization', () => {
  const NOW = '2026-11-21T10:00:00.000Z';

  it('creates clean-slate HubState (0 compounds) that passes validateHubState and normalizes partial state', () => {
    const empty = core.createEmptyHubState({ now: NOW });
    assert.equal(empty.compounds.length, 0);
    assert.equal(empty.members.length, 2);
    assert.equal(empty.sections.length, 4);
    const check = core.validateHubState(empty);
    assert.equal(check.ok, true);
    assert.equal(check.valid, true);

    const hydrated = core.normalizeHubState({
      sections: [{ id: 'rx_meds', name: 'Rx Meds', isCore: false }],
      _rev: -5,
    }, { now: NOW });
    assert.equal(hydrated.sections.length, 5);
    assert.equal(hydrated._rev, 0);
    assert.equal(hydrated.members.length, 2);
  });

  it('supports full custom field lifecycle across all 8 types with non-destructive archival and restoration', () => {
    const state = core.createEmptyHubState({ now: NOW });
    let sec = state.sections.find((s) => s.id === 'peptides');

    const fieldDefs = [
      { key: 'vendor_coa_url', label: 'COA Link', fieldType: 'url', required: false },
      { key: 'batch_note', label: 'Batch Note', fieldType: 'text' },
      { key: 'protocol_rationale', label: 'Rationale', fieldType: 'textarea' },
      { key: 'cost_per_vial', label: 'Cost per Vial', fieldType: 'number', unit: 'USD', required: true },
      { key: 'reconstitution_grade', label: 'Grade', fieldType: 'select', options: ['pharma', 'research', 'compounded'] },
      { key: 'goal_tags', label: 'Goals', fieldType: 'multiselect', options: ['recovery', 'sleep', 'metabolic'] },
      { key: 'fridge_required', label: 'Fridge Required', fieldType: 'boolean' },
      { key: 'co_factors', label: 'Co-Factors', fieldType: 'list' },
    ];

    let compounds = [
      core.normalizeCompoundProfile({
        id: 'cmp_1',
        name: 'BPC-157',
        sectionId: 'peptides',
        customFields: {},
      }, { now: NOW }),
    ];

    for (const def of fieldDefs) {
      const res = core.addCustomField(sec, def, { compounds, now: NOW });
      assert.equal(res.ok, true, `Failed adding ${def.key}: ${JSON.stringify(res.errors)}`);
      sec = res.section;
      compounds = res.compounds;
    }
    assert.equal(sec.customFields.length, 8);

    // Reject malformed, reserved, duplicate keys, and select missing options
    assert.equal(core.addCustomField(sec, { key: '123bad', label: 'Bad', fieldType: 'text' }).ok, false);
    assert.equal(core.addCustomField(sec, { key: 'Has Space', label: 'Bad', fieldType: 'text' }).ok, false);
    assert.equal(core.addCustomField(sec, { key: 'bad-dash', label: 'Bad', fieldType: 'text' }).ok, false);
    assert.equal(core.addCustomField(sec, { key: 'dosages', label: 'Reserved', fieldType: 'text' }).ok, false);
    assert.equal(core.addCustomField(sec, { key: 'batch_note', label: 'Dup', fieldType: 'text' }).ok, false);
    assert.equal(core.addCustomField(sec, { key: 'no_opts', label: 'No Opts', fieldType: 'select' }).ok, false);

    // Populate compound custom values
    compounds[0].customFields = {
      vendor_coa_url: 'https://example.org/coa/123',
      batch_note: 'Lyophilized cake intact',
      protocol_rationale: 'Tendon recovery',
      cost_per_vial: 45,
      reconstitution_grade: 'research',
      goal_tags: ['recovery'],
      fridge_required: true,
      co_factors: ['Vitamin C'],
    };

    // Valid customFields pass validation
    const validRes = core.validateCompoundProfile(compounds[0], { section: sec, now: NOW });
    assert.equal(validRes.ok, true);

    // Rename key migrates compound value cleanly
    const renamed = core.updateCustomField(sec, 'batch_note', { key: 'vial_note', label: 'Vial Note', orderIndex: 0 }, { compounds, now: NOW });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.section.customFields[0].key, 'vial_note');
    assert.equal(renamed.compounds[0].customFields.vial_note, 'Lyophilized cake intact');
    assert.equal(renamed.compounds[0].customFields.batch_note, undefined);
    sec = renamed.section;
    compounds = renamed.compounds;

    // Non-destructive removal archives into archivedCustomFields
    const removed = core.removeCustomField(sec, 'vial_note', { compounds, now: NOW });
    assert.equal(removed.ok, true);
    assert.equal(removed.archivedCount, 1);
    assert.equal(removed.compounds[0].customFields.vial_note, undefined);
    assert.equal(removed.compounds[0].archivedCustomFields.vial_note, 'Lyophilized cake intact');
    sec = removed.section;
    compounds = removed.compounds;

    // Re-adding the same key automatically restores archived value!
    const restored = core.addCustomField(sec, { key: 'vial_note', label: 'Vial Note Restored', fieldType: 'text' }, { compounds, now: NOW });
    assert.equal(restored.ok, true);
    assert.equal(restored.restoredCount, 1);
    assert.equal(restored.compounds[0].customFields.vial_note, 'Lyophilized cake intact');
    assert.equal(restored.compounds[0].archivedCustomFields.vial_note, undefined);

    // Reordering custom fields
    const keys = restored.section.customFields.map((f) => f.key);
    const reversed = [...keys].reverse();
    const reordered = core.reorderCustomFields(restored.section, reversed, { now: NOW });
    assert.equal(reordered.ok, true);
    assert.deepEqual(reordered.section.customFields.map((f) => f.key), reversed);
    assert.equal(core.reorderCustomFields(restored.section, ['nonexistent']).ok, false);
  });

  it('enforces immutable core sections, non-hideable mandatory fields, subsections, and safe custom section deletion', () => {
    const state = core.createEmptyHubState({ now: NOW });
    const pep = state.sections.find((s) => s.id === 'peptides');

    // Cannot mutate section id, unset isCore, or hide mandatory fields
    assert.equal(core.updateSectionConfig(pep, { id: 'renamed' }).ok, false);
    assert.equal(core.updateSectionConfig(pep, { isCore: false }).ok, false);
    assert.equal(core.updateSectionConfig(pep, { hiddenOptionalFields: ['dosages'] }).ok, false);
    assert.equal(core.updateSectionConfig(pep, { hiddenOptionalFields: ['doNotPairWith'] }).ok, false);
    assert.equal(core.updateSectionConfig(pep, { hiddenOptionalFields: ['notes', 'storageNotes'] }).ok, true);

    // Subsections
    const addedSub = core.addCustomSubsection(pep, 'Sleep Peptides', { now: NOW });
    assert.equal(addedSub.ok, true);
    assert.equal(core.addCustomSubsection(addedSub.section, 'sleep peptides', { now: NOW }).ok, false);
    const remSub = core.removeCustomSubsection(addedSub.section, 'Sleep Peptides', { now: NOW });
    assert.equal(remSub.ok, true);

    // Custom section creation & deletion guard
    const created = core.createCustomSection(state.sections, { name: 'Rx Medications', id: 'rx_meds' }, { now: NOW });
    assert.equal(created.ok, true);
    assert.equal(created.section.isCore, false);

    // Cannot delete core sections (empty OR non-empty)
    assert.equal(core.deleteSection(created.sections, 'peptides', { compounds: [] }).ok, false);
    assert.equal(
      core.deleteSection(created.sections, 'peptides', { compounds: [{ id: 'c1', sectionId: 'peptides' }] }).errors[0].code,
      'CORE_SECTION_NON_EMPTY',
    );

    // Cannot delete non-empty custom section
    const nonEmptyDel = core.deleteSection(created.sections, 'rx_meds', { compounds: [{ id: 'rx1', sectionId: 'rx_meds' }] });
    assert.equal(nonEmptyDel.ok, false);
    assert.equal(nonEmptyDel.errors[0].code, 'SECTION_NOT_EMPTY');

    // Can delete empty custom section
    const emptyDel = core.deleteSection(created.sections, 'rx_meds', { compounds: [] });
    assert.equal(emptyDel.ok, true);
    assert.equal(emptyDel.sections.length, 4);

    // Descriptor for MCP get_section_schema
    const desc = core.getSectionSchemaDescriptor(pep);
    assert.equal(desc.section.id, 'peptides');
    assert.ok(desc.sectionDataFields.preferredSolvent);
    assert.ok(desc.enums.units.includes('IU'));
  });

  it('validates core invariants, all 4 sectionData schemas, citation URLs, customFields types, and completenessPct 0..100', () => {
    // Bare stub gets completeness 0
    const stub = core.validateCompoundProfile({ name: 'Bare Stub', sectionId: 'peptides' }, { now: NOW });
    assert.equal(stub.ok, true);
    assert.equal(stub.completenessPct, 0);

    // Strict mode flags missing fields
    const strictStub = core.validateCompoundProfile({ name: 'Bare Stub', sectionId: 'peptides' }, { strict: true, now: NOW });
    assert.equal(strictStub.ok, false);
    assert.ok(strictStub.missingFields.includes('summary'));
    assert.ok(strictStub.missingFields.includes('mechanismOfAction'));
    assert.ok(strictStub.missingFields.includes('dosages.route'));

    // Malformed fields rejected
    const bad = core.validateCompoundProfile({
      name: 'Bad Profile',
      sectionId: 'dermatology',
      timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_am'] },
      halfLife: { valueHours: -2, minHours: 10, maxHours: 5, sourceUrl: 'javascript:alert(1)' },
      doNotPairWith: [{ targetType: 'compound', targetRef: 'Bad Profile', severity: 'hard_stop', citation: 'ftp://evil.example' }],
      provenance: {
        citations: [
          { title: 'XSS', url: 'javascript:alert(1)' },
          { title: 'FTP', url: 'ftp://example.com/file' },
          { title: 'Not URL', url: 'not-a-url' },
        ],
      },
      sectionData: { layeringStep: 8, waitTimeMinutes: 90, vehicleType: 'invalid_vehicle' },
    }, { now: NOW });

    assert.equal(bad.ok, false);
    const codes = new Set(bad.errors.map((e) => e.code));
    assert.ok(codes.has('CONFLICTING_SLOTS'));
    assert.ok(codes.has('INVALID_HALF_LIFE'));
    assert.ok(codes.has('INVALID_RANGE'));
    assert.ok(codes.has('SELF_REFERENCE_INTERACTION'));
    assert.ok(codes.has('INVALID_CITATION_URL'));

    // Vitamins elementalAmount > totalCompoundWeight rejected
    const badSupp = core.validateCompoundProfile({
      name: 'Bad Mineral',
      sectionId: 'vitamins_supplements',
      sectionData: { elementalAmount: 500, totalCompoundWeight: 200 },
    }, { now: NOW });
    assert.equal(badSupp.ok, false);
    assert.ok(badSupp.errors.some((e) => e.code === 'ELEMENTAL_EXCEEDS_TOTAL'));

    // PEDs invalid class & Peptides invalid solvent
    assert.equal(
      core.validateCompoundProfile({ name: 'X', sectionId: 'peds', sectionData: { pedClass: 'unknown_class' } }).ok,
      false,
    );
    assert.equal(
      core.validateCompoundProfile({ name: 'X', sectionId: 'peptides', sectionData: { preferredSolvent: 'vodka' } }).ok,
      false,
    );

    // Required custom field lowers completeness below 100 when missing & fails validation
    const pepSec = core.addCustomField(core.createDefaultSections(NOW)[0], {
      key: 'required_note',
      label: 'Required Note',
      fieldType: 'text',
      required: true,
    }).section;
    const starterBpc = core.STARTER_COMPOUNDS.find((c) => c.id === 'bpc-157');
    assert.equal(core.computeCompoundCompleteness(starterBpc), 100);
    const missingReq = core.validateCompoundProfile(starterBpc, { section: pepSec, now: NOW });
    assert.equal(missingReq.ok, false);
    assert.ok(missingReq.completenessPct < 100);
    assert.ok(missingReq.missingFields.includes('customFields.required_note'));
  });

  it('validates members, ownership scoping priority, and stock deduction clamping/transitions', () => {
    const mBad = core.validateMember({ name: 'Test', routineAnchors: { wake: '25:99', tz: 'Mars/Olympus' } });
    assert.equal(mBad.ok, false);

    const oBad = core.validateOwnershipRecord({ compoundId: 'bpc-157', scope: 'bad_scope', status: 'have', quantity: -1 });
    assert.equal(oBad.ok, false);

    const records = [
      { id: 'o1', compoundId: 'bpc-157', scope: 'household', status: 'have', remainingDoses: 10 },
      { id: 'o2', compoundId: 'bpc-157', scope: 'member:member_wife', status: 'low_stock', remainingDoses: 2 },
      { id: 'o3', compoundId: 'tretinoin-cream', scope: 'member:member_wife', status: 'have' },
    ];
    // Wife gets personal override; Husband falls back to household
    const wifeOwn = core.resolveEffectiveOwnership('bpc-157', 'member_wife', records);
    assert.equal(wifeOwn.status, 'low_stock');
    assert.equal(wifeOwn.scope, 'member:member_wife');

    const husbandOwn = core.resolveEffectiveOwnership('bpc-157', 'member_husband', records);
    assert.equal(husbandOwn.status, 'have');
    assert.equal(husbandOwn.scope, 'household');
    assert.equal(husbandOwn.otherMemberRecords.length, 1);

    // Partner-only record surfaces separately without claiming ownership for Husband
    const husbandTret = core.resolveEffectiveOwnership('tretinoin-cream', 'member_husband', records);
    assert.equal(husbandTret.status, 'dont_have');
    assert.equal(husbandTret.otherMemberRecords.length, 1);

    // Stock deduction auto-transitions to low_stock (<=3) and dont_have (0), clamping at 0
    const d1 = core.deductOwnershipDose({ id: 'o1', compoundId: 'bpc-157', scope: 'household', status: 'have', remainingDoses: 4 }, 1, { now: NOW });
    assert.equal(d1.ok, true);
    assert.equal(d1.record.remainingDoses, 3);
    assert.equal(d1.record.status, 'low_stock');

    const d2 = core.deductOwnershipDose(d1.record, 5, { now: NOW });
    assert.equal(d2.record.remainingDoses, 0);
    assert.equal(d2.record.status, 'dont_have');
  });
});

// ---------------------------------------------------------------------------
// 4. Deduplication, Aliases & Multi-Route Variants
// ---------------------------------------------------------------------------
describe('Deduplication, Aliases & Multi-Route Variants', () => {
  it('normalizes names and detects exact and alias collisions across all 4 sections', () => {
    assert.equal(core.normName('BPC-157'), core.normName('bpc 157'));
    assert.equal(core.normName('Crème Rétiñol'), 'cremeretinol');

    const catalog = [
      { id: 'c_ox', name: 'Oxandrolone', sectionId: 'peds', dosages: { route: 'Oral' } },
      { id: 'c_tret', name: 'Tretinoin 0.05% Cream', sectionId: 'dermatology', dosages: { route: 'Topical' } },
      { id: 'c_ss31', name: 'SS-31', sectionId: 'peptides', dosages: { route: 'SubQ' } },
      { id: 'c_lgd', name: 'LGD-4033', sectionId: 'peds', dosages: { route: 'Oral' } },
      { id: 'c_cjc_nodac', name: 'CJC-1295 (no DAC)', sectionId: 'peptides', dosages: { route: 'SubQ' } },
    ];

    const rAnavar = core.checkDuplicateCompound({ name: 'Anavar', sectionId: 'peds', dosages: { route: 'Oral' } }, catalog);
    assert.equal(rAnavar.isDuplicate, true);
    assert.equal(rAnavar.classification, 'alias_match');
    assert.equal(rAnavar.httpStatusHint, 409);
    assert.equal(rAnavar.existingCompoundId, 'c_ox');

    const rRetinA = core.checkDuplicateCompound({ name: 'Retin-A', sectionId: 'dermatology', dosages: { route: 'Topical' } }, catalog);
    assert.equal(rRetinA.isDuplicate, true);
    assert.equal(rRetinA.existingCompoundId, 'c_tret');

    const rElam = core.checkDuplicateCompound({ name: 'Elamipretide', sectionId: 'peptides', dosages: { route: 'SubQ' } }, catalog);
    assert.equal(rElam.isDuplicate, true);
    assert.equal(rElam.existingCompoundId, 'c_ss31');

    const rLig = core.checkDuplicateCompound({ name: 'Ligandrol', sectionId: 'peds', dosages: { route: 'Oral' } }, catalog);
    assert.equal(rLig.isDuplicate, true);
    assert.equal(rLig.existingCompoundId, 'c_lgd');

    // CJC-1295 DAC must NOT collide with CJC-1295 (no DAC)!
    const rCjcDac = core.checkDuplicateCompound({ name: 'CJC-1295 with DAC', sectionId: 'peptides', dosages: { route: 'SubQ' } }, catalog);
    assert.equal(rCjcDac.isDuplicate, false);

    // excludeId prevents self-collision during edits
    const selfEdit = core.checkDuplicateCompound({ name: 'Oxandrolone', sectionId: 'peds', dosages: { route: 'Oral' } }, catalog, { excludeId: 'c_ox' });
    assert.equal(selfEdit.isDuplicate, false);
  });

  it('fingerprints blends order-independently across raw mg and normalized fractions without false positives', () => {
    const fp1 = core.compoundFingerprint({ 'bpc-157': 10, 'tb-500': 10 });
    const fp2 = core.compoundFingerprint({ tb500: 0.5, bpc157: 0.5 });
    const fpDiff = core.compoundFingerprint({ 'bpc-157': 0.7, 'tb-500': 0.3 });
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fpDiff);

    const existing = [
      { id: 'blend_1', name: 'Wolverine Mix', sectionId: 'peptides', dosages: { route: 'SubQ' }, sectionData: { ingredients: { 'bpc-157': 10, 'tb-500': 10 } } },
    ];
    const dupBlend = core.checkDuplicateCompound(
      { name: 'Recovery Blend', sectionId: 'peptides', dosages: { route: 'SubQ' }, sectionData: { ingredients: { tb500: 0.5, bpc157: 0.5 } } },
      existing,
    );
    assert.equal(dupBlend.isDuplicate, true);
    assert.equal(dupBlend.classification, 'blend_fingerprint_match');
    assert.equal(dupBlend.httpStatusHint, 409);
    assert.equal(dupBlend.existingCompoundId, 'blend_1');

    // Trailing '+' guard: NAD+ and SPF 50+ are NOT blends
    assert.equal(core.isBlendCompound({ name: 'NAD+' }), false);
    assert.equal(core.isBlendCompound({ name: 'Mineral SPF 50+' }), false);
    assert.equal(core.isBlendCompound({ name: 'BPC-157 + TB-500' }), true);
  });

  it('allows multi-route/cross-section sibling variants, flags duplicate on same route, and links siblings bidirectionally', () => {
    const ghkSubQ = { id: 'ghk-cu-subq', name: 'GHK-Cu (Injectable)', sectionId: 'peptides', dosages: { route: 'SubQ' }, relatedCompoundIds: [] };
    const ghkTopical = { id: 'ghk-cu-topical', name: 'GHK-Cu 2% Serum', sectionId: 'dermatology', dosages: { route: 'Topical' }, relatedCompoundIds: [] };

    const siblingCheck = core.checkDuplicateCompound(ghkTopical, [ghkSubQ]);
    assert.equal(siblingCheck.isDuplicate, false);
    assert.equal(siblingCheck.isSiblingVariant, true);
    assert.equal(siblingCheck.classification, 'same_molecule_other_route');
    assert.equal(siblingCheck.httpStatusHint, 200);
    assert.deepEqual(siblingCheck.relatedCompoundIds, ['ghk-cu-subq']);
    assert.equal(siblingCheck.canonicalMolecule, 'ghk-cu');

    // Mixed catalog with BOTH SubQ and Topical still flags a second Topical as 409 while listing SubQ in relatedCompoundIds
    const secondTopical = core.checkDuplicateCompound(
      { name: 'Copper Tripeptide-1 Facial Serum', sectionId: 'dermatology', dosages: { route: 'Topical' } },
      [ghkSubQ, ghkTopical],
    );
    assert.equal(secondTopical.isDuplicate, true);
    assert.equal(secondTopical.httpStatusHint, 409);
    assert.equal(secondTopical.existingCompoundId, 'ghk-cu-topical');
    assert.deepEqual(secondTopical.relatedCompoundIds, ['ghk-cu-subq']);

    // Bidirectional linking
    const linked = core.linkRelatedCompounds([ghkSubQ], ghkTopical);
    const subq = linked.find((c) => c.id === 'ghk-cu-subq');
    const top = linked.find((c) => c.id === 'ghk-cu-topical');
    assert.deepEqual(subq.relatedCompoundIds, ['ghk-cu-topical']);
    assert.deepEqual(top.relatedCompoundIds, ['ghk-cu-subq']);
    assert.equal(subq.canonicalMolecule, 'ghk-cu');
    assert.equal(top.canonicalMolecule, 'ghk-cu');
  });
});

// ---------------------------------------------------------------------------
// 5. Calculators — Solvent, Reconstitution, Oil, Blend & 8-Site Rotation
// ---------------------------------------------------------------------------
describe('Calculators — Solvent, Reconstitution, Oil, Blend & 8-Site Rotation', () => {
  it('resolves peptide solvent overrides and detects blend solvent conflicts', () => {
    assert.equal(core.getPreferredSolvent('ara-290'), 'PBS');
    assert.equal(core.getPreferredSolvent('ARA-290 (Cibinetide)'), 'PBS');
    assert.equal(core.getPreferredSolvent('igf1-lr3'), 'acetic_acid');
    assert.equal(core.getPreferredSolvent('IGF-1 LR3'), 'acetic_acid');
    assert.equal(core.getPreferredSolvent('aod9604'), 'acetic_acid');
    assert.equal(core.getPreferredSolvent('AOD-9604'), 'acetic_acid');
    assert.equal(core.getPreferredSolvent('bpc-157'), 'BAC');

    const conflict = core.getSolventInfo(null, [{ id: 'ara-290', name: 'ARA-290' }, { id: 'igf1-lr3', name: 'IGF-1 LR3' }]);
    assert.equal(conflict.isOverride, true);
    assert.equal(conflict.solventConflict, true);
    assert.ok(conflict.warning.includes('incompatible solvents'));
  });

  it('computes vialMath for mass and IU vials, handles float precision, guards dimension mismatches, and flags warnings', () => {
    // Standard 5 mg + 2 mL BAC, 250 mcg dose (both options & positional)
    const r1 = core.vialMath({ vialMg: 5, diluentMl: 2, doseAmount: 250, doseUnit: 'mcg' });
    assert.equal(r1.ok, true);
    assert.equal(r1.totalMcg, 5000);
    assert.equal(r1.mcgPerMl, 2500);
    assert.equal(r1.mcgPerUnit, 25);
    assert.equal(r1.mlPerDose, 0.1);
    assert.equal(r1.unitsPerDose, 10);
    assert.equal(r1.dosesPerVial, 20);
    assert.equal(r1.overVial, false);
    assert.equal(r1.overBarrel, false);

    const rPos = core.vialMath(5, 2, 250);
    assert.equal(rPos.unitsPerDose, 10);

    // IEEE-754 float precision: 0.6 mg / 200 mcg === 3 doses (NOT 2!)
    const rFloat = core.vialMath({ vialMg: 0.6, diluentMl: 1, doseMcg: 200 });
    assert.equal(rFloat.dosesPerVial, 3);

    // Warnings: overVial & overBarrel
    const rWarn = core.vialMath({ vialMg: 5, diluentMl: 2, doseMcg: 6000, compoundId: 'ara-290' });
    assert.equal(rWarn.ok, true);
    assert.equal(rWarn.overVial, true);
    assert.equal(rWarn.overBarrel, true);
    assert.equal(rWarn.solvent, 'PBS');
    assert.ok(rWarn.warnings.some((w) => w.code === 'DOSE_EXCEEDS_VIAL'));
    assert.ok(rWarn.warnings.some((w) => w.code === 'EXCEEDS_U100_BARREL'));
    assert.ok(rWarn.warnings.some((w) => w.code === 'SPECIAL_SOLVENT'));

    // IU vial (5000 IU / 5 mL) with 250 IU and fractional 12.5 IU
    const rIu = core.vialMath({ vialIU: 5000, diluentMl: 5, doseAmount: 250, doseUnit: 'IU' });
    assert.equal(rIu.ok, true);
    assert.equal(rIu.dimension, 'IU');
    assert.equal(rIu.iuPerMl, 1000);
    assert.equal(rIu.unitsPerDose, 25);
    assert.equal(rIu.dosesPerVial, 20);
    assert.equal(rIu.totalMcg, null);

    const rIuFrac = core.vialMath({ vialIU: 5000, diluentMl: 5, doseIU: 12.5 });
    assert.equal(rIuFrac.unitsPerDose, 1.25);
    assert.equal(rIuFrac.dosesPerVial, 400);

    // Strict guards: invalid inputs & IU/mass cross-dimension refusal
    assert.equal(core.vialMath({ vialMg: 5, diluentMl: 0, doseMcg: 250 }).code, 'INVALID_DILUENT');
    assert.equal(core.vialMath({ vialMg: true, diluentMl: 2, doseMcg: 250 }).code, 'INVALID_VIAL_AMOUNT');
    assert.equal(core.vialMath({ vialMg: 5, diluentMl: 2, doseAmount: 250, doseUnit: 'IU' }).code, 'UNIT_DIMENSION_MISMATCH');
    assert.equal(core.vialMath({ vialIU: 5000, diluentMl: 5, doseAmount: 1, doseUnit: 'mg' }).code, 'UNIT_DIMENSION_MISMATCH');
  });

  it('computes pre-mixed oilDrawMath and multi-component blendBreakdown accurately', () => {
    const oil = core.oilDrawMath({ concentrationMgPerMl: 200, vialMl: 10, doseAmount: 20, doseUnit: 'mg' });
    assert.equal(oil.ok, true);
    assert.equal(oil.oilPreMixed, true);
    assert.equal(oil.requiresReconstitution, false);
    assert.equal(oil.mlPerDose, 0.1);
    assert.equal(oil.unitsPerDose, 10);
    assert.equal(oil.dosesPerVial, 100);

    // Concentration mismatch guard
    const oilMismatch = core.oilDrawMath({ concentrationMgPerMl: 200, totalMg: 2500, vialMl: 10, doseMg: 50 });
    assert.equal(oilMismatch.ok, false);
    assert.equal(oilMismatch.code, 'CONCENTRATION_MISMATCH');

    // IU rejected on oil
    assert.equal(core.oilDrawMath({ concentrationMgPerMl: 200, doseAmount: 100, doseUnit: 'IU' }).code, 'UNIT_DIMENSION_MISMATCH');

    // Blend breakdown: KLOW 80 mg / 5 mL / 2000 mcg shot
    const klow = core.blendBreakdown({
      vialMg: 80,
      diluentMl: 5,
      doseMcg: 2000,
      ingredients: { 'ghk-cu': 0.625, 'bpc-157': 0.125, 'tb-500': 0.125, kpv: 0.125 },
    });
    assert.equal(klow.ok, true);
    assert.equal(klow.unitsPerDose, 12.5);
    const sumShot = klow.components.reduce((acc, c) => acc + c.mcgPerShot, 0);
    assert.ok(Math.abs(sumShot - 2000) < 1e-6);
    assert.equal(klow.components.find((c) => c.id === 'ghk-cu').mcgPerShot, 1250);

    // Unit-driven mode + unnormalized 0.333/0.333/0.333
    const third = core.blendBreakdown({
      vialMg: 15,
      diluentMl: 3,
      drawUnits: 10,
      ingredients: { a: 0.333, b: 0.333, c: 0.333 },
    });
    assert.equal(third.ok, true);
    assert.ok(Math.abs(third.totalDoseMcg - 500) < 1e-6);
    const sumThird = third.components.reduce((acc, c) => acc + c.mcgPerShot, 0);
    assert.ok(Math.abs(sumThird - third.totalDoseMcg) < 1e-6);
  });

  it('rotates through all 8 injection sites with strict member isolation and skip exclusion', () => {
    assert.equal(core.rotateSite(null), 'L abdomen');
    assert.equal(core.rotateSite('R delt'), 'L abdomen');

    let cur = null;
    const visited = [];
    for (let i = 0; i < 8; i++) {
      cur = core.rotateSite(cur);
      visited.push(cur);
    }
    assert.deepEqual(visited, [...core.INJECTION_SITES]);

    const logs = [
      { id: 'l1', memberId: 'member_wife', compoundId: 'bpc-157', datetime: '2026-11-20T08:00:00Z', site: 'L abdomen' },
      { id: 'l2', memberId: 'member_wife', compoundId: 'bpc-157', datetime: '2026-11-21T08:00:00Z', site: 'R abdomen', skipped: true },
      { id: 'l3', memberId: 'member_husband', compoundId: 'bpc-157', datetime: '2026-11-21T09:00:00Z', site: 'R delt' },
    ];
    // Wife's skipped R abdomen is ignored AND Husband's R delt does not leak to Wife
    const wifeNext = core.nextInjectionSite(logs, { memberId: 'member_wife', compoundId: 'bpc-157' });
    assert.equal(wifeNext.lastSite, 'L abdomen');
    assert.equal(wifeNext.nextSite, 'R abdomen');

    const husbandNext = core.nextInjectionSite(logs, { memberId: 'member_husband', compoundId: 'bpc-157' });
    assert.equal(husbandNext.lastSite, 'R delt');
    assert.equal(husbandNext.nextSite, 'L abdomen');
  });
});

// ---------------------------------------------------------------------------
// 6. Calculators — PK Decay, DST Calendar, Cycles, Run-Out & Advisory Gate
// ---------------------------------------------------------------------------
describe('Calculators — PK Decay, DST Calendar, Cycles, Run-Out & Advisory Dose Gate', () => {
  it('computes exact exponential PK decay, respects IU independence, refuses blends/unmodeled/route mismatch, and scales cleanly to 20k logs', () => {
    const t0 = Date.parse('2026-11-10T08:00:00Z');
    const entries = [{ at: t0, amount: 100, unit: 'mcg' }];

    assert.ok(Math.abs(core.remainingAt(entries, t0, 24) - 100) < 1e-8);
    assert.ok(Math.abs(core.remainingAt(entries, t0 + 24 * core.HOUR_MS, 24) - 50) < 1e-8);
    assert.ok(Math.abs(core.remainingAt(entries, t0 + 48 * core.HOUR_MS, 24) - 25) < 1e-8);
    // Future entry excluded
    assert.equal(core.remainingAt(entries, t0 - core.HOUR_MS, 24), 0);

    // Strict refusal invariants: blend, unmodeled, null, <=0, incompatible route
    const blend = core.STARTER_COMPOUNDS.find((c) => c.id === 'bpc157-tb500-blend');
    assert.equal(core.remainingAt(entries, t0 + core.HOUR_MS, blend), null);
    assert.equal(core.levelSeries(entries, t0 + core.HOUR_MS, blend), null);
    assert.equal(core.extractHalfLifeHours({ name: 'Fake Blend', halfLife: { valueHours: 12, kind: 'elimination' }, sectionData: { ingredients: { a: 0.5, b: 0.5 } } }), null);
    assert.equal(core.extractHalfLifeHours({ halfLife: { valueHours: 12, kind: 'unmodeled' } }), null);
    assert.equal(core.extractHalfLifeHours({ halfLife: { valueHours: null, kind: 'elimination' } }), null);
    assert.equal(core.extractHalfLifeHours({ halfLife: { valueHours: 0, kind: 'elimination' } }), null);
    assert.equal(core.extractHalfLifeHours({ halfLife: { valueHours: 17.5, route: 'Oral', kind: 'elimination' } }, { route: 'SL' }), null);

    // Trailing '+' guard: NAD+ with explicit halfLife IS modelable!
    const nadPlus = { name: 'NAD+', halfLife: { valueHours: 4, kind: 'elimination' } };
    assert.equal(core.extractHalfLifeHours(nadPlus), 4);
    assert.ok(Math.abs(core.remainingAt(entries, t0 + 4 * core.HOUR_MS, nadPlus) - 50) < 1e-8);

    // IU independence & mixed IU+mass refusal
    const hcg = core.STARTER_COMPOUNDS.find((c) => c.id === 'hcg');
    const hcgRes = core.buildCompoundLevels({
      compound: hcg,
      memberId: 'member_husband',
      now: t0 + 33 * core.HOUR_MS,
      logs: [
        { id: 'h1', memberId: 'member_husband', compoundId: 'hcg', datetime: '2026-11-10T08:00:00Z', doseAmount: 500, doseUnit: 'IU', route: 'SubQ' },
        { id: 'h_unassigned', compoundId: 'hcg', datetime: '2026-11-10T08:00:00Z', doseAmount: 500, doseUnit: 'IU' },
      ],
    });
    assert.equal(hcgRes.modelable, true);
    assert.equal(hcgRes.dimension, 'IU');
    assert.ok(Math.abs(hcgRes.remaining - 250) < 1e-6);
    assert.equal(hcgRes.formattedRemaining, '250 IU');
    assert.equal(hcgRes.ignored.unassigned, 1);

    // Untagged HCG log refused (never assumed to be mass)
    const hcgUntagged = core.buildCompoundLevels({
      compound: hcg,
      memberId: 'member_husband',
      now: t0 + 33 * core.HOUR_MS,
      logs: [{ id: 'h2', memberId: 'member_husband', compoundId: 'hcg', datetime: '2026-11-10T08:00:00Z', doseMcg: 500 }],
    });
    assert.equal(hcgUntagged.modelable, false);

    // Mixed IU + mass entries return null
    const mixedEntries = [
      { at: t0, amount: 500, unit: 'IU' },
      { at: t0, amount: 500, unit: 'mcg' },
    ];
    assert.equal(core.remainingAt(mixedEntries, t0 + core.HOUR_MS, 24), null);
    assert.equal(core.levelSeries(mixedEntries, t0 + core.HOUR_MS, 24), null);

    // Uncertainty band & tiny positive residual floor
    const band = core.levelSeriesWithBand(entries, t0 + 48 * core.HOUR_MS, { valueHours: 24, minHours: 18, maxHours: 30, kind: 'elimination' }, { days: 2 });
    assert.ok(band && band.low && band.high);
    assert.ok(band.low.at(-1).amount < band.points.at(-1).amount);
    assert.ok(band.points.at(-1).amount < band.high.at(-1).amount);
    assert.equal(core.formatLevel(1e-12, 'mass'), '<0.01 mcg');
    assert.equal(core.formatLevel(1e-12, 'IU'), '<0.01 IU');

    // Performance & bounded output on 20,000 historical logs
    const many = [];
    const nowPerf = t0 + 2000 * 24 * core.HOUR_MS;
    for (let i = 0; i < 20_000; i++) {
      many.push({ at: nowPerf - (i + 1) * 2 * core.HOUR_MS, amount: 100 });
    }
    const startMs = Date.now();
    const seriesPerf = core.levelSeries(many, nowPerf, 24, { days: 1, samples: 120 });
    const elapsed = Date.now() - startMs;
    assert.ok(Array.isArray(seriesPerf));
    assert.ok(seriesPerf.length <= 160);
    assert.ok(elapsed < 250, `Expected fast O(logs+samples) sweep, took ${elapsed}ms`);
    assert.ok(Math.abs(seriesPerf.at(-1).amount - core.remainingAt(many, nowPerf, 24)) < 1e-6);

    // Invalid calendar dates in parseDoseTime
    assert.ok(Number.isNaN(core.parseDoseTime('2026-02-30T12:00')));
    assert.ok(Number.isNaN(core.parseDoseTime('2026-02-29T12:00')));
    assert.ok(Number.isNaN(core.parseDoseTime('2026-03-08')));

    // Latest-edit deduplication: editing a logged dose to skipped:true removes exposure
    const tadalafil = core.STARTER_COMPOUNDS.find((c) => c.id === 'tadalafil');
    const skipOverride = core.buildCompoundLevels({
      compound: tadalafil,
      memberId: 'member_husband',
      now: t0 + 2 * core.HOUR_MS,
      logs: [
        { id: 'dup_1', memberId: 'member_husband', compoundId: 'tadalafil', datetime: '2026-11-10T08:00:00Z', doseAmount: 5, doseUnit: 'mg', route: 'Oral', updatedAt: '2026-11-10T08:01:00Z' },
        { id: 'dup_1', memberId: 'member_husband', compoundId: 'tadalafil', datetime: '2026-11-10T08:00:00Z', doseAmount: 5, doseUnit: 'mg', route: 'Oral', skipped: true, updatedAt: '2026-11-10T08:05:00Z' },
      ],
    });
    assert.equal(skipOverride.modelable, true);
    assert.equal(skipOverride.remaining, 0);
    assert.equal(skipOverride.ignored.duplicate, 1);
    assert.equal(skipOverride.ignored.skipped, 1);
  });

  it('guards nonexistent DST spring-forward wall-clock times and UTC-noon calendar math under TZ=America/New_York', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { parseDoseTime, dkAdd, dkDiff, HOUR_MS } from './src/core/index.js';
         const gap = parseDoseTime('2026-03-08T02:30');
         const before = parseDoseTime('2026-03-08T01:30');
         const after = parseDoseTime('2026-03-08T03:30');
         console.log(JSON.stringify({
           gapIsNaN: Number.isNaN(gap),
           springDiffHours: (after - before) / HOUR_MS,
           springAdd: dkAdd('2026-03-08', 1),
           fallAdd: dkAdd('2026-11-01', 1),
           springDiffDays: dkDiff('2026-03-09', '2026-03-07'),
         }));`,
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, TZ: 'America/New_York' },
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.gapIsNaN, true);
    assert.equal(parsed.springDiffHours, 1);
    assert.equal(parsed.springAdd, '2026-03-09');
    assert.equal(parsed.fallAdd, '2026-11-02');
    assert.equal(parsed.springDiffDays, 2);
  });

  it('performs DST-safe UTC-noon calendar math, dated timeline revisions, and all cycleStatus phases', () => {
    // US Spring-Forward & Fall-Back + Leap Year
    assert.equal(core.dkAdd('2026-03-08', 1), '2026-03-09');
    assert.equal(core.dkDiff('2026-03-09', '2026-03-07'), 2);
    assert.equal(core.dkAdd('2026-11-01', 1), '2026-11-02');
    assert.equal(core.dkDiff('2026-11-02', '2026-10-31'), 2);
    assert.equal(core.dkAdd('2024-02-28', 1), '2024-02-29');
    assert.ok(Number.isNaN(core.dkParse('2026-02-29')));
    assert.ok(Number.isNaN(core.dkParse('2026-04-31')));

    // cycleStatus phases: upcoming, active, ending_soon, off_cycle, expired, continuous, inactive
    const repeating = { startDate: '2026-11-01', cycleDays: 30, offDays: 30 };
    assert.equal(core.cycleStatus(repeating, '2026-10-25').phase, 'upcoming');
    assert.equal(core.cycleStatus(repeating, '2026-11-10').status, 'active_day_10_of_30');
    assert.equal(core.cycleStatus(repeating, '2026-11-28').phase, 'ending_soon');
    const off = core.cycleStatus(repeating, '2026-12-05');
    assert.equal(off.phase, 'off_cycle');
    assert.equal(off.isActive, false);
    assert.equal(off.nextOnDate, '2026-12-31');

    const finite = { startDate: '2026-11-01', cycleDays: 14 };
    assert.equal(core.cycleStatus(finite, '2026-11-20').phase, 'expired');
    assert.equal(core.cycleStatus({ continuous: true }, '2026-11-20').phase, 'continuous');
    assert.equal(core.cycleStatus({ active: false }, '2026-11-20').phase, 'inactive');

    // Dated timeline revisions & materializePlan identity invariant
    let plan = { id: 'p1', startDate: '2026-11-01', doseAmount: 250, doseUnit: 'mcg', schedule: { days: [1, 3, 5] } };
    plan = core.applyRevision(plan, '2026-11-15', { id: 'rev_bump', doseAmount: 500, schedule: { every: 2, anchor: '2026-11-15' } }, '2026-11-10');
    assert.equal(core.planAt(plan, '2026-11-10').doseAmount, 250);
    assert.equal(core.planAt(plan, '2026-11-15').doseAmount, 500);
    assert.equal(core.cycleStatus(plan, '2026-11-10').nextRevision.from, '2026-11-15');

    // materializePlan returns exact === reference when unchanged
    const mat1 = core.materializePlan(plan, '2026-11-10');
    const mat2 = core.materializePlan(mat1, '2026-11-10');
    assert.equal(mat1, mat2);

    const afterRemove = core.removeRevision(plan, 'rev_bump', '2026-11-20');
    assert.equal(core.planAt(afterRemove, '2026-11-20').doseAmount, 250);
  });

  it('projects supply run-out (<=3 doses warning, loggedToday shift, PRN) and computes adherence cleanly', () => {
    assert.equal(core.deductSupply(100, 150), 0);

    const dailyPlan = { startDate: '2026-11-01', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } };
    const r3 = core.projectSupplyRunOut({ remainingDoses: 3, plan: dailyPlan, todayDk: '2026-11-10', loggedToday: false });
    assert.equal(r3.lowStock, true);
    assert.equal(r3.suggestedOwnershipStatus, 'low_stock');
    assert.equal(r3.lastCoveredDateKey, '2026-11-12');
    assert.equal(r3.runOutDateKey, '2026-11-13');

    const r3Logged = core.projectSupplyRunOut({ remainingDoses: 3, plan: dailyPlan, todayDk: '2026-11-10', loggedToday: true });
    assert.equal(r3Logged.runOutDateKey, '2026-11-14');

    const r0 = core.projectSupplyRunOut({ remainingDoses: 0, plan: dailyPlan, todayDk: '2026-11-10' });
    assert.equal(r0.depleted, true);
    assert.equal(r0.suggestedOwnershipStatus, 'dont_have');

    const rPrn = core.projectSupplyRunOut({ remainingDoses: 5, plan: { schedule: { days: [] } }, todayDk: '2026-11-10' });
    assert.equal(rPrn.runOutDateKey, null);

    // Adherence: skipped != taken, strict member isolation
    const adh = core.computeAdherence({
      plan: { compoundId: 'bpc-157', startDate: '2026-11-01', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
      memberId: 'member_wife',
      todayDk: '2026-11-04',
      days: 4,
      logs: [
        { memberId: 'member_wife', compoundId: 'bpc-157', datetime: '2026-11-01T08:00:00Z' },
        { memberId: 'member_wife', compoundId: 'bpc-157', datetime: '2026-11-02T08:00:00Z', skipped: true },
        { memberId: 'member_husband', compoundId: 'bpc-157', datetime: '2026-11-03T08:00:00Z' },
        { memberId: 'member_wife', compoundId: 'bpc-157', datetime: '2026-11-04T08:00:00Z' },
      ],
    });
    assert.equal(adh.expected, 4);
    assert.equal(adh.taken, 2);
    assert.equal(adh.skipped, 1);
    assert.equal(adh.missed, 1);
    assert.equal(adh.pct, 50);
  });

  it('enforces Advisory Dose-Sanity Gate: hard-blocks ONLY missing/<=0/non-finite and softens all warnings to CONFIRM + needsReview', () => {
    // Hard blocks that stay blocked even after softenVerdict
    for (const badDose of [0, -50, NaN, Infinity, null, undefined, '', true]) {
      const v = core.evaluateAdvisoryDose(
        { doseAmount: badDose, doseUnit: 'mcg', compoundId: 'bpc-157' },
        { knownCompound: false, priorDoseAmount: 250, priorUnit: 'mcg' },
      );
      assert.equal(v.decision, 'BLOCK', `Expected hard BLOCK for dose=${String(badDose)}`);
      assert.equal(v.hardBlocked, true);
      assert.equal(v.unwritable, true);
    }

    // >=5x dose jump -> BLOCK in evaluateDose, softened to CONFIRM + needsReview by softenVerdict
    const jumpRaw = core.evaluateDose(
      { doseAmount: 1500, doseUnit: 'mcg', compoundId: 'bpc-157' },
      { knownCompound: true, priorDoseAmount: 250, priorUnit: 'mcg' },
    );
    assert.equal(jumpRaw.decision, 'BLOCK');
    assert.ok(jumpRaw.flags.includes('DOSE_JUMP_5X'));
    const jumpSoft = core.softenVerdict(jumpRaw);
    assert.equal(jumpSoft.decision, 'CONFIRM');
    assert.equal(jumpSoft.hardBlocked, false);
    assert.equal(jumpSoft.wasBlocked, true);
    assert.equal(jumpSoft.needsReview, true);

    // Unit switch & ceiling breach soften to CONFIRM + needsReview
    const switchSoft = core.evaluateAdvisoryDose(
      { doseAmount: 50, doseUnit: 'mg', compoundId: 'tadalafil' },
      { knownCompound: true, priorDoseAmount: 5, priorUnit: 'mcg' },
    );
    assert.equal(switchSoft.decision, 'CONFIRM');
    assert.ok(switchSoft.flags.includes('UNIT_SWITCH'));
    assert.ok(switchSoft.flags.includes('CEILING_BREACH'));
    assert.equal(switchSoft.needsReview, true);

    // Exact scheduled match -> PASS
    const pass = core.evaluateAdvisoryDose(
      { doseAmount: 250, doseUnit: 'mcg', compoundId: 'bpc-157', route: 'SubQ' },
      { knownCompound: true, scheduledDoseAmount: 250, scheduledDoseUnit: 'mcg', scheduledRoute: 'SubQ' },
    );
    assert.equal(pass.decision, 'PASS');
    assert.equal(pass.needsReview, false);
  });
});

// ---------------------------------------------------------------------------
// 7. Sync, LWW Merge & 90-Day Tombstones
// ---------------------------------------------------------------------------
describe('Sync, LWW Merge & 90-Day Tombstones', () => {
  it('parses revisions including Cloudflare weak ETags and produces key-order-independent stableStringify', () => {
    assert.equal(core.parseRevision(5), 5);
    assert.equal(core.parseRevision('12'), 12);
    assert.equal(core.parseRevision('"7"'), 7);
    assert.equal(core.parseRevision('W/"7"'), 7);
    assert.equal(core.parseRevision('w/"0"'), 0);
    assert.equal(core.parseRevision(-1), null);
    assert.equal(core.parseRevision('invalid'), null);
    assert.equal(core.nextRevision('W/"7"'), 8);

    assert.equal(core.stableStringify({ b: 2, a: { d: 4, c: 3 } }), core.stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('prepareSyncState stamps changes, is idempotent, tombstones deletions, clears on revival, and prunes >90d', () => {
    const T1 = '2026-08-01T00:00:00.000Z';
    const T2 = '2026-08-02T00:00:00.000Z';
    const T_91 = '2026-10-31T00:00:01.000Z'; // >90 days after T1

    const initial = core.createEmptyHubState({ now: T1 });
    initial.compounds.push({ id: 'c1', name: 'BPC-157', sectionId: 'peptides' }); // unstamped
    initial.compounds.push({ id: 'c2', name: 'Tadalafil', sectionId: 'peds', updatedAt: T1 });

    const p1 = core.prepareSyncState(initial, null, T1);
    assert.equal(p1.changed, true);
    assert.equal(p1.stampedCount, 1);
    assert.equal(p1.state.compounds[0].updatedAt, T1);

    // Idempotency against snapshotState
    const snap1 = core.snapshotState(p1.state);
    const pIdem = core.prepareSyncState(p1.state, snap1, T2);
    assert.equal(pIdem.changed, false);
    assert.equal(pIdem.stampedCount, 0);

    // Delete c2 -> tombstone recorded
    const afterDel = core.deepClone(p1.state);
    afterDel.compounds = afterDel.compounds.filter((c) => c.id !== 'c2');
    const pDel = core.prepareSyncState(afterDel, snap1, T1);
    assert.equal(pDel.tombstonedCount, 1);
    assert.equal(pDel.state.meta.tombstones.compounds.c2, T1);

    // 89 days later: tombstone kept
    const p89 = core.pruneTombstones(pDel.state.meta.tombstones, '2026-10-29T00:00:00.000Z', 90);
    assert.equal(p89.prunedCount, 0);
    assert.equal(p89.tombstones.compounds.c2, T1);

    // 91 days later: tombstone pruned
    const p91 = core.pruneTombstones(pDel.state.meta.tombstones, T_91, 90);
    assert.equal(p91.prunedCount, 1);
    assert.equal(p91.tombstones.compounds.c2, undefined);

    // Revival clears stale tombstone
    const revived = core.deepClone(pDel.state);
    revived.compounds.push({ id: 'c2', name: 'Tadalafil Reborn', sectionId: 'peds' });
    const pRev = core.prepareSyncState(revived, core.snapshotState(pDel.state), T2);
    assert.equal(pRev.state.meta.tombstones.compounds.c2, undefined);
  });

  it('merges local and remote states with LWW, timezone-safe timestamps, deletion retention, and non-mutation', () => {
    const local = {
      _rev: 3,
      compounds: [
        { id: 'c1', name: 'Local Newer', updatedAt: '2026-11-20T12:00:00Z' },
        { id: 'c2', name: 'Tie Local', updatedAt: '2026-11-20T10:00:00Z' },
        { id: 'c_revived', name: 'Recreated After Delete', updatedAt: '2026-11-20T15:00:00Z' },
      ],
      auditLog: [{ id: 'a2', timestamp: '2026-11-20T12:00:00Z', action: 'b' }],
      settings: { householdName: 'Local Home', updatedAt: '2026-11-20T09:00:00Z' },
      meta: {
        migrations: ['m1'],
        tombstones: { compounds: { c_deleted: '2026-11-20T14:00:00Z' } },
      },
    };

    const remote = {
      _rev: 5,
      compounds: [
        // +02:00 timestamp representing 11:00Z (older than local 12:00Z despite higher hour string!)
        { id: 'c1', name: 'Remote Older TZ', updatedAt: '2026-11-20T13:00:00+02:00' },
        { id: 'c2', name: 'Tie Remote', updatedAt: '2026-11-20T10:00:00Z' },
        { id: 'c_deleted', name: 'Stale Deleted Copy', updatedAt: '2026-11-20T10:00:00Z' },
        { id: 'c_remote_only', name: 'Remote Only', updatedAt: '2026-11-20T11:00:00Z' },
      ],
      auditLog: [{ id: 'a1', timestamp: '2026-11-20T08:00:00Z', action: 'a' }],
      settings: { householdName: 'Remote Newer Home', updatedAt: '2026-11-20T16:00:00Z' },
      meta: {
        migrations: ['m2'],
        tombstones: { compounds: { c_revived: '2026-11-20T12:00:00Z' } },
      },
    };

    const localSnapshot = JSON.stringify(local);
    const merged = core.mergeStates(local, remote, { nowIso: '2026-11-21T00:00:00Z' });
    assert.equal(JSON.stringify(local), localSnapshot, 'mergeStates must not mutate localState');

    const byId = new Map(merged.compounds.map((c) => [c.id, c]));
    assert.equal(byId.get('c1').name, 'Local Newer');
    assert.equal(byId.get('c2').name, 'Tie Local');
    assert.equal(byId.get('c_deleted'), undefined, 'Stale deleted record must stay deleted');
    assert.equal(byId.get('c_revived').name, 'Recreated After Delete');
    assert.equal(byId.get('c_remote_only').name, 'Remote Only');
    assert.equal(merged.settings.householdName, 'Remote Newer Home');
    assert.equal(merged._rev, 5);
    assert.deepEqual(merged.auditLog.map((a) => a.id), ['a1', 'a2']);
    assert.ok(merged.meta.migrations.includes('m1') && merged.meta.migrations.includes('m2'));

    // Merging empty {} local with populated remote works cleanly
    const fromEmpty = core.mergeStates({}, remote, { nowIso: '2026-11-21T00:00:00Z' });
    assert.equal(fromEmpty.compounds.length, 4);
  });
});

// ---------------------------------------------------------------------------
// 8. Hub JSON Export, Validation & Import + Secret Stripping
// ---------------------------------------------------------------------------
describe('Hub JSON Export, Validation & Import', () => {
  it('round-trips losslessly, revives tombstoned items on restore, rejects bad payloads, and strips all secrets', () => {
    const T = '2026-11-21T12:00:00.000Z';
    const base = core.seedStarterCatalog(core.createEmptyHubState({ now: T }), { nowIso: T }).state;
    base.ownership.push({ id: 'own_1', compoundId: 'bpc-157', scope: 'household', status: 'have', updatedAt: T });

    // Pollute state with every secret field class
    const polluted = {
      ...core.deepClone(base),
      apiKeys: [{ id: 'k1', secret: 'hp_live_topsecret999' }],
      oauthTokens: [{ accessToken: 'tok_secret_123' }],
      pinHash: 'sha256_deadbeef',
      passcode: '9999',
      settings: { ...base.settings, byokApiKey: 'sk-proj-supersecret123456', syncToken: 'sync_secret_777' },
    };

    const exported = core.exportHubJson(polluted, { exportedAt: T });
    const exportedStr = JSON.stringify(exported);
    assert.equal(exported._format, 'home-pharmacy-export/v1');
    for (const leaked of ['apiKeys', 'oauthTokens', 'pinHash', 'passcode', 'byokApiKey', 'syncToken', 'hp_live_topsecret999', 'sk-proj-supersecret123456', 'sync_secret_777']) {
      assert.equal(exportedStr.includes(leaked), false, `Export leaked secret token/key: ${leaked}`);
    }

    // Validate with 1 malformed row skipped
    const withBadRow = core.deepClone(exported);
    withBadRow.compounds.push({ bad: true });
    const val = core.validateHubExport(withBadRow);
    assert.equal(val.ok, true);
    assert.equal(val.skipped, 1);

    // Failed import does not mutate state
    const curState = core.createEmptyHubState({ now: T });
    curState.meta.tombstones.compounds['bpc-157'] = T;
    const badRes = core.importHubJson(curState, '{not valid json');
    assert.equal(badRes.ok, false);
    assert.equal(curState.compounds.length, 0);

    // Valid import restores tombstoned ID and clears tombstone
    const imp = core.importHubJson(curState, exported, { mode: 'merge', nowIso: T });
    assert.equal(imp.ok, true);
    assert.equal(imp.state.compounds.length, 26);
    assert.equal(imp.state.meta.tombstones.compounds['bpc-157'], undefined);
  });
});

// ---------------------------------------------------------------------------
// 9. Lossless protocol-os-export/v1 Importer
// ---------------------------------------------------------------------------
describe('Lossless protocol-os-export/v1 Importer', () => {
  it('imports protocols, vials, storage, logs, IU units, oils, pen mixes, timelines losslessly and idempotently', () => {
    const NOW = '2026-11-21T12:00:00.000Z';
    const fixture = {
      _format: 'protocol-os-export/v1',
      exportedAt: NOW,
      activeProfile: 'member_wife',
      protocols: [
        {
          id: 'pr_bpc',
          profile: 'member_wife',
          peptideId: 'bpc157',
          peptideName: 'BPC-157',
          doseMcg: 250,
          doseUnit: 'mcg',
          route: 'sc',
          startDate: '2026-11-01',
          cycleDays: 42,
          schedule: { every: 2, anchor: '2026-11-01', timeOfDay: 'am' },
          timeline: [
            { id: 'tl_0', from: null, doseMcg: 250 },
            { id: 'tl_1', from: '2026-11-15', doseMcg: 500 },
          ],
        },
        {
          id: 'pr_trt',
          profile: 'member_husband',
          peptideId: 'testosterone-cypionate',
          peptideName: 'Testosterone Cypionate',
          doseMcg: 50000,
          doseUnit: 'mg',
          route: 'im',
          oil: true,
          schedule: { days: [1, 4], timeOfDay: 'am' },
        },
        {
          id: 'pr_hcg',
          profile: 'member_husband',
          peptideId: 'hcg',
          peptideName: 'HCG',
          doseMcg: 500,
          doseUnit: 'IU',
          route: 'sc',
          schedule: { days: [1, 4] },
        },
        {
          id: 'pr_pen',
          profile: 'member_wife',
          peptideId: '__pen__',
          peptideName: 'Recovery Pen Mix',
          isPen: true,
          penName: 'Recovery Pen Mix',
          penComponents: [
            { peptideId: 'bpc-157', mcg: 5000 },
            { peptideId: 'tb-500', mcg: 5000 },
          ],
          doseMcg: 500,
          route: 'pen',
          schedule: { days: [1, 3, 5] },
        },
        {
          id: 'pr_archived',
          profile: 'member_wife',
          peptideId: 'semax',
          peptideName: 'Semax',
          doseMcg: 300,
          route: 'nasal',
          active: false,
          schedule: { days: [1, 2, 3, 4, 5] },
        },
      ],
      vials: [
        { id: 'v_bpc', peptideId: 'bpc157', peptideName: 'BPC-157', vialMg: 5, diluentMl: 2, totalMcg: 5000, remainingMcg: 4000 },
        { id: 'v_oil', peptideId: 'testosterone-cypionate', peptideName: 'Testosterone Cypionate', oil: true, concentrationMgPerMl: 200, vialMl: 10, totalMcg: 2_000_000, remainingMcg: 1_500_000, inventoryProfile: 'member_husband' },
        { id: 'v_hcg', peptideId: 'hcg', peptideName: 'HCG', vialIU: 5000, diluentMl: 5, doseUnit: 'IU', remainingDoses: 2 },
        { id: 'v_empty', peptideId: 'semax', peptideName: 'Semax', vialMg: 5, remainingMcg: 0 },
        {
          id: 'v_pen',
          peptideId: '__pen__',
          penName: 'Recovery Pen Mix',
          isPen: true,
          penColor: 'gold',
          penComponents: [
            { peptideId: 'bpc-157', mcg: 5000 },
            { peptideId: 'tb-500', mcg: 5000 },
          ],
          vialMg: 10,
          diluentMl: 2,
          remainingMcg: 5000,
        },
      ],
      storage: [
        { id: 's_1', peptideId: 'bpc157', peptideName: 'BPC-157', vialCount: 3, vialMg: 5 },
      ],
      logs: [
        { id: 'lg_1', protocolId: 'pr_bpc', profile: 'member_wife', peptideId: 'bpc157', datetime: '2026-11-10T08:00:00Z', doseMcg: 250, doseUnit: 'mcg', route: 'sc', site: 'L abdomen' },
        { id: 'lg_skip', protocolId: 'pr_bpc', profile: 'member_wife', peptideId: 'bpc157', datetime: '2026-11-12T08:00:00Z', doseMcg: 0, skipped: true },
        { id: 'lg_iu', protocolId: 'pr_hcg', profile: 'member_husband', peptideId: 'hcg', datetime: '2026-11-11T08:00:00Z', doseMcg: 500, doseUnit: 'IU', backfilled: true, needsReview: true },
        { id: 'lg_bad', datetime: null }, // malformed -> skipped
      ],
      meta: { migrations: ['v2_units'] },
    };

    // Start with a verified BPC-157 profile to prove import reuses it without overwriting verified data
    const state0 = core.createEmptyHubState({ now: NOW });
    const verifiedBpc = core.deepClone(core.STARTER_COMPOUNDS.find((c) => c.id === 'bpc-157'));
    state0.compounds.push(verifiedBpc);

    const res1 = core.importProtocolOsExport(state0, fixture, { nowIso: NOW });
    assert.equal(res1.ok, true);
    assert.equal(res1.summary.skipped, 1);
    assert.equal(res1.summary.logsUpserted, 3);

    // Verified BPC-157 reused and untouched
    const bpcAfter = res1.state.compounds.find((c) => c.id === 'bpc-157');
    assert.equal(bpcAfter.profileStatus, 'verified');
    assert.equal(bpcAfter.summary, verifiedBpc.summary);

    // Section classification: Test Cyp & HCG -> peds; Pen mix -> peptides + unmodeled halfLife
    const cyp = res1.state.compounds.find((c) => c.name.includes('Testosterone Cypionate'));
    assert.equal(cyp.sectionId, 'peds');
    assert.equal(cyp.sectionData.oilPreMixed, true);

    const penCmp = res1.state.compounds.find((c) => c.name === 'Recovery Pen Mix');
    assert.equal(penCmp.sectionId, 'peptides');
    assert.equal(penCmp.halfLife.kind, 'unmodeled');
    assert.equal(penCmp.sectionData.form, 'pen');

    // Ownership statuses: low_stock (<=3 doses), dont_have (0 remaining), member-scoped oil vial
    assert.equal(res1.state.ownership.find((o) => o.id === 'pos_vial_v_hcg').status, 'low_stock');
    assert.equal(res1.state.ownership.find((o) => o.id === 'pos_vial_v_empty').status, 'dont_have');
    assert.equal(res1.state.ownership.find((o) => o.id === 'pos_vial_v_oil').scope, 'member:member_husband');

    // Logs preserved IU, skipped, backfilled, needsReview cleanly
    const iuLog = res1.state.logs.find((l) => l.id === 'pos_log_lg_iu');
    assert.equal(iuLog.doseUnit, 'IU');
    assert.equal(iuLog.doseValue, 500);
    assert.equal(iuLog.doseMcg, null);
    assert.equal(iuLog.backfilled, true);
    assert.equal(iuLog.needsReview, true);

    const skipLog = res1.state.logs.find((l) => l.id === 'pos_log_lg_skip');
    assert.equal(skipLog.skipped, true);

    // Stack timeline revisions preserved verbatim
    const wifeStack = res1.state.stacks.find((s) => s.memberId === 'member_wife');
    const bpcItem = wifeStack.items.find((it) => it.id === 'pos_item_pr_bpc');
    assert.equal(bpcItem.timeline.length, 2);
    assert.equal(bpcItem.timeline[1].from, '2026-11-15');

    // 100% Idempotency on repeat import
    const res2 = core.importProtocolOsExport(res1.state, fixture, { nowIso: NOW });
    assert.equal(res2.ok, true);
    assert.equal(res2.summary.compoundsCreated, 0);
    assert.equal(res2.state.compounds.length, res1.state.compounds.length);
    assert.equal(res2.state.ownership.length, res1.state.ownership.length);
    assert.equal(res2.state.logs.length, res1.state.logs.length);
    assert.equal(
      res2.state.stacks.find((s) => s.memberId === 'member_wife').items.length,
      wifeStack.items.length,
    );

    // Rejects Home Pharmacy export format & invalid JSON without mutating state
    const wrongFmt = core.importProtocolOsExport(state0, { _format: 'home-pharmacy-export/v1' });
    assert.equal(wrongFmt.ok, false);
    assert.equal(state0.compounds.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 10. CSV Export & Formula-Injection Neutralization
// ---------------------------------------------------------------------------
describe('CSV Export & Formula-Injection Neutralization', () => {
  it('emits UTF-8 BOM, CRLF, RFC 4180 quoting, and neutralizes every spreadsheet formula trigger', () => {
    const triggers = [
      '=SUM(A1)',
      '+1+1',
      '-2+3',
      '@cmd',
      '\t=1+1',
      '\r=1+1',
      '  =HYPERLINK("http://evil.example")',
    ];
    for (const raw of triggers) {
      const escaped = core.escapeCsvCell(raw);
      const unwrapped = escaped.startsWith('"') && escaped.endsWith('"') ? escaped.slice(1, -1).replace(/""/g, '"') : escaped;
      assert.equal(unwrapped.startsWith("'"), true, `Failed to neutralize formula trigger: ${JSON.stringify(raw)} -> ${escaped}`);
    }

    assert.equal(core.escapeCsvCell('a, "b"\nc'), '"a, ""b""\nc"');

    const state = core.createEmptyHubState({ now: '2026-11-21T00:00:00Z' });
    const evilCompound = core.normalizeCompoundProfile({
      id: 'c_evil',
      name: '=CMD|calc',
      sectionId: 'peptides',
      summary: 'Has, comma and "quote"',
    });
    // Simulate untrimmed stored notes with leading whitespace before '=' formula
    evilCompound.notes = '  =HYPERLINK("http://bad.example")';
    state.compounds.push(evilCompound);
    state.ownership.push({ id: 'o_evil', compoundId: 'c_evil', scope: 'household', status: 'have' });
    state.logs.push({ id: 'l_evil', memberId: 'member_wife', compoundId: 'c_evil', datetime: '2026-11-21T08:00:00Z', doseAmount: 250, doseUnit: 'mcg', notes: '+SUM(1,2)' });

    const csv = core.exportCompoundsCsv(state, { sectionId: 'peptides', ownershipStatus: 'have' });
    assert.equal(csv.startsWith('\uFEFF'), true);
    assert.ok(csv.includes('\r\n'));
    assert.ok(csv.includes("'=CMD|calc"));
    assert.ok(csv.includes('"Has, comma and ""quote"""'));
    assert.ok(csv.includes(`"'  =HYPERLINK(""http://bad.example"")"`));

    const logsCsv = core.exportLogsCsv(state, { memberId: 'member_wife' });
    assert.equal(logsCsv.startsWith('\uFEFF'), true);
    assert.ok(logsCsv.includes("'+SUM(1,2)"));
  });
});

// ---------------------------------------------------------------------------
// 11. AI Context Bundle Builder & Secret Redaction
// ---------------------------------------------------------------------------
describe('AI Context Bundle Builder & Secret Redaction', () => {
  it('builds token-efficient md and json bundles, retains active-stack missing items, warns over budget, and redacts all secrets', () => {
    const T = '2026-11-21T00:00:00Z';
    const state = core.seedStarterCatalog(core.createEmptyHubState({ now: T }), { nowIso: T }).state;
    state.ownership.push({ id: 'o1', compoundId: 'bpc-157', scope: 'household', status: 'have', updatedAt: T });
    state.stacks.push({
      id: 'st_wife',
      memberId: 'member_wife',
      name: 'Wife Core Stack',
      active: true,
      items: [
        { id: 'i1', compoundId: 'bpc-157', doseAmount: 250, doseUnit: 'mcg', route: 'SubQ' },
        { id: 'i2', compoundId: 'ipamorelin', doseAmount: 200, doseUnit: 'mcg', route: 'SubQ' }, // dont_have, but in active stack!
      ],
    });

    // Inject secrets into both top-level keys AND compound free-text notes
    state.apiKeys = [{ secret: 'hp_live_keyleak999' }];
    state.oauthTokens = [{ accessToken: 'oauth_tok_secret' }];
    state.pinHash = 'pin_hash_leak';
    const bpc = state.compounds.find((c) => c.id === 'bpc-157');
    bpc.notes =
      'Auth Bearer tok_1234567890 key sk-proj-abc1234567890123 google AIzaSyFakeKey12345678901234567890 hp hp_live_secret12345 passcode=9876 url https://example.org/?token=mysecret123';

    const mdBundle = core.buildContextBundle(state, {
      format: 'md',
      memberId: 'member_wife',
      sectionIds: ['peptides'],
      includeDontHave: false,
      includeFullProfiles: true,
      maxEstimatedTokens: 50, // force budget warning
      generatedAt: T,
    });

    assert.equal(mdBundle.format, 'md');
    assert.equal(mdBundle.stats.memberCount, 1);
    assert.equal(mdBundle.stats.sectionCount, 1);
    // Active stack item `ipamorelin` retained with [missing from stock] even though includeDontHave: false
    assert.ok(mdBundle.content.includes('Ipamorelin'));
    assert.ok(mdBundle.content.includes('[missing from stock]'));
    assert.equal(mdBundle.stats.exceedsTokenBudget, true);
    assert.ok(mdBundle.warnings.length >= 1);

    const jsonBundle = core.buildContextBundle(state, {
      format: 'json',
      memberId: 'member_wife',
      includeFullProfiles: true,
      generatedAt: T,
    });
    assert.equal(jsonBundle.format, 'json');

    const forbiddenSecrets = [
      'tok_1234567890',
      'sk-proj-abc1234567890123',
      'AIzaSyFakeKey12345678901234567890',
      'hp_live_secret12345',
      'hp_live_keyleak999',
      'oauth_tok_secret',
      'pin_hash_leak',
      '9876',
      'mysecret123',
    ];
    for (const secret of forbiddenSecrets) {
      assert.equal(mdBundle.content.includes(secret), false, `MD bundle leaked secret: ${secret}`);
      assert.equal(jsonBundle.content.includes(secret), false, `JSON bundle leaked secret: ${secret}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Starter Catalog & Public-Repo Privacy Audit
// ---------------------------------------------------------------------------
describe('Starter Catalog & Public-Repo Privacy Audit', () => {
  it('validates all 26 starter compounds (>=85% completeness), multi-route siblings, blend unmodeled, stack templates, and idempotent seeding', () => {
    const sections = core.createDefaultSections();
    assert.equal(core.STARTER_COMPOUNDS.length, 26);

    const countsBySection = { peptides: 0, peds: 0, vitamins_supplements: 0, dermatology: 0 };
    for (const c of core.STARTER_COMPOUNDS) {
      countsBySection[c.sectionId] = (countsBySection[c.sectionId] || 0) + 1;
      const res = core.validateCompoundProfile(c, { sections, strict: true });
      assert.equal(res.ok, true, `Starter compound ${c.id} failed validation: ${JSON.stringify(res.errors)}`);
      assert.ok(res.completenessPct >= 85, `Starter compound ${c.id} completeness ${res.completenessPct} < 85`);
      assert.equal(c.provenance.sourceModel, 'starter');
      assert.ok(c.provenance.citations.length >= 1);
      for (const cit of c.provenance.citations) {
        assert.ok(cit.url.startsWith('https://'), `Citation URL for ${c.id} must be https://`);
      }
    }

    for (const secId of core.CORE_SECTION_IDS) {
      assert.ok(countsBySection[secId] >= 6, `Expected >=6 starter compounds in ${secId}, got ${countsBySection[secId]}`);
    }

    // Multi-route sibling pairs
    const ghkSubq = core.STARTER_COMPOUNDS.find((c) => c.id === 'ghk-cu-subq');
    const ghkTop = core.STARTER_COMPOUNDS.find((c) => c.id === 'ghk-cu-topical');
    assert.equal(ghkSubq.canonicalMolecule, 'ghk-cu');
    assert.equal(ghkTop.canonicalMolecule, 'ghk-cu');
    assert.ok(ghkSubq.relatedCompoundIds.includes('ghk-cu-topical'));
    assert.ok(ghkTop.relatedCompoundIds.includes('ghk-cu-subq'));
    assert.equal(core.checkDuplicateCompound(ghkTop, [ghkSubq]).classification, 'same_molecule_other_route');

    const finOral = core.STARTER_COMPOUNDS.find((c) => c.id === 'finasteride-oral');
    const finTop = core.STARTER_COMPOUNDS.find((c) => c.id === 'finasteride-topical');
    assert.equal(finOral.canonicalMolecule, 'finasteride');
    assert.equal(finTop.canonicalMolecule, 'finasteride');
    assert.ok(finOral.relatedCompoundIds.includes('finasteride-topical'));
    assert.ok(finTop.relatedCompoundIds.includes('finasteride-oral'));
    assert.equal(core.checkDuplicateCompound(finTop, [finOral]).classification, 'same_molecule_other_route');

    // Blend unmodeled & ingredients sum to 1.0
    const blend = core.STARTER_COMPOUNDS.find((c) => c.id === 'bpc157-tb500-blend');
    assert.equal(blend.halfLife.kind, 'unmodeled');
    assert.equal(blend.halfLife.valueHours, null);
    const sumIng = Object.values(blend.sectionData.ingredients).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sumIng - 1.0) < 1e-6);

    // All stack templates reference valid starter compound IDs
    const starterIdSet = new Set(core.STARTER_COMPOUNDS.map((c) => c.id));
    assert.equal(core.STARTER_STACK_TEMPLATES.length, 4);
    for (const tpl of core.STARTER_STACK_TEMPLATES) {
      for (const item of tpl.items) {
        assert.ok(starterIdSet.has(item.compoundId), `Template ${tpl.id} references unknown compound ${item.compoundId}`);
      }
    }

    // Idempotent seeding & preserves user edits
    const s0 = core.createEmptyHubState({ now: '2026-11-21T00:00:00Z' });
    const seed1 = core.seedStarterCatalog(s0, { createOwnershipRecords: true, nowIso: '2026-11-21T00:00:00Z' });
    assert.equal(seed1.added, 26);
    assert.equal(seed1.skipped, 0);
    assert.equal(seed1.state.ownership.length, 26);

    seed1.state.compounds[0].notes = 'User custom personal note';
    const seed2 = core.seedStarterCatalog(seed1.state, { nowIso: '2026-11-21T01:00:00Z' });
    assert.equal(seed2.added, 0);
    assert.equal(seed2.skipped, 26);
    assert.equal(seed2.state.compounds[0].notes, 'User custom personal note');
  });

  it('passes public-repo privacy audit (zero emails, tokens, local paths, or personal data in defaults & starter catalog)', () => {
    const serialized = JSON.stringify({
      members: core.DEFAULT_MEMBERS,
      sections: core.DEFAULT_SECTIONS,
      settings: core.DEFAULT_HOUSEHOLD_SETTINGS,
      compounds: core.STARTER_COMPOUNDS,
      templates: core.STARTER_STACK_TEMPLATES,
    });

    assert.equal(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(serialized), false, 'Found email address in public starter data');
    assert.equal(/\b(?:sk-|AIza|ghp_|gho_|xai-|hp_live_|Bearer\s+)/.test(serialized), false, 'Found API token prefix in public starter data');
    assert.equal(/(?:\/Users\/|\/home\/|C:\\Users\\)/.test(serialized), false, 'Found local filesystem path in public starter data');
    assert.deepEqual(core.DEFAULT_MEMBERS.map((m) => m.name), ['Wife', 'Husband']);
  });
});

// ---------------------------------------------------------------------------
// 13. Regression Hardening — Dedup, Schema, Calculators, Sync & Security
// ---------------------------------------------------------------------------
describe('Regression Hardening — Dedup, Schema, Calculators, Sync & Security', () => {
  it('enforces .gitignore *.sqlite*, deepClone prototype guard, aligned test-cyp ceiling, and HCG SubQ / IM route', () => {
    const gitignore = readFileSync(path.resolve(__dirname, '../../.gitignore'), 'utf8');
    assert.ok(gitignore.split(/\r?\n/).includes('*.sqlite*'), '.gitignore must include *.sqlite*');

    // Aligned ceiling: test-cyp matches testosterone-cypionate (500 mg)
    assert.equal(core.DEFAULT_DOSE_CEILINGS['test-cyp'].maxAmount, 500);
    assert.equal(core.DEFAULT_DOSE_CEILINGS['test-cyp'].maxMcg, core.DEFAULT_DOSE_CEILINGS['testosterone-cypionate'].maxMcg);
    const cyp100 = core.evaluateDose({ doseAmount: 100, doseUnit: 'mg', compoundId: 'test-cyp' }, { knownCompound: true });
    assert.equal(cyp100.flags.includes('CEILING_BREACH'), false);
    const cyp600 = core.evaluateDose({ doseAmount: 600, doseUnit: 'mg', compoundId: 'test-cyp' }, { knownCompound: true });
    assert.equal(cyp600.flags.includes('CEILING_BREACH'), true);

    // deepClone fallback strips __proto__, constructor, prototype when structuredClone throws (e.g. contains fn)
    const objWithFn = JSON.parse('{"safe":1,"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2}}');
    objWithFn.fn = () => {};
    const cloned = core.deepClone(objWithFn);
    assert.equal(cloned.safe, 1);
    assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
    assert.equal(cloned.polluted, undefined);
    assert.equal(Object.hasOwn(cloned, 'constructor'), false);
    assert.equal(Object.hasOwn(cloned, 'prototype'), false);

    // Starter HCG halfLife supports both SubQ and IM routes, rejects Oral/Device/unknown
    const hcg = core.STARTER_COMPOUNDS.find((c) => c.id === 'hcg');
    assert.equal(hcg.halfLife.route, 'SubQ / IM');
    assert.equal(core.extractHalfLifeHours(hcg, { route: 'SubQ' }), 33);
    assert.equal(core.extractHalfLifeHours(hcg, { route: 'IM' }), 33);
    assert.equal(core.extractHalfLifeHours(hcg, { route: 'Oral' }), null);
    assert.equal(core.extractHalfLifeHours(hcg, { route: 'Device' }), null);
    assert.equal(core.extractHalfLifeHours(hcg, { route: 'unrecognized_route' }), null);
  });

  it('catches 26/26 normalized starter duplicates (only excludeId skips self), prevents blend canonical collapse, strips salt suffixes, and rejects array ingredient values', () => {
    // All 26 starter profiles normalized via normalizeCompoundProfile MUST return 409 duplicate without excludeId
    for (const c of core.STARTER_COMPOUNDS) {
      const normalizedCand = core.normalizeCompoundProfile({
        name: c.name,
        sectionId: c.sectionId,
        dosages: { route: c.dosages.route },
        sectionData: c.sectionData,
      });
      const dup = core.checkDuplicateCompound(normalizedCand, core.STARTER_COMPOUNDS);
      assert.equal(dup.isDuplicate, true, `Normalized starter duplicate missed for ${c.id}`);
      assert.equal(dup.httpStatusHint, 409, `Expected 409 for normalized ${c.id}`);
      assert.equal(dup.existingCompoundId, c.id, `Expected match ${c.id}, got ${dup.existingCompoundId}`);

      // Explicit excludeId still allows in-place edit without self-collision
      const selfEdit = core.checkDuplicateCompound(normalizedCand, core.STARTER_COMPOUNDS, { excludeId: c.id });
      assert.equal(selfEdit.isDuplicate, false, `excludeId failed for ${c.id}`);
    }

    // Distinct-route normalized sibling still allowed as same_molecule_other_route
    const ghkSubq = core.STARTER_COMPOUNDS.find((c) => c.id === 'ghk-cu-subq');
    const ghkTopNorm = core.normalizeCompoundProfile({
      name: 'GHK-Cu 2% Facial Serum',
      sectionId: 'dermatology',
      dosages: { route: 'Topical' },
    });
    const sib = core.checkDuplicateCompound(ghkTopNorm, [ghkSubq]);
    assert.equal(sib.isDuplicate, false);
    assert.equal(sib.classification, 'same_molecule_other_route');

    // Blends NEVER collapse to a single constituent molecule
    assert.equal(
      core.resolveCanonicalMolecule({
        name: 'Recovery Blend (BPC-157)',
        sectionId: 'peptides',
        sectionData: { ingredients: { 'bpc-157': 0.5, 'tb-500': 0.5 } },
      }),
      null,
    );
    assert.equal(
      core.resolveCanonicalMolecule({ name: 'Vitamin D3/K2 (MK-7)', sectionId: 'vitamins_supplements' }),
      null,
    );
    // Direct single-molecule aliases containing '/' remain intact
    assert.equal(core.resolveCanonicalMolecule('EPA/DHA'), 'omega-3');

    const blendVsStandalone = core.checkDuplicateCompound(
      {
        name: 'BPC-157 / TB-500 (TB4)',
        sectionId: 'peptides',
        dosages: { route: 'SubQ' },
        sectionData: { ingredients: { 'bpc-157': 0.5, 'tb-500': 0.5 } },
      },
      [{ id: 'c_tb500', name: 'TB-500', sectionId: 'peptides', dosages: { route: 'SubQ' } }],
    );
    assert.equal(blendVsStandalone.isDuplicate, false);
    assert.equal(blendVsStandalone.canonicalMolecule, null);

    const d3k2VsK2 = core.checkDuplicateCompound(
      {
        name: 'Vitamin D3 / K2 (MK-7)',
        sectionId: 'vitamins_supplements',
        dosages: { route: 'Oral' },
        sectionData: {
          ingredientsList: [
            { name: 'Vitamin D3', amount: 5000, unit: 'IU' },
            { name: 'Vitamin K2 (MK-7)', amount: 100, unit: 'mcg' },
          ],
        },
      },
      [{ id: 'c_k2', name: 'Vitamin K2 (MK-7)', sectionId: 'vitamins_supplements', dosages: { route: 'Oral' } }],
    );
    assert.equal(d3k2VsK2.isDuplicate, false);
    assert.equal(d3k2VsK2.canonicalMolecule, null);

    // Salt suffix stripping without false collisions
    const bpcSalt = core.checkDuplicateCompound(
      { name: 'BPC-157 Acetate 5mg', sectionId: 'peptides', dosages: { route: 'SubQ' } },
      [{ id: 'c_bpc', name: 'BPC-157', sectionId: 'peptides', dosages: { route: 'SubQ' } }],
    );
    assert.equal(bpcSalt.isDuplicate, true);
    assert.equal(bpcSalt.canonicalMolecule, 'bpc-157');
    assert.equal(core.resolveCanonicalMolecule('GHK-Cu Acetate'), 'ghk-cu');
    assert.equal(core.resolveCanonicalMolecule('Magnesium L-Threonate'), null);

    // extractIngredientsMap rejects arrays & non-finite values instead of coercing [10] -> 10
    const ingBad = core.extractIngredientsMap({ 'bpc-157': [10], 'tb-500': 10, kpv: Infinity, ghk: NaN });
    assert.deepEqual(ingBad, { 'tb-500': 10 });
    assert.notEqual(core.compoundFingerprint({ 'bpc-157': [10], 'tb-500': 10 }), 'bpc-157:0.500|tb-500:0.500');
  });

  it('hardens schema guards: whitespace NON_HIDEABLE_FIELDS, isCore on custom, optional customFields types, citation/alias self-ref, ownership availability priority, member & stock edge cases', () => {
    const sections = core.createDefaultSections('2026-11-21T00:00:00Z');
    const pep = sections[0];

    // Whitespace-padded mandatory fields rejected in both updateSectionConfig & validateSection
    for (const field of [' name ', ' sectionId ', ' summary ', ' dosages ', ' doNotPairWith ']) {
      const u = core.updateSectionConfig(pep, { hiddenOptionalFields: [field] });
      assert.equal(u.ok, false, `updateSectionConfig should reject ${JSON.stringify(field)}`);
      assert.ok(u.errors.some((e) => e.code === 'CANNOT_HIDE_REQUIRED_FIELD'));
      const v = core.validateSection({ ...pep, hiddenOptionalFields: [field] });
      assert.equal(v.ok, false, `validateSection should reject ${JSON.stringify(field)}`);
      assert.ok(v.errors.some((e) => e.code === 'CANNOT_HIDE_REQUIRED_FIELD'));
    }
    assert.equal(core.validateSection({ ...pep, hiddenOptionalFields: 'not-array' }).ok, false);
    assert.equal(core.validateSection({ ...pep, customFields: 'not-array' }).ok, false);

    // isCore: true rejected on non-core sections
    assert.equal(core.validateSection({ id: 'custom_labs', name: 'Labs', isCore: true }).ok, false);
    const customSec = core.createCustomSection(sections, { id: 'labs', name: 'Labs' }).section;
    assert.equal(core.updateSectionConfig(customSec, { isCore: true }).ok, false);

    // Non-object sectionData / customFields & mistyped optional customFields rejected
    let secWithCf = core.addCustomField(pep, { key: 'f_num', label: 'N', fieldType: 'number' }).section;
    secWithCf = core.addCustomField(secWithCf, { key: 'f_bool', label: 'B', fieldType: 'boolean' }).section;
    secWithCf = core.addCustomField(secWithCf, { key: 'f_txt', label: 'T', fieldType: 'text' }).section;
    secWithCf = core.addCustomField(secWithCf, { key: 'f_url', label: 'U', fieldType: 'url' }).section;
    secWithCf = core.addCustomField(secWithCf, { key: 'f_list', label: 'L', fieldType: 'list' }).section;

    const nonObj = core.validateCompoundProfile({ name: 'Test', sectionId: 'peptides', sectionData: 'oops', customFields: ['bad'] });
    assert.equal(nonObj.ok, false);
    assert.ok(nonObj.errors.some((e) => e.field === 'sectionData' && e.code === 'INVALID_TYPE'));
    assert.ok(nonObj.errors.some((e) => e.field === 'customFields' && e.code === 'INVALID_TYPE'));

    for (const badCf of [
      { f_num: NaN },
      { f_num: Infinity },
      { f_num: -Infinity },
      { f_num: [] },
      { f_bool: {} },
      { f_txt: [] },
      { f_url: {} },
      { f_list: {} },
    ]) {
      const res = core.validateCompoundProfile(
        { name: 'Test', sectionId: 'peptides', customFields: badCf },
        { section: secWithCf },
      );
      assert.equal(res.ok, false, `Expected mistyped optional customFields to fail: ${JSON.stringify(badCf)}`);
      assert.ok(res.errors.some((e) => e.code === 'INVALID_CUSTOM_FIELD_TYPE'));
    }
    // Legitimate omitted optional values pass
    assert.equal(
      core.validateCompoundProfile(
        { name: 'Test', sectionId: 'peptides', customFields: { f_txt: '', f_url: '', f_list: [], f_num: null } },
        { section: secWithCf },
      ).ok,
      true,
    );

    // doNotPairWith alias self-reference & obfuscated dangerous citation URLs rejected
    const aliasSelf = core.validateCompoundProfile({
      name: 'Oxandrolone',
      aliases: ['Anavar'],
      sectionId: 'peds',
      doNotPairWith: [{ targetType: 'compound', targetRef: 'Anavar', severity: 'hard_stop' }],
    });
    assert.equal(aliasSelf.ok, false);
    assert.ok(aliasSelf.errors.some((e) => e.code === 'SELF_REFERENCE_INTERACTION'));

    for (const badCit of [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      '//evil.example/phish',
      'data:text/html,hi',
      'file:///etc/hosts',
      'ftp://evil.example',
    ]) {
      const res = core.validateCompoundProfile({
        name: 'BPC-157',
        sectionId: 'peptides',
        doNotPairWith: [{ targetType: 'compound', targetRef: 'TB-500', severity: 'caution', citation: badCit }],
      });
      assert.equal(res.ok, false, `Expected dangerous citation to fail: ${JSON.stringify(badCit)}`);
      assert.ok(res.errors.some((e) => e.code === 'INVALID_CITATION_URL'));
    }
    assert.equal(core.isValidHttpUrl('https://example.org/\tpath'), false);

    // resolveEffectiveOwnership selects highest availability within each scope
    const effOwn = core.resolveEffectiveOwnership('bpc-157', 'member_wife', [
      { id: 'pos_vial_1', compoundId: 'bpc-157', scope: 'household', status: 'dont_have', remainingDoses: 0, updatedAt: '2026-11-20T00:00:00Z' },
      { id: 'pos_storage_1', compoundId: 'bpc-157', scope: 'household', status: 'have', quantity: 3, updatedAt: '2026-11-19T00:00:00Z' },
    ]);
    assert.equal(effOwn.status, 'have');
    assert.equal(effOwn.record.id, 'pos_storage_1');

    // validateMember edge cases, deductOwnershipDose NaN, normalizeHubState boolean _rev
    const longMember = core.validateMember({ name: 'A'.repeat(55) });
    assert.equal(longMember.ok, true);
    assert.ok(longMember.normalized.id.length <= 48);
    assert.equal(core.validateMember({ name: 'Test', routineAnchors: ['invalid'] }).ok, false);
    assert.equal(core.validateMember({ name: 'Test', safetyContext: 'invalid' }).ok, false);
    const trimmedTz = core.validateMember({ name: 'Test', routineAnchors: { tz: '  America/New_York  ' } });
    assert.equal(trimmedTz.ok, true);
    assert.equal(trimmedTz.normalized.routineAnchors.tz, 'America/New_York');

    assert.equal(core.deductOwnershipDose({ id: 'o3', remainingDoses: NaN, status: 'have' }, 1).ok, false);
    assert.equal(core.deductOwnershipDose({ id: 'o3', remainingDoses: Infinity, status: 'have' }, 1).ok, false);
    assert.equal(core.normalizeHubState({ _rev: true })._rev, 0);
  });

  it('hardens calculators: stacked timeline revisions, strict dkParse & boundary ISO dates, IU/non-mass PK refusal, Dose-Sanity unit mismatches, blend mass & solvent warnings', () => {
    // Timeline revisions: future-only non-leakage, stacked partial revision folding, invalid fromDk ignored
    assert.equal(
      core.planAt({ doseAmount: 250, timeline: [{ id: 'r1', from: '2026-04-01', doseAmount: 500 }] }, '2026-03-15').doseAmount,
      250,
    );
    let plan = { doseAmount: 250, slot: 'morning_am', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } };
    plan = core.applyRevision(plan, '2026-04-01', { doseAmount: 500 }, '2026-03-01');
    plan = core.applyRevision(plan, '2026-04-15', { slot: 'bedtime_fasted' }, '2026-03-01');
    const effAfterBoth = core.planAt(plan, '2026-04-20');
    assert.equal(effAfterBoth.doseAmount, 500);
    assert.equal(effAfterBoth.slot, 'bedtime_fasted');
    const unchangedInvalid = core.applyRevision({ doseAmount: 250 }, '2026-02-30', { doseAmount: 999 }, '2026-03-01');
    assert.equal(unchangedInvalid.doseAmount, 250);

    // normalizePkEntries: IU + untagged mass refused, mL/pumps refused, 0 IU + 500 mcg succeeds
    const t0 = Date.parse('2026-03-01T08:00:00Z');
    assert.equal(
      core.remainingAt([{ at: t0, doseAmount: 500, doseUnit: 'IU' }, { at: t0, doseMcg: 250 }], t0 + 12 * core.HOUR_MS, 12),
      null,
    );
    assert.equal(
      core.remainingAt([{ at: t0, amount: 250, unit: 'mcg' }, { at: t0, amount: 2, unit: 'mL' }], t0, 24),
      null,
    );
    assert.equal(
      core.remainingAt([{ at: t0, amount: 250, unit: 'mcg' }, { at: t0, amount: 2, unit: 'pumps' }], t0, 24),
      null,
    );
    assert.equal(
      core.remainingAt([{ at: t0, amount: 500, unit: 'mcg' }, { at: t0, amount: 0, unit: 'IU' }], t0, 24),
      500,
    );

    // buildCompoundLevels invalid `now` timestamp returns modelable: false
    const badNowPk = core.buildCompoundLevels({
      compound: { id: 'bpc', halfLife: { valueHours: 4, kind: 'elimination' } },
      logs: [{ id: 'l1', compoundId: 'bpc', datetime: '2026-03-01T08:00:00Z', doseAmount: 250, doseUnit: 'mcg' }],
      now: '2026-02-30T08:00:00Z',
    });
    assert.equal(badNowPk.modelable, false);
    assert.equal(badNowPk.remaining, null);

    // Strict dkParse & boundary-day ISO datetime handling + computeAdherence bad timestamp rejection
    assert.equal(core.dkValid('2026-11-14Tgarbage'), false);
    assert.equal(core.dkValid('2026-03-04T99:99:99Z'), false);
    const boundaryEnd = { startDate: '2026-03-01', endDate: '2026-03-10', active: true };
    const csLastDay = core.cycleStatus(boundaryEnd, '2026-03-10T08:00:00Z');
    assert.equal(csLastDay.isActive, true);
    assert.notEqual(csLastDay.phase, 'expired');
    assert.equal(core.inRange(boundaryEnd, '2026-03-10T08:00:00Z'), true);
    assert.equal(core.materializePlan(boundaryEnd, '2026-03-10T08:00:00Z').active, true);
    assert.equal(
      core.computeAdherence({
        plan: { compoundId: 'bpc', startDate: '2026-03-01', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
        logs: [{ memberId: 'member_wife', compoundId: 'bpc', datetime: '2026-03-04T99:99:99Z' }],
        memberId: 'member_wife',
        todayDk: '2026-03-07',
        days: 7,
      }).taken,
      0,
    );

    // Dose-Sanity Gate: scheduled unit mismatch & unknown units NEVER PASS
    const iuMismatch = core.evaluateAdvisoryDose(
      { compoundId: 'vitamin-d3', doseAmount: 5000, doseUnit: 'mcg' },
      { knownCompound: true, scheduledDoseAmount: 5000, scheduledDoseUnit: 'IU' },
    );
    assert.equal(iuMismatch.decision, 'CONFIRM');
    assert.equal(iuMismatch.needsReview, true);
    assert.ok(iuMismatch.flags.includes('UNIT_DIMENSION_MISMATCH'));

    const dropMismatch = core.evaluateAdvisoryDose(
      { compoundId: 'custom-serum', doseAmount: 2, doseUnit: 'mcg' },
      { knownCompound: true, scheduledDoseAmount: 2, scheduledDoseUnit: 'drops' },
    );
    assert.equal(dropMismatch.decision, 'CONFIRM');
    assert.equal(dropMismatch.needsReview, true);

    const unknownUnit = core.evaluateAdvisoryDose(
      { compoundId: 'bpc-157', doseAmount: 250, doseUnit: 'bananas' },
      { knownCompound: true, scheduledDoseAmount: 250, scheduledDoseUnit: 'mcg' },
    );
    assert.equal(unknownUnit.decision, 'CONFIRM');
    assert.equal(unknownUnit.needsReview, true);
    assert.ok(unknownUnit.flags.includes('INVALID_UNIT'));

    // blendBreakdown mass mismatch, getSolventInfo string blend conflict, vialMath explicit BAC warning
    const massMismatch = core.blendBreakdown({
      vialMg: 10,
      diluentMl: 2,
      drawUnits: 10,
      components: [{ id: 'bpc-157', mg: 5 }, { id: 'tb-500', mg: 10 }],
    });
    assert.equal(massMismatch.ok, false);
    assert.equal(massMismatch.code, 'VIAL_MASS_MISMATCH');

    const strConflict = core.getSolventInfo('ARA-290 + IGF-1 LR3');
    assert.equal(strConflict.solventConflict, true);
    assert.equal(strConflict.isOverride, true);

    const bacOverride = core.vialMath({ vialMg: 5, diluentMl: 2, doseMcg: 250, compoundId: 'ara-290', solvent: 'BAC' });
    assert.equal(bacOverride.ok, true);
    assert.ok(bacOverride.warnings.some((w) => w.code === 'SOLVENT_MISMATCH'));
  });

  it('hardens sync security (proto pollution, snake/kebab secret keys, extended redaction), tombstone revival survival, Object.prototype IDs, CSV Unicode/C1, and MD bundle parity', () => {
    // Prototype pollution blocked in validateHubExport & all 3 importHubJson modes
    const maliciousJson = JSON.stringify({
      _format: 'home-pharmacy-export/v1',
      settings: JSON.parse('{"householdName":"Test","__proto__":{"isAdmin":true},"constructor":{"x":1},"prototype":{"y":2}}'),
      compounds: [JSON.parse('{"id":"c_evil","name":"Evil","sectionId":"peptides","__proto__":{"profileStatus":"verified","hijacked":true}}')],
    });
    const val = core.validateHubExport(maliciousJson);
    assert.equal(val.ok, true);
    assert.equal(Object.getPrototypeOf(val.sanitized.settings), Object.prototype);
    assert.equal(val.sanitized.settings.isAdmin, undefined);
    assert.equal(val.sanitized.compounds[0].hijacked, undefined);
    for (const mode of ['merge', 'lww', 'replace']) {
      const imp = core.importHubJson(core.createEmptyHubState(), maliciousJson, { mode });
      assert.equal(Object.hasOwn(imp.state.settings, 'constructor'), false);
      assert.equal(Object.hasOwn(imp.state.settings, 'prototype'), false);
      assert.equal(Object.hasOwn(imp.state.settings, '__proto__'), false);
    }

    // Snake/kebab/camelCase secret keys stripped without stripping benign token counters
    const secretPayload = {
      admin_token: 'SEC_1',
      client_secret: 'SEC_2',
      passcode_hash: 'SEC_3',
      password_hash: 'SEC_4',
      openai_api_key: 'SEC_5',
      secret_key: 'SEC_6',
      passcodeSalt: 'SEC_7',
      pin_salt: 'SEC_8',
      pinSalt: 'SEC_9',
      tokenHash: 'SEC_10',
      token_hash: 'SEC_11',
      keyHash: 'SEC_12',
      key_hash: 'SEC_13',
      api_key_hash: 'SEC_14',
      apiKeyHash: 'SEC_15',
      bearer_token: 'SEC_16',
      session_token: 'SEC_17',
      webhook_secret: 'SEC_18',
      householdPasscodeHash: 'SEC_19',
      'x-api-key': 'SEC_20',
      estimatedTokens: 420,
      maxEstimatedTokens: 16000,
    };
    const cleaned = core.stripSecrets(secretPayload);
    assert.equal(cleaned.estimatedTokens, 420);
    assert.equal(cleaned.maxEstimatedTokens, 16000);
    const cleanedStr = JSON.stringify(cleaned);
    for (let i = 1; i <= 20; i++) {
      assert.equal(cleanedStr.includes(`SEC_${i}`), false, `Secret key SEC_${i} leaked`);
    }

    // Extended text redaction + MD Context Bundle parity (Notes & ## Recent Logs)
    const st = core.createEmptyHubState({ now: '2026-11-21T00:00:00Z' });
    st.compounds = [
      {
        id: 'c1',
        name: 'Test Peptide',
        sectionId: 'peptides',
        summary: 'bearer lower_tok_777 | BEARER UPPER_TOK_888',
        mechanismOfAction: 'AIzaSyDummyKey123456789 hp_read_dummy1234 hp_propose_dummy5678 hp_write_dummy9012 github_pat_DummyToken1234567890',
        notes: 'https://user:basicpass_555@hub.example/mcp?key=qkey_999 token=raw_tok_666 pin=847291 secret=topsec_333',
      },
    ];
    st.logs = [
      {
        id: 'l1',
        memberId: 'member_wife',
        compoundId: 'c1',
        datetime: '2026-11-21T08:00:00Z',
        doseAmount: 250,
        doseUnit: 'mcg',
        notes: 'secret=log_secret_444',
      },
    ];
    const mdBundle = core.buildContextBundle(st, { format: 'md', includeFullProfiles: true, includeLogs: true });
    const jsonBundle = core.buildContextBundle(st, { format: 'json', includeFullProfiles: true, includeLogs: true });
    assert.ok(mdBundle.content.includes('## Recent Logs'));
    assert.ok(mdBundle.content.includes('Notes:'));
    for (const leak of [
      'AIzaSyDummyKey123456789',
      'lower_tok_777',
      'UPPER_TOK_888',
      'basicpass_555',
      'qkey_999',
      'raw_tok_666',
      '847291',
      'topsec_333',
      'log_secret_444',
      'hp_read_dummy1234',
      'hp_propose_dummy5678',
      'hp_write_dummy9012',
      'github_pat_DummyToken1234567890',
    ]) {
      assert.equal(mdBundle.content.includes(leak), false, `MD bundle leaked ${leak}`);
      assert.equal(jsonBundle.content.includes(leak), false, `JSON bundle leaked ${leak}`);
    }

    // Post-restore tombstone survival across subsequent mergeStates sync (merge & replace)
    const T1 = '2026-11-01T00:00:00.000Z';
    const T2 = '2026-11-02T00:00:00.000Z';
    const T3 = '2026-11-03T00:00:00.000Z';
    const orig = core.createEmptyHubState({ now: T1 });
    orig.compounds = [{ id: 'c_rev', name: 'BPC-157', sectionId: 'peptides', updatedAt: T1 }];
    const backup = core.exportHubJson(orig, { exportedAt: T1 });
    const deleted = core.prepareSyncState({ ...orig, compounds: [] }, core.snapshotState(orig), T2).state;
    const remote = core.deepClone(deleted);
    for (const mode of ['merge', 'replace']) {
      const restored = core.importHubJson(deleted, backup, { mode, nowIso: T3 });
      const synced = core.mergeStates(restored.state, remote, { nowIso: T3 });
      assert.equal(synced.compounds.length, 1, `Revived compound must survive remote tombstone in ${mode} mode`);
    }

    // Object.prototype ID safety ("toString") & duplicate local ID deduplication in mergeStates
    const edgeLocal = {
      compounds: [
        { id: 'toString', name: 'Prototype Edge' },
        { id: 'c_dup', name: 'Older Copy', updatedAt: T1 },
        { id: 'c_dup', name: 'Newer Copy', updatedAt: T2 },
      ],
    };
    const edgeMerged = core.mergeStates(edgeLocal, {}, { nowIso: T3 });
    assert.equal(edgeMerged.compounds.find((c) => c.id === 'toString')?.name, 'Prototype Edge');
    assert.equal(edgeMerged.compounds.filter((c) => c.id === 'c_dup').length, 1);
    assert.equal(edgeMerged.compounds.find((c) => c.id === 'c_dup').name, 'Newer Copy');
    const prepToStr = core.prepareSyncState(
      { compounds: [{ id: 'toString', name: 'Prototype Edge', updatedAt: T1 }] },
      core.snapshotState({ compounds: [] }),
      T2,
    );
    assert.equal(prepToStr.state.compounds[0].updatedAt, T1);

    // CSV invisible Unicode / C1 formula prefix neutralization
    for (const raw of ['\u200B=1+1', '\u0085=1+1', '\u200E=1+1', '\u202E+1+1', '\u2060@SUM(1,2)']) {
      const esc = core.escapeCsvCell(raw);
      const unwrapped = esc.startsWith('"') && esc.endsWith('"') ? esc.slice(1, -1).replace(/""/g, '"') : esc;
      assert.equal(unwrapped.startsWith("'"), true, `CSV failed to neutralize ${JSON.stringify(raw)} -> ${esc}`);
    }
  });

  it('losslessly imports real protocol-os vial fields (mgPerVial, iuPerVial, unitLabel, vialCount), penVialId linkage, mixed mg/mcg pen ratios, oil dedup, multi-route variants, and protocol-os-logs/v1 profile', () => {
    const NOW = '2026-11-21T12:00:00.000Z';
    const realShape = {
      _format: 'protocol-os-export/v1',
      vials: [
        { id: 'v1', peptideId: 'bpc-157', peptideName: 'BPC-157', mgPerVial: 5, vialCount: 3, diluentMl: 2, remainingMcg: 750, doseMcg: 250, active: true },
        { id: 'v2', peptideId: 'hcg', peptideName: 'HCG', mgPerVial: 5, diluentMl: 5, totalMcg: 5000, remainingMcg: 1500, doseMcg: 500, unitLabel: 'IU', iuPerVial: 5000, active: true },
        { id: 'v3', peptideId: 'test-cyp', peptideName: 'Testosterone Cypionate', oil: true, mgPerVial: 2000, diluentMl: 10, remainingMcg: 1_000_000, active: true },
        { id: 'v4', peptideId: 'kpv', peptideName: 'KPV', mgPerVial: 5, vialCount: 0, active: true },
        {
          id: 'pen_1',
          isPen: true,
          penColor: 'blue',
          penName: null,
          peptideId: '__pen__',
          peptideName: 'Blue Pen',
          penComponents: [
            { peptideId: 'bpc-157', mg: 5 },
            { peptideId: 'tb-500', mcg: 5000 },
          ],
          mgPerVial: 10,
          diluentMl: 3,
          remainingMcg: 10000,
          active: true,
        },
      ],
      protocols: [
        { id: 'p1', profile: 'member_wife', peptideId: 'bpc-157', peptideName: 'BPC-157', doseMcg: 250, cycleDays: 42, schedule: { timeOfDay: 'am', days: [0, 1, 2, 3, 4, 5, 6] } },
        { id: 'p2', profile: 'member_husband', peptideId: 'hcg', peptideName: 'HCG', doseMcg: 500, doseUnit: 'IU', cycleDays: 90, schedule: { days: [1, 4] } },
        { id: 'p3', profile: 'member_husband', peptideId: 'test-cyp', peptideName: 'Testosterone Cypionate', doseMcg: 50000, doseUnit: 'mg', schedule: { days: [1, 4] } },
        { id: 'p_pen', profile: 'member_wife', peptideId: '__pen__', peptideName: 'Blue Pen — BPC + TB', route: 'pen', penName: null, penVialId: 'pen_1', doseMcg: 500, schedule: { days: [1, 3, 5] } },
        { id: 'p_ghk_sc', profile: 'member_wife', peptideId: 'ghk-cu', peptideName: 'GHK-Cu', route: 'sc', doseMcg: 1500, schedule: { days: [1, 3, 5] } },
        { id: 'p_ghk_top', profile: 'member_wife', peptideId: 'ghk-cu', peptideName: 'GHK-Cu', route: 'topical', doseMcg: 500, schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
      ],
      logs: [],
    };

    const res = core.importProtocolOsExport(core.createEmptyHubState({ now: NOW }), realShape, { nowIso: NOW });
    assert.equal(res.ok, true);

    // Real vial fields preserved
    const v1 = res.state.ownership.find((o) => o.id === 'pos_vial_v1');
    assert.equal(v1.reconstitution.vialMg, 5);
    assert.equal(v1.quantity, 3);
    const v2 = res.state.ownership.find((o) => o.id === 'pos_vial_v2');
    assert.equal(v2.reconstitution.vialIU, 5000);
    const v3 = res.state.ownership.find((o) => o.id === 'pos_vial_v3');
    assert.equal(v3.reconstitution.vialMg, 2000);
    assert.equal(v3.reconstitution.oilConcentrationMgPerMl, 200);
    const v4 = res.state.ownership.find((o) => o.id === 'pos_vial_v4');
    assert.equal(v4.status, 'dont_have');
    assert.equal(v4.quantity, 0);

    // Protocol metadata backfilled onto newly imported needs_review compounds
    const bpc = res.state.compounds.find((c) => c.id === 'pos_cmp_bpc-157');
    assert.equal(bpc.dosages.defaultAmount, 250);
    assert.equal(bpc.cycles.cycleDays, 42);
    assert.deepEqual(bpc.timingRules.preferredSlots, ['morning_am']);

    const hcg = res.state.compounds.find((c) => c.id === 'pos_cmp_hcg');
    assert.equal(hcg.dosages.defaultUnit, 'IU');
    assert.equal(hcg.dosages.defaultAmount, 500);
    assert.equal(hcg.cycles.cycleDays, 90);

    // Pen protocol with penName: null & penVialId maps to single compound with normalized 0.5/0.5 mixed mg/mcg ratios
    const penOwnership = res.state.ownership.find((o) => o.id === 'pos_vial_pen_1');
    const wifeStack = res.state.stacks.find((s) => s.memberId === 'member_wife');
    const penStackItem = wifeStack.items.find((it) => it.id === 'pos_item_p_pen');
    assert.equal(penStackItem.compoundId, penOwnership.compoundId);
    const penComp = res.state.compounds.find((c) => c.id === penOwnership.compoundId);
    assert.deepEqual(penComp.sectionData.ingredients, { 'bpc-157': 0.5, 'tb-500': 0.5 });

    // Multi-route same peptideId (SubQ GHK-Cu + Topical GHK-Cu) preserved as 2 distinct compounds
    const ghkComps = res.state.compounds.filter((c) => c.name === 'GHK-Cu');
    assert.equal(ghkComps.length, 2);

    // Oil protocol omitting route/oil dedupes cleanly against starter testosterone-cypionate
    const seeded = core.seedStarterCatalog(core.createEmptyHubState({ now: NOW }), { nowIso: NOW }).state;
    const oilWithStarter = core.importProtocolOsExport(seeded, {
      _format: 'protocol-os-export/v1',
      vials: [realShape.vials[2]],
      protocols: [realShape.protocols[2]],
      logs: [],
    }, { nowIso: NOW });
    const cypMatches = oilWithStarter.state.compounds.filter((c) => /testosterone cypionate/i.test(c.name));
    assert.equal(cypMatches.length, 1);
    assert.equal(cypMatches[0].id, 'testosterone-cypionate');

    // protocol-os-logs/v1 honors top-level payload.profile
    const logsImport = core.importProtocolOsExport(core.createEmptyHubState({ now: NOW }), {
      _format: 'protocol-os-logs/v1',
      profile: 'Husband',
      logs: [{ id: 'lg_top', peptideId: 'bpc-157', peptide: 'BPC-157', datetime: '2026-11-10T08:00:00Z', doseMcg: 250, doseUnit: 'mcg' }],
    }, { nowIso: NOW });
    assert.equal(logsImport.ok, true);
    assert.equal(logsImport.state.logs[0].memberId, 'member_husband');
  });
});

// ---------------------------------------------------------------------------
// 14. Iteration 3 Zero-Regression & Second-Order Hardening
// ---------------------------------------------------------------------------
describe('Iteration 3 Zero-Regression & Second-Order Hardening', () => {
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

  it('hardens Object.prototype key lookups across dedup, schema, and calculators without crashes, function injection, or validator bypasses', () => {
    for (const k of PROTO_KEYS) {
      assert.equal(core.normRoute(k), null, `normRoute(${k}) must be null`);
      assert.equal(core.normalizeRoute(k), null, `normalizeRoute(${k}) must be null`);
      assert.equal(core.resolveCanonicalMolecule(k), null, `resolveCanonicalMolecule(${k}) must be null`);
      assert.equal(core.normalizeUnit(k), null, `normalizeUnit(${k}) must be null`);
      assert.equal(core.unitDimension(k), 'unknown', `unitDimension(${k}) must be unknown`);
      assert.equal(core.getPreferredSolvent(k), 'BAC', `getPreferredSolvent(${k}) must be BAC`);
      assert.equal(core.getSolventInfo(k).isOverride, false);
      const doseEval = core.evaluateDose({ compoundId: k, doseAmount: 10, doseUnit: 'mg' });
      assert.deepEqual(doseEval.flags, [], `evaluateDose(${k}) must not hit prototype ceiling`);
    }

    assert.equal(core.normalizeRoute(['SubQ']), null);
    assert.equal(core.normRoute(['SubQ']), null);
    assert.equal(core.normalizeUnit(['mg']), null);
    assert.equal(core.normalizeUnit({}), null);
    assert.equal(core.toMassMcg(10, 'constructor'), null);
    assert.equal(core.toCanonicalAmount(10, 'constructor'), null);

    // Schema profile & route validation on 'constructor'
    const nameProto = core.validateCompoundProfile({ name: 'constructor', sectionId: 'peptides' });
    assert.equal(nameProto.ok, true);
    assert.equal(nameProto.normalized.canonicalMolecule, undefined);

    const routeProto = core.validateCompoundProfile({
      name: 'Test Peptide',
      sectionId: 'peptides',
      dosages: { route: 'constructor' },
    });
    assert.equal(routeProto.ok, false);
    assert.ok(routeProto.errors.some((e) => e.field === 'dosages.route' && e.code === 'INVALID_ROUTE'));
    assert.equal(typeof routeProto.normalized.dosages.route, 'string');

    // Dedup checkDuplicateCompound, fingerprint & extractIngredientsMap on prototype keys
    const dupRoute = core.checkDuplicateCompound(
      { name: 'BPC-157', sectionId: 'peptides', dosages: { route: 'constructor' } },
      core.STARTER_COMPOUNDS,
    );
    assert.equal(dupRoute.isDuplicate, true);

    const dupName = core.checkDuplicateCompound(
      { name: 'constructor', sectionId: 'peptides', dosages: { route: 'Oral' } },
      core.STARTER_COMPOUNDS,
    );
    assert.equal(dupName.canonicalMolecule, null);

    const dupExplicit = core.checkDuplicateCompound(
      { name: 'X', canonicalMolecule: 'constructor', sectionId: 'peptides' },
      [],
    );
    assert.equal(dupExplicit.isDuplicate, false);

    assert.equal(
      core.compoundFingerprint({ constructor: 10, 'bpc-157': 10 }),
      'bpc-157:0.500|constructor:0.500',
    );
    const penProto = core.extractIngredientsMap({
      penComponents: [
        { name: 'constructor', mg: 5 },
        { name: 'toString', mg: 5 },
      ],
    });
    assert.equal(penProto.constructor, 5);
    assert.equal(penProto.toString, 5);
    const rawProto = core.extractIngredientsMap(JSON.parse('{"__proto__":10,"bpc-157":10}'));
    assert.equal(Object.hasOwn(rawProto, '__proto__'), false);
    assert.equal(rawProto['bpc-157'], 10);

    // Schema descriptor, custom field keys, ownership rank, and plain-object lookup guards
    assert.deepEqual(core.getSectionSchemaDescriptor({ id: 'constructor' }).sectionDataFields, {});
    for (const badKey of ['constructor', 'prototype']) {
      const cfCheck = core.validateCustomFieldDef({ key: badKey, label: 'Bad', fieldType: 'text' });
      assert.equal(cfCheck.ok, false);
      assert.ok(cfCheck.errors.some((e) => e.code === 'RESERVED_KEY'));
    }

    const effOwn = core.resolveEffectiveOwnership('c1', 'member_wife', [
      { id: '1', compoundId: 'c1', scope: 'household', status: 'constructor' },
      { id: '2', compoundId: 'c1', scope: 'household', status: 'have' },
    ]);
    assert.equal(effOwn.status, 'have');
    assert.equal(effOwn.record.id, '2');

    const ownLookup = core.validateOwnershipRecord(
      { compoundId: 'constructor', scope: 'member:constructor', status: 'have' },
      { compoundsById: {}, membersById: {} },
    );
    assert.equal(ownLookup.ok, false);
    assert.ok(ownLookup.errors.some((e) => e.code === 'NOT_FOUND'));
    assert.ok(ownLookup.errors.some((e) => e.code === 'MEMBER_NOT_FOUND'));

    const stackLookup = core.validateStack(
      { memberId: 'constructor', name: 'S', items: [{ compoundId: 'constructor' }] },
      { membersById: {}, compoundsById: {} },
    );
    assert.equal(stackLookup.ok, false);
    assert.ok(stackLookup.errors.some((e) => e.code === 'MEMBER_NOT_FOUND'));
    assert.ok(stackLookup.errors.some((e) => e.code === 'COMPOUND_NOT_FOUND'));

    // Calculators blendBreakdown, rotateSite, PK route & dose unit on 'constructor'
    const bd = core.blendBreakdown({
      vialMg: 10,
      diluentMl: 2,
      drawUnits: 10,
      ingredients: { constructor: 5, 'bpc-157': 5 },
    });
    assert.equal(bd.ok, true);
    assert.equal(bd.components.find((c) => c.id === 'constructor').name, 'constructor');

    assert.equal(core.rotateSite('constructor'), 'L abdomen');
    assert.equal(
      core.extractHalfLifeHours(
        { halfLife: { valueHours: 12, route: 'SubQ', kind: 'elimination' } },
        { route: 'constructor' },
      ),
      null,
    );
    const pkProtoRoute = core.buildCompoundLevels({
      compound: { id: 'bpc', halfLife: { valueHours: 4, route: 'SubQ', kind: 'elimination' } },
      logs: [
        {
          id: 'l1',
          compoundId: 'bpc',
          datetime: '2026-03-01T08:00:00Z',
          doseAmount: 250,
          doseUnit: 'mcg',
          route: 'constructor',
        },
      ],
      now: '2026-03-01T12:00:00Z',
    });
    assert.equal(pkProtoRoute.modelable, false);
    assert.equal(pkProtoRoute.entries[0].route, null);

    const badUnitEval = core.evaluateDose({ compoundId: 'bpc-157', doseAmount: 10, doseUnit: 'constructor' });
    assert.equal(badUnitEval.decision, 'BLOCK');
    assert.ok(badUnitEval.flags.includes('INVALID_UNIT'));
    assert.equal(badUnitEval.displayUnit, 'constructor');
  });

  it('preserves registered salt and vehicle aliases via 3-pass dedup stripping, spaced concentration STRENGTH_RE, and multi-component blend refusal', () => {
    // 3-pass salt/vehicle/spaced-concentration alias resolution
    assert.equal(core.resolveCanonicalMolecule('Sodium Hyaluronate 2% Serum'), 'hyaluronic-acid');
    assert.equal(core.resolveCanonicalMolecule('Ferrous Sulfate 325mg Tablets'), 'iron');
    assert.equal(core.resolveCanonicalMolecule('BPC-157 Acetate 5mg'), 'bpc-157');
    assert.equal(core.resolveCanonicalMolecule('GHK-Cu Acetate'), 'ghk-cu');
    assert.equal(core.resolveCanonicalMolecule('Vitamin C Serum 15%'), 'vitamin-c-laa');
    assert.equal(core.resolveCanonicalMolecule('Omega-3 Fish Oil 1000mg'), 'omega-3');
    assert.equal(core.resolveCanonicalMolecule('Testosterone Cypionate 200 mg / mL'), 'testosterone-cypionate');
    assert.equal(core.resolveCanonicalMolecule('Testosterone Cypionate 200 mg / 1 mL Oil'), 'testosterone-cypionate');
    assert.equal(core.resolveCanonicalMolecule('Semaglutide 2.5 mg / 0.5 mL Pen'), 'semaglutide');
    assert.equal(core.resolveCanonicalMolecule('HCG 5,000 IU / mL'), 'hcg');

    // Duplicate detection on restored salt aliases
    const haDup = core.checkDuplicateCompound(
      { name: 'Sodium Hyaluronate 2% Serum', sectionId: 'dermatology', dosages: { route: 'Topical' } },
      [{ id: 'ha', name: 'Hyaluronic Acid Serum', sectionId: 'dermatology', dosages: { route: 'Topical' } }],
    );
    assert.equal(haDup.isDuplicate, true);
    assert.equal(haDup.httpStatusHint, 409);

    // Zero false collapses across distinct salt/ester families
    const nonCollapsing = [
      'Magnesium Citrate',
      'Magnesium L-Threonate',
      'Magnesium Sulfate',
      'Potassium Citrate',
      'Potassium Chloride',
      'Sodium Chloride',
      'Sodium Ascorbate',
      'Testosterone Propionate',
      'Trenbolone Acetate',
      'Trenbolone Enanthate',
    ];
    for (const label of nonCollapsing) {
      assert.equal(core.resolveCanonicalMolecule(label), null, `${label} must not collapse to canonical`);
    }
    assert.equal(
      core.checkDuplicateCompound(
        { name: 'Potassium Chloride', sectionId: 'vitamins_supplements', dosages: { route: 'Oral' } },
        [{ id: 'nacl', name: 'Sodium Chloride', sectionId: 'vitamins_supplements', dosages: { route: 'Oral' } }],
      ).isDuplicate,
      false,
    );
    assert.equal(
      core.checkDuplicateCompound(
        { name: 'Trenbolone Acetate', sectionId: 'peds', dosages: { route: 'IM' } },
        [{ id: 'tren_e', name: 'Trenbolone Enanthate', sectionId: 'peds', dosages: { route: 'IM' } }],
      ).isDuplicate,
      false,
    );

    // Multi-component blends (&, and, comma, slash, multi-paren) refused by dedup & PK
    assert.equal(core.isBlendCompound({ name: 'BPC-157 / TB-500' }), true);
    assert.equal(
      core.extractHalfLifeHours({ name: 'BPC-157 / TB-500', halfLife: { valueHours: 4, kind: 'elimination' } }),
      null,
    );
    for (const blendName of [
      'Vitamin D3 & K2 (MK-7)',
      'Vitamin D3 and K2 (MK-7)',
      'Vitamin D3, K2 (MK-7)',
      'Daily Stack (TB4) (BPC-157/TB-500)',
      'Recovery Stack (BPC-157) (TB-500)',
    ]) {
      assert.equal(core.resolveCanonicalMolecule(blendName), null, `Expected null canonical for ${blendName}`);
      assert.equal(core.isBlendCompound({ name: blendName }), true, `Expected blend true for ${blendName}`);
    }
    assert.equal(core.resolveCanonicalMolecule('Vitamin D3 & K2 (MK-7)', ['Vitamin K2 (MK-7)']), null);

    const k2Check = core.checkDuplicateCompound(
      { name: 'Vitamin D3 & K2 (MK-7)', sectionId: 'vitamins_supplements', dosages: { route: 'Oral' } },
      [{ id: 'c_k2', name: 'Vitamin K2 (MK-7)', sectionId: 'vitamins_supplements', dosages: { route: 'Oral' } }],
    );
    assert.equal(k2Check.isDuplicate, false);
    assert.equal(k2Check.httpStatusHint, 200);
    assert.equal(k2Check.canonicalMolecule, null);

    const multiParenCheck = core.checkDuplicateCompound(
      { name: 'Daily Stack (TB4) (BPC-157/TB-500)', sectionId: 'peptides', dosages: { route: 'SubQ' } },
      [{ id: 'tb', name: 'TB-500', sectionId: 'peptides', dosages: { route: 'SubQ' } }],
    );
    assert.equal(multiParenCheck.isDuplicate, false);
    assert.equal(multiParenCheck.canonicalMolecule, null);

    // Preserved single compounds (never misclassified as blends)
    const singles = [
      ['EPA/DHA', 'omega-3'],
      ['EPA/DHA 1000mg Softgels', 'omega-3'],
      ['Omega-3 (EPA/DHA)', 'omega-3'],
      ['Omega-3 Fish Oil (EPA/DHA) 1000mg', 'omega-3'],
      ['Testosterone Cypionate 200 mg / mL', 'testosterone-cypionate'],
      ['HCG 5000 IU / mL', 'hcg'],
      ['HCG (SubQ / IM)', 'hcg'],
      ['Vitamin D3 5,000 IU', 'vitamin-d3'],
      ['NAD+', null],
      ['Mineral SPF 50+', null],
    ];
    for (const [singleName, expectedCanon] of singles) {
      assert.equal(core.isBlendCompound({ name: singleName }), false, `${singleName} must NOT be blend`);
      assert.equal(core.resolveCanonicalMolecule(singleName), expectedCanon);
    }
  });

  it('enforces route-aware doNotPairWith self-refs, hardened citation/URL checks, whitespace-only list custom fields, and strict 26/26 starter catalog', () => {
    // Same-route self-references REJECTED
    const sameRouteCases = [
      { name: 'GHK-Cu', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'SubQ GHK-Cu' },
      { name: 'GHK-Cu', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'Injectable GHK-Cu' },
      { name: 'GHK-Cu Topical Serum', sectionId: 'dermatology', dosages: { route: 'Topical' }, targetRef: 'Topical GHK-Cu' },
      { name: 'GHK-Cu Topical Serum', sectionId: 'dermatology', dosages: { route: 'Topical' }, targetRef: 'GHK-Cu Cream' },
      { name: 'Finasteride (Oral)', sectionId: 'peds', dosages: { route: 'Oral' }, targetRef: 'Oral Propecia' },
      { name: 'Finasteride (Oral)', sectionId: 'peds', dosages: { route: 'Oral' }, targetRef: 'Oral Finasteride' },
      { name: 'HCG', sectionId: 'peds', dosages: { route: 'IM' }, targetRef: 'Intramuscular HCG' },
      { name: 'BPC-157', sectionId: 'peptides', dosages: { route: 'SL' }, targetRef: 'Sublingual BPC-157' },
      { name: 'GHK-Cu', sectionId: 'peptides', dosages: {}, targetRef: 'SubQ GHK-Cu' },
    ];
    for (const tc of sameRouteCases) {
      const res = core.validateCompoundProfile({
        name: tc.name,
        sectionId: tc.sectionId,
        dosages: tc.dosages,
        doNotPairWith: [{ targetType: 'compound', targetRef: tc.targetRef, severity: 'hard_stop' }],
      });
      assert.equal(res.ok, false, `Expected same-route self-ref rejection for ${tc.name} -> ${tc.targetRef}`);
      assert.ok(res.errors.some((e) => e.code === 'SELF_REFERENCE_INTERACTION'));
    }

    // Distinct-route siblings ALLOWED
    const distinctRouteCases = [
      { id: 'ghk-cu-topical', name: 'GHK-Cu Topical Serum', sectionId: 'dermatology', dosages: { route: 'Topical' }, targetRef: 'Subcutaneous GHK-Cu' },
      { id: 'ghk-cu-topical', name: 'GHK-Cu Topical Serum', sectionId: 'dermatology', dosages: { route: 'Topical' }, targetRef: 'Injectable GHK-Cu' },
      { id: 'ghk-cu', name: 'GHK-Cu', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'GHK-Cu Serum' },
      { id: 'ghk-cu', name: 'GHK-Cu', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'GHK-Cu Cream' },
      { id: 'ghk-cu', name: 'GHK-Cu', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'GHK-Cu Foam' },
      { id: 'ghk-cu', name: 'GHK-Cu', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'GHK-Cu Gel' },
      { id: 'finasteride-oral', name: 'Finasteride (Oral)', sectionId: 'peds', dosages: { route: 'Oral' }, targetRef: 'finasteride-topical' },
      { id: 'finasteride-oral', name: 'Finasteride (Oral)', sectionId: 'peds', dosages: { route: 'Oral' }, targetRef: 'Finasteride Foam' },
      { id: 'bpc-157', name: 'BPC-157', sectionId: 'peptides', dosages: { route: 'SubQ' }, targetRef: 'Sublingual BPC-157' },
      { id: 'hcg', name: 'HCG', sectionId: 'peds', dosages: { route: 'SubQ' }, targetRef: 'IM HCG' },
    ];
    for (const tc of distinctRouteCases) {
      const res = core.validateCompoundProfile({
        id: tc.id,
        name: tc.name,
        sectionId: tc.sectionId,
        dosages: tc.dosages,
        doNotPairWith: [{ targetType: 'compound', targetRef: tc.targetRef, severity: 'caution' }],
      });
      assert.equal(res.ok, true, `Expected distinct-route sibling allowed for ${tc.name} -> ${tc.targetRef}: ${JSON.stringify(res.errors)}`);
    }

    // Citation URL & non-string hardening
    for (const badUrl of [
      '\\\\evil.com/phish',
      '/\\evil.com/phish',
      '\\/evil.com/phish',
      'https:\\\\evil.com',
      '\x7fjavascript:alert(1)',
      'java\x7fscript:alert(1)',
      'https://example.org/\x7fpath',
    ]) {
      const res = core.validateCompoundProfile({
        name: 'BPC-157',
        sectionId: 'peptides',
        doNotPairWith: [{ targetType: 'compound', targetRef: 'TB-500', severity: 'caution', citation: badUrl }],
      });
      assert.equal(res.ok, false, `Expected citation rejection for ${JSON.stringify(badUrl)}`);
      assert.ok(res.errors.some((e) => e.code === 'INVALID_CITATION_URL'));
    }
    for (const nonStr of [['javascript:alert(1)'], { url: 'javascript:alert(1)' }, 123, true]) {
      const res = core.validateCompoundProfile({
        name: 'BPC-157',
        sectionId: 'peptides',
        doNotPairWith: [{ targetType: 'compound', targetRef: 'TB-500', severity: 'caution', citation: nonStr }],
      });
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'));
    }
    for (const okCit of ['https://pubmed.ncbi.nlm.nih.gov/12345/', 'FDA Label Section 7', 'PMID: 12345678', null, undefined, '']) {
      const res = core.validateCompoundProfile({
        name: 'BPC-157',
        sectionId: 'peptides',
        doNotPairWith: [{ targetType: 'compound', targetRef: 'TB-500', severity: 'caution', citation: okCit }],
      });
      assert.equal(res.ok, true);
    }

    // Required `list` custom field whitespace-only array rejection
    const sections = core.createDefaultSections();
    const pepSec = core.addCustomField(sections.find((s) => s.id === 'peptides'), {
      key: 'req_list',
      label: 'Required List',
      fieldType: 'list',
      required: true,
    }).section;
    for (const wsArr of [['   '], ['', '\t\n']]) {
      const res = core.validateCompoundProfile(
        { name: 'BPC-157', sectionId: 'peptides', customFields: { req_list: wsArr } },
        { section: pepSec },
      );
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === 'REQUIRED_CUSTOM_FIELD'));
      assert.ok(res.missingFields.includes('customFields.req_list'));
      assert.ok(res.completenessPct < 100);
    }
    const mixedList = core.validateCompoundProfile(
      { name: 'BPC-157', sectionId: 'peptides', customFields: { req_list: ['   ', 123] } },
      { section: pepSec },
    );
    assert.equal(mixedList.ok, false);
    assert.ok(mixedList.errors.some((e) => e.code === 'INVALID_CUSTOM_FIELD_TYPE'));

    const validList = core.validateCompoundProfile(
      { name: 'BPC-157', sectionId: 'peptides', customFields: { req_list: ['valid'] } },
      { section: pepSec },
    );
    assert.equal(validList.ok, true);

    // All 26/26 starter profiles pass strict validation with 0 errors, 0 warnings, 100% completeness
    const defaultSections = core.createDefaultSections();
    assert.equal(core.STARTER_COMPOUNDS.length, 26);
    for (const c of core.STARTER_COMPOUNDS) {
      const res = core.validateCompoundProfile(c, { sections: defaultSections, strict: true });
      assert.equal(res.ok, true, `Starter ${c.id} failed strict validation: ${JSON.stringify(res.errors)}`);
      assert.equal(res.warnings.length, 0, `Starter ${c.id} emitted warnings: ${JSON.stringify(res.warnings)}`);
      assert.equal(res.completenessPct, 100, `Starter ${c.id} completenessPct=${res.completenessPct}`);
    }
  });

  it('isolates PK dimensions, eliminates timeline ghosts and future-only overwrite, preserves materializePlan === identity, and enforces non-mass evaluateDose unit precision', () => {
    const t0 = Date.parse('2026-03-01T08:00:00Z');

    // Group B: PK normalizePkEntries & buildCompoundLevels
    assert.equal(
      core.remainingAt([{ at: t0, amount: 500, unit: 'IU' }, { at: t0, doseMcg: 250 }], t0, 12, { dimension: 'IU' }),
      500,
    );
    assert.equal(
      core.remainingAt([{ at: t0, amount: 500, unit: 'IU' }, { at: t0, amount: 250 }], t0, 12, { unit: 'IU' }),
      500,
    );
    assert.equal(
      core.remainingAt([{ at: t0, amount: 500, unit: 'IU' }, { at: t0, amount: 250, unit: 'IU' }], t0, 12, { dimension: 'IU' }),
      750,
    );
    assert.equal(
      core.levelSeries([{ at: t0, amount: 500, unit: 'IU' }, { at: t0, doseMcg: 250 }], t0, 12, { dimension: 'IU', days: 1, samples: 4 }).at(-1).amount,
      500,
    );
    assert.equal(
      core.remainingAt([{ at: t0, amount: 500, unit: 'IU' }, { at: t0, doseMcg: 250 }], t0, 12),
      null,
    );

    const bananaPk = core.buildCompoundLevels({
      compound: { id: 'bpc', halfLife: { valueHours: 4, kind: 'elimination' } },
      logs: [{ id: 'l1', compoundId: 'bpc', datetime: '2026-03-01T08:00:00Z', doseAmount: 250, doseUnit: 'bananas', doseMcg: 250 }],
      now: '2026-03-01T12:00:00Z',
    });
    assert.equal(bananaPk.modelable, false);
    assert.equal(bananaPk.remaining, null);

    const legacyPk = core.buildCompoundLevels({
      compound: { id: 'bpc', halfLife: { valueHours: 4, kind: 'elimination' } },
      logs: [{ id: 'l1', compoundId: 'bpc', datetime: '2026-03-01T08:00:00Z', doseMcg: 250 }],
      now: '2026-03-01T12:00:00Z',
    });
    assert.equal(legacyPk.modelable, true);
    assert.equal(legacyPk.remaining, 125);

    // Group C: Ghost-free timelines, removeRevision cleanup, future-only baseline snapshot, partial legacy preservation, === identity
    let q = { id: 'q1', doseAmount: 250, schedule: { days: [0, 1, 2, 3, 4, 5, 6] } };
    q = core.applyRevision(q, '2026-04-01', { id: 'r1', doseAmount: 500 }, '2026-04-25');
    q = core.applyRevision(q, '2026-04-10', { id: 'r2', pinnedSlot: 'bedtime_fasted' }, '2026-04-25');
    q = core.applyRevision(q, '2026-04-20', { id: 'r3', doseAmount: 750 }, '2026-04-25');

    for (const sample of [q, JSON.parse(JSON.stringify(q))]) {
      assert.equal(core.planAt(sample, '2026-03-01').doseAmount, 250);
      assert.equal(core.planAt(sample, '2026-03-01').pinnedSlot, undefined);
      assert.equal(core.planAt(sample, '2026-04-05').doseAmount, 500);
      assert.equal(core.planAt(sample, '2026-04-05').pinnedSlot, undefined);
      assert.equal(core.planAt(sample, '2026-04-15').doseAmount, 500);
      assert.equal(core.planAt(sample, '2026-04-15').pinnedSlot, 'bedtime_fasted');
      assert.equal(core.planAt(sample, '2026-04-25').doseAmount, 750);
      assert.equal(core.planAt(sample, '2026-04-25').pinnedSlot, 'bedtime_fasted');
    }

    const qDel = core.removeRevision(q, 'r2', '2026-04-25');
    assert.equal(qDel.pinnedSlot, undefined);
    assert.equal(Object.hasOwn(qDel, 'pinnedSlot'), false);
    assert.equal(core.planAt(qDel, '2026-04-25').pinnedSlot, undefined);
    assert.equal(core.planAt(qDel, '2026-03-01').pinnedSlot, undefined);
    assert.equal(qDel.doseAmount, 750);
    assert.equal(core.planAt(qDel, '2026-03-01').doseAmount, 250);

    const fMat = core.materializePlan(
      { id: 'f1', doseAmount: 250, timeline: [{ id: 'r1', from: '2026-04-10', doseAmount: 500 }] },
      '2026-04-15',
    );
    assert.equal(fMat.doseAmount, 500);
    assert.equal(core.planAt(fMat, '2026-04-01').doseAmount, 250);
    assert.equal(core.materializePlan(fMat, '2026-04-15'), fMat);

    // Partial legacy protocol-os timeline preserves untouched fields
    const legacyPlan = {
      doseMcg: 250,
      doseUnit: 'mcg',
      schedule: { every: 2, anchor: '2026-11-01' },
      timeline: [
        { id: 'tl_0', from: null, doseMcg: 250 },
        { id: 'tl_1', from: '2026-11-15', doseMcg: 500 },
      ],
    };
    const effLegacy = core.planAt(legacyPlan, '2026-11-10');
    assert.equal(effLegacy.schedule.every, 2);
    assert.equal(effLegacy.doseUnit, 'mcg');

    // `every > 1` with timeline preserves exact === identity across repeated materializePlan calls
    let e = { id: 'e1', startDate: '2026-11-01', doseAmount: 250, schedule: { every: 2, anchor: '2026-11-01' } };
    e = core.applyRevision(e, '2026-11-15', { doseAmount: 500 }, '2026-11-10');
    const m1 = core.materializePlan(e, '2026-11-10');
    const m2 = core.materializePlan(m1, '2026-11-10');
    assert.equal(m1, m2);
    const m3 = core.materializePlan(m1, '2026-11-20');
    const m4 = core.materializePlan(m3, '2026-11-20');
    assert.equal(m3, m4);

    // Group D: evaluateDose non-mass dimension & unit precision
    const dropVsMcg = core.evaluateDose(
      { compoundId: 'serum', doseMcg: 500, doseUnit: 'drops' },
      { scheduledDoseAmount: 500, scheduledDoseUnit: 'mcg' },
    );
    assert.equal(dropVsMcg.decision, 'BLOCK');
    assert.equal(dropVsMcg.dimension, 'count_or_topical');
    assert.ok(dropVsMcg.flags.includes('UNIT_DIMENSION_MISMATCH'));
    const softDropVsMcg = core.softenVerdict(dropVsMcg);
    assert.equal(softDropVsMcg.decision, 'CONFIRM');
    assert.equal(softDropVsMcg.needsReview, true);

    const dropVsSchedMcg = core.evaluateDose(
      { compoundId: 'serum', doseMcg: 500, doseUnit: 'drops' },
      { scheduledDoseMcg: 500 },
    );
    assert.equal(dropVsSchedMcg.decision, 'BLOCK');
    assert.ok(dropVsSchedMcg.flags.includes('UNIT_DIMENSION_MISMATCH'));

    const dropVsPumpCeil = core.evaluateDose(
      { compoundId: 'serum', doseAmount: 1, doseUnit: 'drops' },
      { maxCeiling: { maxAmount: 2, unit: 'pumps', per: 'dose' }, scheduledDoseAmount: 1, scheduledDoseUnit: 'drops' },
    );
    assert.equal(dropVsPumpCeil.decision, 'BLOCK');
    assert.ok(dropVsPumpCeil.flags.includes('UNIT_DIMENSION_MISMATCH'));

    const dropVsDropCeil = core.evaluateDose(
      { compoundId: 'serum', doseAmount: 1, doseUnit: 'drops' },
      { maxCeiling: { maxAmount: 2, unit: 'drops', per: 'dose' }, scheduledDoseAmount: 1, scheduledDoseUnit: 'drops' },
    );
    assert.equal(dropVsDropCeil.decision, 'PASS');

    const pumpVsDropPrior = core.evaluateDose(
      { compoundId: 'serum', doseAmount: 10, doseUnit: 'pumps' },
      { priorDoseAmount: 2, priorUnit: 'drops', freqPerWeek: 7 },
    );
    assert.equal(pumpVsDropPrior.decision, 'BLOCK');
    assert.ok(pumpVsDropPrior.flags.includes('UNIT_SWITCH'));
    assert.equal(pumpVsDropPrior.flags.includes('DOSE_JUMP_5X'), false);
    assert.equal(pumpVsDropPrior.flags.includes('WEEKLY_JUMP_5X'), false);

    const dropVsDropJump = core.evaluateDose(
      { compoundId: 'serum', doseAmount: 10, doseUnit: 'drops' },
      { priorDoseAmount: 2, priorUnit: 'drops' },
    );
    assert.equal(dropVsDropJump.decision, 'BLOCK');
    assert.ok(dropVsDropJump.flags.includes('DOSE_JUMP_5X'));
    assert.equal(dropVsDropJump.flags.includes('UNIT_SWITCH'), false);

    const legacyMassMg = core.evaluateDose(
      { compoundId: 'test-cyp', doseMcg: 50000, doseUnit: 'mg' },
      { scheduledDoseAmount: 50, scheduledDoseUnit: 'mg' },
    );
    assert.equal(legacyMassMg.decision, 'PASS');
  });

  it('hardens deepClone, mergeStates, protocol-os IU/mg/g inheritance, zero-regression secret stripping/redaction, validateHubExport, and CSV redaction/Unicode formula defense', () => {
    // T1: deepClone strips own __proto__/constructor/prototype on plain JSON + preserves rich types & circular refs
    const parsedPoison = JSON.parse(
      '{"safe":1,"nested":{"__proto__":{"p":1},"ok":2},"__proto__":{"isAdmin":true},"constructor":{"bad":1},"prototype":{"bad":2}}',
    );
    const cloned = core.deepClone(parsedPoison);
    assert.equal(cloned.safe, 1);
    assert.equal(cloned.nested.ok, 2);
    assert.equal(Object.hasOwn(cloned, '__proto__'), false);
    assert.equal(Object.hasOwn(cloned, 'constructor'), false);
    assert.equal(Object.hasOwn(cloned, 'prototype'), false);
    assert.equal(Object.hasOwn(cloned.nested, '__proto__'), false);
    const assigned = Object.assign({}, cloned);
    assert.equal(assigned.isAdmin, undefined);
    assert.equal(Object.getPrototypeOf(assigned), Object.prototype);

    const rich = {
      d: new Date('2026-05-01T00:00:00Z'),
      re: /abc/gi,
      s: new Set([1, 2]),
      m: new Map([['k', { v: 3 }]]),
      u8: new Uint8Array([1, 2, 3]),
    };
    rich.self = rich;
    const richClone = core.deepClone(rich);
    assert.equal(richClone.d instanceof Date, true);
    assert.equal(richClone.d.toISOString(), '2026-05-01T00:00:00.000Z');
    assert.equal(richClone.re instanceof RegExp, true);
    assert.equal(richClone.re.flags, 'gi');
    assert.equal(richClone.s instanceof Set, true);
    assert.equal(richClone.s.has(2), true);
    assert.equal(richClone.m instanceof Map, true);
    assert.equal(richClone.m.get('k').v, 3);
    assert.equal(richClone.u8 instanceof Uint8Array, true);
    assert.deepEqual([...richClone.u8], [1, 2, 3]);
    assert.equal(richClone.self, richClone);

    // T2: mergeStates prototype hijacking defense
    const loc = core.createEmptyHubState({ now: '2026-10-01T00:00:00.000Z' });
    const rem = JSON.parse(
      '{"settings":{"updatedAt":"2026-10-05T00:00:00.000Z","__proto__":{"isAdmin":true}},"compounds":[{"id":"c1","name":"BPC","sectionId":"peptides","updatedAt":"2026-10-05T00:00:00.000Z","__proto__":{"profileStatus":"verified"}}]}',
    );
    const merged = core.mergeStates(loc, rem, { nowIso: '2026-10-10T00:00:00.000Z' });
    assert.equal(Object.hasOwn(merged.settings, '__proto__'), false);
    assert.equal(Object.hasOwn(merged.compounds[0], '__proto__'), false);
    const assignedSettings = Object.assign({}, merged.settings);
    assert.equal(assignedSettings.isAdmin, undefined);
    assert.equal(Object.getPrototypeOf(assignedSettings), Object.prototype);

    // T3: validateProtocolOsExport & importProtocolOsExport prototype defense + profileMap/ingredients 'constructor' guard
    const evilPos =
      '{"_format":"protocol-os-export/v1","meta":{"__proto__":{"hijacked":true}},"vials":[{"id":"v1","peptideId":"__pen__","isPen":true,"penName":"P","penComponents":[{"peptideId":"bpc-157","mg":5,"__proto__":{"hijacked":true},"constructor":{"x":1}},{"peptideId":"tb-500","mg":5},{"peptideId":"constructor","mg":1}],"diluentMl":2,"active":true}],"protocols":[{"id":"p1","profile":"constructor","peptideId":"__pen__","penVialId":"v1","doseMcg":500,"schedule":{"days":[1]},"timeline":[{"id":"t1","from":"2026-11-01","doseMcg":500,"__proto__":{"hijacked":true}}]}],"logs":[]}';
    const valPos = core.validateProtocolOsExport(evilPos);
    assert.equal(valPos.ok, true);
    assert.equal(Object.hasOwn(valPos.meta, '__proto__'), false);
    assert.equal(Object.hasOwn(valPos.vials[0].penComponents[0], '__proto__'), false);
    assert.equal(Object.hasOwn(valPos.vials[0].penComponents[0], 'constructor'), false);
    assert.equal(Object.hasOwn(valPos.protocols[0].timeline[0], '__proto__'), false);

    const impPos = core.importProtocolOsExport(core.createEmptyHubState(), evilPos);
    assert.equal(impPos.ok, true);
    assert.equal(Object.hasOwn(impPos.state.ownership[0].reconstitution.penComponents[0], '__proto__'), false);
    assert.equal(Object.hasOwn(impPos.state.ownership[0].reconstitution.penComponents[0], 'constructor'), false);
    assert.equal(Object.hasOwn(impPos.state.stacks[0].items[0].timeline[0], '__proto__'), false);
    assert.equal(impPos.state.stacks[0].memberId, 'member_wife');
    assert.equal(Object.hasOwn(impPos.state.compounds[0].sectionData.ingredients, 'constructor'), false);

    // T4: importProtocolOsExport IU & mg/g inheritance on stackItems, logs, skipped logs, orphan vial logs, explicit overrides
    const unitPayload = {
      _format: 'protocol-os-export/v1',
      vials: [
        { id: 'v_hcg', peptideId: 'hcg', peptideName: 'HCG', mgPerVial: 5, iuPerVial: 5000, unitLabel: 'IU', diluentMl: 5, remainingMcg: 2500, doseMcg: 500, active: true },
      ],
      protocols: [
        { id: 'p_hcg', peptideId: 'hcg', peptideName: 'HCG', vialId: 'v_hcg', doseMcg: 500, schedule: { days: [1, 4] } },
        { id: 'p_hcg_unlinked', peptideId: 'hcg', peptideName: 'HCG', doseMcg: 500, schedule: { days: [1, 4] } },
        { id: 'p_anavar', peptideId: 'anavar', peptideName: 'Anavar', doseMcg: 50000, doseUnit: 'mg', doseValue: 50, route: 'oral', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
        { id: 'p_creatine', peptideId: 'creatine', peptideName: 'Creatine Monohydrate', doseMcg: 5_000_000, doseUnit: 'g', route: 'oral', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
      ],
      logs: [
        { id: 'l_hcg', protocolId: 'p_hcg', vialId: 'v_hcg', peptideId: 'hcg', peptide: 'HCG', doseMcg: 500, datetime: '2026-11-20T08:00:00Z' },
        { id: 'l_hcg_skip', protocolId: 'p_hcg', peptideId: 'hcg', peptide: 'HCG', doseMcg: 0, skipped: true, datetime: '2026-11-21T08:00:00Z' },
        { id: 'l_anavar', protocolId: 'p_anavar', peptideId: 'anavar', peptide: 'Anavar', doseMcg: 50000, datetime: '2026-11-20T08:00:00Z' },
        { id: 'l_creatine', protocolId: 'p_creatine', peptideId: 'creatine', peptide: 'Creatine Monohydrate', doseMcg: 5_000_000, datetime: '2026-11-20T08:00:00Z' },
        { id: 'l_orphan_hcg', vialId: 'v_hcg', peptideId: 'hcg', peptide: 'HCG', doseMcg: 500, datetime: '2026-11-19T08:00:00Z' },
        { id: 'l_override', protocolId: 'p_anavar', peptideId: 'anavar', peptide: 'Anavar', doseMcg: 500, doseUnit: 'mcg', datetime: '2026-11-18T08:00:00Z' },
      ],
    };
    const unitRes = core.importProtocolOsExport(core.createEmptyHubState(), unitPayload);
    assert.equal(unitRes.ok, true);
    const items = unitRes.state.stacks[0].items;
    const hcgItem = items.find((i) => i.id === 'pos_item_p_hcg');
    assert.equal(hcgItem.doseUnit, 'IU');
    assert.equal(hcgItem.doseAmount, 500);
    assert.equal(hcgItem.doseMcg, null);

    const hcgUnlinked = items.find((i) => i.id === 'pos_item_p_hcg_unlinked');
    assert.equal(hcgUnlinked.doseUnit, 'IU');
    assert.equal(hcgUnlinked.doseAmount, 500);
    assert.equal(hcgUnlinked.doseMcg, null);

    const logById = (id) => unitRes.state.logs.find((l) => l.id === id);
    assert.equal(logById('pos_log_l_hcg').doseUnit, 'IU');
    assert.equal(logById('pos_log_l_hcg').doseAmount, 500);
    assert.equal(logById('pos_log_l_hcg').doseMcg, null);
    assert.equal(logById('pos_log_l_hcg_skip').doseUnit, 'IU');
    assert.equal(logById('pos_log_l_hcg_skip').doseMcg, null);
    assert.equal(logById('pos_log_l_hcg_skip').skipped, true);
    assert.equal(logById('pos_log_l_anavar').doseUnit, 'mg');
    assert.equal(logById('pos_log_l_anavar').doseAmount, 50);
    assert.equal(logById('pos_log_l_anavar').doseMcg, 50000);
    assert.equal(logById('pos_log_l_creatine').doseUnit, 'g');
    assert.equal(logById('pos_log_l_creatine').doseAmount, 5);
    assert.equal(logById('pos_log_l_orphan_hcg').doseUnit, 'IU');
    assert.equal(logById('pos_log_l_orphan_hcg').doseMcg, null);
    assert.equal(logById('pos_log_l_override').doseUnit, 'mcg');
    assert.equal(logById('pos_log_l_override').doseAmount, 500);

    // Seeded IU compound fallback when neither protocol nor vial specifies doseUnit/unitLabel
    const seededForIu = core.seedStarterCatalog(core.createEmptyHubState()).state;
    const seededIuImport = core.importProtocolOsExport(seededForIu, {
      _format: 'protocol-os-export/v1',
      vials: [],
      protocols: [{ id: 'p_hcg_bare', peptideId: 'hcg', doseMcg: 250, schedule: { days: [1, 4] } }],
      logs: [{ id: 'l_hcg_bare', protocolId: 'p_hcg_bare', peptideId: 'hcg', doseMcg: 250, datetime: '2026-11-20T08:00:00Z' }],
    });
    assert.equal(seededIuImport.ok, true);
    const bareItem = seededIuImport.state.stacks[0].items.find((i) => i.id === 'pos_item_p_hcg_bare');
    assert.equal(bareItem.doseUnit, 'IU');
    assert.equal(bareItem.doseAmount, 250);
    assert.equal(bareItem.doseMcg, null);
    const bareLog = seededIuImport.state.logs.find((l) => l.id === 'pos_log_l_hcg_bare');
    assert.equal(bareLog.doseUnit, 'IU');
    assert.equal(bareLog.doseAmount, 250);
    assert.equal(bareLog.doseMcg, null);

    // T5: isSensitiveKey zero-regression (unseparated + new keys + benign keys + full seeded HubState)
    const secretObj = {
      apikey: 'X1',
      APIKEY: 'X2',
      passcodehash: 'X3',
      pinhash: 'X4',
      clientsecret: 'X5',
      accesstoken: 'X6',
      refreshtoken: 'X7',
      admintoken: 'X8',
      pin: '1234',
      devicePin: '5678',
      lockPin: '9999',
      householdPin: '4321',
      authorizationHeader: 'Bearer abc',
      authorization_header: 'Bearer def',
      jwt: 'a.b.c',
      encryptionKey: 'enc_val',
      client_credentials: 'cred_val',
      session_cookie: 'cook_val',
      // Benign keys that MUST survive
      key: 'k',
      primaryKey: 'pk',
      apiVersion: 'v1',
      pinned: true,
      pinnedSlot: 'morning_am',
      pinOverride: 'bedtime_fasted',
      estimatedTokens: 100,
      maxEstimatedTokens: 16000,
      tokenBudget: 8000,
      ghSecretagogue: true,
      chemicalSalt: 'glycinate',
      firstPassMetabolism: 'moderate',
    };
    const strippedObj = core.stripSecrets(secretObj);
    for (const secKey of [
      'apikey', 'APIKEY', 'passcodehash', 'pinhash', 'clientsecret', 'accesstoken',
      'refreshtoken', 'admintoken', 'pin', 'devicePin', 'lockPin', 'householdPin',
      'authorizationHeader', 'authorization_header', 'jwt', 'encryptionKey',
      'client_credentials', 'session_cookie',
    ]) {
      assert.equal(Object.hasOwn(strippedObj, secKey), false, `Secret key ${secKey} was not stripped`);
    }
    for (const okKey of [
      'key', 'primaryKey', 'apiVersion', 'pinned', 'pinnedSlot', 'pinOverride',
      'estimatedTokens', 'maxEstimatedTokens', 'tokenBudget', 'ghSecretagogue',
      'chemicalSalt', 'firstPassMetabolism',
    ]) {
      assert.equal(Object.hasOwn(strippedObj, okKey), true, `Benign key ${okKey} was wrongly stripped`);
    }
    const seededState = core.seedStarterCatalog(core.createEmptyHubState()).state;
    assert.deepEqual(core.stripSecrets(seededState), seededState);

    // T6: redactSensitiveText JSON, quoted multi-word, escaped quotes, URL &other=1, Authorization Basic, bare JWT
    const jsonRedacted = core.redactSensitiveText('{"api_key": "super_secret_val_abc", "token": "tok_xyz_999"}');
    assert.equal(jsonRedacted.includes('super_secret_val_abc'), false);
    assert.equal(jsonRedacted.includes('tok_xyz_999'), false);
    assert.deepEqual(JSON.parse(jsonRedacted), { api_key: '[REDACTED]', token: '[REDACTED]' });

    const quotedSpace1 = core.redactSensitiveText('passcode="my secret pass 123"');
    assert.equal(quotedSpace1, 'passcode="[REDACTED]"');
    const quotedSpace2 = core.redactSensitiveText("password='my secret 456'");
    assert.equal(quotedSpace2, "password='[REDACTED]'");
    const escapedJson = core.redactSensitiveText('{"passcode": "my \\"quoted\\" secret"}');
    assert.equal(escapedJson.includes('quoted'), false);
    assert.equal(escapedJson.includes('secret'), false);
    assert.deepEqual(JSON.parse(escapedJson), { passcode: '[REDACTED]' });

    const urlRedacted = core.redactSensitiveText('https://hub.example/mcp?token=abc12345&other=1#sec');
    assert.equal(urlRedacted, 'https://hub.example/mcp?token=[REDACTED]&other=1#sec');

    const basicRedacted = core.redactSensitiveText('Authorization: Basic dXNlcjpwYXNz');
    assert.equal(basicRedacted.includes('dXNlcjpwYXNz'), false);
    assert.ok(basicRedacted.includes('[REDACTED]'));

    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dummysignature123';
    assert.equal(core.redactSensitiveText(`Use ${fakeJwt} now`).includes('eyJ'), false);

    // Zero false redactions on seeded starter catalog
    const allSeededStrings = [];
    const walkStrings = (val) => {
      if (typeof val === 'string') allSeededStrings.push(val);
      else if (Array.isArray(val)) val.forEach(walkStrings);
      else if (val && typeof val === 'object') Object.values(val).forEach(walkStrings);
    };
    walkStrings(seededState);
    for (const s of allSeededStrings) {
      assert.equal(core.redactSensitiveText(s), s, `False redaction on starter string: ${s}`);
    }

    // T7: validateHubExport empty-after-strip + exportCompoundsCsv redaction + Unicode Cc/Cf formula defense
    const emptyAfterStrip = core.validateHubExport(
      '{"_format":"home-pharmacy-export/v1","settings":{"__proto__":{"isAdmin":true},"admin_token":"tok_123"}}',
    );
    assert.equal(emptyAfterStrip.ok, false);
    assert.equal(emptyAfterStrip.sanitized, null);

    const csvState = core.createEmptyHubState();
    csvState.compounds = [
      {
        id: 'c_sec',
        name: 'Sec Compound',
        sectionId: 'peptides',
        summary: 'Summary with AIzaSyDummyKey123456789',
        mechanismOfAction: 'MoA with Bearer dummy_bearer_token_999',
        notes: '{"api_key": "json_csv_secret_777"}',
      },
    ];
    const csvOut = core.exportCompoundsCsv(csvState);
    assert.equal(csvOut.includes('AIzaSyDummyKey123456789'), false);
    assert.equal(csvOut.includes('dummy_bearer_token_999'), false);
    assert.equal(csvOut.includes('json_csv_secret_777'), false);

    for (const invis of ['\u00AD=1+1', '\u034F+1+1', '\u180E-1+1', '\u3164@SUM(1,2)', '\u061C=1+1']) {
      const esc = core.escapeCsvCell(invis);
      const unwrapped = esc.startsWith('"') && esc.endsWith('"') ? esc.slice(1, -1).replace(/""/g, '"') : esc;
      assert.equal(unwrapped.startsWith("'"), true, `Failed to neutralize invisible formula cell ${JSON.stringify(invis)}`);
    }
    assert.equal(core.escapeCsvCell('BPC-157'), 'BPC-157');
  });
});

// ---------------------------------------------------------------------------
// 15. Iteration 4 Zero-Regression, Prototype, Timeline & ReDoS Hardening
// ---------------------------------------------------------------------------
describe('Iteration 4 Zero-Regression, Prototype, Timeline & ReDoS Hardening', () => {
  const NOW = '2026-11-22T12:00:00.000Z';

  it('hardens schema.js: validateMember proto/aliasing/sparse guards, validateOwnershipRecord types, timestamp fallbacks, and proactive invariants', () => {
    // 1. validateMember prototype hijacking defense + canonical-only allowlist
    const poisonedMember = JSON.parse(
      '{"name":"Member One","routineAnchors":{"__proto__":{"isAdmin":true},"constructor":{"bad":1},"prototype":{"bad":2},"toString":"pwn","extra":{"nested":1},"wake":"06:30"},"safetyContext":{"__proto__":{"bypass":true},"constructor":{"bad":3},"prototype":{"bad":4},"extra":{"nested":2},"allergies":["sulfa"]}}',
    );
    const mRes = core.validateMember(poisonedMember, [], { now: NOW });
    assert.equal(mRes.ok, true);
    assert.equal(mRes.normalized.routineAnchors.wake, '06:30');
    assert.deepEqual(mRes.normalized.safetyContext.allergies, ['sulfa']);

    for (const badKey of ['__proto__', 'constructor', 'prototype', 'toString', 'extra']) {
      assert.equal(Object.hasOwn(mRes.normalized.routineAnchors, badKey), false, `routineAnchors leaked ${badKey}`);
      assert.equal(Object.hasOwn(mRes.normalized.safetyContext, badKey), false, `safetyContext leaked ${badKey}`);
    }
    const mergedAnchors = Object.assign({}, mRes.normalized.routineAnchors);
    assert.equal(mergedAnchors.isAdmin, undefined);
    assert.equal(Object.getPrototypeOf(mergedAnchors), Object.prototype);
    const mergedSafety = Object.assign({}, mRes.normalized.safetyContext);
    assert.equal(mergedSafety.bypass, undefined);
    assert.equal(Object.getPrototypeOf(mergedSafety), Object.prototype);

    // 2. validateMember caller non-aliasing + non-plain / sparse / non-string rejections
    const callerMember = {
      name: 'Member Two',
      routineAnchors: { wake: '07:00', workoutDays: [1, 3, 5] },
      safetyContext: { allergies: ['penicillin'], activeRxMeds: [], conditions: [] },
    };
    const mClean = core.validateMember(callerMember, [], { now: NOW });
    assert.equal(mClean.ok, true);
    callerMember.routineAnchors.workoutDays.push(6);
    callerMember.safetyContext.allergies.push('mutated');
    assert.deepEqual(mClean.normalized.routineAnchors.workoutDays, [1, 3, 5]);
    assert.deepEqual(mClean.normalized.safetyContext.allergies, ['penicillin']);

    assert.equal(core.validateMember({ name: 'M', routineAnchors: new Date() }).ok, false);
    assert.equal(core.validateMember({ name: 'M', safetyContext: new Map() }).ok, false);
    assert.equal(core.validateMember({ name: 'M', routineAnchors: { workoutDays: Array(2) } }).ok, false);
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(core.validateMember({ name: 'M', safetyContext: { allergies: [, 'latex'] } }).ok, false);
    assert.equal(core.validateMember({ name: 'M', id: 123 }).errors.some((e) => e.field === 'id' && e.code === 'INVALID_TYPE'), true);
    assert.equal(core.validateMember({ name: 'M', avatarInitial: {} }).errors.some((e) => e.field === 'avatarInitial' && e.code === 'INVALID_TYPE'), true);

    // 3. validateOwnershipRecord non-string unit/vendor/notes/scope/id/dates + reconstitution proto defense
    for (const strField of ['unit', 'vendor', 'notes', 'scope', 'id']) {
      for (const badVal of [123, true, ['vial'], JSON.parse('{"__proto__":{"p":1}}')]) {
        const res = core.validateOwnershipRecord({ compoundId: 'bpc-157', status: 'have', [strField]: badVal }, { now: NOW });
        assert.equal(res.ok, false, `Expected ${strField}=${JSON.stringify(badVal)} to fail`);
        assert.equal(res.normalized, null);
        assert.equal(res.errors.some((e) => e.field === strField && e.code === 'INVALID_TYPE'), true);
      }
    }
    for (const dateField of ['expiryDate', 'openedAt']) {
      const badType = core.validateOwnershipRecord({ compoundId: 'bpc-157', status: 'have', [dateField]: 20260101 });
      assert.equal(badType.ok, false);
      assert.equal(badType.errors.some((e) => e.field === dateField && e.code === 'INVALID_TYPE'), true);
      const badDate = core.validateOwnershipRecord({ compoundId: 'bpc-157', status: 'have', [dateField]: '2026-02-30' });
      assert.equal(badDate.ok, false);
      assert.equal(badDate.errors.some((e) => e.field === dateField && e.code === 'INVALID_DATE'), true);
    }
    assert.equal(
      core.validateOwnershipRecord({ compoundId: 'bpc-157', status: 'have', reconstitution: new Date() }).errors.some(
        (e) => e.field === 'reconstitution' && e.code === 'INVALID_TYPE',
      ),
      true,
    );
    const validOwn = core.validateOwnershipRecord(
      {
        compoundId: 'bpc-157',
        status: 'have',
        unit: '  vials  ',
        vendor: null,
        notes: '  cold storage  ',
        reconstitution: JSON.parse('{"vialMg":10,"diluentMl":2,"oilConcentrationMgPerMl":200,"__proto__":{"p":1}}'),
      },
      { now: NOW },
    );
    assert.equal(validOwn.ok, true);
    assert.equal(validOwn.normalized.unit, 'vials');
    assert.equal(validOwn.normalized.vendor, null);
    assert.equal(validOwn.normalized.notes, 'cold storage');
    assert.equal(validOwn.normalized.reconstitution.oilConcentrationMgPerMl, 200);
    assert.equal(Object.hasOwn(validOwn.normalized.reconstitution, '__proto__'), false);

    // 4. createdAt / updatedAt fallback guards across ALL validators & normalizers
    const badTimestamps = [{}, 123, ['x'], '', '   ', JSON.parse('{"__proto__":{"x":1}}')];
    for (const badTs of badTimestamps) {
      const vm = core.validateMember({ name: 'TS Check', createdAt: badTs, updatedAt: badTs }, [], { now: NOW });
      assert.equal(vm.ok, true);
      assert.equal(vm.normalized.createdAt, NOW);
      assert.equal(vm.normalized.updatedAt, NOW);

      const vo = core.validateOwnershipRecord({ compoundId: 'bpc-157', status: 'have', updatedAt: badTs }, { now: NOW });
      assert.equal(vo.ok, true);
      assert.equal(vo.normalized.updatedAt, NOW);

      const vs = core.validateStack({ memberId: 'member_wife', name: 'Stack TS', createdAt: badTs, updatedAt: badTs }, { now: NOW });
      assert.equal(vs.ok, true);
      assert.equal(vs.normalized.createdAt, NOW);
      assert.equal(vs.normalized.updatedAt, NOW);

      const nc = core.normalizeCompoundProfile(
        { name: 'Test Cmp', sectionId: 'peptides', createdAt: badTs, updatedAt: badTs, provenance: { researchedAt: badTs } },
        { now: NOW },
      );
      assert.equal(nc.createdAt, NOW);
      assert.equal(nc.updatedAt, NOW);
      assert.equal(nc.provenance.researchedAt, NOW);

      const nh = core.normalizeHubState(
        {
          settings: { createdAt: badTs, updatedAt: badTs },
          sections: [{ id: 'peptides', name: 'Peptides', isCore: true, updatedAt: badTs }],
          meta: { createdAt: badTs, updatedAt: badTs },
        },
        { now: NOW },
      );
      assert.equal(nh.settings.createdAt, NOW);
      assert.equal(nh.settings.updatedAt, NOW);
      assert.equal(nh.meta.createdAt, NOW);
      assert.equal(nh.meta.updatedAt, NOW);
      assert.equal(nh.sections.find((s) => s.id === 'peptides').updatedAt, NOW);
    }

    // 5. Proactive schema hardening (10 latent defects)
    // (a) add/update/removeCustomField with key 'length' on malformed compound having array customFields/archivedCustomFields
    const secPeptides = core.createDefaultSections(NOW)[0];
    const malformedCmp = { id: 'c1', sectionId: 'peptides', customFields: [], archivedCustomFields: [] };
    const addLen = core.addCustomField(secPeptides, { key: 'length', label: 'Length', fieldType: 'number' }, { compounds: [malformedCmp], now: NOW });
    assert.equal(addLen.ok, true);
    const updLen = core.updateCustomField(addLen.section, 'length', { key: 'length_mm' }, { compounds: [malformedCmp], now: NOW });
    assert.equal(updLen.ok, true);
    const remLen = core.removeCustomField(addLen.section, 'length', { compounds: [malformedCmp], now: NOW });
    assert.equal(remLen.ok, true);

    // (b) addCustomSubsection / removeCustomSubsection non-aliasing
    const rawSec = { ...core.createDefaultSections(NOW)[0], subsections: ['Sub A', 'Sub B'] };
    const addedSub = core.addCustomSubsection(rawSec, 'Sub C', { now: NOW });
    assert.equal(addedSub.ok, true);
    const removedSub = core.removeCustomSubsection(addedSub.section, 'Sub A', { now: NOW });
    assert.equal(removedSub.ok, true);
    assert.deepEqual(rawSec.subsections, ['Sub A', 'Sub B']);

    // (c) doNotPairWith[].citation rejects single-slash/backslash/schemeless http(s)
    for (const badCit of ['https:\\evil.com', 'https:/evil.com', 'http:evil.com']) {
      const citRes = core.validateCompoundProfile({
        name: 'Zinc Test',
        sectionId: 'vitamins_supplements',
        doNotPairWith: [{ targetType: 'nutrient', targetRef: 'copper', severity: 'avoid_same_slot', citation: badCit }],
      });
      assert.equal(citRes.ok, false, `Expected bad citation ${badCit} to fail`);
      assert.equal(citRes.errors.some((e) => e.code === 'INVALID_CITATION_URL'), true);
    }
    const okCitRes = core.validateCompoundProfile({
      name: 'Zinc Test',
      sectionId: 'vitamins_supplements',
      doNotPairWith: [
        { targetType: 'nutrient', targetRef: 'copper', severity: 'avoid_same_slot', citation: 'FDA Label Section 7' },
        { targetType: 'nutrient', targetRef: 'iron', severity: 'avoid_same_slot', citation: 'PMID: 12345678' },
      ],
    });
    assert.equal(okCitRes.ok, true);

    // (d) provenance.citations rejects non-string/array/null-proto pmid & nct
    const badProv = core.validateCompoundProfile({
      name: 'Prov Check',
      sectionId: 'peptides',
      provenance: {
        citations: [
          { title: 'Study 1', url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/', pmid: ['123'], nct: ['NCT12345'] },
          { title: 'Study 2', url: 'https://pubmed.ncbi.nlm.nih.gov/87654321/', pmid: Object.create(null), nct: Object.create(null) },
        ],
      },
    });
    assert.equal(badProv.ok, false);
    assert.equal(badProv.errors.filter((e) => e.code === 'INVALID_PMID').length, 2);
    assert.equal(badProv.errors.filter((e) => e.code === 'INVALID_NCT').length, 2);

    // (e) sectionData.ingredients excludes __proto__ from sum (idempotent with normalized)
    const protoIngInput = {
      name: 'Proto Blend',
      sectionId: 'peptides',
      sectionData: { ingredients: JSON.parse('{"__proto__":0.5,"bpc-157":0.5}') },
    };
    const protoIngRes = core.validateCompoundProfile(protoIngInput);
    assert.equal(protoIngRes.ok, false);
    assert.equal(protoIngRes.errors.some((e) => e.code === 'INVALID_INGREDIENT_SUM'), true);
    const protoIngRes2 = core.validateCompoundProfile(protoIngRes.normalized);
    assert.equal(protoIngRes2.ok, false);
    assert.equal(protoIngRes2.errors.some((e) => e.code === 'INVALID_INGREDIENT_SUM'), true);

    // (f) validateHubState rejects duplicate section IDs
    const dupSecState = core.createEmptyHubState({ now: NOW });
    dupSecState.sections.push({ ...dupSecState.sections[0] });
    const dupSecRes = core.validateHubState(dupSecState);
    assert.equal(dupSecRes.ok, false);
    assert.equal(dupSecRes.errors.some((e) => e.code === 'DUPLICATE_SECTION'), true);

    // (g) validateStack rejects non-string id & description
    const badStack = core.validateStack({ id: 42, description: { bad: true }, memberId: 'member_wife', name: 'S' });
    assert.equal(badStack.ok, false);
    assert.equal(badStack.errors.some((e) => e.field === 'id' && e.code === 'INVALID_TYPE'), true);
    assert.equal(badStack.errors.some((e) => e.field === 'description' && e.code === 'INVALID_TYPE'), true);

    // (h) null-proto safe helpers & floating-point dust clamp
    assert.equal(core.resolveEffectiveOwnership('bpc-157', Object.create(null), []).status, 'dont_have');
    assert.equal(core.slugify(Object.create(null)), '');
    assert.ok(core.generateId(Object.create(null)).startsWith('id_'));
    const dustRes = core.deductOwnershipDose({ id: 'o1', compoundId: 'c1', status: 'have', remainingDoses: 0.3 }, 0.3 - 1e-13, { now: NOW });
    assert.equal(dustRes.ok, true);
    assert.equal(dustRes.record.remainingDoses, 0);
    assert.equal(dustRes.record.status, 'dont_have');
  });

  it('hardens dedup.js: plural STRENGTH_RE & Greek μg, edge cases, and strictly O(N) linear 50 KB ReDoS budget', () => {
    // 1. Plural denominator units + Greek μg + plural vehicle qualifiers
    const pluralCases = [
      ['Zinc 30 mg / 2 capsules', 'zinc'],
      ['BPC-157 500 mcg / 2 sprays', 'bpc-157'],
      ['BPC-157 500 µg / 2 sprays', 'bpc-157'],
      ['BPC-157 500 μg / 2 sprays', 'bpc-157'],
      ['Magnesium Glycinate 400 mg / 2 caps', 'magnesium-glycinate'],
      ['Omega-3 Fish Oil 1000 mg / 2 softgels', 'omega-3'],
      ['Creatine Monohydrate 5 g / 2 scoops', 'creatine-monohydrate'],
      ['Vitamin D3 5,000 IU / 5 drops', 'vitamin-d3'],
      ['Vitamin B12 1000 mcg / 2 tablets', 'vitamin-b12'],
      ['GHK-Cu 2 mg / 2 pumps', 'ghk-cu'],
      ['CoQ10 100 mg / 2 doses', 'coq10'],
      ['BPC-157 Nasal Sprays', 'bpc-157'],
    ];
    for (const [label, expectedCanon] of pluralCases) {
      assert.equal(core.resolveCanonicalMolecule(label), expectedCanon, `Expected "${label}" -> "${expectedCanon}"`);
      assert.equal(core.isBlendCompound({ name: label }), false, `Expected "${label}" NOT to be flagged as blend`);
    }
    assert.equal(core.isBlendCompound({ name: 'Apigenin 50 mg / 2 capsules' }), false);
    assert.equal(core.resolveCanonicalMolecule('Apigenin 50 mg / 2 capsules'), null);

    // Blends MUST STILL be detected and never collapse
    const blendCases = [
      'BPC-157 5mg / TB-500 5mg',
      'Vitamin D3 5000 IU / K2 100 mcg',
      'Zinc 30 mg / Copper 2 mg',
      'Testosterone Cypionate 200mg/mL / Nandrolone Decanoate 200mg/mL',
    ];
    for (const b of blendCases) {
      assert.equal(core.isBlendCompound({ name: b }), true, `Expected blend "${b}" to remain blend`);
      assert.equal(core.resolveCanonicalMolecule(b), null, `Expected blend "${b}" not to collapse`);
    }

    // 2. Subtle edge cases
    assert.equal(core.resolveCanonicalMolecule({ name: 'X', canonicalMolecule: '---' }), null);
    assert.equal(core.resolveCanonicalMolecule(['bpc-157']), null);
    assert.equal(core.isBlendCompound([]), false);
    const badDup = core.checkDuplicateCompound({ name: 'X', sectionId: Object.create(null) }, 'not-an-array');
    assert.equal(badDup.isDuplicate, false);
    assert.equal(badDup.classification, 'unique');
    const siblingsNoId = core.findSiblingVariants({ name: 'GHK-Cu' }, [{ name: 'Copper Peptide' }]);
    assert.equal(siblingsNoId.length, 1);

    // 3. 50 KB ReDoS linear-time performance gate (< 200 ms each)
    const redosPayloads = [
      `a${' '.repeat(50000)}x`,
      `a${'-'.repeat(50000)}a`,
      `${'a'.repeat(50000)} ! /`,
      '('.repeat(50000),
      `${'('.repeat(25000)})${'('.repeat(25000)}`,
      `1${',000'.repeat(12500)}x`,
    ];
    for (const payload of redosPayloads) {
      const t0 = performance.now();
      core.stripFormulationSuffixes(payload);
      core.resolveCanonicalMolecule(payload);
      core.isBlendCompound({ name: payload });
      core.validateCompoundProfile({ name: payload.slice(0, 160), sectionId: 'peptides', aliases: [payload] });
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 200, `dedup/schema ReDoS regression: payload took ${elapsed.toFixed(1)} ms`);
    }
  });

  it('hardens calculators.js timeline engine: legacy partial from:null promotion, dated-only timelines, === identity, and proto/aliasing defense', () => {
    // 1. Exact Secondary Reviewer Blocking #1 regression repro
    const legacyPlan = {
      doseMcg: 250,
      doseUnit: 'mcg',
      pinnedSlot: 'morning_am',
      schedule: { every: 2, anchor: '2026-11-01' },
      timeline: [
        { id: 'tl_0', from: null, doseMcg: 250 },
        { id: 'tl_1', from: '2026-11-15', doseMcg: 500 },
      ],
    };
    const updated = core.applyRevision(
      legacyPlan,
      '2026-12-01',
      { id: 'r_future', schedule: { days: [1, 3, 5] }, pinnedSlot: 'bedtime_fasted' },
      '2026-11-10',
    );
    assert.equal(updated.schedule.every, 2);
    assert.equal(updated.pinnedSlot, 'morning_am');
    assert.equal(updated.doseUnit, 'mcg');
    assert.equal(updated.doseMcg, 250);
    assert.equal(core.dueOn(core.planAt(updated, '2026-11-02'), '2026-11-02'), false);
    assert.equal(core.dueOn(core.planAt(updated, '2026-11-03'), '2026-11-03'), true);

    const midNov = core.planAt(updated, '2026-11-20');
    assert.equal(midNov.doseMcg, 500);
    assert.equal(midNov.pinnedSlot, 'morning_am');
    assert.equal(midNov.schedule.every, 2);

    const dec1 = core.planAt(updated, '2026-12-01');
    assert.equal(dec1.doseMcg, 500);
    assert.equal(dec1.pinnedSlot, 'bedtime_fasted');
    assert.deepEqual(dec1.schedule.days, [1, 3, 5]);

    assert.equal(core.materializePlan(updated, '2026-11-10'), updated);

    const reverted = core.removeRevision(updated, 'r_future', '2026-11-10');
    assert.equal(reverted.pinnedSlot, 'morning_am');
    assert.equal(reverted.schedule.every, 2);
    assert.equal(reverted.doseUnit, 'mcg');
    assert.equal(reverted.doseMcg, 250);

    // 2. Today & past revisions on legacy partial timeline
    const todayRev = core.applyRevision(legacyPlan, '2026-11-10', { id: 'r_today', pinnedSlot: 'bedtime_fasted' }, '2026-11-10');
    assert.equal(todayRev.pinnedSlot, 'bedtime_fasted');
    assert.equal(core.planAt(todayRev, '2026-11-09').pinnedSlot, 'morning_am');
    assert.equal(core.removeRevision(todayRev, 'r_today', '2026-11-10').pinnedSlot, 'morning_am');

    const pastRev = core.applyRevision(legacyPlan, '2026-11-05', { id: 'r_past', doseAmount: 300 }, '2026-11-10');
    assert.equal(core.planAt(pastRev, '2026-11-04').doseAmount, undefined);
    assert.equal(core.planAt(pastRev, '2026-11-04').pinnedSlot, 'morning_am');
    assert.equal(core.planAt(pastRev, '2026-11-05').doseAmount, 300);
    const pastRemoved = core.removeRevision(pastRev, 'r_past', '2026-11-10');
    assert.equal(pastRemoved.doseAmount, undefined);
    assert.equal(pastRemoved.pinnedSlot, 'morning_am');
    assert.equal(pastRemoved.schedule.every, 2);

    // 3. from: null update + already-materialized legacy timeline (zero retroactive leak of tl_1.slot)
    const nullUpdated = core.applyRevision(legacyPlan, null, { pinnedSlot: 'waking_fasted' }, '2026-11-10');
    assert.equal(nullUpdated.timeline[0]._baseline, true);
    assert.equal(nullUpdated.schedule.every, 2);
    assert.equal(nullUpdated.doseUnit, 'mcg');
    assert.equal(core.planAt(nullUpdated, '2026-11-15').doseMcg, 500);

    const alreadyMatLegacy = {
      doseMcg: 500,
      doseUnit: 'mcg',
      slot: 'evening_dinner',
      pinnedSlot: 'morning_am',
      schedule: { every: 2, anchor: '2026-11-01' },
      timeline: [
        { id: 'tl_0', from: null, doseMcg: 250 },
        { id: 'tl_1', from: '2026-11-15', doseMcg: 500, slot: 'evening_dinner' },
      ],
    };
    const afterMatRev = core.applyRevision(alreadyMatLegacy, '2026-12-01', { pinnedSlot: 'bedtime_fasted' }, '2026-11-20');
    assert.equal(core.planAt(afterMatRev, '2026-11-10').doseMcg, 250);
    assert.equal(core.planAt(afterMatRev, '2026-11-10').slot, undefined);
    assert.equal(core.planAt(afterMatRev, '2026-11-10').pinnedSlot, 'morning_am');
    assert.equal(core.planAt(afterMatRev, '2026-11-10').schedule.every, 2);

    // 4. Dated-only timeline (no from: null) + materializePlan + applyRevision + removeRevision
    const datedOnly = {
      doseMcg: 250,
      pinnedSlot: 'morning_am',
      timeline: [{ id: 'tl_1', from: '2026-11-15', doseMcg: 500 }],
    };
    const crossed = core.materializePlan(datedOnly, '2026-11-20');
    assert.equal(crossed.doseMcg, 500);
    assert.equal(crossed.timeline.some((e) => e.from == null && e._baseline === true), true);
    assert.equal(core.planAt(crossed, '2026-11-10').doseMcg, 250);
    assert.equal(core.materializePlan(crossed, '2026-11-20'), crossed);
    const datedReverted = core.removeRevision(crossed, 'tl_1', '2026-11-20');
    assert.equal(datedReverted.doseMcg, 250);

    // 5. Prototype pollution, caller/planAt non-aliasing & malformed from entry defense
    const poisonedSched = JSON.parse('{"days":[1,3],"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2}}');
    const safePlan = core.applyRevision({ doseMcg: 250 }, '2026-11-10', { id: 12345, schedule: poisonedSched }, '2026-11-10');
    assert.equal(typeof safePlan.timeline[1].id, 'string');
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(Object.hasOwn(safePlan.schedule, k), false);
      assert.equal(Object.hasOwn(safePlan.timeline[1].schedule, k), false);
    }
    poisonedSched.days.push(5);
    assert.deepEqual(safePlan.timeline[1].schedule.days, [1, 3]);
    const queried = core.planAt(safePlan, '2026-11-10');
    queried.schedule.days.push(6);
    assert.deepEqual(safePlan.timeline[1].schedule.days, [1, 3]);

    const withBadFrom = {
      doseMcg: 250,
      timeline: [
        { id: 'tl_0', from: null, doseMcg: 250 },
        { id: 'bad', from: 'not-a-date', doseAmount: 999 },
      ],
    };
    const afterNullRev = core.applyRevision(withBadFrom, null, { pinnedSlot: 'waking_fasted' }, '2026-11-10');
    const badEntry = afterNullRev.timeline.find((e) => e.id === 'bad');
    assert.equal(badEntry.from, 'not-a-date');
    assert.equal(afterNullRev.timeline.find((e) => e.id === 'tl_0').pinnedSlot, 'waking_fasted');
  });

  it('hardens calculators.js: [] unit rejection, IEEE-754 overflow guards, dkFromUTC, non-string route, invalid ISO rollover, PRN timelines & formatting', () => {
    // 1. Empty-array [] unit rejection across all 7 sites
    const atIso = '2026-11-10T08:00:00Z';
    assert.equal(core.remainingAt([{ at: Date.parse(atIso), amount: 250, unit: [] }], atIso, 24), null);
    const pkArrUnit = core.buildCompoundLevels({
      compound: { id: 'bpc-157', halfLife: { valueHours: 4, kind: 'elimination' }, dosages: { route: 'SubQ', defaultUnit: 'mcg' } },
      logs: [{ id: 'l1', compoundId: 'bpc-157', datetime: atIso, doseAmount: 250, doseUnit: [] }],
      now: atIso,
    });
    assert.equal(pkArrUnit.modelable, false);

    assert.equal(core.evaluateDose({ doseAmount: 250, doseUnit: [] }).flags.includes('INVALID_UNIT'), true);
    const schedArrUnit = core.evaluateDose(
      { doseAmount: 250, doseUnit: 'mcg' },
      { scheduledDoseAmount: 250, scheduledDoseUnit: [] },
    );
    assert.equal(schedArrUnit.flags.includes('INVALID_UNIT'), true);
    assert.notEqual(schedArrUnit.decision, 'PASS');

    const priorArrUnit = core.evaluateDose(
      { doseAmount: 1500, doseUnit: 'mcg' },
      { priorDoseAmount: 250, priorUnit: [] },
    );
    assert.equal(priorArrUnit.flags.includes('DOSE_JUMP_5X'), false);

    assert.equal(
      core.blendBreakdown({ vialMg: 10, diluentMl: 2, doseMcg: 500, doseUnit: [], ingredients: { a: 1, b: 1 } }).code,
      'UNIT_DIMENSION_MISMATCH',
    );

    // 2. IEEE-754 numeric overflow guards & dkFromUTC overflow
    assert.equal(core.toMassMcg(1e305, 'g'), null);
    assert.equal(core.toCanonicalAmount(1e305, 'g'), null);
    assert.equal(core.vialMath({ vialMg: 1e306, diluentMl: 1, doseMcg: 100 }).code, 'NUMERIC_OVERFLOW');
    assert.equal(core.vialMath({ vialIU: 1e308, diluentMl: 1e-10, doseIU: 100 }).code, 'NUMERIC_OVERFLOW');
    assert.equal(core.oilDrawMath({ concentrationMgPerMl: 1e306, doseAmount: 10, doseUnit: 'mg' }).code, 'NUMERIC_OVERFLOW');
    assert.equal(core.blendBreakdown({ vialMg: 10, diluentMl: 2, drawUnits: 10, ingredients: { a: 1e308, b: 1e308 } }).ok, false);
    assert.equal(core.blendBreakdown({ diluentMl: 2, drawUnits: 10, components: [{ id: 'a', mg: 1e308 }, { id: 'b', mg: 1e308 }] }).ok, false);
    assert.equal(core.dkAdd('2026-11-10', 1e12), null);
    assert.equal(core.cycleStatus({ startDate: '2026-11-01', cycleDays: 1e12 }, '2026-11-10').phase, 'active');
    assert.equal(core.levelSeries([{ at: Date.parse(atIso), amount: 100 }], atIso, 24, { days: 1e308 }), null);
    assert.equal(core.projectSupplyRunOut({ remainingAmount: 1e308, doseAmount: 1e-10, todayDk: '2026-11-10' }).ok, false);

    // 3. Non-string route guard in buildCompoundLevels
    const pkArrRoute = core.buildCompoundLevels({
      compound: { id: 'bpc-157', halfLife: { valueHours: 4, kind: 'elimination', route: 'SubQ' }, dosages: { route: 'SubQ', defaultUnit: 'mcg' } },
      logs: [{ id: 'l1', compoundId: 'bpc-157', datetime: atIso, doseAmount: 250, doseUnit: 'mcg', route: ['Oral'] }],
      now: atIso,
    });
    assert.equal(pkArrRoute.modelable, false);

    // 4. nextInjectionSite invalid ISO rollover guard
    const rot = core.nextInjectionSite([
      { datetime: '2026-02-30T08:00:00Z', site: 'R delt' },
      { datetime: '2026-03-01T08:00:00Z', site: 'L abdomen' },
    ]);
    assert.equal(rot.lastSite, 'L abdomen');
    assert.equal(rot.nextSite, 'R abdomen');

    // 5. PRN timeline transitions + bounded horizons
    const prnToDailyPlan = {
      startDate: '2026-11-01',
      schedule: { prn: true, days: [] },
      timeline: [
        { id: 'b', from: null, _baseline: true, schedule: { prn: true, days: [] } },
        { id: 'r1', from: '2026-11-12', schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
      ],
    };
    const runOut = core.projectSupplyRunOut({
      remainingDoses: 2,
      plan: prnToDailyPlan,
      todayDk: '2026-11-10',
      maxHorizonDays: Infinity,
    });
    assert.equal(runOut.ok, true);
    assert.equal(runOut.runOutDateKey, '2026-11-14');

    const dailyToPrnPlan = {
      startDate: '2026-11-01',
      schedule: { prn: true, days: [] },
      timeline: [
        { id: 'b', from: null, _baseline: true, schedule: { days: [0, 1, 2, 3, 4, 5, 6] } },
        { id: 'r1', from: '2026-11-05', schedule: { prn: true, days: [] } },
      ],
    };
    const adh = core.computeAdherence({ plan: dailyToPrnPlan, logs: [], todayDk: '2026-11-10', days: 10 });
    assert.equal(adh.expected, 4);

    // 6. Minor consistency polish: every: 1.4, -0 mcg, array canonicalizeDose
    assert.equal(core.scheduleLabel({ every: 1.4 }), 'Daily');
    assert.equal(core.formatDose(-0.0001, 'mcg'), '0 mcg');
    const arrDose = [1, 2];
    assert.equal(core.canonicalizeDose(arrDose), arrDose);
  });

  it('hardens sync.js redaction: unclosed/escaped/empty quotes, multiline, PEM, camelCase, Basic-Auth URL boundaries, idempotency & 50 KB ReDoS gate', () => {
    // Construct synthetic PEM markers via concatenation so static secret scanners never false-positive
    const pemStart = '-----' + 'BEGIN PRIVATE KEY' + '-----';
    const pemEnd = '-----' + 'END PRIVATE KEY' + '-----';
    const ecPemStart = '-----' + 'BEGIN EC PRIVATE KEY' + '-----';

    const cases = [
      ['api_key="my_unclosed_secret_123', 'api_key="[REDACTED]'],
      ["passcode='my unclosed pass", "passcode='[REDACTED]"],
      ['{"api_key":"secret_123', '{"api_key":"[REDACTED]'],
      ['{"api_key":"secret_123"}', '{"api_key":"[REDACTED]"}'],
      ['api_key="foo\\"bar', 'api_key="[REDACTED]'],
      ['api_key="foo\\"', 'api_key="[REDACTED]'],
      ['api_key="foo\\\\"', 'api_key="[REDACTED]"'],
      ['api_key="foo\\', 'api_key="[REDACTED]'],
      ['api_key=""', 'api_key="[REDACTED]"'],
      ['api_key="', 'api_key="[REDACTED]'],
      ["api_key=''", "api_key='[REDACTED]'"],
      ["api_key='", "api_key='[REDACTED]"],
      ['token="a\nnormal line', 'token="[REDACTED]\nnormal line'],
      ['token="a\r\nnormal line', 'token="[REDACTED]\r\nnormal line'],
      ['https://:secret_tok@api.example.com/v1', 'https://[REDACTED]:[REDACTED]@api.example.com/v1'],
      ['{"url":"https://example.com:8080","email":"test@example.com"}', '{"url":"https://example.com:8080","email":"test@example.com"}'],
      ['https://example.com:8080?email=test@example.com', 'https://example.com:8080?email=test@example.com'],
      [`${pemStart}\nSYNTHETIC_DUMMY_TEST_BODY\n${pemEnd}`, '[REDACTED_PRIVATE_KEY]'],
      [`${ecPemStart}\nSYNTHETIC_TRUNCATED_BODY`, '[REDACTED_PRIVATE_KEY]'],
      ['{"vapidPrivateKey": "priv_xyz", "oauthClientSecret": "sec_xyz", "householdPasscodeHash": "hash_xyz"}', '{"vapidPrivateKey": "[REDACTED]", "oauthClientSecret": "[REDACTED]", "householdPasscodeHash": "[REDACTED]"}'],
    ];

    for (const [input, expected] of cases) {
      const once = core.redactSensitiveText(input);
      assert.equal(once, expected, `Unexpected redaction for ${JSON.stringify(input)}`);
      const twice = core.redactSensitiveText(once);
      assert.equal(twice, once, `redactSensitiveText not idempotent for ${JSON.stringify(input)}`);
    }

    // Valid JSON preserved after closed-quote redaction
    assert.deepEqual(JSON.parse(core.redactSensitiveText('{"api_key":"secret_123"}')), { api_key: '[REDACTED]' });
    assert.deepEqual(
      JSON.parse(core.redactSensitiveText('{"vapidPrivateKey": "priv_xyz", "oauthClientSecret": "sec_xyz"}')),
      { vapidPrivateKey: '[REDACTED]', oauthClientSecret: '[REDACTED]' },
    );

    // 50 KB+ ReDoS linear-time performance gate (< 200 ms each)
    const redactAdversarial = [
      'a'.repeat(50000),
      `api_key="${'a'.repeat(50000)}`,
      `api_key="${'\\'.repeat(50001)}`,
      `${'a.'.repeat(25000)}://@`,
      `http://${'a'.repeat(50000)}:${'b'.repeat(50000)}`,
      `http://${'a:'.repeat(25000)}@`,
      `${'http://'.repeat(10000)}@`,
      pemStart.repeat(2000),
    ];
    for (const payload of redactAdversarial) {
      const t0 = performance.now();
      core.redactSensitiveText(payload);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 200, `redactSensitiveText ReDoS regression: took ${elapsed.toFixed(1)} ms`);
    }

    // Blocking #3 ReDoS fix in splitKeySegments / stripSecrets (formerly 4,740 ms on 50 KB uppercase key)
    const tKey0 = performance.now();
    const bigKeyOut = core.stripSecrets({ ['A'.repeat(50000)]: 'val' });
    const tKeyElapsed = performance.now() - tKey0;
    assert.equal(bigKeyOut['A'.repeat(50000)], 'val');
    assert.ok(tKeyElapsed < 200, `stripSecrets/splitKeySegments ReDoS regression: took ${tKeyElapsed.toFixed(1)} ms`);
  });

  it('hardens deepClone, stripSecrets Map/Set/RegExp, CSV full-column redaction, mergeStates, buildContextBundle & starter-catalog null guards', () => {
    // 1. deepClone prototype-safe TypedArray constructor resolution + null-proto + poisoned arrays/Maps/Sets
    const ta = new Uint8Array([1, 2, 3, 4]);
    let evilInvoked = false;
    Object.defineProperty(ta, 'constructor', {
      value: function EvilCtor() {
        evilInvoked = true;
        return { pwned: true };
      },
      enumerable: true,
      configurable: true,
    });
    const clonedTa = core.deepClone(ta);
    assert.equal(evilInvoked, false);
    assert.equal(clonedTa instanceof Uint8Array, true);
    assert.deepEqual([...clonedTa], [1, 2, 3, 4]);

    const nullProto = Object.assign(Object.create(null), { safe: 1, __proto__: { bad: 1 }, constructor: 'bad', prototype: 'bad' });
    const clonedNp = core.deepClone(nullProto);
    assert.equal(clonedNp.safe, 1);
    assert.equal(Object.hasOwn(clonedNp, '__proto__'), false);
    assert.equal(Object.hasOwn(clonedNp, 'constructor'), false);
    assert.equal(Object.hasOwn(clonedNp, 'prototype'), false);

    const poisonedArr = [1, 2];
    Object.defineProperty(poisonedArr, '__proto__', { value: { bad: 1 }, enumerable: true });
    poisonedArr.extra = 'strip-me';
    const clonedArr = core.deepClone(poisonedArr);
    assert.deepEqual(clonedArr, [1, 2]);
    assert.equal(Object.hasOwn(clonedArr, 'extra'), false);

    // 2. stripSecrets preserves Map/Set/RegExp while stripping sensitive & dangerous keys
    const secMap = new Map([
      ['api_key', 'secret1'],
      ['authKey', 'secret2'],
      ['byokKey', 'secret3'],
      ['__proto__', 'poison'],
      ['anchorKey', 'safe1'],
      ['dateKey', '2026-11-22'],
      ['vapidPublicKey', 'pub_safe'],
    ]);
    const secSet = new Set([{ authKey: 'drop', byokKey: 'drop', keep: 'ok' }]);
    const stripped = core.stripSecrets({ map: secMap, set: secSet, re: /abc/gi });
    assert.equal(stripped.map instanceof Map, true);
    assert.equal(stripped.map.has('api_key'), false);
    assert.equal(stripped.map.has('authKey'), false);
    assert.equal(stripped.map.has('byokKey'), false);
    assert.equal(stripped.map.has('__proto__'), false);
    assert.equal(stripped.map.get('anchorKey'), 'safe1');
    assert.equal(stripped.map.get('dateKey'), '2026-11-22');
    assert.equal(stripped.map.get('vapidPublicKey'), 'pub_safe');
    assert.equal(stripped.set instanceof Set, true);
    assert.deepEqual([...stripped.set], [{ keep: 'ok' }]);
    assert.equal(stripped.re instanceof RegExp, true);
    assert.equal(stripped.re.source, 'abc');

    // 3. Full-column CSV redaction + null element resilience + Hangul fillers
    const csvState = {
      sections: [null, { id: 'custom_sec', name: 'Sec token=sec_name_123' }],
      compounds: [
        {
          id: 'c_full',
          name: 'Name api_key="unclosed_name_secret',
          sectionId: 'custom_sec',
          subsection: 'Sub passcode=sub_secret_1',
          dosages: { route: 'Oral token=route_sec_1', defaultUnit: 'mg api_key=unit_sec_1' },
          timingRules: { preferredSlots: ['morning_am token=slot_sec_1'] },
          doNotPairWith: [null, { targetRef: 'X', severity: 'caution' }],
          synergies: [null, { targetRef: 'Y' }],
        },
      ],
      logs: [
        {
          id: 'l_full',
          memberId: 'member_wife',
          datetime: '2026-11-22T08:00:00Z',
          compoundName: 'Cmp api_key="log_cmp_secret',
          doseAmount: 1,
          doseUnit: 'mg token=log_unit_sec',
          route: 'SubQ password=log_route_sec',
          site: 'L abdomen passcode=log_site_sec',
          notes: 'note secret=log_note_sec',
        },
      ],
    };
    const cmpCsv = core.exportCompoundsCsv(csvState);
    for (const leaked of ['sec_name_123', 'unclosed_name_secret', 'sub_secret_1', 'route_sec_1', 'unit_sec_1', 'slot_sec_1']) {
      assert.equal(cmpCsv.includes(leaked), false, `Compounds CSV leaked ${leaked}`);
    }
    const logCsv = core.exportLogsCsv(csvState);
    for (const leaked of ['log_cmp_secret', 'log_unit_sec', 'log_route_sec', 'log_site_sec', 'log_note_sec']) {
      assert.equal(logCsv.includes(leaked), false, `Logs CSV leaked ${leaked}`);
    }
    for (const hangul of ['\u115F=1+1', '\u1160+1', '\uFFA0@SUM(1,2)']) {
      const esc = core.escapeCsvCell(hangul);
      const unwrapped = esc.startsWith('"') && esc.endsWith('"') ? esc.slice(1, -1).replace(/""/g, '"') : esc;
      assert.equal(unwrapped.startsWith("'"), true, `Hangul filler formula not neutralized: ${JSON.stringify(hangul)}`);
    }

    // 4. mergeStates type/timestamp/tombstone resilience
    const merged = core.mergeStates(
      {
        schemaVersion: { bad: 1 },
        _schemaVersion: 'bad',
        _syncedAt: { bad: 2 },
        compounds: [{ id: 'c1', name: 'Valid Timestamp', updatedAt: 'invalid-date', timestamp: '2026-11-20T00:00:00Z' }],
        meta: { tombstones: { compounds: { c1: 'not-a-timestamp' } } },
      },
      {
        _schemaVersion: NaN,
        _syncedAt: '2026-11-21T00:00:00Z',
        compounds: [{ id: 'c1', name: 'Older Remote', updatedAt: '2026-11-19T00:00:00Z' }],
      },
      { prune: false },
    );
    assert.equal(merged._schemaVersion, 1);
    assert.equal(merged._syncedAt, '2026-11-21T00:00:00Z');
    assert.equal(Object.hasOwn(merged, 'schemaVersion'), false);
    assert.equal(merged.compounds.length, 1);
    assert.equal(merged.compounds[0].name, 'Valid Timestamp');

    // 5. buildContextBundle null-element resilience
    const bundle = core.buildContextBundle({
      members: [null, { id: 'member_wife', name: 'Wife', role: 'admin' }],
      sections: [null, { id: 'peptides', name: 'Peptides', customFields: [null, { key: 'k', fieldType: 'text' }] }],
      stacks: [null, { id: 'st1', memberId: 'member_wife', name: 'S1', items: [null, { compoundId: 'c1', doseAmount: 100, doseUnit: 'mcg' }] }],
      compounds: [null, { id: 'c1', name: 'C1', sectionId: 'peptides', doNotPairWith: [null, { targetRef: 'X', severity: 'caution' }] }],
    });
    assert.equal(bundle.format, 'md');
    assert.ok(bundle.content.includes('C1'));

    // 6. starter-catalog null option & state guards
    const catNull = core.getStarterCatalog(null);
    assert.equal(catNull.compounds.length, 26);
    const seedNull = core.seedStarterCatalog(null, null);
    assert.equal(seedNull.added, 26);
    assert.equal(seedNull.state.compounds.length, 26);
  });
});
