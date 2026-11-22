import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  KeyRound,
  Check,
  X,
  Copy,
  FileJson,
  Trash2,
  Bot,
  History,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { API_TOKEN_SCOPES } from '../../core/index.js';
import { api, getApiBaseUrl } from '../lib/api.js';

function buildFallbackPromptText(compoundName, section) {
  const name = (compoundName || 'Example Compound').trim();
  const secId = section?.id || 'peptides';
  const secName = section?.name || secId;
  return [
    `Research "${name}" for the "${secName}" (${secId}) section of Home Pharmacy.`,
    section?.aiResearchPrompt ? `\nSection Instructions: ${section.aiResearchPrompt}` : '',
    `\nReturn ONLY a single valid JSON object matching the canonical Home Pharmacy Compound Profile schema with fields:`,
    `- name, aliases[], sectionId ("${secId}"), subsection, tags[]`,
    `- summary, detailedDescription, mechanismOfAction, useCaseScenarios[], benefits[]`,
    `- timingRules { preferredSlots[], avoidSlots[], foodState, workoutRelation, circadianEffect, timingNotes }`,
    `- halfLife { valueHours, minHours, maxHours, displayText, route, kind, sourceUrl }`,
    `- dosages { rangeText, defaultAmount, defaultUnit, route, frequencyText, femaleDoseNote, maleDoseNote, maxCeiling }`,
    `- cycles { patternText, cycleDays, offDays, continuous, washoutNote }`,
    `- doNotPairWith [{ targetType, targetRef, severity, separationHours, mechanism, recommendation }]`,
    `- synergies[], contraindications[], sideEffects[], monitoringLabs[], storageNotes`,
    `- sectionData {}, customFields {}, provenance { sourceModel, evidenceTier, confidence, citations[] }`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function AiHubView({
  sections,
  proposals,
  activeMemberId,
  onRefresh,
}) {
  const [keys, setKeys] = useState([]);
  const [oauthClients, setOauthClients] = useState([]);
  const [auditLog, setAuditLog] = useState([]);

  // Proposals state
  const [proposalMsg, setProposalMsg] = useState('');
  const [proposalErr, setProposalErr] = useState('');

  // Prompt builder modal
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptCompoundName, setPromptCompoundName] = useState('');
  const [promptSectionId, setPromptSectionId] = useState('peptides');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);

  // JSON paste importer
  const [jsonInput, setJsonInput] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  // API key minting
  const [keyName, setKeyName] = useState('');
  const [keyScope, setKeyScope] = useState('propose');
  const [mintedSecret, setMintedSecret] = useState(null);
  const [keyError, setKeyError] = useState('');
  const [minting, setMinting] = useState(false);

  // Context MD copy
  const [contextMsg, setContextMsg] = useState('');
  const [contextPreview, setContextPreview] = useState('');

  const origin = getApiBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
  const pendingProposals = (proposals || []).filter((p) => p.status === 'pending');

  const loadAiMeta = async () => {
    try {
      const [kRes, cRes, aRes] = await Promise.all([
        api.get('/api/v1/keys'),
        api.get('/api/v1/oauth/clients'),
        api.get('/api/v1/audit-log'),
      ]);
      setKeys(kRes.json?.keys || []);
      setOauthClients(cRes.json?.clients || []);
      setAuditLog((aRes.json?.auditLog || aRes.json?.entries || []).slice(0, 20));
    } catch {
      // Ignore secondary metadata fetch failure (e.g., read-only or offline)
    }
  };

  useEffect(() => {
    loadAiMeta();
  }, []);

  const handleResolveProposal = async (proposalId, action) => {
    setProposalErr('');
    setProposalMsg('');
    try {
      await api.post(`/api/v1/proposals/${encodeURIComponent(proposalId)}/resolve`, { action });
      setProposalMsg(`Proposal ${action === 'approve' ? 'approved and applied' : 'dismissed'}.`);
      await onRefresh();
      await loadAiMeta();
    } catch (err) {
      setProposalErr(err.message || `Failed to ${action} proposal.`);
    }
  };

  const openPromptBuilder = () => {
    const sec = (sections || []).find((s) => s.id === promptSectionId) || (sections || [])[0];
    setGeneratedPrompt(buildFallbackPromptText(promptCompoundName || 'BPC-157', sec));
    setShowPromptModal(true);
  };

  const handleGeneratePrompt = async (e) => {
    e.preventDefault();
    const targetName = promptCompoundName.trim() || 'BPC-157';
    setPromptLoading(true);
    try {
      const res = await api.post('/api/v1/ai/research-prompt', {
        name: targetName,
        sectionId: promptSectionId,
      });
      setGeneratedPrompt(res.json?.prompt || buildFallbackPromptText(targetName, sections.find((s) => s.id === promptSectionId)));
    } catch {
      setGeneratedPrompt(buildFallbackPromptText(targetName, sections.find((s) => s.id === promptSectionId)));
    } finally {
      setPromptLoading(false);
    }
  };

  const handleImportAiJson = async () => {
    setImportError('');
    setImportStatus('');
    const raw = jsonInput.trim();
    if (!raw) {
      setImportError('Please paste a valid JSON compound profile before importing.');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      setImportError(`Invalid JSON syntax: ${err.message}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setImportError('Invalid JSON payload: expected a compound profile JSON object.');
      return;
    }

    if (!parsed.name || !String(parsed.name).trim() || !parsed.sectionId || !String(parsed.sectionId).trim()) {
      setImportError('Validation error: required fields "name" and "sectionId" must be provided.');
      return;
    }

    setImporting(true);
    try {
      const res = await api.post('/api/v1/compounds', parsed);
      setJsonInput('');
      const createdName = res.json?.compound?.name || parsed.name;
      setImportStatus(
        res.status === 202
          ? `Held "${createdName}" in Proposals Inbox for review.`
          : `Imported "${createdName}" into catalog successfully.`,
      );
      await onRefresh();
      await loadAiMeta();
    } catch (err) {
      setImportError(err.message || 'Validation failed while importing AI JSON compound.');
    } finally {
      setImporting(false);
    }
  };

  const handleMintKey = async (e) => {
    e.preventDefault();
    setKeyError('');
    setMintedSecret(null);
    const cleanName = keyName.trim() || `AI ${keyScope} Key`;
    setMinting(true);
    try {
      const res = await api.post('/api/v1/keys', {
        name: cleanName,
        scope: keyScope,
      });
      const secret = res.json?.secret || res.json?.rawKey || '';
      setMintedSecret({
        name: res.json?.name || cleanName,
        scope: res.json?.scope || keyScope,
        secret,
      });
      setKeyName('');
      await loadAiMeta();
    } catch (err) {
      setKeyError(err.message || 'Failed to mint scoped API key.');
    } finally {
      setMinting(false);
    }
  };

  const handleRevokeKey = async (keyId) => {
    setKeyError('');
    try {
      await api.del(`/api/v1/keys/${encodeURIComponent(keyId)}`);
      await loadAiMeta();
    } catch (err) {
      setKeyError(err.message || 'Failed to revoke API key.');
    }
  };

  const handleRevokeOAuth = async (clientId) => {
    try {
      await api.del(`/api/v1/oauth/clients/${encodeURIComponent(clientId)}`);
      await loadAiMeta();
    } catch {
      // ignore
    }
  };

  const handleCopyContextMd = async () => {
    setContextMsg('');
    try {
      const res = await api.get(`/api/v1/export/context.md?member=${encodeURIComponent(activeMemberId)}`, {
        rawText: true,
      });
      const md = res.text || '';
      setContextPreview(md);
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(md);
        }
      } catch {
        // Clipboard permission unavailable in headless context; preview is shown below
      }
      setContextMsg('Copied portable Markdown AI context bundle (zero secrets included).');
    } catch (err) {
      setContextMsg(err.message || 'Failed to export Markdown context bundle.');
    }
  };

  return (
    <div className="stack-v">
      <div className="space-between">
        <div>
          <h1 style={{ margin: 0, fontSize: '1.45rem' }}>Universal Multi-AI Hub</h1>
          <p className="muted" style={{ margin: '0.2rem 0 0' }}>
            Review AI-proposed compounds, build schema-strict research prompts, import AI JSON, mint scoped API keys, and connect Gemini, Claude, Grok Bot, ChatGPT/GPT, and Meta Muse.
          </p>
        </div>
        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-open-ai-prompt-builder"
            onClick={openPromptBuilder}
          >
            <Sparkles size={14} /> AI Research Prompt Builder
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-copy-context-md"
            onClick={handleCopyContextMd}
          >
            <Copy size={14} /> Copy Context MD
          </button>
        </div>
      </div>

      {contextMsg ? (
        <div className="banner-ok" role="status">
          {contextMsg}
        </div>
      ) : null}

      {contextPreview ? (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--gold)' }}>
            Preview Portable Context Bundle ({contextPreview.length} chars)
          </summary>
          <pre className="code-block" style={{ marginTop: '0.6rem', maxHeight: 240 }}>
            {contextPreview}
          </pre>
        </details>
      ) : null}

      {/* 1. AI Proposals Inbox */}
      <section className="card stack-v" data-testid="ai-proposals-list">
        <div className="space-between">
          <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
            AI Proposals Inbox ({pendingProposals.length} pending)
          </h2>
        </div>

        {proposalMsg ? (
          <div className="banner-ok" role="status">
            {proposalMsg}
          </div>
        ) : null}
        {proposalErr ? (
          <div className="banner-danger" role="alert">
            {proposalErr}
          </div>
        ) : null}

        {pendingProposals.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No pending AI proposals. Edits to human-verified profiles and held AI drafts will appear here for 1-click approval.
          </p>
        ) : (
          <div className="stack-v">
            {pendingProposals.map((p) => (
              <div
                key={p.id}
                className="slot-card stack-v"
                style={{ gap: '0.5rem' }}
              >
                <div className="space-between">
                  <div>
                    <strong>{p.summary || p.proposedPayload?.name || p.type}</strong>
                    <div className="muted" style={{ fontSize: '0.8rem' }}>
                      Type: {p.type} • Source: {p.sourceModel || p.actor || 'ai'} • Status: {p.status}
                    </div>
                  </div>
                  <div className="row-wrap">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-testid={`btn-approve-proposal-${p.id}`}
                      onClick={() => handleResolveProposal(p.id, 'approve')}
                    >
                      <Check size={14} /> Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      data-testid={`btn-dismiss-proposal-${p.id}`}
                      onClick={() => handleResolveProposal(p.id, 'dismiss')}
                    >
                      <X size={14} /> Dismiss
                    </button>
                  </div>
                </div>
                {p.proposedPayload?.name || p.proposedPatch ? (
                  <pre className="code-block" style={{ margin: 0, maxHeight: 140 }}>
                    {JSON.stringify(p.proposedPayload || p.proposedPatch, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. AI JSON Paste Importer */}
      <section className="card stack-v">
        <div className="row-wrap">
          <FileJson size={17} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
            Import AI-Researched Compound JSON
          </h2>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Paste JSON generated by Gemini, Claude, Grok, ChatGPT, or Muse using the Research Prompt Builder to validate and save into your catalog.
        </p>
        {importError ? (
          <div className="banner-danger" role="alert">
            <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {importError}
          </div>
        ) : null}
        {importStatus ? (
          <div className="banner-ok" role="status">
            <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {importStatus}
          </div>
        ) : null}
        <label className="field-label">
          Compound Profile JSON
          <textarea
            data-testid="ai-json-import-textarea"
            rows={6}
            placeholder='{"name": "Semax", "sectionId": "peptides", "summary": "...", ...}'
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
          />
        </label>
        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="btn-import-ai-json"
            disabled={importing}
            onClick={handleImportAiJson}
          >
            {importing ? 'Validating & Importing…' : 'Validate & Import JSON'}
          </button>
        </div>
      </section>

      {/* 3. Scoped API Keys & OAuth Clients */}
      <section className="card stack-v">
        <div className="row-wrap">
          <KeyRound size={17} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
            Scoped API Keys & Connected OAuth 2.1 Clients
          </h2>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Keys are hashed at rest (SHA-256) and raw secrets are displayed only once upon creation.
        </p>

        {keyError ? (
          <div className="banner-danger" role="alert">
            {keyError}
          </div>
        ) : null}

        {mintedSecret ? (
          <div className="banner-ok stack-v" role="status">
            <strong>
              New API Key Minted ({mintedSecret.name} — scope: {mintedSecret.scope}) — Copy now, shown ONCE:
            </strong>
            <input
              type="text"
              readOnly
              aria-label="Minted API Key Secret"
              value={mintedSecret.secret}
              onFocus={(e) => e.target.select()}
            />
            <code className="code-block">{mintedSecret.secret}</code>
          </div>
        ) : null}

        <form onSubmit={handleMintKey} className="row-wrap" style={{ alignItems: 'flex-end' }}>
          <label className="field-label" style={{ flex: '1 1 200px' }}>
            Key Name
            <input
              type="text"
              name="keyName"
              placeholder="e.g., Claude Pro Key, Grok Bot"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
          </label>
          <label className="field-label" style={{ minWidth: 150 }}>
            Scope
            <select name="scope" aria-label="API Key Scope" value={keyScope} onChange={(e) => setKeyScope(e.target.value)}>
              {API_TOKEN_SCOPES.map((sc) => (
                <option key={sc} value={sc}>
                  {sc}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="btn-mint-api-key"
            disabled={minting}
          >
            <KeyRound size={14} /> {minting ? 'Minting…' : 'Mint API Key'}
          </button>
        </form>

        {keys.length > 0 ? (
          <div className="stack-v">
            {keys.map((k) => (
              <div key={k.id} className="slot-card space-between">
                <div>
                  <strong>{k.name}</strong>{' '}
                  <span className="pill">{k.scope}</span>
                  <div className="muted" style={{ fontSize: '0.78rem' }}>
                    Prefix: <code>{k.prefix || 'hp_key_...'}</code> • Created: {k.createdAt ? k.createdAt.slice(0, 10) : '—'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => handleRevokeKey(k.id)}
                >
                  <Trash2 size={13} /> Revoke
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: '0.84rem' }}>
            No named API keys minted yet.
          </p>
        )}

        {oauthClients.length > 0 ? (
          <div className="stack-v" style={{ marginTop: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.96rem' }}>Connected OAuth 2.1 Clients</h3>
            {oauthClients.map((c) => (
              <div key={c.client_id || c.id} className="slot-card space-between">
                <div>
                  <strong>{c.client_name || c.client_id}</strong>
                  <div className="muted" style={{ fontSize: '0.78rem' }}>
                    Client ID: <code>{c.client_id}</code>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => handleRevokeOAuth(c.client_id)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* 4. Five AI Platform Setup Guides */}
      <section className="stack-v">
        <div className="row-wrap">
          <Bot size={18} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--gold)' }}>
            Connect All 5 AI Assistants
          </h2>
        </div>

        <div className="grid-2">
          <article className="card stack-v" data-testid="ai-guide-gemini">
            <h3 style={{ margin: 0, color: 'var(--gold)' }}>Google Gemini</h3>
            <p className="muted" style={{ margin: 0 }}>
              Connect Gemini CLI, Gemini Gems, or AI Studio using Remote Streamable HTTP MCP or OpenAPI / Context Bundle.
            </p>
            <div className="code-block">
              MCP Endpoint: {origin}/mcp{'\n'}
              OAuth Discovery: {origin}/.well-known/oauth-protected-resource{'\n'}
              Context Bundle: Copy Context MD above for Gems/web chat
            </div>
          </article>

          <article className="card stack-v" data-testid="ai-guide-claude">
            <h3 style={{ margin: 0, color: 'var(--gold)' }}>Anthropic Claude</h3>
            <p className="muted" style={{ margin: 0 }}>
              Add a Custom Remote MCP Connector in Claude.ai / Claude Desktop / Claude Code with automatic OAuth 2.1 + PKCE + DCR discovery.
            </p>
            <div className="code-block">
              Connector URL: {origin}/mcp{'\n'}
              Auth: OAuth 2.1 + PKCE (auto-discovered via /.well-known/oauth-authorization-server)
            </div>
          </article>

          <article className="card stack-v" data-testid="ai-guide-grok">
            <h3 style={{ margin: 0, color: 'var(--gold)' }}>xAI Grok Bot</h3>
            <p className="muted" style={{ margin: 0 }}>
              Connect Grok Bot via Remote MCP or REST API v1 using a scoped Bearer API key (<code>propose</code> or <code>read</code>).
            </p>
            <div className="code-block">
              MCP: {origin}/mcp{'\n'}
              REST API: {origin}/api/v1/compounds{'\n'}
              Header: Authorization: Bearer &lt;minted-api-key&gt;
            </div>
          </article>

          <article className="card stack-v" data-testid="ai-guide-gpt">
            <h3 style={{ margin: 0, color: 'var(--gold)' }}>OpenAI ChatGPT / GPT</h3>
            <p className="muted" style={{ margin: 0 }}>
              Connect via Remote MCP (Developer Mode) or import the OpenAPI 3.1.0 schema into Custom GPT Actions with OAuth 2.1 or API Key auth.
            </p>
            <div className="code-block">
              OpenAPI 3.1 Schema: {origin}/openapi.json{'\n'}
              MCP Endpoint: {origin}/mcp
            </div>
          </article>

          <article className="card stack-v" data-testid="ai-guide-muse">
            <h3 style={{ margin: 0, color: 'var(--gold)' }}>Meta Muse</h3>
            <p className="muted" style={{ margin: 0 }}>
              Connect Meta Muse via Remote MCP, OpenAPI connector (<code>/openapi.json</code>), <code>/llms.txt</code> discovery, or portable Context MD + Prompt Builder.
            </p>
            <div className="code-block">
              Discovery: {origin}/llms.txt{'\n'}
              OpenAPI: {origin}/openapi.json{'\n'}
              MCP: {origin}/mcp
            </div>
          </article>
        </div>
      </section>

      {/* 5. Recent Multi-AI Audit Log */}
      {auditLog.length > 0 ? (
        <section className="card stack-v">
          <div className="row-wrap">
            <History size={16} color="var(--gold)" />
            <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--gold)' }}>Recent Audit Trail</h2>
          </div>
          <div className="stack-v" style={{ gap: '0.4rem' }}>
            {auditLog.slice(0, 10).map((entry, idx) => (
              <div key={entry.id || idx} className="muted" style={{ fontSize: '0.82rem' }}>
                <code>{entry.actor || 'system'}</code> • <strong>{entry.action}</strong> — {entry.summary || entry.targetId || ''}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* AI Research Prompt Builder Modal */}
      {showPromptModal ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="AI Research Prompt Builder">
          <div className="modal-card stack-v">
            <div className="space-between">
              <h2 style={{ margin: 0, color: 'var(--gold)' }}>Universal AI Research Prompt Builder</h2>
              <button type="button" className="btn btn-sm" onClick={() => setShowPromptModal(false)}>
                Close
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Generate a schema-strict research prompt including your custom section fields to paste into Gemini, Claude, Grok, ChatGPT, or Muse.
            </p>

            <form onSubmit={handleGeneratePrompt} className="stack-v">
              <div className="grid-2">
                <label className="field-label">
                  Compound Name
                  <input
                    type="text"
                    name="compoundName"
                    placeholder="e.g., Thymosin Beta-4, Tretinoin, Magnesium"
                    value={promptCompoundName}
                    onChange={(e) => setPromptCompoundName(e.target.value)}
                  />
                </label>
                <label className="field-label">
                  Target Section
                  <select value={promptSectionId} onChange={(e) => setPromptSectionId(e.target.value)}>
                    {(sections || []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row-wrap">
                <button type="submit" className="btn btn-primary btn-sm" disabled={promptLoading}>
                  {promptLoading ? 'Generating…' : 'Generate Prompt'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigator.clipboard?.writeText?.(generatedPrompt).catch(() => {})}
                >
                  <Copy size={13} /> Copy Prompt
                </button>
              </div>
            </form>

            <label className="field-label">
              Schema-Strict Research Prompt
              <textarea
                readOnly
                rows={12}
                value={generatedPrompt}
                aria-label="Generated AI Research Prompt"
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
