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

function assertNoSecrets(text, secrets, label) {
  assert.equal(typeof text, 'string', `${label}: expected string body`);
  assert.ok(text.length > 0, `${label}: expected non-empty body`);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      assert.ok(!text.includes(secret), `${label}: secret value leaked in response body`);
    }
  }
}

function getId(obj) {
  return obj?.id ?? obj?.compoundId ?? obj?.stackId ?? obj?.logId ?? null;
}

function recentIso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function extractApiKeySecret(res) {
  const unwrapped = unwrapData(res.json, ['key', 'apiKey']);
  return (
    res.json?.token ||
    res.json?.secret ||
    res.json?.rawKey ||
    res.json?.rawToken ||
    (typeof res.json?.apiKey === 'string' ? res.json.apiKey : null) ||
    (typeof res.json?.key === 'string' ? res.json.key : null) ||
    unwrapped?.token ||
    unwrapped?.secret ||
    unwrapped?.rawKey ||
    unwrapped?.rawToken ||
    unwrapped?.value ||
    null
  );
}

function collectSystemicItems(spread) {
  return (spread?.systemic?.slots ?? []).flatMap((slot) =>
    (slot.items ?? []).map((item) => ({ ...item, slotId: slot.slotId, suggestedTime: slot.suggestedTime })),
  );
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
  const ids = new Set();
  for (const item of collectSystemicItems(spread)) {
    if (item?.compoundId) ids.add(item.compoundId);
  }
  for (const cid of collectWeeklyGridCompoundIds(spread)) {
    ids.add(cid);
  }
  for (const item of spread?.dermatology?.skin?.am ?? []) {
    if (item?.compoundId) ids.add(item.compoundId);
  }
  for (const night of spread?.dermatology?.skin?.pmNights ?? []) {
    for (const step of night?.steps ?? []) {
      if (step?.compoundId) ids.add(step.compoundId);
    }
  }
  for (const bucket of ['am', 'pm', 'weekly']) {
    for (const item of spread?.dermatology?.hairScalp?.[bucket] ?? []) {
      if (item?.compoundId) ids.add(item.compoundId);
    }
  }
  return ids;
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

function parseCsvRows(csvText) {
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
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

describe('Tier 4 — Real-World Household Routine, Migration & Disaster Recovery Scenarios', () => {
  it('Scenario 1 — Full Household Onboarding & Two-Spouse Daily Routine across all 4 core sections with strict spousal isolation', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      // 1. Verify clean-slate bootstrap
      const initialCompounds = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.equal(initialCompounds.length, 0, 'Fresh hub must launch clean-slate with 0 compounds');

      const sections = unwrapData((await admin.get('/api/v1/sections')).json, ['sections']);
      const sectionIds = new Set(sections.map((s) => s.id));
      for (const coreId of ['peptides', 'peds', 'vitamins_supplements', 'dermatology']) {
        assert.ok(sectionIds.has(coreId), `Core section "${coreId}" must be bootstrapped`);
      }

      const initialMembers = unwrapData((await admin.get('/api/v1/members')).json, ['members']);
      assert.ok(initialMembers.some((m) => m.id === 'member_wife'));
      assert.ok(initialMembers.some((m) => m.id === 'member_husband'));

      // 2. Customize Clara (member_wife) and Marcus (member_husband) profiles, routineAnchors, and safetyContext
      const wifePatch = await admin.patch('/api/v1/members/member_wife', {
        name: 'Clara',
        avatarInitial: 'C',
        accentColor: '#3D7A5A',
        routineAnchors: {
          wake: '06:30',
          breakfast: '07:30',
          workout: '08:00',
          workoutDays: [1, 3, 5],
          lunch: '12:30',
          dinner: '18:30',
          bed: '22:00',
          tz: 'UTC',
        },
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'female',
          allergies: ['sulfa'],
          activeRxMeds: [],
          conditions: [],
        },
      });
      assert.equal(wifePatch.status, 200);
      const clara = unwrapData(wifePatch.json, ['member']);
      assert.equal(clara.name, 'Clara');
      assert.equal(clara.safetyContext?.biologicalSexContext, 'female');

      const husbandPatch = await admin.patch('/api/v1/members/member_husband', {
        name: 'Marcus',
        avatarInitial: 'M',
        accentColor: '#2E5E8A',
        routineAnchors: {
          wake: '05:45',
          breakfast: '07:00',
          workout: '06:00',
          workoutDays: [1, 2, 4, 5],
          lunch: '13:00',
          dinner: '19:30',
          bed: '23:00',
          tz: 'UTC',
        },
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'male',
          allergies: [],
          activeRxMeds: [],
          conditions: [],
        },
      });
      assert.equal(husbandPatch.status, 200);
      const marcus = unwrapData(husbandPatch.json, ['member']);
      assert.equal(marcus.name, 'Marcus');
      assert.equal(marcus.safetyContext?.biologicalSexContext, 'male');

      // 3. Load optional generic non-personal starter reference catalog
      const seedRes = await admin.post('/api/v1/seed/starter', {});
      assertStatusIn(seedRes, [200, 201], 'POST /api/v1/seed/starter');

      const seededCompounds = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      const bySection = {
        peptides: seededCompounds.filter((c) => c.sectionId === 'peptides'),
        peds: seededCompounds.filter((c) => c.sectionId === 'peds'),
        vitamins_supplements: seededCompounds.filter((c) => c.sectionId === 'vitamins_supplements'),
        dermatology: seededCompounds.filter((c) => c.sectionId === 'dermatology'),
      };
      for (const sec of ['peptides', 'peds', 'vitamins_supplements', 'dermatology']) {
        assert.ok(
          bySection[sec].length >= 1,
          `Starter catalog must populate core section "${sec}", got 0 compounds`,
        );
      }
      const seededBlob = JSON.stringify(seededCompounds);
      assert.ok(!seededBlob.includes('Clara'), 'Starter catalog must NOT contain member display name "Clara"');
      assert.ok(!seededBlob.includes('Marcus'), 'Starter catalog must NOT contain member display name "Marcus"');
      assertNoSecrets(seededBlob, [server.adminToken, server.passcode], 'Starter catalog zero-secrets check');

      // 4. Add one personal compound for Clara and one personal compound for Marcus (avoiding starter catalog molecule collisions)
      const seededIdentityStrings = seededCompounds.flatMap((c) =>
        [c.name, c.canonicalMolecule, ...(c.aliases ?? [])].filter(Boolean).map((s) => String(s)),
      );
      const dermUseBackup = seededIdentityStrings.some((s) => /azelaic/i.test(s));
      const claraDermRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeDermCompound({
          name: dermUseBackup ? 'Tranexamic Acid 5% Serum' : 'Azelaic Acid 15% Gel',
          canonicalMolecule: dermUseBackup ? 'tranexamic-acid-topical' : 'azelaic-acid',
          aliases: dermUseBackup ? ['TXA 5% Serum'] : ['Azelaic 15%'],
          tags: ['dermatology', dermUseBackup ? 'tranexamic_acid' : 'azelaic_acid', 'antioxidant'],
          timingRules: {
            preferredSlots: ['derm_am', 'derm_pm'],
            avoidSlots: [],
            foodState: 'any',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'AM or PM facial serum.',
          },
          sectionData: {
            targetArea: ['face'],
            vehicleType: dermUseBackup ? 'water_serum' : 'gel',
            actives: [{ name: dermUseBackup ? 'Tranexamic Acid' : 'Azelaic Acid', concentrationPct: dermUseBackup ? 5 : 15, optimalPh: 5.0 }],
            layeringStep: 3,
            waitTimeMinutes: 0,
            amPmSuitability: 'am_or_pm',
            photosensitivity: false,
            leaveOn: true,
            skinCyclingRole: 'barrier',
            pregnancySafety: 'safe',
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );
      assertStatusIn(claraDermRes, [200, 201], 'Create Clara personal derm compound');
      const claraPersonalDerm = unwrapData(claraDermRes.json, ['compound']);
      const claraPersonalDermId = getId(claraPersonalDerm);

      const pedUseBackup = seededIdentityStrings.some((s) => /drostanolone|masteron/i.test(s));
      const marcusPedRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          name: pedUseBackup ? 'Methenolone Enanthate' : 'Drostanolone Propionate',
          canonicalMolecule: pedUseBackup ? 'methenolone-enanthate' : 'drostanolone-propionate',
          aliases: pedUseBackup ? ['Primobolan Depot'] : ['Masteron Propionate'],
          dosages: {
            rangeText: '50 mg 2x/wk IM',
            defaultAmount: 50,
            defaultUnit: 'mg',
            route: 'IM',
            frequencyText: '2x/week',
            maxCeiling: 250,
          },
        }),
      );
      assertStatusIn(marcusPedRes, [200, 201], 'Create Marcus personal PED compound');
      const marcusPersonalPed = unwrapData(marcusPedRes.json, ['compound']);
      const marcusPersonalPedId = getId(marcusPersonalPed);

      const sharedSupp = bySection.vitamins_supplements[0];
      const sharedPeptide = bySection.peptides[0];
      const starterPed = bySection.peds[0];
      const starterDerm = bySection.dermatology[0];

      const sharedSuppId = getId(sharedSupp);
      const sharedPeptideId = getId(sharedPeptide);
      const starterPedId = getId(starterPed);
      const starterDermId = getId(starterDerm);

      // 5. Configure shared household vs personal ownership
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${sharedSuppId}`, { scope: 'household', status: 'have', quantity: 2, unit: 'bottle' }),
        [200, 201],
        'Household shared supplement ownership',
      );
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${sharedPeptideId}`, { scope: 'household', status: 'have', quantity: 1, unit: 'vial' }),
        [200, 201],
        'Household shared peptide ownership',
      );
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${claraPersonalDermId}`, { scope: 'member:member_wife', status: 'have', quantity: 1, unit: 'tube' }),
        [200, 201],
        'Clara personal derm ownership',
      );
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${marcusPersonalPedId}`, { scope: 'member:member_husband', status: 'have', quantity: 1, unit: 'vial' }),
        [200, 201],
        'Marcus personal PED ownership',
      );
      const ownershipList = unwrapData((await admin.get('/api/v1/ownership')).json, ['ownership', 'ownerships']);
      assert.ok(ownershipList.some((o) => o.compoundId === sharedSuppId && o.scope === 'household' && o.status === 'have'));
      assert.ok(ownershipList.some((o) => o.compoundId === claraPersonalDermId && o.scope === 'member:member_wife' && o.status === 'have'));
      assert.ok(ownershipList.some((o) => o.compoundId === marcusPersonalPedId && o.scope === 'member:member_husband' && o.status === 'have'));

      // Cross-spouse ownership isolation via member-scoped catalog query
      const claraHaveRes = await admin.get('/api/v1/compounds', { query: { ownership: 'have', member: 'member_wife' } });
      assert.equal(claraHaveRes.status, 200, `GET Clara owned compounds failed: ${claraHaveRes.text}`);
      const claraHaveIds = new Set(unwrapData(claraHaveRes.json, ['compounds']).map((c) => getId(c)));
      assert.ok(claraHaveIds.has(sharedSuppId), 'Clara ownership=have must include shared supplement');
      assert.ok(claraHaveIds.has(sharedPeptideId), 'Clara ownership=have must include shared peptide');
      assert.ok(claraHaveIds.has(claraPersonalDermId), 'Clara ownership=have must include her personal derm compound');
      assert.ok(!claraHaveIds.has(marcusPersonalPedId), 'Clara ownership=have MUST EXCLUDE Marcus personal PED');

      const marcusHaveRes = await admin.get('/api/v1/compounds', { query: { ownership: 'have', member: 'member_husband' } });
      assert.equal(marcusHaveRes.status, 200, `GET Marcus owned compounds failed: ${marcusHaveRes.text}`);
      const marcusHaveIds = new Set(unwrapData(marcusHaveRes.json, ['compounds']).map((c) => getId(c)));
      assert.ok(marcusHaveIds.has(sharedSuppId), 'Marcus ownership=have must include shared supplement');
      assert.ok(marcusHaveIds.has(sharedPeptideId), 'Marcus ownership=have must include shared peptide');
      assert.ok(marcusHaveIds.has(marcusPersonalPedId), 'Marcus ownership=have must include his personal PED');
      assert.ok(!marcusHaveIds.has(claraPersonalDermId), 'Marcus ownership=have MUST EXCLUDE Clara personal derm compound');

      // 6. Build independent cross-section stacks spanning all 4 sections for Clara and Marcus
      const buildItem = (cmp) =>
        fixtures.makeStackItem({
          compoundId: getId(cmp),
          doseAmount: cmp.dosages?.defaultAmount ?? 1,
          doseUnit: cmp.dosages?.defaultUnit ?? 'mg',
        });

      const claraStackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Clara Daily 4-Section Stack',
          memberId: 'member_wife',
          items: [
            buildItem(sharedPeptide),
            buildItem(starterPed),
            buildItem(sharedSupp),
            buildItem(claraPersonalDerm),
          ],
        }),
      );
      assertStatusIn(claraStackRes, [200, 201], 'Create Clara 4-section stack');
      const claraStackId = getId(unwrapData(claraStackRes.json, ['stack']));

      const marcusStackRes = await admin.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Marcus Daily 4-Section Stack',
          memberId: 'member_husband',
          items: [
            buildItem(sharedPeptide),
            buildItem(marcusPersonalPed),
            buildItem(sharedSupp),
            buildItem(starterDerm),
          ],
        }),
      );
      assertStatusIn(marcusStackRes, [200, 201], 'Create Marcus 4-section stack');
      const marcusStackId = getId(unwrapData(marcusStackRes.json, ['stack']));

      // 7. Generate spread schedules for both spouses and verify deterministic placement + anchor alignment + isolation
      const claraSched1 = unwrapData(
        (await admin.post(`/api/v1/members/member_wife/stacks/${claraStackId}/schedule`, { dateKey: '2026-10-12' })).json,
        ['schedule'],
      );
      const claraSched2 = unwrapData(
        (await admin.post(`/api/v1/members/member_wife/stacks/${claraStackId}/schedule`, { dateKey: '2026-10-12' })).json,
        ['schedule'],
      );
      assert.deepEqual(
        claraSched1.systemic.slots.map((s) => ({ slotId: s.slotId, suggestedTime: s.suggestedTime, ids: s.items.map((i) => i.compoundId).sort() })),
        claraSched2.systemic.slots.map((s) => ({ slotId: s.slotId, suggestedTime: s.suggestedTime, ids: s.items.map((i) => i.compoundId).sort() })),
        'Clara spread schedule must be deterministic across repeated runs',
      );

      const marcusSched = unwrapData(
        (await admin.post(`/api/v1/members/member_husband/stacks/${marcusStackId}/schedule`, { dateKey: '2026-10-12' })).json,
        ['schedule'],
      );

      const claraWake = claraSched1.systemic.slots.find((s) => s.slotId === 'waking_fasted')?.suggestedTime;
      const marcusWake = marcusSched.systemic.slots.find((s) => s.slotId === 'waking_fasted')?.suggestedTime;
      assert.ok(claraWake && marcusWake, 'Both schedules must compute waking_fasted suggestedTime');
      assert.notEqual(claraWake, marcusWake, `Clara (${claraWake}) and Marcus (${marcusWake}) must reflect distinct routineAnchors`);

      const claraScheduledIds = collectAllScheduledCompoundIds(claraSched1);
      const marcusScheduledIds = collectAllScheduledCompoundIds(marcusSched);

      assert.ok(claraScheduledIds.has(sharedPeptideId));
      assert.ok(claraScheduledIds.has(starterPedId));
      assert.ok(claraScheduledIds.has(sharedSuppId));
      assert.ok(claraScheduledIds.has(claraPersonalDermId));
      assert.ok(!claraScheduledIds.has(marcusPersonalPedId), 'Clara schedule must NEVER include Marcus personal PED');

      assert.ok(marcusScheduledIds.has(sharedPeptideId));
      assert.ok(marcusScheduledIds.has(marcusPersonalPedId));
      assert.ok(marcusScheduledIds.has(sharedSuppId));
      assert.ok(marcusScheduledIds.has(starterDermId));
      assert.ok(!marcusScheduledIds.has(claraPersonalDermId), 'Marcus schedule must NEVER include Clara personal derm item');

      // 8. Log daily taken doses + skip-with-reason for each spouse (recent UTC timestamps inside 7d/30d/90d adherence windows)
      const claraLog1At = recentIso(150);
      assertStatusIn(
        await admin.post('/api/v1/members/member_wife/logs', {
          compoundId: sharedSuppId,
          stackId: claraStackId,
          dose: sharedSupp.dosages?.defaultAmount ?? 200,
          doseValue: sharedSupp.dosages?.defaultAmount ?? 200,
          doseAmount: sharedSupp.dosages?.defaultAmount ?? 200,
          unit: sharedSupp.dosages?.defaultUnit ?? 'mg',
          doseUnit: sharedSupp.dosages?.defaultUnit ?? 'mg',
          skipped: false,
          takenAt: claraLog1At,
          datetime: claraLog1At,
        }),
        [200, 201],
        'Clara taken log 1',
      );
      const claraLog2At = recentIso(120);
      assertStatusIn(
        await admin.post('/api/v1/members/member_wife/logs', {
          compoundId: claraPersonalDermId,
          stackId: claraStackId,
          dose: 1,
          doseValue: 1,
          doseAmount: 1,
          unit: 'pea_size',
          doseUnit: 'pea_size',
          skipped: false,
          takenAt: claraLog2At,
          datetime: claraLog2At,
        }),
        [200, 201],
        'Clara taken log 2',
      );
      const claraSkipAt = recentIso(90);
      assertStatusIn(
        await admin.post('/api/v1/members/member_wife/logs', {
          compoundId: sharedPeptideId,
          stackId: claraStackId,
          skipped: true,
          skipReason: 'morning travel schedule',
          takenAt: claraSkipAt,
          datetime: claraSkipAt,
        }),
        [200, 201],
        'Clara skipped log',
      );

      const marcusLog1At = recentIso(140);
      assertStatusIn(
        await admin.post('/api/v1/members/member_husband/logs', {
          compoundId: marcusPersonalPedId,
          stackId: marcusStackId,
          dose: 50,
          doseValue: 50,
          doseAmount: 50,
          unit: 'mg',
          doseUnit: 'mg',
          site: 'glute_left',
          skipped: false,
          takenAt: marcusLog1At,
          datetime: marcusLog1At,
        }),
        [200, 201],
        'Marcus taken log 1',
      );
      const marcusLog2At = recentIso(80);
      assertStatusIn(
        await admin.post('/api/v1/members/member_husband/logs', {
          compoundId: sharedSuppId,
          stackId: marcusStackId,
          dose: sharedSupp.dosages?.defaultAmount ?? 200,
          doseValue: sharedSupp.dosages?.defaultAmount ?? 200,
          doseAmount: sharedSupp.dosages?.defaultAmount ?? 200,
          unit: sharedSupp.dosages?.defaultUnit ?? 'mg',
          doseUnit: sharedSupp.dosages?.defaultUnit ?? 'mg',
          skipped: false,
          takenAt: marcusLog2At,
          datetime: marcusLog2At,
        }),
        [200, 201],
        'Marcus taken log 2',
      );

      // 9. Verify strict isolation across stacks, personal ownership, logs, and adherence
      const claraStacks = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']);
      const marcusStacks = unwrapData((await admin.get('/api/v1/members/member_husband/stacks')).json, ['stacks']);
      assert.equal(claraStacks.length, 1);
      assert.equal(marcusStacks.length, 1);
      assert.notEqual(getId(claraStacks[0]), getId(marcusStacks[0]));

      const claraLogs = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);
      const marcusLogs = unwrapData((await admin.get('/api/v1/members/member_husband/logs')).json, ['logs']);
      assert.equal(claraLogs.length, 3);
      assert.equal(marcusLogs.length, 2);
      assert.ok(claraLogs.every((l) => l.compoundId !== marcusPersonalPedId), 'Clara logs must not contain Marcus PED');
      assert.ok(marcusLogs.every((l) => l.compoundId !== claraPersonalDermId), 'Marcus logs must not contain Clara derm');
      assert.ok(claraLogs.some((l) => l.skipped === true), 'Clara skip-with-reason log must persist');

      const claraAdhRes = await admin.get('/api/v1/members/member_wife/adherence');
      const marcusAdhRes = await admin.get('/api/v1/members/member_husband/adherence');
      assert.equal(claraAdhRes.status, 200);
      assert.equal(marcusAdhRes.status, 200);
      assertNoStore(claraAdhRes, 'Clara adherence');
      assertNoStore(marcusAdhRes, 'Marcus adherence');
      const claraAdh = unwrapData(claraAdhRes.json, ['adherence']);
      const marcusAdh = unwrapData(marcusAdhRes.json, ['adherence']);

      const claraMetrics = extractAdherenceMetrics(claraAdh);
      const marcusMetrics = extractAdherenceMetrics(marcusAdh);
      assert.equal(claraMetrics.taken, 2, `Clara 7d/overall taken must be 2, got ${JSON.stringify(claraAdh)}`);
      assert.equal(claraMetrics.skipped, 1, `Clara 7d/overall skipped must be 1, got ${JSON.stringify(claraAdh)}`);
      assert.equal(marcusMetrics.taken, 2, `Marcus 7d/overall taken must be 2, got ${JSON.stringify(marcusAdh)}`);
      assert.equal(marcusMetrics.skipped, 0, `Marcus 7d/overall skipped must be 0, got ${JSON.stringify(marcusAdh)}`);
      if (typeof claraMetrics.rate === 'number' && typeof marcusMetrics.rate === 'number') {
        assert.ok(
          marcusMetrics.rate > claraMetrics.rate,
          `Marcus adherence rate (${marcusMetrics.rate}) must exceed Clara rate (${claraMetrics.rate})`,
        );
      }
      assert.notDeepEqual(
        stripAdherenceMeta(claraAdh),
        stripAdherenceMeta(marcusAdh),
        'Metadata-stripped Clara and Marcus adherence metrics must strictly differ',
      );
    } finally {
      await server.stop();
    }
  });

  it('Scenario 2 — Legacy protocol-os migration, fractional IU logging, formula-safe CSV / Hub JSON / Context MD exports & snapshot disaster recovery', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      // 1. Import realistic protocol-os-export/v1 payload
      const importRes = await admin.post('/api/v1/import/protocol-os', fixtures.makeProtocolOsExport());
      assertStatusIn(importRes, [200, 201], 'POST /api/v1/import/protocol-os');

      const migratedCompounds = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      const bpc = migratedCompounds.find((c) => /bpc/i.test(c.name) && !/wolverine|blend/i.test(c.name));
      const blend = migratedCompounds.find((c) => /wolverine|bpc.*tb|blend/i.test(c.name));
      assert.ok(bpc, 'protocol-os migration must import BPC-157');
      assert.ok(blend, 'protocol-os migration must import Wolverine BPC+TB blend');
      if (blend.halfLife) {
        assert.ok(
          blend.halfLife.valueHours === null || blend.halfLife.valueHours === undefined || blend.halfLife.kind === 'unmodeled',
          `Multi-ingredient blend must NOT fabricate a single half-life, got ${JSON.stringify(blend.halfLife)}`,
        );
      }
      const bpcId = getId(bpc);
      const blendId = getId(blend);

      // 2. Add HCG (IU unit) and a compound with spreadsheet formula-trigger notes (=SUM(A1:A2))
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
      assertStatusIn(hcgRes, [200, 201], 'Create HCG compound');
      const hcgId = getId(unwrapData(hcgRes.json, ['compound']));

      const formulaCompoundRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Electrolyte Formula Audit',
          canonicalMolecule: 'electrolyte-audit',
          aliases: ['Formula Test'],
          tags: ['supplement', 'electrolytes'],
          summary: '=SUM(A1:A2) synthetic formula guard test',
          detailedDescription: '+1+2 synthetic formula description test',
          notes: '=SUM(A1:A2)',
          storageNotes: '@SUM(1,2) keep dry',
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Sodium/Potassium Electrolyte Blend',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Sodium Citrate', amount: 200, unit: 'mg' }],
            adultUpperLimit: null,
          },
        }),
      );
      assertStatusIn(formulaCompoundRes, [200, 201], 'Create formula-guard test compound');
      const formulaId = getId(unwrapData(formulaCompoundRes.json, ['compound']));

      // 3. Build spread stack combining migrated peptides + HCG + formula supplement
      const stackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Migrated Protocol-OS Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: bpcId, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: blendId, doseAmount: 500, doseUnit: 'mcg' }),
            fixtures.makeStackItem({
              compoundId: hcgId,
              doseAmount: 12.5,
              doseUnit: 'IU',
              frequency: '2x_weekly',
              cadence: { type: 'weekly', daysOfWeek: [1, 4] },
            }),
            fixtures.makeStackItem({ compoundId: formulaId, doseAmount: 200, doseUnit: 'mg' }),
          ],
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'Create migrated stack');
      const stackId = getId(unwrapData(stackRes.json, ['stack']));

      const schedRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(schedRes.status, 200);
      const spread = unwrapData(schedRes.json, ['schedule']);
      const scheduledIds = collectAllScheduledCompoundIds(spread);
      assert.ok(scheduledIds.has(bpcId));
      assert.ok(scheduledIds.has(hcgId));

      // 4. Log fractional 12.5 IU HCG dose with formula-like note '=SUM(A1:A2)' and verify lossless preservation
      const hcgLogAt = '2026-10-12T08:00:00.000Z';
      const hcgLogRes = await admin.post('/api/v1/members/member_wife/logs', {
        compoundId: hcgId,
        stackId,
        dose: 12.5,
        doseValue: 12.5,
        doseAmount: 12.5,
        unit: 'IU',
        doseUnit: 'IU',
        site: 'abdomen_right',
        skipped: false,
        notes: '=SUM(A1:A2)',
        takenAt: hcgLogAt,
        datetime: hcgLogAt,
      });
      assertStatusIn(hcgLogRes, [200, 201], 'Log fractional 12.5 IU HCG');

      const logs = unwrapData((await admin.get('/api/v1/members/member_wife/logs')).json, ['logs']);
      const hcgLog = logs.find((l) => l.compoundId === hcgId);
      assert.ok(hcgLog, 'Fractional HCG log must exist in member logs');
      const loggedDose = extractLogDose(hcgLog);
      assert.equal(loggedDose, 12.5, `Fractional 12.5 IU dose must be preserved losslessly without rounding, got ${loggedDose}`);
      assert.equal(extractLogUnit(hcgLog), 'IU', `Unit 'IU' must be preserved without conversion, got ${JSON.stringify(hcgLog)}`);
      assert.equal(hcgLog.notes, '=SUM(A1:A2)', 'JSON log must preserve verbatim note text');

      // Mint a scoped API key so we can verify ZERO secret leakage across all export formats
      const mintedRes = await admin.post('/api/v1/keys', { name: 'Export Audit Key', scope: 'read' });
      assertStatusIn(mintedRes, [200, 201], 'Mint read API key for export secret audit');
      const mintedSecret = extractApiKeySecret(mintedRes);
      assert.ok(
        typeof mintedSecret === 'string' && mintedSecret.length >= 16,
        `POST /api/v1/keys must return raw secret once (>=16 chars), got ${mintedRes.text}`,
      );
      const exportSecrets = [server.adminToken, server.passcode, mintedSecret];

      // 5. Ensure daily snapshot exists before exports & destructive mutation
      const dateKey = await ensureSnapshotDateKey(admin);

      // 6. Export Format #1 — Hub JSON
      const hubJsonRes = await admin.get('/api/v1/export/hub.json');
      assert.equal(hubJsonRes.status, 200, `Hub JSON export failed: ${hubJsonRes.text}`);
      assertNoStore(hubJsonRes, 'GET /api/v1/export/hub.json');
      assert.equal(hubJsonRes.json?._format, 'home-pharmacy-export/v1');
      assert.match(hubJsonRes.text, /BPC-157/i);
      assert.match(hubJsonRes.text, /HCG/);
      assertNoSecrets(hubJsonRes.text, exportSecrets, 'GET /api/v1/export/hub.json');

      // 7. Export Format #2 — Formula-safe CSV
      const csvRes = await admin.get('/api/v1/export/compounds.csv');
      assert.equal(csvRes.status, 200, `CSV export failed: ${csvRes.text}`);
      assertNoStore(csvRes, 'GET /api/v1/export/compounds.csv');
      assert.match(csvRes.headers.get('content-type') || '', /text\/csv/i, 'CSV export must return text/csv');
      assert.match(csvRes.text, /BPC-157/i);
      assert.match(csvRes.text, /HCG/);
      assertNoSecrets(csvRes.text, exportSecrets, 'GET /api/v1/export/compounds.csv');

      const csvRows = parseCsvRows(csvRes.text);
      assert.ok(csvRows.length >= 4, `Expected header + >=3 compound rows in CSV, got ${csvRows.length}`);
      const allDataCells = csvRows.slice(1).flat();
      assert.ok(
        allDataCells.some((cell) => cell.startsWith("'=SUM(A1:A2)")),
        `CSV export must neutralize =SUM(A1:A2) with a leading single quote: ${csvRes.text.slice(0, 800)}`,
      );
      for (const cell of allDataCells) {
        assert.ok(
          !cell.startsWith('=SUM(A1:A2)'),
          `Unescaped CSV formula injection detected in cell: "${cell}"`,
        );
        assert.ok(
          !/^[=+\-@\t\r]/.test(cell),
          `CSV cell starts with unescaped spreadsheet formula trigger character: "${cell}"`,
        );
      }

      // 8. Export Format #3 — Markdown & JSON AI Context Bundles
      const mdRes = await admin.get('/api/v1/export/context.md');
      assert.equal(mdRes.status, 200, `Context MD export failed: ${mdRes.text}`);
      assertNoStore(mdRes, 'GET /api/v1/export/context.md');
      assert.match(mdRes.text, /BPC-157/i);
      assert.match(mdRes.text, /HCG/);
      assertNoSecrets(mdRes.text, exportSecrets, 'GET /api/v1/export/context.md');

      const ctxJsonRes = await admin.get('/api/v1/export/context.json');
      assert.equal(ctxJsonRes.status, 200, `Context JSON export failed: ${ctxJsonRes.text}`);
      assertNoStore(ctxJsonRes, 'GET /api/v1/export/context.json');
      assert.ok(ctxJsonRes.json && typeof ctxJsonRes.json === 'object');
      assertNoSecrets(ctxJsonRes.text, exportSecrets, 'GET /api/v1/export/context.json');

      // 9. Accidental destructive deletion + rogue compound -> Snapshot Disaster Recovery
      assertStatusIn(await admin.del(`/api/v1/compounds/${bpcId}`), [200, 204], 'Accidentally delete BPC-157');
      assertStatusIn(
        await admin.post(
          '/api/v1/compounds',
          fixtures.makePeptideCompound({
            name: 'Accidental Rogue Post-Snapshot Entry',
            canonicalMolecule: 'accidental-rogue-entry',
            aliases: [],
          }),
        ),
        [200, 201],
        'Create post-snapshot rogue entry',
      );

      const destroyedCompounds = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(!destroyedCompounds.some((c) => getId(c) === bpcId), 'BPC-157 must be absent after accidental deletion');
      assert.ok(destroyedCompounds.some((c) => c.name === 'Accidental Rogue Post-Snapshot Entry'));

      const restoreRes = await admin.post(`/api/v1/snapshots/${encodeURIComponent(dateKey)}/restore`, {});
      assert.equal(restoreRes.status, 200, `Snapshot restore failed: ${restoreRes.text}`);

      const recoveredCompounds = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(
        recoveredCompounds.some((c) => getId(c) === bpcId || (/bpc/i.test(c.name) && !/wolverine|blend/i.test(c.name))),
        'Snapshot restore must recover accidentally deleted BPC-157',
      );
      assert.ok(
        !recoveredCompounds.some((c) => c.name === 'Accidental Rogue Post-Snapshot Entry'),
        'Snapshot restore must roll back post-snapshot rogue mutation',
      );
    } finally {
      await server.stop();
    }
  });
});
