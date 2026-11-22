import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/backend/app.js';
import { createMemoryStorage } from '../../src/backend/storage/memory.js';

const ADMIN_TOKEN = 'unit-admin-token-1234567890';
const PASSCODE = 'unit-passcode-secret';

function makeApp() {
  const storage = createMemoryStorage();
  const env = {
    HOUSEHOLD_ADMIN_TOKEN: ADMIN_TOKEN,
    HOUSEHOLD_PASSCODE: PASSCODE,
    ALLOWED_ORIGINS: 'http://localhost:8787',
  };
  return createApp({ storage, env });
}

async function reqJson(app, method, path, body = null, { token = ADMIN_TOKEN, headers = {} } = {}) {
  const hdrs = { ...headers };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  if (body !== null) hdrs['Content-Type'] = 'application/json';
  const req = new Request(`http://127.0.0.1:8787${path}`, {
    method,
    headers: hdrs,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const res = await app.handleRequest(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

describe('M3 Backend REST API Unit Tests (Memory Storage)', () => {
  it('1. Public discovery (/health, /openapi.json, /llms.txt) and unauth 401 guard', async () => {
    const app = makeApp();
    const health = await reqJson(app, 'GET', '/health', null, { token: null });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.storage, 'memory');

    const openapi = await reqJson(app, 'GET', '/openapi.json', null, { token: null });
    assert.equal(openapi.status, 200);
    assert.equal(openapi.json.openapi, '3.1.0');

    const llms = await reqJson(app, 'GET', '/llms.txt', null, { token: null });
    assert.equal(llms.status, 200);
    assert.match(llms.text, /Home Pharmacy/);

    const unauth = await reqJson(app, 'GET', '/api/v1/compounds', null, { token: null });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('cache-control') || '', /no-store/i);
  });

  it('2. Compounds CRUD, duplicate 409, starter seed idempotency & daily snapshot restore', async () => {
    const app = makeApp();
    const seed1 = await reqJson(app, 'POST', '/api/v1/seed/starter', {});
    assert.equal(seed1.status, 200);
    assert.ok(seed1.json.addedCount >= 20);

    const seed2 = await reqJson(app, 'POST', '/api/v1/seed/starter', {});
    assert.equal(seed2.status, 200);
    assert.equal(seed2.json.addedCount, 0);

    const snaps = await reqJson(app, 'GET', '/api/v1/snapshots');
    assert.equal(snaps.status, 200);
    assert.ok(snaps.json.snapshots.length >= 1);

    // Add an extra compound after snapshot, then restore
    const created = await reqJson(app, 'POST', '/api/v1/compounds', {
      name: 'Unique Experimental Peptide X9',
      sectionId: 'peptides',
      summary: 'Test summary',
      dosages: { defaultAmount: 100, defaultUnit: 'mcg', route: 'SubQ', rangeText: '100 mcg', frequencyText: 'Daily' },
    });
    assert.equal(created.status, 201);
    const dup = await reqJson(app, 'POST', '/api/v1/compounds', {
      name: 'Unique Experimental Peptide X9',
      sectionId: 'peptides',
      summary: 'Dup attempt',
      dosages: { defaultAmount: 100, defaultUnit: 'mcg', route: 'SubQ', rangeText: '100 mcg', frequencyText: 'Daily' },
    });
    assert.equal(dup.status, 409);

    const dateKey = snaps.json.snapshots[0].dateKey;
    const restored = await reqJson(app, 'POST', `/api/v1/snapshots/${dateKey}/restore`, {});
    assert.equal(restored.status, 200);
    const listAfter = await reqJson(app, 'GET', '/api/v1/compounds');
    assert.ok(!listAfter.json.compounds.some((c) => c.id === created.json.compound.id));
  });

  it('3. Scoped API key minting (read-only blocks writes 403) & revocation (401)', async () => {
    const app = makeApp();
    const minted = await reqJson(app, 'POST', '/api/v1/keys', { name: 'Read Only Muse', scope: 'read' });
    assert.equal(minted.status, 201);
    const secret = minted.json.secret;
    assert.ok(secret.startsWith('hp_key_'));

    const readOk = await reqJson(app, 'GET', '/api/v1/sections', null, { token: secret });
    assert.equal(readOk.status, 200);

    const writeDenied = await reqJson(app, 'POST', '/api/v1/seed/starter', {}, { token: secret });
    assert.equal(writeDenied.status, 403);

    const rev = await reqJson(app, 'DELETE', `/api/v1/keys/${minted.json.id}`);
    assert.equal(rev.status, 200);

    const afterRev = await reqJson(app, 'GET', '/api/v1/sections', null, { token: secret });
    assert.equal(afterRev.status, 401);
  });
});
