/**
 * Unified Dual-Runtime Web-Standard Fetch App (`src/backend/app.js`).
 * Wires CORS, OAuth 2.1, Remote Streamable HTTP MCP, REST API v1, Discovery,
 * and optional Static Web PWA serving behind one `handleRequest(request)` function.
 */

import { getCorsHeaders, jsonResponse, resolveAuth } from './auth.js';
import { handleMcpRequest } from './mcp.js';
import { handleOAuthRoute } from './oauth.js';
import { handleRestRoute } from './rest.js';
import { createHubService } from './service.js';

export function createApp({ storage, env = {}, staticHandler = null }) {
  const service = createHubService({ storage, env });

  async function handleRequest(request) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);

    // 1. CORS Preflight (OPTIONS)
    if (request.method.toUpperCase() === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          'Cache-Control': 'no-store',
        },
      });
    }

    // 2. OAuth 2.1 Discovery, DCR, Authorize Consent UI, Token & Revocation
    if (
      url.pathname.startsWith('/.well-known/oauth-') ||
      url.pathname.startsWith('/oauth/')
    ) {
      const oauthRes = await handleOAuthRoute(request, url, env, storage, corsHeaders);
      if (oauthRes) return oauthRes;
    }

    // 3. Universal Remote Streamable HTTP MCP Endpoint (/mcp)
    if (url.pathname === '/mcp') {
      const auth = await resolveAuth(request, env, storage);
      return handleMcpRequest(request, env, service, auth, corsHeaders);
    }

    // 4. Public Discovery (/health, /openapi.json, /llms.txt) + Authenticated REST API v1 (/api/v1/*)
    if (
      url.pathname === '/health' ||
      url.pathname === '/openapi.json' ||
      url.pathname === '/llms.txt' ||
      url.pathname.startsWith('/api/v1/')
    ) {
      const auth = url.pathname.startsWith('/api/v1/')
        ? await resolveAuth(request, env, storage)
        : { authenticated: false };
      const restRes = await handleRestRoute(request, url, env, storage, service, auth, corsHeaders);
      if (restRes) return restRes;
    }

    // 5. Static Frontend PWA Handler (when running via node-server.js or Workers Assets)
    if (typeof staticHandler === 'function') {
      const staticRes = await staticHandler(request, url);
      if (staticRes) return staticRes;
    }

    return jsonResponse(
      { error: 'NOT_FOUND', message: `Not found: ${url.pathname}` },
      { status: 404, corsHeaders },
    );
  }

  return { handleRequest, service, storage };
}
