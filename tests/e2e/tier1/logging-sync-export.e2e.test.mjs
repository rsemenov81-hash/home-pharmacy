/**
 * Tier 1 E2E Suite — Area E: Dose Logging, Adherence, Advisory Dose-Sanity Gate,
 * Conflict-Safe Cloud Sync, Daily Snapshots, Multi-Format Import/Export & Web Push
 * (Happy Paths: F28, F38, F39, F41, F42, F43).
 *
 * Strictly opaque-box: imports ONLY from ../harness.mjs and Node built-ins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  startE2EServer,
  createApiClient,
  unwrapData,
  fixtures,
} from '../harness.mjs';

async function withServer(fn, options = {}) {
  const server = await startE2EServer(options);
  try {
    const api = createApiClient({
      baseUrl: server.baseUrl,
      token: server.adminToken,
    });
    return await fn({ server, api });
  } finally {
    await server.stop();
  }
}

function assertNoStore(res, label) {
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  assert.ok(
    cc.includes('no-store'),
    `${label}: expected Cache-Control to include "no-store", got "${cc}"`,
  );
}

async function createCompound(api, payload) {
  const res = await api.post('/api/v1/compounds', payload);
  assert.ok(
    res.status === 201 || res.status === 200,
    `POST /api/v1/compounds (${payload.name}) expected 200/201, got ${res.status}: ${res.text}`,
  );
  assertNoStore(res, `POST /api/v1/compounds (${payload.name})`);
  const compound = unwrapData(res.json, ['compound']);
  assert.ok(compound && typeof compound.id === 'string' && compound.id.length > 0);
  return compound;
}

/**
 * Strict RFC 4180 CSV parser supporting UTF-8 BOM, CRLF/LF line endings,
 * quoted commas, escaped double quotes (""), and embedded newlines.
 */
function parseCsv(rawText) {
  assert.equal(typeof rawText, 'string', 'CSV response text must be a string');
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  assert.equal(inQuotes, false, 'CSV ended with an unclosed quoted field');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function extractSanityInfo(rawJson, log) {
  const gate =
    log?.sanityCheck ??
    log?.doseSanity ??
    log?.doseGate ??
    log?.gate ??
    rawJson?.sanityCheck ??
    rawJson?.doseSanity ??
    rawJson?.doseGate ??
    rawJson?.gate ??
    rawJson?.data?.sanityCheck ??
    rawJson?.data?.doseSanity ??
    null;

  const needsReview = Boolean(
    log?.needsReview === true ||
      rawJson?.needsReview === true ||
      rawJson?.data?.needsReview === true ||
      gate?.needsReview === true,
  );

  const verdict = String(
    gate?.verdict ??
      gate?.decision ??
      gate?.status ??
      log?.sanityVerdict ??
      rawJson?.verdict ??
      '',
  );

  const warningSources = [
    gate?.warnings,
    gate?.reasons,
    log?.warnings,
    log?.sanityWarnings,
    rawJson?.warnings,
    rawJson?.sanityWarnings,
  ];
  const warnings = [];
  for (const src of warningSources) {
    if (Array.isArray(src)) warnings.push(...src.filter(Boolean));
  }
  if (typeof rawJson?.warning === 'string' && rawJson.warning.trim()) warnings.push(rawJson.warning);
  if (typeof log?.warning === 'string' && log.warning.trim()) warnings.push(log.warning);

  const trimmedVerdict = verdict.trim();
  const isExplicitCleanVerdict = /^(ok|pass|passed|clean|allow|allowed|none|no[\s_-]*warnings?)$/i.test(
    trimmedVerdict,
  );
  const verdictFlagged =
    !isExplicitCleanVerdict &&
    /(?:^|[\s_-])(confirm|warn|warning|needs_review|review|advisory|flagged?)(?:$|[\s_-])/i.test(
      trimmedVerdict,
    );

  const isFlagged = needsReview || verdictFlagged || warnings.length > 0;

  return { needsReview, verdict, warnings, gate, isFlagged };
}

function extractAdherenceWindow(adherence, days) {
  const keyCandidates = {
    7: ['7d', '7', 'days7', 'd7', 'last7Days', 'sevenDay'],
    30: ['30d', '30', 'days30', 'd30', 'last30Days', 'thirtyDay'],
    90: ['90d', '90', 'days90', 'd90', 'last90Days', 'ninetyDay'],
  }[days];

  const containers = [adherence?.windows, adherence?.periods, adherence].filter(
    (c) => c && typeof c === 'object',
  );
  for (const container of containers) {
    for (const key of keyCandidates) {
      if (container[key] && typeof container[key] === 'object') {
        const win = container[key];
        return {
          raw: win,
          taken: win.taken ?? win.takenCount ?? win.completed ?? win.loggedTaken,
          skipped: win.skipped ?? win.skippedCount,
          rate: win.rate ?? win.adherenceRate ?? win.pct ?? win.adherencePct ?? win.percentage,
        };
      }
    }
  }
  return null;
}

function extractRev(res) {
  const j = res.json;
  const rawCandidates = [
    j?._rev,
    j?.rev,
    j?.currentRev,
    j?.serverRev,
    j?.data?._rev,
    j?.data?.rev,
    j?.state?._rev,
    j?.state?.rev,
  ];
  for (const c of rawCandidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && /^\d+$/.test(c.trim())) return Number(c.trim());
  }
  const etag = res.headers.get('etag');
  if (etag) {
    const cleaned = etag.replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
    if (/^\d+$/.test(cleaned)) return Number(cleaned);
  }
  return null;
}

function getSyncStateContainer(payload) {
  if (payload && Array.isArray(payload.compounds)) return payload;
  if (payload?.data && Array.isArray(payload.data.compounds)) return payload.data;
  if (payload?.state && Array.isArray(payload.state.compounds)) return payload.state;
  return payload;
}

function extractSnapshotDateKey(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return entry.dateKey ?? entry.date ?? entry.id ?? entry.key ?? null;
  }
  return null;
}

function generateWebPushKeys() {
  // Valid RFC 8291 key material: 65-byte uncompressed P-256 point (0x04 || 64 bytes) & 16-byte auth secret
  const p256dh = Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]).toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  return { p256dh, auth };
}

function extractLogDose(log) {
  return log?.dose ?? log?.doseAmount ?? log?.amount ?? log?.doseValue;
}

function extractLogUnit(log) {
  return log?.unit ?? log?.doseUnit;
}

describe('Tier 1 — Area E: Dose Logging, Adherence, Sync, Snapshots, Import/Export & Web Push', () => {
  it('T1: Dose logging CRUD (quick-log, injectable site/mL, skip-with-reason, list & undo DELETE)', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(api, fixtures.makePeptideCompound());
      const mag = await createCompound(api, fixtures.makeSupplementCompound());
      const nowIso = new Date().toISOString();

      // 1. Quick-log oral supplement
      const quickRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: mag.id,
        dose: 200,
        doseAmount: 200,
        unit: 'mg',
        doseUnit: 'mg',
        slot: 'bedtime_fasted',
        takenAt: nowIso,
        skipped: false,
        notes: 'Quick-logged evening magnesium.',
      });
      assert.ok(
        quickRes.status === 201 || quickRes.status === 200,
        `Quick-log POST expected 200/201, got ${quickRes.status}: ${quickRes.text}`,
      );
      assertNoStore(quickRes, 'POST quick-log');
      const quickLog = unwrapData(quickRes.json, ['log', 'entry', 'record']);
      assert.ok(quickLog && typeof quickLog.id === 'string' && quickLog.id.length > 0);
      assert.equal(quickLog.compoundId, mag.id);
      assert.equal(extractLogDose(quickLog), 200);
      assert.equal(extractLogUnit(quickLog), 'mg');

      // 2. Injectable draw log with site & mL
      const injRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        slot: 'waking_fasted',
        takenAt: nowIso,
        injectionSite: 'abdomen_left',
        site: 'abdomen_left',
        volumeMl: 0.1,
        doseMl: 0.1,
        skipped: false,
        notes: 'U-100 draw 10 units.',
      });
      assert.ok(
        injRes.status === 201 || injRes.status === 200,
        `Injectable POST expected 200/201, got ${injRes.status}: ${injRes.text}`,
      );
      const injLog = unwrapData(injRes.json, ['log', 'entry', 'record']);
      assert.ok(injLog && typeof injLog.id === 'string');
      assert.equal(injLog.injectionSite ?? injLog.site, 'abdomen_left');
      assert.equal(injLog.volumeMl ?? injLog.doseMl, 0.1);

      // 3. Skip-with-reason log (must succeed without triggering <= 0 dose hard-block)
      const skipRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        slot: 'bedtime_fasted',
        takenAt: nowIso,
        skipped: true,
        skipReason: 'Traveling — skipped evening dose',
        notes: 'Skipped intentionally during flight.',
      });
      assert.ok(
        skipRes.status === 201 || skipRes.status === 200,
        `Skip-with-reason POST expected 200/201, got ${skipRes.status}: ${skipRes.text}`,
      );
      const skipLog = unwrapData(skipRes.json, ['log', 'entry', 'record']);
      assert.ok(skipLog && typeof skipLog.id === 'string');
      assert.equal(skipLog.skipped, true);
      const skipDetail = `${skipLog.skipReason ?? skipLog.reason ?? ''} ${skipLog.notes ?? ''}`;
      assert.ok(
        /traveling|skipped/i.test(skipDetail),
        `Skip log must preserve skipReason or notes context, got: ${JSON.stringify(skipLog)}`,
      );

      // 4. GET logs returns all 3 entries
      const listRes = await api.get('/api/v1/members/member_wife/logs');
      assert.equal(listRes.status, 200, `GET logs expected 200: ${listRes.text}`);
      assertNoStore(listRes, 'GET logs');
      const logs = unwrapData(listRes.json, ['logs', 'entries']);
      assert.ok(Array.isArray(logs), 'GET logs must return an array');
      const logIds = new Set(logs.map((l) => l.id));
      assert.ok(logIds.has(quickLog.id) && logIds.has(injLog.id) && logIds.has(skipLog.id));

      // 5. DELETE (undo) quick-log
      const delRes = await api.del(
        `/api/v1/members/member_wife/logs/${encodeURIComponent(quickLog.id)}`,
      );
      assert.ok(
        delRes.status === 200 || delRes.status === 204,
        `DELETE log expected 200/204, got ${delRes.status}: ${delRes.text}`,
      );

      const afterRes = await api.get('/api/v1/members/member_wife/logs');
      assert.equal(afterRes.status, 200);
      const afterLogs = unwrapData(afterRes.json, ['logs', 'entries']);
      assert.ok(!afterLogs.some((l) => l.id === quickLog.id), 'Undone log must be removed');
      assert.ok(afterLogs.some((l) => l.id === injLog.id), 'Injectable log must remain intact');
      assert.ok(afterLogs.some((l) => l.id === skipLog.id), 'Skipped log must remain intact');
    });
  });

  it('T2: Advisory Dose-Sanity Gate passes normal within-range doses cleanly without needsReview', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(
        api,
        fixtures.makePeptideCompound({
          dosages: {
            rangeText: '250-500 mcg daily',
            defaultAmount: 250,
            defaultUnit: 'mcg',
            route: 'SubQ',
            frequencyText: 'Daily',
            maxCeiling: 1000,
          },
        }),
      );

      const firstRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        slot: 'waking_fasted',
        takenAt: new Date(Date.now() - 86_400_000).toISOString(),
        skipped: false,
      });
      assert.ok(firstRes.status === 201 || firstRes.status === 200, `Baseline dose log failed: ${firstRes.text}`);
      assertNoStore(firstRes, 'POST baseline dose');
      const firstLog = unwrapData(firstRes.json, ['log', 'entry', 'record']);
      const firstSanity = extractSanityInfo(firstRes.json, firstLog);
      assert.equal(
        firstSanity.isFlagged,
        false,
        `Normal 250 mcg dose within range must pass cleanly without advisory warning: ${firstRes.text}`,
      );

      // Second dose 300 mcg (1.2x prior dose, well under 5x jump and 1000 mcg ceiling)
      const secondRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 300,
        doseAmount: 300,
        unit: 'mcg',
        doseUnit: 'mcg',
        slot: 'waking_fasted',
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      assert.ok(secondRes.status === 201 || secondRes.status === 200, `Second normal dose log failed: ${secondRes.text}`);
      const secondLog = unwrapData(secondRes.json, ['log', 'entry', 'record']);
      const secondSanity = extractSanityInfo(secondRes.json, secondLog);
      assert.equal(
        secondSanity.isFlagged,
        false,
        `Normal 300 mcg follow-up dose must pass cleanly without needsReview: ${secondRes.text}`,
      );
      assert.equal(extractLogDose(secondLog), 300);
      assert.equal(extractLogUnit(secondLog), 'mcg');
    });
  });

  it('T3: Adherence statistics compute accurate 7/30/90d windows and exclude skipped items from taken count', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(api, fixtures.makePeptideCompound());
      const now = Date.now();
      const dayMs = 86_400_000;

      // Create active stack so adherence engine has stack context if needed
      const stackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Adherence Tracking Stack',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: bpc.id, doseAmount: 250, doseUnit: 'mcg' })],
        }),
      );
      assert.ok(stackRes.status === 201 || stackRes.status === 200);

      // Within 7 days: 2 taken + 1 skipped
      for (const offsetDays of [0, 2]) {
        const res = await api.post('/api/v1/members/member_wife/logs', {
          compoundId: bpc.id,
          dose: 250,
          doseAmount: 250,
          unit: 'mcg',
          doseUnit: 'mcg',
          takenAt: new Date(now - offsetDays * dayMs).toISOString(),
          skipped: false,
        });
        assert.ok(res.status === 201 || res.status === 200, `Taken log failed: ${res.text}`);
      }

      const skipRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        takenAt: new Date(now - 1 * dayMs).toISOString(),
        skipped: true,
        skipReason: 'Missed morning window',
      });
      assert.ok(skipRes.status === 201 || skipRes.status === 200, `Skipped log failed: ${skipRes.text}`);

      // Outside 7d but inside 30d & 90d: 1 taken log 15 days ago
      const older30Res = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(now - 15 * dayMs).toISOString(),
        skipped: false,
      });
      assert.ok(older30Res.status === 201 || older30Res.status === 200, `15d-old log failed: ${older30Res.text}`);

      // Outside 30d but inside 90d: 1 taken log 45 days ago (proves 90d != 30d window)
      const older90Res = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(now - 45 * dayMs).toISOString(),
        skipped: false,
      });
      assert.ok(older90Res.status === 201 || older90Res.status === 200, `45d-old log failed: ${older90Res.text}`);

      const adhRes = await api.get('/api/v1/members/member_wife/adherence');
      assert.equal(adhRes.status, 200, `GET adherence expected 200: ${adhRes.text}`);
      assertNoStore(adhRes, 'GET adherence');
      const adherence = unwrapData(adhRes.json, ['adherence']);
      assert.ok(adherence && typeof adherence === 'object', `Adherence response must be an object: ${adhRes.text}`);

      const w7 = extractAdherenceWindow(adherence, 7);
      const w30 = extractAdherenceWindow(adherence, 30);
      const w90 = extractAdherenceWindow(adherence, 90);

      assert.ok(w7, `Adherence response missing 7-day window: ${adhRes.text}`);
      assert.ok(w30, `Adherence response missing 30-day window: ${adhRes.text}`);
      assert.ok(w90, `Adherence response missing 90-day window: ${adhRes.text}`);

      assert.equal(w7.taken, 2, `7d taken must be 2 (excluding skipped), got: ${JSON.stringify(w7.raw)}`);
      if (w7.skipped !== undefined) {
        assert.equal(w7.skipped, 1, `7d skipped must be 1, got: ${JSON.stringify(w7.raw)}`);
      }
      assert.equal(w30.taken, 3, `30d taken must include 15d-old log and exclude 45d-old log (total 3), got: ${JSON.stringify(w30.raw)}`);
      assert.equal(w90.taken, 4, `90d taken must include 15d-old and 45d-old logs (total 4), got: ${JSON.stringify(w90.raw)}`);

      // Adherence rate must be numeric, finite, > 0, and strictly below 100% because 1 dose was skipped
      assert.equal(typeof w7.rate, 'number', `7d adherence rate must be numeric: ${JSON.stringify(w7.raw)}`);
      assert.ok(Number.isFinite(w7.rate) && w7.rate > 0, `7d rate must be > 0, got ${w7.rate}`);
      if (w7.rate <= 1) {
        assert.ok(w7.rate < 1, `7d fractional rate with 1 skipped dose must be < 1, got ${w7.rate}`);
      } else {
        assert.ok(w7.rate < 100, `7d percentage rate with 1 skipped dose must be < 100, got ${w7.rate}`);
      }
    });
  });

  it('T4: Conflict-safe Sync read/write with If-Match / _rev increments _rev and preserves LWW edits & tombstones', async () => {
    await withServer(async ({ api }) => {
      const keeper = await createCompound(
        api,
        fixtures.makePeptideCompound({ name: 'Sync Keeper Peptide', canonicalMolecule: 'sync-keeper' }),
      );
      const doomed = await createCompound(
        api,
        fixtures.makeSupplementCompound({ name: 'Sync Tombstone Target', canonicalMolecule: 'sync-tombstone' }),
      );

      // Delete doomed compound so a tombstone is created
      const delRes = await api.del(`/api/v1/compounds/${encodeURIComponent(doomed.id)}`);
      assert.ok(delRes.status === 200 || delRes.status === 204, `DELETE doomed compound failed: ${delRes.text}`);

      const pull1 = await api.get('/api/v1/sync');
      assert.equal(pull1.status, 200, `GET /api/v1/sync expected 200: ${pull1.text}`);
      assertNoStore(pull1, 'GET /api/v1/sync');

      const rev1 = extractRev(pull1);
      assert.ok(typeof rev1 === 'number' && rev1 >= 0, `GET /api/v1/sync must expose numeric _rev, got: ${pull1.text}`);
      const etag1 = pull1.headers.get('etag');

      const pulledState = getSyncStateContainer(pull1.json);
      assert.ok(
        Array.isArray(pulledState?.compounds),
        `Sync state must contain compounds array: ${pull1.text}`,
      );
      const pushPayload = structuredClone(pulledState);

      const targetCmp = pushPayload.compounds.find((c) => c.id === keeper.id);
      assert.ok(targetCmp, 'Sync pull must include Sync Keeper Peptide');
      assert.ok(
        !pushPayload.compounds.some((c) => c.id === doomed.id),
        'Deleted compound must not be live in sync pull',
      );

      // Apply newer LWW edit
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      targetCmp.notes = 'Updated via LWW cloud sync push';
      targetCmp.updatedAt = futureIso;
      pushPayload._rev = rev1;

      const pushRes = await api.post('/api/v1/sync', pushPayload, {
        headers: { 'If-Match': etag1 || `"${rev1}"` },
      });
      assert.equal(pushRes.status, 200, `POST /api/v1/sync expected 200, got ${pushRes.status}: ${pushRes.text}`);
      assertNoStore(pushRes, 'POST /api/v1/sync');

      const rev2 = extractRev(pushRes);
      assert.ok(
        typeof rev2 === 'number' && rev2 > rev1,
        `POST /api/v1/sync must increment _rev (before=${rev1}, after=${rev2}): ${pushRes.text}`,
      );

      // Pull again to verify persisted revision, LWW note, and non-resurrection of tombstoned compound
      const pull2 = await api.get('/api/v1/sync');
      assert.equal(pull2.status, 200);
      assert.equal(extractRev(pull2), rev2, 'Subsequent GET /api/v1/sync must reflect incremented _rev');
      const state2 = getSyncStateContainer(pull2.json);
      const updatedKeeper = state2.compounds.find((c) => c.id === keeper.id);
      assert.ok(updatedKeeper, 'Keeper compound must remain present after sync');
      assert.equal(updatedKeeper.notes, 'Updated via LWW cloud sync push');
      assert.ok(
        !state2.compounds.some((c) => c.id === doomed.id),
        'Deleted tombstoned compound must NEVER resurrect on sync',
      );
    });
  });

  it('T5: Automatic daily snapshot creation on write & point-in-time restore rolls back post-snapshot writes', async () => {
    await withServer(async ({ api }) => {
      // Write #1 triggers today's automatic daily snapshot
      await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Baseline Snapshot Peptide',
          canonicalMolecule: 'baseline-snapshot-peptide',
        }),
      );

      const snapListRes = await api.get('/api/v1/snapshots');
      assert.equal(snapListRes.status, 200, `GET /api/v1/snapshots expected 200: ${snapListRes.text}`);
      assertNoStore(snapListRes, 'GET /api/v1/snapshots');
      const snapshots = unwrapData(snapListRes.json, ['snapshots']);
      assert.ok(
        Array.isArray(snapshots) && snapshots.length >= 1,
        `Expected >= 1 automatic daily snapshot after Write #1, got: ${snapListRes.text}`,
      );

      const dateKeys = snapshots
        .map(extractSnapshotDateKey)
        .filter((k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k));
      assert.ok(
        dateKeys.length >= 1,
        `Snapshots list must contain a valid YYYY-MM-DD dateKey, got: ${snapListRes.text}`,
      );
      const todayKey = dateKeys.sort().at(-1);

      // Write #2 occurs strictly AFTER today's snapshot already exists
      const postSnapshotCmp = await createCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'Post-Snapshot Accidental Compound',
          canonicalMolecule: 'post-snapshot-accidental',
        }),
      );

      const beforeRestoreRes = await api.get('/api/v1/compounds');
      assert.equal(beforeRestoreRes.status, 200);
      const beforeCompounds = unwrapData(beforeRestoreRes.json, ['compounds']);
      assert.ok(
        beforeCompounds.some((c) => c.id === postSnapshotCmp.id),
        'Post-snapshot compound must exist prior to restore',
      );

      // Restore to today's snapshot
      const restoreRes = await api.post(`/api/v1/snapshots/${encodeURIComponent(todayKey)}/restore`, {});
      assert.equal(
        restoreRes.status,
        200,
        `POST /api/v1/snapshots/${todayKey}/restore expected 200, got ${restoreRes.status}: ${restoreRes.text}`,
      );
      assertNoStore(restoreRes, 'POST snapshot restore');

      // Verify post-snapshot write #2 was rolled back cleanly
      const afterRestoreRes = await api.get('/api/v1/compounds');
      assert.equal(afterRestoreRes.status, 200);
      const afterCompounds = unwrapData(afterRestoreRes.json, ['compounds']);
      assert.ok(
        !afterCompounds.some((c) => c.id === postSnapshotCmp.id),
        `Post-snapshot compound must be rolled back after restoring snapshot ${todayKey}`,
      );
    });
  });

  it('T6: Full Hub JSON export (home-pharmacy-export/v1) & round-trip re-import into a fresh isolated server', async () => {
    let exportedHubJson = null;
    let bpcId = null;
    let magId = null;
    let stackId = null;
    let logId = null;

    await withServer(async ({ api }) => {
      const renameRes = await api.patch('/api/v1/members/member_wife', { name: 'Spouse Alpha' });
      assert.equal(renameRes.status, 200, `PATCH member_wife failed: ${renameRes.text}`);

      const bpc = await createCompound(api, fixtures.makePeptideCompound());
      const mag = await createCompound(api, fixtures.makeSupplementCompound());
      bpcId = bpc.id;
      magId = mag.id;

      const ownRes = await api.put(`/api/v1/ownership/${encodeURIComponent(bpc.id)}`, {
        scope: 'household',
        status: 'have',
        quantity: 3,
      });
      assert.ok(ownRes.status === 200 || ownRes.status === 201);

      const stackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Roundtrip Export Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: bpc.id, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: mag.id, doseAmount: 200, doseUnit: 'mg' }),
          ],
        }),
      );
      assert.ok(stackRes.status === 201 || stackRes.status === 200);
      stackId = unwrapData(stackRes.json, ['stack'])?.id ?? null;

      const logRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      assert.ok(logRes.status === 201 || logRes.status === 200);
      logId = unwrapData(logRes.json, ['log', 'entry', 'record'])?.id ?? null;

      const exportRes = await api.get('/api/v1/export/hub.json');
      assert.equal(exportRes.status, 200, `GET /api/v1/export/hub.json expected 200: ${exportRes.text}`);
      assertNoStore(exportRes, 'GET /api/v1/export/hub.json');
      assert.match(exportRes.headers.get('content-type') || '', /application\/json/i);

      exportedHubJson = unwrapData(exportRes.json);
      assert.ok(exportedHubJson && typeof exportedHubJson === 'object');
      assert.equal(
        exportedHubJson._format,
        'home-pharmacy-export/v1',
        `Export envelope must declare _format="home-pharmacy-export/v1", got: ${exportedHubJson._format}`,
      );
    });

    // Re-import into a completely fresh second server instance (or cleanly reset shared external target)
    await withServer(async ({ server: targetServer, api: targetApi }) => {
      const preCompounds = unwrapData((await targetApi.get('/api/v1/compounds')).json, ['compounds']);
      if (!targetServer.external) {
        assert.ok(
          !preCompounds.some((c) => c.id === bpcId),
          'Fresh managed target server must start without source compounds',
        );
      } else if (preCompounds.some((c) => c.id === bpcId)) {
        // Non-resetting single external server (--base-url / E2E_BASE_URL): clear exported entities before verifying round-trip import
        if (logId) {
          const delLogRes = await targetApi.del(
            `/api/v1/members/member_wife/logs/${encodeURIComponent(logId)}`,
          );
          assert.ok(
            delLogRes.status === 200 || delLogRes.status === 204,
            `External target pre-import log cleanup expected 200/204, got ${delLogRes.status}: ${delLogRes.text}`,
          );
        }
        if (stackId) {
          const delStackRes = await targetApi.del(
            `/api/v1/members/member_wife/stacks/${encodeURIComponent(stackId)}`,
          );
          assert.ok(
            delStackRes.status === 200 || delStackRes.status === 204,
            `External target pre-import stack cleanup expected 200/204, got ${delStackRes.status}: ${delStackRes.text}`,
          );
        }
        const resetOwnRes = await targetApi.put(`/api/v1/ownership/${encodeURIComponent(bpcId)}`, {
          scope: 'household',
          status: 'dont_have',
        });
        assert.ok(
          resetOwnRes.status === 200 || resetOwnRes.status === 201,
          `External target pre-import ownership reset expected 200/201, got ${resetOwnRes.status}: ${resetOwnRes.text}`,
        );
        for (const cid of [bpcId, magId]) {
          if (!cid) continue;
          const delCmpRes = await targetApi.del(`/api/v1/compounds/${encodeURIComponent(cid)}`);
          assert.ok(
            delCmpRes.status === 200 || delCmpRes.status === 204,
            `External target pre-import compound cleanup (${cid}) expected 200/204, got ${delCmpRes.status}: ${delCmpRes.text}`,
          );
        }
        const revertWifeRes = await targetApi.patch('/api/v1/members/member_wife', { name: 'Wife' });
        assert.equal(
          revertWifeRes.status,
          200,
          `External target pre-import member_wife revert expected 200, got ${revertWifeRes.status}: ${revertWifeRes.text}`,
        );

        const afterResetCompounds = unwrapData(
          (await targetApi.get('/api/v1/compounds')).json,
          ['compounds'],
        );
        assert.ok(
          !afterResetCompounds.some((c) => c.id === bpcId),
          'External target server must not contain bpcId after pre-import cleanup',
        );
        assert.ok(
          !afterResetCompounds.some((c) => c.id === magId),
          'External target server must not contain magId after pre-import cleanup',
        );
      }

      const importRes = await targetApi.post('/api/v1/import/hub', exportedHubJson);
      assert.ok(
        importRes.status === 200 || importRes.status === 201,
        `POST /api/v1/import/hub expected 200/201, got ${importRes.status}: ${importRes.text}`,
      );
      assertNoStore(importRes, 'POST /api/v1/import/hub');

      const members = unwrapData((await targetApi.get('/api/v1/members')).json, ['members']);
      const wife = members.find((m) => m.id === 'member_wife');
      assert.ok(wife && wife.name === 'Spouse Alpha', `Imported member name mismatch: ${JSON.stringify(members)}`);

      const compounds = unwrapData((await targetApi.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(compounds.some((c) => c.id === bpcId || c.name === 'BPC-157'), 'BPC-157 must round-trip');
      assert.ok(compounds.some((c) => c.id === magId || c.name === 'Magnesium Glycinate'), 'Magnesium Glycinate must round-trip');

      const ownerships = unwrapData((await targetApi.get('/api/v1/ownership')).json, ['ownership', 'ownerships']);
      assert.ok(
        ownerships.some((o) => o.compoundId === bpcId && o.status === 'have'),
        `BPC-157 ownership must round-trip: ${JSON.stringify(ownerships)}`,
      );

      const stacks = unwrapData((await targetApi.get('/api/v1/members/member_wife/stacks')).json, ['stacks']);
      assert.ok(
        stacks.some((s) => s.name === 'Roundtrip Export Stack'),
        `Stack must round-trip: ${JSON.stringify(stacks)}`,
      );

      const logs = unwrapData((await targetApi.get('/api/v1/members/member_wife/logs')).json, ['logs', 'entries']);
      assert.ok(
        logs.some((l) => l.compoundId === bpcId && extractLogDose(l) === 250),
        `Dose log must round-trip: ${JSON.stringify(logs)}`,
      );
    });
  });

  it('T7: Lossless protocol-os-export/v1 import maps peptides, blends, vials, protocols & logs into canonical entities', async () => {
    await withServer(async ({ api }) => {
      const legacyExport = fixtures.makeProtocolOsExport();
      const importRes = await api.post('/api/v1/import/protocol-os', legacyExport);
      assert.ok(
        importRes.status === 200 || importRes.status === 201,
        `POST /api/v1/import/protocol-os expected 200/201, got ${importRes.status}: ${importRes.text}`,
      );
      assertNoStore(importRes, 'POST /api/v1/import/protocol-os');

      const cmpRes = await api.get('/api/v1/compounds', { query: { section: 'peptides' } });
      assert.equal(cmpRes.status, 200);
      const peptides = unwrapData(cmpRes.json, ['compounds']);
      assert.ok(Array.isArray(peptides) && peptides.length >= 3, `Expected >= 3 imported peptides, got: ${cmpRes.text}`);

      const findByName = (pattern) => peptides.find((c) => pattern.test(c.name || ''));
      const bpc = findByName(/bpc-157/i);
      const blend = findByName(/wolverine/i);
      const ipa = findByName(/ipamorelin/i);

      assert.ok(bpc, `Imported peptides must include BPC-157: ${JSON.stringify(peptides.map((p) => p.name))}`);
      assert.ok(blend, `Imported peptides must include Wolverine blend: ${JSON.stringify(peptides.map((p) => p.name))}`);
      assert.ok(ipa, `Imported peptides must include Ipamorelin: ${JSON.stringify(peptides.map((p) => p.name))}`);

      for (const p of [bpc, blend, ipa]) {
        assert.equal(p.sectionId, 'peptides');
      }

      // Verify blend preserves multi-component blend data
      const blendSerialized = JSON.stringify(blend).toLowerCase();
      assert.ok(
        blend.sectionData?.isBlend === true ||
          (Array.isArray(blend.sectionData?.blendComponents) && blend.sectionData.blendComponents.length >= 2) ||
          (blendSerialized.includes('bpc') && blendSerialized.includes('tb500')),
        `Imported Wolverine blend must preserve blend composition: ${JSON.stringify(blend)}`,
      );

      // Verify active vials created ownership records with reconstitution data preserved
      const ownRes = await api.get('/api/v1/ownership');
      assert.equal(ownRes.status, 200);
      const ownerships = unwrapData(ownRes.json, ['ownership', 'ownerships']);
      assert.ok(Array.isArray(ownerships) && ownerships.length >= 2, `Expected >= 2 vial ownership records: ${ownRes.text}`);
      const bpcOwn = ownerships.find((o) => o.compoundId === bpc.id);
      assert.ok(bpcOwn && (bpcOwn.status === 'have' || bpcOwn.status === 'low_stock'));
      const reconVialMg = bpcOwn.reconstitution?.vialMg ?? bpc.sectionData?.vialMg;
      const reconDiluentMl = bpcOwn.reconstitution?.diluentMl ?? bpc.sectionData?.diluentMl;
      assert.equal(reconVialMg, 5, 'BPC-157 vial 5mg reconstitution must be preserved');
      assert.equal(reconDiluentMl, 2, 'BPC-157 vial 2mL diluent must be preserved');

      // Verify protocols -> stacks and logs -> member logs across household members
      const members = unwrapData((await api.get('/api/v1/members')).json, ['members']);
      let totalStacks = 0;
      let totalStackItems = 0;
      let totalLogs = 0;
      let sawSkippedLog = false;

      for (const member of members) {
        const sRes = await api.get(`/api/v1/members/${encodeURIComponent(member.id)}/stacks`);
        if (sRes.status === 200) {
          const mStacks = unwrapData(sRes.json, ['stacks']);
          if (Array.isArray(mStacks)) {
            totalStacks += mStacks.length;
            for (const s of mStacks) totalStackItems += Array.isArray(s.items) ? s.items.length : 0;
          }
        }
        const lRes = await api.get(`/api/v1/members/${encodeURIComponent(member.id)}/logs`);
        if (lRes.status === 200) {
          const mLogs = unwrapData(lRes.json, ['logs', 'entries']);
          if (Array.isArray(mLogs)) {
            totalLogs += mLogs.length;
            if (mLogs.some((l) => l.skipped === true)) sawSkippedLog = true;
          }
        }
      }

      assert.ok(totalStacks >= 1 && totalStackItems >= 3, `Expected imported protocols as stack items (>=3), got stacks=${totalStacks}, items=${totalStackItems}`);
      assert.ok(totalLogs >= 2, `Expected >= 2 imported logs from protocol-os export, got ${totalLogs}`);
      assert.equal(sawSkippedLog, true, 'Imported logs must preserve skipped: true entry');
    });
  });

  it('T8: UTF-8 CSV export produces valid RFC 4180 CSV containing exported compounds and quoted special chars', async () => {
    await withServer(async ({ api }) => {
      const specialText = 'Taken fasted, "morning" protocol, sterile BAC water.';
      await createCompound(
        api,
        fixtures.makePeptideCompound({
          summary: specialText,
          notes: specialText,
        }),
      );
      await createCompound(api, fixtures.makeSupplementCompound());
      await createCompound(api, fixtures.makeDermCompound());

      const csvRes = await api.get('/api/v1/export/compounds.csv');
      assert.equal(csvRes.status, 200, `GET /api/v1/export/compounds.csv expected 200: ${csvRes.text}`);
      assertNoStore(csvRes, 'GET /api/v1/export/compounds.csv');
      assert.match(
        csvRes.headers.get('content-type') || '',
        /text\/csv/i,
        `CSV Content-Type must include text/csv, got "${csvRes.headers.get('content-type')}"`,
      );

      const rows = parseCsv(csvRes.text);
      assert.ok(rows.length >= 4, `Expected header + >= 3 compound rows, got ${rows.length} rows`);

      const header = rows[0];
      assert.ok(header.length >= 3, `CSV header must have >= 3 columns, got: ${JSON.stringify(header)}`);
      for (let r = 1; r < rows.length; r++) {
        assert.equal(
          rows[r].length,
          header.length,
          `RFC 4180 violation: row ${r} has ${rows[r].length} columns, expected ${header.length}`,
        );
      }

      const dataRows = rows.slice(1);
      const findRowContaining = (text) => dataRows.find((r) => r.some((cell) => cell.includes(text)));

      const bpcRow = findRowContaining('BPC-157');
      const magRow = findRowContaining('Magnesium Glycinate');
      const tretRow = findRowContaining('Tretinoin 0.05% Cream');

      assert.ok(bpcRow, 'CSV must contain BPC-157 row');
      assert.ok(magRow, 'CSV must contain Magnesium Glycinate row');
      assert.ok(tretRow, 'CSV must contain Tretinoin 0.05% Cream row');

      assert.ok(bpcRow.some((c) => c.includes('peptides')), 'BPC-157 row must include section peptides');
      assert.ok(
        bpcRow.some((c) => c.includes(specialText)),
        `Quoted comma/double-quote summary/notes must round-trip cleanly through RFC 4180 CSV: ${JSON.stringify(bpcRow)}`,
      );
      assert.ok(magRow.some((c) => c.includes('vitamins_supplements')));
      assert.ok(tretRow.some((c) => c.includes('dermatology')));
    });
  });

  it('T9: Markdown & JSON AI Context export reflects active stack, logs & supports section/member filtering', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(api, fixtures.makePeptideCompound());
      const tret = await createCompound(api, fixtures.makeDermCompound());

      const stackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Context Bundle Daily Stack',
          memberId: 'member_wife',
          items: [
            fixtures.makeStackItem({ compoundId: bpc.id, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: tret.id, doseAmount: 1, doseUnit: 'pea_size' }),
          ],
        }),
      );
      assert.ok(stackRes.status === 201 || stackRes.status === 200);

      const husbandStackRes = await api.post(
        '/api/v1/members/member_husband/stacks',
        fixtures.makeStackPayload({
          name: 'Husband Context Only Stack',
          memberId: 'member_husband',
          items: [fixtures.makeStackItem({ compoundId: bpc.id, doseAmount: 300, doseUnit: 'mcg' })],
        }),
      );
      assert.ok(husbandStackRes.status === 201 || husbandStackRes.status === 200);

      const logRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      assert.ok(
        logRes.status === 201 || logRes.status === 200,
        `Setup POST log expected 200/201, got ${logRes.status}: ${logRes.text}`,
      );

      // Full Markdown Context Bundle
      const mdRes = await api.get('/api/v1/export/context.md');
      assert.equal(mdRes.status, 200, `GET /api/v1/export/context.md expected 200: ${mdRes.text}`);
      assertNoStore(mdRes, 'GET /api/v1/export/context.md');
      assert.match(mdRes.headers.get('content-type') || '', /text\/(markdown|plain)/i);
      assert.ok(mdRes.text.includes('#'), 'Markdown context bundle must contain Markdown headings');
      assert.ok(mdRes.text.includes('BPC-157'), 'context.md must include BPC-157');
      assert.ok(mdRes.text.includes('Tretinoin 0.05% Cream'), 'context.md must include Tretinoin 0.05% Cream');
      assert.ok(
        mdRes.text.includes('Context Bundle Daily Stack') || /wife/i.test(mdRes.text),
        'context.md must reflect active stack/member context',
      );

      // Section-filtered Markdown Context Bundle
      const filteredMdRes = await api.get('/api/v1/export/context.md', {
        query: { section: 'peptides' },
      });
      assert.equal(filteredMdRes.status, 200);
      assert.ok(filteredMdRes.text.includes('BPC-157'), 'Section-filtered context.md must retain peptides');
      assert.ok(
        !filteredMdRes.text.includes('Tretinoin 0.05% Cream'),
        'Section-filtered context.md?section=peptides must exclude dermatology compounds',
      );

      // Member-filtered Markdown Context Bundle
      const memberMdRes = await api.get('/api/v1/export/context.md', {
        query: { member: 'member_wife' },
      });
      assert.equal(memberMdRes.status, 200);
      assert.ok(
        memberMdRes.text.includes('Context Bundle Daily Stack') || /wife/i.test(memberMdRes.text),
        'Member-filtered context.md?member=member_wife must include Wife stack/context',
      );
      assert.ok(
        !memberMdRes.text.includes('Husband Context Only Stack'),
        'Member-filtered context.md?member=member_wife must exclude Husband-only stack',
      );

      // Full JSON Context Bundle
      const jsonRes = await api.get('/api/v1/export/context.json');
      assert.equal(jsonRes.status, 200, `GET /api/v1/export/context.json expected 200: ${jsonRes.text}`);
      assertNoStore(jsonRes, 'GET /api/v1/export/context.json');
      assert.match(jsonRes.headers.get('content-type') || '', /application\/json/i);
      assert.ok(jsonRes.json && typeof jsonRes.json === 'object');
      const serializedJson = JSON.stringify(jsonRes.json);
      assert.ok(serializedJson.includes('BPC-157'), 'context.json must include BPC-157');
      assert.ok(serializedJson.includes('Tretinoin 0.05% Cream'), 'context.json must include Tretinoin');
      assert.ok(
        serializedJson.includes('Context Bundle Daily Stack') || serializedJson.includes('member_wife'),
        'context.json must reflect active stack and member context',
      );

      // Member-filtered JSON Context Bundle
      const memberJsonRes = await api.get('/api/v1/export/context.json', {
        query: { member: 'member_wife' },
      });
      assert.equal(memberJsonRes.status, 200);
      assert.ok(memberJsonRes.json && typeof memberJsonRes.json === 'object');
      const memberJsonStr = JSON.stringify(memberJsonRes.json);
      assert.ok(memberJsonStr.includes('BPC-157'));
      assert.ok(
        !memberJsonStr.includes('Husband Context Only Stack'),
        'Member-filtered context.json?member=member_wife must exclude Husband-only stack',
      );
    });
  });

  it('T10: Web Push config & subscription lifecycle (GET config, POST subscribe, DELETE unsubscribe)', async () => {
    await withServer(async ({ api }) => {
      const cfgRes = await api.get('/api/v1/push/config');
      assert.equal(cfgRes.status, 200, `GET /api/v1/push/config expected 200: ${cfgRes.text}`);
      assertNoStore(cfgRes, 'GET /api/v1/push/config');
      assert.ok(cfgRes.json && typeof cfgRes.json === 'object', `Push config must be JSON object: ${cfgRes.text}`);
      const cfg = unwrapData(cfgRes.json, ['config', 'pushConfig', 'push']);
      assert.ok(
        typeof cfg.enabled === 'boolean' ||
          Object.prototype.hasOwnProperty.call(cfg, 'publicKey') ||
          Object.prototype.hasOwnProperty.call(cfg, 'vapidPublicKey'),
        `Push config must expose enabled/publicKey properties: ${cfgRes.text}`,
      );

      const endpoint = `https://push.example.test/wp/e2e-sub-${crypto.randomBytes(6).toString('hex')}`;
      const keys = generateWebPushKeys();

      const subRes = await api.post('/api/v1/push/subscribe', {
        memberId: 'member_wife',
        endpoint,
        keys,
        subscription: { endpoint, keys },
        preferences: {
          slots: ['waking_fasted', 'bedtime_fasted'],
          tz: 'UTC',
        },
      });
      assert.ok(
        subRes.status === 200 || subRes.status === 201,
        `POST /api/v1/push/subscribe expected 200/201, got ${subRes.status}: ${subRes.text}`,
      );
      assertNoStore(subRes, 'POST /api/v1/push/subscribe');
      assert.ok(subRes.json && typeof subRes.json === 'object');

      const subId = subRes.json?.id ?? subRes.json?.subscription?.id ?? subRes.json?.data?.id;

      // Remember api.del 2-arg signature takes opts ({ body, query, headers })
      const unsubRes = await api.del('/api/v1/push/subscribe', {
        body: {
          endpoint,
          memberId: 'member_wife',
          ...(subId ? { id: subId } : {}),
        },
        query: { endpoint },
      });
      assert.ok(
        unsubRes.status === 200 || unsubRes.status === 204,
        `DELETE /api/v1/push/subscribe expected 200/204, got ${unsubRes.status}: ${unsubRes.text}`,
      );
      assertNoStore(unsubRes, 'DELETE /api/v1/push/subscribe');
    });
  });
});
