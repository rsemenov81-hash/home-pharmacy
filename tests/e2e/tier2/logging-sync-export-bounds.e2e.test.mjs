/**
 * Tier 2 E2E Suite — Area E: Dose-Sanity Gate Boundaries, IU Dimension Isolation,
 * Sync Optimistic Concurrency (409), Snapshot Errors, CSV Formula Injection
 * Neutralization, Invalid Import Refusal, Secret Hygiene, Member Isolation & Push Bounds.
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
  runOAuthFlow,
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

function extractRev(res) {
  const j = res.json;
  const rawCandidates = [
    j?._rev,
    j?.rev,
    j?.currentRev,
    j?.serverRev,
    j?.data?._rev,
    j?.data?.rev,
    j?.data?.currentRev,
    j?.data?.serverRev,
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
        };
      }
    }
  }
  return null;
}

function extractMintedKeySecret(rawJson, unwrapped) {
  const sources = [rawJson, rawJson?.data, rawJson?.data?.key, unwrapped].filter(
    (s) => s && typeof s === 'object',
  );
  const idVal = unwrapped?.id ?? rawJson?.id ?? rawJson?.key?.id ?? rawJson?.data?.id ?? null;
  for (const src of sources) {
    for (const field of ['secret', 'rawKey', 'plainKey', 'rawSecret', 'token', 'apiKey', 'key']) {
      const val = src[field];
      if (typeof val === 'string' && val.length >= 16 && val !== idVal) {
        return val;
      }
    }
  }
  return null;
}

function extractLogDose(log) {
  return log?.dose ?? log?.doseAmount ?? log?.amount ?? log?.doseValue;
}

function extractLogUnit(log) {
  return log?.unit ?? log?.doseUnit;
}

function generateWebPushKeys() {
  const p256dh = Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]).toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  return { p256dh, auth };
}

describe('Tier 2 — Area E: Logging, Sync, Snapshots, Export Hygiene & Push Boundaries', () => {
  it('T1: Advisory Dose-Sanity Gate allows & flags >=5x jump, unit switch, and ceiling breach independently while hard-blocking <=0/missing doses', async () => {
    await withServer(async ({ api }) => {
      // Dedicated compounds isolate each advisory rule so no rule can mask a missing check in another
      const bpcJump = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'BPC-157 Jump Probe',
          canonicalMolecule: 'bpc-157-jump-probe',
          aliases: ['JumpProbe'],
          dosages: {
            rangeText: '100-500 mcg daily',
            defaultAmount: 100,
            defaultUnit: 'mcg',
            route: 'SubQ',
            frequencyText: 'Daily',
            maxCeiling: 1000,
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const bpcUnit = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'BPC-157 Unit Probe',
          canonicalMolecule: 'bpc-157-unit-probe',
          aliases: ['UnitProbe'],
          dosages: {
            rangeText: '250-500 mcg daily',
            defaultAmount: 250,
            defaultUnit: 'mcg',
            route: 'SubQ',
            frequencyText: 'Daily',
            maxCeiling: 1000,
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const bpcCeiling = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'BPC-157 Ceiling Probe',
          canonicalMolecule: 'bpc-157-ceiling-probe',
          aliases: ['CeilingProbe'],
          dosages: {
            rangeText: '250-500 mcg daily',
            defaultAmount: 400,
            defaultUnit: 'mcg',
            route: 'SubQ',
            frequencyText: 'Daily',
            maxCeiling: 1000,
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const t0 = Date.now() - 4 * 3_600_000;

      // Advisory 1 (isolated >=5x jump): 100 mcg -> 600 mcg (same unit 'mcg', < ceiling 1000)
      const jumpBase = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcJump.id,
        dose: 100,
        doseAmount: 100,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(t0).toISOString(),
        skipped: false,
      });
      assert.ok(jumpBase.status === 201 || jumpBase.status === 200, `Jump baseline failed: ${jumpBase.text}`);
      const jumpBaseLog = unwrapData(jumpBase.json, ['log', 'entry', 'record']);
      assert.equal(
        extractSanityInfo(jumpBase.json, jumpBaseLog).isFlagged,
        false,
        `Normal 100 mcg baseline dose must pass cleanly without advisory flag: ${jumpBase.text}`,
      );

      const jumpRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcJump.id,
        dose: 600,
        doseAmount: 600,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(t0 + 3_600_000).toISOString(),
        skipped: false,
      });
      assert.ok(
        jumpRes.status === 201 || jumpRes.status === 200,
        `>=5x dose jump must be ALLOWED (advisory only), got ${jumpRes.status}: ${jumpRes.text}`,
      );
      const jumpLog = unwrapData(jumpRes.json, ['log', 'entry', 'record']);
      assert.equal(
        extractSanityInfo(jumpRes.json, jumpLog).isFlagged,
        true,
        `>=5x dose jump must be flagged with needsReview/CONFIRM/warning: ${jumpRes.text}`,
      );

      // Advisory 2 (isolated unit switch): 250 mcg -> 0.5 mg (2x mass < 5x, <= ceiling, unit switched mcg -> mg)
      const unitBase = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcUnit.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(t0).toISOString(),
        skipped: false,
      });
      assert.ok(unitBase.status === 201 || unitBase.status === 200, `Unit baseline failed: ${unitBase.text}`);
      const unitBaseLog = unwrapData(unitBase.json, ['log', 'entry', 'record']);
      assert.equal(
        extractSanityInfo(unitBase.json, unitBaseLog).isFlagged,
        false,
        `Normal 250 mcg baseline dose must pass cleanly without advisory flag: ${unitBase.text}`,
      );

      const unitSwitchRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcUnit.id,
        dose: 0.5,
        doseAmount: 0.5,
        unit: 'mg',
        doseUnit: 'mg',
        takenAt: new Date(t0 + 2 * 3_600_000).toISOString(),
        skipped: false,
      });
      assert.ok(
        unitSwitchRes.status === 201 || unitSwitchRes.status === 200,
        `Unit switch (mcg->mg) must be ALLOWED (advisory only), got ${unitSwitchRes.status}: ${unitSwitchRes.text}`,
      );
      const unitSwitchLog = unwrapData(unitSwitchRes.json, ['log', 'entry', 'record']);
      assert.equal(
        extractSanityInfo(unitSwitchRes.json, unitSwitchLog).isFlagged,
        true,
        `Unit switch (mcg->mg) must be flagged with needsReview/CONFIRM/warning: ${unitSwitchRes.text}`,
      );

      // Advisory 3 (isolated ceiling breach): 400 mcg -> 1200 mcg (same unit 'mcg', 3x < 5x, > maxCeiling 1000)
      const ceilingBase = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcCeiling.id,
        dose: 400,
        doseAmount: 400,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(t0).toISOString(),
        skipped: false,
      });
      assert.ok(ceilingBase.status === 201 || ceilingBase.status === 200, `Ceiling baseline failed: ${ceilingBase.text}`);
      const ceilingBaseLog = unwrapData(ceilingBase.json, ['log', 'entry', 'record']);
      assert.equal(
        extractSanityInfo(ceilingBase.json, ceilingBaseLog).isFlagged,
        false,
        `Normal 400 mcg baseline dose must pass cleanly without advisory flag: ${ceilingBase.text}`,
      );

      const ceilingRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpcCeiling.id,
        dose: 1200,
        doseAmount: 1200,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(t0 + 3 * 3_600_000).toISOString(),
        skipped: false,
      });
      assert.ok(
        ceilingRes.status === 201 || ceilingRes.status === 200,
        `Ceiling breach must be ALLOWED (advisory only), got ${ceilingRes.status}: ${ceilingRes.text}`,
      );
      const ceilingLog = unwrapData(ceilingRes.json, ['log', 'entry', 'record']);
      assert.equal(
        extractSanityInfo(ceilingRes.json, ceilingLog).isFlagged,
        true,
        `Ceiling breach (1200 > 1000 mcg) must be flagged with needsReview/CONFIRM/warning: ${ceilingRes.text}`,
      );

      // Confirm all 6 allowed logs (3 baselines + 3 isolated advisory-flagged logs) persisted
      const afterAdvisoryLogs = unwrapData(
        (await api.get('/api/v1/members/member_wife/logs')).json,
        ['logs', 'entries'],
      );
      assert.equal(afterAdvisoryLogs.length, 6, 'All 6 allowed logs (3 baselines + 3 advisory warnings) must persist');

      // Hard-blocks: zero, negative, and missing dose (when skipped !== true) -> 400 or 422
      const invalidPayloads = [
        { label: 'zero dose', body: { compoundId: bpcJump.id, dose: 0, doseAmount: 0, unit: 'mcg', doseUnit: 'mcg', skipped: false } },
        { label: 'negative dose', body: { compoundId: bpcJump.id, dose: -25, doseAmount: -25, unit: 'mcg', doseUnit: 'mcg', skipped: false } },
        { label: 'missing dose', body: { compoundId: bpcJump.id, unit: 'mcg', doseUnit: 'mcg', skipped: false } },
      ];
      for (const { label, body } of invalidPayloads) {
        const res = await api.post('/api/v1/members/member_wife/logs', body);
        assert.ok(
          res.status === 400 || res.status === 422,
          `Hard-block (${label}) must return 400 or 422, got ${res.status}: ${res.text}`,
        );
      }

      // Confirm rejected logs were NOT persisted
      const afterHardBlockLogs = unwrapData(
        (await api.get('/api/v1/members/member_wife/logs')).json,
        ['logs', 'entries'],
      );
      assert.equal(
        afterHardBlockLogs.length,
        6,
        'Hard-blocked zero/negative/missing doses must NEVER be persisted',
      );
    });
  });

  it('T2: IU vs mg/mcg dimension isolation preserves exact fractional 12.5 IU HCG without mass conversion', async () => {
    await withServer(async ({ api }) => {
      const hcg = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'HCG (Human Chorionic Gonadotropin)',
          canonicalMolecule: 'hcg',
          aliases: ['Choriogonadotropin alfa'],
          tags: ['peptide', 'gonadotropin', 'iu_dosed'],
          dosages: {
            rangeText: '250-500 IU 2x/week',
            defaultAmount: 250,
            defaultUnit: 'IU',
            route: 'SubQ',
            frequencyText: 'Twice weekly',
            maxCeiling: 1500,
          },
          sectionData: {
            form: 'lyophilized',
            vialMg: null,
            vialIU: 5000,
            diluentMl: 2,
            solvent: 'BAC',
            isBlend: false,
            blendComponents: [],
          },
          doNotPairWith: [],
          synergies: [],
        }),
      );

      const postRes = await api.post('/api/v1/members/member_husband/logs', {
        compoundId: hcg.id,
        dose: 12.5,
        doseAmount: 12.5,
        unit: 'IU',
        doseUnit: 'IU',
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      assert.ok(
        postRes.status === 201 || postRes.status === 200,
        `Logging 12.5 IU HCG expected 200/201, got ${postRes.status}: ${postRes.text}`,
      );
      const createdLog = unwrapData(postRes.json, ['log', 'entry', 'record']);
      assert.ok(createdLog && typeof createdLog.id === 'string');

      const listRes = await api.get('/api/v1/members/member_husband/logs');
      assert.equal(listRes.status, 200);
      const logs = unwrapData(listRes.json, ['logs', 'entries']);
      const stored = logs.find((l) => l.id === createdLog.id);
      assert.ok(stored, 'Fractional IU log must be stored and retrievable');
      assert.equal(
        extractLogDose(stored),
        12.5,
        `Fractional 12.5 IU must be preserved without rounding or x1000 mass conversion, got ${extractLogDose(stored)}`,
      );
      assert.equal(
        extractLogUnit(stored),
        'IU',
        `IU unit must NEVER be coerced into mg or mcg, got ${extractLogUnit(stored)}`,
      );
    });
  });

  it('T3: Sync optimistic concurrency conflict returns 409 with current server revision and never overwrites newer writes', async () => {
    await withServer(async ({ api }) => {
      const anchor = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Sync Concurrency Peptide',
          canonicalMolecule: 'sync-concurrency-peptide',
        }),
      );

      // Both Client A and Client B pull at revision R1
      const pullA = await api.get('/api/v1/sync');
      assert.equal(pullA.status, 200);
      const rev1 = extractRev(pullA);
      const etag1 = pullA.headers.get('etag');
      assert.ok(typeof rev1 === 'number', `GET /api/v1/sync must return numeric revision: ${pullA.text}`);

      const pulledState = getSyncStateContainer(pullA.json);
      assert.ok(Array.isArray(pulledState?.compounds), `Sync pull must include compounds: ${pullA.text}`);
      const payloadA = structuredClone(pulledState);
      const payloadB = structuredClone(pulledState);

      // Client A commits first with valid If-Match / _rev = rev1
      const cmpA = payloadA.compounds.find((c) => c.id === anchor.id);
      assert.ok(cmpA);
      cmpA.notes = 'Client A authoritative commit';
      cmpA.updatedAt = new Date(Date.now() + 60_000).toISOString();
      payloadA._rev = rev1;

      const pushA = await api.post('/api/v1/sync', payloadA, {
        headers: { 'If-Match': etag1 || `"${rev1}"` },
      });
      assert.equal(pushA.status, 200, `Client A sync push expected 200, got ${pushA.status}: ${pushA.text}`);
      const rev2 = extractRev(pushA);
      assert.ok(typeof rev2 === 'number' && rev2 > rev1, `Client A push must advance rev (${rev1} -> ${rev2})`);

      // Client B tries to push with STALE If-Match / _rev = rev1
      const cmpB = payloadB.compounds.find((c) => c.id === anchor.id);
      assert.ok(cmpB);
      cmpB.notes = 'Client B stale clobber attempt';
      cmpB.updatedAt = new Date(Date.now() + 120_000).toISOString();
      payloadB._rev = rev1;

      const pushB = await api.post('/api/v1/sync', payloadB, {
        headers: { 'If-Match': etag1 || `"${rev1}"` },
      });
      assert.equal(
        pushB.status,
        409,
        `Stale sync push MUST return 409 Conflict, got ${pushB.status}: ${pushB.text}`,
      );
      assertNoStore(pushB, 'POST /api/v1/sync conflict');

      const reportedServerRev = extractRev(pushB);
      assert.equal(
        reportedServerRev,
        rev2,
        `409 Conflict response must report current server revision (${rev2}), got ${reportedServerRev}: ${pushB.text}`,
      );

      // Confirm Client A's state was NEVER overwritten by stale Client B push
      const verifyPull = await api.get('/api/v1/sync');
      assert.equal(verifyPull.status, 200);
      assert.equal(extractRev(verifyPull), rev2);
      const verifiedCmp = getSyncStateContainer(verifyPull.json).compounds.find((c) => c.id === anchor.id);
      assert.equal(
        verifiedCmp.notes,
        'Client A authoritative commit',
        'Newer server write must survive rejected stale sync push intact',
      );
    });
  });

  it('T4: Snapshot restore boundary errors return 400 on malformed dateKey and 404 on nonexistent snapshot without mutating live state', async () => {
    await withServer(async ({ api }) => {
      const guardian = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Snapshot Guardian Compound',
          canonicalMolecule: 'snapshot-guardian',
        }),
      );

      for (const badDate of ['not-a-date', '2026-99-99', '2026-1-5', '20261121']) {
        const res = await api.post(`/api/v1/snapshots/${encodeURIComponent(badDate)}/restore`, {});
        assert.equal(
          res.status,
          400,
          `Malformed snapshot dateKey "${badDate}" must return 400, got ${res.status}: ${res.text}`,
        );
      }

      const missingRes = await api.post('/api/v1/snapshots/1999-01-01/restore', {});
      assert.equal(
        missingRes.status,
        404,
        `Valid-format nonexistent snapshot "1999-01-01" must return 404, got ${missingRes.status}: ${missingRes.text}`,
      );

      // Confirm live household catalog was completely untouched
      const compounds = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(
        compounds.some((c) => c.id === guardian.id),
        'Live data must remain completely intact after rejected snapshot restore attempts',
      );
    });
  });

  it('T5: CSV formula-injection neutralization prefixes =, +, -, @, leading tab, and leading CR with single quote in compounds.csv', async () => {
    await withServer(async ({ api }) => {
      const vectors = [
        { slug: 'csv-eq', name: 'Formula Probe Equal', payload: '=SUM(A1:A2)' },
        { slug: 'csv-plus', name: 'Formula Probe Plus', payload: '+cmd|\' /C calc\'!A0' },
        { slug: 'csv-minus', name: 'Formula Probe Minus', payload: '-2+3' },
        { slug: 'csv-at', name: 'Formula Probe At', payload: '@IMPORTXML("https://example.test/x","//a")' },
        { slug: 'csv-tab', name: 'Formula Probe Tab', payload: '\t=1+1' },
        { slug: 'csv-cr', name: 'Formula Probe CR', payload: '\r=1' },
      ];

      const storedVectors = [];
      for (const v of vectors) {
        const created = await createCompound(
          api,
          fixtures.makeSupplementCompound({
            name: v.name,
            canonicalMolecule: v.slug,
            aliases: [v.slug],
            summary: v.payload,
            notes: v.payload,
            doNotPairWith: [],
            synergies: [],
          }),
        );
        storedVectors.push({
          ...v,
          storedNotes: typeof created.notes === 'string' ? created.notes : v.payload,
          storedSummary: typeof created.summary === 'string' ? created.summary : v.payload,
        });
      }

      const csvRes = await api.get('/api/v1/export/compounds.csv');
      assert.equal(csvRes.status, 200, `GET /api/v1/export/compounds.csv failed: ${csvRes.text}`);
      assertNoStore(csvRes, 'GET /api/v1/export/compounds.csv');
      assert.match(csvRes.headers.get('content-type') || '', /text\/csv/i);

      const rows = parseCsv(csvRes.text);
      assert.ok(rows.length >= vectors.length + 1, `Expected header + ${vectors.length} rows`);
      const header = rows[0];
      assert.ok(header.length >= 3, `CSV header must have >= 3 columns, got: ${JSON.stringify(header)}`);
      const dataRows = rows.slice(1);

      // Uniform RFC 4180 column count & zero cells beginning unescaped with a spreadsheet formula trigger
      for (let r = 0; r < dataRows.length; r++) {
        assert.equal(
          dataRows[r].length,
          header.length,
          `RFC 4180 violation: data row ${r + 1} has ${dataRows[r].length} columns, expected ${header.length}`,
        );
        for (let c = 0; c < dataRows[r].length; c++) {
          const cell = dataRows[r][c];
          assert.ok(
            !/^[=+\-@\t\r]/.test(cell),
            `Unescaped CSV formula injection found at row ${r + 1}, col ${c}: ${JSON.stringify(cell)}`,
          );
        }
      }

      // Every single attack vector must be present AND neutralized with a leading single quote "'"
      const allDataCells = dataRows.flat();
      for (const v of storedVectors) {
        const rawCandidates = [...new Set([v.storedNotes, v.storedSummary])].filter(
          (val) => typeof val === 'string' && val.length > 0,
        );
        const triggerCandidates = rawCandidates.filter((val) => /^[=+\-@\t\r]/.test(val));
        const expectedNeutralizedList = (
          triggerCandidates.length > 0 ? triggerCandidates : rawCandidates
        ).map((val) => `'${val}`);
        assert.ok(
          expectedNeutralizedList.some((expectedNeutralized) =>
            allDataCells.some(
              (cell) => cell === expectedNeutralized || cell.startsWith(expectedNeutralized),
            ),
          ),
          `CSV must contain single-quote-prefixed neutralized payload (one of ${JSON.stringify(expectedNeutralizedList)}), parsed cells: ${JSON.stringify(allDataCells)}`,
        );
      }
    });
  });

  it('T6: Invalid Hub JSON & malformed protocol-os imports are rejected (400/422) without mutating existing live data', async () => {
    await withServer(async ({ api }) => {
      const anchor = await createCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Import Guard Anchor',
          canonicalMolecule: 'import-guard-anchor',
        }),
      );
      const logRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: anchor.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      assert.ok(logRes.status === 201 || logRes.status === 200);

      // Invalid Hub JSON payloads
      const badHubPayloads = [
        { label: 'wrong _format', body: { _format: 'wrong-format/v99', compounds: [], members: [] } },
        { label: 'missing envelope structure', body: { hello: 'world' } },
      ];
      for (const { label, body } of badHubPayloads) {
        const res = await api.post('/api/v1/import/hub', body);
        assert.ok(
          res.status === 400 || res.status === 422,
          `Invalid /import/hub (${label}) must return 400/422, got ${res.status}: ${res.text}`,
        );
      }

      const rawBadHub = await api.post('/api/v1/import/hub', '{malformed-json', {
        headers: { 'content-type': 'application/json' },
      });
      assert.ok(
        rawBadHub.status === 400 || rawBadHub.status === 422,
        `Malformed raw JSON to /import/hub must return 400/422, got ${rawBadHub.status}: ${rawBadHub.text}`,
      );

      // Invalid protocol-os payloads
      const badProtocolOsPayloads = [
        { label: 'wrong _format', body: { _format: 'legacy-unknown/v0', protocols: [], vials: [], logs: [] } },
        { label: 'non-array protocols', body: { _format: 'protocol-os-export/v1', protocols: 'invalid', vials: null } },
        { label: 'junk object', body: { unexpected: 123 } },
      ];
      for (const { label, body } of badProtocolOsPayloads) {
        const res = await api.post('/api/v1/import/protocol-os', body);
        assert.ok(
          res.status === 400 || res.status === 422,
          `Invalid /import/protocol-os (${label}) must return 400/422, got ${res.status}: ${res.text}`,
        );
      }

      const rawBadProto = await api.post('/api/v1/import/protocol-os', '{broken-json', {
        headers: { 'content-type': 'application/json' },
      });
      assert.ok(
        rawBadProto.status === 400 || rawBadProto.status === 422,
        `Malformed raw JSON to /import/protocol-os must return 400/422, got ${rawBadProto.status}: ${rawBadProto.text}`,
      );

      // Verify live household data was NOT mutated or wiped
      const compoundsAfter = unwrapData((await api.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(
        compoundsAfter.some((c) => c.id === anchor.id),
        'Pre-existing compound must remain completely intact after rejected imports',
      );
      const logsAfter = unwrapData(
        (await api.get('/api/v1/members/member_wife/logs')).json,
        ['logs', 'entries'],
      );
      assert.equal(logsAfter.length, 1, 'Pre-existing dose log must remain intact after rejected imports');
    });
  });

  it('T7: Security export hygiene — zero leakage of adminToken, passcode, minted API keys, or OAuth tokens across all 4 exports + Cache-Control: no-store', async () => {
    await withServer(async ({ server, api }) => {
      const cmp = await createCompound(api, fixtures.makePeptideCompound());
      const stackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Export Hygiene Stack',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: cmp.id, doseAmount: 250, doseUnit: 'mcg' })],
        }),
      );
      assert.ok(
        stackRes.status === 201 || stackRes.status === 200,
        `Setup POST stack expected 200/201, got ${stackRes.status}: ${stackRes.text}`,
      );

      // 1. Mint a real scoped API key (secret returned ONCE)
      const mintRes = await api.post('/api/v1/keys', {
        name: 'E2E Hygiene Probe Key',
        scope: 'read',
      });
      assert.ok(
        mintRes.status === 201 || mintRes.status === 200,
        `POST /api/v1/keys expected 200/201, got ${mintRes.status}: ${mintRes.text}`,
      );
      const mintedObj = unwrapData(mintRes.json, ['key', 'apiKey']);
      const mintedApiKeySecret = extractMintedKeySecret(mintRes.json, mintedObj);
      assert.ok(
        mintedApiKeySecret,
        `POST /api/v1/keys must return the raw secret once: ${mintRes.text}`,
      );

      // Confirm GET /api/v1/keys never exposes the raw secret
      const listKeysRes = await api.get('/api/v1/keys');
      assert.equal(listKeysRes.status, 200);
      assert.ok(
        !listKeysRes.text.includes(mintedApiKeySecret),
        'GET /api/v1/keys must NEVER expose the raw API key secret after creation',
      );

      // 2. Mint real OAuth 2.1 accessToken & refreshToken via full PKCE discovery/DCR/consent flow
      const oauthFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        scope: 'read',
        clientName: 'E2E Hygiene Probe OAuth Client',
      });
      assert.equal(
        oauthFlow.ok,
        true,
        `runOAuthFlow must succeed for hygiene test, got error: ${oauthFlow.error}`,
      );
      assert.ok(
        typeof oauthFlow.accessToken === 'string' && oauthFlow.accessToken.length >= 16,
        'OAuth flow must issue a non-empty accessToken',
      );

      const forbiddenSecrets = [
        { label: 'HOUSEHOLD_ADMIN_TOKEN', value: server.adminToken },
        { label: 'HOUSEHOLD_PASSCODE', value: server.passcode },
        { label: 'mintedApiKeySecret', value: mintedApiKeySecret },
        { label: 'oauth.accessToken', value: oauthFlow.accessToken },
        ...(oauthFlow.refreshToken
          ? [{ label: 'oauth.refreshToken', value: oauthFlow.refreshToken }]
          : []),
        ...(oauthFlow.clientSecret
          ? [{ label: 'oauth.clientSecret', value: oauthFlow.clientSecret }]
          : []),
      ];

      const exportRoutes = [
        '/api/v1/export/hub.json',
        '/api/v1/export/compounds.csv',
        '/api/v1/export/context.md',
        '/api/v1/export/context.json',
      ];

      for (const route of exportRoutes) {
        const res = await api.get(route);
        assert.equal(res.status, 200, `GET ${route} expected 200: ${res.text}`);
        assertNoStore(res, `GET ${route}`);
        for (const secret of forbiddenSecrets) {
          assert.ok(
            !res.text.includes(secret.value),
            `SECURITY FAILURE: ${route} leaked secret ${secret.label}!`,
          );
        }
      }
    });
  });

  it('T8: Per-member log & adherence isolation prevents Wife logs leaking to Husband and denies cross-member delete', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(api, fixtures.makePeptideCompound());
      const now = Date.now();

      const wifeTaken1 = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(now).toISOString(),
        skipped: false,
      });
      assert.ok(wifeTaken1.status === 201 || wifeTaken1.status === 200);
      const wifeLog1 = unwrapData(wifeTaken1.json, ['log', 'entry', 'record']);

      const wifeTaken2 = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date(now - 86_400_000).toISOString(),
        skipped: false,
      });
      assert.ok(wifeTaken2.status === 201 || wifeTaken2.status === 200);

      const wifeSkip = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        takenAt: new Date(now - 2 * 86_400_000).toISOString(),
        skipped: true,
        skipReason: 'Rest day',
      });
      assert.ok(wifeSkip.status === 201 || wifeSkip.status === 200);

      // Wife has 3 logs; Husband must have 0 logs
      const wifeLogs = unwrapData(
        (await api.get('/api/v1/members/member_wife/logs')).json,
        ['logs', 'entries'],
      );
      assert.equal(wifeLogs.length, 3);

      const husbandLogsRes = await api.get('/api/v1/members/member_husband/logs');
      assert.equal(husbandLogsRes.status, 200);
      const husbandLogs = unwrapData(husbandLogsRes.json, ['logs', 'entries']);
      assert.equal(
        husbandLogs.length,
        0,
        `Husband logs must NOT include Wife logs, got: ${JSON.stringify(husbandLogs)}`,
      );

      // Husband adherence must report 0 taken across 7/30/90d windows
      const husbandAdhRes = await api.get('/api/v1/members/member_husband/adherence');
      assert.equal(husbandAdhRes.status, 200);
      const husbandAdh = unwrapData(husbandAdhRes.json, ['adherence']);
      for (const days of [7, 30, 90]) {
        const win = extractAdherenceWindow(husbandAdh, days);
        assert.ok(win, `Husband adherence missing ${days}d window: ${husbandAdhRes.text}`);
        assert.equal(win.taken, 0, `Husband ${days}d taken must be 0, got ${win.taken}`);
        if (win.skipped !== undefined) {
          assert.equal(win.skipped, 0, `Husband ${days}d skipped must be 0, got ${win.skipped}`);
        }
      }

      // Cross-member delete must be denied (404 or 403) and leave Wife's logs intact
      const crossDel = await api.del(
        `/api/v1/members/member_husband/logs/${encodeURIComponent(wifeLog1.id)}`,
      );
      assert.ok(
        crossDel.status === 404 || crossDel.status === 403,
        `Cross-member log delete must return 404 or 403, got ${crossDel.status}: ${crossDel.text}`,
      );

      const wifeLogsAfter = unwrapData(
        (await api.get('/api/v1/members/member_wife/logs')).json,
        ['logs', 'entries'],
      );
      assert.equal(wifeLogsAfter.length, 3, 'Denied cross-member delete must leave Wife logs intact');
    });
  });

  it('T9: Web Push subscribe rejects missing/invalid/non-HTTPS endpoints (400/422) and unknown unsubscribe succeeds/404 cleanly without 500', async () => {
    await withServer(async ({ api }) => {
      const validKeys = generateWebPushKeys();

      const invalidSubs = [
        { label: 'missing endpoint', body: { memberId: 'member_wife' } },
        { label: 'empty subscription', body: { memberId: 'member_wife', subscription: {} } },
        {
          label: 'non-HTTPS http:// endpoint',
          body: {
            memberId: 'member_wife',
            endpoint: 'http://insecure.example.test/push/sub-1',
            keys: validKeys,
            subscription: { endpoint: 'http://insecure.example.test/push/sub-1', keys: validKeys },
          },
        },
        {
          label: 'malformed non-URL endpoint',
          body: {
            memberId: 'member_wife',
            endpoint: 'not-a-valid-url',
            keys: validKeys,
            subscription: { endpoint: 'not-a-valid-url', keys: validKeys },
          },
        },
        {
          label: 'javascript: scheme endpoint',
          body: {
            memberId: 'member_wife',
            endpoint: 'javascript:alert(1)',
            keys: validKeys,
            subscription: { endpoint: 'javascript:alert(1)', keys: validKeys },
          },
        },
      ];

      for (const { label, body } of invalidSubs) {
        const res = await api.post('/api/v1/push/subscribe', body);
        assert.ok(
          res.status === 400 || res.status === 422,
          `Invalid push subscribe (${label}) must return 400 or 422, got ${res.status}: ${res.text}`,
        );
      }

      // Deleting a never-registered subscription must be handled cleanly (never 500)
      const unknownEndpoint = 'https://push.example.test/wp/unknown-never-registered-99999';
      const delUnknown = await api.del('/api/v1/push/subscribe', {
        body: { endpoint: unknownEndpoint, memberId: 'member_wife' },
        query: { endpoint: unknownEndpoint },
      });
      assert.ok(
        delUnknown.status === 200 || delUnknown.status === 204 || delUnknown.status === 404,
        `Deleting unknown push subscription must return 200/204/404 (never 500), got ${delUnknown.status}: ${delUnknown.text}`,
      );
    });
  });

  it('T10: Deleting nonexistent log returns 404 without affecting existing logs', async () => {
    await withServer(async ({ api }) => {
      const bpc = await createCompound(api, fixtures.makePeptideCompound());
      const createRes = await api.post('/api/v1/members/member_wife/logs', {
        compoundId: bpc.id,
        dose: 250,
        doseAmount: 250,
        unit: 'mcg',
        doseUnit: 'mcg',
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      assert.ok(createRes.status === 201 || createRes.status === 200);
      const existingLog = unwrapData(createRes.json, ['log', 'entry', 'record']);

      const missingDel = await api.del('/api/v1/members/member_wife/logs/log_nonexistent_id_40499');
      assert.equal(
        missingDel.status,
        404,
        `Deleting nonexistent log must return 404, got ${missingDel.status}: ${missingDel.text}`,
      );
      assertNoStore(missingDel, 'DELETE nonexistent log');

      const logsAfter = unwrapData(
        (await api.get('/api/v1/members/member_wife/logs')).json,
        ['logs', 'entries'],
      );
      assert.equal(logsAfter.length, 1, 'Existing log must remain untouched after 404 delete');
      assert.equal(logsAfter[0].id, existingLog.id);
    });
  });
});
