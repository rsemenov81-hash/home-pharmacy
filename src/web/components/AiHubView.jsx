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

  const [proposalMsg, setProposalMsg] = useState('');
  const [proposalErr, setProposalErr] = useState('');

  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptCompoundName, setPromptCompoundName] = useState('');
  const [promptSectionId, setPromptSectionId] = useState('peptides');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);

  const [jsonInput, setJsonInput] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  const [keyName, setKeyName] = useState('');
  const [keyScope, setKeyScope] = useState('propose');
  const [mintedSecret, setMintedSecret] = useState(null);
  const [keyError, setKeyError] = useState('');
  const [minting, setMinting] = useState(false);

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
      // ignore if read-only or offline
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
      setProposalMsg(`Proposal ${action === 'approve' ? 'approved and saved' : 'dismissed'}.`);
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
      setImportError('Paste a compound JSON profile before importing.');
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
      setImportError('Invalid JSON payload: expected a compound profile object.');
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
          ? `Added “${createdName}” to your review inbox.`
          : `Added “${createdName}” to your library.`,
      );
      await onRefresh();
      await loadAiMeta();
    } catch (err) {
      setImportError(err.message || 'Validation failed while importing JSON.');
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
      setKeyError(err.message || 'Could not create API key.');
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
      setKeyError(err.message || 'Could not revoke key.');
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
        // clipboard unavailable in headless contexts
      }
      setContextMsg('Copied your clean Markdown health context — paste into Gemini, Claude, Grok, ChatGPT, or Muse.');
    } catch (err) {
      setContextMsg(err.message || 'Could not export context.');
    }
  };

  return (
    <div className="stack-v">
      <div className="space-between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">MULTI-AI ASSISTANT HUB</div>
          <h1 className="display-title" style={{ marginTop: 4 }}>Connect Your AIs</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Research new compounds with Gemini, Claude, Grok, ChatGPT, or Muse — and review AI updates in one place.
          </p>
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-open-ai-prompt-builder"
            onClick={openPromptBuilder}
          >
            <Sparkles size={14} /> Research with AI
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-copy-context-md"
            onClick={handleCopyContextMd}
          >
            <Copy size={14} /> Copy Context
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
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--accent)' }}>
            View Copied Context ({contextPreview.length} chars)
          </summary>
          <pre className="code-block" style={{ marginTop: '0.6rem', maxHeight: 220 }}>
            {contextPreview}
          </pre>
        </details>
      ) : null}

      {/* 1. AI Proposals Inbox */}
      <section className="card stack-sm" data-testid="ai-proposals-list">
        <div className="space-between">
          <div>
            <div className="eyebrow">REVIEW QUEUE</div>
            <h2 className="section-heading">AI Proposals ({pendingProposals.length} pending)</h2>
          </div>
        </div>

        {proposalMsg ? <div className="banner-ok" role="status">{proposalMsg}</div> : null}
        {proposalErr ? <div className="banner-danger" role="alert">{proposalErr}</div> : null}

        {pendingProposals.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            All caught up — when an AI proposes a new compound or suggests edits to a verified profile, it appears here for 1-tap approval.
          </p>
        ) : (
          <div className="stack-sm">
            {pendingProposals.map((p) => (
              <div key={p.id} className="slot-card slot-populated stack-sm">
                <div className="space-between">
                  <div>
                    <strong>{p.summary || p.proposedPayload?.name || p.type}</strong>
                    <div className="dim">
                      {p.sourceModel || p.actor || 'AI'} · {p.type.replace(/_/g, ' ')}
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
                  <details>
                    <summary className="dim" style={{ cursor: 'pointer' }}>Inspect proposed fields</summary>
                    <pre className="code-block" style={{ marginTop: 6, maxHeight: 140 }}>
                      {JSON.stringify(p.proposedPayload || p.proposedPatch, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Paste AI JSON */}
      <section className="card stack-sm">
        <div className="row-wrap">
          <FileJson size={16} color="var(--accent)" />
          <div>
            <div className="eyebrow">QUICK IMPORT</div>
            <h2 className="section-heading">Add Compound from AI Reply</h2>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Tap <strong>Research with AI</strong> above, ask your favorite AI to fill out a compound, then paste the JSON reply here.
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
          AI Compound JSON
          <textarea
            data-testid="ai-json-import-textarea"
            rows={4}
            placeholder='{"name": "Semax", "sectionId": "peptides", "summary": "...", ...}'
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
          />
        </label>
        <div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-import-ai-json"
            disabled={importing}
            onClick={handleImportAiJson}
          >
            {importing ? 'Importing…' : 'Import to Library'}
          </button>
        </div>
      </section>

      {/* 3. Five AI Assistants */}
      <section className="stack-sm">
        <div className="row-wrap">
          <Bot size={16} color="var(--accent)" />
          <div>
            <div className="eyebrow">5-AI ECOSYSTEM</div>
            <h2 className="section-heading">Works With Every AI You Use</h2>
          </div>
        </div>

        <div className="grid-3">
          <article className="card stack-sm" data-testid="ai-guide-gemini">
            <div className="space-between">
              <strong style={{ color: 'var(--accent)' }}>Google Gemini</strong>
              <span className="pill">MCP · Gems</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Connect via Remote MCP or paste your Context bundle into a Gemini Gem.
            </p>
            <div className="code-block">{origin}/mcp</div>
          </article>

          <article className="card stack-sm" data-testid="ai-guide-claude">
            <div className="space-between">
              <strong style={{ color: 'var(--accent)' }}>Anthropic Claude</strong>
              <span className="pill">OAuth 2.1 · MCP</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Add as a Custom Connector in Claude.ai or Claude Code with automatic OAuth sign-in.
            </p>
            <div className="code-block">{origin}/mcp</div>
          </article>

          <article className="card stack-sm" data-testid="ai-guide-grok">
            <div className="space-between">
              <strong style={{ color: 'var(--accent)' }}>xAI Grok Bot</strong>
              <span className="pill">MCP · REST</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Connect Grok Bot using a scoped Bearer API key minted below.
            </p>
            <div className="code-block">{origin}/api/v1/compounds</div>
          </article>

          <article className="card stack-sm" data-testid="ai-guide-gpt">
            <div className="space-between">
              <strong style={{ color: 'var(--accent)' }}>ChatGPT / GPT</strong>
              <span className="pill">OpenAPI 3.1 · MCP</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Import the OpenAPI schema into Custom GPT Actions or connect via Remote MCP.
            </p>
            <div className="code-block">{origin}/openapi.json</div>
          </article>

          <article className="card stack-sm" data-testid="ai-guide-muse">
            <div className="space-between">
              <strong style={{ color: 'var(--accent)' }}>Meta Muse</strong>
              <span className="pill">OpenAPI · Context</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Use OpenAPI / llms.txt discovery or paste your Context MD directly in chat.
            </p>
            <div className="code-block">{origin}/llms.txt</div>
          </article>
        </div>
      </section>

      {/* 4. Scoped API Keys & OAuth Clients */}
      <section className="card stack-sm">
        <div className="row-wrap">
          <KeyRound size={16} color="var(--accent)" />
          <div>
            <div className="eyebrow">ACCESS KEYS</div>
            <h2 className="section-heading">Scoped AI Keys &amp; Connections</h2>
          </div>
        </div>

        {keyError ? <div className="banner-danger" role="alert">{keyError}</div> : null}

        {mintedSecret ? (
          <div className="banner-ok stack-sm" role="status">
            <strong>Copy your new key now ({mintedSecret.name} · {mintedSecret.scope}) — shown only once:</strong>
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
              placeholder="e.g., Claude, Grok Bot"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
          </label>
          <label className="field-label" style={{ minWidth: 140 }}>
            Permission Scope
            <select name="scope" aria-label="API Key Scope" value={keyScope} onChange={(e) => setKeyScope(e.target.value)}>
              {API_TOKEN_SCOPES.map((sc) => (
                <option key={sc} value={sc}>{sc}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" data-testid="btn-mint-api-key" disabled={minting}>
            <KeyRound size={14} /> {minting ? 'Creating…' : 'Create Key'}
          </button>
        </form>

        {keys.length > 0 ? (
          <div className="stack-sm">
            {keys.map((k) => (
              <div key={k.id} className="card-subtle space-between">
                <div>
                  <strong>{k.name}</strong> <span className="pill pill-accent">{k.scope}</span>
                  <div className="dim num">{k.prefix || 'hp_key_...'} · {k.createdAt ? k.createdAt.slice(0, 10) : '—'}</div>
                </div>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => handleRevokeKey(k.id)}>
                  <Trash2 size={13} /> Revoke
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {oauthClients.length > 0 ? (
          <div className="stack-sm">
            <div className="eyebrow">CONNECTED OAUTH APPS</div>
            {oauthClients.map((c) => (
              <div key={c.client_id || c.id} className="card-subtle space-between">
                <div>
                  <strong>{c.client_name || c.client_id}</strong>
                  <div className="dim num">{c.client_id}</div>
                </div>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => handleRevokeOAuth(c.client_id)}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {auditLog.length > 0 ? (
        <details className="card">
          <summary className="row-wrap" style={{ cursor: 'pointer', fontWeight: 600 }}>
            <History size={15} color="var(--accent)" />
            <span>Recent Activity Log ({auditLog.length})</span>
          </summary>
          <div className="stack-sm" style={{ marginTop: '0.65rem' }}>
            {auditLog.slice(0, 10).map((entry, idx) => (
              <div key={entry.id || idx} className="dim">
                <code style={{ color: 'var(--accent)' }}>{entry.actor || 'system'}</code> · {entry.summary || entry.action}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {/* AI Research Prompt Builder Modal */}
      {showPromptModal ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="AI Research Prompt Builder">
          <div className="modal-card stack-v">
            <div className="space-between">
              <div>
                <div className="eyebrow">AI RESEARCH ASSISTANT</div>
                <h2 className="display-sm">Research Prompt Builder</h2>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setShowPromptModal(false)}>Close</button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Type any compound below, copy the tailored prompt into Gemini, Claude, Grok, ChatGPT, or Muse, then paste its JSON reply back into AI Hub.
            </p>
            <form onSubmit={handleGeneratePrompt} className="stack-sm">
              <div className="grid-2">
                <label className="field-label">
                  Compound Name
                  <input
                    type="text"
                    name="compoundName"
                    placeholder="e.g., Thymosin Beta-4, Azelaic Acid"
                    value={promptCompoundName}
                    onChange={(e) => setPromptCompoundName(e.target.value)}
                  />
                </label>
                <label className="field-label">
                  Section
                  <select value={promptSectionId} onChange={(e) => setPromptSectionId(e.target.value)}>
                    {(sections || []).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row-wrap">
                <button type="submit" className="btn btn-primary btn-sm" disabled={promptLoading}>
                  {promptLoading ? 'Building…' : 'Generate Prompt'}
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
              Ready-to-Paste Prompt
              <textarea readOnly rows={11} value={generatedPrompt} aria-label="Generated AI Research Prompt" />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
