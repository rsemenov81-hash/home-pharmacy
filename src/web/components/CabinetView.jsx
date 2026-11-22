import React, { useMemo, useRef, useState } from 'react';
import { Package, Sparkles, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { OWNERSHIP_STATUSES, resolveEffectiveOwnership } from '../../core/index.js';
import { api } from '../lib/api.js';

export function CabinetView({
  compounds,
  sections,
  ownership,
  activeMemberId,
  searchQuery,
  onSelectCompound,
  onRefresh,
}) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const fileInputRef = useRef(null);

  const sectionsById = useMemo(
    () => new Map((sections || []).map((s) => [s.id, s])),
    [sections],
  );

  const items = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase();
    return (compounds || [])
      .map((c) => {
        const eff = resolveEffectiveOwnership(c.id, activeMemberId, ownership || []);
        return {
          compound: c,
          own: eff || { status: 'dont_have', scope: 'household', remainingDoses: null },
        };
      })
      .filter(({ compound, own }) => {
        if (statusFilter !== 'all' && own.status !== statusFilter) return false;
        if (q) {
          const hay = [
            compound.name,
            compound.slug,
            compound.summary,
            ...(compound.aliases || []),
            own.vendor || '',
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }, [compounds, ownership, activeMemberId, statusFilter, searchQuery]);

  const counts = useMemo(() => {
    const c = { total: (compounds || []).length, have: 0, low_stock: 0, ordered: 0, wishlist: 0, dont_have: 0 };
    for (const cmp of compounds || []) {
      const eff = resolveEffectiveOwnership(cmp.id, activeMemberId, ownership || []);
      const st = eff?.status || 'dont_have';
      if (st in c) c[st] += 1;
    }
    return c;
  }, [compounds, ownership, activeMemberId]);

  const handleLoadStarter = async () => {
    setBusy(true);
    setErrorMsg('');
    setNotice('');
    try {
      const res = await api.post('/api/v1/seed/starter', {});
      const added = res.json?.added ?? res.json?.seeded ?? res.json?.compoundsAdded ?? 'starter';
      await onRefresh();
      setNotice(`Loaded Starter Reference Catalog (${added} reference profiles available across all 4 sections).`);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to load starter reference catalog.');
    } finally {
      setBusy(false);
    }
  };

  const importProtocolPayload = async (rawText) => {
    setBusy(true);
    setErrorMsg('');
    setNotice('');
    try {
      const parsed = JSON.parse(rawText);
      const res = await api.post(
        `/api/v1/import/protocol-os?member=${encodeURIComponent(activeMemberId)}`,
        parsed,
      );
      await onRefresh();
      const imported = res.json?.importedCompounds ?? res.json?.compoundsAdded ?? res.json?.protocolsImported ?? 'records';
      setNotice(`Imported Protocol OS export successfully (${imported}).`);
      setShowPasteModal(false);
      setPasteText('');
    } catch (err) {
      setErrorMsg(err.message || 'Invalid Protocol OS JSON export.');
    } finally {
      setBusy(false);
    }
  };

  const handleProtocolFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    await importProtocolPayload(text);
  };

  const handleQuickOwnership = async (compoundId, status, currentScope) => {
    setErrorMsg('');
    try {
      await api.put(`/api/v1/ownership/${encodeURIComponent(compoundId)}`, {
        scope: currentScope || 'household',
        status,
      });
      await onRefresh();
    } catch (err) {
      setErrorMsg(err.message || 'Failed to update ownership status.');
    }
  };

  return (
    <div className="stack-v">
      <div className="space-between">
        <div>
          <h1 style={{ margin: 0, fontSize: '1.45rem' }}>Household Cabinet & Inventory</h1>
          <p className="muted" style={{ margin: '0.2rem 0 0' }}>
            Track shared household stock vs. personal compounds, run-out alerts, starter reference data, and Protocol OS imports.
          </p>
        </div>
        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-load-starter-catalog"
            disabled={busy}
            onClick={handleLoadStarter}
          >
            <Sparkles size={14} /> Load Starter Reference Catalog
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-import-protocol-os"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} /> Import Protocol OS
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => setShowPasteModal(true)}
          >
            Paste Protocol OS JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            aria-label="Upload Protocol OS JSON file"
            style={{ display: 'none' }}
            onChange={handleProtocolFileSelected}
          />
        </div>
      </div>

      {notice ? (
        <div className="banner-ok" role="status">
          <CheckCircle2 size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {notice}
        </div>
      ) : null}

      {errorMsg ? (
        <div className="banner-danger" role="alert">
          <AlertTriangle size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {errorMsg}
        </div>
      ) : null}

      {/* Summary & Ownership Filter Chips */}
      <div className="row-wrap">
        <button
          type="button"
          className={`tab-btn${statusFilter === 'all' ? ' active' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All ({counts.total})
        </button>
        {OWNERSHIP_STATUSES.map((st) => (
          <button
            key={st}
            type="button"
            className={`tab-btn${statusFilter === st ? ' active' : ''}`}
            onClick={() => setStatusFilter(st)}
          >
            {st.replace(/_/g, ' ')} ({counts[st] || 0})
          </button>
        ))}
      </div>

      {/* Cabinet List */}
      <div className="stack-v" data-testid="cabinet-list">
        {items.length === 0 ? (
          <div className="card stack-v" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
            <Package size={28} color="var(--gold)" style={{ margin: '0 auto' }} />
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>
              {(compounds || []).length === 0 ? 'Your Cabinet is Empty' : 'No Matching Compounds'}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              {(compounds || []).length === 0
                ? 'Start clean by adding compounds in Sections, import a Protocol OS export, or load the generic non-personal Starter Reference Catalog.'
                : 'Adjust your ownership filter or clear global search to see all cabinet items.'}
            </p>
          </div>
        ) : (
          <div className="grid-2">
            {items.map(({ compound, own }) => {
              const sec = sectionsById.get(compound.sectionId);
              const lowRunOut =
                typeof own.remainingDoses === 'number' && Number.isFinite(own.remainingDoses) && own.remainingDoses <= 3;
              return (
                <article key={compound.id} className="card stack-v">
                  <div className="space-between">
                    <div>
                      <button
                        type="button"
                        onClick={() => onSelectCompound(compound.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          color: 'var(--text)',
                          fontWeight: 700,
                          fontSize: '1.02rem',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {compound.name}
                      </button>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>
                        {sec?.name || compound.sectionId}
                        {compound.dosages?.route ? ` • ${compound.dosages.route}` : ''}
                        {own.scope === 'household' ? ' • Shared Household' : ` • Personal (${own.scope})`}
                      </div>
                    </div>
                    <span className={`pill pill-${own.status}`}>{own.status.replace(/_/g, ' ')}</span>
                  </div>

                  {lowRunOut ? (
                    <div className="banner-warn" style={{ padding: '0.45rem 0.65rem', fontSize: '0.82rem' }}>
                      <AlertTriangle size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                      Run-out warning: {own.remainingDoses} doses remaining.
                    </div>
                  ) : null}

                  <div className="space-between">
                    <div className="muted" style={{ fontSize: '0.8rem' }}>
                      {own.quantity != null ? `Qty: ${own.quantity} ${own.unit || ''}` : 'No quantity logged'}
                      {own.expiryDate ? ` • Exp: ${own.expiryDate}` : ''}
                    </div>
                    <select
                      aria-label={`Ownership status for ${compound.name}`}
                      value={own.status}
                      onChange={(e) => handleQuickOwnership(compound.id, e.target.value, own.scope)}
                    >
                      {OWNERSHIP_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {st.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {showPasteModal ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Import Protocol OS JSON">
          <div className="modal-card stack-v">
            <div className="space-between">
              <h2 style={{ margin: 0, color: 'var(--gold)' }}>Import Protocol OS JSON</h2>
              <button type="button" className="btn btn-sm" onClick={() => setShowPasteModal(false)}>
                Close
              </button>
            </div>
            <form
              className="stack-v"
              onSubmit={(e) => {
                e.preventDefault();
                importProtocolPayload(pasteText);
              }}
            >
              <label className="field-label">
                Protocol OS Export JSON
                <textarea
                  rows={8}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder='Paste protocol-os-export/v1 JSON here...'
                  required
                />
              </label>
              <div className="row-wrap">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Importing…' : 'Import Protocol OS'}
                </button>
                <button type="button" className="btn" onClick={() => setShowPasteModal(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
