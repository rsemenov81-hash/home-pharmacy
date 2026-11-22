/**
 * Universal Remote Streamable HTTP MCP Server (`POST /mcp`) — JSON-RPC 2.0
 * Supporting Gemini, Claude, Grok Bot, ChatGPT/GPT, and Meta Muse (F23, F25, F26).
 *
 * Protocol versions: 2025-06-18 (primary) and 2024-11-05 (compat).
 * Supports single & batch JSON-RPC 2.0, notifications (202), Mcp-Session-Id propagation,
 * scope-filtered tools/list & scope-enforced tools/call across all 17 canonical tools,
 * 5 canonical resources, and 3 reusable prompts.
 */

import { HUB_VERSION, dkToday } from '../core/index.js';
import {
  getRequestOrigin,
  hasScope,
  jsonResponse,
  randomToken,
  unauthorizedResponse,
} from './auth.js';
import { HubError } from './service.js';

const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2024-11-05']);

// ---------------------------------------------------------------------------
// 17 Canonical MCP Tools with Scopes & JSON Input Schemas
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  // READ TOOLS (11)
  {
    name: 'get_hub_overview',
    scope: 'read',
    description: 'Return household overview, member list, 4+ sections summary, compound counts, and pending proposals count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_sections',
    scope: 'read',
    description: 'List all health sections (peptides, peds, vitamins_supplements, dermatology, plus custom sections).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_section_schema',
    scope: 'read',
    description: 'Fetch a section schema including customFields, subsections, hiddenOptionalFields, and aiResearchPrompt.',
    inputSchema: {
      type: 'object',
      required: ['sectionId'],
      properties: {
        sectionId: { type: 'string', description: 'Section slug (peptides, peds, vitamins_supplements, dermatology, or custom)' },
      },
    },
  },
  {
    name: 'search_compounds',
    scope: 'read',
    description: 'Search and filter compound profiles by query text, section, ownership status, member, route, slot, status, evidenceTier, or tag.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        section: { type: 'string' },
        ownership: { type: 'string' },
        member: { type: 'string' },
        inStack: { type: 'boolean' },
        route: { type: 'string' },
        slot: { type: 'string' },
        status: { type: 'string' },
        evidenceTier: { type: 'string' },
        tag: { type: 'string' },
      },
    },
  },
  {
    name: 'get_compound',
    scope: 'read',
    description: 'Fetch full compound profile by compoundId or slug.',
    inputSchema: {
      type: 'object',
      required: ['compoundId'],
      properties: {
        compoundId: { type: 'string' },
      },
    },
  },
  {
    name: 'check_duplicate_compound',
    scope: 'read',
    description: 'Check whether a compound already exists by normalized name, alias, or blend fingerprint before creating.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        sectionId: { type: 'string' },
        route: { type: 'string' },
        canonicalMolecule: { type: 'string' },
      },
    },
  },
  {
    name: 'get_member_stack',
    scope: 'read',
    description: 'List stacks and active stack items for a specific household member (strict spouse isolation).',
    inputSchema: {
      type: 'object',
      required: ['memberId'],
      properties: {
        memberId: { type: 'string' },
        stackId: { type: 'string' },
      },
    },
  },
  {
    name: 'analyze_stack_interactions',
    scope: 'read',
    description: 'Analyze bidirectional interactions, hard-stops, Rx med contraindications, pregnancy/virilization alerts, synergies, and Adult UL totals.',
    inputSchema: {
      type: 'object',
      required: ['memberId'],
      properties: {
        memberId: { type: 'string' },
        stackId: { type: 'string' },
        items: { type: 'array', items: { type: 'object' } },
        whatIfCompounds: { type: 'array' },
      },
    },
  },
  {
    name: 'suggest_stack_schedule',
    scope: 'read',
    description: 'Compute deterministic dual-track Systemic (8-slot + weekly grid) and Dermatology (AM/PM layering + skin cycling + Hair/Scalp) schedule.',
    inputSchema: {
      type: 'object',
      required: ['memberId'],
      properties: {
        memberId: { type: 'string' },
        stackId: { type: 'string' },
        dateKey: { type: 'string', description: 'YYYY-MM-DD' },
        haveOnly: { type: 'boolean' },
        whatIfCompounds: { type: 'array' },
      },
    },
  },
  {
    name: 'get_today_schedule',
    scope: 'read',
    description: 'Fetch today’s spread schedule for a specific household member.',
    inputSchema: {
      type: 'object',
      required: ['memberId'],
      properties: {
        memberId: { type: 'string' },
        stackId: { type: 'string' },
        dateKey: { type: 'string' },
      },
    },
  },
  {
    name: 'list_proposals',
    scope: 'read',
    description: 'List pending or resolved AI compound/stack proposals in the Proposals Inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'dismissed'] },
        type: { type: 'string' },
        memberId: { type: 'string' },
      },
    },
  },

  // PROPOSE TOOLS (4)
  {
    name: 'create_or_propose_compound',
    scope: 'propose',
    description: 'Create an AI-researched compound profile (lands as ai_draft or pending proposal per household policy). Returns actionable missingFields on validation errors and existingCompoundId on duplicates.',
    inputSchema: {
      type: 'object',
      required: ['compound'],
      properties: {
        compound: { type: 'object', description: 'Canonical CompoundProfile payload' },
      },
    },
  },
  {
    name: 'enrich_compound',
    scope: 'propose',
    description: 'Enrich an existing compound profile with missing research fields. Edits to verified profiles are automatically routed to Proposals Inbox without silent overwrite.',
    inputSchema: {
      type: 'object',
      required: ['compoundId', 'patch'],
      properties: {
        compoundId: { type: 'string' },
        patch: { type: 'object' },
        rationale: { type: 'string' },
        provenance: { type: 'object' },
      },
    },
  },
  {
    name: 'update_compound_ownership',
    scope: 'propose',
    description: 'Update shared (household) or personal (member:<id>) ownership status (have, dont_have, wishlist, low_stock, ordered) and inventory metadata.',
    inputSchema: {
      type: 'object',
      required: ['compoundId', 'status'],
      properties: {
        compoundId: { type: 'string' },
        scope: { type: 'string', description: 'household or member:<id>' },
        status: { type: 'string', enum: ['have', 'dont_have', 'wishlist', 'low_stock', 'ordered'] },
        quantity: { type: 'number' },
        unit: { type: 'string' },
        remainingDoses: { type: 'number' },
        vendor: { type: 'string' },
        expiryDate: { type: 'string' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'propose_stack_change',
    scope: 'propose',
    description: 'Propose adding, updating, or removing compounds on a member stack (routed cleanly to Proposals Inbox for household approval).',
    inputSchema: {
      type: 'object',
      required: ['memberId'],
      properties: {
        memberId: { type: 'string' },
        stackId: { type: 'string' },
        changes: { type: 'object', description: '{ add?: StackItem[], remove?: string[], items?: StackItem[] }' },
        rationale: { type: 'string' },
        provenance: { type: 'object' },
      },
    },
  },

  // WRITE TOOLS (2)
  {
    name: 'configure_section',
    scope: 'write',
    description: 'Configure a section’s customFields, subsections, hiddenOptionalFields, or aiResearchPrompt (write scope required).',
    inputSchema: {
      type: 'object',
      required: ['sectionId', 'patch'],
      properties: {
        sectionId: { type: 'string' },
        patch: { type: 'object' },
      },
    },
  },
  {
    name: 'resolve_proposal',
    scope: 'write',
    description: 'Approve (with optional edits) or dismiss a pending proposal in the Proposals Inbox (write scope required).',
    inputSchema: {
      type: 'object',
      required: ['proposalId', 'action'],
      properties: {
        proposalId: { type: 'string' },
        action: { type: 'string', enum: ['approve', 'dismiss'] },
        edits: { type: 'object' },
      },
    },
  },
];

const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// 5 Canonical MCP Resource Templates + 3 Canonical Prompts
// ---------------------------------------------------------------------------

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'hub://overview',
    name: 'Household Overview',
    description: 'Household settings, members, section summaries, and pending proposal counts.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'hub://sections',
    name: 'Health Sections & Custom Schemas',
    description: 'All core and custom sections with customFields and AI research prompts.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'hub://compounds/{id}',
    name: 'Compound Profile',
    description: 'Full researched compound profile including pharmacology, dosages, interactions, and citations.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'hub://members/{memberId}/stack',
    name: 'Member Stack',
    description: 'Per-member cross-section stacks (isolated per spouse).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'hub://members/{memberId}/schedule',
    name: 'Member Spread Schedule',
    description: 'Computed deterministic dual-track Systemic + Dermatology spread schedule.',
    mimeType: 'application/json',
  },
];

const PROMPT_DEFINITIONS = [
  {
    name: 'research_compound',
    description: 'Generate a strict schema-aware research prompt for adding a new substance to a section.',
    arguments: [
      { name: 'compoundName', description: 'Name of the substance to research', required: true },
      { name: 'sectionId', description: 'Target section ID (peptides, peds, vitamins_supplements, dermatology)', required: true },
    ],
  },
  {
    name: 'review_stack_safety',
    description: 'Review a household member’s active stack for hard-stops, Rx interactions, UL limits, and monitoring labs.',
    arguments: [
      { name: 'memberId', description: 'Household member ID (e.g. member_wife or member_husband)', required: true },
      { name: 'stackId', description: 'Optional specific stack ID', required: false },
    ],
  },
  {
    name: 'optimize_daily_schedule',
    description: 'Review and optimize a member’s dual-track daily Systemic + Dermatology schedule around their routine anchors.',
    arguments: [
      { name: 'memberId', description: 'Household member ID', required: true },
      { name: 'dateKey', description: 'Optional YYYY-MM-DD date', required: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Helpers
// ---------------------------------------------------------------------------

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcErr(id, code, message, data = undefined) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function toolJsonResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool Execution Dispatcher
// ---------------------------------------------------------------------------

async function executeToolCall(name, rawArgs, service, auth) {
  const toolDef = TOOL_MAP.get(name);
  if (!toolDef) {
    return { rpcError: { code: -32602, message: `Unknown MCP tool "${name}".` } };
  }
  if (!hasScope(auth, toolDef.scope)) {
    return {
      rpcError: {
        code: -32003,
        message: `Forbidden: tool "${name}" requires "${toolDef.scope}" scope (token has "${auth.scope}").`,
        data: { requiredScope: toolDef.scope, tokenScope: auth.scope, httpStatus: 403 },
      },
    };
  }

  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  try {
    switch (name) {
      case 'get_hub_overview': {
        const overview = await service.getHousehold();
        return { result: toolJsonResult(overview) };
      }
      case 'list_sections': {
        const sections = await service.listSections();
        return { result: toolJsonResult({ sections }) };
      }
      case 'get_section_schema': {
        const sid = args.sectionId || args.id || args.section;
        if (!sid) throw new HubError(422, 'REQUIRED', 'sectionId is required.');
        const section = await service.getSection(sid);
        return { result: toolJsonResult({ section, schema: section.schema }) };
      }
      case 'search_compounds': {
        const compounds = await service.listCompounds({
          q: args.q ?? args.query,
          section: args.section ?? args.sectionId,
          ownership: args.ownership,
          member: args.member ?? args.memberId,
          inStack: args.inStack,
          route: args.route,
          slot: args.slot,
          status: args.status,
          evidenceTier: args.evidenceTier,
          tag: args.tag,
        });
        return { result: toolJsonResult({ compounds, count: compounds.length }) };
      }
      case 'get_compound': {
        const cid = args.compoundId || args.id;
        if (!cid) throw new HubError(422, 'REQUIRED', 'compoundId is required.');
        const compound = await service.getCompound(cid);
        return { result: toolJsonResult({ compound }) };
      }
      case 'check_duplicate_compound': {
        const dup = await service.checkDuplicate(args.compound || args);
        return { result: toolJsonResult(dup) };
      }
      case 'create_or_propose_compound': {
        const payload = args.compound || args.profile || args.payload || args.data || args;
        const created = await service.createCompound(payload, auth, { isAi: true });
        return { result: toolJsonResult(created) };
      }
      case 'enrich_compound': {
        const cid = args.compoundId || args.id;
        if (!cid) throw new HubError(422, 'REQUIRED', 'compoundId is required.');
        const patch = args.patch || args.updates || args.fields || args.changes || args.data || (() => {
          const { compoundId: _c, id: _i, rationale: _r, provenance: _p, ...rest } = args;
          return rest;
        })();
        const enriched = await service.enrichCompound(cid, patch, auth, {
          rationale: args.rationale || '',
          provenance: args.provenance || null,
        });
        return { result: toolJsonResult(enriched) };
      }
      case 'update_compound_ownership': {
        const cid = args.compoundId || args.id;
        if (!cid) throw new HubError(422, 'REQUIRED', 'compoundId is required.');
        const ownPatch = args.ownership || args;
        const updated = await service.upsertOwnership(cid, ownPatch, auth);
        return { result: toolJsonResult({ ownership: updated }) };
      }
      case 'configure_section': {
        const sid = args.sectionId || args.id || args.section;
        if (!sid) throw new HubError(422, 'REQUIRED', 'sectionId is required.');
        const patch = args.patch || args.updates || args.config || args.changes || (() => {
          const { sectionId: _s, id: _i, section: _sec, ...rest } = args;
          return rest;
        })();
        const updated = await service.updateSection(sid, patch, auth);
        return { result: toolJsonResult({ section: updated }) };
      }
      case 'get_member_stack': {
        const mid = args.memberId || args.member;
        if (!mid) throw new HubError(422, 'REQUIRED', 'memberId is required.');
        const stacks = await service.listMemberStacks(mid);
        const active = args.stackId ? stacks.find((s) => s.id === args.stackId) : stacks.find((s) => s.active !== false) || stacks[0] || null;
        return { result: toolJsonResult({ memberId: mid, stacks, activeStack: active }) };
      }
      case 'propose_stack_change': {
        const proposal = await service.proposeStackChange(args, auth);
        return { result: toolJsonResult({ status: 'proposed', proposal }) };
      }
      case 'analyze_stack_interactions': {
        const mid = args.memberId || args.member;
        if (!mid) throw new HubError(422, 'REQUIRED', 'memberId is required.');
        const analysis = await service.computeStackInteractions(mid, args.stackId || null, {
          items: args.items,
          whatIfCompounds: args.whatIfCompounds,
        });
        return { result: toolJsonResult(analysis) };
      }
      case 'suggest_stack_schedule': {
        const mid = args.memberId || args.member;
        if (!mid) throw new HubError(422, 'REQUIRED', 'memberId is required.');
        const spread = await service.computeStackSchedule(mid, args.stackId || null, {
          dateKey: args.dateKey,
          haveOnly: args.haveOnly,
          whatIfCompounds: args.whatIfCompounds,
        });
        return { result: toolJsonResult(spread) };
      }
      case 'get_today_schedule': {
        const mid = args.memberId || args.member;
        if (!mid) throw new HubError(422, 'REQUIRED', 'memberId is required.');
        const spread = await service.computeStackSchedule(mid, args.stackId || null, {
          dateKey: args.dateKey || dkToday('UTC'),
        });
        return { result: toolJsonResult(spread) };
      }
      case 'list_proposals': {
        const proposals = await service.listProposals({
          status: args.status,
          type: args.type,
          memberId: args.memberId,
        });
        return { result: toolJsonResult({ proposals, count: proposals.length }) };
      }
      case 'resolve_proposal': {
        const pid = args.proposalId || args.id;
        const action = args.action || args.decision || args.resolution;
        if (!pid || !action) throw new HubError(422, 'REQUIRED', 'proposalId and action are required.');
        const resolved = await service.resolveProposal(
          pid,
          { action, edits: args.edits || args.modifications || null },
          auth,
        );
        return { result: toolJsonResult(resolved) };
      }
      default:
        return { rpcError: { code: -32601, message: `Tool "${name}" is not implemented.` } };
    }
  } catch (err) {
    if (err instanceof HubError) {
      return {
        result: toolJsonResult(
          {
            error: err.code,
            status: err.status,
            message: err.message,
            ...(err.details && typeof err.details === 'object' ? err.details : {}),
          },
          true,
        ),
      };
    }
    return { rpcError: { code: -32603, message: err?.message || 'Internal tool error' } };
  }
}

// ---------------------------------------------------------------------------
// Resources & Prompts Dispatchers
// ---------------------------------------------------------------------------

async function handleResourceRead(uri, service) {
  if (!uri || typeof uri !== 'string') {
    throw new HubError(400, 'INVALID_URI', 'Resource uri is required.');
  }
  if (uri === 'hub://overview') {
    const data = await service.getHousehold();
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  if (uri === 'hub://sections') {
    const sections = await service.listSections();
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ sections }, null, 2) }] };
  }
  const cmpMatch = /^hub:\/\/compounds\/([^/]+)$/.exec(uri);
  if (cmpMatch) {
    const compound = await service.getCompound(decodeURIComponent(cmpMatch[1]));
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ compound }, null, 2) }] };
  }
  const stackMatch = /^hub:\/\/members\/([^/]+)\/stack$/.exec(uri);
  if (stackMatch) {
    const memberId = decodeURIComponent(stackMatch[1]);
    const stacks = await service.listMemberStacks(memberId);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ memberId, stacks }, null, 2) }] };
  }
  const schedMatch = /^hub:\/\/members\/([^/]+)\/schedule$/.exec(uri);
  if (schedMatch) {
    const memberId = decodeURIComponent(schedMatch[1]);
    const spread = await service.computeStackSchedule(memberId, null, { dateKey: dkToday('UTC') });
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(spread, null, 2) }] };
  }
  throw new HubError(404, 'RESOURCE_NOT_FOUND', `Unknown MCP resource URI "${uri}".`);
}

async function handlePromptGet(name, args, service) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'research_compound') {
    const compoundName = a.compoundName || a.compound || a.name || 'Target Compound';
    const sectionId = a.sectionId || a.section || 'peptides';
    const promptObj = await service.buildResearchPrompt({ compoundName, sectionId });
    return {
      description: `Research prompt for ${compoundName} (${sectionId})`,
      messages: [{ role: 'user', content: { type: 'text', text: promptObj.prompt } }],
    };
  }
  if (name === 'review_stack_safety') {
    const memberId = a.memberId || a.member || 'member_wife';
    const analysis = await service.computeStackInteractions(memberId, a.stackId || null);
    const text = `Review stack safety for household member "${memberId}". Emphasize any hard-stops, Rx interactions, teratogenicity/virilization flags, Adult UL breaches, and recommended monitoring labs.\n\nCurrent Interaction Analysis JSON:\n${JSON.stringify(analysis, null, 2)}`;
    return {
      description: `Safety review prompt for ${memberId}`,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  }
  if (name === 'optimize_daily_schedule') {
    const memberId = a.memberId || a.member || 'member_wife';
    const spread = await service.computeStackSchedule(memberId, a.stackId || null, {
      dateKey: a.dateKey || dkToday('UTC'),
    });
    const text = `Optimize the daily Systemic + Dermatology schedule for "${memberId}" based on their routine anchors, conflict separation, synergy co-location, and skin-cycling nights.\n\nCurrent Spread Schedule JSON:\n${JSON.stringify(spread, null, 2)}`;
    return {
      description: `Schedule optimization prompt for ${memberId}`,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  }
  throw new HubError(404, 'PROMPT_NOT_FOUND', `Unknown MCP prompt "${name}".`);
}

// ---------------------------------------------------------------------------
// Single JSON-RPC Message Processor
// ---------------------------------------------------------------------------

async function processSingleRpc(msg, service, auth, sessionState) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcErr(msg?.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0" and method must be a string.');
  }

  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // Notification -> no JSON-RPC response body
  }

  if (method === 'initialize') {
    const reqVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
    const negotiated = SUPPORTED_PROTOCOLS.has(reqVersion) ? reqVersion : '2025-06-18';
    if (!sessionState.sessionId) {
      sessionState.sessionId = `mcp_${randomToken(16)}`;
    }
    return rpcOk(id, {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: {
        name: 'home-pharmacy-mcp',
        version: HUB_VERSION,
      },
      instructions:
        'Home Pharmacy Universal Household Health Hub. Always call get_section_schema and check_duplicate_compound before create_or_propose_compound. Never overwrite verified profiles directly.',
    });
  }

  if (method === 'ping') {
    return rpcOk(id, {});
  }

  if (method === 'tools/list') {
    const visibleTools = TOOL_DEFINITIONS.filter((t) => hasScope(auth, t.scope)).map(
      ({ scope: _s, ...tool }) => tool,
    );
    return rpcOk(id, { tools: visibleTools });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    if (typeof toolName !== 'string' || !toolName.trim()) {
      return rpcErr(id, -32602, 'Invalid params: tools/call requires string "name".');
    }
    const exec = await executeToolCall(toolName, params?.arguments || {}, service, auth);
    if (exec.rpcError) {
      return rpcErr(id, exec.rpcError.code, exec.rpcError.message, exec.rpcError.data);
    }
    return rpcOk(id, exec.result);
  }

  if (method === 'resources/list') {
    const state = await service.loadState();
    const resources = [
      { uri: 'hub://overview', name: 'Household Overview', mimeType: 'application/json' },
      { uri: 'hub://sections', name: 'Health Sections', mimeType: 'application/json' },
      ...state.members.flatMap((m) => [
        { uri: `hub://members/${m.id}/stack`, name: `${m.name} Stack`, mimeType: 'application/json' },
        { uri: `hub://members/${m.id}/schedule`, name: `${m.name} Schedule`, mimeType: 'application/json' },
      ]),
      ...state.compounds.slice(0, 50).map((c) => ({
        uri: `hub://compounds/${c.id}`,
        name: c.name,
        mimeType: 'application/json',
      })),
    ];
    return rpcOk(id, { resources });
  }

  if (method === 'resources/templates/list') {
    return rpcOk(id, { resourceTemplates: RESOURCE_TEMPLATES });
  }

  if (method === 'resources/read') {
    try {
      const result = await handleResourceRead(params?.uri, service);
      return rpcOk(id, result);
    } catch (err) {
      if (err instanceof HubError) {
        return rpcErr(id, err.status === 404 ? -32002 : -32602, err.message);
      }
      return rpcErr(id, -32603, err?.message || 'Resource read failed');
    }
  }

  if (method === 'prompts/list') {
    return rpcOk(id, { prompts: PROMPT_DEFINITIONS });
  }

  if (method === 'prompts/get') {
    try {
      const result = await handlePromptGet(params?.name, params?.arguments || {}, service);
      return rpcOk(id, result);
    } catch (err) {
      if (err instanceof HubError) {
        return rpcErr(id, -32602, err.message);
      }
      return rpcErr(id, -32603, err?.message || 'Prompt get failed');
    }
  }

  if (isNotification) return null;
  return rpcErr(id, -32601, `Method not found: "${method}".`);
}

// ---------------------------------------------------------------------------
// HTTP Route Entrypoint (`POST /mcp`, `GET /mcp`, `DELETE /mcp`)
// ---------------------------------------------------------------------------

export async function handleMcpRequest(request, env, service, auth, corsHeaders) {
  const origin = getRequestOrigin(request, env);
  if (!auth?.authenticated) {
    return unauthorizedResponse({
      origin,
      isMcp: true,
      corsHeaders,
      message: 'Valid OAuth 2.1 Bearer token or Household API Key is required for /mcp.',
    });
  }

  const method = request.method.toUpperCase();
  const incomingSessionId = request.headers.get('mcp-session-id') || null;
  const sessionState = { sessionId: incomingSessionId };

  if (method === 'DELETE') {
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }

  if (method === 'GET') {
    return jsonResponse(
      {
        name: 'home-pharmacy-mcp',
        version: HUB_VERSION,
        transport: 'streamable-http',
        endpoint: `${origin}/mcp`,
        protocols: [...SUPPORTED_PROTOCOLS],
        scope: auth.scope,
      },
      { status: 200, corsHeaders },
    );
  }

  if (method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405, corsHeaders });
  }

  let parsed;
  try {
    const raw = await request.text();
    parsed = JSON.parse(raw);
  } catch {
    return jsonResponse(
      rpcErr(null, -32700, 'Parse error: request body is not valid JSON.'),
      { status: 200, corsHeaders },
    );
  }

  const extraHeaders = {};

  // Batch JSON-RPC 2.0
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return jsonResponse(
        rpcErr(null, -32600, 'Invalid Request: empty JSON-RPC batch.'),
        { status: 200, corsHeaders },
      );
    }
    const responses = [];
    for (const item of parsed) {
      const res = await processSingleRpc(item, service, auth, sessionState);
      if (res !== null) responses.push(res);
    }
    if (sessionState.sessionId) extraHeaders['Mcp-Session-Id'] = sessionState.sessionId;
    if (responses.length === 0) {
      return new Response(null, {
        status: 202,
        headers: { 'Cache-Control': 'no-store', ...corsHeaders, ...extraHeaders },
      });
    }
    return jsonResponse(responses, { status: 200, headers: extraHeaders, corsHeaders });
  }

  // Single JSON-RPC 2.0
  const response = await processSingleRpc(parsed, service, auth, sessionState);
  if (sessionState.sessionId) extraHeaders['Mcp-Session-Id'] = sessionState.sessionId;
  if (response === null) {
    return new Response(null, {
      status: 202,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders, ...extraHeaders },
    });
  }
  return jsonResponse(response, { status: 200, headers: extraHeaders, corsHeaders });
}
