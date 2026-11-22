import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
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

const CORE_SECTIONS = ['peptides', 'peds', 'vitamins_supplements', 'dermatology'];

const DISCLAIMER_RE =
  /not\s+medical\s+advice|personal\s+reference|educational\s+(?:reference|purposes|only)|harm[- ]reduction|consult\s+(?:a|your)\s+(?:qualified\s+)?(?:physician|clinician|doctor|healthcare)/i;

const LOCKOUT_TEXT_RE =
  /lock(?:ed)?\s*out|too\s+many\s+(?:failed\s+)?attempts|wait\s+\d+|try\s+again\s+in|cooldown|30\s*s|attempts?\s+(?:exceeded|remaining:\s*0)|temporarily\s+locked/i;

// ---------------------------------------------------------------------------
// Opaque-Box UI Helpers (strictly canonical PROJECT.md §3 data-testids + ARIA)
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

async function readToggleState(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  return locator.evaluate((el) => {
    if (el.tagName.toUpperCase() === 'INPUT' && el.type === 'checkbox') return Boolean(el.checked);
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

async function apiCreateCompound(api, payload) {
  const res = await api.post('/api/v1/compounds', payload);
  assert.ok(
    res.status === 200 || res.status === 201,
    `POST /api/v1/compounds failed (${res.status}): ${res.text}`
  );
  const created = unwrapData(res.json, 'compound');
  assert.ok(created?.id, `Missing compound id: ${res.text}`);
  return created;
}

async function apiSetOwnership(api, compoundId, payload) {
  const res = await api.put(`/api/v1/ownership/${encodeURIComponent(compoundId)}`, payload);
  assert.equal(res.status, 200, `PUT ownership failed (${res.status}): ${res.text}`);
}

async function apiListCompounds(api) {
  const res = await api.get('/api/v1/compounds');
  assert.equal(res.status, 200);
  const list = unwrapData(res.json, ['compounds', 'items']);
  assert.ok(Array.isArray(list));
  return list;
}

async function apiListStacks(api, memberId) {
  const res = await api.get(`/api/v1/members/${encodeURIComponent(memberId)}/stacks`);
  assert.equal(res.status, 200);
  const list = unwrapData(res.json, ['stacks', 'items']);
  assert.ok(Array.isArray(list));
  return list;
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

    const raced = await Promise.race([
      networkPromise,
      downloadPromise.then((txt) => txt || new Promise((r) => setTimeout(() => r(responseText), 500))),
      new Promise((r) => setTimeout(() => r(null), 6_000)),
    ]);

    return raced || responseText || (await downloadPromise);
  } finally {
    page.off('response', resHandler);
  }
}

async function isPinLockActive(page) {
  const nav = page.locator('[data-testid="nav-sections"]').first();
  const navVisible = (await nav.count()) > 0 && (await nav.isVisible());
  if (!navVisible) {
    const bodyText = await page.locator('body').innerText();
    if (/pin|unlock|locked|passcode/i.test(bodyText)) return true;
  }
  const lockOverlay = page
    .locator('[role="dialog"], [role="alertdialog"], form')
    .filter({ hasText: /enter\s*(?:your\s*)?pin|unlock\s*(?:app|hub|device)|device\s*locked|pin\s*lock/i })
    .first();
  if ((await lockOverlay.count()) > 0 && (await lockOverlay.isVisible())) {
    if ((await lockOverlay.locator('input, button').count()) > 0) return true;
  }
  return false;
}

async function enablePinInSettings(page, pin) {
  await page.locator('[data-testid="nav-settings"]').first().click();
  const pinSection = page.locator('[data-testid="settings-pin-lock"]').first();
  await pinSection.waitFor({ state: 'visible', timeout: 10_000 });

  let pinInputs = pinSection.locator(
    'input[type="password"], input[inputmode="numeric"], input[name*="pin" i], input[placeholder*="pin" i], input[aria-label*="pin" i], input[type="text"]'
  );
  if ((await pinInputs.count()) === 0 || !(await pinInputs.first().isVisible())) {
    const enableToggle = await firstVisibleFrom(pinSection, ['input[type="checkbox"]', 'button']);
    assert.ok(enableToggle, 'Expected PIN input or enable toggle inside settings-pin-lock');
    await enableToggle.click();
    pinInputs = pinSection.locator(
      'input[type="password"], input[inputmode="numeric"], input[name*="pin" i], input[placeholder*="pin" i], input[aria-label*="pin" i], input[type="text"]'
    );
  }

  const visibleInputs = [];
  const count = await pinInputs.count();
  for (let i = 0; i < count; i += 1) {
    const inp = pinInputs.nth(i);
    if (await inp.isVisible()) visibleInputs.push(inp);
  }
  assert.ok(visibleInputs.length >= 1, 'Expected visible PIN input inside settings-pin-lock');

  for (const inp of visibleInputs.slice(0, 2)) {
    await inp.fill(pin);
  }

  const savePinBtn = pinSection
    .locator('button[type="submit"], button')
    .filter({ hasText: /enable|set\s*pin|save|activate|confirm|update/i })
    .first();
  await savePinBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await savePinBtn.click();
}

async function lockAppViaPin(page) {
  const lockBtn = page
    .locator('button')
    .filter({ hasText: /lock\s*now|lock\s*app|lock\s*device|^lock$/i })
    .first();
  if ((await lockBtn.count()) > 0 && (await lockBtn.isVisible())) {
    await lockBtn.click();
  } else {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await waitForCondition(async () => isPinLockActive(page), {
    message: 'Expected PIN lock screen to activate after locking/reloading',
  });
}

async function submitPinAttemptOnLockScreen(page, pin) {
  const input = await firstVisibleFrom(page, [
    '[role="dialog"] input[type="password"]',
    '[role="dialog"] input[inputmode="numeric"]',
    '[role="dialog"] input',
    '[role="alertdialog"] input',
    'input[type="password"]',
    'input[inputmode="numeric"]',
    'input[placeholder*="pin" i]',
    'input[aria-label*="pin" i]',
  ]);

  if (input) {
    if (await input.isDisabled()) return { blockedByDisabled: true };
    await input.fill('');
    await input.fill(pin);
    const submitBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /unlock|enter|submit|verify|open/i })
      .first();
    if ((await submitBtn.count()) > 0 && (await submitBtn.isVisible())) {
      if (await submitBtn.isDisabled()) return { blockedByDisabled: true };
      await submitBtn.click();
    } else {
      await input.press('Enter');
    }
    return { blockedByDisabled: false };
  }

  const digitZero = page.getByRole('button', { name: /^0$/ }).first();
  const digitOne = page.getByRole('button', { name: /^1$/ }).first();
  if ((await digitZero.isVisible()) && (await digitOne.isVisible())) {
    for (const ch of String(pin)) {
      const btn = page.getByRole('button', { name: new RegExp(`^${ch}$`) }).first();
      if (await btn.isDisabled()) return { blockedByDisabled: true };
      await btn.click();
    }
    const unlockBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /unlock|enter|submit|verify/i })
      .first();
    if ((await unlockBtn.count()) > 0 && (await unlockBtn.isVisible())) {
      if (await unlockBtn.isDisabled()) return { blockedByDisabled: true };
      await unlockBtn.click();
    }
    return { blockedByDisabled: false };
  }

  assert.fail('Expected visible PIN input or numeric keypad on lock screen');
}

async function mintScopedKeyFromUi(page, api, { keyLabel, scope = 'read', server }) {
  const mintBtn = page.locator('[data-testid="btn-mint-api-key"]').first();
  await mintBtn.waitFor({ state: 'visible', timeout: 10_000 });

  const keysBefore = unwrapData((await api.get('/api/v1/keys')).json, ['keys', 'apiKeys', 'items']) || [];
  const tokensBefore = new Set(await extractCandidateSecretTokens(page));

  // Support inline form adjacent to btn-mint-api-key (either <form> or parent container)
  const inlineParent = mintBtn.locator('xpath=ancestor::form[1] | ..').first();
  const inlineName = await firstVisibleFrom(inlineParent, [
    'input[name*="name" i]',
    'input[placeholder*="name" i]',
    'input[placeholder*="label" i]',
  ]);
  if (inlineName) {
    await inlineName.fill(keyLabel);
    const inlineScope = await firstVisibleFrom(inlineParent, ['select']);
    if (inlineScope) {
      await selectOptionOnControl(page, inlineScope, { value: scope, labelRe: new RegExp(`^${scope}$`, 'i') });
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
      await selectOptionOnControl(page, dialogScope, { value: scope, labelRe: new RegExp(`^${scope}$`, 'i') });
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
    { message: 'Expected btn-mint-api-key to create a new API key' }
  );

  const revealedSecret = await waitForCondition(
    async () => {
      const tokensAfter = await extractCandidateSecretTokens(page);
      return (
        tokensAfter.find(
          (t) => !tokensBefore.has(t) && t !== server.adminToken && t !== server.passcode
        ) || null
      );
    },
    { message: 'Expected once-shown minted API key raw secret to appear in AI Hub UI' }
  );
  assert.ok(revealedSecret.length >= 20, 'Minted API key secret should be a non-trivial token');
  return revealedSecret;
}

// ---------------------------------------------------------------------------
// Tier 4: Real-World End-User Browser Journeys (Scenarios 7 & 8)
// ---------------------------------------------------------------------------

describe('Tier 4: Real-World Browser User Journeys (Playwright Chromium)', () => {
  it('Scenario 7: Full Desktop Playwright Chromium Household User Journey (1280x800)', async () => {
    let server;
    let browserHandle;

    try {
      server = await startE2EServer();
      const api = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      browserHandle = await launchBrowser({ viewport: { width: 1280, height: 800 } });
      await browserHandle.context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

      // Step 1: Verify privacy meta tag (noindex, nofollow) & F44 medical disclaimers
      const robotsContent = await page.evaluate(() => {
        const meta = document.querySelector('head meta[name="robots"]');
        return meta ? meta.getAttribute('content') || '' : '';
      });
      assert.match(robotsContent, /\bnoindex\b/i, `Expected noindex meta tag, got: "${robotsContent}"`);
      assert.match(robotsContent, /\bnofollow\b/i, `Expected nofollow meta tag, got: "${robotsContent}"`);
      assert.match(await page.locator('body').innerText(), DISCLAIMER_RE, 'Expected visible F44 medical disclaimer');

      // Step 2: Switch between Wife and Husband via member-switcher
      await selectMember(page, 'member_husband');
      await selectMember(page, 'member_wife');

      // Step 3: Load Starter Reference Catalog in Cabinet View
      await page.locator('[data-testid="nav-cabinet"]').first().click();
      const cabinetList = page.locator('[data-testid="cabinet-list"]').first();
      await cabinetList.waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-testid="btn-load-starter-catalog"]').first().click();

      await waitForCondition(
        async () => {
          const list = await apiListCompounds(api);
          const sections = new Set(list.map((c) => c.sectionId));
          return CORE_SECTIONS.every((s) => sections.has(s));
        },
        { message: 'Expected Starter Reference Catalog to populate all 4 core sections' }
      );
      await waitForCondition(
        async () => (await cabinetList.innerText()).trim().length > 20,
        { message: 'Expected cabinet-list to render populated starter items' }
      );

      // Step 4: Navigate all 4 Core Section tabs
      await page.locator('[data-testid="nav-sections"]').first().click();
      for (const tabId of [
        'section-tab-peptides',
        'section-tab-peds',
        'section-tab-vitamins_supplements',
        'section-tab-dermatology',
      ]) {
        const tabLoc = page.locator(`[data-testid="${tabId}"]`).first();
        await tabLoc.waitFor({ state: 'visible', timeout: 10_000 });
        await tabLoc.click();
        await waitForCondition(
          async () => (await page.locator('[data-testid^="compound-card-"]').count()) > 0,
          { message: `Expected at least 1 compound card rendered under ${tabId}` }
        );
      }

      // Step 5: Customize Peptides section schema via btn-customize-section
      await page.locator('[data-testid="section-tab-peptides"]').first().click();
      await page.locator('[data-testid="btn-customize-section"]').first().click();
      const customScope =
        (await firstVisibleFrom(page, ['[role="dialog"]', 'form'])) || page.locator('main, body').first();

      let fieldLabelInput = await firstVisibleFrom(customScope, [
        'input[name*="label" i]',
        'input[placeholder*="label" i]',
        'input[aria-label*="label" i]',
        'input[placeholder*="field name" i]',
      ]);
      if (!fieldLabelInput) {
        const addFieldBtn = customScope
          .locator('button')
          .filter({ hasText: /add\s*(?:custom\s*)?field|new\s*field|\+\s*field/i })
          .first();
        await addFieldBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await addFieldBtn.click();
        fieldLabelInput = await firstVisibleFrom(customScope, [
          'input[name*="label" i]',
          'input[placeholder*="label" i]',
          'input[aria-label*="label" i]',
          'input[placeholder*="field" i]',
          'input[type="text"]',
        ]);
      }
      assert.ok(fieldLabelInput, 'Expected visible custom field label input');
      await fieldLabelInput.fill('Third-Party Lab');

      const fieldKeyInput = await firstVisibleFrom(customScope, [
        'input[name*="key" i]',
        'input[placeholder*="key" i]',
        'input[aria-label*="key" i]',
      ]);
      if (fieldKeyInput) await fieldKeyInput.fill('third_party_lab');

      const saveSchemaBtn = customScope
        .locator('button[type="submit"], button')
        .filter({ hasText: /save|apply|update|done/i })
        .first();
      await saveSchemaBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await saveSchemaBtn.click();

      await waitForCondition(
        async () => {
          const secRes = await api.get('/api/v1/sections/peptides');
          const sec = unwrapData(secRes.json, 'section');
          return (sec?.customFields || []).some(
            (f) => f.key === 'third_party_lab' || /third-party\s*lab/i.test(f.label || '')
          );
        },
        { message: 'Expected custom field "Third-Party Lab" to persist on peptides section' }
      );

      // Step 6: Add a new compound via UI form (btn-add-compound + btn-save-compound)
      await page.locator('[data-testid="btn-add-compound"]').first().click();
      const saveCmpBtn = page.locator('[data-testid="btn-save-compound"]').first();
      await saveCmpBtn.waitFor({ state: 'visible', timeout: 10_000 });
      const addFormScope =
        (await firstVisibleFrom(page, ['[role="dialog"]', '[data-testid="compound-detail"]', 'form'])) ||
        page.locator('body');
      const cmpNameInput = await firstVisibleFrom(addFormScope, [
        'input[name="name"]',
        'input[name*="name" i]',
        'input[placeholder*="name" i]',
        'input[aria-label*="name" i]',
        'input[type="text"]',
      ]);
      assert.ok(cmpNameInput, 'Expected compound name input in Add Compound form');
      await cmpNameInput.fill('Thymosin Alpha-1 Journey');
      const cmpSummaryInput = await firstVisibleFrom(addFormScope, [
        'textarea[name*="summary" i]',
        'textarea[placeholder*="summary" i]',
        'textarea',
      ]);
      if (cmpSummaryInput) {
        await cmpSummaryInput.fill('Synthetic 28-amino-acid thymic peptide evaluated for immune modulation.');
      }
      await saveCmpBtn.click();

      const createdThymosin = await waitForCondition(
        async () => (await apiListCompounds(api)).find((c) => /Thymosin Alpha-1 Journey/i.test(c.name || '')) || null,
        { message: 'Expected Thymosin Alpha-1 Journey to persist after btn-save-compound' }
      );

      // Step 7: Seed an ai_draft lyophilized peptide to verify one-tap Verify + Ownership + Reconstitution Calc
      const draftPeptide = await apiCreateCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'BPC-157 Journey Draft',
          canonicalMolecule: 'bpc-157-journey',
          profileStatus: 'ai_draft',
        })
      );
      await apiSetOwnership(api, draftPeptide.id, { scope: 'household', status: 'have', remainingDoses: 14 });
      await apiSetOwnership(api, createdThymosin.id, { scope: 'household', status: 'have', remainingDoses: 10 });

      await browserHandle.openAuthenticatedPage(server.baseUrl, {
        token: server.adminToken,
        passcode: server.passcode,
      });
      await page.locator('[data-testid="nav-sections"]').first().click();
      await page.locator('[data-testid="section-tab-peptides"]').first().click();
      await compoundCardLocator(page, draftPeptide).click();

      const detail = page.locator('[data-testid="compound-detail"]').first();
      await detail.waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-testid="btn-verify-compound"]').first().click();
      await waitForCondition(
        async () => {
          const res = await api.get(`/api/v1/compounds/${encodeURIComponent(draftPeptide.id)}`);
          return unwrapData(res.json, 'compound')?.profileStatus === 'verified';
        },
        { message: 'Expected btn-verify-compound to transition draftPeptide to verified' }
      );

      await selectOptionOnControl(page, page.locator('[data-testid="ownership-status-select"]').first(), {
        value: 'have',
        labelRe: /^have$/i,
      });

      // Live Reconstitution Calculator verification
      const reconCalc = page.locator('[data-testid="reconstitution-calc"]').first();
      await reconCalc.waitFor({ state: 'visible', timeout: 10_000 });
      const numInputs = reconCalc.locator('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]');
      assert.ok((await numInputs.count()) >= 3, 'Expected vial, diluent, and dose inputs inside reconstitution-calc');
      await numInputs.nth(0).fill('5');
      await numInputs.nth(1).fill('2');
      await numInputs.nth(2).fill('250');
      await waitForCondition(
        async () => /\b10(?:\.0+)?\s*(?:u|iu|units?)\b|\b0\.10?\s*mL\b/i.test(await reconCalc.innerText()),
        { message: 'Expected reconstitution-calc to show 10 U-100 units (0.10 mL) for 5mg / 2mL / 250mcg' }
      );

      // Step 8: Seed cross-section stack items (hard-stop pair + derm AM/PM + hair/scalp + wishlist) + pending AI proposal
      const igf1 = await apiCreateCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'IGF-1 LR3 Journey',
          canonicalMolecule: 'igf-1-lr3',
          tags: ['peptide', 'growth_factor', 'oncogenic_growth_factors'],
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef: 'dihexa',
              severity: 'hard_stop',
              mechanism: 'Dual proliferative growth-factor hard stop.',
              recommendation: 'Do not combine IGF-1 LR3 and Dihexa.',
            },
          ],
          profileStatus: 'verified',
        })
      );
      const dihexa = await apiCreateCompound(
        api,
        fixtures.makePeptideCompound({
          name: 'Dihexa Journey',
          canonicalMolecule: 'dihexa',
          tags: ['peptide', 'nootropic', 'oncogenic_growth_factors'],
          doNotPairWith: [
            {
              targetType: 'compound',
              targetRef: 'igf-1-lr3',
              severity: 'hard_stop',
              mechanism: 'Dual proliferative growth-factor hard stop.',
              recommendation: 'Do not combine Dihexa and IGF-1 LR3.',
            },
          ],
          profileStatus: 'verified',
        })
      );
      const dermVitC = await apiCreateCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Vitamin C AM Journey Serum',
          canonicalMolecule: 'l-ascorbic-journey',
          tags: ['dermatology', 'antioxidant', 'am_only'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'] },
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
      const dermSpf = await apiCreateCompound(
        api,
        fixtures.makeDermCompound({
          name: 'SPF 50 Mineral Journey',
          canonicalMolecule: 'spf-50-journey',
          tags: ['dermatology', 'spf', 'sunscreen', 'am_only'],
          timingRules: { preferredSlots: ['derm_am'], avoidSlots: ['derm_pm'] },
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
      const dermTret = await apiCreateCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Tretinoin PM Journey Cream',
          canonicalMolecule: 'tretinoin-journey',
          profileStatus: 'verified',
        })
      );
      const hairMinox = await apiCreateCompound(
        api,
        fixtures.makeDermCompound({
          name: 'Minoxidil Scalp Journey Foam',
          canonicalMolecule: 'minoxidil-journey',
          tags: ['dermatology', 'hair_scalp', 'scalp'],
          timingRules: { preferredSlots: ['derm_am', 'derm_pm'], avoidSlots: [] },
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
      const wishlistSupp = await apiCreateCompound(
        api,
        fixtures.makeSupplementCompound({
          name: 'CoQ10 Wishlist Journey',
          canonicalMolecule: 'coq10-journey',
          profileStatus: 'verified',
        })
      );

      for (const cmp of [igf1, dihexa, dermVitC, dermSpf, dermTret, hairMinox]) {
        await apiSetOwnership(api, cmp.id, { scope: 'household', status: 'have', remainingDoses: 20 });
      }
      await apiSetOwnership(api, wishlistSupp.id, { scope: 'household', status: 'wishlist' });

      const aiProposalRes = await api.post('/api/v1/proposals', {
        type: 'compound_create',
        sourceModel: 'ai:claude',
        summary: 'Add GHK-Cu synthetic educational profile from Claude research',
        payload: fixtures.makePeptideCompound({
          name: 'GHK-Cu Claude Proposal',
          canonicalMolecule: 'ghk-cu-proposal',
          profileStatus: 'ai_draft',
        }),
      });
      assert.ok(aiProposalRes.status === 200 || aiProposalRes.status === 201);
      const aiProposal = unwrapData(aiProposalRes.json, 'proposal');
      assert.ok(aiProposal?.id);

      // Step 9: Stack Builder — create stack, add multi-section compounds via UI picker, inspect Dual-Track Spread & Hard-Stop Banner
      await browserHandle.openAuthenticatedPage(server.baseUrl, {
        token: server.adminToken,
        passcode: server.passcode,
      });
      await selectMember(page, 'member_wife');
      await page.locator('[data-testid="nav-stack"]').first().click();

      const journeyStackName = 'Desktop Journey Full Stack';
      let promptDialogHandled = false;
      const onDialog = async (d) => {
        promptDialogHandled = true;
        await d.accept(journeyStackName);
      };
      page.once('dialog', onDialog);
      await page.locator('[data-testid="btn-new-stack"]').first().click();
      await page.waitForTimeout(250);
      page.off('dialog', onDialog);

      if (!promptDialogHandled) {
        const dialogScope = (await firstVisibleFrom(page, ['[role="dialog"]', 'form'])) || page.locator('body');
        const nameInput = await firstVisibleFrom(dialogScope, [
          'input[name*="name" i]',
          'input[placeholder*="stack" i]',
          'input[placeholder*="name" i]',
          'input[type="text"]',
        ]);
        if (nameInput) {
          await nameInput.fill(journeyStackName);
          const confirmBtn = dialogScope
            .locator('button[type="submit"], button')
            .filter({ hasText: /create|save|add|confirm/i })
            .first();
          await confirmBtn.waitFor({ state: 'visible', timeout: 5_000 });
          await confirmBtn.click();
        }
      }

      const activeStack = await waitForCondition(
        async () => {
          const stacks = await apiListStacks(api, 'member_wife');
          return stacks.find((s) => s.name === journeyStackName) || stacks[stacks.length - 1] || null;
        },
        { message: 'Expected btn-new-stack to create Desktop Journey Full Stack' }
      );

      await selectOptionOnControl(page, page.locator('[data-testid="stack-selector"]').first(), {
        value: activeStack.id,
        labelRe: new RegExp(activeStack.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      });

      await page.locator('[data-testid="stack-compound-picker"]').first().waitFor({ state: 'visible', timeout: 10_000 });
      for (const cmp of [draftPeptide, igf1, dihexa, dermVitC, dermSpf, dermTret, hairMinox, wishlistSupp]) {
        await page.locator(`[data-testid="btn-add-to-stack-${cmp.id}"]`).first().click();
      }

      await waitForCondition(
        async () => {
          const stacks = await apiListStacks(api, 'member_wife');
          const st = stacks.find((s) => s.id === activeStack.id);
          return (st?.items || []).length >= 8;
        },
        { message: 'Expected all 8 multi-section compounds to be added via stack-compound-picker' }
      );

      // Toggle have-only & What-If (verifying What-If does not mutate stack)
      const haveOnly = page.locator('[data-testid="stack-toggle-have-only"]').first();
      const haveBefore = await readToggleState(haveOnly);
      await clickToggle(haveOnly);
      assert.notEqual(await readToggleState(haveOnly), haveBefore);
      await clickToggle(haveOnly);

      const whatIf = page.locator('[data-testid="what-if-toggle"]').first();
      const whatIfBefore = await readToggleState(whatIf);
      await clickToggle(whatIf);
      assert.notEqual(await readToggleState(whatIf), whatIfBefore);
      await clickToggle(whatIf);

      // Inspect Systemic Timeline + slots + Derm AM/PM + Hair/Scalp + Interaction Alerts + Hard-Stop Banner
      const timeline = page.locator('[data-testid="spread-systemic-timeline"]').first();
      await timeline.waitFor({ state: 'visible', timeout: 10_000 });
      let slotCount = 0;
      for (const slotId of CANONICAL_SYSTEMIC_SLOTS) {
        if ((await page.locator(`[data-testid="spread-slot-${slotId}"]`).count()) > 0) slotCount += 1;
      }
      assert.ok(slotCount >= 2, `Expected canonical spread-slot-* containers in timeline (found ${slotCount})`);

      await page.locator('[data-testid="spread-derm-am"]').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-testid="spread-derm-pm"]').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-testid="spread-hair-scalp"]').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-testid="interaction-alerts"]').first().waitFor({ state: 'visible', timeout: 10_000 });

      const hardStopBanner = page.locator('[data-testid="hard-stop-banner"]').first();
      await hardStopBanner.waitFor({ state: 'visible', timeout: 10_000 });
      assert.match(await hardStopBanner.innerText(), /IGF-1|Dihexa|hard[\s_-]?stop/i);

      // Pin override + log dose
      await page.locator(`[data-testid="btn-pin-override-${draftPeptide.id}"]`).first().click();
      const pinDialog = await firstVisibleFrom(page, ['[role="dialog"]', '[role="listbox"]', '[role="menu"]']);
      if (pinDialog) {
        const slotSel = await firstVisibleFrom(pinDialog, ['select']);
        if (slotSel) {
          await selectOptionOnControl(page, slotSel, { value: 'evening_dinner', labelRe: /evening|dinner|midday/i });
        } else {
          const slotOpt = pinDialog
            .locator('button, [role="option"], [role="menuitem"]')
            .filter({ hasText: /evening|dinner|midday/i })
            .first();
          if ((await slotOpt.count()) > 0 && (await slotOpt.isVisible())) await slotOpt.click();
        }
        const pinConfirm = pinDialog
          .locator('button[type="submit"], button')
          .filter({ hasText: /pin|save|apply|confirm/i })
          .first();
        if ((await pinConfirm.count()) > 0 && (await pinConfirm.isVisible())) await pinConfirm.click();
      }
      await waitForCondition(
        async () => {
          const stacks = await apiListStacks(api, 'member_wife');
          const st = stacks.find((s) => s.id === activeStack.id);
          return Boolean((st?.items || []).find((i) => i.compoundId === draftPeptide.id)?.pinnedSlot);
        },
        { message: 'Expected btn-pin-override to persist pinnedSlot' }
      );

      await page.locator(`[data-testid="btn-log-dose-${draftPeptide.id}"]`).first().click();
      const logDialog = await firstVisibleFrom(page, ['[role="dialog"]']);
      if (logDialog) {
        const confirmLog = logDialog
          .locator('button[type="submit"], button')
          .filter({ hasText: /log|save|confirm|record/i })
          .first();
        if ((await confirmLog.count()) > 0 && (await confirmLog.isVisible())) await confirmLog.click();
      }
      await waitForCondition(
        async () => {
          const res = await api.get('/api/v1/members/member_wife/logs');
          const logs = unwrapData(res.json, ['logs', 'items']) || [];
          return logs.some((l) => l.compoundId === draftPeptide.id);
        },
        { message: 'Expected btn-log-dose to persist a dose log for draftPeptide' }
      );

      // Step 10: AI Hub — approve proposal, Prompt Builder, JSON Import, 5 AI Guides, Mint API Key, Copy Context MD
      await page.locator('[data-testid="nav-ai-hub"]').first().click();
      await page.locator('[data-testid="ai-proposals-list"]').first().waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator(`[data-testid="btn-approve-proposal-${aiProposal.id}"]`).first().click();
      await waitForCondition(
        async () => {
          const allRes = await api.get('/api/v1/proposals', { query: { status: 'all' } });
          const pendingRes = await api.get('/api/v1/proposals');
          const allList = unwrapData(allRes.json, ['proposals', 'items']) || [];
          const pendingList = unwrapData(pendingRes.json, ['proposals', 'items']) || [];
          const found = allList.find((p) => p.id === aiProposal.id);
          const created = (await apiListCompounds(api)).some((c) => /GHK-Cu Claude Proposal/i.test(c.name || ''));
          const resolved = (found && /approv/i.test(String(found.status || ''))) || !pendingList.some((p) => p.id === aiProposal.id);
          return resolved && created;
        },
        { message: 'Expected AI proposal approval to persist and create GHK-Cu Claude Proposal' }
      );

      await page.locator('[data-testid="btn-open-ai-prompt-builder"]').first().click();
      const promptScope = (await firstVisibleFrom(page, ['[role="dialog"]'])) || page.locator('body');
      const promptInput = await firstVisibleFrom(promptScope, [
        'input[name*="compound" i]',
        'input[placeholder*="compound" i]',
        'input[type="text"]',
      ]);
      if (promptInput) {
        await promptInput.fill('KPV Peptide');
        const genBtn = promptScope
          .locator('button[type="submit"], button')
          .filter({ hasText: /generate|build|create/i })
          .first();
        if ((await genBtn.count()) > 0 && (await genBtn.isVisible())) await genBtn.click();
      }
      await waitForCondition(
        async () => {
          const txt = await promptScope.innerText();
          const area = await firstVisibleFrom(promptScope, ['textarea', 'pre', 'code']);
          const areaVal = area ? await area.evaluate((el) => el.value || el.textContent || '') : '';
          return /json|mechanismOfAction|timingRules|sectionId|halfLife/i.test(`${txt}\n${areaVal}`);
        },
        { message: 'Expected AI Prompt Builder to generate schema-strict research prompt' }
      );
      const closePrompt = promptScope
        .locator('button')
        .filter({ hasText: /close|done|cancel|×/i })
        .first();
      if ((await closePrompt.count()) > 0 && (await closePrompt.isVisible())) await closePrompt.click();

      const epitalonJson = JSON.stringify(
        fixtures.makePeptideCompound({
          name: 'Epitalon Journey Import',
          canonicalMolecule: 'epitalon-journey',
          profileStatus: 'ai_draft',
        }),
        null,
        2
      );
      await page.locator('[data-testid="ai-json-import-textarea"]').first().fill(epitalonJson);
      await page.locator('[data-testid="btn-import-ai-json"]').first().click();
      await waitForCondition(
        async () => (await apiListCompounds(api)).some((c) => /Epitalon Journey Import/i.test(c.name || '')),
        { message: 'Expected AI JSON import to persist Epitalon Journey Import' }
      );

      for (const guideId of ['ai-guide-gemini', 'ai-guide-claude', 'ai-guide-grok', 'ai-guide-gpt', 'ai-guide-muse']) {
        await page.locator(`[data-testid="${guideId}"]`).first().waitFor({ state: 'visible', timeout: 10_000 });
      }

      await mintScopedKeyFromUi(page, api, {
        keyLabel: 'Scenario 7 Desktop Key',
        scope: 'read',
        server,
      });

      const contextMd = await captureExportText(page, 'btn-copy-context-md', '/api/v1/export/context.md');
      const finalContext =
        contextMd ||
        (await page.evaluate(() => navigator.clipboard.readText()).catch(() => ''));
      assert.ok(finalContext && finalContext.trim().length > 20, 'Expected valid Context MD bundle from btn-copy-context-md');
      assert.ok(!finalContext.includes(server.adminToken), 'Context MD MUST NOT leak adminToken');

      // Step 11: Settings — inspect all 4 panels, configure PIN lock, test JSON/CSV/Print exports
      await page.locator('[data-testid="nav-settings"]').first().click();
      for (const panelId of ['settings-members', 'settings-ai-policy', 'settings-sync', 'settings-pin-lock']) {
        await page.locator(`[data-testid="${panelId}"]`).first().waitFor({ state: 'visible', timeout: 10_000 });
      }

      const hubJson = await captureExportText(page, 'btn-export-json', '/api/v1/export/hub.json');
      assert.ok(hubJson && hubJson.trim().length > 10, 'Expected valid Hub JSON export');
      assert.ok(JSON.parse(hubJson), 'Hub JSON export must be valid JSON');
      assert.ok(!hubJson.includes(server.adminToken), 'Hub JSON export MUST NOT leak adminToken');

      const csvText = await captureExportText(page, 'btn-export-csv', '/api/v1/export/compounds.csv');
      assert.ok(csvText && csvText.includes(','), 'Expected valid CSV export');
      assert.ok(!csvText.includes(server.adminToken), 'CSV export MUST NOT leak adminToken');

      await page.evaluate(() => {
        window.__e2ePrintCalls = 0;
      });
      await page.locator('[data-testid="btn-print-report"]').first().click();
      await waitForCondition(
        async () => {
          const calls = await page.evaluate(() => window.__e2ePrintCalls || 0);
          if (calls > 0) return true;
          const dialog = await firstVisibleFrom(page, ['[role="dialog"]', 'article']);
          return Boolean(dialog && DISCLAIMER_RE.test(await dialog.innerText()));
        },
        { message: 'Expected btn-print-report to call window.print() or render printable report' }
      );

      // Configure PIN lock cleanly as final Settings step
      await enablePinInSettings(page, '2468');

      // Step 12: Zero uncaught browser errors across entire desktop journey
      assert.deepEqual(
        browserHandle.pageErrors,
        [],
        `Scenario 7 encountered uncaught browser pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`
      );
    } finally {
      try {
        if (browserHandle) await browserHandle.close();
      } finally {
        if (server) await server.stop();
      }
    }
  });

  it('Scenario 8: Mobile Viewport PWA (390x844), Theme Toggle, Global Search, PIN Lockout & Offline Resilience Journey', async () => {
    let server;
    let mobileHandle;

    try {
      server = await startE2EServer();
      const api = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

      // Seed representative compounds across all 4 core sections + an active stack
      const cmpPeptide = await apiCreateCompound(api, fixtures.makePeptideCompound({ profileStatus: 'verified' }));
      const cmpPed = await apiCreateCompound(api, fixtures.makePedCompound({ profileStatus: 'verified' }));
      const cmpSupp = await apiCreateCompound(api, fixtures.makeSupplementCompound({ profileStatus: 'verified' }));
      const cmpDerm = await apiCreateCompound(api, fixtures.makeDermCompound({ profileStatus: 'verified' }));

      for (const cmp of [cmpPeptide, cmpPed, cmpSupp, cmpDerm]) {
        await apiSetOwnership(api, cmp.id, { scope: 'household', status: 'have', remainingDoses: 15 });
      }

      const stackRes = await api.post(
        '/api/v1/members/member_wife/stacks',
        fixtures.makeStackPayload({
          name: 'Mobile Routine Stack',
          memberId: 'member_wife',
          active: true,
          items: [
            fixtures.makeStackItem({ compoundId: cmpPeptide.id, doseAmount: 250, doseUnit: 'mcg' }),
            fixtures.makeStackItem({ compoundId: cmpSupp.id, doseAmount: 200, doseUnit: 'mg' }),
          ],
        })
      );
      assert.ok(stackRes.status === 200 || stackRes.status === 201);

      // Launch mobile iPhone viewport (390x844)
      mobileHandle = await launchBrowser({
        viewport: { width: 390, height: 844 },
        contextOptions: { isMobile: true, hasTouch: true },
      });

      const page = await mobileHandle.openAuthenticatedPage(server.baseUrl, {
        token: server.adminToken,
        passcode: server.passcode,
      });

      // Step 1: Mobile navigation across all 5 primary tabs + zero horizontal overflow check
      const navIds = ['nav-sections', 'nav-stack', 'nav-cabinet', 'nav-ai-hub', 'nav-settings'];
      for (const navId of navIds) {
        const navBtn = page.locator(`[data-testid="${navId}"]`).first();
        await navBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await navBtn.click();
        await page.waitForTimeout(150);

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        assert.ok(
          metrics.scrollWidth <= metrics.innerWidth + 2,
          `Mobile horizontal overflow on ${navId}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
        );
      }

      // Step 2: Toggle Dark/Light theme via theme-toggle and assert visual/DOM theme flip
      await page.locator('[data-testid="nav-sections"]').first().click();
      const themeToggle = page.locator('[data-testid="theme-toggle"]').first();
      await themeToggle.waitFor({ state: 'visible', timeout: 10_000 });
      const themeBefore = await getThemeSnapshot(page);
      await themeToggle.click();
      const themeAfter = await getThemeSnapshot(page);
      assert.notDeepEqual(
        themeAfter,
        themeBefore,
        `Expected theme-toggle to flip mobile theme state (before=${JSON.stringify(themeBefore)})`
      );
      await themeToggle.click();

      // Step 3: Global search across all 4 core sections
      const searchInput = page.locator('[data-testid="global-search-input"]').first();
      await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
      for (const term of ['BPC-157', 'Testosterone', 'Magnesium', 'Tretinoin']) {
        await searchInput.fill(term);
        await waitForCondition(
          async () => (await page.locator('body').innerText()).includes(term),
          { message: `Expected mobile global-search-input query "${term}" to match compound` }
        );
      }
      await searchInput.fill('');

      // Step 4: Enable PIN lock in Settings -> lock -> verify clean unlock with valid PIN
      const validPin = '2468';
      await enablePinInSettings(page, validPin);
      await lockAppViaPin(page);

      const unlockAttempt = await submitPinAttemptOnLockScreen(page, validPin);
      assert.equal(unlockAttempt.blockedByDisabled, false, 'Valid PIN entry should succeed before lockout');
      await waitForCondition(
        async () => !(await isPinLockActive(page)) && (await page.locator('[data-testid="nav-sections"]').first().isVisible()),
        { message: 'Expected valid PIN to unlock mobile PWA cleanly' }
      );

      // Step 5: Offline Resilience — toggle offline, navigate cached views with zero white-screen crash or pageErrors
      await mobileHandle.context.setOffline(true);
      try {
        for (const navId of navIds) {
          const navBtn = page.locator(`[data-testid="${navId}"]`).first();
          await navBtn.waitFor({ state: 'visible', timeout: 5_000 });
          await navBtn.click();
          await page.waitForTimeout(200);

          const offlineBody = await page.locator('body').innerText();
          assert.ok(
            offlineBody.trim().length > 20,
            `White-screen crash detected offline on ${navId}: empty body text`
          );
        }
        assert.deepEqual(
          mobileHandle.pageErrors,
          [],
          `Uncaught browser pageErrors during offline navigation: ${JSON.stringify(mobileHandle.pageErrors)}`
        );
      } finally {
        await mobileHandle.context.setOffline(false);
      }

      // Step 6: Re-lock and submit 5 consecutive wrong PINs -> verify 30s lockout banner & blocked unlock
      await page.locator('[data-testid="nav-settings"]').first().click();
      await lockAppViaPin(page);

      for (const badPin of ['1111', '2222', '3333', '4444', '5555']) {
        await submitPinAttemptOnLockScreen(page, badPin);
        await page.waitForTimeout(150);
      }

      await waitForCondition(
        async () => LOCKOUT_TEXT_RE.test(await page.locator('body').innerText()),
        { message: 'Expected visible lockout/cooldown banner on mobile after 5 wrong PIN attempts' }
      );

      const blockedValidAttempt = await submitPinAttemptOnLockScreen(page, validPin);
      if (!blockedValidAttempt.blockedByDisabled) {
        await page.waitForTimeout(300);
        assert.equal(
          await isPinLockActive(page),
          true,
          'Valid PIN MUST remain blocked while mobile 30s PIN lockout is active'
        );
      }

      assert.deepEqual(
        mobileHandle.pageErrors,
        [],
        `Scenario 8 encountered uncaught mobile pageErrors: ${JSON.stringify(mobileHandle.pageErrors)}`
      );
    } finally {
      try {
        if (mobileHandle) await mobileHandle.close();
      } finally {
        if (server) await server.stop();
      }
    }
  });
});
