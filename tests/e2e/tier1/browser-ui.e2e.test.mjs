import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  createMcpClient,
  parseToolJson,
  launchBrowser,
  unwrapData,
  fixtures,
} from '../harness.mjs';

const CANONICAL_SYSTEMIC_SLOTS = [
  'waking_fasted',
  'morning_am',
  'pre_workout',
  'intra_post_workout',
  'midday_lunch',
  'evening_dinner',
  'bedtime_fasted',
  'prn',
];

const DISCLAIMER_RE =
  /not\s+medical\s+advice|personal\s+reference|educational\s+(?:reference|purposes|only)|harm[- ]reduction|consult\s+(?:a|your)\s+(?:qualified\s+)?(?:physician|clinician|doctor|healthcare)/i;

const RESEARCH_PROMPT_SCHEMA_RE =
  /mechanismOfAction|timingRules|sectionId|halfLife|doNotPairWith|useCaseScenarios|customFields|dosages/i;

const AI_GUIDE_IDS = [
  'ai-guide-gemini',
  'ai-guide-claude',
  'ai-guide-grok',
  'ai-guide-gpt',
  'ai-guide-muse',
];

const NON_SEARCH_FORM_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  'main form:not(:has([data-testid="global-search-input"]))',
  'form:not(:has([data-testid="global-search-input"]))',
];

const EXCLUDED_GENERIC_SELECT_TESTIDS = [
  'member-switcher',
  'filter-ownership',
  'filter-status',
  'stack-selector',
  'ownership-status-select',
];

const GENERIC_NON_GLOBAL_SELECT =
  'select' +
  EXCLUDED_GENERIC_SELECT_TESTIDS.map((id) => `:not([data-testid="${id}"])`).join('');

// ---------------------------------------------------------------------------
// Opaque-Box UI Helpers (canonical PROJECT.md §3 data-testids + ARIA + text)
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

  let targetSelect = null;
  if (tagName === 'SELECT') {
    targetSelect = switcher;
  } else {
    const nestedSelect = switcher.locator('select').first();
    if ((await nestedSelect.count()) > 0 && (await nestedSelect.isVisible())) {
      targetSelect = nestedSelect;
    }
  }

  if (targetSelect) {
    const optionLoc = page.locator(`[data-testid="member-option-${memberId}"]`).first();
    assert.ok(
      (await optionLoc.count()) > 0,
      `Expected <option data-testid="member-option-${memberId}"> inside member-switcher`
    );
    const optValue =
      (await optionLoc
        .evaluate((el) => (el.tagName.toUpperCase() === 'OPTION' ? el.value : el.getAttribute('value')))
        .catch(() => null)) || memberId;
    await targetSelect.selectOption(optValue);
    assert.equal(
      await targetSelect.inputValue(),
      optValue,
      `member-switcher did not update value to ${optValue}`
    );
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
        const opts = Array.from(sel.options);
        if (arg.value !== null && arg.value !== undefined) {
          const exact = opts.find((opt) => opt.value === arg.value);
          if (exact) return exact.value;
          const exactCI = opts.find(
            (opt) => opt.value.toLowerCase() === String(arg.value).toLowerCase()
          );
          if (exactCI) return exactCI.value;
        }
        const re = arg.pattern ? new RegExp(arg.pattern, 'i') : null;
        if (re) {
          const byRe = opts.find(
            (opt) => re.test(opt.value) || re.test((opt.textContent || '').trim())
          );
          if (byRe) return byRe.value;
        }
        if (arg.value === 'all') {
          const emptyOpt = opts.find((opt) => opt.value === '');
          if (emptyOpt) return emptyOpt.value;
        }
        return null;
      },
      { value: value ?? null, pattern: labelRe ? labelRe.source : null }
    );
    assert.ok(
      matchedValue !== null,
      `Expected matching option (${value || labelRe}) inside <select>`
    );
    await controlLocator.selectOption(matchedValue);
    assert.equal(await controlLocator.inputValue(), matchedValue);
    return matchedValue;
  }

  const nestedSelect = controlLocator.locator('select').first();
  if ((await nestedSelect.count()) > 0 && (await nestedSelect.isVisible())) {
    return selectOptionOnControl(page, nestedSelect, { value, labelRe });
  }

  if (value !== undefined && value !== null) {
    const escapedVal = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const radioByVal = controlLocator.locator(`input[type="radio"][value="${escapedVal}"]`).first();
    if ((await radioByVal.count()) > 0 && (await radioByVal.isVisible())) {
      await radioByVal.check();
      return String(value);
    }
  }

  const matcher = labelRe || new RegExp(`^${String(value).replace(/[_-]/g, '[\\s_-]?')}$`, 'i');
  const innerBtn = controlLocator
    .locator('button, label:has(input[type="radio"]), [role="option"], [role="tab"], [role="radio"]')
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

async function readToggleState(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  return locator.evaluate((el) => {
    if (el.tagName.toUpperCase() === 'INPUT' && el.type === 'checkbox') {
      return Boolean(el.checked);
    }
    const nested = el.querySelector('input[type="checkbox"]');
    if (nested) return Boolean(nested.checked);
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked === 'true' || ariaChecked === 'false') return ariaChecked === 'true';
    const ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed === 'true' || ariaPressed === 'false') return ariaPressed === 'true';
    const dataActive = el.getAttribute('data-active') ?? el.getAttribute('data-checked');
    if (dataActive === 'true' || dataActive === 'false') return dataActive === 'true';
    return el.getAttribute('data-state') === 'checked' || el.getAttribute('data-state') === 'on';
  });
}

async function clickToggle(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const nestedCheckbox = locator.locator('input[type="checkbox"]').first();
  if ((await nestedCheckbox.count()) > 0 && (await nestedCheckbox.isVisible())) {
    await nestedCheckbox.click();
    return;
  }
  await locator.click();
}

async function getThemeSnapshot(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    return {
      htmlTheme: html.getAttribute('data-theme') || '',
      bodyTheme: body.getAttribute('data-theme') || '',
      htmlClass: html.className || '',
      bodyClass: body.className || '',
      colorScheme: getComputedStyle(html).colorScheme || '',
      bg: getComputedStyle(body).backgroundColor || '',
      fg: getComputedStyle(body).color || '',
    };
  });
}

async function firstVisibleFrom(container, selectors, { waitMs = 0, intervalMs = 50 } = {}) {
  const deadline = Date.now() + waitMs;
  do {
    for (const sel of selectors) {
      const loc = typeof sel === 'string' ? container.locator(sel) : sel;
      const count = Math.min(await loc.count(), 25);
      for (let i = 0; i < count; i += 1) {
        const item = loc.nth(i);
        if (await item.isVisible()) return item;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => {
      const t = setTimeout(r, intervalMs);
      t.unref?.();
    });
  } while (Date.now() < deadline);
  return null;
}

async function isAllowedControl(loc, { allowedTags = null, editableOnly = false } = {}) {
  return loc
    .evaluate(
      (el, opts) => {
        const tag = el.tagName.toUpperCase();
        if (opts.allowedTags && !opts.allowedTags.includes(tag)) return false;
        if (el.getAttribute('data-testid') === 'global-search-input') return false;
        if (tag === 'SELECT') {
          if (
            el.closest('[data-testid="member-switcher"]') ||
            el.closest('[data-testid="filter-ownership"]') ||
            el.closest('[data-testid="filter-status"]') ||
            el.closest('[data-testid="stack-selector"]') ||
            el.closest('[data-testid="ownership-status-select"]')
          ) {
            return false;
          }
        }
        if (tag === 'INPUT') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          if (['checkbox', 'radio', 'hidden', 'submit', 'button', 'file'].includes(t)) {
            return false;
          }
        }
        if (opts.editableOnly && (el.readOnly || el.disabled)) return false;
        return true;
      },
      { allowedTags, editableOnly }
    )
    .catch(() => false);
}

async function firstVisibleInput(
  container,
  { labelRe = null, labelRes = [], allowedTags = null, selectors = [], editableOnly = false, waitMs = 0 } = {}
) {
  const allLabels = labelRe ? [labelRe, ...labelRes] : [...labelRes];
  const deadline = Date.now() + waitMs;
  do {
    if (typeof container.getByLabel === 'function') {
      for (const re of allLabels) {
        const labeled = container.getByLabel(re);
        const n = Math.min(await labeled.count(), 25);
        for (let i = 0; i < n; i += 1) {
          const item = labeled.nth(i);
          if (!(await item.isVisible())) continue;
          if (await isAllowedControl(item, { allowedTags, editableOnly })) return item;
        }
      }
    }
    for (const sel of selectors) {
      const loc = container.locator(sel);
      const n = Math.min(await loc.count(), 25);
      for (let i = 0; i < n; i += 1) {
        const item = loc.nth(i);
        if (!(await item.isVisible())) continue;
        if (await isAllowedControl(item, { allowedTags, editableOnly })) return item;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => {
      const t = setTimeout(r, 50);
      t.unref?.();
    });
  } while (Date.now() < deadline);
  return null;
}

async function findSubmitButton(scope, labelRe, { excludeTestIds = [], preferLast = false } = {}) {
  const excludeSet = new Set(excludeTestIds);
  const pickVisible = async (loc, { excludeCancel = false } = {}) => {
    const n = Math.min(await loc.count(), 30);
    const visible = [];
    for (let i = 0; i < n; i += 1) {
      const item = loc.nth(i);
      if (!(await item.isVisible())) continue;
      if (excludeSet.size > 0) {
        const tid = await item.getAttribute('data-testid');
        if (tid && excludeSet.has(tid)) continue;
      }
      if (excludeCancel) {
        const txt = (await item.innerText().catch(() => '')) || '';
        if (/cancel|close|delete|remove|reset|disable/i.test(txt)) continue;
      }
      visible.push(item);
    }
    if (visible.length === 0) return null;
    return preferLast ? visible[visible.length - 1] : visible[0];
  };

  // Priority 1: explicit submit button OR implicit <form><button> matching labelRe
  const submitSelector =
    'button[type="submit"], input[type="submit"], form button:not([type="button"]):not([type="reset"])';
  if (labelRe) {
    const submitMatched = await pickVisible(scope.locator(submitSelector).filter({ hasText: labelRe }));
    if (submitMatched) return submitMatched;
  }

  // Priority 2: explicit button[type="submit"] / input[type="submit"] in scope (non-cancel)
  const explicitSubmit = await pickVisible(
    scope.locator('button[type="submit"], input[type="submit"]'),
    { excludeCancel: true }
  );
  if (explicitSubmit) return explicitSubmit;

  // Priority 3: fallback generic button matching labelRe
  if (labelRe) {
    return pickVisible(scope.locator('button:not([type="reset"])').filter({ hasText: labelRe }));
  }
  return null;
}

async function countVisible(locator) {
  const n = await locator.count();
  let visible = 0;
  for (let i = 0; i < n; i += 1) {
    if (await locator.nth(i).isVisible()) visible += 1;
  }
  return visible;
}

async function lastVisibleOf(locator) {
  const n = await locator.count();
  for (let i = n - 1; i >= 0; i -= 1) {
    const item = locator.nth(i);
    if (await item.isVisible()) return item;
  }
  return null;
}

async function assertDisclaimerVisible(page, container = null) {
  const scope = container || page.locator('body');
  const text = await scope.innerText();
  assert.match(
    text,
    DISCLAIMER_RE,
    'Expected visible F44 medical / harm-reduction disclaimer text'
  );
}

async function apiCreateCompound(api, payload) {
  const res = await api.post('/api/v1/compounds', payload);
  assert.ok(
    res.status === 200 || res.status === 201,
    `POST /api/v1/compounds failed (${res.status}): ${res.text}`
  );
  const created = unwrapData(res.json, 'compound');
  assert.ok(created?.id, `Created compound missing id: ${res.text}`);
  return created;
}

async function apiSetOwnership(api, compoundId, ownershipPayload) {
  const res = await api.put(`/api/v1/ownership/${encodeURIComponent(compoundId)}`, ownershipPayload);
  assert.equal(
    res.status,
    200,
    `PUT /api/v1/ownership/${compoundId} failed (${res.status}): ${res.text}`
  );
  return unwrapData(res.json, 'ownership');
}

async function apiCreateStack(api, memberId, stackPayload) {
  const res = await api.post(`/api/v1/members/${encodeURIComponent(memberId)}/stacks`, stackPayload);
  assert.ok(
    res.status === 200 || res.status === 201,
    `POST /api/v1/members/${memberId}/stacks failed (${res.status}): ${res.text}`
  );
  const created = unwrapData(res.json, 'stack');
  assert.ok(created?.id, `Created stack missing id: ${res.text}`);
  return created;
}

async function apiListCompounds(api) {
  const res = await api.get('/api/v1/compounds');
  assert.equal(res.status, 200, `GET /api/v1/compounds failed (${res.status}): ${res.text}`);
  const list = unwrapData(res.json, ['compounds', 'items']);
  assert.ok(Array.isArray(list), `Expected compounds array, got: ${res.text}`);
  return list;
}

async function apiListStacks(api, memberId) {
  const res = await api.get(`/api/v1/members/${encodeURIComponent(memberId)}/stacks`);
  assert.equal(res.status, 200, `GET stacks failed (${res.status}): ${res.text}`);
  const list = unwrapData(res.json, ['stacks', 'items']);
  assert.ok(Array.isArray(list), `Expected stacks array, got: ${res.text}`);
  return list;
}

async function extractCandidateSecretTokens(page) {
  return page.evaluate(() => {
    const priority = new Set();
    const secondary = new Set();
    const tokenRe = /[A-Za-z0-9._-]{20,}/g;
    const addTokens = (str, target) => {
      if (!str) return;
      for (const m of String(str).matchAll(tokenRe)) {
        const candidate = m[0];
        if (!/^https?:\/\//i.test(candidate) && !candidate.includes('://')) {
          target.add(candidate);
        }
      }
    };

    const prioritySelectors = [
      'input[readonly]',
      'textarea[readonly]',
      '[role="alert"]',
      '[role="status"]',
      '[role="dialog"] code',
      '[role="dialog"] pre',
      '[role="dialog"] input',
      '[role="alertdialog"] code',
      '[role="alertdialog"] pre',
      '[role="alertdialog"] input',
      'code',
      'pre',
      '[role="dialog"]',
      '[role="alertdialog"]',
    ];
    for (const sel of prioritySelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if ('value' in el && el.value) addTokens(el.value, priority);
        addTokens(el.innerText || el.textContent || '', priority);
      }
    }

    for (const el of document.querySelectorAll('input, textarea')) {
      if (el.value) addTokens(el.value, secondary);
    }
    addTokens(document.body?.innerText || '', secondary);

    const ordered = [...priority];
    for (const tok of secondary) {
      if (!priority.has(tok)) ordered.push(tok);
    }
    return ordered;
  });
}

function collectKeyMetadataExclusions(keysList) {
  const excluded = new Set();
  for (const k of keysList || []) {
    if (!k || typeof k !== 'object') continue;
    for (const field of [
      'id',
      'keyId',
      'name',
      'label',
      'prefix',
      'keyPrefix',
      'hash',
      'keyHash',
      'tokenHash',
      'createdAt',
      'updatedAt',
    ]) {
      const val = k[field];
      if (typeof val === 'string' && val.length > 0) excluded.add(val);
    }
  }
  return excluded;
}

async function findMintKeyContainer(mintBtn) {
  const candidateXPaths = [
    'xpath=ancestor::form[1]',
    'xpath=..',
    'xpath=../..',
    'xpath=../../..',
    'xpath=ancestor::section[1]',
    'xpath=ancestor::article[1]',
    'xpath=ancestor::*[@role="region"][1]',
  ];
  let firstValid = null;
  for (const xp of candidateXPaths) {
    const container = mintBtn.locator(xp).first();
    if ((await container.count()) === 0 || !(await container.isVisible())) continue;
    const check = await container
      .evaluate((el) => {
        const tag = el.tagName.toUpperCase();
        if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') return { ok: false, hasControls: false };
        if (el.querySelector('[data-testid="nav-sections"]')) return { ok: false, hasControls: false };
        if (el.querySelector('[data-testid="member-switcher"]')) return { ok: false, hasControls: false };
        if (el.querySelector('[data-testid="ai-json-import-textarea"]')) return { ok: false, hasControls: false };
        const hasControls = Boolean(
          el.querySelector(
            'select:not([data-testid="member-switcher"]):not([data-testid="filter-ownership"]):not([data-testid="filter-status"]):not([data-testid="stack-selector"]), input[type="radio"], [role="radiogroup"], input[type="text"]:not([data-testid="global-search-input"]), input:not([type]):not([data-testid="global-search-input"])'
          )
        );
        return { ok: true, hasControls };
      })
      .catch(() => ({ ok: false, hasControls: false }));
    if (!check.ok) continue;
    if (!firstValid) firstValid = container;
    if (check.hasControls) return container;
  }
  return firstValid || mintBtn.locator('xpath=..').first();
}

async function selectScopeControl(page, container, scopeValue) {
  const scopeRe = new RegExp(`^${scopeValue}\\b|\\b${scopeValue}\\b`, 'i');
  const scopeSelect = await firstVisibleInput(container, {
    labelRe: /scope|permission|access/i,
    allowedTags: ['SELECT'],
    selectors: [
      'select[name*="scope" i]',
      'select[aria-label*="scope" i]',
      GENERIC_NON_GLOBAL_SELECT,
    ],
  });
  if (scopeSelect) {
    await selectOptionOnControl(page, scopeSelect, { value: scopeValue, labelRe: scopeRe });
    return true;
  }
  const radio = container.locator(`input[type="radio"][value="${scopeValue}"]`).first();
  if ((await radio.count()) > 0 && (await radio.isVisible())) {
    await radio.check();
    return true;
  }
  const radioLabel = container
    .locator('label:has(input[type="radio"]), [role="radio"]')
    .filter({ hasText: new RegExp(`^${scopeValue}\\b`, 'i') })
    .first();
  if ((await radioLabel.count()) > 0 && (await radioLabel.isVisible())) {
    await radioLabel.click();
    return true;
  }
  const scopeBtns = container
    .locator('button, [role="option"]')
    .filter({ hasText: new RegExp(`^${scopeValue}(?:\\s+only)?$`, 'i') });
  const btnCount = await scopeBtns.count();
  for (let i = 0; i < btnCount; i += 1) {
    const btn = scopeBtns.nth(i);
    if (!(await btn.isVisible())) continue;
    if ((await btn.getAttribute('data-testid')) === 'btn-mint-api-key') continue;
    await btn.click();
    return true;
  }
  return false;
}

function resolveOpenApiSchema(spec, schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const parts = schema.$ref.slice(2).split('/');
    let cur = spec;
    for (const p of parts) cur = cur?.[p];
    return cur || null;
  }
  return schema;
}

async function seedPendingCompoundProposal(api, server, { compoundPayload, sourceModel, summary }) {
  const candidates = [];

  try {
    const specRes = await api.get('/openapi.json');
    if (specRes.status === 200 && specRes.json?.paths) {
      const rawSchema =
        specRes.json.paths['/api/v1/proposals']?.post?.requestBody?.content?.['application/json']?.schema;
      const schema = resolveOpenApiSchema(specRes.json, rawSchema);
      const props = schema?.properties;
      if (props && typeof props === 'object') {
        const body = {};
        const typeKey = ['type', 'kind', 'proposalType', 'action', 'operation'].find((k) => k in props);
        if (typeKey) {
          const enums = props[typeKey]?.enum;
          body[typeKey] =
            Array.isArray(enums) && enums.length > 0
              ? enums.find((e) => /compound.*create|create.*compound|new.*compound|compound/i.test(String(e))) ||
                enums[0]
              : 'compound_create';
        }
        const payloadKey = ['payload', 'data', 'compound', 'changes', 'proposedData'].find((k) => k in props);
        if (payloadKey) body[payloadKey] = compoundPayload;
        const actorKey = ['sourceModel', 'actor', 'source', 'submittedBy'].find((k) => k in props);
        if (actorKey) body[actorKey] = sourceModel;
        const summaryKey = ['summary', 'reason', 'description', 'title'].find((k) => k in props);
        if (summaryKey) body[summaryKey] = summary;
        if (Object.keys(body).length > 0) candidates.push(body);
      }
    }
  } catch {
    // OpenAPI discovery is best-effort; canonical candidate shapes follow
  }

  candidates.push(
    { type: 'compound_create', sourceModel, summary, payload: compoundPayload },
    { type: 'create_compound', sourceModel, summary, payload: compoundPayload },
    { kind: 'compound_create', sourceModel, summary, data: compoundPayload },
    { action: 'create_compound', actor: sourceModel, summary, compound: compoundPayload }
  );

  let lastDiag = '';
  for (const body of candidates) {
    const res = await api.post('/api/v1/proposals', body);
    if (res.status === 200 || res.status === 201) {
      const created = unwrapData(res.json, 'proposal');
      if (created?.id) return created;
    }
    lastDiag = `status=${res.status} body=${res.text.slice(0, 240)}`;
  }

  // Fallback via canonical MCP create_or_propose_compound
  const beforeRes = await api.get('/api/v1/proposals');
  const beforeIds = new Set((unwrapData(beforeRes.json, ['proposals', 'items']) || []).map((p) => p.id));
  const mcp = createMcpClient({ baseUrl: server.baseUrl, token: server.adminToken });
  const initRes = await mcp.initialize({ name: 'home-pharmacy-tier1-e2e', version: '1.0.0' });
  if (initRes.status === 200 && initRes.error === null) {
    await mcp.notifyInitialized();
    const listRes = await mcp.listTools();
    const tool = (listRes.result?.tools || []).find((t) => t.name === 'create_or_propose_compound');
    if (tool) {
      const props = tool.inputSchema?.properties || {};
      const args = 'compound' in props ? { compound: compoundPayload } : { ...compoundPayload };
      if ('mode' in props) args.mode = 'propose';
      if ('forceProposal' in props) args.forceProposal = true;
      if ('asProposal' in props) args.asProposal = true;
      if ('holdInInbox' in props) args.holdInInbox = true;
      if ('sourceModel' in props) args.sourceModel = sourceModel;
      if ('summary' in props && !args.summary) args.summary = summary;
      const callRes = await mcp.callTool('create_or_propose_compound', args);
      if (callRes.status === 200 && callRes.error === null && callRes.result?.isError !== true) {
        const parsed = parseToolJson(callRes, { allowNull: true });
        if (parsed?.proposal?.id) return parsed.proposal;
        const afterRes = await api.get('/api/v1/proposals');
        const afterList = unwrapData(afterRes.json, ['proposals', 'items']) || [];
        const matched = afterList.find(
          (p) => !beforeIds.has(p.id) && JSON.stringify(p).includes(compoundPayload.name)
        );
        if (matched?.id) return matched;
      }
    }
  }

  assert.fail(`Failed to seed pending compound proposal (${compoundPayload.name}); last REST: ${lastDiag}`);
}

async function captureExportText(page, buttonTestId, urlSubstring) {
  let responseText = null;
  let resolveNetwork;
  const networkPromise = new Promise((resolve) => {
    resolveNetwork = resolve;
  });

  const resHandler = async (res) => {
    if (res.url().includes(urlSubstring) && res.status() === 200) {
      try {
        responseText = await res.text();
        resolveNetwork(responseText);
      } catch {
        // Ignore read race if body consumed by browser
      }
    }
  };
  page.on('response', resHandler);

  let timeoutId;
  let fallbackTimerId;
  try {
    const downloadPromise = page
      .waitForEvent('download', { timeout: 6_000 })
      .then(async (dl) => {
        const stream = await dl.createReadStream();
        if (!stream) return null;
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
      })
      .catch(() => null);

    await page.locator(`[data-testid="${buttonTestId}"]`).first().click();

    const timeoutPromise = new Promise((r) => {
      timeoutId = setTimeout(() => r(null), 6_000);
      timeoutId.unref?.();
    });
    const downloadRace = downloadPromise.then((txt) => {
      if (txt) return txt;
      return new Promise((r) => {
        fallbackTimerId = setTimeout(() => r(responseText), 500);
        fallbackTimerId.unref?.();
      });
    });

    const raced = await Promise.race([networkPromise, downloadRace, timeoutPromise]);
    return raced || responseText || (await downloadPromise);
  } finally {
    clearTimeout(timeoutId);
    clearTimeout(fallbackTimerId);
    page.off('response', resHandler);
  }
}

async function waitForCondition(fn, { timeoutMs = 10_000, intervalMs = 150, message = 'Condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await fn();
    if (lastResult) return lastResult;
    await new Promise((r) => {
      const t = setTimeout(r, intervalMs);
      t.unref?.();
    });
  }
  assert.fail(`${message} (lastResult=${JSON.stringify(lastResult)})`);
}

// ---------------------------------------------------------------------------
// Tier 1: Browser UI Happy-Path E2E Suite (Playwright Chromium, Desktop 1280x800)
// ---------------------------------------------------------------------------

describe('Tier 1: Browser UI Happy-Path E2E (Playwright Chromium)', () => {
  let server;
  let api;
  let browserHandle;

  // Seeded reference compounds across all 4 core sections
  let peptideBpc;
  let pedTestCyp;
  let suppMag;
  let suppZinc;
  let suppCopper;
  let dermTret;
  let dermVitC;
  let dermSpf;
  let dermGlycolic;
  let dermMinoxidil;

  before(async () => {
    server = await startE2EServer();
    api = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    // Seed synthetic non-personal educational compounds spanning all 4 sections
    peptideBpc = await apiCreateCompound(
      api,
      fixtures.makePeptideCompound({
        profileStatus: 'ai_draft',
      })
    );
    pedTestCyp = await apiCreateCompound(
      api,
      fixtures.makePedCompound({
        profileStatus: 'verified',
      })
    );
    suppMag = await apiCreateCompound(
      api,
      fixtures.makeSupplementCompound({
        profileStatus: 'verified',
      })
    );
    suppZinc = await apiCreateCompound(
      api,
      fixtures.makeSupplementCompound({
        name: 'Zinc Picolinate 30mg',
        canonicalMolecule: 'zinc',
        aliases: ['Zinc'],
        tags: ['supplement', 'mineral', 'zinc'],
        timingRules: {
          preferredSlots: ['midday_lunch', 'evening_dinner'],
          avoidSlots: ['waking_fasted'],
          foodState: 'with_meal',
          circadianEffect: 'neutral',
          timingNotes: 'Take with food and separate from copper by at least 2 hours.',
        },
        dosages: {
          rangeText: '15-30 mg daily',
          defaultAmount: 30,
          defaultUnit: 'mg',
          route: 'Oral',
          frequencyText: 'Once daily with meal',
          maxCeiling: 40,
        },
        doNotPairWith: [
          {
            targetType: 'nutrient',
            targetRef: 'copper',
            severity: 'avoid_same_slot',
            separationHours: 2,
            mechanism: 'High-dose zinc competitively inhibits intestinal copper absorption.',
            recommendation: 'Separate zinc and copper by at least 2 hours.',
          },
        ],
        profileStatus: 'verified',
      })
    );
    suppCopper = await apiCreateCompound(
      api,
      fixtures.makeSupplementCompound({
        name: 'Copper Bisglycinate 2mg',
        canonicalMolecule: 'copper',
        aliases: ['Copper'],
        tags: ['supplement', 'mineral', 'copper'],
        timingRules: {
          preferredSlots: ['morning_am', 'midday_lunch'],
          avoidSlots: [],
          foodState: 'with_meal',
          circadianEffect: 'neutral',
          timingNotes: 'Take with a meal separate from zinc.',
        },
        dosages: {
          rangeText: '1-2 mg daily',
          defaultAmount: 2,
          defaultUnit: 'mg',
          route: 'Oral',
          frequencyText: 'Once daily with meal',
          maxCeiling: 10,
        },
        doNotPairWith: [
          {
            targetType: 'nutrient',
            targetRef: 'zinc',
            severity: 'avoid_same_slot',
            separationHours: 2,
            mechanism: 'Zinc competes with copper uptake via metallothionein induction.',
            recommendation: 'Separate copper from zinc by at least 2 hours.',
          },
        ],
        profileStatus: 'verified',
      })
    );
    dermTret = await apiCreateCompound(
      api,
      fixtures.makeDermCompound({
        profileStatus: 'verified',
      })
    );
    dermVitC = await apiCreateCompound(
      api,
      fixtures.makeDermCompound({
        name: 'Vitamin C 15% L-Ascorbic Serum',
        canonicalMolecule: 'l-ascorbic-acid',
        aliases: ['L-Ascorbic Acid Serum'],
        tags: ['dermatology', 'antioxidant', 'vitamin_c', 'am_only'],
        timingRules: {
          preferredSlots: ['derm_am'],
          avoidSlots: ['derm_pm'],
          foodState: 'any',
          workoutRelation: 'any',
          circadianEffect: 'neutral',
          timingNotes: 'Apply in the AM skincare routine prior to moisturizer and SPF.',
        },
        doNotPairWith: [],
        sectionData: {
          targetArea: ['face', 'neck'],
          vehicleType: 'water_serum',
          actives: [{ name: 'L-Ascorbic Acid', concentrationPct: 15, optimalPh: 3.2 }],
          layeringStep: 2,
          waitTimeMinutes: 5,
          amPmSuitability: 'am_only',
          photosensitivity: false,
          leaveOn: true,
          skinCyclingRole: 'antioxidant',
          pregnancySafety: 'safe',
        },
        profileStatus: 'verified',
      })
    );
    dermSpf = await apiCreateCompound(
      api,
      fixtures.makeDermCompound({
        name: 'Mineral SPF 50 Sunscreen',
        canonicalMolecule: 'zinc-oxide-spf',
        aliases: ['Broad-Spectrum SPF 50'],
        tags: ['dermatology', 'spf', 'sunscreen', 'am_only'],
        timingRules: {
          preferredSlots: ['derm_am'],
          avoidSlots: ['derm_pm'],
          foodState: 'any',
          workoutRelation: 'any',
          circadianEffect: 'neutral',
          timingNotes: 'Final AM skincare layering step every morning.',
        },
        doNotPairWith: [],
        sectionData: {
          targetArea: ['face', 'neck'],
          vehicleType: 'lotion',
          actives: [{ name: 'Zinc Oxide', concentrationPct: 20, optimalPh: 7.0 }],
          layeringStep: 7,
          waitTimeMinutes: 0,
          amPmSuitability: 'am_only',
          photosensitivity: false,
          leaveOn: true,
          skinCyclingRole: 'spf',
          pregnancySafety: 'safe',
        },
        profileStatus: 'verified',
      })
    );
    dermGlycolic = await apiCreateCompound(
      api,
      fixtures.makeDermCompound({
        name: 'Glycolic Acid 10% Toner',
        canonicalMolecule: 'glycolic-acid',
        aliases: ['AHA 10%'],
        tags: ['dermatology', 'aha', 'aha_bha', 'exfoliant', 'photosensitizing', 'pm_only'],
        timingRules: {
          preferredSlots: ['derm_pm'],
          avoidSlots: ['derm_am'],
          foodState: 'any',
          workoutRelation: 'any',
          circadianEffect: 'neutral',
          timingNotes: 'Apply on PM exfoliation nights alternating with retinoid nights.',
        },
        doNotPairWith: [
          {
            targetType: 'class',
            targetRef: 'retinoid',
            severity: 'alternate_days',
            mechanism: 'Concurrent AHA and retinoid severely irritates the skin barrier.',
            recommendation: 'Alternate on separate PM skin-cycling nights.',
          },
        ],
        sectionData: {
          targetArea: ['face', 'neck'],
          vehicleType: 'liquid_toner',
          actives: [{ name: 'Glycolic Acid', concentrationPct: 10, optimalPh: 3.5 }],
          layeringStep: 2,
          waitTimeMinutes: 10,
          amPmSuitability: 'pm_only',
          photosensitivity: true,
          leaveOn: true,
          skinCyclingRole: 'exfoliant',
          pregnancySafety: 'caution',
        },
        profileStatus: 'verified',
      })
    );
    dermMinoxidil = await apiCreateCompound(
      api,
      fixtures.makeDermCompound({
        name: 'Topical Minoxidil 5% Scalp Foam',
        canonicalMolecule: 'minoxidil',
        aliases: ['Minoxidil 5% Foam'],
        tags: ['dermatology', 'hair_scalp', 'scalp', 'minoxidil'],
        timingRules: {
          preferredSlots: ['derm_am', 'derm_pm'],
          avoidSlots: [],
          foodState: 'any',
          workoutRelation: 'any',
          circadianEffect: 'neutral',
          timingNotes: 'Apply directly to dry scalp morning and evening.',
        },
        doNotPairWith: [],
        sectionData: {
          targetArea: ['scalp_hair'],
          vehicleType: 'foam',
          actives: [{ name: 'Minoxidil', concentrationPct: 5, optimalPh: 6.5 }],
          layeringStep: 2,
          waitTimeMinutes: 15,
          amPmSuitability: 'both',
          photosensitivity: false,
          leaveOn: true,
          skinCyclingRole: 'hair_growth',
          pregnancySafety: 'avoid',
        },
        profileStatus: 'verified',
      })
    );

    // Ownership mix: some "have", some "dont_have" / "wishlist"
    await apiSetOwnership(api, peptideBpc.id, { scope: 'household', status: 'have', remainingDoses: 12 });
    await apiSetOwnership(api, pedTestCyp.id, { scope: 'member:member_husband', status: 'have', remainingDoses: 16 });
    await apiSetOwnership(api, suppMag.id, { scope: 'household', status: 'have', remainingDoses: 30 });
    await apiSetOwnership(api, suppZinc.id, { scope: 'household', status: 'have', remainingDoses: 20 });
    await apiSetOwnership(api, suppCopper.id, { scope: 'household', status: 'dont_have' });
    await apiSetOwnership(api, dermTret.id, { scope: 'household', status: 'have', remainingDoses: 25 });
    await apiSetOwnership(api, dermVitC.id, { scope: 'household', status: 'have', remainingDoses: 20 });
    await apiSetOwnership(api, dermSpf.id, { scope: 'household', status: 'have', remainingDoses: 30 });
    await apiSetOwnership(api, dermGlycolic.id, { scope: 'household', status: 'have', remainingDoses: 15 });
    await apiSetOwnership(api, dermMinoxidil.id, { scope: 'household', status: 'wishlist' });

    browserHandle = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    await browserHandle.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  after(async () => {
    try {
      if (browserHandle) await browserHandle.close();
    } finally {
      if (server) await server.stop();
    }
  });

  it('T1-01: loads authenticated PWA, navigates all 5 primary views, toggles theme, runs global search, and shows F44 disclaimers', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    // Verify all 5 primary navigation targets exist & work
    const navIds = ['nav-sections', 'nav-stack', 'nav-cabinet', 'nav-ai-hub', 'nav-settings'];
    for (const navId of navIds) {
      const navLoc = page.locator(`[data-testid="${navId}"]`).first();
      await navLoc.waitFor({ state: 'visible', timeout: 10_000 });
      await navLoc.click();
    }

    // Return to Sections view and assert F44 medical disclaimer is visibly rendered
    await page.locator('[data-testid="nav-sections"]').first().click();
    await assertDisclaimerVisible(page);

    // Toggle Dark / Light theme via theme-toggle and assert observable theme change (waits for async React useEffect)
    const themeToggle = page.locator('[data-testid="theme-toggle"]').first();
    await themeToggle.waitFor({ state: 'visible', timeout: 10_000 });
    const beforeTheme = await getThemeSnapshot(page);
    await themeToggle.click();
    await waitForCondition(
      async () => JSON.stringify(await getThemeSnapshot(page)) !== JSON.stringify(beforeTheme),
      {
        timeoutMs: 5_000,
        message: `Expected theme-toggle click to mutate theme attributes/classes/colors (before=${JSON.stringify(beforeTheme)})`,
      }
    );
    await themeToggle.click();

    // Global search across all 4 core sections (verify card visibility + non-matching exclusion, not query echo)
    const searchInput = page.locator('[data-testid="global-search-input"]').first();
    await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
    const searchCases = [
      { query: 'BPC-157', match: peptideBpc, nonMatch: dermTret },
      { query: 'Testosterone', match: pedTestCyp, nonMatch: dermTret },
      { query: 'Magnesium', match: suppMag, nonMatch: pedTestCyp },
      { query: 'Tretinoin', match: dermTret, nonMatch: suppMag },
    ];
    for (const { query, match, nonMatch } of searchCases) {
      await searchInput.fill(query);
      await waitForCondition(
        async () => {
          const matchVisible = await compoundCardLocator(page, match).isVisible();
          const nonMatchVisible = await compoundCardLocator(page, nonMatch).isVisible();
          return matchVisible && !nonMatchVisible;
        },
        {
          message: `Expected global-search-input query "${query}" to display matching card (${match.name}) and hide non-matching card (${nonMatch.name})`,
        }
      );
    }
    await searchInput.fill('');

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-02: switches active household member (Wife <-> Husband) via member-switcher with isolated member stacks', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    await apiCreateStack(
      api,
      'member_wife',
      fixtures.makeStackPayload({
        name: 'Wife Longevity Stack',
        memberId: 'member_wife',
        active: true,
        items: [fixtures.makeStackItem({ compoundId: suppMag.id, doseAmount: 200, doseUnit: 'mg' })],
      })
    );
    await apiCreateStack(
      api,
      'member_husband',
      fixtures.makeStackPayload({
        name: 'Husband Performance Stack',
        memberId: 'member_husband',
        active: true,
        items: [fixtures.makeStackItem({ compoundId: pedTestCyp.id, doseAmount: 60, doseUnit: 'mg' })],
      })
    );

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-stack"]').first().click();

    const systemicTimeline = page.locator('[data-testid="spread-systemic-timeline"]').first();

    await selectMember(page, 'member_wife');
    await waitForCondition(
      async () => {
        const bodyHasStack = (await page.locator('body').innerText()).includes('Wife Longevity Stack');
        if (!bodyHasStack || !(await systemicTimeline.isVisible())) return false;
        return /Magnesium Glycinate/i.test(await systemicTimeline.innerText());
      },
      { message: 'Expected Wife Longevity Stack and Magnesium Glycinate to render after switching to member_wife' }
    );
    const wifeViewText = await systemicTimeline.innerText();
    assert.match(wifeViewText, /Magnesium Glycinate/i, 'Wife systemic spread should include Magnesium Glycinate');
    assert.doesNotMatch(
      wifeViewText,
      /Testosterone Cypionate/i,
      'Wife systemic spread must NOT leak Husband stack compound Testosterone Cypionate'
    );

    await selectMember(page, 'member_husband');
    await waitForCondition(
      async () => {
        const bodyHasStack = (await page.locator('body').innerText()).includes('Husband Performance Stack');
        if (!bodyHasStack || !(await systemicTimeline.isVisible())) return false;
        return /Testosterone Cypionate/i.test(await systemicTimeline.innerText());
      },
      { message: 'Expected Husband Performance Stack and Testosterone Cypionate to render after switching to member_husband' }
    );
    const husbandViewText = await systemicTimeline.innerText();
    assert.match(husbandViewText, /Testosterone Cypionate/i, 'Husband systemic spread should include Testosterone Cypionate');
    assert.doesNotMatch(
      husbandViewText,
      /Magnesium Glycinate/i,
      'Husband systemic spread must NOT leak Wife stack compound Magnesium Glycinate'
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-03: navigates all 4 core section tabs and applies ownership and verification status filters', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-sections"]').first().click();

    const sectionExpectations = [
      { tab: 'section-tab-peptides', compound: peptideBpc },
      { tab: 'section-tab-peds', compound: pedTestCyp },
      { tab: 'section-tab-vitamins_supplements', compound: suppMag },
      { tab: 'section-tab-dermatology', compound: dermTret },
    ];

    for (const { tab, compound } of sectionExpectations) {
      const tabLoc = page.locator(`[data-testid="${tab}"]`).first();
      await tabLoc.waitFor({ state: 'visible', timeout: 10_000 });
      await tabLoc.click();
      await compoundCardLocator(page, compound).waitFor({ state: 'visible', timeout: 10_000 });
    }

    // Test filter-ownership on vitamins_supplements (Magnesium/Zinc = have, Copper = dont_have)
    await page.locator('[data-testid="section-tab-vitamins_supplements"]').first().click();
    await compoundCardLocator(page, suppMag).waitFor({ state: 'visible', timeout: 10_000 });
    await compoundCardLocator(page, suppCopper).waitFor({ state: 'visible', timeout: 10_000 });

    const ownershipFilter = page.locator('[data-testid="filter-ownership"]').first();
    await selectOptionOnControl(page, ownershipFilter, { value: 'have', labelRe: /^have$/i });
    await compoundCardLocator(page, suppMag).waitFor({ state: 'visible', timeout: 5_000 });
    await waitForCondition(
      async () => !(await compoundCardLocator(page, suppCopper).isVisible()),
      { message: 'Expected dont_have compound Copper to be filtered out when filter-ownership is "have"' }
    );
    await selectOptionOnControl(page, ownershipFilter, { value: 'all', labelRe: /all|any|clear|reset/i });
    await compoundCardLocator(page, suppCopper).waitFor({ state: 'visible', timeout: 5_000 });

    // Test filter-status on peptides (BPC-157 = ai_draft)
    await page.locator('[data-testid="section-tab-peptides"]').first().click();
    const statusFilter = page.locator('[data-testid="filter-status"]').first();
    await selectOptionOnControl(page, statusFilter, { value: 'ai_draft', labelRe: /ai[\s_-]?draft|draft/i });
    await compoundCardLocator(page, peptideBpc).waitFor({ state: 'visible', timeout: 5_000 });

    await selectOptionOnControl(page, statusFilter, { value: 'verified', labelRe: /^verified$/i });
    await waitForCondition(
      async () => !(await compoundCardLocator(page, peptideBpc).isVisible()),
      { message: 'Expected ai_draft compound BPC-157 to be hidden when filter-status is "verified"' }
    );
    await selectOptionOnControl(page, statusFilter, { value: 'all', labelRe: /all|any|clear|reset/i });

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-04: customizes section schema (btn-customize-section) and adds a new compound via UI form (btn-add-compound + btn-save-compound)', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-sections"]').first().click();
    await page.locator('[data-testid="section-tab-peptides"]').first().click();

    // 1. Customize section schema (exclude header search <form>, prefer getByLabel + input:not([type]) + submit priority)
    await page.locator('[data-testid="btn-customize-section"]').first().click();
    const customContainer =
      (await firstVisibleFrom(page, NON_SEARCH_FORM_SELECTORS, { waitMs: 400 })) ||
      page.locator('main, body').first();

    let fieldLabelInput = await firstVisibleInput(customContainer, {
      labelRes: [/field\s*label|\blabel\b|field\s*name/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="label" i]',
        'input[placeholder*="label" i]',
        'input[aria-label*="label" i]',
        'input[placeholder*="field name" i]',
        'input[aria-label*="field name" i]',
      ],
    });
    if (!fieldLabelInput) {
      const addFieldBtn = customContainer
        .locator('button')
        .filter({ hasText: /add\s*(?:custom\s*)?field|new\s*field|\+\s*field/i })
        .first();
      await addFieldBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await addFieldBtn.click();
      fieldLabelInput = await firstVisibleInput(customContainer, {
        labelRes: [/field\s*label|\blabel\b|field\s*name|\bfield\b/i],
        allowedTags: ['INPUT'],
        editableOnly: true,
        selectors: [
          'input[name*="label" i]',
          'input[placeholder*="label" i]',
          'input[aria-label*="label" i]',
          'input[placeholder*="field" i]',
          'input[type="text"]:not([data-testid="global-search-input"])',
          'input:not([type]):not([data-testid="global-search-input"])',
        ],
        waitMs: 300,
      });
    }
    assert.ok(fieldLabelInput, 'Expected visible custom field label input inside customize-section panel');
    await fieldLabelInput.fill('Purity COA URL');

    const fieldKeyInput = await firstVisibleInput(customContainer, {
      labelRes: [/field\s*key|\bkey\b/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="key" i]',
        'input[placeholder*="key" i]',
        'input[aria-label*="key" i]',
      ],
    });
    if (fieldKeyInput) {
      await fieldKeyInput.fill('purity_coa_url');
    }

    const fieldTypeSelect = await firstVisibleInput(customContainer, {
      labelRes: [/field\s*type|\btype\b/i],
      allowedTags: ['SELECT'],
      selectors: [
        'select[name*="type" i]',
        'select[aria-label*="type" i]',
        GENERIC_NON_GLOBAL_SELECT,
      ],
    });
    if (fieldTypeSelect) {
      await selectOptionOnControl(page, fieldTypeSelect, { value: 'url', labelRe: /url/i });
    }

    const saveSchemaBtn = await findSubmitButton(customContainer, /save|apply|update|done/i);
    assert.ok(saveSchemaBtn, 'Expected visible Save button inside customize-section panel');
    await saveSchemaBtn.click();

    await waitForCondition(
      async () => {
        const secRes = await api.get('/api/v1/sections/peptides');
        if (secRes.status !== 200) return false;
        const sec = unwrapData(secRes.json, 'section');
        return (sec?.customFields || []).some(
          (f) => f.key === 'purity_coa_url' || /purity\s*coa/i.test(f.label || '')
        );
      },
      { message: 'Expected custom field "Purity COA URL" to persist on GET /api/v1/sections/peptides' }
    );

    // 2. Add a new compound via btn-add-compound + btn-save-compound
    await page.locator('[data-testid="btn-add-compound"]').first().click();
    const saveCompoundBtn = page.locator('[data-testid="btn-save-compound"]').first();
    await saveCompoundBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const saveAncestorForm = saveCompoundBtn.locator('xpath=ancestor::form[1]').first();
    const formScope =
      ((await saveAncestorForm.count()) > 0 && (await saveAncestorForm.isVisible())
        ? saveAncestorForm
        : await firstVisibleFrom(page, [
            '[role="dialog"]:has([data-testid="btn-save-compound"])',
            '[role="alertdialog"]:has([data-testid="btn-save-compound"])',
            '[data-testid="compound-detail"]',
            ...NON_SEARCH_FORM_SELECTORS,
          ])) || page.locator('main, body').first();

    const nameInput = await firstVisibleInput(formScope, {
      labelRes: [/compound\s*name|\bname\b/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name="name"]',
        'input[name*="name" i]',
        'input[placeholder*="name" i]',
        'input[aria-label*="name" i]',
        'input[type="text"]:not([data-testid="global-search-input"])',
        'input:not([type]):not([data-testid="global-search-input"])',
      ],
    });
    assert.ok(nameInput, 'Expected visible compound name input in Add Compound form');
    await nameInput.fill('Selank Nasal Spray');

    const summaryInput = await firstVisibleInput(formScope, {
      labelRes: [/summary|what\s*it\s*is|description/i],
      allowedTags: ['TEXTAREA', 'INPUT'],
      editableOnly: true,
      selectors: [
        'textarea[name*="summary" i]',
        'input[name*="summary" i]',
        'textarea[placeholder*="what it is" i]',
        'textarea[placeholder*="summary" i]',
        'textarea[aria-label*="summary" i]',
        'textarea',
      ],
    });
    if (summaryInput) {
      await summaryInput.fill('Synthetic tuftsin analogue heptapeptide studied for anxiolytic modulation.');
    }

    await saveCompoundBtn.click();

    const createdSelank = await waitForCondition(
      async () => {
        const list = await apiListCompounds(api);
        return list.find((c) => /selank/i.test(c.name || '')) || null;
      },
      { message: 'Expected newly created compound "Selank Nasal Spray" to persist in GET /api/v1/compounds' }
    );

    await page.locator('[data-testid="section-tab-peptides"]').first().click();
    await compoundCardLocator(page, createdSelank).waitFor({ state: 'visible', timeout: 10_000 });

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-05: opens compound-detail, verifies ai_draft, edits/saves profile, updates ownership, and computes live U-100 math in reconstitution-calc', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-sections"]').first().click();
    await page.locator('[data-testid="section-tab-peptides"]').first().click();
    await compoundCardLocator(page, peptideBpc).click();

    const detail = page.locator('[data-testid="compound-detail"]').first();
    await detail.waitFor({ state: 'visible', timeout: 10_000 });
    const detailText = await detail.innerText();
    assert.match(detailText, /BPC-157/i, 'compound-detail should show compound name');
    await assertDisclaimerVisible(page);

    // 1. One-tap verify ai_draft -> verified
    const verifyBtn = page.locator('[data-testid="btn-verify-compound"]').first();
    await verifyBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await verifyBtn.click();

    await waitForCondition(
      async () => {
        const res = await api.get(`/api/v1/compounds/${encodeURIComponent(peptideBpc.id)}`);
        const cmp = unwrapData(res.json, 'compound');
        return cmp?.profileStatus === 'verified';
      },
      { message: 'Expected btn-verify-compound to transition BPC-157 profileStatus to "verified"' }
    );

    // 2. Update ownership-status-select (have -> low_stock -> have)
    const ownershipSel = page.locator('[data-testid="ownership-status-select"]').first();
    await selectOptionOnControl(page, ownershipSel, { value: 'low_stock', labelRe: /low[\s_-]?stock/i });
    await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/ownership');
        const records = unwrapData(res.json, ['ownership', 'ownerships', 'items']);
        return (
          Array.isArray(records) &&
          records.some((r) => r.compoundId === peptideBpc.id && r.status === 'low_stock')
        );
      },
      { message: 'Expected ownership-status-select change to persist "low_stock" via API' }
    );
    await selectOptionOnControl(page, ownershipSel, { value: 'have', labelRe: /^have$/i });
    await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/ownership');
        const records = unwrapData(res.json, ['ownership', 'ownerships', 'items']);
        return (
          Array.isArray(records) &&
          records.some((r) => r.compoundId === peptideBpc.id && r.status === 'have')
        );
      },
      { message: 'Expected ownership-status-select restore to persist "have" via API' }
    );

    // 3. Edit & save compound profile (supports both inline detail editor and modal edit dialog)
    await page.locator('[data-testid="btn-edit-compound"]').first().click();
    const saveBtn = page.locator('[data-testid="btn-save-compound"]').first();
    await saveBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const editFormAncestor = saveBtn.locator('xpath=ancestor::form[1]').first();
    const editScope =
      ((await editFormAncestor.count()) > 0 && (await editFormAncestor.isVisible())
        ? editFormAncestor
        : await firstVisibleFrom(page, [
            '[role="dialog"]:has([data-testid="btn-save-compound"])',
            '[role="alertdialog"]:has([data-testid="btn-save-compound"])',
            '[data-testid="compound-detail"]',
          ])) || detail;

    const editableArea = await firstVisibleInput(editScope, {
      labelRes: [/notes|summary|description/i],
      allowedTags: ['TEXTAREA'],
      editableOnly: true,
      selectors: [
        'textarea[name*="notes" i]',
        'textarea[placeholder*="notes" i]',
        'textarea[name*="summary" i]',
        'textarea',
      ],
    });
    assert.ok(editableArea, 'Expected editable textarea after clicking btn-edit-compound');
    await editableArea.fill('Updated synthetic educational note for BPC-157 E2E verification.');
    await saveBtn.click();

    await waitForCondition(
      async () => {
        const res = await api.get(`/api/v1/compounds/${encodeURIComponent(peptideBpc.id)}`);
        return res.text.includes('Updated synthetic educational note for BPC-157');
      },
      { message: 'Expected btn-edit-compound + btn-save-compound edit to persist via API' }
    );

    // 4. Interactive Peptides Reconstitution Calculator (semantic label/attr lookup + live recalculation)
    const reconCalc = page.locator('[data-testid="reconstitution-calc"]').first();
    await reconCalc.waitFor({ state: 'visible', timeout: 10_000 });

    const vialInput = await firstVisibleInput(reconCalc, {
      labelRes: [/vial|peptide.*(?:mg|amount)|amount.*mg/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="vial" i]',
        'input[aria-label*="vial" i]',
        'input[placeholder*="vial" i]',
        'input[name*="mg" i]',
        'input[aria-label*="mg" i]',
      ],
    });
    const diluentInput = await firstVisibleInput(reconCalc, {
      labelRes: [/diluent|bac|water|volume|ml/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="diluent" i]',
        'input[name*="water" i]',
        'input[name*="ml" i]',
        'input[aria-label*="diluent" i]',
        'input[aria-label*="water" i]',
        'input[aria-label*="ml" i]',
        'input[placeholder*="diluent" i]',
        'input[placeholder*="ml" i]',
      ],
    });
    const doseInput = await firstVisibleInput(reconCalc, {
      labelRes: [/dose|target|mcg/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="dose" i]',
        'input[name*="mcg" i]',
        'input[aria-label*="dose" i]',
        'input[aria-label*="mcg" i]',
        'input[placeholder*="dose" i]',
        'input[placeholder*="mcg" i]',
      ],
    });

    const numInputs = reconCalc.locator(
      'input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"], input[type="text"], input:not([type])'
    );
    const numCount = await numInputs.count();
    const resolvedVial = vialInput || (numCount >= 1 ? numInputs.nth(0) : null);
    const resolvedDiluent = diluentInput || (numCount >= 2 ? numInputs.nth(1) : null);
    const resolvedDose = doseInput || (numCount >= 3 ? numInputs.nth(2) : null);

    assert.ok(
      resolvedVial && resolvedDiluent && resolvedDose,
      `Expected 3 inputs (vial, diluent, dose) inside reconstitution-calc (found ${numCount} numeric inputs)`
    );

    await resolvedVial.fill('5');
    await resolvedDiluent.fill('2');
    await resolvedDose.fill('250');
    await waitForCondition(
      async () => /\b10(?:\.0+)?\s*(?:u|iu|units?)\b|\b0\.10?\s*mL\b/i.test(await reconCalc.innerText()),
      { message: 'Expected reconstitution-calc to compute 10 U-100 units (0.10 mL) for 5 mg / 2 mL / 250 mcg' }
    );

    await resolvedDose.fill('500');
    await waitForCondition(
      async () => /\b20(?:\.0+)?\s*(?:u|iu|units?)\b|\b0\.20?\s*mL\b/i.test(await reconCalc.innerText()),
      { message: 'Expected reconstitution-calc to live-update to 20 U-100 units (0.20 mL) for 500 mcg dose' }
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-06: builds a cross-section stack (btn-new-stack, stack-selector, stack-compound-picker) and tests have-only & non-mutating What-If toggles', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await selectMember(page, 'member_wife');
    await page.locator('[data-testid="nav-stack"]').first().click();

    // Snapshot pre-existing stack IDs BEFORE clicking btn-new-stack (eliminates stale T1-02 fallback)
    const existingStackIds = new Set(
      (await apiListStacks(api, 'member_wife')).map((s) => s.id)
    );

    // Create a new stack via btn-new-stack
    const newStackName = 'Wife Smart Protocol';
    let dialogHandled = false;
    const dialogHandler = async (dialog) => {
      dialogHandled = true;
      await dialog.accept(newStackName);
    };
    page.once('dialog', dialogHandler);

    await page.locator('[data-testid="btn-new-stack"]').first().click();
    await page.waitForTimeout(250);
    page.off('dialog', dialogHandler);

    if (!dialogHandled) {
      // Strictly scope to dialog or non-search form (NEVER fall back to body / global-search-input)
      const dialogScope = await firstVisibleFrom(page, NON_SEARCH_FORM_SELECTORS, { waitMs: 350 });
      if (dialogScope) {
        const stackNameInput = await firstVisibleInput(dialogScope, {
          labelRes: [/stack\s*name|\bname\b/i],
          allowedTags: ['INPUT'],
          editableOnly: true,
          selectors: [
            'input[name*="name" i]',
            'input[placeholder*="stack" i]',
            'input[aria-label*="stack" i]',
            'input[placeholder*="name" i]',
            'input[type="text"]:not([data-testid="global-search-input"])',
            'input:not([type]):not([data-testid="global-search-input"])',
          ],
        });
        if (stackNameInput) {
          await stackNameInput.fill(newStackName);
          const confirmBtn = await findSubmitButton(dialogScope, /create|save|add|confirm/i, {
            excludeTestIds: ['btn-new-stack'],
          });
          assert.ok(confirmBtn, 'Expected visible submit button inside new-stack dialog/form');
          await confirmBtn.click();
        }
      }
    }

    const createdStack = await waitForCondition(
      async () => {
        const stacks = await apiListStacks(api, 'member_wife');
        const newlyCreated = stacks.filter((s) => !existingStackIds.has(s.id));
        if (newlyCreated.length === 0) return null;
        return (
          newlyCreated.find((s) => s.name === newStackName) ||
          newlyCreated[newlyCreated.length - 1]
        );
      },
      { message: 'Expected btn-new-stack to persist a genuinely new stack for member_wife' }
    );
    assert.ok(
      !existingStackIds.has(createdStack.id),
      'btn-new-stack MUST create a brand-new stack ID distinct from pre-existing stacks'
    );

    // Ensure stack-selector is visible and selects the new stack
    const stackSelector = page.locator('[data-testid="stack-selector"]').first();
    await stackSelector.waitFor({ state: 'visible', timeout: 10_000 });
    await selectOptionOnControl(page, stackSelector, {
      value: createdStack.id,
      labelRe: new RegExp(createdStack.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    });

    // Pick compounds across sections via stack-compound-picker + btn-add-to-stack-<id>
    const picker = page.locator('[data-testid="stack-compound-picker"]').first();
    await picker.waitFor({ state: 'visible', timeout: 10_000 });

    await page.locator(`[data-testid="btn-add-to-stack-${peptideBpc.id}"]`).first().click();
    await page.locator(`[data-testid="btn-add-to-stack-${suppZinc.id}"]`).first().click();
    await page.locator(`[data-testid="btn-add-to-stack-${suppCopper.id}"]`).first().click();

    await waitForCondition(
      async () => {
        const stacks = await apiListStacks(api, 'member_wife');
        const active = stacks.find((s) => s.id === createdStack.id);
        const ids = new Set((active?.items || []).map((i) => i.compoundId));
        return ids.has(peptideBpc.id) && ids.has(suppZinc.id) && ids.has(suppCopper.id);
      },
      { message: 'Expected BPC-157, Zinc, and Copper to be added to active stack via btn-add-to-stack-<id>' }
    );

    const stacksBeforeToggles = await apiListStacks(api, 'member_wife');
    const persistedItemIdsBefore = (
      stacksBeforeToggles.find((s) => s.id === createdStack.id)?.items || []
    )
      .map((i) => i.compoundId)
      .sort();

    // Toggle stack-toggle-have-only (Copper is dont_have; BPC-157 & Zinc are have) and verify spread filtering
    const systemicTimeline = page.locator('[data-testid="spread-systemic-timeline"]').first();
    await systemicTimeline.waitFor({ state: 'visible', timeout: 10_000 });

    const haveOnlyToggle = page.locator('[data-testid="stack-toggle-have-only"]').first();
    if (await readToggleState(haveOnlyToggle)) {
      await clickToggle(haveOnlyToggle);
    }
    await waitForCondition(
      async () => {
        const text = await systemicTimeline.innerText();
        return /BPC-157/i.test(text) && /Zinc Picolinate/i.test(text) && /Copper Bisglycinate/i.test(text);
      },
      { message: 'Expected BPC-157, Zinc, and dont_have Copper in spread-systemic-timeline when have-only is OFF' }
    );

    await clickToggle(haveOnlyToggle);
    assert.equal(await readToggleState(haveOnlyToggle), true, 'Expected stack-toggle-have-only to turn ON');
    await waitForCondition(
      async () => {
        const text = await systemicTimeline.innerText();
        return (
          /BPC-157/i.test(text) &&
          /Zinc Picolinate/i.test(text) &&
          !/Copper Bisglycinate/i.test(text)
        );
      },
      {
        message:
          'Expected stack-toggle-have-only ON to hide dont_have compound Copper Bisglycinate while keeping have compounds visible',
      }
    );

    await clickToggle(haveOnlyToggle);
    assert.equal(await readToggleState(haveOnlyToggle), false, 'Expected stack-toggle-have-only to turn OFF');
    await waitForCondition(
      async () => /Copper Bisglycinate/i.test(await systemicTimeline.innerText()),
      {
        message:
          'Expected Copper Bisglycinate to reappear in spread-systemic-timeline when stack-toggle-have-only is OFF',
      }
    );

    // Toggle what-if-toggle and assert persisted stack is NOT mutated (F37)
    const whatIfToggle = page.locator('[data-testid="what-if-toggle"]').first();
    const initialWhatIf = await readToggleState(whatIfToggle);
    await clickToggle(whatIfToggle);
    const flippedWhatIf = await readToggleState(whatIfToggle);
    assert.notEqual(flippedWhatIf, initialWhatIf, 'Expected what-if-toggle to activate What-If simulation mode');
    await page.waitForTimeout(150);

    const stacksAfterWhatIf = await apiListStacks(api, 'member_wife');
    const persistedItemIdsAfter = (
      stacksAfterWhatIf.find((s) => s.id === createdStack.id)?.items || []
    )
      .map((i) => i.compoundId)
      .sort();
    assert.deepEqual(
      persistedItemIdsAfter,
      persistedItemIdsBefore,
      'What-If mode MUST NOT mutate persisted stack items'
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-07: renders Dual-Track Smart Spread (8 systemic slots, Derm AM/PM, Hair/Scalp, and Interaction Alerts)', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    // Create a comprehensive cross-section stack for member_husband (pregnancyOrTrying: false)
    const fullStack = await apiCreateStack(
      api,
      'member_husband',
      fixtures.makeStackPayload({
        name: 'Full Dual-Track Spread Stack',
        memberId: 'member_husband',
        active: true,
        items: [
          fixtures.makeStackItem({ compoundId: peptideBpc.id, doseAmount: 250, doseUnit: 'mcg' }),
          fixtures.makeStackItem({ compoundId: pedTestCyp.id, doseAmount: 60, doseUnit: 'mg' }),
          fixtures.makeStackItem({ compoundId: suppMag.id, doseAmount: 200, doseUnit: 'mg' }),
          fixtures.makeStackItem({ compoundId: suppZinc.id, doseAmount: 30, doseUnit: 'mg' }),
          fixtures.makeStackItem({ compoundId: suppCopper.id, doseAmount: 2, doseUnit: 'mg' }),
          fixtures.makeStackItem({ compoundId: dermVitC.id, doseAmount: 4, doseUnit: 'drops' }),
          fixtures.makeStackItem({ compoundId: dermSpf.id, doseAmount: 2, doseUnit: 'pumps' }),
          fixtures.makeStackItem({ compoundId: dermTret.id, doseAmount: 1, doseUnit: 'pea_size' }),
          fixtures.makeStackItem({ compoundId: dermGlycolic.id, doseAmount: 5, doseUnit: 'drops' }),
          fixtures.makeStackItem({ compoundId: dermMinoxidil.id, doseAmount: 1, doseUnit: 'mL' }),
        ],
      })
    );

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await selectMember(page, 'member_husband');
    await page.locator('[data-testid="nav-stack"]').first().click();
    await selectOptionOnControl(page, page.locator('[data-testid="stack-selector"]').first(), {
      value: fullStack.id,
      labelRe: /Full Dual-Track Spread Stack/i,
    });

    // Verify Systemic Timeline and canonical spread-slot-<slotId> containers (waits for async schedule fetch)
    const systemicTimeline = page.locator('[data-testid="spread-systemic-timeline"]').first();
    await systemicTimeline.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForCondition(
      async () => {
        const text = await systemicTimeline.innerText();
        return /BPC-157/i.test(text) && /Zinc Picolinate/i.test(text) && /Copper Bisglycinate/i.test(text);
      },
      { message: 'Expected spread-systemic-timeline to populate with BPC-157, Zinc, and Copper after selecting fullStack' }
    );

    let renderedCanonicalSlots = 0;
    for (const slotId of CANONICAL_SYSTEMIC_SLOTS) {
      const slotLoc = page.locator(`[data-testid="spread-slot-${slotId}"]`).first();
      if ((await slotLoc.count()) > 0) {
        renderedCanonicalSlots += 1;
      }
    }
    assert.ok(
      renderedCanonicalSlots >= 3,
      `Expected canonical spread-slot-<slotId> containers in systemic timeline (found ${renderedCanonicalSlots})`
    );

    // Verify Dermatology AM, PM, and Hair/Scalp tracks
    const dermAm = page.locator('[data-testid="spread-derm-am"]').first();
    await dermAm.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForCondition(
      async () => /Vitamin C|SPF 50/i.test(await dermAm.innerText()),
      { message: 'spread-derm-am should show AM skincare steps' }
    );

    const dermPm = page.locator('[data-testid="spread-derm-pm"]').first();
    await dermPm.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForCondition(
      async () => /Tretinoin|Glycolic/i.test(await dermPm.innerText()),
      { message: 'spread-derm-pm should show PM skin-cycling actives' }
    );

    const hairScalp = page.locator('[data-testid="spread-hair-scalp"]').first();
    await hairScalp.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForCondition(
      async () => /Minoxidil/i.test(await hairScalp.innerText()),
      { message: 'spread-hair-scalp should show scalp/hair track item' }
    );

    // Verify Interaction Alerts panel surfaces mineral separation / alternate-night interactions
    const alertsPanel = page.locator('[data-testid="interaction-alerts"]').first();
    await alertsPanel.waitFor({ state: 'visible', timeout: 10_000 });
    await waitForCondition(
      async () => /zinc|copper|tretinoin|glycolic|separat|alternat/i.test(await alertsPanel.innerText()),
      { message: 'interaction-alerts should describe active interaction resolutions' }
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-08: pins a slot override (btn-pin-override-<id>) and logs a daily dose (btn-log-dose-<id>) from Spread View', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const pinStack = await apiCreateStack(
      api,
      'member_wife',
      fixtures.makeStackPayload({
        name: 'Pin and Log Test Stack',
        memberId: 'member_wife',
        active: true,
        items: [
          fixtures.makeStackItem({ compoundId: peptideBpc.id, doseAmount: 250, doseUnit: 'mcg' }),
          fixtures.makeStackItem({ compoundId: suppMag.id, doseAmount: 200, doseUnit: 'mg' }),
        ],
      })
    );

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await selectMember(page, 'member_wife');
    await page.locator('[data-testid="nav-stack"]').first().click();
    await selectOptionOnControl(page, page.locator('[data-testid="stack-selector"]').first(), {
      value: pinStack.id,
      labelRe: /Pin and Log Test Stack/i,
    });

    // 1. Trigger pin override for BPC-157 (supports modal dialog/popover AND inline row <select>)
    const pinBtnTestId = `btn-pin-override-${peptideBpc.id}`;
    const pinBtn = page.locator(`[data-testid="${pinBtnTestId}"]`).first();
    await pinBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await pinBtn.click();

    const pinDialog = await firstVisibleFrom(
      page,
      ['[role="dialog"]', '[role="alertdialog"]', '[role="listbox"]', '[role="menu"]'],
      { waitMs: 350 }
    );
    if (pinDialog) {
      const slotSelect = await firstVisibleFrom(pinDialog, ['select']);
      if (slotSelect) {
        await selectOptionOnControl(page, slotSelect, {
          value: 'evening_dinner',
          labelRe: /evening|dinner|midday|morning/i,
        });
      } else {
        const slotChoice = pinDialog
          .locator('button, [role="option"], [role="menuitem"]')
          .filter({ hasText: /evening|dinner|midday|morning/i })
          .first();
        if ((await slotChoice.count()) > 0 && (await slotChoice.isVisible())) {
          await slotChoice.click();
        }
      }
      const confirmPin = await findSubmitButton(pinDialog, /pin|save|apply|confirm/i, {
        excludeTestIds: [pinBtnTestId],
      });
      if (confirmPin) await confirmPin.click();
    } else {
      const inlinePinHost =
        (await firstVisibleFrom(pinBtn, ['xpath=ancestor::*[self::li or self::article or self::tr][1]', 'xpath=..'])) ||
        page.locator('[data-testid="spread-systemic-timeline"]').first();
      const inlineSlotSel = await firstVisibleInput(inlinePinHost, {
        allowedTags: ['SELECT'],
        selectors: [GENERIC_NON_GLOBAL_SELECT],
      });
      if (inlineSlotSel) {
        await selectOptionOnControl(page, inlineSlotSel, {
          value: 'evening_dinner',
          labelRe: /evening|dinner|midday|morning/i,
        });
        const inlineConfirm = await findSubmitButton(inlinePinHost, /pin|save|apply|confirm/i, {
          excludeTestIds: [pinBtnTestId],
        });
        if (inlineConfirm) await inlineConfirm.click();
      }
    }

    await waitForCondition(
      async () => {
        const stacks = await apiListStacks(api, 'member_wife');
        const st = stacks.find((s) => s.id === pinStack.id);
        const item = (st?.items || []).find((i) => i.compoundId === peptideBpc.id);
        return Boolean(item?.pinnedSlot);
      },
      { message: 'Expected btn-pin-override-<compoundId> to persist a non-null pinnedSlot on stack item' }
    );

    // 2. Log a dose for Magnesium Glycinate via btn-log-dose-<compoundId>
    const logsBeforeRes = await api.get('/api/v1/members/member_wife/logs');
    assert.equal(logsBeforeRes.status, 200);
    const logsBefore = unwrapData(logsBeforeRes.json, ['logs', 'items']) || [];

    const logBtnTestId = `btn-log-dose-${suppMag.id}`;
    const logBtn = page.locator(`[data-testid="${logBtnTestId}"]`).first();
    await logBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await logBtn.click();

    // If a confirmation dialog/form opens for dose logging, submit it
    const logDialog = await firstVisibleFrom(page, ['[role="dialog"]', '[role="alertdialog"]'], { waitMs: 350 });
    if (logDialog) {
      const submitLog = await findSubmitButton(logDialog, /log|save|confirm|record/i, {
        excludeTestIds: [logBtnTestId],
      });
      if (submitLog) await submitLog.click();
    }

    await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/members/member_wife/logs');
        if (res.status !== 200) return false;
        const logsAfter = unwrapData(res.json, ['logs', 'items']) || [];
        return (
          logsAfter.length > logsBefore.length &&
          logsAfter.some((entry) => entry.compoundId === suppMag.id)
        );
      },
      { message: 'Expected btn-log-dose-<compoundId> to persist a dose log in GET /api/v1/members/member_wife/logs' }
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-10: AI Hub approves/dismisses proposals, opens prompt builder, imports AI JSON, renders all 5 AI setup guides, mints API key, and copies Context MD', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    // Seed two pending proposals (one to approve, one to dismiss) via schema-resilient helper
    const propApprove = await seedPendingCompoundProposal(api, server, {
      sourceModel: 'ai:claude',
      summary: 'Approve candidate: Epitalon synthetic draft',
      compoundPayload: fixtures.makePeptideCompound({
        name: 'Epitalon Proposal',
        canonicalMolecule: 'epitalon-proposal',
        profileStatus: 'ai_draft',
      }),
    });
    assert.ok(propApprove?.id, 'Expected approve proposal to have an id');

    const propDismiss = await seedPendingCompoundProposal(api, server, {
      sourceModel: 'ai:grok',
      summary: 'Dismiss candidate: Redundant synthetic draft',
      compoundPayload: fixtures.makeSupplementCompound({
        name: 'Dismissed Synthetic Compound',
        canonicalMolecule: 'dismissed-synthetic',
        profileStatus: 'ai_draft',
      }),
    });
    assert.ok(propDismiss?.id, 'Expected dismiss proposal to have an id');

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-ai-hub"]').first().click();

    // 1. Proposals Inbox: approve one, dismiss the other
    const proposalsList = page.locator('[data-testid="ai-proposals-list"]').first();
    await proposalsList.waitFor({ state: 'visible', timeout: 10_000 });

    const approveBtn = page.locator(`[data-testid="btn-approve-proposal-${propApprove.id}"]`).first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await approveBtn.click();

    const dismissBtn = page.locator(`[data-testid="btn-dismiss-proposal-${propDismiss.id}"]`).first();
    await dismissBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await dismissBtn.click();

    await waitForCondition(
      async () => {
        const allRes = await api.get('/api/v1/proposals', { query: { status: 'all' } });
        const pendingRes = await api.get('/api/v1/proposals');
        const allList = unwrapData(allRes.json, ['proposals', 'items']) || [];
        const pendingList = unwrapData(pendingRes.json, ['proposals', 'items']) || [];
        const p1 = allList.find((p) => p.id === propApprove.id);
        const p2 = allList.find((p) => p.id === propDismiss.id);
        const compounds = await apiListCompounds(api);
        const approvedCreated = compounds.some((c) => /Epitalon Proposal/i.test(c.name || ''));
        const dismissedCreated = compounds.some((c) => /Dismissed Synthetic Compound/i.test(c.name || ''));
        const p1Resolved = (p1 && /approv/i.test(String(p1.status || ''))) || (!pendingList.some((p) => p.id === propApprove.id) && approvedCreated);
        const p2Resolved = (p2 && /dismiss|reject/i.test(String(p2.status || ''))) || !pendingList.some((p) => p.id === propDismiss.id);
        return p1Resolved && p2Resolved && approvedCreated && !dismissedCreated;
      },
      { message: 'Expected btn-approve-proposal-<id> to approve & create compound and btn-dismiss-proposal-<id> to dismiss without creating compound' }
    );

    // 2. Universal AI Research Prompt Builder (strict: no bare "json", exclude ai-json-import-textarea & 5 ai-guide-* panels)
    const prePromptSnapshot = await page.evaluate((guideIds) => {
      const snippets = new Set();
      for (const el of document.querySelectorAll('textarea, pre, code')) {
        if (el.getAttribute('data-testid') === 'ai-json-import-textarea') continue;
        if (guideIds.some((id) => el.closest(`[data-testid="${id}"]`))) continue;
        const v = ('value' in el && el.value ? el.value : el.textContent || '').trim();
        if (v) snippets.add(v);
      }
      const bodyLines = new Set(
        (document.body?.innerText || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      );
      return { snippets: Array.from(snippets), bodyLines: Array.from(bodyLines) };
    }, AI_GUIDE_IDS);
    const preSnippetsSet = new Set(prePromptSnapshot.snippets);
    const preBodyLinesSet = new Set(prePromptSnapshot.bodyLines);

    await page.locator('[data-testid="btn-open-ai-prompt-builder"]').first().click();

    const promptDialog = await firstVisibleFrom(page, ['[role="dialog"]', '[role="alertdialog"]'], { waitMs: 450 });
    const promptScope = promptDialog || page.locator('main, body').first();

    const promptQueryInput = await firstVisibleInput(promptScope, {
      labelRes: [/compound|substance|topic|peptide|research|\bname\b/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="compound" i]',
        'input[name*="name" i]',
        'input[placeholder*="compound" i]',
        'input[placeholder*="substance" i]',
        ...(promptDialog
          ? [
              'input[type="text"]:not([data-testid="global-search-input"])',
              'input:not([type]):not([data-testid="global-search-input"])',
            ]
          : []),
      ],
    });
    if (promptQueryInput) {
      await promptQueryInput.fill('Thymosin Beta-4');
      const genBtn = await findSubmitButton(promptScope, /generate|build|create\s*prompt|refresh/i, {
        excludeTestIds: ['btn-open-ai-prompt-builder'],
      });
      if (genBtn) await genBtn.click();
    }

    await waitForCondition(
      async () => {
        if (promptDialog && (await promptDialog.isVisible())) {
          const dialogContent = await promptDialog.evaluate((dlg) => {
            const parts = [dlg.innerText || ''];
            for (const el of dlg.querySelectorAll('textarea, pre, code')) {
              if (el.getAttribute('data-testid') === 'ai-json-import-textarea') continue;
              parts.push('value' in el && el.value ? el.value : el.textContent || '');
            }
            return parts.join('\n');
          });
          return RESEARCH_PROMPT_SCHEMA_RE.test(dialogContent);
        }

        const inlineDelta = await page.evaluate(
          ({ guideIds, oldSnippets, oldLines }) => {
            const oldS = new Set(oldSnippets);
            const oldL = new Set(oldLines);
            const added = [];
            for (const el of document.querySelectorAll('textarea, pre, code')) {
              if (el.getAttribute('data-testid') === 'ai-json-import-textarea') continue;
              if (guideIds.some((id) => el.closest(`[data-testid="${id}"]`))) continue;
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;
              const v = ('value' in el && el.value ? el.value : el.textContent || '').trim();
              if (v && !oldS.has(v)) added.push(v);
            }
            for (const line of (document.body?.innerText || '').split(/\r?\n/)) {
              const t = line.trim();
              if (t && !oldL.has(t)) added.push(t);
            }
            return added.join('\n');
          },
          { guideIds: AI_GUIDE_IDS, oldSnippets: [...preSnippetsSet], oldLines: [...preBodyLinesSet] }
        );
        return RESEARCH_PROMPT_SCHEMA_RE.test(inlineDelta);
      },
      {
        message:
          'Expected btn-open-ai-prompt-builder to reveal a newly generated schema-strict research prompt (containing mechanismOfAction/timingRules/sectionId/halfLife/doNotPairWith)',
      }
    );

    if (promptDialog && (await promptDialog.isVisible())) {
      const closePromptBtn = promptDialog
        .locator('button')
        .filter({ hasText: /close|done|cancel|×/i })
        .first();
      if ((await closePromptBtn.count()) > 0 && (await closePromptBtn.isVisible())) {
        await closePromptBtn.click();
      }
    }

    // 3. AI JSON Paste Importer
    const pastedCompound = fixtures.makePeptideCompound({
      name: 'Semax Pasted Draft',
      canonicalMolecule: 'semax-pasted',
      profileStatus: 'ai_draft',
      provenance: { sourceModel: 'ai:gemini' },
    });
    const jsonTextarea = page.locator('[data-testid="ai-json-import-textarea"]').first();
    await jsonTextarea.waitFor({ state: 'visible', timeout: 10_000 });
    await jsonTextarea.fill(JSON.stringify(pastedCompound, null, 2));
    await page.locator('[data-testid="btn-import-ai-json"]').first().click();

    await waitForCondition(
      async () => {
        const list = await apiListCompounds(api);
        return list.some((c) => /Semax Pasted Draft/i.test(c.name || ''));
      },
      { message: 'Expected btn-import-ai-json to validate and persist pasted JSON compound' }
    );

    // 4. All 5 requested AI Platform Setup Guides (Gemini, Claude, Grok, GPT, Muse)
    const aiGuides = [
      { id: 'ai-guide-gemini', re: /gemini/i },
      { id: 'ai-guide-claude', re: /claude/i },
      { id: 'ai-guide-grok', re: /grok/i },
      { id: 'ai-guide-gpt', re: /gpt|chatgpt/i },
      { id: 'ai-guide-muse', re: /muse/i },
    ];
    for (const guide of aiGuides) {
      const guideLoc = page.locator(`[data-testid="${guide.id}"]`).first();
      await guideLoc.waitFor({ state: 'visible', timeout: 10_000 });
      assert.match(await guideLoc.innerText(), guide.re, `Expected ${guide.id} to describe its AI platform`);
    }

    // 5. Mint Scoped API Key (raw secret shown ONCE in UI, excluded from GET /api/v1/keys, live auth probed)
    const keysBefore = unwrapData((await api.get('/api/v1/keys')).json, ['keys', 'apiKeys', 'items']) || [];
    const tokensBefore = new Set(await extractCandidateSecretTokens(page));

    const mintBtn = page.locator('[data-testid="btn-mint-api-key"]').first();
    await mintBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const mintContainer = await findMintKeyContainer(mintBtn);
    const inlineNameInput = await firstVisibleInput(mintContainer, {
      labelRes: [/key\s*name|label|\bname\b/i],
      allowedTags: ['INPUT'],
      editableOnly: true,
      selectors: [
        'input[name*="name" i]',
        'input[name*="label" i]',
        'input[placeholder*="name" i]',
        'input[placeholder*="label" i]',
        'input[aria-label*="name" i]',
        'input[type="text"]:not([data-testid="global-search-input"])',
        'input:not([type]):not([data-testid="global-search-input"])',
      ],
    });
    if (inlineNameInput) {
      await inlineNameInput.fill('Tier1 Test Read Key');
    }
    // Ungated from inlineNameInput so scope is selected even without an inline name field
    await selectScopeControl(page, mintContainer, 'read');

    await mintBtn.click();

    const mintDialog = await firstVisibleFrom(page, ['[role="dialog"]', '[role="alertdialog"]'], { waitMs: 400 });
    if (mintDialog) {
      const currentKeys = unwrapData((await api.get('/api/v1/keys')).json, ['keys', 'apiKeys', 'items']) || [];
      if (currentKeys.length === keysBefore.length) {
        const keyNameInput = await firstVisibleInput(mintDialog, {
          labelRes: [/key\s*name|label|\bname\b/i],
          allowedTags: ['INPUT'],
          editableOnly: true,
          selectors: [
            'input[name*="name" i]:not([readonly]):not([disabled])',
            'input[name*="label" i]:not([readonly]):not([disabled])',
            'input[placeholder*="name" i]:not([readonly]):not([disabled])',
            'input[placeholder*="label" i]:not([readonly]):not([disabled])',
            'input[type="text"]:not([readonly]):not([disabled]):not([data-testid="global-search-input"])',
            'input:not([type]):not([readonly]):not([disabled]):not([data-testid="global-search-input"])',
          ],
        });
        if (keyNameInput) await keyNameInput.fill('Tier1 Test Read Key');
        await selectScopeControl(page, mintDialog, 'read');
        const confirmMint = await findSubmitButton(mintDialog, /mint|create|generate|confirm|save/i, {
          excludeTestIds: ['btn-mint-api-key'],
        });
        if (confirmMint) await confirmMint.click();
      }
    }

    const keysAfterPayload = await waitForCondition(
      async () => {
        const res = await api.get('/api/v1/keys');
        if (res.status !== 200) return null;
        const keysAfter = unwrapData(res.json, ['keys', 'apiKeys', 'items']) || [];
        return keysAfter.length > keysBefore.length ? { res, keysAfter } : null;
      },
      { message: 'Expected btn-mint-api-key to create a new API key in GET /api/v1/keys' }
    );
    const keysAfterRes = keysAfterPayload.res;
    const keyMetadataStrings = collectKeyMetadataExclusions(keysAfterPayload.keysAfter);
    const rejectedTokens = new Set();
    const uuidRe = /^(?:key[_-])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const revealedSecret = await waitForCondition(
      async () => {
        const tokensAfter = await extractCandidateSecretTokens(page);
        const fresh = tokensAfter.filter(
          (t) =>
            !tokensBefore.has(t) &&
            !keyMetadataStrings.has(t) &&
            !rejectedTokens.has(t) &&
            t !== server.adminToken &&
            t !== server.passcode
        );
        const notInKeysApi = fresh.filter((t) => !keysAfterRes.text.includes(t));
        const inKeysApi = fresh.filter((t) => keysAfterRes.text.includes(t));
        const ordered = [
          ...notInKeysApi.filter((t) => !uuidRe.test(t)),
          ...notInKeysApi.filter((t) => uuidRe.test(t)),
          ...inKeysApi.filter((t) => !uuidRe.test(t)),
          ...inKeysApi.filter((t) => uuidRe.test(t)),
        ];
        for (const candidate of ordered.slice(0, 10)) {
          const probeApi = createApiClient({ baseUrl: server.baseUrl, token: candidate });
          const probeRes = await probeApi.get('/api/v1/sections');
          if (probeRes.status === 200) return candidate;
          const probeMcp = createMcpClient({ baseUrl: server.baseUrl, token: candidate });
          const initRes = await probeMcp.initialize({ name: 'home-pharmacy-tier1-probe', version: '1.0.0' });
          if (initRes.status === 200 && initRes.error === null) return candidate;
          rejectedTokens.add(candidate);
        }
        return null;
      },
      {
        message:
          'Expected minted API key raw secret to be revealed once in the UI and authenticate live API/MCP',
      }
    );
    assert.ok(revealedSecret.length >= 20, 'Minted API key secret should be a non-trivial token');
    assert.ok(
      !keysAfterRes.text.includes(revealedSecret),
      'GET /api/v1/keys MUST NOT re-expose raw minted API key secret (hashed at rest per F29)'
    );

    // Dismiss any reveal dialog so btn-copy-context-md is unobstructed
    const openRevealDialog = await firstVisibleFrom(page, ['[role="dialog"]', '[role="alertdialog"]']);
    if (openRevealDialog) {
      const closeBtn = openRevealDialog
        .locator('button')
        .filter({ hasText: /close|done|dismiss|ok|×/i })
        .first();
      if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible())) {
        await closeBtn.click();
      }
    }

    // 6. Copy Context MD (zero raw adminToken / passcode leaked)
    let fetchedContextMd = null;
    const ctxResponseHandler = async (res) => {
      if (res.url().includes('/api/v1/export/context.md') && res.status() === 200) {
        try {
          fetchedContextMd = await res.text();
        } catch {
          // Ignore body read race
        }
      }
    };
    page.on('response', ctxResponseHandler);
    try {
      await page.locator('[data-testid="btn-copy-context-md"]').first().click();
      const contextText = await waitForCondition(
        async () => {
          if (fetchedContextMd && fetchedContextMd.trim().length > 20) return fetchedContextMd;
          try {
            const clip = await page.evaluate(() => navigator.clipboard.readText());
            if (clip && clip.trim().length > 20) return clip;
          } catch {
            // Clipboard permission fallback checked via network response
          }
          return null;
        },
        { message: 'Expected btn-copy-context-md to copy or fetch non-empty Context MD bundle' }
      );
      assert.ok(
        contextText.includes('#') || /peptides|sections|household|compounds/i.test(contextText),
        'Expected Context MD to contain Markdown household catalog context'
      );
      assert.ok(!contextText.includes(server.adminToken), 'Context MD MUST NOT leak adminToken');
      assert.ok(!contextText.includes(server.passcode), 'Context MD MUST NOT leak household passcode');
    } finally {
      page.off('response', ctxResponseHandler);
    }

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T1-11: Settings View renders all 4 config panels and executes JSON export, CSV export, and Print Report with F44 disclaimer', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    // Stub window.print before opening page so headless Chromium never blocks on native print UI
    await browserHandle.context.addInitScript(() => {
      window.__e2ePrintCalls = 0;
      window.print = () => {
        window.__e2ePrintCalls += 1;
      };
    });

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-settings"]').first().click();

    // All 4 canonical settings panels visible
    for (const panelId of ['settings-members', 'settings-ai-policy', 'settings-sync', 'settings-pin-lock']) {
      await page.locator(`[data-testid="${panelId}"]`).first().waitFor({ state: 'visible', timeout: 10_000 });
    }

    // 1. Export JSON (btn-export-json) — capture either download or /api/v1/export/hub.json fetch
    const jsonExportText = await captureExportText(page, 'btn-export-json', '/api/v1/export/hub.json');
    assert.ok(jsonExportText && jsonExportText.trim().length > 10, 'Expected btn-export-json to produce Hub JSON export');
    const parsedExport = JSON.parse(jsonExportText);
    assert.ok(parsedExport && typeof parsedExport === 'object', 'Exported Hub JSON must parse cleanly');
    assert.ok(!jsonExportText.includes(server.adminToken), 'Exported Hub JSON MUST NOT contain raw adminToken');
    assert.ok(!jsonExportText.includes(server.passcode), 'Exported Hub JSON MUST NOT contain raw passcode');

    // 2. Export CSV (btn-export-csv) — capture either download or /api/v1/export/compounds.csv fetch
    const csvExportText = await captureExportText(page, 'btn-export-csv', '/api/v1/export/compounds.csv');
    assert.ok(csvExportText && csvExportText.includes(','), 'Expected btn-export-csv to produce valid CSV content');
    assert.match(csvExportText, /BPC-157|Testosterone|Magnesium/i, 'CSV export should include seeded compounds');
    assert.ok(!csvExportText.includes(server.adminToken), 'CSV export MUST NOT leak raw adminToken');
    assert.ok(!csvExportText.includes(server.passcode), 'CSV export MUST NOT leak raw passcode');

    // 3. Print Report (btn-print-report) — triggers window.print() or opens a NEW printable report with F44 disclaimer
    await page.evaluate(() => {
      window.__e2ePrintCalls = 0;
    });
    const printDialogLoc = page.locator('[role="dialog"], [role="alertdialog"]');
    const printArticleLoc = page.locator('article');
    const dialogsBeforePrint = await countVisible(printDialogLoc);
    const articlesBeforePrint = await countVisible(printArticleLoc);
    await page.locator('[data-testid="btn-print-report"]').first().click();

    await waitForCondition(
      async () => {
        const calls = await page.evaluate(() => window.__e2ePrintCalls || 0);
        if (calls > 0) return true;
        if ((await countVisible(printDialogLoc)) > dialogsBeforePrint) {
          const dlg = await lastVisibleOf(printDialogLoc);
          if (dlg && DISCLAIMER_RE.test(await dlg.innerText())) return true;
        }
        if ((await countVisible(printArticleLoc)) > articlesBeforePrint) {
          const art = await lastVisibleOf(printArticleLoc);
          if (art && DISCLAIMER_RE.test(await art.innerText())) return true;
        }
        return false;
      },
      { message: 'Expected btn-print-report to invoke window.print() or render a new printable report with F44 disclaimer' }
    );
    await assertDisclaimerVisible(page);

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 (Independent Clean-Slate Suite): Starter Catalog & Protocol OS Import
// ---------------------------------------------------------------------------

describe('Tier 1: Clean-Slate Starter Catalog & Protocol OS Import E2E (Playwright Chromium)', () => {
  it('T1-09: Cabinet View loads Starter Reference Catalog (btn-load-starter-catalog) and imports Protocol OS export (btn-import-protocol-os)', async () => {
    let cleanServer;
    let cleanBrowser;
    try {
      cleanServer = await startE2EServer();
      const cleanApi = createApiClient({ baseUrl: cleanServer.baseUrl, token: cleanServer.adminToken });
      const initialCompounds = await apiListCompounds(cleanApi);
      if (!cleanServer.external) {
        assert.equal(
          initialCompounds.length,
          0,
          'Fresh managed server should start clean-slate with 0 compounds'
        );
      }

      cleanBrowser = await launchBrowser({ viewport: { width: 1280, height: 800 } });
      const page = await cleanBrowser.openAuthenticatedPage(cleanServer.baseUrl, {
        token: cleanServer.adminToken,
        passcode: cleanServer.passcode,
      });

      await page.locator('[data-testid="nav-cabinet"]').first().click();
      const cabinetList = page.locator('[data-testid="cabinet-list"]').first();
      await cabinetList.waitFor({ state: 'visible', timeout: 10_000 });

      // 1. Load Starter Reference Catalog (track HTTP seed response for external-server idempotency)
      let seedOkResponse = false;
      const seedResHandler = (res) => {
        if (res.url().includes('/api/v1/seed/starter') && (res.status() === 200 || res.status() === 201)) {
          seedOkResponse = true;
        }
      };
      page.on('response', seedResHandler);
      let seededCompounds;
      try {
        const starterBtn = page.locator('[data-testid="btn-load-starter-catalog"]').first();
        await starterBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await starterBtn.click();

        seededCompounds = await waitForCondition(
          async () => {
            const list = await apiListCompounds(cleanApi);
            const sections = new Set(list.map((c) => c.sectionId));
            const hasAllFour =
              sections.has('peptides') &&
              sections.has('peds') &&
              sections.has('vitamins_supplements') &&
              sections.has('dermatology');
            if (!hasAllFour) return null;
            if (!cleanServer.external) {
              return list.length >= 4 ? list : null;
            }
            return list.length > initialCompounds.length || seedOkResponse ? list : null;
          },
          { message: 'Expected btn-load-starter-catalog to seed compounds across all 4 core sections' }
        );
      } finally {
        page.off('response', seedResHandler);
      }
      assert.ok(seededCompounds.length >= 4, 'Starter catalog should populate compounds across all 4 sections');
      await waitForCondition(
        async () => {
          const text = (await cabinetList.innerText()).trim();
          return text.length > 20 && seededCompounds.some((c) => c.name && text.includes(c.name));
        },
        { message: 'Expected cabinet-list to render populated starter catalog compound names' }
      );

      // 2. Snapshot pre-import compound IDs & log count BEFORE clicking btn-import-protocol-os
      const preImportCompounds = await apiListCompounds(cleanApi);
      const preImportIds = new Set(preImportCompounds.map((c) => c.id));
      const preLogsWife = await cleanApi.get('/api/v1/members/member_wife/logs');
      const preLogsHusband = await cleanApi.get('/api/v1/members/member_husband/logs');
      const logsBeforeImport =
        (unwrapData(preLogsWife.json, ['logs', 'items'])?.length || 0) +
        (unwrapData(preLogsHusband.json, ['logs', 'items'])?.length || 0);

      let protocolExport = fixtures.makeProtocolOsExport();
      if (cleanServer.external && preImportCompounds.some((c) => /wolverine/i.test(c.name || ''))) {
        const uniq = Date.now();
        protocolExport = {
          ...protocolExport,
          protocols: [
            ...protocolExport.protocols,
            {
              id: `proto_ext_syn_${uniq}`,
              profile: 'Spouse A',
              peptideId: `syn_blend_${uniq}`,
              peptideName: `Synthetic Blend ${uniq}`,
              doseMcg: 300,
              doseUnit: 'mcg',
              doseValue: 300,
              route: 'SubQ',
              schedule: { days: [1, 3, 5], timeOfDay: 'morning' },
              cycleDays: 28,
              startDate: '2026-10-01',
              active: true,
              updatedAt: '2026-10-15T08:00:00.000Z',
            },
          ],
          logs: [
            ...protocolExport.logs,
            {
              id: `log_ext_syn_${uniq}`,
              protocolId: `proto_ext_syn_${uniq}`,
              peptideId: `syn_blend_${uniq}`,
              peptide: `Synthetic Blend ${uniq}`,
              peptideName: `Synthetic Blend ${uniq}`,
              profile: 'Spouse A',
              datetime: '2026-10-15T08:15:00.000Z',
              doseMcg: 300,
              doseUnit: 'mcg',
              doseValue: 300,
              skipped: false,
              notes: 'Synthetic external import log',
              updatedAt: '2026-10-15T08:15:00.000Z',
            },
          ],
        };
      }
      const protocolJson = JSON.stringify(protocolExport);

      const importBtn = page.locator('[data-testid="btn-import-protocol-os"]').first();
      await importBtn.waitFor({ state: 'visible', timeout: 10_000 });

      let fileChooserFired = false;
      const fcPromise = page
        .waitForEvent('filechooser', { timeout: 2_000 })
        .then(async (chooser) => {
          fileChooserFired = true;
          await chooser.setFiles({
            name: 'protocol-os-export.json',
            mimeType: 'application/json',
            buffer: Buffer.from(protocolJson, 'utf8'),
          });
        })
        .catch(() => {});

      await importBtn.click();
      await fcPromise;

      if (!fileChooserFired) {
        const importScope =
          (await firstVisibleFrom(page, NON_SEARCH_FORM_SELECTORS, { waitMs: 350 })) ||
          page.locator('main, body').first();
        let fileInput = importScope.locator('input[type="file"]').first();
        if ((await fileInput.count()) === 0) {
          fileInput = importBtn
            .locator('xpath=ancestor::*[self::form or self::section or self::div][1]')
            .locator('input[type="file"]')
            .first();
        }
        const pasteArea = await firstVisibleFrom(importScope, [
          'textarea:not([data-testid="ai-json-import-textarea"])',
        ]);
        if ((await fileInput.count()) > 0) {
          await fileInput.setInputFiles({
            name: 'protocol-os-export.json',
            mimeType: 'application/json',
            buffer: Buffer.from(protocolJson, 'utf8'),
          });
          const submitBtn = await findSubmitButton(importScope, /import|upload|confirm|submit/i, {
            excludeTestIds: ['btn-import-protocol-os'],
          });
          if (submitBtn) await submitBtn.click();
        } else if (pasteArea) {
          await pasteArea.fill(protocolJson);
          const submitBtn = await findSubmitButton(importScope, /import|confirm|submit|parse/i, {
            excludeTestIds: ['btn-import-protocol-os'],
          });
          assert.ok(submitBtn, 'Expected visible submit button for Protocol OS paste import');
          await submitBtn.click();
        } else {
          assert.fail('Expected file chooser, file input, or JSON textarea after clicking btn-import-protocol-os');
        }
      }

      // Strictly require genuinely NEW compounds (!preImportIds.has(id)) or NEW logs (> logsBeforeImport)
      await waitForCondition(
        async () => {
          const list = await apiListCompounds(cleanApi);
          const logsA = await cleanApi.get('/api/v1/members/member_wife/logs');
          const logsB = await cleanApi.get('/api/v1/members/member_husband/logs');
          const totalLogs =
            (unwrapData(logsA.json, ['logs', 'items'])?.length || 0) +
            (unwrapData(logsB.json, ['logs', 'items'])?.length || 0);
          const hasNewCompound = list.some((c) => !preImportIds.has(c.id));
          const hasNewLogs = totalLogs > logsBeforeImport;
          return hasNewCompound || hasNewLogs;
        },
        { message: 'Expected btn-import-protocol-os to persist genuinely new Protocol OS compounds or dose logs' }
      );

      assert.deepEqual(cleanBrowser.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(cleanBrowser.pageErrors)}`);
    } finally {
      try {
        if (cleanBrowser) await cleanBrowser.close();
      } finally {
        if (cleanServer) await cleanServer.stop();
      }
    }
  });
});
