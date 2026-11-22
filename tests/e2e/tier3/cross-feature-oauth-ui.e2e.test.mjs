import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  runOAuthFlow,
  createMcpClient,
  parseToolJson,
  launchBrowser,
  unwrapData,
  fixtures,
} from '../harness.mjs';

const CORE_SECTIONS = ['peptides', 'peds', 'vitamins_supplements', 'dermatology'];

// ---------------------------------------------------------------------------
// Opaque-Box UI & MCP Schema-Discovery Helpers
// ---------------------------------------------------------------------------

function compoundCardLocator(page, compound) {
  const selectors = [];
  if (compound?.id) selectors.push(`[data-testid="compound-card-${compound.id}"]`);
  if (compound?.slug && compound.slug !== compound.id) {
    selectors.push(`[data-testid="compound-card-${compound.slug}"]`);
  }
  assert.ok(selectors.length > 0, 'compoundCardLocator requires compound.id or compound.slug');
  return page.locator(selectors.join(', ')).first();
}

async function selectMember(page, memberId) {
  const switcher = page.locator('[data-testid="member-switcher"]').first();
  await switcher.waitFor({ state: 'visible', timeout: 10_000 });
  const tagName = await switcher.evaluate((el) => el.tagName.toUpperCase());

  if (tagName === 'SELECT') {
    const optionLoc = page.locator(`[data-testid="member-option-${memberId}"]`);
    assert.ok(
      (await optionLoc.count()) > 0,
      `Expected <option data-testid="member-option-${memberId}"> inside member-switcher`
    );
    await switcher.selectOption(memberId);
    assert.equal(await switcher.inputValue(), memberId);
    return;
  }

  const optionLoc = page.locator(`[data-testid="member-option-${memberId}"]`).first();
  if (!(await optionLoc.isVisible())) {
    await switcher.click();
  }
  await optionLoc.waitFor({ state: 'visible', timeout: 5_000 });
  await optionLoc.click();
}

async function selectOptionOnControl(page, controlLocator, { value, labelRe }) {
  await controlLocator.waitFor({ state: 'visible', timeout: 10_000 });
  const tagName = await controlLocator.evaluate((el) => el.tagName.toUpperCase());

  if (tagName === 'SELECT') {
    const matchedValue = await controlLocator.evaluate(
      (sel, arg) => {
        const re = arg.pattern ? new RegExp(arg.pattern, 'i') : null;
        for (const opt of Array.from(sel.options)) {
          if (arg.value && opt.value === arg.value) return opt.value;
          if (re && (re.test(opt.value) || re.test(opt.textContent || ''))) return opt.value;
        }
        return null;
      },
      { value: value ?? null, pattern: labelRe ? labelRe.source : null }
    );
    assert.ok(matchedValue !== null, `Expected matching option (${value || labelRe}) inside <select>`);
    await controlLocator.selectOption(matchedValue);
    return matchedValue;
  }

  const nestedSelect = controlLocator.locator('select').first();
  if ((await nestedSelect.count()) > 0 && (await nestedSelect.isVisible())) {
    return selectOptionOnControl(page, nestedSelect, { value, labelRe });
  }

  const matcher = labelRe || new RegExp(`^${String(value).replace(/[_-]/g, '[\\s_-]?')}$`, 'i');
  const innerBtn = controlLocator
    .locator('button, [role="option"], [role="tab"], [role="radio"]')
    .filter({ hasText: matcher })
    .first();
  if ((await innerBtn.count()) > 0 && (await innerBtn.isVisible())) {
    await innerBtn.click();
    return value ?? matcher.source;
  }

  await controlLocator.click();
  const popupOpt = page
    .locator('[role="option"], [role="menuitem"], [role="listbox"] button')
    .filter({ hasText: matcher })
    .first();
  await popupOpt.waitFor({ state: 'visible', timeout: 5_000 });
  await popupOpt.click();
  return value ?? matcher.source;
}

async function firstVisibleFrom(container, selectors) {
  for (const sel of selectors) {
    const loc = container.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible())) {
      return loc;
    }
  }
  return null;
}

async function waitForCondition(fn, { timeoutMs = 10_000, intervalMs = 150, message = 'Condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await fn();
    if (lastResult) return lastResult;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  assert.fail(`${message} (lastResult=${JSON.stringify(lastResult)})`);
}

async function extractCandidateSecretTokens(page) {
  return page.evaluate(() => {
    const found = new Set();
    const tokenRe = /[A-Za-z0-9._-]{20,}/g;
    const scanText = (str) => {
      if (!str) return;
      for (const m of String(str).matchAll(tokenRe)) {
        const candidate = m[0];
        if (!/^https?:\/\//i.test(candidate) && !candidate.includes('://')) {
          found.add(candidate);
        }
      }
    };
    scanText(document.body?.innerText || '');
    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.value) scanText(el.value);
    }
    return Array.from(found);
  });
}

async function initMcpAndListTools(baseUrl, token) {
  const mcp = createMcpClient({ baseUrl, token });
  const initRes = await mcp.initialize({ name: 'home-pharmacy-tier3-e2e', version: '1.0.0' });
  assert.equal(initRes.status, 200, `MCP initialize failed (${initRes.status}): ${initRes.text}`);
  assert.equal(initRes.error, null, `MCP initialize error: ${JSON.stringify(initRes.error)}`);

  await mcp.notifyInitialized();

  const listRes = await mcp.listTools();
  assert.equal(listRes.status, 200, `MCP tools/list failed (${listRes.status}): ${listRes.text}`);
  assert.equal(listRes.error, null, `MCP tools/list error: ${JSON.stringify(listRes.error)}`);
  const tools = listRes.result?.tools;
  assert.ok(Array.isArray(tools), `Expected tools array from tools/list: ${listRes.text}`);

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  return { mcp, tools, toolMap };
}

function pickPropKey(props, candidates, fallback) {
  if (props && typeof props === 'object') {
    for (const key of candidates) {
      if (Object.prototype.hasOwnProperty.call(props, key)) return key;
    }
  }
  return fallback;
}

function buildProposeStackArgs(toolDef, { memberId, stackId, compoundId, doseAmount, doseUnit, reason }) {
  const props = toolDef?.inputSchema?.properties || {};
  const args = {};

  const memberKey = pickPropKey(props, ['memberId', 'member_id', 'member'], 'memberId');
  args[memberKey] = memberId;

  if (Object.prototype.hasOwnProperty.call(props, 'stackId') || Object.prototype.hasOwnProperty.call(props, 'stack_id')) {
    const stackKey = pickPropKey(props, ['stackId', 'stack_id'], 'stackId');
    args[stackKey] = stackId;
  }

  const stackItem = {
    compoundId,
    doseAmount,
    doseUnit,
    frequency: 'daily',
    enabled: true,
  };

  if (Object.prototype.hasOwnProperty.call(props, 'action') || Object.prototype.hasOwnProperty.call(props, 'operation')) {
    const actKey = pickPropKey(props, ['action', 'operation'], 'action');
    const enumVals = props[actKey]?.enum;
    if (Array.isArray(enumVals) && enumVals.length > 0) {
      const addOpt = enumVals.find((v) => /add/i.test(String(v))) || enumVals[0];
      args[actKey] = addOpt;
    } else {
      args[actKey] = 'add';
    }
  }

  if (Object.prototype.hasOwnProperty.call(props, 'compoundId') || Object.prototype.hasOwnProperty.call(props, 'compound_id')) {
    const cmpKey = pickPropKey(props, ['compoundId', 'compound_id'], 'compoundId');
    args[cmpKey] = compoundId;
  }
  if (Object.prototype.hasOwnProperty.call(props, 'doseAmount')) args.doseAmount = doseAmount;
  if (Object.prototype.hasOwnProperty.call(props, 'doseUnit')) args.doseUnit = doseUnit;

  if (Object.prototype.hasOwnProperty.call(props, 'addItems')) {
    args.addItems = [stackItem];
  } else if (Object.prototype.hasOwnProperty.call(props, 'items')) {
    args.items = [stackItem];
  } else if (Object.prototype.hasOwnProperty.call(props, 'changes')) {
    args.changes = props.changes?.type === 'array' ? [{ action: 'add', ...stackItem }] : { add: [stackItem] };
  } else if (Object.prototype.hasOwnProperty.call(props, 'item')) {
    args.item = stackItem;
  } else if (!args.compoundId && !args.compound_id) {
    args.compoundId = compoundId;
    args.items = [stackItem];
  }

  const reasonKey = pickPropKey(props, ['reason', 'summary', 'rationale', 'notes'], 'reason');
  args[reasonKey] = reason;

  return args;
}

function buildCreateCompoundArgs(toolDef, compoundPayload) {
  const props = toolDef?.inputSchema?.properties || {};
  if (Object.prototype.hasOwnProperty.call(props, 'compound') && !Object.prototype.hasOwnProperty.call(props, 'name')) {
    return { compound: compoundPayload };
  }
  if (Object.prototype.hasOwnProperty.call(props, 'profile') && !Object.prototype.hasOwnProperty.call(props, 'name')) {
    return { profile: compoundPayload };
  }
  return compoundPayload;
}

function extractCompoundArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const key of ['compounds', 'items', 'results', 'matches', 'data']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tier 3: Cross-Feature OAuth 2.1 + MCP + Playwright UI E2E Suite (4 Tests)
// ---------------------------------------------------------------------------

describe('Tier 3: Cross-Feature OAuth 2.1 / MCP + Playwright Browser UI E2E', () => {
  let server;
  let api;
  let browserHandle;

  before(async () => {
    server = await startE2EServer();
    api = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });
    browserHandle = await launchBrowser({ viewport: { width: 1280, height: 800 } });
  });

  after(async () => {
    try {
      if (browserHandle) await browserHandle.close();
    } finally {
      if (server) await server.stop();
    }
  });

  it('T3-01: OAuth 2.1 DCR + PKCE S256 (propose) -> MCP propose_stack_change -> Chromium UI approve -> Stack & Schedule updated', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    // 1. Seed compound & initial stack for member_wife
    const cmpRes = await api.post(
      '/api/v1/compounds',
      fixtures.makeSupplementCompound({
        name: 'Magnesium Glycinate CrossFeature',
        canonicalMolecule: 'magnesium-cross-feature',
        profileStatus: 'verified',
      })
    );
    assert.ok(cmpRes.status === 200 || cmpRes.status === 201, `Create compound failed: ${cmpRes.text}`);
    const compound = unwrapData(cmpRes.json, 'compound');
    assert.ok(compound?.id);

    const ownRes = await api.put(`/api/v1/ownership/${encodeURIComponent(compound.id)}`, {
      scope: 'household',
      status: 'have',
      remainingDoses: 30,
    });
    assert.equal(ownRes.status, 200);

    const stackRes = await api.post(
      '/api/v1/members/member_wife/stacks',
      fixtures.makeStackPayload({
        name: 'Wife Cross-Feature Stack',
        memberId: 'member_wife',
        active: true,
        items: [],
      })
    );
    assert.ok(stackRes.status === 200 || stackRes.status === 201, `Create stack failed: ${stackRes.text}`);
    const stack = unwrapData(stackRes.json, 'stack');
    assert.ok(stack?.id);

    // 2. Real OAuth 2.1 DCR -> PKCE S256 consent -> token exchange with scope="propose"
    const oauth = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      memberId: 'member_wife',
      resource: `${server.baseUrl}/mcp`,
      clientName: 'Claude Tier3 Cross-Feature E2E',
    });
    assert.equal(oauth.ok, true, `OAuth 2.1 flow failed: ${oauth.error}`);
    assert.equal(oauth.iss, server.origin, 'Expected RFC 9207 iss parameter to match server origin');
    assert.equal(oauth.returnedState, oauth.state, 'Expected state CSRF roundtrip match');
    assert.ok(oauth.accessToken, 'Expected non-empty OAuth access_token');

    // 3. External AI calls MCP propose_stack_change via opaque-box tools/list schema discovery
    const { mcp, toolMap } = await initMcpAndListTools(server.baseUrl, oauth.accessToken);
    const proposeTool = toolMap.get('propose_stack_change');
    assert.ok(proposeTool, 'Expected canonical MCP tool "propose_stack_change" in tools/list for propose scope');

    // Verify write-only tool resolve_proposal is denied or hidden for propose-only token
    if (toolMap.has('resolve_proposal')) {
      const deniedRes = await mcp.callTool('resolve_proposal', { proposalId: 'nonexistent', action: 'approve' });
      assert.ok(
        deniedRes.status === 403 || deniedRes.error !== null || deniedRes.result?.isError === true,
        'propose-scoped OAuth token MUST NOT execute write-only resolve_proposal'
      );
    }

    const proposeArgs = buildProposeStackArgs(proposeTool, {
      memberId: 'member_wife',
      stackId: stack.id,
      compoundId: compound.id,
      doseAmount: 200,
      doseUnit: 'mg',
      reason: 'Add Magnesium Glycinate CrossFeature for evening sleep support',
    });
    const proposeRes = await mcp.callTool('propose_stack_change', proposeArgs);
    assert.equal(proposeRes.status, 200, `MCP propose_stack_change HTTP failed: ${proposeRes.text}`);
    assert.equal(proposeRes.error, null, `MCP propose_stack_change JSON-RPC error: ${JSON.stringify(proposeRes.error)}`);
    assert.notEqual(
      proposeRes.result?.isError,
      true,
      `MCP propose_stack_change returned tool isError=true: ${proposeRes.text}`
    );
    const proposePayload = parseToolJson(proposeRes);
    assert.ok(proposePayload, 'Expected structured JSON response from propose_stack_change');

    // 4. Confirm pending proposal via REST API
    const pendingProposal = await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/proposals');
        if (res.status !== 200) return null;
        const proposals = unwrapData(res.json, ['proposals', 'items']) || [];
        return (
          proposals.find(
            (p) =>
              /pending|open/i.test(String(p.status || 'pending')) &&
              (JSON.stringify(p).includes(compound.id) || JSON.stringify(p).includes('Magnesium Glycinate CrossFeature'))
          ) || null
        );
      },
      { message: 'Expected pending stack-change proposal in GET /api/v1/proposals' }
    );
    assert.ok(pendingProposal.id, 'Pending proposal must have an id');

    // 5. User opens AI Hub in Playwright Chromium and approves the proposal
    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });
    await page.locator('[data-testid="nav-ai-hub"]').first().click();

    const proposalsList = page.locator('[data-testid="ai-proposals-list"]').first();
    await proposalsList.waitFor({ state: 'visible', timeout: 10_000 });

    const approveBtn = page.locator(`[data-testid="btn-approve-proposal-${pendingProposal.id}"]`).first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await approveBtn.click();

    // 6. Verify approval persisted to stack & visible in Stack Builder Systemic Timeline
    await waitForCondition(
      async () => {
        const stacksRes = await api.get('/api/v1/members/member_wife/stacks');
        const stacks = unwrapData(stacksRes.json, ['stacks', 'items']) || [];
        return stacks.some((s) => (s.items || []).some((i) => i.compoundId === compound.id));
      },
      { message: 'Expected approved stack proposal to add Magnesium Glycinate CrossFeature to member_wife stack' }
    );

    await selectMember(page, 'member_wife');
    await page.locator('[data-testid="nav-stack"]').first().click();
    const timeline = page.locator('[data-testid="spread-systemic-timeline"]').first();
    await timeline.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForCondition(
      async () => (await timeline.innerText()).includes('Magnesium Glycinate CrossFeature'),
      { message: 'Expected approved compound to immediately appear in spread-systemic-timeline UI' }
    );

    // 7. Cross-verify MCP suggest_stack_schedule reflects the newly approved item
    const schedTool = toolMap.get('suggest_stack_schedule');
    assert.ok(schedTool, 'Expected canonical MCP tool "suggest_stack_schedule" in tools/list');
    const schedProps = schedTool.inputSchema?.properties || {};
    const schedArgs = {
      [pickPropKey(schedProps, ['memberId', 'member_id'], 'memberId')]: 'member_wife',
    };
    if (Object.prototype.hasOwnProperty.call(schedProps, 'stackId')) schedArgs.stackId = stack.id;
    const schedMcpRes = await mcp.callTool('suggest_stack_schedule', schedArgs);
    assert.equal(schedMcpRes.status, 200);
    assert.notEqual(schedMcpRes.result?.isError, true, `suggest_stack_schedule error: ${schedMcpRes.text}`);
    const schedPayload = parseToolJson(schedMcpRes);
    assert.ok(
      JSON.stringify(schedPayload).includes('Magnesium Glycinate CrossFeature'),
      'MCP suggest_stack_schedule should include the UI-approved compound'
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T3-02: UI custom section field -> MCP get_section_schema -> AI create_or_propose_compound -> Chromium UI verify', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    // 1. User opens Peptides section in Chromium and adds custom field via btn-customize-section
    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });
    await page.locator('[data-testid="nav-sections"]').first().click();
    await page.locator('[data-testid="section-tab-peptides"]').first().click();
    await page.locator('[data-testid="btn-customize-section"]').first().click();

    const customScope = (await firstVisibleFrom(page, ['[role="dialog"]', 'form'])) || page.locator('main, body').first();
    let labelInput = await firstVisibleFrom(customScope, [
      'input[name*="label" i]',
      'input[placeholder*="label" i]',
      'input[aria-label*="label" i]',
      'input[placeholder*="field name" i]',
    ]);
    if (!labelInput) {
      const addFieldBtn = customScope
        .locator('button')
        .filter({ hasText: /add\s*(?:custom\s*)?field|new\s*field|\+\s*field/i })
        .first();
      await addFieldBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await addFieldBtn.click();
      labelInput = await firstVisibleFrom(customScope, [
        'input[name*="label" i]',
        'input[placeholder*="label" i]',
        'input[aria-label*="label" i]',
        'input[placeholder*="field" i]',
        'input[type="text"]',
      ]);
    }
    assert.ok(labelInput, 'Expected custom field label input in customize-section UI');
    await labelInput.fill('Batch Lot Code');

    const keyInput = await firstVisibleFrom(customScope, [
      'input[name*="key" i]',
      'input[placeholder*="key" i]',
      'input[aria-label*="key" i]',
    ]);
    if (keyInput) await keyInput.fill('batch_lot_code');

    const saveBtn = customScope
      .locator('button[type="submit"], button')
      .filter({ hasText: /save|apply|update|done/i })
      .first();
    await saveBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await saveBtn.click();

    const persistedField = await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/sections/peptides');
        if (res.status !== 200) return null;
        const section = unwrapData(res.json, 'section');
        return (
          (section?.customFields || []).find(
            (f) => f.key === 'batch_lot_code' || /batch\s*lot\s*code/i.test(f.label || '')
          ) || null
        );
      },
      { message: 'Expected custom field "Batch Lot Code" to persist on peptides section' }
    );
    const fieldKey = persistedField.key;
    assert.ok(fieldKey, 'Persisted custom field must have a key');

    // 2. External AI authenticates via OAuth 2.1 (propose) and discovers schema via MCP get_section_schema
    const oauth = await runOAuthFlow({
      baseUrl: server.baseUrl,
      passcode: server.passcode,
      scope: 'propose',
      resource: `${server.baseUrl}/mcp`,
      clientName: 'Gemini Tier3 Schema Researcher',
    });
    assert.equal(oauth.ok, true, `OAuth flow failed: ${oauth.error}`);

    const { mcp, toolMap } = await initMcpAndListTools(server.baseUrl, oauth.accessToken);
    const schemaTool = toolMap.get('get_section_schema');
    const createTool = toolMap.get('create_or_propose_compound');
    assert.ok(schemaTool, 'Expected canonical MCP tool "get_section_schema" in tools/list');
    assert.ok(createTool, 'Expected canonical MCP tool "create_or_propose_compound" in tools/list');

    const secParamKey = pickPropKey(schemaTool.inputSchema?.properties, ['sectionId', 'section', 'id'], 'sectionId');
    const schemaRes = await mcp.callTool('get_section_schema', { [secParamKey]: 'peptides' });
    assert.equal(schemaRes.status, 200);
    assert.equal(schemaRes.error, null);
    assert.notEqual(schemaRes.result?.isError, true, `get_section_schema failed: ${schemaRes.text}`);
    const schemaPayload = parseToolJson(schemaRes);
    assert.ok(
      JSON.stringify(schemaPayload).includes(fieldKey) ||
        JSON.stringify(schemaPayload).includes('Batch Lot Code'),
      `Expected MCP get_section_schema to expose UI-added custom field "${fieldKey}": ${JSON.stringify(schemaPayload)}`
    );

    // 3. External AI creates MOTS-c populating the custom field via create_or_propose_compound
    const lotValue = 'LOT-SYN-2026-042';
    const motsPayload = fixtures.makePeptideCompound({
      name: 'MOTS-c Mitochondrial Peptide',
      canonicalMolecule: 'mots-c',
      customFields: {
        [fieldKey]: lotValue,
      },
      profileStatus: 'ai_draft',
      provenance: {
        sourceModel: 'ai:gemini',
        evidenceTier: 'working_hypothesis',
        confidence: 'medium',
      },
    });
    const createArgs = buildCreateCompoundArgs(createTool, motsPayload);
    const createRes = await mcp.callTool('create_or_propose_compound', createArgs);
    assert.equal(createRes.status, 200);
    assert.equal(createRes.error, null);
    assert.notEqual(
      createRes.result?.isError,
      true,
      `create_or_propose_compound returned tool error: ${createRes.text}`
    );
    const createResult = parseToolJson(createRes);
    assert.ok(createResult, 'Expected structured JSON result from create_or_propose_compound');

    const createdMots = await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/compounds');
        const list = unwrapData(res.json, ['compounds', 'items']) || [];
        return list.find((c) => /MOTS-c/i.test(c.name || '')) || null;
      },
      { message: 'Expected AI-created MOTS-c compound to appear in GET /api/v1/compounds as ai_draft' }
    );
    assert.equal(createdMots.profileStatus, 'ai_draft', 'AI-created compound should land with profileStatus="ai_draft"');

    // 4. User views MOTS-c in Chromium, sees custom field value, and clicks btn-verify-compound
    await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });
    await page.locator('[data-testid="nav-sections"]').first().click();
    await page.locator('[data-testid="section-tab-peptides"]').first().click();

    const card = compoundCardLocator(page, createdMots);
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();

    const detail = page.locator('[data-testid="compound-detail"]').first();
    await detail.waitFor({ state: 'visible', timeout: 10_000 });
    const detailText = await detail.innerText();
    assert.match(detailText, /MOTS-c/i, 'compound-detail must show AI-created compound name');
    assert.ok(
      detailText.includes(lotValue),
      `Expected compound-detail to display AI-populated custom field value "${lotValue}"`
    );

    const verifyBtn = page.locator('[data-testid="btn-verify-compound"]').first();
    await verifyBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await verifyBtn.click();

    await waitForCondition(
      async () => {
        const res = await api.get(`/api/v1/compounds/${encodeURIComponent(createdMots.id)}`);
        const cmp = unwrapData(res.json, 'compound');
        return cmp?.profileStatus === 'verified';
      },
      { message: 'Expected btn-verify-compound to transition MOTS-c to profileStatus="verified"' }
    );

    // 5. Cross-verify verified status through MCP get_compound
    const getCmpTool = toolMap.get('get_compound');
    assert.ok(getCmpTool, 'Expected canonical MCP tool "get_compound" in tools/list');
    const cmpParamKey = pickPropKey(getCmpTool.inputSchema?.properties, ['compoundId', 'id', 'slug'], 'compoundId');
    const getCmpRes = await mcp.callTool('get_compound', { [cmpParamKey]: createdMots.id });
    assert.equal(getCmpRes.status, 200);
    assert.notEqual(getCmpRes.result?.isError, true, `get_compound failed: ${getCmpRes.text}`);
    const mcpCmp = unwrapData(parseToolJson(getCmpRes), 'compound');
    assert.equal(mcpCmp?.profileStatus, 'verified', 'MCP get_compound must reflect UI verification');

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T3-03: clean-slate server -> UI Load Starter Catalog -> External AI queries all 4 sections via MCP search_compounds + get_hub_overview & REST', async () => {
    let cleanServer;
    let cleanBrowser;
    try {
      cleanServer = await startE2EServer();
      const cleanApi = createApiClient({ baseUrl: cleanServer.baseUrl, token: cleanServer.adminToken });

      // Confirm clean-slate start (0 compounds)
      const initCmpRes = await cleanApi.get('/api/v1/compounds');
      assert.equal(initCmpRes.status, 200);
      assert.equal((unwrapData(initCmpRes.json, ['compounds', 'items']) || []).length, 0);

      // User loads Starter Reference Catalog via Cabinet UI
      cleanBrowser = await launchBrowser({ viewport: { width: 1280, height: 800 } });
      const page = await cleanBrowser.openAuthenticatedPage(cleanServer.baseUrl, {
        token: cleanServer.adminToken,
        passcode: cleanServer.passcode,
      });

      await page.locator('[data-testid="nav-cabinet"]').first().click();
      await page.locator('[data-testid="cabinet-list"]').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-testid="btn-load-starter-catalog"]').first().click();

      const restCompounds = await waitForCondition(
        async () => {
          const res = await cleanApi.get('/api/v1/compounds');
          const list = unwrapData(res.json, ['compounds', 'items']) || [];
          const sections = new Set(list.map((c) => c.sectionId));
          return CORE_SECTIONS.every((s) => sections.has(s)) ? list : null;
        },
        { message: 'Expected btn-load-starter-catalog to seed all 4 core sections' }
      );
      assert.ok(restCompounds.length >= 4);

      // External AI authenticates with OAuth read scope & queries MCP get_hub_overview + search_compounds
      const oauth = await runOAuthFlow({
        baseUrl: cleanServer.baseUrl,
        passcode: cleanServer.passcode,
        scope: 'read',
        resource: `${cleanServer.baseUrl}/mcp`,
        clientName: 'Grok Tier3 Starter Catalog Reader',
      });
      assert.equal(oauth.ok, true, `OAuth read flow failed: ${oauth.error}`);

      const { mcp, toolMap } = await initMcpAndListTools(cleanServer.baseUrl, oauth.accessToken);
      assert.ok(toolMap.has('get_hub_overview'), 'Expected canonical MCP tool "get_hub_overview"');
      const searchTool = toolMap.get('search_compounds');
      assert.ok(searchTool, 'Expected canonical MCP tool "search_compounds"');

      const overviewRes = await mcp.callTool('get_hub_overview', {});
      assert.equal(overviewRes.status, 200);
      assert.equal(overviewRes.error, null);
      assert.notEqual(overviewRes.result?.isError, true, `get_hub_overview failed: ${overviewRes.text}`);
      const overviewJson = parseToolJson(overviewRes);
      assert.ok(overviewJson && typeof overviewJson === 'object', 'Expected structured hub overview object');

      const sectionKey = pickPropKey(searchTool.inputSchema?.properties, ['sectionId', 'section'], 'sectionId');
      for (const secId of CORE_SECTIONS) {
        const searchRes = await mcp.callTool('search_compounds', { [sectionKey]: secId });
        assert.equal(searchRes.status, 200);
        assert.equal(searchRes.error, null);
        assert.notEqual(searchRes.result?.isError, true, `search_compounds(${secId}) failed: ${searchRes.text}`);

        const mcpCompounds = extractCompoundArray(parseToolJson(searchRes));
        const restCountForSec = restCompounds.filter((c) => c.sectionId === secId).length;
        assert.ok(
          mcpCompounds.length > 0,
          `Expected MCP search_compounds to return seeded starter compounds for section "${secId}"`
        );
        assert.equal(
          mcpCompounds.length,
          restCountForSec,
          `Expected MCP count (${mcpCompounds.length}) to match REST count (${restCountForSec}) for section "${secId}"`
        );
      }

      assert.deepEqual(
        cleanBrowser.pageErrors,
        [],
        `Unexpected pageErrors: ${JSON.stringify(cleanBrowser.pageErrors)}`
      );
    } finally {
      try {
        if (cleanBrowser) await cleanBrowser.close();
      } finally {
        if (cleanServer) await cleanServer.stop();
      }
    }
  });

  it('T3-04: UI mints scoped API key (btn-mint-api-key) -> External AI authenticates POST /mcp with Bearer key + verifies scope boundary and zero secret re-exposure', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-ai-hub"]').first().click();

    const mintBtn = page.locator('[data-testid="btn-mint-api-key"]').first();
    await mintBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const keysBefore = unwrapData((await api.get('/api/v1/keys')).json, ['keys', 'apiKeys', 'items']) || [];
    const tokensBefore = new Set(await extractCandidateSecretTokens(page));

    // Support both inline form (inputs adjacent to btn-mint-api-key) and modal dialog after clicking
    const keyLabel = 'Meta Muse Tier3 Read Key';
    const inlineContainer = mintBtn.locator('xpath=ancestor::form[1] | ..').first();
    if ((await inlineContainer.count()) > 0 && (await inlineContainer.isVisible())) {
      const inlineName = await firstVisibleFrom(inlineContainer, [
        'input[name*="name" i]',
        'input[placeholder*="name" i]',
        'input[placeholder*="label" i]',
      ]);
      if (inlineName) await inlineName.fill(keyLabel);
      const inlineScope = await firstVisibleFrom(inlineContainer, ['select']);
      if (inlineScope) {
        await selectOptionOnControl(page, inlineScope, { value: 'read', labelRe: /^read$/i });
      }
    }

    await mintBtn.click();

    const mintDialog = await firstVisibleFrom(page, ['[role="dialog"]']);
    if (mintDialog) {
      const dialogName = await firstVisibleFrom(mintDialog, [
        'input[name*="name" i]',
        'input[placeholder*="name" i]',
        'input[placeholder*="label" i]',
        'input[type="text"]',
      ]);
      if (dialogName) await dialogName.fill(keyLabel);

      const dialogScope = await firstVisibleFrom(mintDialog, ['select']);
      if (dialogScope) {
        await selectOptionOnControl(page, dialogScope, { value: 'read', labelRe: /^read$/i });
      }

      const confirmBtn = mintDialog
        .locator('button[type="submit"], button')
        .filter({ hasText: /mint|create|generate|confirm/i })
        .first();
      if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible())) {
        await confirmBtn.click();
      }
    }

    await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/keys');
        const keysAfter = unwrapData(res.json, ['keys', 'apiKeys', 'items']) || [];
        return keysAfter.length > keysBefore.length;
      },
      { message: 'Expected btn-mint-api-key to persist a new scoped API key in GET /api/v1/keys' }
    );

    // Extract the once-revealed raw secret directly from the rendered UI DOM
    const mintedKey = await waitForCondition(
      async () => {
        const tokensAfter = await extractCandidateSecretTokens(page);
        return (
          tokensAfter.find(
            (t) =>
              !tokensBefore.has(t) &&
              t !== server.adminToken &&
              t !== server.passcode
          ) || null
        );
      },
      { message: 'Expected minted raw API key secret to be displayed once in the AI Hub UI' }
    );
    assert.ok(mintedKey.length >= 20, `Expected non-trivial minted API key, got length ${mintedKey.length}`);

    // Authenticate external AI to POST /mcp using the UI-minted Bearer key
    const { mcp, toolMap } = await initMcpAndListTools(server.baseUrl, mintedKey);
    assert.ok(toolMap.has('get_hub_overview'), 'Minted API key must be able to list get_hub_overview');

    const overviewRes = await mcp.callTool('get_hub_overview', {});
    assert.equal(overviewRes.status, 200, `MCP get_hub_overview failed with minted key: ${overviewRes.text}`);
    assert.equal(overviewRes.error, null);
    assert.notEqual(overviewRes.result?.isError, true, `MCP get_hub_overview tool error: ${overviewRes.text}`);
    const overviewData = parseToolJson(overviewRes);
    assert.ok(overviewData && typeof overviewData === 'object', 'Expected valid hub overview JSON from minted key');

    // Verify read-only key cannot call write-only configure_section
    const writeAttempt = await mcp.callTool('configure_section', {
      sectionId: 'peptides',
      aiResearchPrompt: 'Unauthorized write attempt via read key',
    });
    assert.ok(
      writeAttempt.status === 403 || writeAttempt.error !== null || writeAttempt.result?.isError === true,
      `Expected read-scoped minted API key to be denied write-only configure_section, got: ${writeAttempt.text}`
    );

    // Verify GET /api/v1/keys lists key metadata WITHOUT re-exposing the raw secret
    const listKeysRes = await api.get('/api/v1/keys');
    assert.equal(listKeysRes.status, 200);
    assert.ok(
      !listKeysRes.text.includes(mintedKey),
      'GET /api/v1/keys MUST NOT re-expose the raw minted API key secret (must be hashed at rest)'
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });
});
