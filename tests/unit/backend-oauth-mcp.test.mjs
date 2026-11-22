import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/backend/app.js';
import { createMemoryStorage } from '../../src/backend/storage/memory.js';
import { sha256Base64Url } from '../../src/backend/auth.js';

const ADMIN_TOKEN = 'unit-admin-token-oauth-mcp';
const PASSCODE = 'unit-passcode-oauth-mcp';

function makeApp() {
  return createApp({
    storage: createMemoryStorage(),
    env: {
      HOUSEHOLD_ADMIN_TOKEN: ADMIN_TOKEN,
      HOUSEHOLD_PASSCODE: PASSCODE,
    },
  });
}

describe('M3 Backend OAuth 2.1 + PKCE + Remote MCP Unit Tests', () => {
  it('1. Full OAuth 2.1 DCR + PKCE S256 + RFC 9207 iss + refresh rotation + revocation', async () => {
    const app = makeApp();
    const origin = 'http://127.0.0.1:8787';

    // Discovery
    const pr = await app.handleRequest(new Request(`${origin}/.well-known/oauth-protected-resource`));
    assert.equal(pr.status, 200);
    const asMeta = await (await app.handleRequest(new Request(`${origin}/.well-known/oauth-authorization-server`))).json();
    assert.equal(asMeta.authorization_response_iss_parameter_supported, true);
    assert.equal(asMeta.client_id_metadata_document_supported, true);

    // DCR
    const dcrRes = await app.handleRequest(
      new Request(`${origin}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude Unit', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
      }),
    );
    assert.equal(dcrRes.status, 201);
    const dcr = await dcrRes.json();

    // PKCE S256
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await sha256Base64Url(verifier);

    // POST /oauth/authorize
    const form = new URLSearchParams({
      client_id: dcr.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      scope: 'propose',
      state: 'xyz123',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      passcode: PASSCODE,
      decision: 'approve',
      member_id: 'member_wife',
    });
    const authRes = await app.handleRequest(
      new Request(`${origin}/oauth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }),
    );
    assert.equal(authRes.status, 302);
    const cb = new URL(authRes.headers.get('location'));
    assert.equal(cb.searchParams.get('iss'), origin);
    assert.equal(cb.searchParams.get('state'), 'xyz123');
    const code = cb.searchParams.get('code');
    assert.ok(code);

    // Exchange code -> tokens
    const tokRes = await app.handleRequest(
      new Request(`${origin}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          client_id: dcr.client_id,
          code_verifier: verifier,
          resource: `${origin}/mcp`,
        }).toString(),
      }),
    );
    assert.equal(tokRes.status, 200);
    const tokens = await tokRes.json();
    assert.ok(tokens.access_token && tokens.refresh_token);

    // MCP initialize + tools/list (propose scope = 15 tools, excludes configure_section & resolve_proposal)
    const mcpRes = await app.handleRequest(
      new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        ]),
      }),
    );
    assert.equal(mcpRes.status, 200);
    const batch = await mcpRes.json();
    assert.equal(batch.length, 2);
    const toolNames = batch[1].result.tools.map((t) => t.name);
    assert.equal(toolNames.length, 15);
    assert.ok(!toolNames.includes('configure_section'));
    assert.ok(!toolNames.includes('resolve_proposal'));

    // Refresh rotation
    const refRes = await app.handleRequest(
      new Request(`${origin}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: dcr.client_id }),
      }),
    );
    assert.equal(refRes.status, 200);
    const rotated = await refRes.json();
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);

    // Revoke
    const revRes = await app.handleRequest(
      new Request(`${origin}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rotated.access_token }),
      }),
    );
    assert.equal(revRes.status, 200);

    // Post-revoke MCP call must return 401 with WWW-Authenticate
    const afterRev = await app.handleRequest(
      new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${rotated.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      }),
    );
    assert.equal(afterRev.status, 401);
    assert.match(afterRev.headers.get('www-authenticate') || '', /resource_metadata=/i);
  });
});
