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
      assert.ok(
        !text.includes(secret),
        `${label}: secret value leaked in response body`,
      );
    }
  }
}

function getId(obj) {
  return obj?.id ?? obj?.compoundId ?? obj?.proposalId ?? obj?.stackId ?? null;
}

function getToolSpec(tools, toolName) {
  assert.ok(Array.isArray(tools), 'tools/list must return an array of tools');
  const spec = tools.find((t) => t?.name === toolName);
  assert.ok(spec, `Expected canonical MCP tool "${toolName}" in tools/list`);
  return spec;
}

function buildSectionSchemaArgs(spec, sectionId) {
  const props = spec.inputSchema?.properties ?? {};
  if ('sectionId' in props) return { sectionId };
  if ('id' in props) return { id: sectionId };
  if ('section' in props) return { section: sectionId };
  return { sectionId };
}

function buildDuplicateCheckArgs(spec, query) {
  const props = spec.inputSchema?.properties ?? {};
  const args = { name: query.name };
  if (query.aliases) args.aliases = query.aliases;
  if (query.sectionId) {
    if ('sectionId' in props || !('section' in props)) args.sectionId = query.sectionId;
    else args.section = query.sectionId;
  }
  if (query.route) args.route = query.route;
  if (query.canonicalMolecule) args.canonicalMolecule = query.canonicalMolecule;
  return args;
}

function buildCreateCompoundArgs(spec, payload) {
  const props = spec.inputSchema?.properties ?? {};
  if ('compound' in props && !('name' in props)) {
    return {
      compound: payload,
      ...('provenance' in props && payload.provenance ? { provenance: payload.provenance } : {}),
    };
  }
  if ('profile' in props && !('name' in props)) {
    return { profile: payload };
  }
  if ('data' in props && !('name' in props)) {
    return { data: payload };
  }
  return payload;
}

function buildEnrichCompoundArgs(spec, compoundId, patch, extras = {}) {
  const props = spec.inputSchema?.properties ?? {};
  const idKey = 'compoundId' in props ? 'compoundId' : 'id' in props ? 'id' : 'compoundId';
  const patchKey = ['patch', 'updates', 'fields', 'changes', 'data'].find((k) => k in props);
  const args = { [idKey]: compoundId };
  if (patchKey) {
    args[patchKey] = patch;
  } else {
    Object.assign(args, patch);
  }
  if (extras.provenance && ('provenance' in props || !patchKey)) {
    args.provenance = extras.provenance;
  }
  if (extras.rationale && 'rationale' in props) {
    args.rationale = extras.rationale;
  }
  return args;
}

function getAllSystemicItems(spread) {
  const slots = spread?.systemic?.slots ?? [];
  return slots.flatMap((slot) =>
    (slot.items ?? []).map((item) => ({ ...item, slotId: slot.slotId, suggestedTime: slot.suggestedTime })),
  );
}

function extractSnapshotDateKey(snapshots) {
  assert.ok(Array.isArray(snapshots) && snapshots.length >= 1, 'Expected at least 1 snapshot in GET /api/v1/snapshots');
  const sorted = [...snapshots].reverse();
  const preferred =
    sorted.find((s) => typeof s === 'object' && s !== null && (s.compoundCount > 0 || s.compoundsCount > 0)) ??
    sorted[0];
  if (typeof preferred === 'string') return preferred;
  const dateKey = preferred?.dateKey ?? preferred?.id ?? preferred?.key ?? preferred?.date;
  assert.ok(typeof dateKey === 'string' && dateKey.length > 0, `Expected valid snapshot dateKey, got ${JSON.stringify(preferred)}`);
  return dateKey;
}

async function ensureSnapshotDateKey(adminApi) {
  let snapsRes = await adminApi.get('/api/v1/snapshots');
  assert.equal(snapsRes.status, 200, `GET /api/v1/snapshots failed: ${snapsRes.text}`);
  assertNoStore(snapsRes, 'GET /api/v1/snapshots');
  let snapshots = unwrapData(snapsRes.json, ['snapshots']);
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    const syncRes = await adminApi.get('/api/v1/sync');
    assert.equal(syncRes.status, 200, `GET /api/v1/sync failed: ${syncRes.text}`);
    const state = unwrapData(syncRes.json, ['state', 'sync']);
    const rev = state?._rev ?? syncRes.json?._rev;
    const writeRes = await adminApi.post('/api/v1/sync', state, {
      headers: rev !== undefined && rev !== null ? { 'If-Match': `"${rev}"` } : {},
    });
    assert.equal(writeRes.status, 200, `Baseline sync write failed: ${writeRes.text}`);
    snapsRes = await adminApi.get('/api/v1/snapshots');
    assert.equal(snapsRes.status, 200);
    snapshots = unwrapData(snapsRes.json, ['snapshots']);
  }
  return extractSnapshotDateKey(snapshots);
}

describe('Tier 3 — Cross-Feature: Catalog, Custom Schemas, AI Governance & Sync', () => {
  it('1. Custom section field (coa_url, required) + aiResearchPrompt propagates through MCP schema, rejects missing field, creates ai_draft, verifies, spreads in Wife stack, and exports in context.md', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
      const customPrompt = 'Always cite preclinical or clinical half-life data and include third-party COA link.';
      const coaField = fixtures.makeCustomSectionField({
        key: 'coa_url',
        label: 'Certificate of Analysis URL',
        fieldType: 'url',
        required: true,
        showOnCard: true,
        aiResearchInstruction: 'Provide a third-party HPLC Certificate of Analysis URL.',
      });

      const patchSecRes = await admin.patch('/api/v1/sections/peptides', {
        customFields: [coaField],
        aiResearchPrompt: customPrompt,
      });
      assert.equal(patchSecRes.status, 200, `PATCH /api/v1/sections/peptides failed: ${patchSecRes.text}`);
      assertNoStore(patchSecRes, 'PATCH /api/v1/sections/peptides');
      const updatedSection = unwrapData(patchSecRes.json, ['section']);
      assert.ok(
        Array.isArray(updatedSection.customFields) &&
          updatedSection.customFields.some((f) => f.key === 'coa_url' && f.required === true),
        'Updated peptides section must include required custom field coa_url',
      );
      assert.equal(updatedSection.aiResearchPrompt, customPrompt);

      const flow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(flow.ok, true, `Claude OAuth flow failed: ${flow.error}`);
      assert.equal(flow.iss, server.origin);
      assert.ok(flow.accessToken);

      const mcp = createMcpClient({ baseUrl: server.baseUrl, token: flow.accessToken, protocolVersion: '2025-06-18' });
      const initRes = await mcp.initialize({ name: 'Claude', version: '1.0.0' });
      assert.equal(initRes.status, 200);
      assert.equal(initRes.error, null);
      await mcp.notifyInitialized();

      const listToolsRes = await mcp.listTools();
      assert.equal(listToolsRes.status, 200);
      assert.equal(listToolsRes.error, null);
      const tools = listToolsRes.result?.tools;
      const getSchemaSpec = getToolSpec(tools, 'get_section_schema');
      const createSpec = getToolSpec(tools, 'create_or_propose_compound');

      const schemaRes = await mcp.callTool('get_section_schema', buildSectionSchemaArgs(getSchemaSpec, 'peptides'));
      assert.equal(schemaRes.status, 200);
      assert.equal(schemaRes.error, null);
      assert.notEqual(schemaRes.result?.isError, true);
      const schemaPayload = parseToolJson(schemaRes);
      const schemaText = JSON.stringify(schemaPayload);
      assert.match(schemaText, /coa_url/, 'MCP get_section_schema must expose coa_url');
      assert.ok(schemaText.includes(customPrompt), 'MCP get_section_schema must expose updated aiResearchPrompt');

      const missingCoaPayload = fixtures.makePeptideCompound({
        name: 'Epitalon',
        canonicalMolecule: 'epitalon',
        aliases: ['Epithalon'],
        customFields: {},
        provenance: {
          sourceModel: 'ai:claude',
          researchedAt: '2026-10-12T10:00:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [{ title: 'Epitalon Peptide Review', url: 'https://pubmed.ncbi.nlm.nih.gov/12374906/' }],
        },
      });
      const rejectedRes = await mcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(createSpec, missingCoaPayload),
      );
      const rejected =
        rejectedRes.status === 422 ||
        rejectedRes.status === 400 ||
        Boolean(rejectedRes.error) ||
        rejectedRes.result?.isError === true;
      assert.equal(rejected, true, `Expected missing required coa_url to be rejected, got: ${rejectedRes.text}`);
      const rejectedText = rejectedRes.text || JSON.stringify(rejectedRes.json);
      assert.match(rejectedText, /coa_url|required|missing/i, `Expected actionable missing-field error mentioning coa_url: ${rejectedText}`);

      const listAfterReject = await admin.get('/api/v1/compounds');
      assert.equal(listAfterReject.status, 200);
      const compoundsAfterReject = unwrapData(listAfterReject.json, ['compounds']);
      assert.ok(
        !compoundsAfterReject.some((c) => c.name === 'Epitalon'),
        'Rejected compound missing required coa_url must not be persisted',
      );

      const completePayload = fixtures.makePeptideCompound({
        name: 'Epitalon',
        canonicalMolecule: 'epitalon',
        aliases: ['Epithalon'],
        customFields: { coa_url: 'https://lab-coa.example.test/epitalon-2026.pdf' },
        provenance: {
          sourceModel: 'ai:claude',
          researchedAt: '2026-10-12T10:05:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [{ title: 'Epitalon Peptide Review', url: 'https://pubmed.ncbi.nlm.nih.gov/12374906/' }],
        },
      });
      const createRes = await mcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(createSpec, completePayload),
      );
      assert.equal(createRes.status, 200);
      assert.equal(createRes.error, null);
      assert.notEqual(createRes.result?.isError, true, `Expected Epitalon creation to succeed: ${createRes.text}`);

      const listAfterCreate = await admin.get('/api/v1/compounds');
      assert.equal(listAfterCreate.status, 200);
      const compounds = unwrapData(listAfterCreate.json, ['compounds']);
      const epitalon = compounds.find((c) => c.name === 'Epitalon');
      assert.ok(epitalon, 'Epitalon must appear in REST catalog after MCP create_or_propose_compound');
      assert.equal(epitalon.profileStatus, 'ai_draft');
      assert.equal(epitalon.customFields?.coa_url, 'https://lab-coa.example.test/epitalon-2026.pdf');
      assert.ok(Array.isArray(epitalon.provenance?.citations) && epitalon.provenance.citations.length >= 1);
      const epitalonId = getId(epitalon);

      const verifyRes = await admin.post(`/api/v1/compounds/${epitalonId}/verify`, {});
      assert.equal(verifyRes.status, 200, `POST /verify failed: ${verifyRes.text}`);
      const verifiedGet = await admin.get(`/api/v1/compounds/${epitalonId}`);
      assert.equal(verifiedGet.status, 200);
      const verifiedEpitalon = unwrapData(verifiedGet.json, ['compound']);
      assert.equal(verifiedEpitalon.profileStatus, 'verified');

      const ownRes = await admin.put(`/api/v1/ownership/${epitalonId}`, {
        scope: 'member:member_wife',
        status: 'have',
        quantity: 2,
        unit: 'vial',
      });
      assertStatusIn(ownRes, [200, 201], 'PUT ownership');

      const stackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Longevity Stack',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: epitalonId, doseAmount: 250, doseUnit: 'mcg' })],
        }),
      );
      assertStatusIn(stackRes, [200, 201], 'POST Wife stack');
      const stack = unwrapData(stackRes.json, ['stack']);
      const stackId = getId(stack);
      assert.ok(stackId);

      const schedRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/schedule`, {
        dateKey: '2026-10-12',
      });
      assert.equal(schedRes.status, 200, `Schedule failed: ${schedRes.text}`);
      assertNoStore(schedRes, 'POST schedule');
      const spread = unwrapData(schedRes.json, ['schedule']);
      const scheduledItems = getAllSystemicItems(spread);
      const scheduledEpitalon = scheduledItems.find((i) => i.compoundId === epitalonId);
      assert.ok(scheduledEpitalon, 'Epitalon must appear in systemic spread schedule');
      assert.ok(
        Array.isArray(scheduledEpitalon.rationale) && scheduledEpitalon.rationale.length > 0,
        'Scheduled item must carry explainable rationale',
      );

      const interRes = await admin.post(`/api/v1/members/member_wife/stacks/${stackId}/interactions`, {});
      assert.equal(interRes.status, 200, `Interactions failed: ${interRes.text}`);
      assertNoStore(interRes, 'POST interactions');
      const interactions = unwrapData(interRes.json, ['interactions']);
      assert.ok(Array.isArray(interactions.hardStops), 'InteractionAnalysis must include hardStops[]');
      assert.ok(Array.isArray(interactions.cautions), 'InteractionAnalysis must include cautions[]');
      assert.ok(Array.isArray(interactions.synergies), 'InteractionAnalysis must include synergies[]');

      const ctxRes = await admin.get('/api/v1/export/context.md');
      assert.equal(ctxRes.status, 200, `GET context.md failed: ${ctxRes.text}`);
      assertNoStore(ctxRes, 'GET context.md');
      assert.match(ctxRes.text, /Epitalon/, 'context.md must include verified compound Epitalon');
      assert.match(ctxRes.text, /Peptides|peptides/, 'context.md must include section context');
      assertNoSecrets(
        ctxRes.text,
        [server.adminToken, server.passcode, flow.accessToken, flow.refreshToken],
        'GET /api/v1/export/context.md',
      );
    } finally {
      await server.stop();
    }
  });

  it('2. AI onboarding (Claude) -> User verify -> Gemini verified-field overwrite routed to Proposals Inbox -> approve with edits -> Audit log attribution -> Snapshot rollback', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const claudeFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(claudeFlow.ok, true, `Claude OAuth failed: ${claudeFlow.error}`);

      const geminiFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Gemini',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(geminiFlow.ok, true, `Gemini OAuth failed: ${geminiFlow.error}`);

      const claudeMcp = createMcpClient({ baseUrl: server.baseUrl, token: claudeFlow.accessToken });
      await claudeMcp.initialize({ name: 'Claude', version: '1.0.0' });
      await claudeMcp.notifyInitialized();
      const claudeTools = (await claudeMcp.listTools()).result?.tools;
      const createSpec = getToolSpec(claudeTools, 'create_or_propose_compound');

      const tbPayload = fixtures.makePeptideCompound({
        name: 'TB-500',
        canonicalMolecule: 'tb-500',
        aliases: ['Thymosin Beta-4 Fragment'],
        dosages: {
          rangeText: '2 mg twice weekly',
          defaultAmount: 2,
          defaultUnit: 'mg',
          route: 'SubQ',
          frequencyText: '2x/week',
          maxCeiling: 10,
        },
        provenance: {
          sourceModel: 'ai:claude',
          researchedAt: '2026-10-12T10:00:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [{ title: 'Thymosin Beta-4 Tissue Repair', url: 'https://pubmed.ncbi.nlm.nih.gov/20536458/' }],
        },
      });
      const claudeCreate = await claudeMcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(createSpec, tbPayload),
      );
      assert.equal(claudeCreate.status, 200);
      assert.equal(claudeCreate.error, null);
      assert.notEqual(claudeCreate.result?.isError, true, `Claude create TB-500 failed: ${claudeCreate.text}`);

      const listRes = await admin.get('/api/v1/compounds');
      assert.equal(listRes.status, 200);
      const tbCompound = unwrapData(listRes.json, ['compounds']).find((c) => c.name === 'TB-500');
      assert.ok(tbCompound, 'TB-500 must exist after Claude onboarding');
      assert.equal(tbCompound.profileStatus, 'ai_draft');
      assert.equal(tbCompound.dosages?.defaultAmount, 2);
      const tbId = getId(tbCompound);

      const verifyRes = await admin.post(`/api/v1/compounds/${tbId}/verify`, {});
      assert.equal(verifyRes.status, 200);
      const afterVerify = unwrapData((await admin.get(`/api/v1/compounds/${tbId}`)).json, ['compound']);
      assert.equal(afterVerify.profileStatus, 'verified');

      const geminiMcp = createMcpClient({ baseUrl: server.baseUrl, token: geminiFlow.accessToken });
      await geminiMcp.initialize({ name: 'Gemini', version: '1.0.0' });
      await geminiMcp.notifyInitialized();
      const geminiTools = (await geminiMcp.listTools()).result?.tools;
      const enrichSpec = getToolSpec(geminiTools, 'enrich_compound');

      const geminiEnrich = await geminiMcp.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(
          enrichSpec,
          tbId,
          {
            dosages: {
              rangeText: '5 mg twice weekly',
              defaultAmount: 5,
              defaultUnit: 'mg',
              route: 'SubQ',
              frequencyText: '2x/week',
              maxCeiling: 10,
            },
          },
          {
            provenance: { sourceModel: 'ai:gemini' },
            rationale: 'Updated dosing protocol from recent literature',
          },
        ),
      );
      assert.equal(geminiEnrich.status, 200, `Gemini enrich_compound failed: ${geminiEnrich.text}`);
      assert.equal(geminiEnrich.error, null);

      const afterGeminiAttempt = unwrapData((await admin.get(`/api/v1/compounds/${tbId}`)).json, ['compound']);
      assert.equal(
        afterGeminiAttempt.dosages?.defaultAmount,
        2,
        'Verified compound dosage MUST NOT be silently overwritten by second AI',
      );
      assert.equal(afterGeminiAttempt.dosages?.rangeText, '2 mg twice weekly');

      const proposalsRes = await admin.get('/api/v1/proposals', { query: { status: 'pending' } });
      assert.equal(proposalsRes.status, 200, `GET /api/v1/proposals failed: ${proposalsRes.text}`);
      assertNoStore(proposalsRes, 'GET /api/v1/proposals');
      const proposals = unwrapData(proposalsRes.json, ['proposals']);
      assert.ok(Array.isArray(proposals) && proposals.length >= 1, 'Gemini overwrite attempt must create a pending proposal');
      const geminiProposal = proposals.find((p) => JSON.stringify(p).includes(tbId));
      assert.ok(geminiProposal, `Expected pending proposal referencing TB-500 (${tbId})`);
      const proposalId = getId(geminiProposal);

      const resolveRes = await admin.post(`/api/v1/proposals/${proposalId}/resolve`, {
        action: 'approve',
        edits: {
          dosages: {
            rangeText: '2.5 mg twice weekly (user edited)',
            defaultAmount: 2.5,
            defaultUnit: 'mg',
            route: 'SubQ',
            frequencyText: '2x/week',
            maxCeiling: 10,
          },
        },
      });
      assert.equal(resolveRes.status, 200, `POST /proposals/:id/resolve failed: ${resolveRes.text}`);

      const afterResolve = unwrapData((await admin.get(`/api/v1/compounds/${tbId}`)).json, ['compound']);
      assert.equal(afterResolve.dosages?.defaultAmount, 2.5, 'User edits in proposal approval must take effect');
      assert.equal(afterResolve.dosages?.rangeText, '2.5 mg twice weekly (user edited)');

      // Competing proposal from Gemini -> User dismisses -> live compound keeps 2.5 mg untouched
      const competingEnrich = await geminiMcp.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(
          enrichSpec,
          tbId,
          {
            dosages: {
              rangeText: '12 mg daily (competing proposal to dismiss)',
              defaultAmount: 12,
              defaultUnit: 'mg',
              route: 'SubQ',
              frequencyText: 'Daily',
              maxCeiling: 15,
            },
          },
          {
            provenance: { sourceModel: 'ai:gemini' },
            rationale: 'Competing aggressive protocol proposal for dismissal test',
          },
        ),
      );
      assert.equal(competingEnrich.status, 200, `Competing Gemini enrich_compound failed: ${competingEnrich.text}`);
      assert.equal(competingEnrich.error, null);

      const competingProposalsRes = await admin.get('/api/v1/proposals', { query: { status: 'pending' } });
      assert.equal(competingProposalsRes.status, 200);
      const competingProposals = unwrapData(competingProposalsRes.json, ['proposals']);
      const competingProposal = competingProposals.find(
        (p) => getId(p) !== proposalId && (!p.status || p.status === 'pending') && JSON.stringify(p).includes(tbId),
      );
      assert.ok(competingProposal, `Expected competing pending proposal referencing TB-500 (${tbId})`);
      const competingProposalId = getId(competingProposal);

      const dismissRes = await admin.post(`/api/v1/proposals/${competingProposalId}/resolve`, {
        action: 'dismiss',
      });
      assert.equal(dismissRes.status, 200, `POST /proposals/:id/resolve (dismiss) failed: ${dismissRes.text}`);

      const afterDismiss = unwrapData((await admin.get(`/api/v1/compounds/${tbId}`)).json, ['compound']);
      assert.equal(afterDismiss.dosages?.defaultAmount, 2.5, 'Dismissed competing proposal must NOT alter live dosage');
      assert.equal(afterDismiss.dosages?.rangeText, '2.5 mg twice weekly (user edited)');

      const auditRes = await admin.get('/api/v1/audit-log');
      assert.equal(auditRes.status, 200, `GET /api/v1/audit-log failed: ${auditRes.text}`);
      assertNoStore(auditRes, 'GET /api/v1/audit-log');
      const auditEntries = unwrapData(auditRes.json, ['auditLog', 'audit_log', 'entries', 'items']);
      assert.ok(Array.isArray(auditEntries) && auditEntries.length >= 3, 'Audit log must record multi-actor history');
      for (const entry of auditEntries) {
        assert.ok(entry.timestamp || entry.createdAt || entry.at, 'Each audit entry must include a timestamp');
        assert.ok(
          entry.actor || entry.actorId || entry.clientName || entry.sourceModel || entry.memberId,
          `Each audit entry must include a non-empty actor attribution field: ${JSON.stringify(entry)}`,
        );
      }
      const actorBlob = auditEntries
        .map((e) => [e.actor, e.actorId, e.clientName, e.sourceModel, e.memberId].filter(Boolean).join(' '))
        .join('\n');
      assert.match(actorBlob, /claude/i, `Audit log actor fields must capture Claude actor: ${actorBlob}`);
      assert.match(actorBlob, /gemini/i, `Audit log actor fields must capture Gemini actor: ${actorBlob}`);
      assert.match(
        actorBlob,
        /admin|member|wife|husband|user|household/i,
        `Audit log actor fields must capture Household User actor: ${actorBlob}`,
      );

      const dateKey = await ensureSnapshotDateKey(admin);

      const delRes = await admin.del(`/api/v1/compounds/${tbId}`);
      assertStatusIn(delRes, [200, 204], 'DELETE TB-500 destructive mutation');
      const rogueRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          name: 'Rogue Post-Snapshot Peptide',
          canonicalMolecule: 'rogue-post-snapshot-peptide',
          aliases: [],
        }),
      );
      assertStatusIn(rogueRes, [200, 201], 'POST rogue post-snapshot compound');

      const afterDestruction = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(!afterDestruction.some((c) => getId(c) === tbId), 'TB-500 must be deleted before restore');
      assert.ok(afterDestruction.some((c) => c.name === 'Rogue Post-Snapshot Peptide'), 'Rogue compound must exist before restore');

      const restoreRes = await admin.post(`/api/v1/snapshots/${encodeURIComponent(dateKey)}/restore`, {});
      assert.equal(restoreRes.status, 200, `POST snapshot restore failed: ${restoreRes.text}`);

      const afterRestore = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.ok(
        afterRestore.some((c) => getId(c) === tbId || c.name === 'TB-500'),
        'Snapshot restore must recover baseline TB-500',
      );
      assert.ok(
        !afterRestore.some((c) => c.name === 'Rogue Post-Snapshot Peptide'),
        'Snapshot restore must roll back post-snapshot rogue mutation',
      );
    } finally {
      await server.stop();
    }
  });

  it('3. Multi-client concurrent sync enforces optimistic concurrency (If-Match 409) and clean pull-merge-retry without clobbering', async () => {
    const server = await startE2EServer();
    try {
      const clientA = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
      const clientB = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      const seedRes = await clientA.post('/api/v1/compounds', fixtures.makePeptideCompound());
      assertStatusIn(seedRes, [200, 201], 'Seed initial BPC-157');

      const pullA = await clientA.get('/api/v1/sync');
      const pullB = await clientB.get('/api/v1/sync');
      assert.equal(pullA.status, 200);
      assert.equal(pullB.status, 200);
      assertNoStore(pullA, 'GET /api/v1/sync');

      const stateA = structuredClone(unwrapData(pullA.json, ['state', 'sync']));
      const stateB = structuredClone(unwrapData(pullB.json, ['state', 'sync']));
      const rev0 = stateA._rev ?? pullA.json?._rev;
      assert.equal(typeof rev0, 'number', `Expected numeric _rev in GET /api/v1/sync, got ${JSON.stringify(pullA.json)}`);
      assert.equal(stateB._rev ?? pullB.json?._rev, rev0, 'Both clients must pull identical initial _rev');

      const compoundA = {
        ...fixtures.makePeptideCompound({
          name: 'Client A Peptide',
          canonicalMolecule: 'client-a-peptide',
          aliases: ['CAP-1'],
          provenance: { sourceModel: 'ai:claude' },
        }),
        id: 'cmp_sync_client_a',
        slug: 'client-a-peptide',
        createdAt: '2026-10-12T10:00:00.000Z',
        updatedAt: '2026-10-12T10:00:00.000Z',
      };
      const compoundB = {
        ...fixtures.makeSupplementCompound({
          name: 'Client B Supplement',
          canonicalMolecule: 'client-b-supplement',
          aliases: ['CBS-1'],
          tags: ['supplement', 'antioxidant'],
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Standardized Botanical Extract',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Client B Complex', amount: 250, unit: 'mg' }],
            adultUpperLimit: null,
          },
          provenance: { sourceModel: 'ai:gpt' },
        }),
        id: 'cmp_sync_client_b',
        slug: 'client-b-supplement',
        createdAt: '2026-10-12T10:01:00.000Z',
        updatedAt: '2026-10-12T10:01:00.000Z',
      };

      const addCompoundToState = (state, cmp) => {
        if (Array.isArray(state.compounds)) {
          state.compounds.push(cmp);
        } else if (state.compounds && typeof state.compounds === 'object') {
          state.compounds[cmp.id] = cmp;
        } else {
          state.compounds = [cmp];
        }
      };

      addCompoundToState(stateA, compoundA);
      const pushA = await clientA.post('/api/v1/sync', stateA, {
        headers: { 'If-Match': `"${rev0}"` },
      });
      assert.equal(pushA.status, 200, `Client A sync push failed: ${pushA.text}`);
      const pushAData = unwrapData(pushA.json, ['state', 'sync']);
      const rev1 = pushAData?._rev ?? pushA.json?._rev ?? pushAData?.rev ?? pushA.json?.rev;
      assert.equal(typeof rev1, 'number', 'Client A sync push must return updated integer _rev');
      assert.ok(rev1 > rev0, `Expected _rev to increment (${rev1} > ${rev0})`);

      addCompoundToState(stateB, compoundB);
      const stalePushB = await clientB.post('/api/v1/sync', stateB, {
        headers: { 'If-Match': `"${rev0}"` },
      });
      assert.equal(stalePushB.status, 409, `Expected 409 Conflict for stale If-Match, got ${stalePushB.status}: ${stalePushB.text}`);
      const etagRev = stalePushB.headers.get('etag');
      const parsedEtagRev = etagRev ? Number(etagRev.replace(/^W\//i, '').replace(/"/g, '')) : undefined;
      const conflictRev =
        stalePushB.json?.currentRev ??
        stalePushB.json?._rev ??
        stalePushB.json?.serverRev ??
        stalePushB.json?.rev ??
        stalePushB.json?.data?._rev ??
        stalePushB.json?.data?.currentRev ??
        stalePushB.json?.data?.serverRev ??
        stalePushB.json?.data?.rev ??
        (Number.isFinite(parsedEtagRev) ? parsedEtagRev : undefined);
      assert.equal(conflictRev, rev1, `409 Conflict response must report current revision ${rev1}, got ${stalePushB.text}`);

      const repullB = await clientB.get('/api/v1/sync');
      assert.equal(repullB.status, 200);
      const mergedB = structuredClone(unwrapData(repullB.json, ['state', 'sync']));
      const freshRev = mergedB._rev ?? repullB.json?._rev ?? mergedB.rev ?? repullB.json?.rev;
      assert.equal(freshRev, rev1);
      addCompoundToState(mergedB, compoundB);

      const retryPushB = await clientB.post('/api/v1/sync', mergedB, {
        headers: { 'If-Match': `"${freshRev}"` },
      });
      assert.equal(retryPushB.status, 200, `Client B merged sync retry failed: ${retryPushB.text}`);
      const retryData = unwrapData(retryPushB.json, ['state', 'sync']);
      const rev2 = retryData?._rev ?? retryPushB.json?._rev ?? retryData?.rev ?? retryPushB.json?.rev;
      assert.ok(typeof rev2 === 'number' && rev2 > rev1, `Expected _rev > ${rev1}, got ${rev2}`);

      const finalCompounds = unwrapData((await clientA.get('/api/v1/compounds')).json, ['compounds']);
      const names = new Set(finalCompounds.map((c) => c.name));
      assert.ok(names.has('BPC-157'), 'Baseline BPC-157 must survive concurrent sync');
      assert.ok(names.has('Client A Peptide'), 'Client A change must not be clobbered by Client B merge');
      assert.ok(names.has('Client B Supplement'), 'Client B merged change must persist cleanly');
    } finally {
      await server.stop();
    }
  });

  it('4. Custom field removal archives existing compound values into archivedCustomFields and preserves them across MCP schema refresh & re-enrichment', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
      const lotField = fixtures.makeCustomSectionField({
        key: 'batch_lot_code',
        label: 'Batch Lot Code',
        fieldType: 'text',
        required: true,
        showOnCard: true,
        aiResearchInstruction: 'Record manufacturer batch/lot code.',
      });

      const addFieldRes = await admin.patch('/api/v1/sections/peptides', { customFields: [lotField] });
      assert.equal(addFieldRes.status, 200);

      const createBpcRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePeptideCompound({
          profileStatus: 'ai_draft',
          storageNotes: '',
          customFields: { batch_lot_code: 'LOT-2026-ALPHA-09' },
        }),
      );
      assertStatusIn(createBpcRes, [200, 201], 'Create BPC-157 with batch_lot_code');
      const bpc = unwrapData(createBpcRes.json, ['compound']);
      const bpcId = getId(bpc);
      assert.equal(bpc.customFields?.batch_lot_code, 'LOT-2026-ALPHA-09');

      const removeFieldRes = await admin.patch('/api/v1/sections/peptides', { customFields: [] });
      assert.equal(removeFieldRes.status, 200);

      const bpcAfterRemoval = unwrapData((await admin.get(`/api/v1/compounds/${bpcId}`)).json, ['compound']);
      assert.equal(
        bpcAfterRemoval.archivedCustomFields?.batch_lot_code,
        'LOT-2026-ALPHA-09',
        'Removed custom field value must be preserved non-destructively in archivedCustomFields',
      );

      const flow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'propose',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(flow.ok, true, `OAuth failed: ${flow.error}`);

      const mcp = createMcpClient({ baseUrl: server.baseUrl, token: flow.accessToken });
      await mcp.initialize({ name: 'Claude', version: '1.0.0' });
      await mcp.notifyInitialized();
      const tools = (await mcp.listTools()).result?.tools;
      const schemaSpec = getToolSpec(tools, 'get_section_schema');
      const createSpec = getToolSpec(tools, 'create_or_propose_compound');
      const enrichSpec = getToolSpec(tools, 'enrich_compound');

      const schemaPayload = parseToolJson(
        await mcp.callTool('get_section_schema', buildSectionSchemaArgs(schemaSpec, 'peptides')),
      );
      const activeCustomFields =
        schemaPayload?.customFields ??
        schemaPayload?.section?.customFields ??
        schemaPayload?.schema?.customFields ??
        schemaPayload?.data?.customFields;
      assert.ok(
        Array.isArray(activeCustomFields),
        `get_section_schema must expose an array of customFields, got ${JSON.stringify(schemaPayload)}`,
      );
      assert.ok(
        !activeCustomFields.some((f) => f.key === 'batch_lot_code'),
        'Removed field batch_lot_code must no longer appear in active get_section_schema customFields',
      );

      const selankPayload = fixtures.makePeptideCompound({
        name: 'Selank',
        canonicalMolecule: 'selank',
        aliases: ['TP-7'],
        customFields: {},
        provenance: { sourceModel: 'ai:claude' },
      });
      const selankRes = await mcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(createSpec, selankPayload),
      );
      assert.equal(selankRes.status, 200);
      assert.equal(selankRes.error, null);
      assert.notEqual(
        selankRes.result?.isError,
        true,
        `New peptide without removed custom field must succeed: ${selankRes.text}`,
      );

      const enrichRes = await mcp.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(
          enrichSpec,
          bpcId,
          { storageNotes: 'Store lyophilized at -20C; reconstituted at 2-8C up to 28 days.' },
          { provenance: { sourceModel: 'ai:claude' } },
        ),
      );
      assert.equal(enrichRes.status, 200);
      assert.equal(enrichRes.error, null);
      assert.notEqual(enrichRes.result?.isError, true, `enrich_compound failed: ${enrichRes.text}`);

      const bpcAfterEnrich = unwrapData((await admin.get(`/api/v1/compounds/${bpcId}`)).json, ['compound']);
      assert.equal(
        bpcAfterEnrich.archivedCustomFields?.batch_lot_code,
        'LOT-2026-ALPHA-09',
        'Re-enriching compound must NOT destroy archivedCustomFields.batch_lot_code',
      );
      assert.match(bpcAfterEnrich.storageNotes || '', /28 days/i, 'Enriched field must persist cleanly');
    } finally {
      await server.stop();
    }
  });

  it('5. Alias duplicate prevention across REST + MCP (Anavar <-> Oxandrolone) blocks duplicate creation and routes cleanly to enrich_compound', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
      const anavarPayload = fixtures.makePedCompound({
        name: 'Anavar',
        canonicalMolecule: 'oxandrolone',
        aliases: ['Oxandrolone'],
        subsection: 'Oral DHT-Derived AAS',
        tags: ['ped', 'aas', '17aa_oral', 'dht_derived'],
        dosages: {
          rangeText: '5-20 mg/day',
          defaultAmount: 10,
          defaultUnit: 'mg',
          route: 'Oral',
          frequencyText: 'Daily',
          maxCeiling: 40,
        },
        halfLife: {
          valueHours: 9,
          minHours: 8,
          maxHours: 10,
          displayText: '~9 hours',
          route: 'Oral',
          kind: 'elimination',
          effectDurationNote: 'Oral C17-alpha-alkylated elimination half-life.',
        },
        sectionData: {
          compoundClass: 'Oral DHT-Derived AAS',
          ester: null,
          esterHalfLifeDays: null,
          oilPreMixed: false,
          concentrationMgPerMl: null,
          vialMl: null,
          c17AlphaAlkylated: true,
          hepatotoxicityRisk: 'moderate',
        },
        monitoringLabs: [],
        profileStatus: 'ai_draft',
        notes: '',
      });
      const createRes = await admin.post('/api/v1/compounds', anavarPayload);
      assertStatusIn(createRes, [200, 201], 'Create Anavar');
      const anavar = unwrapData(createRes.json, ['compound']);
      const anavarId = getId(anavar);
      assert.ok(anavarId);

      const restDupRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makePedCompound({
          name: 'Oxandrolone',
          canonicalMolecule: 'oxandrolone',
          aliases: ['Anavar'],
          dosages: { defaultAmount: 10, defaultUnit: 'mg', route: 'Oral', rangeText: '10 mg/day', frequencyText: 'Daily' },
          halfLife: {
            valueHours: 9,
            minHours: 8,
            maxHours: 10,
            displayText: '~9 hours',
            route: 'Oral',
            kind: 'elimination',
          },
          sectionData: { ester: null, esterHalfLifeDays: null, oilPreMixed: false, c17AlphaAlkylated: true },
        }),
      );
      assert.equal(restDupRes.status, 409, `REST duplicate alias must return 409, got ${restDupRes.status}: ${restDupRes.text}`);
      assert.ok(restDupRes.text.includes(anavarId), `REST 409 duplicate response must reference existing ID ${anavarId}`);

      const flow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'propose',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(flow.ok, true);

      const mcp = createMcpClient({ baseUrl: server.baseUrl, token: flow.accessToken });
      await mcp.initialize({ name: 'Claude', version: '1.0.0' });
      await mcp.notifyInitialized();
      const tools = (await mcp.listTools()).result?.tools;
      const dupSpec = getToolSpec(tools, 'check_duplicate_compound');
      const createSpec = getToolSpec(tools, 'create_or_propose_compound');
      const enrichSpec = getToolSpec(tools, 'enrich_compound');

      const checkRes = await mcp.callTool(
        'check_duplicate_compound',
        buildDuplicateCheckArgs(dupSpec, { name: 'Oxandrolone', sectionId: 'peds', route: 'Oral' }),
      );
      assert.equal(checkRes.status, 200);
      assert.equal(checkRes.error, null);
      const checkJson = parseToolJson(checkRes);
      const checkBlob = JSON.stringify(checkJson);
      assert.ok(
        checkJson?.isDuplicate === true ||
          checkJson?.duplicate === true ||
          (Array.isArray(checkJson?.matches) && checkJson.matches.length > 0),
        `check_duplicate_compound must flag Oxandrolone as duplicate of Anavar: ${checkBlob}`,
      );
      assert.ok(checkBlob.includes(anavarId), `check_duplicate_compound must reference existing compoundId ${anavarId}`);

      const mcpDupCreate = await mcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(
          createSpec,
          fixtures.makePedCompound({
            name: 'Oxandrolone',
            canonicalMolecule: 'oxandrolone',
            aliases: [],
            dosages: { defaultAmount: 10, defaultUnit: 'mg', route: 'Oral', rangeText: '10 mg/day', frequencyText: 'Daily' },
            halfLife: {
              valueHours: 9,
              minHours: 8,
              maxHours: 10,
              displayText: '~9 hours',
              route: 'Oral',
              kind: 'elimination',
            },
            sectionData: { ester: null, esterHalfLifeDays: null, oilPreMixed: false, c17AlphaAlkylated: true },
          }),
        ),
      );
      const dupBlocked =
        mcpDupCreate.status === 409 ||
        Boolean(mcpDupCreate.error) ||
        mcpDupCreate.result?.isError === true ||
        parseToolJson(mcpDupCreate, { allowNull: true })?.duplicate === true ||
        parseToolJson(mcpDupCreate, { allowNull: true })?.isDuplicate === true;
      assert.equal(dupBlocked, true, `MCP create_or_propose_compound must block alias duplicate Oxandrolone: ${mcpDupCreate.text}`);
      assert.ok(
        mcpDupCreate.text.includes(anavarId) || /duplicate|already exists|enrich_compound/i.test(mcpDupCreate.text),
        `Duplicate rejection must reference existing ID or enrich_compound: ${mcpDupCreate.text}`,
      );

      const listAfterDup = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']);
      assert.equal(listAfterDup.length, 1, 'Catalog must contain strictly 1 compound (zero duplicate created)');

      const enrichRes = await mcp.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(
          enrichSpec,
          anavarId,
          {
            monitoringLabs: ['ALT/AST', 'HDL/LDL Lipid Panel', 'SHBG', 'Total Testosterone'],
            notes: 'Enriched via MCP after duplicate check.',
          },
          { provenance: { sourceModel: 'ai:claude' } },
        ),
      );
      assert.equal(enrichRes.status, 200);
      assert.equal(enrichRes.error, null);
      assert.notEqual(enrichRes.result?.isError, true, `enrich_compound on existing ID failed: ${enrichRes.text}`);

      const enriched = unwrapData((await admin.get(`/api/v1/compounds/${anavarId}`)).json, ['compound']);
      assert.match(enriched.notes || '', /Enriched via MCP/i);
      assert.ok(
        Array.isArray(enriched.monitoringLabs) && enriched.monitoringLabs.length >= 1,
        `Enriched monitoringLabs must persist cleanly, got ${JSON.stringify(enriched.monitoringLabs)}`,
      );
      assert.equal(unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']).length, 1);
    } finally {
      await server.stop();
    }
  });

  it('6. AI Research Prompt Builder reflects custom field & aiResearchPrompt (+ 501 unconfigured BYOK fallback) -> REST JSON import -> immediate MCP resources/read', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
      const labField = fixtures.makeCustomSectionField({
        key: 'third_party_lab_id',
        label: 'Third-Party Lab Accreditation ID',
        fieldType: 'text',
        required: false,
        showOnCard: true,
        aiResearchInstruction: 'Record independent ISO-17025 lab accreditation identifier.',
      });
      const promptGuidance = 'Prioritize mitochondrial PK human data and specify lyophilization solvent.';

      const secPatch = await admin.patch('/api/v1/sections/peptides', {
        customFields: [labField],
        aiResearchPrompt: promptGuidance,
      });
      assert.equal(secPatch.status, 200);

      const promptRes = await admin.post('/api/v1/ai/research-prompt', {
        sectionId: 'peptides',
        compoundName: 'SS-31',
        name: 'SS-31',
      });
      assert.equal(promptRes.status, 200, `POST /api/v1/ai/research-prompt failed: ${promptRes.text}`);
      assertNoStore(promptRes, 'POST /api/v1/ai/research-prompt');
      const promptBody = promptRes.text;
      assert.match(promptBody, /SS-31/, 'Research prompt must reference requested compound name');
      assert.match(
        promptBody,
        /third_party_lab_id|Third-Party Lab Accreditation ID/,
        'Research prompt must include custom section field',
      );
      assert.ok(
        promptBody.includes('lyophilization solvent'),
        'Research prompt must include section aiResearchPrompt guidance',
      );

      const autofillRes = await admin.post('/api/v1/ai/autofill', {
        sectionId: 'peptides',
        compoundName: 'SS-31',
        name: 'SS-31',
      });
      assert.equal(
        autofillRes.status,
        501,
        `POST /api/v1/ai/autofill without BYOK key must return 501, got ${autofillRes.status}: ${autofillRes.text}`,
      );
      assert.match(
        autofillRes.text,
        /prompt|byok|api.?key|not configured|fallback/i,
        `501 autofill response must provide clear prompt fallback guidance: ${autofillRes.text}`,
      );

      const importedPayload = fixtures.makePeptideCompound({
        name: 'SS-31',
        canonicalMolecule: 'elamipretide',
        aliases: ['Elamipretide', 'MTP-131'],
        summary: 'Mitochondria-targeted tetrapeptide stabilizing cardiolipin.',
        customFields: { third_party_lab_id: 'ISO17025-LAB-8842' },
        provenance: {
          sourceModel: 'ai:claude',
          researchedAt: '2026-10-12T12:00:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [{ title: 'Elamipretide Mitochondrial Review', url: 'https://pubmed.ncbi.nlm.nih.gov/31280379/' }],
        },
      });
      const importRes = await admin.post('/api/v1/compounds', importedPayload);
      assertStatusIn(importRes, [200, 201], 'Import researched SS-31 JSON via REST');
      const ss31 = unwrapData(importRes.json, ['compound']);
      const ss31Id = getId(ss31);
      assert.ok(ss31Id);

      const readFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Gemini',
        scope: 'read',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(readFlow.ok, true, `Gemini read OAuth failed: ${readFlow.error}`);

      const mcp = createMcpClient({ baseUrl: server.baseUrl, token: readFlow.accessToken });
      await mcp.initialize({ name: 'Gemini', version: '1.0.0' });
      await mcp.notifyInitialized();

      const resourceRes = await mcp.readResource(`hub://compounds/${ss31Id}`);
      assert.equal(resourceRes.status, 200, `MCP resources/read failed: ${resourceRes.text}`);
      assert.equal(resourceRes.error, null);
      const resourceData = parseToolJson(resourceRes);
      const profile = resourceData?.compound ?? resourceData;
      assert.equal(profile?.name, 'SS-31');
      assert.equal(profile?.customFields?.third_party_lab_id, 'ISO17025-LAB-8842');
      assert.ok(typeof profile?.mechanismOfAction === 'string' && profile.mechanismOfAction.length > 0);
      assert.ok(profile?.dosages?.defaultUnit);
    } finally {
      await server.stop();
    }
  });
});
