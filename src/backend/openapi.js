/**
 * Public Zero-PII Discovery Documents: OpenAPI 3.1.0 (`/openapi.json`) & `/llms.txt`
 * for ChatGPT Actions, Meta Muse, Gemini, Claude, and Grok Bot (F27, F28, F45).
 */

import { HUB_VERSION } from '../core/index.js';

export function buildOpenApiSpec(origin) {
  const serverUrl = String(origin || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  return {
    openapi: '3.1.0',
    info: {
      title: 'Home Pharmacy — Universal Household Health Hub API',
      version: HUB_VERSION,
      description:
        'Privacy-first household pharmacology, peptides, PEDs, vitamins/supplements, and dermatology hub with dual-track stack spreading and universal multi-AI access (MCP + OAuth 2.1 + REST). Personal reference tool only — not medical advice.',
    },
    servers: [{ url: serverUrl, description: 'Home Pharmacy Hub Server' }],
    security: [{ BearerAuth: [] }, { OAuth2: ['read', 'propose', 'write'] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Scoped Household API Key or OAuth 2.1 access token.',
        },
        OAuth2: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: `${serverUrl}/oauth/authorize`,
              tokenUrl: `${serverUrl}/oauth/token`,
              scopes: {
                read: 'Read household catalog, sections, stacks, schedules, and proposals',
                propose: 'Read + create AI drafts, enrich compounds, update ownership, and propose stack changes',
                write: 'Full administrative access including section schema changes and proposal approvals',
              },
            },
          },
        },
      },
      schemas: {
        CompoundProfile: {
          type: 'object',
          required: ['name', 'sectionId'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            canonicalMolecule: { type: 'string' },
            aliases: { type: 'array', items: { type: 'string' } },
            sectionId: { type: 'string' },
            subsection: { type: 'string' },
            summary: { type: 'string' },
            detailedDescription: { type: 'string' },
            mechanismOfAction: { type: 'string' },
            useCaseScenarios: { type: 'array', items: { type: 'string' } },
            timingRules: { type: 'object' },
            halfLife: { type: 'object' },
            dosages: { type: 'object' },
            cycles: { type: 'object' },
            doNotPairWith: { type: 'array', items: { type: 'object' } },
            synergies: { type: 'array', items: { type: 'object' } },
            sectionData: { type: 'object' },
            customFields: { type: 'object' },
            profileStatus: { type: 'string', enum: ['verified', 'ai_draft', 'needs_review'] },
            provenance: { type: 'object' },
            completenessPct: { type: 'number' },
          },
        },
        Stack: {
          type: 'object',
          required: ['name', 'items'],
          properties: {
            id: { type: 'string' },
            memberId: { type: 'string' },
            name: { type: 'string' },
            active: { type: 'boolean' },
            haveOnly: { type: 'boolean' },
            items: { type: 'array', items: { type: 'object' } },
          },
        },
        SpreadResult: {
          type: 'object',
          properties: {
            memberId: { type: 'string' },
            stackId: { type: 'string' },
            systemic: { type: 'object' },
            dermatology: { type: 'object' },
            interactions: { type: 'object' },
            stockSummary: { type: 'object' },
            explanations: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Public server health status',
          security: [],
          responses: { '200': { description: 'Healthy' } },
        },
      },
      '/api/v1/household': {
        get: { operationId: 'getHousehold', summary: 'Get household overview and settings', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/household/settings': {
        patch: { operationId: 'updateHouseholdSettings', summary: 'Update household settings & AI write policy', responses: { '200': { description: 'Updated' } } },
      },
      '/api/v1/members': {
        get: { operationId: 'listMembers', summary: 'List household members', responses: { '200': { description: 'OK' } } },
        post: { operationId: 'createMember', summary: 'Add a household member', responses: { '201': { description: 'Created' } } },
      },
      '/api/v1/members/{id}': {
        patch: {
          operationId: 'updateMember',
          summary: 'Update member name, routineAnchors, or safetyContext',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Updated' } },
        },
        delete: {
          operationId: 'deleteMember',
          summary: 'Delete an extensible household member',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted' } },
        },
      },
      '/api/v1/sections': {
        get: { operationId: 'listSections', summary: 'List core & custom health sections', responses: { '200': { description: 'OK' } } },
        post: { operationId: 'createSection', summary: 'Create a custom health section', responses: { '201': { description: 'Created' } } },
      },
      '/api/v1/sections/{id}': {
        get: {
          operationId: 'getSectionSchema',
          summary: 'Get section configuration, customFields, and AI research prompt',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
        patch: {
          operationId: 'configureSection',
          summary: 'Update section custom fields, subsections, or AI research prompt',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Updated' } },
        },
        delete: {
          operationId: 'deleteSection',
          summary: 'Delete an empty custom section',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted' } },
        },
      },
      '/api/v1/compounds': {
        get: {
          operationId: 'searchCompounds',
          summary: 'Search and filter compound profiles across all sections',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'section', in: 'query', schema: { type: 'string' } },
            { name: 'ownership', in: 'query', schema: { type: 'string' } },
            { name: 'member', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'OK' } },
        },
        post: {
          operationId: 'createCompound',
          summary: 'Create a researched compound profile',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CompoundProfile' } } } },
          responses: { '201': { description: 'Created' }, '409': { description: 'Duplicate' }, '422': { description: 'Validation error' } },
        },
      },
      '/api/v1/compounds/check-duplicate': {
        post: { operationId: 'checkDuplicateCompound', summary: 'Check duplicate or sibling variant before creating a compound', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/compounds/{id}': {
        get: {
          operationId: 'getCompound',
          summary: 'Get a single compound profile by ID',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
        },
        patch: {
          operationId: 'updateCompound',
          summary: 'Update compound profile fields',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Updated' } },
        },
        delete: {
          operationId: 'deleteCompound',
          summary: 'Delete compound profile',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted' } },
        },
      },
      '/api/v1/compounds/{id}/verify': {
        post: {
          operationId: 'verifyCompound',
          summary: 'Promote an AI draft compound profile to verified',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Verified' } },
        },
      },
      '/api/v1/ownership': {
        get: { operationId: 'listOwnership', summary: 'List shared & personal ownership records', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/ownership/{compoundId}': {
        put: {
          operationId: 'updateCompoundOwnership',
          summary: 'Upsert shared or member-scoped compound ownership/stock status',
          parameters: [{ name: 'compoundId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Updated' } },
        },
      },
      '/api/v1/members/{memberId}/stacks': {
        get: {
          operationId: 'listMemberStacks',
          summary: 'List stacks for a specific household member',
          parameters: [{ name: 'memberId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
        post: {
          operationId: 'createMemberStack',
          summary: 'Create a cross-section stack for a household member',
          parameters: [{ name: 'memberId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Stack' } } } },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/api/v1/members/{memberId}/stacks/{stackId}/schedule': {
        post: {
          operationId: 'suggestStackSchedule',
          summary: 'Compute deterministic dual-track Systemic + Dermatology spread schedule (supports What-If simulation)',
          parameters: [
            { name: 'memberId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'stackId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'SpreadResult', content: { 'application/json': { schema: { $ref: '#/components/schemas/SpreadResult' } } } } },
        },
      },
      '/api/v1/members/{memberId}/stacks/{stackId}/interactions': {
        post: {
          operationId: 'analyzeStackInteractions',
          summary: 'Analyze bidirectional interactions, hard-stops, synergies, UL limits, and safety context alerts',
          parameters: [
            { name: 'memberId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'stackId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'InteractionAnalysis' } },
        },
      },
      '/api/v1/members/{memberId}/logs': {
        get: { operationId: 'listMemberLogs', summary: 'List member dose logs', parameters: [{ name: 'memberId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
        post: { operationId: 'createMemberLog', summary: 'Log a dose or skip with Advisory Dose-Sanity Gate', parameters: [{ name: 'memberId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Created' } } },
      },
      '/api/v1/members/{memberId}/adherence': {
        get: { operationId: 'getMemberAdherence', summary: 'Get 7/30/90-day adherence stats', parameters: [{ name: 'memberId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/proposals': {
        get: { operationId: 'listProposals', summary: 'List AI & stack change proposals', responses: { '200': { description: 'OK' } } },
        post: { operationId: 'createProposal', summary: 'Submit a change proposal', responses: { '201': { description: 'Created' } } },
      },
      '/api/v1/proposals/{id}/resolve': {
        post: {
          operationId: 'resolveProposal',
          summary: 'Approve (with optional edits) or dismiss a pending proposal',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Resolved' } },
        },
      },
      '/api/v1/export/context.md': {
        get: { operationId: 'exportContextMarkdown', summary: 'Export token-efficient Markdown AI context bundle', responses: { '200': { description: 'Markdown' } } },
      },
      '/api/v1/export/context.json': {
        get: { operationId: 'exportContextJson', summary: 'Export structured JSON AI context bundle', responses: { '200': { description: 'JSON' } } },
      },
      '/api/v1/ai/research-prompt': {
        post: { operationId: 'generateResearchPrompt', summary: 'Generate a schema-aware compound research prompt for any AI', responses: { '200': { description: 'Prompt' } } },
      },
      '/api/v1/seed/starter': {
        post: { operationId: 'seedStarterCatalog', summary: 'Load optional generic non-personal starter reference catalog', responses: { '200': { description: 'Seeded' } } },
      },
    },
  };
}

export function buildLlmsTxt(origin) {
  const base = String(origin || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  return `# Home Pharmacy — Universal Household Health Hub

> Personal reference & scheduling hub for household wellness protocols across 4 sections:
> 1) Peptides, 2) Performance Enhancement Drugs (PEDs), 3) Vitamins & Supplements, and 4) Dermatology (Skin & Hair).
> Notice: Personal reference tool only — not medical advice. This discovery file contains zero personal health records or secrets.

## Universal AI Integration Endpoints
- Remote Streamable HTTP MCP Server: ${base}/mcp (JSON-RPC 2.0, protocols 2025-06-18 & 2024-11-05)
- OAuth 2.1 Protected Resource Metadata: ${base}/.well-known/oauth-protected-resource
- OAuth 2.1 Authorization Server Metadata: ${base}/.well-known/oauth-authorization-server
- OpenAPI 3.1.0 Specification: ${base}/openapi.json
- REST API v1 Base: ${base}/api/v1
- Authenticated Markdown Context Bundle: ${base}/api/v1/export/context.md
- Authenticated JSON Context Bundle: ${base}/api/v1/export/context.json

## Supported AI Platforms
- Claude (Remote MCP + OAuth 2.1 DCR & PKCE S256)
- Gemini (Remote MCP + OAuth 2.1 PKCE or Bearer API Key)
- Grok Bot (Remote MCP + OAuth 2.1 DCR / Bearer + REST API)
- ChatGPT / GPT (Custom GPT Actions via /openapi.json + OAuth 2.1 / CIMD or Bearer)
- Meta Muse (Scoped Bearer API Key + /llms.txt + Context Bundles + MCP/REST)

## Canonical AI Compound Research Workflow
1. Call \`get_section_schema\` (or GET /api/v1/sections/{sectionId}) to fetch section customFields & aiResearchPrompt.
2. Call \`check_duplicate_compound\` before adding a substance to detect aliases or multi-route siblings.
3. Call \`create_or_propose_compound\` with full pharmacology, timingRules, halfLife, dosages, cycles, doNotPairWith, synergies, sectionData, customFields, and valid https:// citations.
4. Use \`analyze_stack_interactions\` and \`suggest_stack_schedule\` for dual-track Systemic + Dermatology spreading.
`;
}
