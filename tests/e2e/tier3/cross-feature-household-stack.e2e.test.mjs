import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  createMcpClient,
  runOAuthFlow,
  parseToolJson,
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

function assertNoSecrets(text, secrets, label) {
  assert.equal(typeof text, 'string', `${label}: expected string body`);
  assert.ok(text.length > 0, `${label}: expected non-empty body`);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      assert.ok(!text.includes(secret), `${label}: secret leaked in response body`);
    }
  }
}

function getId(obj) {
  return obj?.id ?? obj?.compoundId ?? obj?.stackId ?? obj?.logId ?? null;
}

function recentIso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function collectSystemicItems(spread) {
  const slots = spread?.systemic?.slots ?? [];
  return slots.flatMap((slot) =>
    (slot.items ?? []).map((item) => ({
      ...item,
      slotId: slot.slotId,
      suggestedTime: slot.suggestedTime,
    })),
  );
}

function collectDermCompoundIds(spread) {
  const ids = [];
  for (const item of spread?.dermatology?.skin?.am ?? []) {
    if (item?.compoundId) ids.push(item.compoundId);
  }
  for (const night of spread?.dermatology?.skin?.pmNights ?? []) {
    for (const step of night?.steps ?? []) {
      if (step?.compoundId) ids.push(step.compoundId);
    }
  }
  for (const bucket of ['am', 'pm', 'weekly']) {
    for (const item of spread?.dermatology?.hairScalp?.[bucket] ?? []) {
      if (item?.compoundId) ids.push(item.compoundId);
    }
  }
  return ids;
}

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
    ...collectDermCompoundIds(spread),
  ]);
}

function normalizeSystemicSchedule(spread) {
  const slots = spread?.systemic?.slots ?? [];
  return slots.map((slot) => ({
    slotId: slot.slotId,
    suggestedTime: slot.suggestedTime,
    compoundIds: (slot.items ?? []).map((i) => i.compoundId).sort(),
  }));
}

function extractLogDose(log) {
  return log?.dose ?? log?.doseValue ?? log?.doseAmount ?? log?.amount;
}

function extractLogUnit(log) {
  return log?.unit ?? log?.doseUnit;
}

function stripAdherenceMeta(obj) {
  if (Array.isArray(obj)) return obj.map(stripAdherenceMeta);
  if (!obj || typeof obj !== 'object') return obj;
  const ignore = new Set(['memberId', 'member', 'memberName', 'generatedAt', 'timestamp', 'updatedAt', 'createdAt', 'asOf']);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (ignore.has(k)) continue;
    out[k] = stripAdherenceMeta(v);
  }
  return out;
}

function extractAdherenceMetrics(adherence) {
  const keyCandidates = ['7d', '7', 'days7', 'd7', 'last7Days', 'sevenDay', '30d', '30', 'days30', 'd30', 'last30Days', 'overall', 'summary'];
  const containers = [adherence?.windows, adherence?.periods, adherence].filter((c) => c && typeof c === 'object');
  for (const container of containers) {
    for (const key of keyCandidates) {
      const win = container[key];
      if (win && typeof win === 'object') {
        const taken = win.taken ?? win.takenCount ?? win.completed ?? win.loggedTaken;
        const skipped = win.skipped ?? win.skippedCount;
        const rate = win.rate ?? win.adherenceRate ?? win.pct ?? win.adherencePct ?? win.percentage;
        if (typeof taken === 'number' || typeof skipped === 'number' || typeof rate === 'number') {
          return { taken, skipped, rate, raw: win };
        }
      }
    }
  }
  return {
    taken: adherence?.taken ?? adherence?.takenCount ?? adherence?.completed ?? adherence?.loggedTaken,
    skipped: adherence?.skipped ?? adherence?.skippedCount,
    rate: adherence?.rate ?? adherence?.adherenceRate ?? adherence?.pct ?? adherence?.adherencePct ?? adherence?.percentage,
    raw: adherence,
  };
}

function extractAdvisoryGateInfo(rawBody, log) {
  const gate =
    rawBody?.gate ??
    rawBody?.doseGate ??
    rawBody?.sanityGate ??
    rawBody?.sanityCheck ??
    rawBody?.doseSanity ??
    log?.gate ??
    log?.doseGate ??
    log?.sanityGate ??
    log?.sanityCheck ??
    log?.doseSanity ??
    rawBody?.data?.gate ??
    rawBody?.data?.doseGate ??
    rawBody?.data?.sanityGate ??
    rawBody?.data?.sanityCheck ??
    null;

  const decision = String(
    gate?.decision ??
      gate?.verdict ??
      gate?.status ??
      rawBody?.decision ??
      rawBody?.verdict ??
      log?.sanityVerdict ??
      '',
  ).trim();

  const warningSources = [
    gate?.warnings,
    gate?.reasons,
    rawBody?.warnings,
    rawBody?.sanityWarnings,
    log?.warnings,
    log?.sanityWarnings,
  ];
  const warnings = warningSources.flatMap((src) => (Array.isArray(src) ? src.filter(Boolean) : []));
  if (typeof rawBody?.warning === 'string' && rawBody.warning.trim()) warnings.push(rawBody.warning);
  if (typeof log?.warning === 'string' && log.warning.trim()) warnings.push(log.warning);

  const isExplicitCleanDecision = /^(ok|pass|passed|clean|allow|allowed|none|no[\s_-]*warnings?)$/i.test(decision);
  const isDecisionFlagged =
    !isExplicitCleanDecision &&
    /^(confirm|warn|warning|needs_review|review|advisory|flagged?)$/i.test(decision);

  const isAdvisoryFlagged =
    log?.needsReview === true ||
    rawBody?.needsReview === true ||
    rawBody?.data?.needsReview === true ||
    gate?.needsReview === true ||
    rawBody?.requiresConfirmation === true ||
    gate?.requiresConfirmation === true ||
    isDecisionFlagged ||
    warnings.length > 0;

  return { gate, decision, warnings, isAdvisoryFlagged };
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

function extractSnapshotDateKey(snapshots) {
  assert.ok(Array.isArray(snapshots) && snapshots.length >= 1, 'Expected at least 1 snapshot in GET /api/v1/snapshots');
  const sorted = [...snapshots].reverse();
  const preferred =
    sorted.find((s) => typeof s === 'object' && s !== null && (s.compoundCount > 0 || s.compoundsCount > 0)) ??
    sorted[0];
  if (typeof preferred === 'string') return preferred;
  const dateKey = preferred?.dateKey ?? preferred?.id ?? preferred?.key ?? preferred?.date;
  assert.ok(typeof dateKey === 'string' && dateKey.length > 0, `Invalid snapshot dateKey: ${JSON.stringify(preferred)}`);
  return dateKey;
}

async function ensureSnapshotDateKey(adminApi) {
  let snapsRes = await adminApi.get('/api/v1/snapshots');
  assert.equal(snapsRes.status, 200);
  assertNoStore(snapsRes, 'GET /api/v1/snapshots');
  let snapshots = unwrapData(snapsRes.json, ['snapshots']);
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    const syncRes = await adminApi.get('/api/v1/sync');
    assert.equal(syncRes.status, 200);
    const state = unwrapData(syncRes.json, ['state', 'sync']);
    const rev = state?._rev ?? syncRes.json?._rev;
    const writeRes = await adminApi.post('/api/v1/sync', state, {
      headers: rev !== undefined && rev !== null ? { 'If-Match': `"${rev}"` } : {},
    });
    assert.equal(writeRes.status, 200);
    snapsRes = await adminApi.get('/api/v1/snapshots');
    assert.equal(snapsRes.status, 200);
    snapshots = unwrapData(snapsRes.json, ['snapshots']);
  }
  return extractSnapshotDateKey(snapshots);
}

function getToolSpec(tools, name) {
  assert.ok(Array.isArray(tools), 'tools/list must return an array');
  const spec = tools.find((t) => t?.name === name);
  assert.ok(spec, `Expected canonical MCP tool "${name}"`);
  return spec;
}

function buildSuggestScheduleArgs(spec, { memberId, stackId, dateKey }) {
  const props = spec.inputSchema?.properties ?? {};
  const args = {};
  if ('memberId' in props || !('member' in props)) args.memberId = memberId;
  else args.member = memberId;
  if (stackId && ('stackId' in props || Object.keys(props).length === 0)) args.stackId = stackId;
  if ('dateKey' in props || !('date' in props)) args.dateKey = dateKey;
  else args.date = dateKey;
  return args;
}

describe('Tier 3 — Cross-Feature: Household Isolation, Multi-Route Variants, What-If, Anchors & Migration', () => {
  it('1. Wife vs Husband shared (household) vs personal ownership maintains complete isolation across stacks, schedules, logs, and adherence', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const omegaRes = await admin.post(
        '/api/v1/compounds',
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
            timingNotes: 'Take with a meal containing dietary fat.',
          },
          dosages: {
            rangeText: '2000 mg daily',
            defaultAmount: 2000,
            defaultUnit: 'mg',
            route: 'Oral',
            frequencyText: 'Daily',
            maxCeiling: 4000,
          },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Triglyceride Fish Oil (EPA/DHA)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Omega-3 Fatty Acids (EPA/DHA)', amount: 2000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );
      assertStatusIn(omegaRes, [200, 201], 'Create Omega-3');
      const omegaId = getId(unwrapData(omegaRes.json, ['compound']));

      const tretRes = await admin.post('/api/v1/compounds', fixtures.makeDermCompound());
      assertStatusIn(tretRes, [200, 201], 'Create Tretinoin');
      const tretId = getId(unwrapData(tretRes.json, ['compound']));

      const testRes = await admin.post('/api/v1/compounds', fixtures.makePedCompound());
      assertStatusIn(testRes, [200, 201], 'Create Testosterone Cypionate');
      const testId = getId(unwrapData(testRes.json, ['compound']));

      assertStatusIn(
        await admin.put(`/api/v1/ownership/${omegaId}`, { scope: 'household', status: 'have', quantity: 1, unit: 'bottle' }),
        [200, 201],
        'Set shared household ownership for Omega-3',
      );
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${tretId}`, { scope: 'member:member_wife', status: 'have', quantity: 1, unit: 'tube' }),
        [200, 201],
        'Set Wife-only ownership for Tretinoin',
      );
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${testId}`, { scope: 'member:member_husband', status: 'have', quantity: 1, unit: 'vial' }),
        [200, 201],
        'Set Husband-only ownership for Testosterone Cypionate',
      );

      const ownRes = await admin.get('/api/v1/ownership');
      assert.equal(ownRes.status, 200);
      assertNoStore(ownRes, 'GET /api/v1/ownership');
      const ownerships = unwrapData(ownRes.json, ['ownership', 'ownerships']);
      assert.ok(ownerships.some((o) => o.compoundId === omegaId && o.scope === 'household' && o.status === 'have'));
      assert.ok(ownerships.some((o) => o.compoundId === tretId && o.scope === 'member:member_wife' && o.status === 'have'));
      assert.ok(ownerships.some((o) => o.compoundId === testId && o.scope === 'member:member_husband' && o.status === 'have'));

      // Cross-spouse ownership isolation via member-scoped catalog query
      const wifeHaveRes = await admin.get('/api/v1/compounds', { query: { ownership: 'have', member: 'member_wife' } });
      assert.equal(wifeHaveRes.status, 200, `GET Wife owned compounds failed: ${wifeHaveRes.text}`);
      const wifeHaveIds = new Set(unwrapData(wifeHaveRes.json, ['compounds']).map((c) => getId(c)));
      assert.ok(wifeHaveIds.has(omegaId), 'Wife ownership=have filter must include shared household Omega-3');
      assert.ok(wifeHaveIds.has(tretId), 'Wife ownership=have filter must include personal Tretinoin');
      assert.ok(!wifeHaveIds.has(testId), 'Wife ownership=have filter MUST EXCLUDE Husband personal Testosterone Cypionate');

      const husbandHaveRes = await admin.get('/api/v1/compounds', { query: { ownership: 'have', member: 'member_husband' } });
      assert.equal(husbandHaveRes.status, 200, `GET Husband owned compounds failed: ${husbandHaveRes.text}`);
      const husbandHaveIds = new Set(unwrapData(husbandHaveRes.json, ['compounds']).map((c) => getId(c)));
      assert.ok(husbandHaveIds.has(omegaId), 'Husband ownership=have filter must include shared household Omega-3');
      assert.ok(husbandHaveIds.has(testId), 'Husband ownership=have filter must include personal Testosterone Cypionate');
      assert.ok(!husbandHaveIds.has(tretId), 'Husband ownership=have filter MUST EXCLUDE Wife personal Tretinoin');

      const wifeStackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Personal Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: omegaId, doseAmount: 2000, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: tretId, doseAmount: 1, doseUnit: 'pea_size' }),
          ],
        }),
      );
      assertStatusIn(wifeStackRes, [200, 201], 'Create Wife stack');
      const wifeStackId = getId(unwrapData(wifeStackRes.json, ['stack']));

      const husbandStackRes = await admin.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Husband Personal Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: omegaId, doseAmount: 2000, doseUnit: 'mg' }),
            fixtures.makeStackItem({
              compoundId: testId,
              doseAmount: 60,
              doseUnit: 'mg',
              frequency: '2x_weekly',
              cadence: { type: 'weekly', daysOfWeek: [1, 4] },
            }),
          ],
        }),
      );
      assertStatusIn(husbandStackRes, [200, 201], 'Create Husband stack');
      const husbandStackId = getId(unwrapData(husbandStackRes.json, ['stack']));

      const wifeStacks = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']);
      const husbandStacks = unwrapData((await admin.get('/api/v1/members/member_husband/stacks')).json, ['stacks']);
      assert.ok(wifeStacks.some((s) => getId(s) === wifeStackId));
      assert.ok(!wifeStacks.some((s) => getId(s) === husbandStackId), 'Wife stacks must never leak Husband stack');
      assert.ok(husbandStacks.some((s) => getId(s) === husbandStackId));
      assert.ok(!husbandStacks.some((s) => getId(s) === wifeStackId), 'Husband stacks must never leak Wife stack');

      const wifeSpread = unwrapData(
        (await admin.post(`/api/v1/members/member_wife/stacks/${wifeStackId}/schedule`, { dateKey: '2026-10-12' })).json,
        ['schedule'],
      );
      const husbandSpread = unwrapData(
        (await admin.post(`/api/v1/members/member_husband/stacks/${husbandStackId}/schedule`, { dateKey: '2026-10-12' })).json,
        ['schedule'],
      );
      const wifeScheduledIds = collectAllScheduledCompoundIds(wifeSpread);
      const husbandScheduledIds = collectAllScheduledCompoundIds(husbandSpread);

      assert.ok(wifeScheduledIds.has(omegaId), 'Wife schedule must include shared Omega-3');
      assert.ok(wifeScheduledIds.has(tretId), 'Wife schedule must include personal Tretinoin');
      assert.ok(!wifeScheduledIds.has(testId), 'Wife schedule must NEVER include Husband Testosterone Cypionate');
      assert.equal(wifeSpread.stockSummary?.have, 2, 'Wife stockSummary must count shared household + personal Wife items');
      assert.ok(husbandScheduledIds.has(omegaId), 'Husband schedule must include shared Omega-3');
      assert.ok(husbandScheduledIds.has(testId), 'Husband schedule must include personal Testosterone Cypionate');
      assert.ok(!husbandScheduledIds.has(tretId), 'Husband schedule must NEVER include Wife Tretinoin');
      assert.equal(husbandSpread.stockSummary?.have, 2, 'Husband stockSummary must count shared household + personal Husband items');

      // Cross-spouse ownership isolation via non-mutating What-If: Husband's personal Testosterone is NOT "have" for Wife
      const wifeWhatIfTestRes = await admin.post(`/api/v1/members/member_wife/stacks/${wifeStackId}/schedule`, {
        dateKey: '2026-10-12',
        whatIfCompounds: [{ compoundId: testId, doseAmount: 60, doseUnit: 'mg', frequency: '2x_weekly' }],
      });
      assert.equal(wifeWhatIfTestRes.status, 200, `Wife What-If cross-spouse ownership probe failed: ${wifeWhatIfTestRes.text}`);
      const wifeWhatIfTestSpread = unwrapData(wifeWhatIfTestRes.json, ['schedule']);
      const wifeMissingIds = new Set((wifeWhatIfTestSpread.stockSummary?.missing ?? []).map((m) => m.compoundId ?? m.id));
      assert.ok(
        wifeMissingIds.has(testId),
        `Husband's personal Testosterone (${testId}) must appear in Wife's stockSummary.missing, got ${JSON.stringify(wifeWhatIfTestSpread.stockSummary)}`,
      );

      const wifeLog1At = recentIso(120);
      assertStatusIn(
        await admin.post('/api/v1/members/member_wife/logs', {
          compoundId: omegaId,
          stackId: wifeStackId,
          dose: 2000,
          doseValue: 2000,
          doseAmount: 2000,
          unit: 'mg',
          doseUnit: 'mg',
          skipped: false,
          takenAt: wifeLog1At,
          datetime: wifeLog1At,
        }),
        [200, 201],
        'Wife log Omega-3 taken',
      );
      const wifeLog2At = recentIso(60);
      assertStatusIn(
        await admin.post('/api/v1/members/member_wife/logs', {
          compoundId: tretId,
          stackId: wifeStackId,
          skipped: true,
          skipReason: 'mild skin dryness',
          takenAt: wifeLog2At,
          datetime: wifeLog2At,
        }),
        [200, 201],
        'Wife log Tretinoin skipped',
      );
      const husbandLog1At = recentIso(90);
      assertStatusIn(
        await admin.post('/api/v1/members/member_husband/logs', {
          compoundId: testId,
          stackId: husbandStackId,
          dose: 60,
          doseValue: 60,
          doseAmount: 60,
          unit: 'mg',
          doseUnit: 'mg',
          site: 'glute_right',
          skipped: false,
          takenAt: husbandLog1At,
          datetime: husbandLog1At,
        }),
        [200, 201],
        'Husband log Testosterone taken',
      );

      const wifeLogs = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);
      const husbandLogs = unwrapData((await admin.get('/api/v1/members/member_husband/logs')).json, ['logs']);
      assert.equal(wifeLogs.length, 2, 'Wife logs must contain exactly her 2 entries');
      assert.ok(wifeLogs.every((l) => l.compoundId !== testId), 'Wife logs must never leak Husband Testosterone log');
      assert.equal(husbandLogs.length, 1, 'Husband logs must contain exactly his 1 entry');
      assert.equal(husbandLogs[0].compoundId, testId, 'Husband logs must never leak Wife entries');

      const wifeAdhRes = await admin.get('/api/v1/members/member_wife/adherence');
      const husbandAdhRes = await admin.get('/api/v1/members/member_husband/adherence');
      assert.equal(wifeAdhRes.status, 200);
      assert.equal(husbandAdhRes.status, 200);
      assertNoStore(wifeAdhRes, 'GET Wife adherence');
      assertNoStore(husbandAdhRes, 'GET Husband adherence');
      const wifeAdh = unwrapData(wifeAdhRes.json, ['adherence']);
      const husbandAdh = unwrapData(husbandAdhRes.json, ['adherence']);
      assert.ok(wifeAdh && typeof wifeAdh === 'object', 'Wife adherence must return structured stats');
      assert.ok(husbandAdh && typeof husbandAdh === 'object', 'Husband adherence must return structured stats');

      const wifeMetrics = extractAdherenceMetrics(wifeAdh);
      const husbandMetrics = extractAdherenceMetrics(husbandAdh);
      assert.equal(wifeMetrics.taken, 1, `Wife 7d/overall taken must be 1, got ${JSON.stringify(wifeAdh)}`);
      assert.equal(wifeMetrics.skipped, 1, `Wife 7d/overall skipped must be 1, got ${JSON.stringify(wifeAdh)}`);
      assert.equal(husbandMetrics.taken, 1, `Husband 7d/overall taken must be 1, got ${JSON.stringify(husbandAdh)}`);
      assert.equal(husbandMetrics.skipped, 0, `Husband 7d/overall skipped must be 0, got ${JSON.stringify(husbandAdh)}`);
      if (typeof wifeMetrics.rate === 'number' && typeof husbandMetrics.rate === 'number') {
        assert.ok(
          husbandMetrics.rate > wifeMetrics.rate,
          `Husband adherence rate (${husbandMetrics.rate}) must exceed Wife rate (${wifeMetrics.rate})`,
        );
      }
      assert.notDeepEqual(
        stripAdherenceMeta(wifeAdh),
        stripAdherenceMeta(husbandAdh),
        'Metadata-stripped Wife and Husband adherence metrics must strictly differ',
      );
    } finally {
      await server.stop();
    }
  });

  it('2. protocol-os-export/v1 import -> cross-section stack -> spread -> dose logging (fractional IU, <=0 hard-block & >=5x advisory gate) -> snapshot restore', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const importPayload = fixtures.makeProtocolOsExport();
      const importRes = await admin.post('/api/v1/import/protocol-os', importPayload);
      assertStatusIn(importRes, [200, 201], 'POST /api/v1/import/protocol-os');

      const importedCompounds = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(importedCompounds.length >= 2, 'protocol-os import must create peptide & blend compounds');
      const bpc = importedCompounds.find((c) => /bpc/i.test(c.name) && !/wolverine|blend/i.test(c.name));
      const blend = importedCompounds.find((c) => /wolverine|bpc.*tb|blend/i.test(c.name));
      assert.ok(bpc, 'Imported catalog must include BPC-157');
      assert.ok(blend, 'Imported catalog must include Wolverine BPC+TB blend');
      const bpcId = getId(bpc);

      const magRes = await admin.post('/api/v1/compounds', fixtures.makeSupplementCompound());
      assertStatusIn(magRes, [200, 201], 'Create Magnesium Glycinate');
      const magId = getId(unwrapData(magRes.json, ['compound']));
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${magId}`, { scope: 'household', status: 'have' }),
        [200, 201],
        'Set Magnesium ownership',
      );

      const hcgRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'HCG',
          canonicalMolecule: 'hcg',
          aliases: ['Human Chorionic Gonadotropin'],
          subsection: 'Gonadotropins',
          tags: ['peptide', 'gonadotropin', 'hcg', 'subq'],
          dosages: {
            rangeText: '12.5-500 IU SubQ',
            defaultAmount: 250,
            defaultUnit: 'IU',
            route: 'SubQ',
            frequencyText: '2x/week',
            maxCeiling: 2000,
          },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            form: 'lyophilized',
            vialMg: null,
            vialIU: 5000,
            diluentMl: 5,
            solvent: 'BAC',
            isBlend: false,
            blendComponents: [],
          },
        }),
      );
      assertStatusIn(hcgRes, [200, 201], 'Create HCG for fractional IU dose logging');
      const hcgId = getId(unwrapData(hcgRes.json, ['compound']));

      const stackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Migrated Recovery + Sleep Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: bpcId, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: magId, doseAmount: 200, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: hcgId, doseAmount: 12.5, doseUnit: 'IU' }),
          ],
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'Create cross-section stack');
      const stackId = getId(unwrapData(stackRes.json, ['stack']));

      const schedRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(schedRes.status, 200);
      const spread = unwrapData(schedRes.json, ['schedule']);
      const scheduledIds = collectAllScheduledCompoundIds(spread);
      assert.ok(scheduledIds.has(bpcId), 'Imported BPC-157 must appear in spread schedule');
      assert.ok(scheduledIds.has(magId), 'Magnesium Glycinate must appear in spread schedule');
      assert.ok(scheduledIds.has(hcgId), 'HCG must appear in spread schedule');

      const hcgAt = recentIso(150);
      const fractionalIuRes = await admin.post('/api/v1/members/member_wife/logs', {
        compoundId: hcgId,
        stackId,
        dose: 12.5,
        doseValue: 12.5,
        doseAmount: 12.5,
        unit: 'IU',
        doseUnit: 'IU',
        site: 'abdomen_left',
        skipped: false,
        takenAt: hcgAt,
        datetime: hcgAt,
      });
      assertStatusIn(fractionalIuRes, [200, 201], 'Fractional 12.5 IU dose log');
      const wifeLogsAfterIu = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);
      const hcgLog = wifeLogsAfterIu.find((l) => l.compoundId === hcgId);
      assert.ok(hcgLog, 'Fractional IU log must persist in GET /logs');
      assert.equal(
        extractLogDose(hcgLog),
        12.5,
        `Fractional 12.5 IU must be preserved without integer rounding, got ${JSON.stringify(hcgLog)}`,
      );
      assert.equal(extractLogUnit(hcgLog), 'IU', `IU unit must be preserved without conversion, got ${JSON.stringify(hcgLog)}`);

      const normalAt = recentIso(120);
      const normalLogRes = await admin.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcId,
        stackId,
        dose: 250,
        doseValue: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        site: 'abdomen_left',
        skipped: false,
        takenAt: normalAt,
        datetime: normalAt,
      });
      assertStatusIn(normalLogRes, [200, 201], 'Normal baseline dose log');

      const zeroAt = recentIso(90);
      const zeroLogRes = await admin.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcId,
        stackId,
        dose: 0,
        doseValue: 0,
        doseAmount: 0,
        unit: 'mcg',
        doseUnit: 'mcg',
        skipped: false,
        takenAt: zeroAt,
        datetime: zeroAt,
      });
      assertStatusIn(zeroLogRes, [400, 422], 'Dose <= 0 must be hard-blocked');

      const negAt = recentIso(60);
      const negLogRes = await admin.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcId,
        stackId,
        dose: -100,
        doseValue: -100,
        doseAmount: -100,
        unit: 'mcg',
        doseUnit: 'mcg',
        skipped: false,
        takenAt: negAt,
        datetime: negAt,
      });
      assertStatusIn(negLogRes, [400, 422], 'Negative dose must be hard-blocked');

      const spikeAt = recentIso(30);
      const spikePayload = {
        compoundId: bpcId,
        stackId,
        dose: 1500,
        doseValue: 1500,
        doseAmount: 1500,
        unit: 'mcg',
        doseUnit: 'mcg',
        site: 'abdomen_right',
        skipped: false,
        takenAt: spikeAt,
        datetime: spikeAt,
      };
      const spikeLogRes = await admin.post('/api/v1/members/member_wife/logs', spikePayload);
      assertStatusIn(spikeLogRes, [200, 201, 409, 422], 'Advisory >=5x jump / ceiling breach response');
      const spikeBody = spikeLogRes.json ?? {};
      const spikeLog = unwrapData(spikeBody, ['log', 'entry', 'record']);
      const spikeGate = extractAdvisoryGateInfo(spikeBody, spikeLog);
      assert.equal(
        spikeGate.isAdvisoryFlagged,
        true,
        `1500 mcg dose (6x prior 250 mcg & above ceiling) must trigger structured advisory Dose-Sanity Gate (not needsReview:false): ${JSON.stringify(spikeBody)}`,
      );

      // Prove >=5x jump is ADVISORY (not a hard-block): either persisted immediately or confirmable
      if (spikeLogRes.status === 409 || spikeLogRes.status === 422) {
        const confirmedSpikeRes = await admin.post('/api/v1/members/member_wife/logs', {
          ...spikePayload,
          confirmed: true,
          confirm: true,
          force: true,
        });
        assertStatusIn(
          confirmedSpikeRes,
          [200, 201],
          'Advisory >=5x jump must allow confirmation (MUST NOT be hard-blocked like <=0)',
        );
      }
      const logsAfterSpike = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);
      assert.ok(
        logsAfterSpike.some((l) => l.compoundId === bpcId && extractLogDose(l) === 1500),
        `Advisory 1500 mcg spike log must be persisted in GET /logs after advisory flow, got ${JSON.stringify(logsAfterSpike)}`,
      );

      const dateKey = await ensureSnapshotDateKey(admin);

      assertStatusIn(await admin.del(`/api/v1/compounds/${bpcId}`), [200, 204], 'Delete BPC-157');
      assertStatusIn(
        await admin.post(
          '/api/v1/compounds',
          fixtures.makePeptideCompound({
            name: 'Corrupted Post-Snapshot Peptide',
            canonicalMolecule: 'corrupted-post-snapshot',
            aliases: [],
          }),
        ),
        [200, 201],
        'Create rogue compound after snapshot',
      );

      const afterDestroy = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(!afterDestroy.some((c) => getId(c) === bpcId), 'BPC-157 must be deleted prior to restore');
      assert.ok(afterDestroy.some((c) => c.name === 'Corrupted Post-Snapshot Peptide'));

      const restoreRes = await admin.post(`/api/v1/snapshots/${encodeURIComponent(dateKey)}/restore`, {});
      assert.equal(restoreRes.status, 200, `Snapshot restore failed: ${restoreRes.text}`);

      const afterRestore = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(
        afterRestore.some((c) => getId(c) === bpcId || (/bpc/i.test(c.name) && !/wolverine|blend/i.test(c.name))),
        'Snapshot restore must recover migrated BPC-157',
      );
      assert.ok(
        !afterRestore.some((c) => c.name === 'Corrupted Post-Snapshot Peptide'),
        'Snapshot restore must remove post-snapshot rogue compound',
      );
    } finally {
      await server.stop();
    }
  });

  it('3. Multi-route same-molecule variants coexist (GHK-Cu SubQ + Topical; Finasteride Oral + Topical), link reciprocally, and emit cumulative exposure warning', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const ghkSubqRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'GHK-Cu',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Tripeptide-1'],
          sectionId: 'peptides',
          tags: ['peptide', 'copper_peptide', 'subq'],
          dosages: {
            rangeText: '1-2 mg daily SubQ',
            defaultAmount: 1.5,
            defaultUnit: 'mg',
            route: 'SubQ',
            frequencyText: 'Daily',
            maxCeiling: 5,
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );
      assertStatusIn(ghkSubqRes, [200, 201], 'Create GHK-Cu SubQ');
      const ghkSubqId = getId(unwrapData(ghkSubqRes.json, ['compound']));

      const ghkSerumRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'GHK-Cu 2% Serum',
          canonicalMolecule: 'ghk-cu',
          aliases: ['Copper Peptide 2% Serum'],
          sectionId: 'dermatology',
          subsection: 'Peptide Serums',
          tags: ['dermatology', 'copper_peptide', 'skin_cycling_active'],
          dosages: {
            rangeText: '3-4 drops PM',
            defaultAmount: 3,
            defaultUnit: 'drops',
            route: 'Topical',
            frequencyText: 'Alternating PM',
            maxCeiling: 6,
          },
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
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'vitamin_c',
              severity: 'avoid_same_slot',
              separationHours: 12,
              mechanism: 'Acidic L-ascorbic acid destabilizes copper peptide complex',
              recommendation: 'Use Vitamin C in AM and GHK-Cu in PM',
            },
          ],
          synergies: [],
        }),
      );
      assertStatusIn(ghkSerumRes, [200, 201], 'Create GHK-Cu Topical Serum (must coexist, NOT 409)');
      const ghkSerumId = getId(unwrapData(ghkSerumRes.json, ['compound']));

      const finOralRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          name: 'Finasteride',
          canonicalMolecule: 'finasteride',
          aliases: ['Propecia'],
          sectionId: 'peds',
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
          dosages: {
            rangeText: '1 mg daily oral',
            defaultAmount: 1,
            defaultUnit: 'mg',
            route: 'Oral',
            frequencyText: 'Daily',
            maxCeiling: 5,
          },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'pregnancy',
              severity: 'hard_stop',
              mechanism: '5-alpha-reductase inhibition causes severe teratogenic risk in male fetuses.',
              recommendation: 'Strictly contraindicated during pregnancy or trying to conceive.',
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
      assertStatusIn(finOralRes, [200, 201], 'Create Oral Finasteride');
      const finOralId = getId(unwrapData(finOralRes.json, ['compound']));

      const finTopicalRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: 'Finasteride 0.1% Topical Solution',
          canonicalMolecule: 'finasteride',
          aliases: ['Topical Finasteride'],
          sectionId: 'dermatology',
          subsection: 'Hair & Scalp Treatments',
          tags: ['dermatology', 'hair_growth', '5ar_inhibitor', 'finasteride', 'teratogen'],
          dosages: {
            rangeText: '1 mL scalp daily',
            defaultAmount: 1,
            defaultUnit: 'mL',
            route: 'Topical',
            frequencyText: 'Daily',
            maxCeiling: 2,
          },
          doNotPairWith: [
            {
              targetType: 'class',
              targetRef: 'pregnancy',
              severity: 'hard_stop',
              mechanism: 'Topical 5-alpha-reductase inhibitors carry systemic teratogenic precaution.',
              recommendation: 'Avoid handling or use during pregnancy or trying to conceive.',
            },
          ],
          synergies: [],
          sectionData: {
            targetArea: ['scalp_hair'],
            vehicleType: 'scalp_tonic',
            actives: [{ name: 'Finasteride', concentrationPct: 0.1, optimalPh: 5.5 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'pm_only',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'hair_growth',
            pregnancySafety: 'avoid',
          },
        }),
      );
      assertStatusIn(finTopicalRes, [200, 201], 'Create Topical Finasteride (must coexist, NOT 409)');
      const finTopicalId = getId(unwrapData(finTopicalRes.json, ['compound']));

      const ghkSubq = unwrapData((await admin.get(`/api/v1/compounds/${ghkSubqId}`)).json, ['compound']);
      const ghkSerum = unwrapData((await admin.get(`/api/v1/compounds/${ghkSerumId}`)).json, ['compound']);
      const finOral = unwrapData((await admin.get(`/api/v1/compounds/${finOralId}`)).json, ['compound']);
      const finTopical = unwrapData((await admin.get(`/api/v1/compounds/${finTopicalId}`)).json, ['compound']);

      assert.equal(ghkSubq.canonicalMolecule, 'ghk-cu');
      assert.equal(ghkSerum.canonicalMolecule, 'ghk-cu');
      assert.ok(
        Array.isArray(ghkSubq.relatedCompoundIds) && ghkSubq.relatedCompoundIds.includes(ghkSerumId),
        `GHK-Cu SubQ must reciprocally link to GHK-Cu Serum (${ghkSerumId}), got ${JSON.stringify(ghkSubq.relatedCompoundIds)}`,
      );
      assert.ok(
        Array.isArray(ghkSerum.relatedCompoundIds) && ghkSerum.relatedCompoundIds.includes(ghkSubqId),
        `GHK-Cu Serum must reciprocally link to GHK-Cu SubQ (${ghkSubqId}), got ${JSON.stringify(ghkSerum.relatedCompoundIds)}`,
      );
      assert.ok(
        Array.isArray(finOral.relatedCompoundIds) && finOral.relatedCompoundIds.includes(finTopicalId),
        'Oral Finasteride must reciprocally link to Topical Finasteride',
      );
      assert.ok(
        Array.isArray(finTopical.relatedCompoundIds) && finTopical.relatedCompoundIds.includes(finOralId),
        'Topical Finasteride must reciprocally link to Oral Finasteride',
      );

      const stackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Multi-Route GHK-Cu Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: ghkSubqId, doseAmount: 1.5, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: ghkSerumId, doseAmount: 3, doseUnit: 'drops' }),
          ],
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'Create multi-route GHK-Cu stack');
      const stackId = getId(unwrapData(stackRes.json, ['stack']));

      const interRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/interactions`, {});
      assert.equal(interRes.status, 200);
      const inter = unwrapData(interRes.json, ['interactions']);
      const interAlerts = [
        ...(inter.cautions ?? []),
        ...(inter.safetyAlerts ?? []),
        ...(inter.redundancies ?? []),
        ...(inter.hardStops ?? []),
      ];
      assertMultiRouteAlert(
        interAlerts,
        /ghk.?cu|copper.?tripeptide/i,
        ghkSubqId,
        ghkSerumId,
        'POST /interactions multi-route GHK-Cu warning',
      );

      const schedRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(schedRes.status, 200);
      const spread = unwrapData(schedRes.json, ['schedule']);
      const spreadAlerts = [
        ...(spread.interactions?.cautions ?? []),
        ...(spread.interactions?.safetyAlerts ?? []),
        ...(spread.interactions?.redundancies ?? []),
        ...(spread.interactions?.hardStops ?? []),
      ];
      assertMultiRouteAlert(
        spreadAlerts,
        /ghk.?cu|copper.?tripeptide/i,
        ghkSubqId,
        ghkSerumId,
        'POST /schedule.interactions multi-route GHK-Cu warning',
      );
      const scheduledIds = collectAllScheduledCompoundIds(spread);
      assert.ok(scheduledIds.has(ghkSubqId), 'GHK-Cu SubQ must not be silently dropped');
      assert.ok(scheduledIds.has(ghkSerumId), 'GHK-Cu 2% Serum must not be silently dropped');
    } finally {
      await server.stop();
    }
  });

  it('4. Non-mutating What-If wishlist simulation previews slots, Zinc<->Copper separation, and missing shopping list with zero stack/log mutation', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const zincRes = await admin.post(
        '/api/v1/compounds',
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
            timingNotes: 'Take with a meal to minimize nausea.',
          },
          dosages: { rangeText: '30 mg daily', defaultAmount: 30, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 40 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'copper',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Zinc induces metallothionein and blocks copper uptake.',
              recommendation: 'Separate zinc and copper by at least 2 hours.',
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
      assertStatusIn(zincRes, [200, 201], 'Create Zinc Picolinate');
      const zincId = getId(unwrapData(zincRes.json, ['compound']));

      const vitDRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3'],
          timingRules: {
            preferredSlots: ['morning_am'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with breakfast fat.',
          },
          dosages: { rangeText: '2000 IU daily', defaultAmount: 2000, defaultUnit: 'IU', route: 'Oral', frequencyText: 'Daily', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [],
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
      assertStatusIn(vitDRes, [200, 201], 'Create Vitamin D3');
      const vitDId = getId(unwrapData(vitDRes.json, ['compound']));

      const copperRes = await admin.post(
        '/api/v1/compounds',
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
            timingNotes: 'Separate from zinc.',
          },
          dosages: { rangeText: '2 mg daily', defaultAmount: 2, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 10 },
          doNotPairWith: [
            {
              targetType: 'nutrient',
              targetRef: 'zinc',
              severity: 'avoid_same_slot',
              separationHours: 2,
              mechanism: 'Competitive intestinal absorption with zinc.',
              recommendation: 'Separate copper from zinc by >=2 hours.',
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
      assertStatusIn(copperRes, [200, 201], 'Create Copper Bisglycinate');
      const copperId = getId(unwrapData(copperRes.json, ['compound']));

      const tesaRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Tesamorelin',
          canonicalMolecule: 'tesamorelin',
          aliases: ['Egrifta'],
          timingRules: {
            preferredSlots: ['waking_fasted'],
            avoidSlots: ['morning_am', 'midday_lunch'],
            foodState: 'fasted',
            fastingWindowHours: 1,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Administer fasted upon waking.',
          },
          dosages: { rangeText: '1 mg daily SubQ', defaultAmount: 1, defaultUnit: 'mg', route: 'SubQ', frequencyText: 'Daily', maxCeiling: 2 },
          doNotPairWith: [],
          synergies: [],
        }),
      );
      assertStatusIn(tesaRes, [200, 201], 'Create Tesamorelin');
      const tesaId = getId(unwrapData(tesaRes.json, ['compound']));

      assertStatusIn(await admin.put(`/api/v1/ownership/${zincId}`, { scope: 'household', status: 'have' }), [200, 201], 'Set Zinc ownership');
      assertStatusIn(await admin.put(`/api/v1/ownership/${vitDId}`, { scope: 'household', status: 'have' }), [200, 201], 'Set Vit D3 ownership');
      assertStatusIn(await admin.put(`/api/v1/ownership/${copperId}`, { scope: 'member:member_wife', status: 'dont_have' }), [200, 201], 'Set Copper ownership');
      assertStatusIn(await admin.put(`/api/v1/ownership/${tesaId}`, { scope: 'member:member_wife', status: 'wishlist' }), [200, 201], 'Set Tesamorelin ownership');

      const stackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Active Have Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: zincId, doseAmount: 30, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: vitDId, doseAmount: 2000, doseUnit: 'IU' }),
          ],
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'Create Wife active stack');
      const stackId = getId(unwrapData(stackRes.json, ['stack']));

      const vitDLogAt = recentIso(60);
      assertStatusIn(
        await admin.post('/api/v1/members/member_wife/logs', {
          compoundId: vitDId,
          stackId,
          dose: 2000,
          doseValue: 2000,
          doseAmount: 2000,
          unit: 'IU',
          doseUnit: 'IU',
          skipped: false,
          takenAt: vitDLogAt,
          datetime: vitDLogAt,
        }),
        [200, 201],
        'Seed baseline Vitamin D3 log',
      );

      const stacksBefore = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']);
      const logsBefore = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);

      const whatIfRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
        whatIfCompounds: [
          { compoundId: copperId, doseAmount: 2, doseUnit: 'mg', frequency: 'daily' },
          { compoundId: tesaId, doseAmount: 1, doseUnit: 'mg', frequency: 'daily' },
        ],
      });
      assert.equal(whatIfRes.status, 200, `What-If schedule failed: ${whatIfRes.text}`);
      const spread = unwrapData(whatIfRes.json, ['schedule']);
      const items = collectSystemicItems(spread);

      const zincPlaced = items.find((i) => i.compoundId === zincId);
      const copperPlaced = items.find((i) => i.compoundId === copperId);
      const tesaPlaced = items.find((i) => i.compoundId === tesaId);
      assert.ok(zincPlaced, 'Zinc must be placed');
      assert.ok(copperPlaced, 'What-If Copper must appear in preview schedule');
      assert.ok(tesaPlaced, 'What-If Tesamorelin must appear in preview schedule');
      assert.equal(copperPlaced.isWhatIf, true, 'Previewed Copper must be flagged isWhatIf: true');
      assert.equal(tesaPlaced.isWhatIf, true, 'Previewed Tesamorelin must be flagged isWhatIf: true');
      assert.notEqual(
        zincPlaced.slotId,
        copperPlaced.slotId,
        `Zinc (${zincPlaced.slotId}) and What-If Copper (${copperPlaced.slotId}) must be separated into distinct slots`,
      );

      const missingIds = new Set((spread.stockSummary?.missing ?? []).map((m) => m.compoundId ?? m.id));
      assert.ok(missingIds.has(copperId), 'stockSummary.missing must include dont_have Copper');
      assert.ok(missingIds.has(tesaId), 'stockSummary.missing must include wishlist Tesamorelin');
      assert.equal(spread.stockSummary?.have, 2);
      assert.equal(spread.stockSummary?.total, 4);

      const stacksAfter = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']);
      const logsAfter = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);
      assert.deepEqual(stacksAfter, stacksBefore, 'What-If simulation MUST NOT mutate saved stacks');
      assert.deepEqual(logsAfter, logsBefore, 'What-If simulation MUST NOT mutate member logs');
    } finally {
      await server.stop();
    }
  });

  it('5. Editing routineAnchors deterministically shifts suggestedTime and swaps workout/rest-day placement identically across REST and MCP', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const tesaRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Tesamorelin',
          canonicalMolecule: 'tesamorelin',
          aliases: ['Egrifta'],
          doNotPairWith: [],
          synergies: [],
          timingRules: {
            preferredSlots: ['waking_fasted'],
            avoidSlots: [],
            foodState: 'fasted',
            fastingWindowHours: 1,
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Waking fasted.',
          },
        }),
      );
      assertStatusIn(tesaRes, [200, 201], 'Create Test 5 Tesamorelin');
      const tesaId = getId(unwrapData(tesaRes.json, ['compound']));

      const citrullineRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'L-Citrulline Malate',
          canonicalMolecule: 'l-citrulline',
          aliases: ['Citrulline'],
          tags: ['supplement', 'pre_workout', 'nitric_oxide'],
          timingRules: {
            preferredSlots: ['pre_workout'],
            avoidSlots: ['bedtime_fasted'],
            foodState: 'any',
            workoutRelation: 'training_days_only',
            circadianEffect: 'neutral',
            timingNotes: 'Training days only, 30 min pre-workout.',
          },
          dosages: { rangeText: '6 g pre-workout', defaultAmount: 6, defaultUnit: 'g', route: 'Oral', frequencyText: 'Training days', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'L-Citrulline DL-Malate 2:1',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'L-Citrulline Malate', amount: 6000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );
      assertStatusIn(citrullineRes, [200, 201], 'Create Test 5 L-Citrulline Malate');
      const citrullineId = getId(unwrapData(citrullineRes.json, ['compound']));

      const omegaRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Omega-3 Fish Oil',
          canonicalMolecule: 'omega-3',
          aliases: ['EPA/DHA', 'Fish Oil'],
          tags: ['supplement', 'omega3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['evening_dinner'],
            avoidSlots: [],
            foodState: 'with_meal',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with dinner.',
          },
          dosages: { rangeText: '2000 mg daily', defaultAmount: 2000, defaultUnit: 'mg', route: 'Oral', frequencyText: 'Daily', maxCeiling: 4000 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Triglyceride Fish Oil (EPA/DHA)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Omega-3 Fatty Acids (EPA/DHA)', amount: 2000, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );
      assertStatusIn(omegaRes, [200, 201], 'Create Test 5 Omega-3 Fish Oil');
      const omegaId = getId(unwrapData(omegaRes.json, ['compound']));

      const magRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          timingRules: {
            preferredSlots: ['bedtime_fasted'],
            avoidSlots: ['pre_workout'],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'sedating',
            timingNotes: 'Take at bedtime.',
          },
        }),
      );
      assertStatusIn(magRes, [200, 201], 'Create Test 5 Magnesium Glycinate');
      const magId = getId(unwrapData(magRes.json, ['compound']));

      assert.equal(
        new Set([tesaId, citrullineId, omegaId, magId].filter(Boolean)).size,
        4,
        `All 4 Test 5 compounds must be distinct non-empty IDs, got ${JSON.stringify({ tesaId, citrullineId, omegaId, magId })}`,
      );

      const anchorsA = {
        wake: '07:00',
        breakfast: '08:00',
        workout: '06:30',
        workoutDays: [1, 3, 5],
        lunch: '13:00',
        dinner: '19:00',
        bed: '22:30',
        tz: 'UTC',
      };
      assert.equal(
        (await admin.patch('/api/v1/members/member_husband', { routineAnchors: anchorsA })).status,
        200,
      );

      const citrullineStackItem = fixtures.makeStackItem({
        compoundId: citrullineId,
        doseAmount: 6,
        doseUnit: 'g',
        frequency: 'training_days',
        cadence: { type: 'training_days' },
      });
      delete citrullineStackItem.cadence.daysOfWeek;

      const stackRes = await admin.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Husband Anchor Test Stack',
          memberId: 'member_husband',
          items: [
            fixtures.makeStackItem({ compoundId: tesaId, doseAmount: 1, doseUnit: 'mg' }),
            citrullineStackItem,
            fixtures.makeStackItem({ compoundId: omegaId, doseAmount: 2000, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: magId, doseAmount: 200, doseUnit: 'mg' }),
          ],
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'Create Husband Anchor Test Stack');
      const stackId = getId(unwrapData(stackRes.json, ['stack']));
      assert.ok(stackId, 'Husband Anchor Test Stack must return valid stackId');

      const flow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'read',
        memberId: 'member_husband',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(flow.ok, true);

      const mcp = createMcpClient({ baseUrl: server.baseUrl, token: flow.accessToken });
      await mcp.initialize({ name: 'Claude', version: '1.0.0' });
      await mcp.notifyInitialized();
      const tools = (await mcp.listTools()).result?.tools;
      const schedToolSpec = getToolSpec(tools, 'suggest_stack_schedule');

      const fetchPair = async (dateKey) => {
        const restRes = await admin.post(`/api/v1/members/member_husband/stacks/${stackId}/schedule`, { dateKey });
        assert.equal(restRes.status, 200, `REST schedule failed for ${dateKey}: ${restRes.text}`);
        const restSpread = unwrapData(restRes.json, ['schedule']);

        const mcpRes = await mcp.callTool(
          'suggest_stack_schedule',
          buildSuggestScheduleArgs(schedToolSpec, {
            memberId: 'member_husband',
            stackId,
            dateKey,
          }),
        );
        assert.equal(mcpRes.status, 200, `MCP suggest_stack_schedule failed for ${dateKey}: ${mcpRes.text}`);
        assert.equal(mcpRes.error, null);
        assert.notEqual(mcpRes.result?.isError, true);
        const mcpSpread = unwrapData(parseToolJson(mcpRes), ['schedule']);

        const normRest = normalizeSystemicSchedule(restSpread);
        const normMcp = normalizeSystemicSchedule(mcpSpread);
        assert.deepEqual(normMcp, normRest, `REST and MCP schedules MUST match identically for ${dateKey}`);
        return restSpread;
      };

      const monA = await fetchPair('2026-10-12'); // Monday (weekday 1) — workout day in Schedule A
      const tueA = await fetchPair('2026-10-13'); // Tuesday (weekday 2) — rest day in Schedule A

      const slotTime = (spread, slotId) => spread.systemic.slots.find((s) => s.slotId === slotId)?.suggestedTime;
      const slotHas = (spread, slotId, compoundId) =>
        (spread.systemic.slots.find((s) => s.slotId === slotId)?.items ?? []).some((i) => i.compoundId === compoundId);

      assert.equal(slotHas(monA, 'pre_workout', citrullineId), true, 'Monday (workout day in A) must place L-Citrulline in pre_workout');
      assert.equal(slotHas(tueA, 'pre_workout', citrullineId), false, 'Tuesday (rest day in A) must NOT place L-Citrulline in pre_workout');
      assert.ok(
        slotHas(monA, 'bedtime_fasted', magId) || slotHas(monA, 'evening_dinner', magId),
        'Magnesium Glycinate must be scheduled in bedtime_fasted or evening_dinner',
      );

      const wakeTimeA = slotTime(monA, 'waking_fasted');
      const preWoTimeA = slotTime(monA, 'pre_workout');
      const dinnerTimeA = slotTime(monA, 'evening_dinner');
      const bedTimeA = slotTime(monA, 'bedtime_fasted');
      for (const [label, val] of [
        ['waking_fasted', wakeTimeA],
        ['pre_workout', preWoTimeA],
        ['evening_dinner', dinnerTimeA],
        ['bedtime_fasted', bedTimeA],
      ]) {
        assert.match(String(val || ''), /^\d{2}:\d{2}$/, `${label} must carry HH:MM suggestedTime, got "${val}"`);
      }

      const anchorsB = {
        wake: '05:30',
        breakfast: '07:00',
        workout: '17:30',
        workoutDays: [2, 4, 6],
        lunch: '12:00',
        dinner: '20:30',
        bed: '23:30',
        tz: 'UTC',
      };
      assert.equal(
        (await admin.patch('/api/v1/members/member_husband', { routineAnchors: anchorsB })).status,
        200,
      );

      const monB = await fetchPair('2026-10-12'); // Monday — NOW rest day in Schedule B
      const tueB = await fetchPair('2026-10-13'); // Tuesday — NOW workout day in Schedule B

      assert.notEqual(slotTime(tueB, 'waking_fasted'), wakeTimeA, 'waking_fasted suggestedTime must shift after wake anchor edit');
      assert.notEqual(slotTime(tueB, 'pre_workout'), preWoTimeA, 'pre_workout suggestedTime must shift after workout anchor edit');
      assert.notEqual(slotTime(tueB, 'evening_dinner'), dinnerTimeA, 'evening_dinner suggestedTime must shift after dinner anchor edit');
      assert.notEqual(slotTime(tueB, 'bedtime_fasted'), bedTimeA, 'bedtime_fasted suggestedTime must shift after bed anchor edit');

      assert.equal(slotHas(monB, 'pre_workout', citrullineId), false, 'Monday (now rest day in B) must NOT place L-Citrulline in pre_workout');
      assert.equal(slotHas(tueB, 'pre_workout', citrullineId), true, 'Tuesday (now workout day in B) must place L-Citrulline in pre_workout');
    } finally {
      await server.stop();
    }
  });

  it('6. Full Hub JSON export on Server A -> import on brand-new isolated Server B reproduces exact schema, ownership, stacks, and deterministic spread parity', async () => {
    const serverA = await startE2EServer({ ignoreExternalEnv: true });
    let serverB = null;
    try {
      const apiA = createApiClient({ baseUrl: serverA.baseUrl, token: serverA.adminToken });

      const coaField = fixtures.makeCustomSectionField({
        key: 'coa_url',
        label: 'COA Verification URL',
        fieldType: 'url',
        required: false,
      });
      const promptNote = 'Verify peptide purity >= 98% via HPLC.';
      assert.equal(
        (await apiA.patch('/api/v1/sections/peptides', { customFields: [coaField], aiResearchPrompt: promptNote })).status,
        200,
      );
      assert.equal(
        (
          await apiA.patch('/api/v1/members/member_wife', {
            name: 'Clara',
            routineAnchors: {
              wake: '06:15',
              breakfast: '07:15',
              workout: '07:45',
              workoutDays: [1, 3, 5],
              lunch: '12:30',
              dinner: '18:45',
              bed: '22:00',
              tz: 'UTC',
            },
          })
        ).status,
        200,
      );

      const bpcRes = await apiA.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          customFields: { coa_url: 'https://lab-coa.example.test/bpc157-parity.pdf' },
        }),
      );
      assertStatusIn(bpcRes, [200, 201], 'Create Server A BPC-157');
      const bpcId = getId(unwrapData(bpcRes.json, ['compound']));

      const pedRes = await apiA.post('/api/v1/compounds', fixtures.makePedCompound());
      assertStatusIn(pedRes, [200, 201], 'Create Server A Testosterone Cypionate');
      const pedId = getId(unwrapData(pedRes.json, ['compound']));

      const magRes = await apiA.post('/api/v1/compounds', fixtures.makeSupplementCompound());
      assertStatusIn(magRes, [200, 201], 'Create Server A Magnesium Glycinate');
      const magId = getId(unwrapData(magRes.json, ['compound']));

      const dermRes = await apiA.post('/api/v1/compounds', fixtures.makeDermCompound());
      assertStatusIn(dermRes, [200, 201], 'Create Server A Tretinoin');
      const dermId = getId(unwrapData(dermRes.json, ['compound']));

      assertStatusIn(await apiA.put(`/api/v1/ownership/${bpcId}`, { scope: 'member:member_wife', status: 'have', quantity: 2, unit: 'vial' }), [200, 201], 'Set Server A BPC ownership');
      assertStatusIn(await apiA.put(`/api/v1/ownership/${magId}`, { scope: 'household', status: 'have', quantity: 1, unit: 'bottle' }), [200, 201], 'Set Server A Magnesium ownership');
      assertStatusIn(await apiA.put(`/api/v1/ownership/${dermId}`, { scope: 'member:member_wife', status: 'have', quantity: 1, unit: 'tube' }), [200, 201], 'Set Server A Tretinoin ownership');
      assertStatusIn(await apiA.put(`/api/v1/ownership/${pedId}`, { scope: 'member:member_husband', status: 'wishlist' }), [200, 201], 'Set Server A PED ownership');

      const stackARes = await apiA.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Clara Parity Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: bpcId, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: magId, doseAmount: 200, doseUnit: 'mg' }),
            fixtures.makeStackItem({ compoundId: dermId, doseAmount: 1, doseUnit: 'pea_size' }),
          ],
        }),
      );
      assertStatusIn(stackARes, [200, 201], 'Create Server A Clara Parity Stack');
      const stackAId = getId(unwrapData(stackARes.json, ['stack']));
      assert.ok(stackAId, 'Server A stack must return valid stackId');

      const spreadARes = await apiA.post(`/api/v1/members/member_wife/stacks/${stackAId}/schedule`, {
        dateKey: '2026-10-14',
      });
      assert.equal(spreadARes.status, 200);
      const spreadA = unwrapData(spreadARes.json, ['schedule']);

      const exportRes = await apiA.get('/api/v1/export/hub.json');
      assert.equal(exportRes.status, 200, `GET /api/v1/export/hub.json failed: ${exportRes.text}`);
      assertNoStore(exportRes, 'GET /api/v1/export/hub.json');
      assert.equal(exportRes.json?._format, 'home-pharmacy-export/v1');
      assertNoSecrets(exportRes.text, [serverA.adminToken, serverA.passcode], 'GET /api/v1/export/hub.json');

      serverB = await startE2EServer({ ignoreExternalEnv: true });
      const apiB = createApiClient({ baseUrl: serverB.baseUrl, token: serverB.adminToken });

      const emptyB = unwrapData((await apiB.get('/api/v1/compounds')).json, ['compounds']);
      assert.equal(emptyB.length, 0, 'Fresh Server B must start with clean empty compound catalog');

      const importBRes = await apiB.post('/api/v1/import/hub', exportRes.json);
      assertStatusIn(importBRes, [200, 201], 'POST /api/v1/import/hub on Server B');

      const peptidesB = unwrapData((await apiB.get('/api/v1/sections/peptides')).json, ['section']);
      assert.ok(peptidesB.customFields.some((f) => f.key === 'coa_url'), 'Server B must preserve customFields');
      assert.equal(peptidesB.aiResearchPrompt, promptNote, 'Server B must preserve aiResearchPrompt');

      const membersB = unwrapData((await apiB.get('/api/v1/members')).json, ['members']);
      const wifeB = membersB.find((m) => m.id === 'member_wife');
      assert.equal(wifeB?.name, 'Clara');
      assert.equal(wifeB?.routineAnchors?.wake, '06:15');

      const compoundsB = unwrapData((await apiB.get('/api/v1/compounds')).json, ['compounds']);
      assert.equal(compoundsB.length, 4, 'Server B must import all 4 compounds');
      const bpcB = compoundsB.find((c) => getId(c) === bpcId || c.name === 'BPC-157');
      assert.equal(bpcB?.customFields?.coa_url, 'https://lab-coa.example.test/bpc157-parity.pdf');

      const ownershipsB = unwrapData((await apiB.get('/api/v1/ownership')).json, ['ownership', 'ownerships']);
      assert.ok(ownershipsB.some((o) => o.scope === 'household' && o.status === 'have'));
      assert.ok(ownershipsB.some((o) => o.scope === 'member:member_husband' && o.status === 'wishlist'));

      const stacksB = unwrapData((await apiB.get('/api/v1/members/member_wife/stacks')).json, ['stacks']);
      const stackB = stacksB.find((s) => getId(s) === stackAId || s.name === 'Clara Parity Stack');
      assert.ok(stackB, 'Server B must preserve Wife stack');
      const stackBId = getId(stackB);

      const spreadBRes = await apiB.post(`/api/v1/members/member_wife/stacks/${stackBId}/schedule`, {
        dateKey: '2026-10-14',
      });
      assert.equal(spreadBRes.status, 200);
      const spreadB = unwrapData(spreadBRes.json, ['schedule']);

      assert.deepEqual(
        normalizeSystemicSchedule(spreadB),
        normalizeSystemicSchedule(spreadA),
        'Server B deterministic systemic slots & suggestedTimes must match Server A identically',
      );
      assert.deepEqual(
        spreadB.stockSummary,
        spreadA.stockSummary,
        'Server B stockSummary must match Server A identically',
      );
      assert.equal(
        (spreadB.dermatology?.skin?.pmNights ?? []).length,
        (spreadA.dermatology?.skin?.pmNights ?? []).length,
        'Server B dermatology PM skin cycling nights must match Server A',
      );
      assert.equal(
        (spreadB.interactions?.hardStops ?? []).length,
        (spreadA.interactions?.hardStops ?? []).length,
      );
    } finally {
      try {
        if (serverB) await serverB.stop();
      } finally {
        await serverA.stop();
      }
    }
  });
});
