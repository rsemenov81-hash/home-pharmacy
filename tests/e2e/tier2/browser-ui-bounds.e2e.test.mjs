import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2EServer,
  createApiClient,
  launchBrowser,
  unwrapData,
  fixtures,
} from '../harness.mjs';

const LOCKOUT_TEXT_RE =
  /lock(?:ed)?\s*out|too\s+many\s+(?:failed\s+)?attempts|wait\s+\d+|try\s+again\s+in|cooldown|30\s*s|attempts?\s+(?:exceeded|remaining:\s*0)|temporarily\s+locked/i;

const ERROR_TEXT_RE =
  /error|invalid|required|malformed|failed|cannot|must\s+be|missing|parse|syntax|please\s+enter/i;

// ---------------------------------------------------------------------------
// Opaque-Box UI Helpers (strictly canonical PROJECT.md §3 data-testids + ARIA)
// ---------------------------------------------------------------------------

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

async function clickToggle(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const nestedCheckbox = locator.locator('input[type="checkbox"]').first();
  if ((await nestedCheckbox.count()) > 0 && (await nestedCheckbox.isVisible())) {
    await nestedCheckbox.click();
    return;
  }
  await locator.click();
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

async function apiCreateStack(api, memberId, payload) {
  const res = await api.post(`/api/v1/members/${encodeURIComponent(memberId)}/stacks`, payload);
  assert.ok(
    res.status === 200 || res.status === 201,
    `POST stack failed (${res.status}): ${res.text}`
  );
  const created = unwrapData(res.json, 'stack');
  assert.ok(created?.id, `Missing stack id: ${res.text}`);
  return created;
}

async function apiListCompounds(api) {
  const res = await api.get('/api/v1/compounds');
  assert.equal(res.status, 200);
  const list = unwrapData(res.json, ['compounds', 'items']);
  assert.ok(Array.isArray(list), `Expected array of compounds, got: ${res.text}`);
  return list;
}

async function isPinLockActive(page) {
  const nav = page.locator('[data-testid="nav-sections"]').first();
  const navVisible = (await nav.count()) > 0 && (await nav.isVisible());
  if (!navVisible) {
    const bodyText = await page.locator('body').innerText();
    if (/pin|unlock|locked|passcode/i.test(bodyText)) return true;
  }
  // Also support modal/full-screen lock overlay covering app shell
  const lockOverlay = page
    .locator('[role="dialog"], [role="alertdialog"], form')
    .filter({ hasText: /enter\s*(?:your\s*)?pin|unlock\s*(?:app|hub|device)|device\s*locked|pin\s*lock/i })
    .first();
  if ((await lockOverlay.count()) > 0 && (await lockOverlay.isVisible())) {
    const hasUnlockControl =
      (await lockOverlay.locator('input, button').count()) > 0;
    if (hasUnlockControl) return true;
  }
  return false;
}

async function enablePinInSettings(page, pin) {
  await page.locator('[data-testid="nav-settings"]').first().click();
  const pinSection = page.locator('[data-testid="settings-pin-lock"]').first();
  await pinSection.waitFor({ state: 'visible', timeout: 10_000 });

  // Reveal PIN inputs if gated behind an enable checkbox/toggle button
  let pinInputs = pinSection.locator(
    'input[type="password"], input[inputmode="numeric"], input[name*="pin" i], input[placeholder*="pin" i], input[aria-label*="pin" i], input[type="text"]'
  );
  if ((await pinInputs.count()) === 0 || !(await pinInputs.first().isVisible())) {
    const enableToggle = await firstVisibleFrom(pinSection, [
      'input[type="checkbox"]',
      'button',
    ]);
    assert.ok(enableToggle, 'Expected PIN input or enable toggle inside settings-pin-lock');
    await enableToggle.click();
    pinInputs = pinSection.locator(
      'input[type="password"], input[inputmode="numeric"], input[name*="pin" i], input[placeholder*="pin" i], input[aria-label*="pin" i], input[type="text"]'
    );
  }

  const visibleInputs = [];
  const count = await pinInputs.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = pinInputs.nth(i);
    if (await candidate.isVisible()) visibleInputs.push(candidate);
  }
  assert.ok(visibleInputs.length >= 1, 'Expected at least 1 visible PIN input inside settings-pin-lock');

  // Fill PIN (and Confirm PIN if a second input is rendered)
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
    message: 'Expected PIN lock screen to become active after locking or reloading',
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
    if (await input.isDisabled()) {
      return { blockedByDisabled: true };
    }
    await input.fill('');
    await input.fill(pin);
    const submitBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /unlock|enter|submit|verify|open/i })
      .first();
    if ((await submitBtn.count()) > 0 && (await submitBtn.isVisible())) {
      if (await submitBtn.isDisabled()) {
        return { blockedByDisabled: true };
      }
      await submitBtn.click();
    } else {
      await input.press('Enter');
    }
    return { blockedByDisabled: false };
  }

  // Numeric keypad fallback
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

  assert.fail('Expected visible PIN input or numeric keypad buttons on PIN lock screen');
}

// ---------------------------------------------------------------------------
// Tier 2: Browser UI Boundary, Negative & Security E2E Suite
// ---------------------------------------------------------------------------

describe('Tier 2: Browser UI Boundaries, Negative Paths & Security E2E (Playwright Chromium)', () => {
  let server;
  let api;
  let browserHandle;

  let cmpIgf1;
  let cmpDihexa;
  let cmpTretinoin;
  let cmpSentinel;

  before(async () => {
    server = await startE2EServer();
    api = createApiClient({ baseUrl: server.baseUrl, token: server.adminToken });

    cmpIgf1 = await apiCreateCompound(
      api,
      fixtures.makePeptideCompound({
        name: 'IGF-1 LR3',
        canonicalMolecule: 'igf-1-lr3',
        tags: ['peptide', 'growth_factor', 'oncogenic_growth_factors'],
        doNotPairWith: [
          {
            targetType: 'compound',
            targetRef: 'dihexa',
            severity: 'hard_stop',
            mechanism:
              'Co-stacking IGF-1 LR3 with potent HGF/c-Met agonist Dihexa carries unacceptable theoretical oncogenic proliferative risk.',
            recommendation: 'HARD STOP: Do not combine IGF-1 LR3 and Dihexa in the same stack.',
          },
        ],
        profileStatus: 'verified',
      })
    );

    cmpDihexa = await apiCreateCompound(
      api,
      fixtures.makePeptideCompound({
        name: 'Dihexa',
        canonicalMolecule: 'dihexa',
        tags: ['peptide', 'nootropic', 'hgf_cmet_agonist', 'oncogenic_growth_factors'],
        doNotPairWith: [
          {
            targetType: 'compound',
            targetRef: 'igf-1-lr3',
            severity: 'hard_stop',
            mechanism:
              'Potent HGF/c-Met pathway stimulation combined with IGF-1 LR3 poses unacceptable theoretical oncogenic risk.',
            recommendation: 'HARD STOP: Never co-stack Dihexa with IGF-1 LR3.',
          },
        ],
        profileStatus: 'verified',
      })
    );

    cmpTretinoin = await apiCreateCompound(
      api,
      fixtures.makeDermCompound({
        profileStatus: 'verified',
      })
    );

    cmpSentinel = await apiCreateCompound(
      api,
      fixtures.makeSupplementCompound({
        name: 'Private Sentinel Compound X99',
        canonicalMolecule: 'sentinel-x99',
        profileStatus: 'verified',
      })
    );

    await apiSetOwnership(api, cmpIgf1.id, { scope: 'household', status: 'have' });
    await apiSetOwnership(api, cmpDihexa.id, { scope: 'household', status: 'have' });
    await apiSetOwnership(api, cmpTretinoin.id, { scope: 'household', status: 'have' });
    await apiSetOwnership(api, cmpSentinel.id, { scope: 'household', status: 'have' });

    browserHandle = await launchBrowser({ viewport: { width: 1280, height: 800 } });
  });

  after(async () => {
    try {
      if (browserHandle) await browserHandle.close();
    } finally {
      if (server) await server.stop();
    }
  });

  it('T2-01: enforces <meta name="robots" content="noindex, nofollow"> and zero raw secret leakage in rendered DOM across all 5 views', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    const robotsContent = await page.evaluate(() => {
      const meta = document.querySelector('head meta[name="robots"]');
      return meta ? meta.getAttribute('content') || '' : '';
    });
    assert.match(robotsContent, /\bnoindex\b/i, `Expected noindex in <meta name="robots">, got: "${robotsContent}"`);
    assert.match(robotsContent, /\bnofollow\b/i, `Expected nofollow in <meta name="robots">, got: "${robotsContent}"`);

    for (const navId of ['nav-sections', 'nav-stack', 'nav-cabinet', 'nav-ai-hub', 'nav-settings']) {
      await page.locator(`[data-testid="${navId}"]`).first().click();
      const visibleText = await page.locator('body').innerText();
      assert.ok(
        !visibleText.includes(server.adminToken),
        `Raw adminToken leaked into visible DOM text on ${navId}`
      );
      assert.ok(
        !visibleText.includes(server.passcode),
        `Raw household passcode leaked into visible DOM text on ${navId}`
      );
    }

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T2-02: renders prominent non-hideable hard-stop-banner for IGF-1 LR3 + Dihexa oncogenic pair', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const oncogenicStack = await apiCreateStack(
      api,
      'member_husband',
      fixtures.makeStackPayload({
        name: 'Hard-Stop Oncogenic Test Stack',
        memberId: 'member_husband',
        active: true,
        items: [
          fixtures.makeStackItem({ compoundId: cmpIgf1.id, doseAmount: 40, doseUnit: 'mcg' }),
          fixtures.makeStackItem({ compoundId: cmpDihexa.id, doseAmount: 10, doseUnit: 'mg' }),
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
      value: oncogenicStack.id,
      labelRe: /Hard-Stop Oncogenic Test Stack/i,
    });

    const hardStopBanner = page.locator('[data-testid="hard-stop-banner"]').first();
    await hardStopBanner.waitFor({ state: 'visible', timeout: 10_000 });
    const bannerText = await hardStopBanner.innerText();
    assert.match(
      bannerText,
      /IGF-1|Dihexa|hard[\s_-]?stop|oncogenic|do\s+not/i,
      `Expected hard-stop-banner to clearly explain IGF-1 LR3 + Dihexa hard stop, got: "${bannerText}"`
    );

    const alertsPanel = page.locator('[data-testid="interaction-alerts"]').first();
    await alertsPanel.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(await alertsPanel.innerText(), /IGF-1|Dihexa|hard[\s_-]?stop/i);

    // Must remain visible (non-hideable) even when toggling stack controls
    await clickToggle(page.locator('[data-testid="stack-toggle-have-only"]').first());
    assert.equal(await hardStopBanner.isVisible(), true, 'hard-stop-banner MUST stay visible when toggling have-only');
    await clickToggle(page.locator('[data-testid="what-if-toggle"]').first());
    assert.equal(await hardStopBanner.isVisible(), true, 'hard-stop-banner MUST stay visible in What-If mode');

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T2-03: renders non-hideable hard-stop-banner for pregnancy teratogen context (member_wife pregnancyOrTrying + Tretinoin)', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const patchRes = await api.patch('/api/v1/members/member_wife', {
      safetyContext: {
        pregnancyOrTrying: true,
        biologicalSexContext: 'female',
        allergies: [],
        activeRxMeds: [],
        conditions: [],
      },
    });
    assert.equal(patchRes.status, 200, `PATCH member_wife failed (${patchRes.status}): ${patchRes.text}`);

    try {
      const pregStack = await apiCreateStack(
        api,
        'member_wife',
        fixtures.makeStackPayload({
          name: 'Pregnancy Teratogen Guard Stack',
          memberId: 'member_wife',
          active: true,
          items: [
            fixtures.makeStackItem({ compoundId: cmpTretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
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
        value: pregStack.id,
        labelRe: /Pregnancy Teratogen Guard Stack/i,
      });

      const hardStopBanner = page.locator('[data-testid="hard-stop-banner"]').first();
      await hardStopBanner.waitFor({ state: 'visible', timeout: 10_000 });
      const bannerText = await hardStopBanner.innerText();
      assert.match(
        bannerText,
        /pregnan|teratogen|tretinoin|retinoid|avoid|hard[\s_-]?stop/i,
        `Expected pregnancy/teratogen hard-stop warning in hard-stop-banner, got: "${bannerText}"`
      );

      assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
    } finally {
      // Restore pregnancyOrTrying to false so later tests start cleanly
      await api.patch('/api/v1/members/member_wife', {
        safetyContext: {
          pregnancyOrTrying: false,
          biologicalSexContext: 'female',
          allergies: [],
          activeRxMeds: [],
          conditions: [],
        },
      });
    }
  });

  it('T2-04: displays Missing SPF warning when photosensitizing derm active (Tretinoin) is stacked without SPF', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const noSpfStack = await apiCreateStack(
      api,
      'member_husband',
      fixtures.makeStackPayload({
        name: 'No-SPF Photosensitizing Stack',
        memberId: 'member_husband',
        active: true,
        items: [
          fixtures.makeStackItem({ compoundId: cmpTretinoin.id, doseAmount: 1, doseUnit: 'pea_size' }),
        ],
      })
    );

    // Corroborate engine contract via API schedule endpoint
    const schedRes = await api.post(
      `/api/v1/members/member_husband/stacks/${encodeURIComponent(noSpfStack.id)}/schedule`,
      {}
    );
    assert.equal(schedRes.status, 200, `Schedule endpoint failed: ${schedRes.text}`);
    const spread = unwrapData(schedRes.json, 'schedule');
    assert.ok(
      typeof spread?.dermatology?.skin?.missingSpfWarning === 'string' &&
        spread.dermatology.skin.missingSpfWarning.trim().length > 0,
      `Expected non-null dermatology.skin.missingSpfWarning in schedule payload: ${schedRes.text}`
    );

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await selectMember(page, 'member_husband');
    await page.locator('[data-testid="nav-stack"]').first().click();
    await selectOptionOnControl(page, page.locator('[data-testid="stack-selector"]').first(), {
      value: noSpfStack.id,
      labelRe: /No-SPF Photosensitizing Stack/i,
    });

    const dermAm = page.locator('[data-testid="spread-derm-am"]').first();
    const alerts = page.locator('[data-testid="interaction-alerts"]').first();
    await waitForCondition(
      async () => {
        const amText = (await dermAm.isVisible()) ? await dermAm.innerText() : '';
        const alertText = (await alerts.isVisible()) ? await alerts.innerText() : '';
        return /spf|sunscreen|photosensit/i.test(`${amText}\n${alertText}`);
      },
      {
        message:
          'Expected visible Missing SPF warning in spread-derm-am or interaction-alerts when Tretinoin is stacked without SPF',
      }
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T2-05: Device PIN lock unlocks on valid PIN and enforces lockout after 5 consecutive wrong PIN attempts (F4)', async () => {
    // Use an isolated browser handle so PIN device state does not affect sibling Tier 2 tests
    const pinBrowser = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await pinBrowser.openAuthenticatedPage(server.baseUrl, {
        token: server.adminToken,
        passcode: server.passcode,
      });

      const validPin = '2468';
      await enablePinInSettings(page, validPin);

      // Step 1: Lock and verify valid PIN unlocks cleanly
      await lockAppViaPin(page);
      const validAttempt = await submitPinAttemptOnLockScreen(page, validPin);
      assert.equal(validAttempt.blockedByDisabled, false, 'Valid PIN entry should not be blocked before failed attempts');

      await waitForCondition(
        async () => !(await isPinLockActive(page)) && (await page.locator('[data-testid="nav-sections"]').first().isVisible()),
        { message: 'Expected valid PIN to unlock the app and restore nav-sections' }
      );

      // Step 2: Re-lock and submit 5 consecutive wrong PIN attempts -> must trigger 30s lockout
      await page.locator('[data-testid="nav-settings"]').first().click();
      await lockAppViaPin(page);

      const wrongPins = ['1111', '2222', '3333', '4444', '5555'];
      for (const badPin of wrongPins) {
        await submitPinAttemptOnLockScreen(page, badPin);
        await page.waitForTimeout(150);
      }

      // Assert lockout message/cooldown is visibly displayed
      await waitForCondition(
        async () => LOCKOUT_TEXT_RE.test(await page.locator('body').innerText()),
        { message: 'Expected visible lockout / cooldown banner after 5 consecutive wrong PIN attempts' }
      );

      // Step 3: Verify even the VALID PIN is rejected / blocked while lockout is active
      const attemptDuringLockout = await submitPinAttemptOnLockScreen(page, validPin);
      if (!attemptDuringLockout.blockedByDisabled) {
        await page.waitForTimeout(300);
        assert.equal(
          await isPinLockActive(page),
          true,
          'Valid PIN MUST remain blocked while 30-second PIN lockout is active'
        );
        assert.match(
          await page.locator('body').innerText(),
          LOCKOUT_TEXT_RE,
          'Lockout message must remain visible when attempting unlock during cooldown'
        );
      }

      assert.deepEqual(pinBrowser.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(pinBrowser.pageErrors)}`);
    } finally {
      await pinBrowser.close();
    }
  });

  it('T2-06: rejects malformed JSON and schema-invalid JSON in AI JSON Importer without crashing or corrupting catalog', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const countBefore = (await apiListCompounds(api)).length;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-ai-hub"]').first().click();
    const textarea = page.locator('[data-testid="ai-json-import-textarea"]').first();
    const importBtn = page.locator('[data-testid="btn-import-ai-json"]').first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await importBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // Case A: Syntactically malformed JSON
    await textarea.fill('{ "name": "Broken Syntax Compound", "sectionId": [unclosed');
    await importBtn.click();

    await waitForCondition(
      async () => ERROR_TEXT_RE.test(await page.locator('body').innerText()),
      { message: 'Expected user-facing parse/validation error for syntactically malformed AI JSON' }
    );
    assert.equal(
      (await apiListCompounds(api)).length,
      countBefore,
      'Malformed JSON import MUST NOT create any compound record'
    );

    // Case B: Syntactically valid JSON missing required fields (`name`, `sectionId`)
    await textarea.fill(JSON.stringify({ summary: 'Missing required name and sectionId fields' }));
    await importBtn.click();

    await waitForCondition(
      async () => ERROR_TEXT_RE.test(await page.locator('body').innerText()),
      { message: 'Expected user-facing validation error for schema-invalid AI JSON missing name/sectionId' }
    );
    assert.equal(
      (await apiListCompounds(api)).length,
      countBefore,
      'Schema-invalid JSON import MUST NOT create any compound record'
    );

    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T2-07: prevents saving an empty/invalid Add Compound form and surfaces validation feedback', async () => {
    browserHandle.pageErrors.length = 0;
    browserHandle.consoleErrors.length = 0;

    const countBefore = (await apiListCompounds(api)).length;

    const page = await browserHandle.openAuthenticatedPage(server.baseUrl, {
      token: server.adminToken,
      passcode: server.passcode,
    });

    await page.locator('[data-testid="nav-sections"]').first().click();
    await page.locator('[data-testid="btn-add-compound"]').first().click();

    const saveBtn = page.locator('[data-testid="btn-save-compound"]').first();
    await saveBtn.waitFor({ state: 'visible', timeout: 10_000 });

    const formScope =
      (await firstVisibleFrom(page, ['[role="dialog"]', '[data-testid="compound-detail"]', 'form'])) ||
      page.locator('body');
    const nameInput = await firstVisibleFrom(formScope, [
      'input[name="name"]',
      'input[name*="name" i]',
      'input[placeholder*="name" i]',
      'input[aria-label*="name" i]',
      'input[type="text"]',
    ]);
    assert.ok(nameInput, 'Expected visible name input inside Add Compound form');
    await nameInput.fill('');

    await saveBtn.click();
    await page.waitForTimeout(300);

    const hasInlineError = ERROR_TEXT_RE.test(await formScope.innerText());
    const hasNativeValidation = await nameInput.evaluate(
      (el) => Boolean(el.validity && !el.validity.valid)
    );
    assert.ok(
      hasInlineError || hasNativeValidation,
      'Expected inline validation error or native required validation feedback on blank compound name'
    );

    assert.equal(
      (await apiListCompounds(api)).length,
      countBefore,
      'Submitting an empty Add Compound form MUST NOT persist a blank compound'
    );
    assert.deepEqual(browserHandle.pageErrors, [], `Unexpected pageErrors: ${JSON.stringify(browserHandle.pageErrors)}`);
  });

  it('T2-08: handles missing token and invalid token cleanly in fresh browser contexts without leaking private records', async () => {
    const authBoundaryRe = /sign\s*in|token|passcode|unauthorized|connect|login|unlock|auth|credential/i;

    // 1. Fresh context without ?token=
    const unauthHandle = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    try {
      await unauthHandle.page.goto(`${server.baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await unauthHandle.page.waitForTimeout(600);
      const bodyText = await unauthHandle.page.locator('body').innerText();
      const hasAuthInput =
        (await unauthHandle.page.locator('input[type="password"], input[name*="token" i], input[name*="pass" i], [data-testid="settings-sync"]').count()) > 0;

      assert.ok(
        bodyText.trim().length > 0 && (hasAuthInput || authBoundaryRe.test(bodyText)),
        `Unauthenticated load MUST render an auth prompt/boundary (not blank or broken page), got: "${bodyText.slice(0, 200)}"`
      );
      assert.ok(
        !bodyText.includes('Private Sentinel Compound X99'),
        'Unauthenticated browser session MUST NOT expose private household compound records'
      );
      assert.equal(
        await unauthHandle.page.locator(`[data-testid="compound-card-${cmpSentinel.id}"], [data-testid="compound-card-${cmpSentinel.slug}"]`).count(),
        0,
        'Unauthenticated browser session MUST NOT render private compound cards'
      );
      assert.deepEqual(
        unauthHandle.pageErrors,
        [],
        `Unexpected pageErrors without token: ${JSON.stringify(unauthHandle.pageErrors)}`
      );
    } finally {
      await unauthHandle.close();
    }

    // 2. Fresh context with invalid ?token=
    const badTokenHandle = await launchBrowser({ viewport: { width: 1280, height: 800 } });
    try {
      await badTokenHandle.page.goto(`${server.baseUrl}/?token=invalid-bogus-token-0000`, {
        waitUntil: 'domcontentloaded',
      });
      await badTokenHandle.page.waitForTimeout(600);
      const bodyText = await badTokenHandle.page.locator('body').innerText();
      const hasAuthInput =
        (await badTokenHandle.page.locator('input[type="password"], input[name*="token" i], input[name*="pass" i], [data-testid="settings-sync"]').count()) > 0;

      assert.ok(
        bodyText.trim().length > 0 && (hasAuthInput || authBoundaryRe.test(bodyText)),
        `Invalid-token load MUST render an auth error/prompt cleanly, got: "${bodyText.slice(0, 200)}"`
      );
      assert.ok(
        !bodyText.includes('Private Sentinel Compound X99'),
        'Invalid-token browser session MUST NOT expose private household compound records'
      );
      assert.equal(
        await badTokenHandle.page.locator(`[data-testid="compound-card-${cmpSentinel.id}"], [data-testid="compound-card-${cmpSentinel.slug}"]`).count(),
        0,
        'Invalid-token browser session MUST NOT render private compound cards'
      );
      assert.deepEqual(
        badTokenHandle.pageErrors,
        [],
        `Unexpected pageErrors with invalid token: ${JSON.stringify(badTokenHandle.pageErrors)}`
      );
    } finally {
      await badTokenHandle.close();
    }
  });

  it('T2-09: renders responsive mobile layout (390x844) across all 5 views without horizontal overflow', async () => {
    const mobileHandle = await launchBrowser({
      viewport: { width: 390, height: 844 },
      contextOptions: { isMobile: true, hasTouch: true },
    });
    try {
      const page = await mobileHandle.openAuthenticatedPage(server.baseUrl, {
        token: server.adminToken,
        passcode: server.passcode,
      });

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
          `Mobile horizontal overflow detected on ${navId}: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
        );
      }

      assert.deepEqual(
        mobileHandle.pageErrors,
        [],
        `Unexpected pageErrors on mobile viewport: ${JSON.stringify(mobileHandle.pageErrors)}`
      );
    } finally {
      await mobileHandle.close();
    }
  });
});
