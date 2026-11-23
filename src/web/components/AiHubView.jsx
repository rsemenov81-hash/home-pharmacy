import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  KeyRound,
  Check,
  X,
  Copy,
  FileJson,
  Trash2,
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
      setGeneratedPrompt(
        res.json?.prompt ||
          res.json?.promptText ||
          buildFallbackPromptText(targetName, sections.find((s) => s.id === promptSectionId)),
      );
    } catch {
      setGeneratedPrompt(
        buildFallbackPromptText(targetName, sections.find((s) => s.id === promptSectionId)),
      );
    } finally {
      setPromptLoading(false);
    }
  };

  const handleImportJson = async (e) => {
    e.preventDefault();
    setImportError('');
    setImportStatus('');
    let parsed;
    try {
      const cleaned = jsonInput
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch {
      setImportError('Invalid JSON — paste a valid JSON object from your AI assistant.');
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setImportError('Expected a single JSON compound object.');
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

  const handleCopyContext = async () => {
    setContextMsg('');
    try {
      const res = await api.get(`/api/v1/export/context.md?member=${encodeURIComponent(activeMemberId)}`, {
        rawText: true,
      });
      const md = res.text || '';
      setContextPreview(md);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(md).catch(() => {});
      }
      setContextMsg('Copied AI Context Markdown to clipboard.');
    } catch (err) {
      setContextMsg(err.message || 'Could not generate Context Markdown.');
    }
  };

  const copyText = (txt, label) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(txt).catch(() => {});
    }
    setContextMsg(`Copied ${label}.`);
  };

  const aiGuides = [
    {
      testId: 'ai-guide-claude',
      monogram: 'C',
      name: 'Claude',
      badge: 'MCP · OAuth 2.1',
      desc: 'Add as a Remote MCP Connector — auto-discovers OAuth 2.1 with PKCE.',
      endpoint: `${origin}/mcp`,
      copyLabel: 'Claude MCP URL',
    },
    {
      testId: 'ai-guide-gemini',
      monogram: 'G',
      name: 'Gemini',
      badge: 'MCP · Context MD',
      desc: 'Connect via Remote MCP (Bearer or ?token=) or paste Context MD in Gems.',
      endpoint: `${origin}/mcp`,
      copyLabel: 'Gemini MCP URL',
    },
    {
      testId: 'ai-guide-grok',
      monogram: 'X',
      name: 'Grok Bot',
      badge: 'Remote MCP · REST',
      desc: 'Point Grok to /mcp with a scoped API key or query /api/v1/compounds.',
      endpoint: `${origin}/api/v1/compounds`,
      copyLabel: 'Grok REST URL',
    },
    {
      testId: 'ai-guide-gpt',
      monogram: 'O',
      name: 'ChatGPT / GPT',
      badge: 'MCP · OpenAPI 3.1',
      desc: 'Connect via ChatGPT MCP or import /openapi.json directly into GPT Actions.',
      endpoint: `${origin}/openapi.json`,
      copyLabel: 'OpenAPI URL',
    },
    {
      testId: 'ai-guide-muse',
      monogram: 'M',
      name: 'Meta Muse',
      badge: 'llms.txt · Context',
      desc: 'Use OpenAPI / llms.txt discovery or paste your Context MD directly in chat.',
      endpoint: `${origin}/llms.txt`,
      copyLabel: 'llms.txt URL',
    },
  ];

  return (
    <div className="stack-v">
      {/* Editorial Header */}
      <div className="space-between" style={{ alignItems: 'flex-end', paddingTop: '0.2rem' }}>
        <div>
          <div className="eyebrow">MULTI-AI ATELIER · 5 ASSISTANTS</div>
          <h1 className="editorial-title" style={{ marginTop: 6 }}>AI Hub</h1>
          <p className="italic-sub" style={{ margin: '0.3rem 0 0' }}>
            Research with Claude, Gemini, Grok, ChatGPT, and Meta Muse — review proposals before saving.
          </p>
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-copy-context-md"
            onClick={handleCopyContext}
          >
            <Copy size={13} strokeWidth={1.8} /> Copy Context MD
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-open-ai-prompt-builder"
            onClick={openPromptBuilder}
          >
            <Sparkles size={13} strokeWidth={1.8} /> Research Prompt
          </button>
        </div>
      </div>

      {contextMsg ? (
        <div className="banner-ok" role="status">
          <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {contextMsg}
        </div>
      ) : null}

      {contextPreview ? (
        <details className="atelier-card">
          <summary className="eyebrow" style={{ cursor: 'pointer' }}>
            Context Markdown Preview ({contextPreview.length} chars)
          </summary>
          <pre className="code-block" style={{ marginTop: '0.65rem', whiteSpace: 'pre-wrap' }}>
            {contextPreview.slice(0, 1200)}
          </pre>
        </details>
      ) : null}

      {/* 1. Pending Proposals Inbox */}
      <section className="stack-sm" data-testid="ai-proposals-list">
        <div className="section-h">
          <span>Review Proposals</span>
          <span className="sh-count">{String(pendingProposals.length).padStart(2, '0')} pending</span>
        </div>

        {proposalMsg ? <div className="banner-ok" role="status">{proposalMsg}</div> : null}
        {proposalErr ? <div className="banner-danger" role="alert">{proposalErr}</div> : null}

        {pendingProposals.length === 0 ? (
          <div className="atelier-card">
            <p className="muted" style={{ margin: 0 }}>
              No pending AI proposals. Suggested edits to verified profiles and stack changes appear here for approval.
            </p>
          </div>
        ) : (
          <div className="list-sheet">
            {pendingProposals.map((p) => (
              <article key={p.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                <div className="row-body">
                  <div className="row-wrap" style={{ gap: '0.45rem' }}>
                    <span className="row-title">{p.summary || p.reason || p.proposalType || p.kind || 'AI Proposal'}</span>
                    <span className="pill pill-accent mono">{p.actor || p.sourceActor || 'ai'}</span>
                  </div>
                  <div className="row-meta" style={{ marginTop: 2 }}>
                    {(p.proposalType || p.kind || 'update').replace(/_/g, ' ')}
                    {p.targetId ? `  ·  target: ${p.targetId}` : ''}
                  </div>
                </div>
                <div className="row-wrap" style={{ flexShrink: 0, gap: '0.35rem' }}>
                  <button
                    type="button"
                    className="btn btn-success btn-sm"
                    data-testid={`btn-approve-proposal-${p.id}`}
                    onClick={() => handleResolveProposal(p.id, 'approve')}
                  >
                    <Check size={13} strokeWidth={2} /> Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    data-testid={`btn-dismiss-proposal-${p.id}`}
                    onClick={() => handleResolveProposal(p.id, 'dismiss')}
                  >
                    <X size={13} strokeWidth={2} /> Dismiss
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 2. Quick JSON Import */}
      <section className="atelier-card stack-sm">
        <div className="space-between">
          <div>
            <div className="eyebrow">PASTE AI RESEARCH</div>
            <h2 className="display-sm" style={{ marginTop: 2 }}>Import Compound JSON</h2>
          </div>
          <FileJson size={17} strokeWidth={1.6} color="var(--accent)" />
        </div>

        {importStatus ? <div className="banner-ok" role="status">{importStatus}</div> : null}
        {importError ? (
          <div className="banner-danger" role="alert">
            <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            {importError}
          </div>
        ) : null}

        <form onSubmit={handleImportJson} className="stack-sm">
          <textarea
            data-testid="ai-json-import-textarea"
            aria-label="AI compound JSON payload"
            rows={4}
            placeholder='Paste a researched compound JSON object (e.g., { "name": "Epitalon", "sectionId": "peptides", "summary": "..." })'
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
          />
          <div>
            <button type="submit" className="btn btn-primary btn-sm" data-testid="btn-import-ai-json" disabled={importing}>
              {importing ? 'Importing…' : 'Validate & Import'}
            </button>
          </div>
        </form>
      </section>

      {/* 3. 5-AI Integration Directory (Unified Porcelain Grouped Sheet) */}
      <section className="stack-sm">
        <div className="section-h">
          <span>Connect Your 5 AIs</span>
          <span className="sh-count">05</span>
        </div>

        <div className="list-sheet">
          {aiGuides.map((g) => (
            <article key={g.testId} className="list-row" data-testid={g.testId}>
              <div className="row-medallion sec-peptides mono" style={{ fontWeight: 700, fontSize: '0.82rem' }} aria-hidden="true">
                {g.monogram}
              </div>
              <div className="row-body">
                <div className="row-wrap" style={{ gap: '0.45rem' }}>
                  <span className="row-title">{g.name}</span>
                  <span className="pill mono">{g.badge}</span>
                </div>
                <div className="row-desc">{g.desc}</div>
                <div className="row-meta" style={{ color: 'var(--accent)', marginTop: 2 }}>{g.endpoint}</div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => copyText(g.endpoint, g.copyLabel)}
              >
                <Copy size={12} strokeWidth={1.8} /> Copy
              </button>
            </article>
          ))}
        </div>
      </section>

      {/* 4. Scoped API Keys & OAuth Clients */}
      <section className="atelier-card stack-sm">
        <div>
          <div className="eyebrow">ACCESS CREDENTIALS</div>
          <h2 className="display-sm" style={{ marginTop: 2 }}>Scoped AI Keys</h2>
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
            <KeyRound size={14} strokeWidth={1.8} /> {minting ? 'Creating…' : 'Create Key'}
          </button>
        </form>

        {keys.length > 0 ? (
          <div className="stack-sm" style={{ paddingTop: '0.4rem' }}>
            {keys.map((k) => {
              const shortPrefix = (k.prefix || 'hp_key').slice(0, 12);
              return (
                <div key={k.id} className="space-between" style={{ padding: '0.55rem 0', borderTop: '1px solid var(--hair-subtle)' }}>
                  <div>
                    <strong style={{ fontSize: '0.9rem' }}>{k.name}</strong>{' '}
                    <span className="pill pill-accent mono">{k.scope}</span>
                    <div className="dim mono" title={k.prefix || ''}>
                      {shortPrefix}… · {k.createdAt ? k.createdAt.slice(0, 10) : '—'}
                    </div>
                  </div>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => handleRevokeKey(k.id)}>
                    <Trash2 size={12} /> Revoke
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {oauthClients.length > 0 ? (
          <div className="stack-sm" style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--hair-subtle)' }}>
            <div className="eyebrow">CONNECTED OAUTH APPS</div>
            {oauthClients.map((c) => {
              const cid = String(c.client_id || c.id || '');
              const shortCid = cid.length > 14 ? `${cid.slice(0, 10)}…` : cid;
              return (
                <div key={cid} className="space-between" style={{ padding: '0.4rem 0' }}>
                  <div>
                    <strong style={{ fontSize: '0.9rem' }}>{c.client_name || shortCid}</strong>
                    <div className="dim mono" title={cid}>ID: {shortCid}</div>
                  </div>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => handleRevokeOAuth(c.client_id)}>
                    Revoke
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {auditLog.length > 0 ? (
        <details className="atelier-card">
          <summary className="row-wrap" style={{ cursor: 'pointer', fontWeight: 600 }}>
            <History size={15} strokeWidth={1.7} color="var(--accent)" />
            <span className="eyebrow">RECENT ACTIVITY LEDGER ({auditLog.length})</span>
          </summary>
          <div className="stack-sm" style={{ marginTop: '0.75rem' }}>
            {auditLog.slice(0, 10).map((entry, idx) => (
              <div key={entry.id || idx} className="dim" style={{ paddingTop: idx ? '0.4rem' : 0, borderTop: idx ? '1px solid var(--hair-subtle)' : 'none' }}>
                <code className="mono" style={{ color: 'var(--accent)' }}>{entry.actor || 'system'}</code> · {entry.summary || entry.action}
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
                <h2 className="display-sm" style={{ marginTop: 2 }}>Research Prompt Builder</h2>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setShowPromptModal(false)}>Close</button>
            </div>
            <form onSubmit={handleGeneratePrompt} className="stack-sm">
              <div className="grid-2">
                <label className="field-label">
                  Compound Name
                  <input
                    type="text"
                    name="compoundName"
                    placeholder="e.g., Epitalon, Magnesium L-Threonate"
                    value={promptCompoundName}
                    onChange={(e) => setPromptCompoundName(e.target.value)}
                    autoFocus
                  />
                </label>
                <label className="field-label">
                  Section
                  <select name="sectionId" value={promptSectionId} onChange={(e) => setPromptSectionId(e.target.value)}>
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
                  onClick={() => copyText(generatedPrompt, 'research prompt')}
                >
                  <Copy size={13} /> Copy Prompt
                </button>
              </div>
            </form>
            <label className="field-label">
              Schema-Strict Prompt (Paste into Claude, Gemini, Grok, ChatGPT, or Muse)
              <textarea rows={9} readOnly value={generatedPrompt} />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
