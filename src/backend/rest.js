/**
 * REST API v1 & Public Discovery Router (`src/backend/rest.js`).
 * Implements all routes in `PROJECT.md §2` with strict scope enforcement,
 * `Cache-Control: no-store` on private responses, ETag/If-Match sync, and zero-PII public discovery.
 */

import { HUB_VERSION } from '../core/index.js';
import {
  forbiddenResponse,
  getRequestOrigin,
  hasScope,
  jsonResponse,
  textResponse,
  unauthorizedResponse,
} from './auth.js';
import { buildLlmsTxt, buildOpenApiSpec } from './openapi.js';
import { HubError } from './service.js';

async function readJsonBody(request) {
  const raw = await request.text();
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HubError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function queryToObject(url) {
  const out = {};
  for (const [k, v] of url.searchParams.entries()) {
    out[k] = v;
  }
  return out;
}

function handleError(err, corsHeaders) {
  if (err instanceof HubError) {
    return jsonResponse(
      {
        error: err.code,
        message: err.message,
        ...(err.details && typeof err.details === 'object' ? err.details : {}),
      },
      { status: err.status, corsHeaders },
    );
  }
  return jsonResponse(
    {
      error: 'INTERNAL_ERROR',
      message: err?.message || 'Unexpected server error.',
    },
    { status: 500, corsHeaders },
  );
}

export async function handleRestRoute(request, url, env, storage, service, auth, corsHeaders) {
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const origin = getRequestOrigin(request, env);

  // -------------------------------------------------------------------------
  // Public Zero-PII Discovery Routes
  // -------------------------------------------------------------------------
  if (method === 'GET' && pathname === '/health') {
    return jsonResponse(
      {
        ok: true,
        version: HUB_VERSION,
        storage: storage.kind || 'memory',
        mode: env?.MODE || (storage.kind === 'd1' || storage.kind === 'kv' ? 'cloudflare' : 'local'),
      },
      { status: 200, corsHeaders, noStore: false },
    );
  }

  if (method === 'GET' && pathname === '/openapi.json') {
    return jsonResponse(buildOpenApiSpec(origin), { status: 200, corsHeaders, noStore: false });
  }

  if (method === 'GET' && pathname === '/llms.txt') {
    return textResponse(buildLlmsTxt(origin), {
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      corsHeaders,
      noStore: false,
    });
  }

  // Only handle /api/v1/* below
  if (!pathname.startsWith('/api/v1/')) {
    return null;
  }

  // Require Authentication for all /api/v1/* routes
  if (!auth?.authenticated) {
    return unauthorizedResponse({ origin, isMcp: false, corsHeaders });
  }

  const requireScope = (scope) => {
    if (!hasScope(auth, scope)) {
      return forbiddenResponse({
        corsHeaders,
        message: `This endpoint requires "${scope}" scope (token has "${auth.scope}").`,
      });
    }
    return null;
  };

  try {
    const q = queryToObject(url);

    // -----------------------------------------------------------------------
    // Household & Settings
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/household' && method === 'GET') {
      const data = await service.getHousehold();
      return jsonResponse({ household: data, ...data }, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/household/settings' && (method === 'PATCH' || method === 'PUT')) {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const data = await service.updateHouseholdSettings(body, auth);
      return jsonResponse(data, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // Members
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/members' && method === 'GET') {
      const members = await service.listMembers();
      return jsonResponse({ members }, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/members' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const member = await service.createMember(body, auth);
      return jsonResponse({ member }, { status: 201, corsHeaders });
    }

    const memberMatch = /^\/api\/v1\/members\/([^/]+)$/.exec(pathname);
    if (memberMatch) {
      const memberId = decodeURIComponent(memberMatch[1]);
      if (method === 'PATCH') {
        const denied = requireScope('write');
        if (denied) return denied;
        const body = await readJsonBody(request);
        const member = await service.updateMember(memberId, body, auth);
        return jsonResponse({ member }, { status: 200, corsHeaders });
      }
      if (method === 'DELETE') {
        const denied = requireScope('write');
        if (denied) return denied;
        const res = await service.deleteMember(memberId, auth);
        return jsonResponse(res, { status: 200, corsHeaders });
      }
    }

    // -----------------------------------------------------------------------
    // Sections
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/sections' && method === 'GET') {
      const sections = await service.listSections();
      return jsonResponse({ sections }, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/sections' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const section = await service.createSection(body, auth);
      return jsonResponse({ section }, { status: 201, corsHeaders });
    }

    const sectionMatch = /^\/api\/v1\/sections\/([^/]+)$/.exec(pathname);
    if (sectionMatch) {
      const sectionId = decodeURIComponent(sectionMatch[1]);
      if (method === 'GET') {
        const section = await service.getSection(sectionId);
        return jsonResponse({ section }, { status: 200, corsHeaders });
      }
      if (method === 'PATCH') {
        const denied = requireScope('write');
        if (denied) return denied;
        const body = await readJsonBody(request);
        const section = await service.updateSection(sectionId, body, auth);
        return jsonResponse({ section }, { status: 200, corsHeaders });
      }
      if (method === 'DELETE') {
        const denied = requireScope('write');
        if (denied) return denied;
        const res = await service.deleteSection(sectionId, auth);
        return jsonResponse(res, { status: 200, corsHeaders });
      }
    }

    // -----------------------------------------------------------------------
    // Compounds
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/compounds' && method === 'GET') {
      const compounds = await service.listCompounds(q);
      return jsonResponse({ compounds, count: compounds.length }, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/compounds' && method === 'POST') {
      const denied = requireScope('propose');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const isAi = auth.kind !== 'admin';
      const result = await service.createCompound(body, auth, { isAi });
      return jsonResponse(result, { status: result.status === 'proposed' ? 202 : 201, corsHeaders });
    }
    if (pathname === '/api/v1/compounds/check-duplicate' && method === 'POST') {
      const body = await readJsonBody(request);
      const result = await service.checkDuplicate(body);
      return jsonResponse(result, { status: 200, corsHeaders });
    }

    const verifyMatch = /^\/api\/v1\/compounds\/([^/]+)\/verify$/.exec(pathname);
    if (verifyMatch && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const compound = await service.verifyCompound(decodeURIComponent(verifyMatch[1]), auth);
      return jsonResponse({ compound }, { status: 200, corsHeaders });
    }

    const cmpMatch = /^\/api\/v1\/compounds\/([^/]+)$/.exec(pathname);
    if (cmpMatch) {
      const compoundId = decodeURIComponent(cmpMatch[1]);
      if (method === 'GET') {
        const compound = await service.getCompound(compoundId);
        return jsonResponse({ compound }, { status: 200, corsHeaders });
      }
      if (method === 'PATCH') {
        const denied = requireScope('write');
        if (denied) return denied;
        const body = await readJsonBody(request);
        const compound = await service.updateCompound(compoundId, body, auth);
        return jsonResponse({ compound }, { status: 200, corsHeaders });
      }
      if (method === 'DELETE') {
        const denied = requireScope('write');
        if (denied) return denied;
        const res = await service.deleteCompound(compoundId, auth);
        return jsonResponse(res, { status: 200, corsHeaders });
      }
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/ownership' && method === 'GET') {
      const ownership = await service.listOwnership(q);
      return jsonResponse({ ownership }, { status: 200, corsHeaders });
    }
    const ownMatch = /^\/api\/v1\/ownership\/([^/]+)$/.exec(pathname);
    if (ownMatch && (method === 'PUT' || method === 'PATCH')) {
      const denied = requireScope('propose');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const ownership = await service.upsertOwnership(decodeURIComponent(ownMatch[1]), body, auth);
      return jsonResponse({ ownership }, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // Member Stacks, Schedule & Interactions
    // -----------------------------------------------------------------------
    const stacksMatch = /^\/api\/v1\/members\/([^/]+)\/stacks$/.exec(pathname);
    if (stacksMatch) {
      const memberId = decodeURIComponent(stacksMatch[1]);
      if (method === 'GET') {
        const stacks = await service.listMemberStacks(memberId);
        return jsonResponse({ stacks }, { status: 200, corsHeaders });
      }
      if (method === 'POST') {
        const denied = requireScope('write');
        if (denied) return denied;
        const body = await readJsonBody(request);
        const stack = await service.createMemberStack(memberId, body, auth);
        return jsonResponse({ stack }, { status: 201, corsHeaders });
      }
    }

    const schedMatch = /^\/api\/v1\/members\/([^/]+)\/stacks\/([^/]+)\/schedule$/.exec(pathname);
    if (schedMatch && method === 'POST') {
      const body = await readJsonBody(request);
      const schedule = await service.computeStackSchedule(
        decodeURIComponent(schedMatch[1]),
        decodeURIComponent(schedMatch[2]),
        body,
      );
      return jsonResponse({ schedule, spread: schedule, ...schedule }, { status: 200, corsHeaders });
    }

    const interMatch = /^\/api\/v1\/members\/([^/]+)\/stacks\/([^/]+)\/interactions$/.exec(pathname);
    if (interMatch && method === 'POST') {
      const body = await readJsonBody(request);
      const analysis = await service.computeStackInteractions(
        decodeURIComponent(interMatch[1]),
        decodeURIComponent(interMatch[2]),
        body,
      );
      return jsonResponse({ analysis, interactions: analysis, ...analysis }, { status: 200, corsHeaders });
    }

    const stackItemMatch = /^\/api\/v1\/members\/([^/]+)\/stacks\/([^/]+)$/.exec(pathname);
    if (stackItemMatch) {
      const memberId = decodeURIComponent(stackItemMatch[1]);
      const stackId = decodeURIComponent(stackItemMatch[2]);
      if (method === 'PATCH') {
        const denied = requireScope('write');
        if (denied) return denied;
        const body = await readJsonBody(request);
        const stack = await service.updateMemberStack(memberId, stackId, body, auth);
        return jsonResponse({ stack }, { status: 200, corsHeaders });
      }
      if (method === 'DELETE') {
        const denied = requireScope('write');
        if (denied) return denied;
        const res = await service.deleteMemberStack(memberId, stackId, auth);
        return jsonResponse(res, { status: 200, corsHeaders });
      }
    }

    // -----------------------------------------------------------------------
    // Member Logs & Adherence
    // -----------------------------------------------------------------------
    const logsMatch = /^\/api\/v1\/members\/([^/]+)\/logs$/.exec(pathname);
    if (logsMatch) {
      const memberId = decodeURIComponent(logsMatch[1]);
      if (method === 'GET') {
        const logs = await service.listMemberLogs(memberId, q);
        return jsonResponse({ logs }, { status: 200, corsHeaders });
      }
      if (method === 'POST') {
        const denied = requireScope('write');
        if (denied) return denied;
        const body = await readJsonBody(request);
        const res = await service.createMemberLog(memberId, body, auth);
        return jsonResponse(res, { status: 201, corsHeaders });
      }
    }

    const logItemMatch = /^\/api\/v1\/members\/([^/]+)\/logs\/([^/]+)$/.exec(pathname);
    if (logItemMatch && method === 'DELETE') {
      const denied = requireScope('write');
      if (denied) return denied;
      const res = await service.deleteMemberLog(
        decodeURIComponent(logItemMatch[1]),
        decodeURIComponent(logItemMatch[2]),
        auth,
      );
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    const adhMatch = /^\/api\/v1\/members\/([^/]+)\/adherence$/.exec(pathname);
    if (adhMatch && method === 'GET') {
      const adherence = await service.getMemberAdherence(decodeURIComponent(adhMatch[1]));
      return jsonResponse({ adherence, ...adherence }, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // Proposals & Audit Log
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/proposals' && method === 'GET') {
      const proposals = await service.listProposals(q);
      return jsonResponse({ proposals }, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/proposals' && method === 'POST') {
      const denied = requireScope('propose');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const proposal = await service.createProposal(body, auth);
      return jsonResponse({ proposal }, { status: 201, corsHeaders });
    }

    const resolveMatch = /^\/api\/v1\/proposals\/([^/]+)\/resolve$/.exec(pathname);
    if (resolveMatch && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const res = await service.resolveProposal(decodeURIComponent(resolveMatch[1]), body, auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    if (pathname === '/api/v1/audit-log' && method === 'GET') {
      const auditLog = await service.listAuditLog(q);
      return jsonResponse({ auditLog, entries: auditLog }, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // API Keys & OAuth Clients
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/keys' && method === 'GET') {
      const keys = await service.listApiKeys();
      return jsonResponse({ keys }, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/keys' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const created = await service.createApiKey(body, auth);
      return jsonResponse(created, { status: 201, corsHeaders });
    }
    const keyItemMatch = /^\/api\/v1\/keys\/([^/]+)$/.exec(pathname);
    if (keyItemMatch && method === 'DELETE') {
      const denied = requireScope('write');
      if (denied) return denied;
      const res = await service.revokeApiKey(decodeURIComponent(keyItemMatch[1]), auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    if (pathname === '/api/v1/oauth/clients' && method === 'GET') {
      const clients = await service.listOAuthClients();
      return jsonResponse({ clients }, { status: 200, corsHeaders });
    }
    const oauthClientMatch = /^\/api\/v1\/oauth\/clients\/([^/]+)$/.exec(pathname);
    if (oauthClientMatch && method === 'DELETE') {
      const denied = requireScope('write');
      if (denied) return denied;
      const res = await service.revokeOAuthClient(decodeURIComponent(oauthClientMatch[1]), auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // Sync & Daily Snapshots
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/sync' && method === 'GET') {
      const state = await service.getSyncState();
      return jsonResponse(
        { ...state, _rev: state._rev },
        { status: 200, headers: { ETag: `"${state._rev}"` }, corsHeaders },
      );
    }
    if (pathname === '/api/v1/sync' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const ifMatch = request.headers.get('if-match');
      const clientState =
        body?.state && typeof body.state === 'object' && !Array.isArray(body.compounds)
          ? { ...body.state, _rev: body._rev ?? body.state._rev }
          : body;
      const saved = await service.pushSyncState(clientState, { ifMatch }, auth);
      return jsonResponse(
        { ok: true, _rev: saved._rev, state: saved },
        { status: 200, headers: { ETag: `"${saved._rev}"` }, corsHeaders },
      );
    }

    if (pathname === '/api/v1/snapshots' && method === 'GET') {
      const snapshots = await service.listSnapshots();
      return jsonResponse({ snapshots }, { status: 200, corsHeaders });
    }
    const snapRestoreMatch = /^\/api\/v1\/snapshots\/([^/]+)\/restore$/.exec(pathname);
    if (snapRestoreMatch && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const res = await service.restoreSnapshot(decodeURIComponent(snapRestoreMatch[1]), auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // Multi-Format Exports, Imports & Starter Seed
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/export/hub.json' && method === 'GET') {
      const exported = await service.exportHub();
      return jsonResponse(exported, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/export/compounds.csv' && method === 'GET') {
      const csv = await service.exportCsv();
      return textResponse(csv, {
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        headers: { 'Content-Disposition': 'attachment; filename="home-pharmacy-compounds.csv"' },
        corsHeaders,
      });
    }
    if (pathname === '/api/v1/export/context.md' && method === 'GET') {
      const rawSec = q.sections || q.section || q.sectionId || null;
      const sectionIds = rawSec
        ? String(rawSec)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      const bundle = await service.exportContext({
        memberId: q.member || q.memberId || null,
        sectionIds,
        format: 'md',
      });
      const md = typeof bundle === 'string' ? bundle : bundle.markdown || bundle.content || '';
      return textResponse(md, {
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        corsHeaders,
      });
    }
    if (pathname === '/api/v1/export/context.json' && method === 'GET') {
      const rawSec = q.sections || q.section || q.sectionId || null;
      const sectionIds = rawSec
        ? String(rawSec)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      const bundle = await service.exportContext({
        memberId: q.member || q.memberId || null,
        sectionIds,
        format: 'json',
      });
      return jsonResponse(bundle, { status: 200, corsHeaders });
    }

    if (pathname === '/api/v1/import/hub' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const res = await service.importHub(body, auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/import/protocol-os' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const res = await service.importProtocolOs(body, { memberId: q.member || body.memberId || 'member_husband' }, auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/seed/starter' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const res = await service.seedStarter(auth);
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // AI Prompt Builder & Optional BYOK Autofill
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/ai/research-prompt' && method === 'POST') {
      const body = await readJsonBody(request);
      const res = await service.buildResearchPrompt(body);
      return jsonResponse(res, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/ai/autofill' && method === 'POST') {
      const denied = requireScope('propose');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const res = await service.autofillCompound(body);
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    // -----------------------------------------------------------------------
    // Web Push Config & Subscriptions
    // -----------------------------------------------------------------------
    if (pathname === '/api/v1/push/config' && method === 'GET') {
      const cfg = await service.getPushConfig();
      return jsonResponse(cfg, { status: 200, corsHeaders });
    }
    if (pathname === '/api/v1/push/subscribe' && method === 'POST') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const res = await service.subscribePush(body, auth);
      return jsonResponse(res, { status: 201, corsHeaders });
    }
    if (pathname === '/api/v1/push/subscribe' && method === 'DELETE') {
      const denied = requireScope('write');
      if (denied) return denied;
      const body = await readJsonBody(request);
      const res = await service.unsubscribePush({ ...q, ...body });
      return jsonResponse(res, { status: 200, corsHeaders });
    }

    return jsonResponse(
      { error: 'NOT_FOUND', message: `No route matches ${method} ${pathname}` },
      { status: 404, corsHeaders },
    );
  } catch (err) {
    return handleError(err, corsHeaders);
  }
}
