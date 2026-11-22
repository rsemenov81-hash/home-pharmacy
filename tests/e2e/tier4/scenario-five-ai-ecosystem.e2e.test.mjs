import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  createMcpClient,
  runOAuthFlow,
  refreshOAuthToken,
  revokeOAuthToken,
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
      assert.ok(!text.includes(secret), `${label}: leaked sensitive secret in response body`);
    }
  }
}

function getId(obj) {
  return obj?.id ?? obj?.compoundId ?? obj?.proposalId ?? obj?.stackId ?? null;
}

function getToolSpec(tools, toolName) {
  assert.ok(Array.isArray(tools), 'tools/list must return an array');
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
  if ('profile' in props && !('name' in props)) return { profile: payload };
  if ('data' in props && !('name' in props)) return { data: payload };
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

function buildProposeStackChangeArgs(spec, { memberId, stackId, existingItems, addItem, rationale, provenance }) {
  const props = spec.inputSchema?.properties ?? {};
  const combinedItems = [...existingItems, addItem];
  const args = {};
  if ('memberId' in props || !('member' in props)) args.memberId = memberId;
  else args.member = memberId;
  if (stackId && ('stackId' in props || Object.keys(props).length === 0)) args.stackId = stackId;
  if ('action' in props) {
    const enumVals = props.action?.enum;
    if (Array.isArray(enumVals) && enumVals.length > 0) {
      args.action = enumVals.find((v) => /add/i.test(String(v))) ?? enumVals[0];
    } else {
      args.action = 'add_item';
    }
  }
  if ('items' in props) args.items = combinedItems;
  if ('item' in props) args.item = addItem;
  if ('addItem' in props) args.addItem = addItem;
  if ('compoundId' in props) {
    args.compoundId = addItem.compoundId;
    if ('doseAmount' in props) args.doseAmount = addItem.doseAmount;
    if ('doseUnit' in props) args.doseUnit = addItem.doseUnit;
    if ('frequency' in props) args.frequency = addItem.frequency;
  }
  if ('changes' in props) args.changes = { action: 'add_item', item: addItem, items: combinedItems };
  if ('proposedChanges' in props) args.proposedChanges = { action: 'add_item', item: addItem, items: combinedItems };
  if ('payload' in props) args.payload = { stackId, action: 'add_item', item: addItem, items: combinedItems };
  if ('rationale' in props || !('reason' in props)) args.rationale = rationale;
  else args.reason = rationale;
  if (provenance && 'provenance' in props) args.provenance = provenance;
  if (!('items' in props) && !('changes' in props) && !('proposedChanges' in props) && !('payload' in props) && !('item' in props) && !('compoundId' in props)) {
    args.items = combinedItems;
  }
  return args;
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

function buildPromptArgs(promptSpec, values) {
  const declared = Array.isArray(promptSpec?.arguments) ? promptSpec.arguments : [];
  if (declared.length === 0) return {};
  const args = {};
  for (const arg of declared) {
    const key = arg.name;
    if (/compound|substance|name/i.test(key) && !/member|stack|section/i.test(key)) {
      args[key] = values.compoundName;
    } else if (/section/i.test(key)) {
      args[key] = values.sectionId;
    } else if (/member/i.test(key)) {
      args[key] = values.memberId;
    } else if (/stack/i.test(key)) {
      args[key] = values.stackId;
    } else if (arg.required) {
      args[key] = values.memberId;
    }
  }
  return args;
}

function extractApiKeySecretAndId(res) {
  const unwrapped = unwrapData(res.json, ['key', 'apiKey']);
  const rawToken =
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
    null;
  const keyId =
    unwrapped?.id ||
    res.json?.id ||
    res.json?.key?.id ||
    res.json?.apiKey?.id ||
    res.json?.data?.id ||
    null;
  return { rawToken, keyId };
}

describe('Tier 4 — 5-AI Ecosystem Interop & Collaborative Governance Scenarios', () => {
  it('Scenario 3 — Complete 5-AI Interop Lifecycle (Claude, Gemini, Grok Bot, ChatGPT/GPT, Meta Muse) against one live hub', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      // Baseline compound + Wife stack so all 5 AIs see real live household data
      const vitDRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3 Baseline',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3', 'fat_soluble'],
          timingRules: {
            preferredSlots: ['morning_am'],
            avoidSlots: [],
            foodState: 'with_fat',
            workoutRelation: 'any',
            circadianEffect: 'neutral',
            timingNotes: 'Take with breakfast.',
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
      assertStatusIn(vitDRes, [200, 201], 'Seed baseline Vitamin D3');
      const vitDId = getId(unwrapData(vitDRes.json, ['compound']));
      assertStatusIn(
        await admin.put(`/api/v1/ownership/${vitDId}`, { scope: 'household', status: 'have' }),
        [200, 201],
        'Set baseline Vitamin D3 ownership',
      );

      const wifeStackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Core Stack',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: vitDId, doseAmount: 2000, doseUnit: 'IU' })],
        }),
      );
      assertStatusIn(wifeStackRes, [200, 201], 'Create baseline Wife stack');
      const wifeStack = unwrapData(wifeStackRes.json, ['stack']);
      const wifeStackId = getId(wifeStack);

      // 0. Unauthenticated POST /mcp MUST return 401 + RFC 9728 WWW-Authenticate header
      const unauthMcp = await server.mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: false });
      assert.equal(unauthMcp.status, 401, `Unauthenticated POST /mcp must return 401, got ${unauthMcp.status}`);
      const wwwAuth = unauthMcp.headers.get('www-authenticate') || '';
      assert.match(wwwAuth, /Bearer/i, `Missing Bearer challenge in WWW-Authenticate: "${wwwAuth}"`);
      assert.match(
        wwwAuth,
        /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource(?:\/mcp)?"/i,
        `Expected RFC 9728 resource_metadata pointer in WWW-Authenticate, got "${wwwAuth}"`,
      );
      assertNoStore(unauthMcp, 'Unauthenticated POST /mcp');

      // 1. CLAUDE — OAuth 2.1 Discovery + DCR + PKCE S256 + RFC 9207 iss + MCP 2025-06-18 (propose scope)
      const claudeFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(claudeFlow.ok, true, `Claude OAuth flow failed: ${claudeFlow.error}`);
      assert.equal(claudeFlow.discovery.protectedResource?.status, 200);
      assert.equal(claudeFlow.discovery.protectedResourceMcp?.status, 200);
      assert.equal(claudeFlow.discovery.authorizationServer?.status, 200);
      assert.ok(
        claudeFlow.authServerMetadata?.code_challenge_methods_supported?.includes('S256'),
        'AS metadata must advertise PKCE S256',
      );
      assert.equal(claudeFlow.authServerMetadata?.authorization_response_iss_parameter_supported, true);
      assert.equal(claudeFlow.authServerMetadata?.client_id_metadata_document_supported, true);
      assert.equal(claudeFlow.registration?.status, 201, 'DCR POST /oauth/register must return 201');
      assert.equal(claudeFlow.iss, server.origin, 'RFC 9207 iss redirect parameter must equal server.origin');
      assert.equal(claudeFlow.returnedState, claudeFlow.state);
      assert.ok(claudeFlow.accessToken);

      const claudeMcp = createMcpClient({
        baseUrl: server.baseUrl,
        token: claudeFlow.accessToken,
        protocolVersion: '2025-06-18',
      });
      const claudeInit = await claudeMcp.initialize({ name: 'Claude', version: '1.0.0' });
      assert.equal(claudeInit.status, 200);
      assert.equal(claudeInit.error, null);
      assert.equal(
        claudeInit.result?.protocolVersion,
        '2025-06-18',
        `Claude MCP initialize must negotiate protocolVersion 2025-06-18, got ${JSON.stringify(claudeInit.result)}`,
      );
      await claudeMcp.notifyInitialized();

      const claudeToolsRes = await claudeMcp.listTools();
      assert.equal(claudeToolsRes.status, 200);
      const claudeTools = claudeToolsRes.result?.tools ?? [];
      const claudeToolNames = new Set(claudeTools.map((t) => t.name));
      assert.ok(claudeToolNames.has('get_section_schema'));
      assert.ok(claudeToolNames.has('check_duplicate_compound'));
      assert.ok(claudeToolNames.has('create_or_propose_compound'));
      assert.ok(claudeToolNames.has('suggest_stack_schedule'));
      assert.ok(!claudeToolNames.has('configure_section'), 'propose scope must NOT expose write-only configure_section');
      assert.ok(!claudeToolNames.has('resolve_proposal'), 'propose scope must NOT expose write-only resolve_proposal');

      const schemaRes = await claudeMcp.callTool(
        'get_section_schema',
        buildSectionSchemaArgs(getToolSpec(claudeTools, 'get_section_schema'), 'peptides'),
      );
      assert.equal(schemaRes.status, 200);
      assert.equal(schemaRes.error, null);
      assert.ok(parseToolJson(schemaRes));

      const dupCheckRes = await claudeMcp.callTool(
        'check_duplicate_compound',
        buildDuplicateCheckArgs(getToolSpec(claudeTools, 'check_duplicate_compound'), {
          name: 'BPC-157',
          sectionId: 'peptides',
          route: 'SubQ',
        }),
      );
      assert.equal(dupCheckRes.status, 200);
      assert.equal(dupCheckRes.error, null);

      const claudeCreateRes = await claudeMcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(
          getToolSpec(claudeTools, 'create_or_propose_compound'),
          fixtures.makePeptideCompound({
            name: 'BPC-157',
            canonicalMolecule: 'bpc-157',
            provenance: { sourceModel: 'ai:claude' },
          }),
        ),
      );
      assert.equal(claudeCreateRes.status, 200);
      assert.equal(claudeCreateRes.error, null);
      assert.notEqual(claudeCreateRes.result?.isError, true, `Claude create BPC-157 failed: ${claudeCreateRes.text}`);

      const claudeCompound = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']).find(
        (c) => c.name === 'BPC-157',
      );
      assert.ok(claudeCompound, 'Claude-created BPC-157 must exist in catalog');
      const claudeCompoundId = getId(claudeCompound);

      const claudeSchedRes = await claudeMcp.callTool(
        'suggest_stack_schedule',
        buildSuggestScheduleArgs(getToolSpec(claudeTools, 'suggest_stack_schedule'), {
          memberId: 'member_wife',
          stackId: wifeStackId,
          dateKey: '2026-10-12',
        }),
      );
      assert.equal(claudeSchedRes.status, 200);
      assert.equal(claudeSchedRes.error, null);
      assert.notEqual(claudeSchedRes.result?.isError, true, `Claude suggest_stack_schedule returned isError: ${claudeSchedRes.text}`);
      const claudeSched = unwrapData(parseToolJson(claudeSchedRes), ['schedule']);
      assert.ok(Array.isArray(claudeSched?.systemic?.slots), 'Claude suggest_stack_schedule must return canonical systemic slots');

      // 2. GEMINI — OAuth 2.1 (read scope) + MCP 2025-06-18 Resources (all 5) & Prompts (all 3) + strict read-scope rejection
      const geminiFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Gemini',
        scope: 'read',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(geminiFlow.ok, true, `Gemini OAuth flow failed: ${geminiFlow.error}`);
      assert.ok(geminiFlow.accessToken);

      const geminiMcp = createMcpClient({
        baseUrl: server.baseUrl,
        token: geminiFlow.accessToken,
        protocolVersion: '2025-06-18',
      });
      assert.equal((await geminiMcp.initialize({ name: 'Gemini', version: '1.0.0' })).status, 200);
      await geminiMcp.notifyInitialized();

      const geminiTools = (await geminiMcp.listTools()).result?.tools ?? [];
      const geminiToolNames = new Set(geminiTools.map((t) => t.name));
      for (const readTool of [
        'get_hub_overview',
        'list_sections',
        'get_section_schema',
        'search_compounds',
        'get_compound',
        'check_duplicate_compound',
        'get_member_stack',
        'analyze_stack_interactions',
        'suggest_stack_schedule',
        'get_today_schedule',
        'list_proposals',
      ]) {
        assert.ok(geminiToolNames.has(readTool), `Gemini read scope must include "${readTool}"`);
      }
      for (const disallowedTool of [
        'create_or_propose_compound',
        'enrich_compound',
        'update_compound_ownership',
        'propose_stack_change',
        'configure_section',
        'resolve_proposal',
      ]) {
        assert.ok(!geminiToolNames.has(disallowedTool), `Gemini read scope must hide "${disallowedTool}" from tools/list`);
      }

      const resList = await geminiMcp.listResources();
      assert.equal(resList.status, 200);
      assert.equal(resList.error, null);

      for (const uri of [
        'hub://overview',
        'hub://sections',
        `hub://compounds/${claudeCompoundId}`,
        'hub://members/member_wife/stack',
        'hub://members/member_wife/schedule',
      ]) {
        const rr = await geminiMcp.readResource(uri);
        assert.equal(rr.status, 200, `Gemini readResource(${uri}) failed: ${rr.text}`);
        assert.equal(rr.error, null, `Gemini readResource(${uri}) returned RPC error`);
        const parsed = parseToolJson(rr);
        assert.ok(parsed && typeof parsed === 'object', `Gemini readResource(${uri}) must return structured JSON`);
      }

      const promptsListRes = await geminiMcp.listPrompts();
      assert.equal(promptsListRes.status, 200);
      assert.equal(promptsListRes.error, null);
      const promptsList = promptsListRes.result?.prompts ?? [];
      for (const promptName of ['research_compound', 'review_stack_safety', 'optimize_daily_schedule']) {
        const promptSpec = promptsList.find((p) => p.name === promptName);
        assert.ok(promptSpec, `prompts/list must expose "${promptName}"`);
        const promptArgs = buildPromptArgs(promptSpec, {
          compoundName: 'BPC-157',
          sectionId: 'peptides',
          memberId: 'member_wife',
          stackId: wifeStackId,
        });
        const gotPrompt = await geminiMcp.getPrompt(promptName, promptArgs);
        assert.equal(gotPrompt.status, 200, `prompts/get(${promptName}) failed: ${gotPrompt.text}`);
        assert.equal(gotPrompt.error, null);
        assert.ok(
          Array.isArray(gotPrompt.result?.messages) && gotPrompt.result.messages.length > 0,
          `prompts/get(${promptName}) must return non-empty messages[]`,
        );
      }

      const overviewRes = await geminiMcp.callTool('get_hub_overview', {});
      assert.equal(overviewRes.status, 200);
      assert.equal(overviewRes.error, null);
      assert.ok(parseToolJson(overviewRes));

      // Verify direct invocation of disallowed propose/write tools on read token is rejected with ZERO side effects
      const countBeforeGeminiAttack = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']).length;
      const proposalsBeforeGeminiAttack = unwrapData((await admin.get('/api/v1/proposals')).json, ['proposals']).length;
      const sectionBeforeGeminiAttack = unwrapData((await admin.get('/api/v1/sections/peptides')).json, ['section']);

      const blockedCreatePayload = fixtures.makePeptideCompound({
        name: 'Unauthorized Gemini Peptide',
        canonicalMolecule: 'unauth-gemini-read-scope',
        aliases: ['UGP-ReadScope-99'],
        doNotPairWith: [],
        synergies: [],
      });
      const blockedCreate = await geminiMcp.callTool(
        'create_or_propose_compound',
        buildCreateCompoundArgs(getToolSpec(claudeTools, 'create_or_propose_compound'), blockedCreatePayload),
      );
      assert.equal(
        blockedCreate.status === 403 || Boolean(blockedCreate.error) || blockedCreate.result?.isError === true,
        true,
        `Gemini read token calling create_or_propose_compound MUST be rejected, got: ${blockedCreate.text}`,
      );
      assert.doesNotMatch(
        blockedCreate.text || '',
        /duplicate|already exists|\b409\b/i,
        `Gemini read-scope rejection must NOT be a duplicate-alias collision: ${blockedCreate.text}`,
      );

      const blockedConfig = await geminiMcp.callTool('configure_section', {
        sectionId: 'peptides',
        aiResearchPrompt: 'HACKED BY READ TOKEN',
      });
      assert.equal(
        blockedConfig.status === 403 || Boolean(blockedConfig.error) || blockedConfig.result?.isError === true,
        true,
        `Gemini read token calling configure_section MUST be rejected, got: ${blockedConfig.text}`,
      );

      assert.equal(
        unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']).length,
        countBeforeGeminiAttack,
        'Rejected Gemini read-token tool call must produce zero new compounds',
      );
      assert.equal(
        unwrapData((await admin.get('/api/v1/proposals')).json, ['proposals']).length,
        proposalsBeforeGeminiAttack,
        'Rejected Gemini read-token tool call must produce zero new proposals',
      );
      const sectionAfterGeminiAttack = unwrapData((await admin.get('/api/v1/sections/peptides')).json, ['section']);
      assert.equal(
        sectionAfterGeminiAttack.aiResearchPrompt,
        sectionBeforeGeminiAttack.aiResearchPrompt,
        'Rejected Gemini configure_section call must leave section untouched',
      );

      // 3. GROK BOT — OAuth 2.1 DCR + PKCE (propose) + MCP 2024-11-05 compat + propose_stack_change + Refresh Rotation + Revocation
      const grokFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Grok Bot',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(grokFlow.ok, true, `Grok Bot OAuth flow failed: ${grokFlow.error}`);
      assert.ok(grokFlow.refreshToken, 'Grok Bot OAuth token response must issue a refresh_token');

      const grokMcp = createMcpClient({
        baseUrl: server.baseUrl,
        token: grokFlow.accessToken,
        protocolVersion: '2024-11-05',
      });
      const grokInit = await grokMcp.initialize({ name: 'Grok Bot', version: '1.0.0' });
      assert.equal(grokInit.status, 200);
      assert.equal(grokInit.error, null);
      assert.equal(
        grokInit.result?.protocolVersion,
        '2024-11-05',
        `Grok Bot MCP initialize must negotiate protocolVersion 2024-11-05, got ${JSON.stringify(grokInit.result)}`,
      );
      await grokMcp.notifyInitialized();

      const grokPing = await grokMcp.ping();
      assert.equal(grokPing.status, 200);
      assert.equal(grokPing.error, null);

      const grokTools = (await grokMcp.listTools()).result?.tools ?? [];
      const proposeStackSpec = getToolSpec(grokTools, 'propose_stack_change');
      const grokProposeRes = await grokMcp.callTool(
        'propose_stack_change',
        buildProposeStackChangeArgs(proposeStackSpec, {
          memberId: 'member_wife',
          stackId: wifeStackId,
          existingItems: wifeStack.items ?? [fixtures.makeStackItem({ compoundId: vitDId, doseAmount: 2000, doseUnit: 'IU' })],
          addItem: fixtures.makeStackItem({ compoundId: claudeCompoundId, doseAmount: 250, doseUnit: 'mcg' }),
          rationale: 'Add BPC-157 for recovery support.',
          provenance: { sourceModel: 'ai:grok' },
        }),
      );
      assert.equal(grokProposeRes.status, 200, `Grok propose_stack_change failed: ${grokProposeRes.text}`);
      assert.equal(grokProposeRes.error, null);
      assert.notEqual(grokProposeRes.result?.isError, true);

      const proposalsAfterGrok = unwrapData((await admin.get('/api/v1/proposals', { query: { status: 'pending' } })).json, ['proposals']);
      assert.ok(proposalsAfterGrok.length >= 1, 'Grok propose_stack_change must create a pending proposal');
      const realPendingProp = proposalsAfterGrok.find((p) => !p.status || p.status === 'pending') ?? proposalsAfterGrok[0];
      const realPendingPropId = getId(realPendingProp);
      assert.ok(realPendingPropId, `Expected real pending proposal ID from Grok stack proposal: ${JSON.stringify(realPendingProp)}`);

      // Verify Gemini's read-only token CANNOT approve a REAL pending proposal (never targeting a fake nonexistent ID)
      const blockedResolve = await geminiMcp.callTool('resolve_proposal', {
        proposalId: realPendingPropId,
        id: realPendingPropId,
        action: 'approve',
      });
      assert.equal(
        blockedResolve.status === 403 || Boolean(blockedResolve.error) || blockedResolve.result?.isError === true,
        true,
        `Gemini read token calling resolve_proposal on real pending proposal (${realPendingPropId}) MUST be rejected, got: ${blockedResolve.text}`,
      );
      assert.doesNotMatch(
        blockedResolve.text || '',
        /not[_\s]?found|\b404\b/i,
        `Gemini read-scope resolve_proposal rejection must NOT be a not_found error: ${blockedResolve.text}`,
      );
      const proposalsAfterBlockedResolve = unwrapData((await admin.get('/api/v1/proposals')).json, ['proposals']);
      const targetPropAfterBlocked = proposalsAfterBlockedResolve.find((p) => getId(p) === realPendingPropId);
      assert.ok(targetPropAfterBlocked, `Target proposal ${realPendingPropId} must still exist after rejected read-token resolve`);
      assert.equal(
        targetPropAfterBlocked.status ?? 'pending',
        'pending',
        `Target proposal ${realPendingPropId} must remain pending after Gemini read-token rejection`,
      );

      const liveWifeStackAfterGrok = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']).find(
        (s) => getId(s) === wifeStackId,
      );
      assert.equal(
        (liveWifeStackAfterGrok?.items ?? []).length,
        1,
        'Grok stack proposal must remain inert and NOT mutate live stack prior to approval',
      );

      // Refresh rotation + old refresh token replay rejection
      const grokRefreshed = await refreshOAuthToken({
        baseUrl: server.baseUrl,
        tokenEndpoint: grokFlow.endpoints.tokenEndpoint,
        refreshToken: grokFlow.refreshToken,
        clientId: grokFlow.clientId,
        clientSecret: grokFlow.clientSecret,
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(grokRefreshed.ok, true, `Grok refresh token failed: ${grokRefreshed.text}`);
      assert.ok(grokRefreshed.accessToken && grokRefreshed.accessToken !== grokFlow.accessToken, 'Refresh must issue a new access_token');
      assert.ok(grokRefreshed.refreshToken && grokRefreshed.refreshToken !== grokFlow.refreshToken, 'Refresh must rotate refresh_token');

      const replayOldRefresh = await refreshOAuthToken({
        baseUrl: server.baseUrl,
        tokenEndpoint: grokFlow.endpoints.tokenEndpoint,
        refreshToken: grokFlow.refreshToken,
        clientId: grokFlow.clientId,
        clientSecret: grokFlow.clientSecret,
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(replayOldRefresh.ok, false, 'Replaying rotated-out Grok refresh_token MUST fail');
      assertStatusIn(replayOldRefresh, [400, 401], 'Old refresh_token replay status');

      // Prove the rotated Grok accessToken is genuinely usable on REST & MCP BEFORE revoking it
      const grokRefreshedRest = await createApiClient({ baseUrl: server.baseUrl, token: grokRefreshed.accessToken }).get('/api/v1/compounds');
      assert.equal(
        grokRefreshedRest.status,
        200,
        `Rotated Grok accessToken must work on REST before revocation, got ${grokRefreshedRest.status}: ${grokRefreshedRest.text}`,
      );
      const grokRefreshedMcp = createMcpClient({
        baseUrl: server.baseUrl,
        token: grokRefreshed.accessToken,
        protocolVersion: '2024-11-05',
      });
      const grokRefreshedPing = await grokRefreshedMcp.ping();
      assert.equal(
        grokRefreshedPing.status,
        200,
        `Rotated Grok accessToken must work on MCP ping before revocation, got ${grokRefreshedPing.status}: ${grokRefreshedPing.text}`,
      );
      assert.equal(grokRefreshedPing.error, null, `Rotated Grok MCP ping returned unexpected error: ${grokRefreshedPing.text}`);

      // Revocation -> 401 on REST + 401 with WWW-Authenticate on MCP
      const grokRevoke = await revokeOAuthToken({
        baseUrl: server.baseUrl,
        revocationEndpoint: grokFlow.endpoints.revocationEndpoint,
        token: grokRefreshed.accessToken,
        tokenTypeHint: 'access_token',
        clientId: grokFlow.clientId,
        clientSecret: grokFlow.clientSecret,
      });
      assert.equal(grokRevoke.ok, true, `Grok revoke failed: ${grokRevoke.text}`);

      const revokedRest = await createApiClient({ baseUrl: server.baseUrl, token: grokRefreshed.accessToken }).get('/api/v1/compounds');
      assert.equal(revokedRest.status, 401, 'Revoked Grok access token must receive 401 on REST');
      const revokedMcp = await createMcpClient({ baseUrl: server.baseUrl, token: grokRefreshed.accessToken }).ping();
      assert.equal(revokedMcp.status, 401, 'Revoked Grok access token must receive 401 on POST /mcp');
      assert.match(revokedMcp.headers.get('www-authenticate') || '', /Bearer.*resource_metadata=/i);

      // 4. CHATGPT / GPT — Offline-safe CIMD HTTPS URL client_id + JSON token exchange + Public OpenAPI 3.1.0 + Bearer REST
      const cimdClientId = 'https://chatgpt.example.test/oauth/client-metadata.json';
      const cimdRedirectUri = 'https://chatgpt.example.test/oauth/callback';
      const gptFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientId: cimdClientId,
        redirectUri: cimdRedirectUri,
        scope: 'propose',
        memberId: 'member_wife',
        tokenContentType: 'application/json',
      });
      assert.equal(gptFlow.registration, null, 'CIMD flow must skip DCR (registration === null)');
      assert.equal(gptFlow.clientId, cimdClientId);
      assert.equal(gptFlow.iss, server.origin);
      assert.equal(gptFlow.ok, true, `ChatGPT CIMD OAuth flow failed: ${gptFlow.error}`);
      assert.ok(gptFlow.accessToken);

      const openapiRes = await admin.get('/openapi.json', { auth: false });
      assert.equal(openapiRes.status, 200, `GET /openapi.json failed: ${openapiRes.text}`);
      assert.match(String(openapiRes.json?.openapi || ''), /^3\.1\./, `Expected OpenAPI 3.1.x, got ${openapiRes.json?.openapi}`);
      assert.ok(openapiRes.json?.paths && openapiRes.json.paths['/api/v1/compounds'], 'OpenAPI spec must document /api/v1/compounds');
      const operationIds = Object.values(openapiRes.json.paths)
        .flatMap((pathObj) => Object.values(pathObj || {}))
        .map((op) => op?.operationId)
        .filter(Boolean);
      assert.ok(operationIds.length >= 10, `OpenAPI spec must define operationIds for GPT Actions, got ${operationIds.length}`);
      assertNoSecrets(
        openapiRes.text,
        [server.adminToken, server.passcode, claudeFlow.accessToken, gptFlow.accessToken, 'Vitamin D3 Baseline'],
        'Public GET /openapi.json',
      );

      const gptApi = createApiClient({ baseUrl: server.baseUrl, token: gptFlow.accessToken });
      const gptListRes = await gptApi.get('/api/v1/compounds');
      assert.equal(gptListRes.status, 200);
      assert.ok(unwrapData(gptListRes.json, ['compounds']).some((c) => c.name === 'BPC-157'));

      const gptCreateRes = await gptApi.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Creatine Monohydrate',
          canonicalMolecule: 'creatine',
          aliases: ['Creatine'],
          tags: ['supplement', 'performance', 'creatine'],
          dosages: { rangeText: '5 g daily', defaultAmount: 5, defaultUnit: 'g', route: 'Oral', frequencyText: 'Daily', maxCeiling: 10 },
          doNotPairWith: [],
          synergies: [],
          sectionData: {
            chemicalForm: 'Creatine Monohydrate (Micronized)',
            elementalWeightMg: null,
            supplementFacts: [{ nutrient: 'Creatine Monohydrate', amount: 5000, unit: 'mg' }],
            adultUpperLimit: null,
          },
          provenance: { sourceModel: 'ai:gpt' },
        }),
      );
      assertStatusIn(gptCreateRes, [200, 201], 'ChatGPT Bearer REST POST /api/v1/compounds');

      // 5. META MUSE — Minted Scoped API Key + /llms.txt + Authenticated context.md + MCP Batch + Key Revocation
      const mintKeyRes = await admin.post('/api/v1/keys', { name: 'Meta Muse', scope: 'propose' });
      assertStatusIn(mintKeyRes, [200, 201], 'Mint Meta Muse API key');
      const { rawToken: museRawKey, keyId: museKeyId } = extractApiKeySecretAndId(mintKeyRes);
      assert.ok(typeof museRawKey === 'string' && museRawKey.length >= 16, `Expected raw API key secret once: ${mintKeyRes.text}`);
      assert.ok(museKeyId, `Expected key id from POST /api/v1/keys: ${mintKeyRes.text}`);

      const listKeysRes = await admin.get('/api/v1/keys');
      assert.equal(listKeysRes.status, 200);
      assertNoStore(listKeysRes, 'GET /api/v1/keys');
      assert.ok(!listKeysRes.text.includes(museRawKey), 'GET /api/v1/keys MUST NEVER expose raw API key secret after creation');
      assert.match(listKeysRes.text, /Meta Muse/);

      const llmsRes = await admin.get('/llms.txt', { auth: false });
      assert.equal(llmsRes.status, 200, `Public GET /llms.txt failed: ${llmsRes.text}`);
      assert.match(llmsRes.text, /\/mcp/, '/llms.txt must document /mcp endpoint');
      assert.match(llmsRes.text, /\/openapi\.json/, '/llms.txt must document /openapi.json');
      assertNoSecrets(
        llmsRes.text,
        [
          server.adminToken,
          server.passcode,
          museRawKey,
          claudeFlow.accessToken,
          geminiFlow.accessToken,
          gptFlow.accessToken,
          'Vitamin D3 Baseline',
          'Creatine Monohydrate',
        ],
        'Public GET /llms.txt zero-PII & zero-secrets',
      );

      const museApi = createApiClient({ baseUrl: server.baseUrl, token: museRawKey });
      const contextMdRes = await museApi.get('/api/v1/export/context.md');
      assert.equal(contextMdRes.status, 200, `Meta Muse GET /api/v1/export/context.md failed: ${contextMdRes.text}`);
      assertNoStore(contextMdRes, 'GET /api/v1/export/context.md');
      assert.match(contextMdRes.text, /BPC-157/);
      assert.match(contextMdRes.text, /Creatine Monohydrate/);
      const museSecrets = [
        server.adminToken,
        server.passcode,
        museRawKey,
        claudeFlow.accessToken,
        claudeFlow.refreshToken,
        geminiFlow.accessToken,
        grokRefreshed.accessToken,
        gptFlow.accessToken,
      ];
      assertNoSecrets(contextMdRes.text, museSecrets, 'Authenticated GET /api/v1/export/context.md zero-secrets');

      const contextJsonRes = await museApi.get('/api/v1/export/context.json');
      assert.equal(contextJsonRes.status, 200, `Meta Muse GET /api/v1/export/context.json failed: ${contextJsonRes.text}`);
      assertNoStore(contextJsonRes, 'GET /api/v1/export/context.json');
      assert.ok(contextJsonRes.json && typeof contextJsonRes.json === 'object');
      assertNoSecrets(contextJsonRes.text, museSecrets, 'Authenticated GET /api/v1/export/context.json zero-secrets');

      const museMcp = createMcpClient({ baseUrl: server.baseUrl, token: museRawKey });
      assert.equal((await museMcp.initialize({ name: 'Meta Muse', version: '1.0.0' })).status, 200);
      await museMcp.notifyInitialized();

      const batchRes = await museMcp.batch([
        { id: 101, method: 'ping', params: {} },
        { id: 102, method: 'tools/call', params: { name: 'list_sections', arguments: {} } },
        { id: 103, method: 'tools/call', params: { name: 'get_hub_overview', arguments: {} } },
      ]);
      assert.equal(batchRes.status, 200, `Meta Muse MCP batch failed: ${batchRes.text}`);
      assert.equal(batchRes.responses.length, 3, `Expected 3 JSON-RPC batch responses, got ${batchRes.responses.length}`);
      for (const item of batchRes.responses) {
        assert.equal(item.error ?? null, null, `Unexpected batch JSON-RPC error: ${JSON.stringify(item)}`);
        assert.ok(item.result, `Expected result in batch response: ${JSON.stringify(item)}`);
        assert.notEqual(item.result?.isError, true, `Batch response returned isError: true: ${JSON.stringify(item)}`);
      }
      const pingResp = batchRes.responses.find((r) => r.id === 101) ?? batchRes.responses[0];
      const sectionsResp = batchRes.responses.find((r) => r.id === 102) ?? batchRes.responses[1];
      const overviewResp = batchRes.responses.find((r) => r.id === 103) ?? batchRes.responses[2];
      assert.ok(pingResp?.result, 'Batch ping response must carry result');
      const sectionsBatchJson = parseToolJson(sectionsResp);
      assert.match(JSON.stringify(sectionsBatchJson), /vitamins_supplements/, 'Batch list_sections must include core sections');
      const overviewBatchJson = parseToolJson(overviewResp);
      assert.ok(overviewBatchJson && typeof overviewBatchJson === 'object');

      // Revoke Meta Muse API key -> 401 on REST and MCP
      assertStatusIn(await admin.del(`/api/v1/keys/${museKeyId}`), [200, 204], 'DELETE Meta Muse API key');
      assert.equal((await museApi.get('/api/v1/compounds')).status, 401, 'Revoked Meta Muse key must receive 401 on REST');
      assert.equal((await museMcp.ping()).status, 401, 'Revoked Meta Muse key must receive 401 on MCP');
    } finally {
      await server.stop();
    }
  });

  it('Scenario 4 — Collaborative Multi-AI Compound Research, Verified-Field Protection, Proposal Governance (Approve+Edits & Dismiss) & Multi-Actor Audit Trail', async () => {
    const server = await startE2EServer();
    try {
      const admin = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      // 1. Household user customizes peptides section with required coa_url & custom aiResearchPrompt
      const coaField = fixtures.makeCustomSectionField({
        key: 'coa_url',
        label: 'COA Verification URL',
        fieldType: 'url',
        required: true,
        showOnCard: true,
        aiResearchInstruction: 'Include third-party HPLC COA verification URL.',
      });
      const promptRule = 'Always report HPLC purity COA URL and mitochondrial mechanism evidence tier.';
      assert.equal(
        (await admin.patch('/api/v1/sections/peptides', { customFields: [coaField], aiResearchPrompt: promptRule })).status,
        200,
      );

      const promptBuilderRes = await admin.post('/api/v1/ai/research-prompt', {
        sectionId: 'peptides',
        compoundName: 'MOTS-c',
        name: 'MOTS-c',
      });
      assert.equal(promptBuilderRes.status, 200);
      assertNoStore(promptBuilderRes, 'POST /api/v1/ai/research-prompt');
      assert.match(promptBuilderRes.text, /coa_url|COA Verification URL/);
      assert.ok(promptBuilderRes.text.includes('HPLC purity COA URL'));

      // Baseline Wife stack with 1 supplement so Grok can propose adding MOTS-c later
      const vitDRes = await admin.post(
        '/api/v1/compounds',
        fixtures.makeSupplementCompound({
          name: 'Vitamin D3',
          canonicalMolecule: 'vitamin-d3',
          aliases: ['Cholecalciferol'],
          tags: ['supplement', 'vitamin', 'vitamin_d3', 'fat_soluble'],
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
      assertStatusIn(vitDRes, [200, 201], 'Create Scenario 4 baseline Vitamin D3');
      const vitDId = getId(unwrapData(vitDRes.json, ['compound']));

      const wifeStackRes = await admin.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Wife Mitochondrial Stack',
          memberId: 'member_wife',
          items: [fixtures.makeStackItem({ compoundId: vitDId, doseAmount: 2000, doseUnit: 'IU' })],
        }),
      );
      assertStatusIn(wifeStackRes, [200, 201], 'Create Scenario 4 Wife Mitochondrial Stack');
      const wifeStack = unwrapData(wifeStackRes.json, ['stack']);
      const wifeStackId = getId(wifeStack);

      // 2. AI #1 (Claude, OAuth propose) discovers schema, checks dup, rejects missing coa_url, creates MOTS-c ai_draft
      const claudeFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Claude',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(claudeFlow.ok, true, `Claude OAuth failed: ${claudeFlow.error}`);

      const claudeMcp = createMcpClient({ baseUrl: server.baseUrl, token: claudeFlow.accessToken });
      await claudeMcp.initialize({ name: 'Claude', version: '1.0.0' });
      await claudeMcp.notifyInitialized();
      const claudeTools = (await claudeMcp.listTools()).result?.tools ?? [];

      const schemaJson = parseToolJson(
        await claudeMcp.callTool('get_section_schema', buildSectionSchemaArgs(getToolSpec(claudeTools, 'get_section_schema'), 'peptides')),
      );
      assert.match(JSON.stringify(schemaJson), /coa_url/);
      assert.ok(JSON.stringify(schemaJson).includes('HPLC purity COA URL'));

      const dupJson = parseToolJson(
        await claudeMcp.callTool(
          'check_duplicate_compound',
          buildDuplicateCheckArgs(getToolSpec(claudeTools, 'check_duplicate_compound'), {
            name: 'MOTS-c',
            sectionId: 'peptides',
            route: 'SubQ',
          }),
        ),
      );
      assert.ok(dupJson?.isDuplicate !== true && dupJson?.duplicate !== true, 'MOTS-c should not be a duplicate yet');

      const motscBase = fixtures.makePeptideCompound({
        name: 'MOTS-c',
        canonicalMolecule: 'mots-c',
        aliases: ['Mitochondrial Open Reading Frame of the 12S rRNA-c'],
        dosages: {
          rangeText: '5 mg twice weekly SubQ',
          defaultAmount: 5,
          defaultUnit: 'mg',
          route: 'SubQ',
          frequencyText: '2x/week',
          maxCeiling: 15,
        },
        customFields: {},
        provenance: {
          sourceModel: 'ai:claude',
          researchedAt: '2026-10-12T10:00:00.000Z',
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [{ title: 'MOTS-c Exercise & Metabolic Homeostasis', url: 'https://pubmed.ncbi.nlm.nih.gov/33473109/' }],
        },
      });
      const createSpec = getToolSpec(claudeTools, 'create_or_propose_compound');
      const missingRes = await claudeMcp.callTool('create_or_propose_compound', buildCreateCompoundArgs(createSpec, motscBase));
      assert.equal(
        missingRes.status === 422 || missingRes.status === 400 || Boolean(missingRes.error) || missingRes.result?.isError === true,
        true,
        `Expected missing required coa_url rejection, got: ${missingRes.text}`,
      );

      const motscComplete = {
        ...motscBase,
        customFields: { coa_url: 'https://lab-coa.example.test/mots-c-hplc.pdf' },
      };
      const createdRes = await claudeMcp.callTool('create_or_propose_compound', buildCreateCompoundArgs(createSpec, motscComplete));
      assert.equal(createdRes.status, 200);
      assert.equal(createdRes.error, null);
      assert.notEqual(createdRes.result?.isError, true, `Claude create MOTS-c failed: ${createdRes.text}`);

      const motsc = unwrapData((await admin.get('/api/v1/compounds')).json, ['compounds']).find((c) => c.name === 'MOTS-c');
      assert.ok(motsc, 'MOTS-c must be created as ai_draft');
      assert.equal(motsc.profileStatus, 'ai_draft');
      assert.equal(motsc.customFields?.coa_url, 'https://lab-coa.example.test/mots-c-hplc.pdf');
      const motscId = getId(motsc);

      // 3. Household User verifies MOTS-c -> profileStatus: 'verified'
      assert.equal((await admin.post(`/api/v1/compounds/${motscId}/verify`, {})).status, 200);
      const verifiedMotsc = unwrapData((await admin.get(`/api/v1/compounds/${motscId}`)).json, ['compound']);
      assert.equal(verifiedMotsc.profileStatus, 'verified');

      // 4. AI #2 (Gemini, OAuth propose) attempts overwrite of verified dosage -> routed to Proposals Inbox
      const geminiFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Gemini',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(geminiFlow.ok, true, `Gemini OAuth failed: ${geminiFlow.error}`);

      const geminiMcp = createMcpClient({ baseUrl: server.baseUrl, token: geminiFlow.accessToken });
      await geminiMcp.initialize({ name: 'Gemini', version: '1.0.0' });
      await geminiMcp.notifyInitialized();
      const geminiTools = (await geminiMcp.listTools()).result?.tools ?? [];
      const enrichSpec = getToolSpec(geminiTools, 'enrich_compound');

      const geminiEnrich1 = await geminiMcp.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(
          enrichSpec,
          motscId,
          {
            dosages: {
              rangeText: '10 mg 3x/week SubQ',
              defaultAmount: 10,
              defaultUnit: 'mg',
              route: 'SubQ',
              frequencyText: '3x/week',
              maxCeiling: 15,
            },
          },
          { provenance: { sourceModel: 'ai:gemini' }, rationale: 'Alternative higher metabolic dosing.' },
        ),
      );
      assert.equal(geminiEnrich1.status, 200);
      assert.equal(geminiEnrich1.error, null);

      const liveAfterGemini1 = unwrapData((await admin.get(`/api/v1/compounds/${motscId}`)).json, ['compound']);
      assert.equal(liveAfterGemini1.dosages?.defaultAmount, 5, 'Verified MOTS-c dosage must NOT be overwritten by Gemini');

      const pending1 = unwrapData((await admin.get('/api/v1/proposals', { query: { status: 'pending' } })).json, ['proposals']);
      const geminiProp1 = pending1.find((p) => (!p.status || p.status === 'pending') && JSON.stringify(p).includes(motscId));
      assert.ok(geminiProp1, 'Gemini overwrite attempt must appear as pending proposal');
      const geminiProp1Id = getId(geminiProp1);

      // 5a. User approves Gemini proposal #1 WITH edits
      const approveWithEditsRes = await admin.post(`/api/v1/proposals/${geminiProp1Id}/resolve`, {
        action: 'approve',
        edits: {
          dosages: {
            rangeText: '7.5 mg twice weekly SubQ (household calibrated)',
            defaultAmount: 7.5,
            defaultUnit: 'mg',
            route: 'SubQ',
            frequencyText: '2x/week',
            maxCeiling: 15,
          },
        },
      });
      assert.equal(approveWithEditsRes.status, 200, `Approve-with-edits failed: ${approveWithEditsRes.text}`);

      const afterApproveEdits = unwrapData((await admin.get(`/api/v1/compounds/${motscId}`)).json, ['compound']);
      assert.equal(afterApproveEdits.dosages?.defaultAmount, 7.5, 'User edits in proposal approval must apply');

      // 5b. Gemini submits second enrichment proposal -> User dismisses -> compound remains untouched
      const geminiEnrich2 = await geminiMcp.callTool(
        'enrich_compound',
        buildEnrichCompoundArgs(
          enrichSpec,
          motscId,
          {
            dosages: {
              rangeText: '20 mg daily (aggressive)',
              defaultAmount: 20,
              defaultUnit: 'mg',
              route: 'SubQ',
              frequencyText: 'Daily',
              maxCeiling: 25,
            },
          },
          { provenance: { sourceModel: 'ai:gemini' }, rationale: 'Aggressive protocol to be dismissed.' },
        ),
      );
      assert.equal(geminiEnrich2.status, 200);
      assert.equal(geminiEnrich2.error, null);

      const pending2 = unwrapData((await admin.get('/api/v1/proposals', { query: { status: 'pending' } })).json, ['proposals']);
      const geminiProp2 = pending2.find(
        (p) => getId(p) !== geminiProp1Id && (!p.status || p.status === 'pending') && JSON.stringify(p).includes(motscId),
      );
      assert.ok(geminiProp2, 'Second Gemini overwrite attempt must create a new pending proposal');
      const geminiProp2Id = getId(geminiProp2);

      const dismissRes = await admin.post(`/api/v1/proposals/${geminiProp2Id}/resolve`, { action: 'dismiss' });
      assert.equal(dismissRes.status, 200, `Dismiss proposal failed: ${dismissRes.text}`);

      const afterDismiss = unwrapData((await admin.get(`/api/v1/compounds/${motscId}`)).json, ['compound']);
      assert.equal(afterDismiss.dosages?.defaultAmount, 7.5, 'Dismissed proposal MUST leave verified compound unchanged');

      // 6. AI #3 (Grok Bot, OAuth propose) proposes adding MOTS-c to Wife's stack -> pending -> User approves
      const grokFlow = await runOAuthFlow({
        baseUrl: server.baseUrl,
        passcode: server.passcode,
        clientName: 'Grok Bot',
        scope: 'propose',
        memberId: 'member_wife',
        resource: `${server.baseUrl}/mcp`,
      });
      assert.equal(grokFlow.ok, true, `Grok OAuth failed: ${grokFlow.error}`);

      const grokMcp = createMcpClient({ baseUrl: server.baseUrl, token: grokFlow.accessToken, protocolVersion: '2024-11-05' });
      await grokMcp.initialize({ name: 'Grok Bot', version: '1.0.0' });
      await grokMcp.notifyInitialized();
      const grokTools = (await grokMcp.listTools()).result?.tools ?? [];

      const grokStackRes = await grokMcp.callTool(
        'propose_stack_change',
        buildProposeStackChangeArgs(getToolSpec(grokTools, 'propose_stack_change'), {
          memberId: 'member_wife',
          stackId: wifeStackId,
          existingItems: wifeStack.items ?? [fixtures.makeStackItem({ compoundId: vitDId, doseAmount: 2000, doseUnit: 'IU' })],
          addItem: fixtures.makeStackItem({
            compoundId: motscId,
            doseAmount: 7.5,
            doseUnit: 'mg',
            frequency: '2x_weekly',
            cadence: { type: 'weekly', daysOfWeek: [1, 4] },
          }),
          rationale: 'Add verified MOTS-c to Wife mitochondrial stack.',
          provenance: { sourceModel: 'ai:grok' },
        }),
      );
      assert.equal(grokStackRes.status, 200, `Grok propose_stack_change failed: ${grokStackRes.text}`);
      assert.equal(grokStackRes.error, null);
      assert.notEqual(grokStackRes.result?.isError, true);

      const wifeStackBeforeApprove = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']).find(
        (s) => getId(s) === wifeStackId,
      );
      assert.equal(
        (wifeStackBeforeApprove?.items ?? []).length,
        1,
        'Live Wife stack must remain unchanged until user approves Grok proposal',
      );

      const pending3 = unwrapData((await admin.get('/api/v1/proposals', { query: { status: 'pending' } })).json, ['proposals']);
      const grokProp = pending3.find(
        (p) =>
          getId(p) !== geminiProp1Id &&
          getId(p) !== geminiProp2Id &&
          (!p.status || p.status === 'pending') &&
          (JSON.stringify(p).includes(motscId) || JSON.stringify(p).includes(wifeStackId)),
      );
      assert.ok(grokProp, 'Grok stack proposal must appear in pending Proposals Inbox');
      const grokPropId = getId(grokProp);

      const approveStackRes = await admin.post(`/api/v1/proposals/${grokPropId}/resolve`, { action: 'approve' });
      assert.equal(approveStackRes.status, 200, `Approve Grok stack proposal failed: ${approveStackRes.text}`);

      const wifeStackAfterApprove = unwrapData((await admin.get('/api/v1/members/member_wife/stacks')).json, ['stacks']).find(
        (s) => getId(s) === wifeStackId,
      );
      assert.ok(
        (wifeStackAfterApprove?.items ?? []).some((i) => i.compoundId === motscId),
        'Approved Grok stack proposal must add MOTS-c to Wife live stack',
      );

      // 7. Immutable Audit Log records distinct timestamped entries across Household User, Claude, Gemini, and Grok Bot
      const auditRes = await admin.get('/api/v1/audit-log');
      assert.equal(auditRes.status, 200, `GET /api/v1/audit-log failed: ${auditRes.text}`);
      assertNoStore(auditRes, 'GET /api/v1/audit-log');
      const entries = unwrapData(auditRes.json, ['auditLog', 'audit_log', 'entries', 'items']);
      assert.ok(Array.isArray(entries) && entries.length >= 6, `Expected rich multi-actor audit log, got ${entries.length} entries`);
      for (const entry of entries) {
        assert.ok(entry.timestamp || entry.createdAt || entry.at, 'Audit entry must be timestamped');
        assert.ok(
          entry.actor || entry.actorId || entry.clientName || entry.sourceModel || entry.memberId,
          `Audit entry must record actor attribution: ${JSON.stringify(entry)}`,
        );
      }
      const actorBlob = entries
        .map((e) => [e.actor, e.actorId, e.clientName, e.sourceModel, e.memberId].filter(Boolean).join(' '))
        .join('\n');
      assert.match(actorBlob, /claude/i, `Audit log actor fields must attribute Claude actions: ${actorBlob}`);
      assert.match(actorBlob, /gemini/i, `Audit log actor fields must attribute Gemini actions: ${actorBlob}`);
      assert.match(actorBlob, /grok/i, `Audit log actor fields must attribute Grok Bot actions: ${actorBlob}`);
      assert.match(
        actorBlob,
        /admin|member|wife|husband|user|household/i,
        `Audit log actor fields must attribute Household User actions: ${actorBlob}`,
      );
    } finally {
      await server.stop();
    }
  });
});
