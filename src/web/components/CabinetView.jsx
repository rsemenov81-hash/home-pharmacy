import React, { useMemo, useRef, useState } from 'react';
import { Package, Sparkles, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { OWNERSHIP_STATUSES, resolveEffectiveOwnership } from '../../core/index.js';
import { api } from '../lib/api.js';

const STATUS_META = [
  { key: 'have', label: 'In Cabinet', tone: 'var(--success)' },
  { key: 'low_stock', label: 'Low Stock', tone: 'var(--warn)' },
  { key: 'ordered', label: 'On Order', tone: 'var(--accent)' },
  { key: 'wishlist', label: 'Wishlist', tone: 'var(--cyan)' },
];

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
      setNotice(`Loaded Starter Reference Catalog (${added} reference profiles ready across all 4 sections).`);
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
      setNotice(`Imported Protocol OS export (${imported}).`);
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
      setErrorMsg(err.message || 'Could not update ownership.');
    }
  };

  return (
    <div className="stack-v">
      <div className="space-between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">INVENTORY &amp; STOCK</div>
          <h1 className="display-title" style={{ marginTop: 4 }}>Household Cabinet</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            See what you have on hand, track low stock &amp; wishlists, and import from Protocol OS.
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
            <Sparkles size={14} /> Load Starter Library
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

      {/* Interactive Glass Stat Strip */}
      <div className="grid-4">
        {STATUS_META.map(({ key, label, tone }) => {
          const active = statusFilter === key;
          return (
            <button
              key={key}
              type="button"
              className="card"
              onClick={() => setStatusFilter(active ? 'all' : key)}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                borderColor: active ? 'var(--accent-border)' : undefined,
              }}
            >
              <div className="metric-label">{label}</div>
              <div className="display-sm num" style={{ color: tone, marginTop: 4 }}>
                {counts[key] || 0}
              </div>
              <div className="dim">{active ? 'Filtering · tap to clear' : 'Tap to filter'}</div>
            </button>
          );
        })}
      </div>

      {/* Filter Pills */}
      <div className="section-tabs">
        <button
          type="button"
          className={`tab-btn${statusFilter === 'all' ? ' active' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All <span className="tab-count">{counts.total}</span>
        </button>
        {OWNERSHIP_STATUSES.map((st) => (
          <button
            key={st}
            type="button"
            className={`tab-btn${statusFilter === st ? ' active' : ''}`}
            onClick={() => setStatusFilter(st)}
          >
            {st.replace(/_/g, ' ')} <span className="tab-count">{counts[st] || 0}</span>
          </button>
        ))}
      </div>

      {/* Cabinet Inventory List */}
      <div className="stack-v" data-testid="cabinet-list">
        {items.length === 0 ? (
          <div className="glass stack-sm" style={{ textAlign: 'center', padding: '2.2rem 1.2rem', alignItems: 'center' }}>
            <Package size={28} color="var(--accent)" />
            <h2 className="display-sm">
              {(compounds || []).length === 0 ? 'Your Cabinet Is Empty' : 'No Items in This View'}
            </h2>
            <p className="muted" style={{ margin: 0, maxWidth: 440 }}>
              {(compounds || []).length === 0
                ? 'Load the 26-compound Starter Library, import your Protocol OS export, or add compounds in Library.'
                : 'Tap All above to view your full household catalog.'}
            </p>
          </div>
        ) : (
          <div className="grid-2">
            {items.map(({ compound, own }) => {
              const sec = sectionsById.get(compound.sectionId);
              const lowRunOut =
                typeof own.remainingDoses === 'number' && Number.isFinite(own.remainingDoses) && own.remainingDoses <= 3;
              return (
                <article key={compound.id} className="card stack-sm">
                  <div className="space-between" style={{ alignItems: 'flex-start' }}>
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
                          fontSize: '1rem',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {compound.name}
                      </button>
                      <div className="dim" style={{ marginTop: 2 }}>
                        {sec?.name || compound.sectionId}
                        {compound.dosages?.route ? ` · ${compound.dosages.route}` : ''}
                        {own.scope === 'household' ? ' · Shared' : ' · Personal'}
                      </div>
                    </div>
                    <span className={`pill pill-${own.status}`}>{own.status.replace(/_/g, ' ')}</span>
                  </div>

                  {lowRunOut ? (
                    <div className="banner-warn" style={{ padding: '0.45rem 0.65rem', fontSize: '0.8rem' }}>
                      <AlertTriangle size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                      Low stock: {own.remainingDoses} dose(s) remaining.
                    </div>
                  ) : null}

                  <div className="space-between" style={{ paddingTop: '0.35rem', borderTop: '1px solid var(--border-subtle)' }}>
                    <div className="dim num">
                      {own.remainingDoses != null
                        ? `${own.remainingDoses} doses left`
                        : own.quantity != null
                          ? `Qty: ${own.quantity} ${own.unit || ''}`
                          : 'No stock count logged'}
                      {own.expiryDate ? ` · Exp ${own.expiryDate}` : ''}
                    </div>
                    <select
                      aria-label={`Ownership status for ${compound.name}`}
                      value={own.status}
                      onChange={(e) => handleQuickOwnership(compound.id, e.target.value, own.scope)}
                      style={{ padding: '0.32rem 0.6rem', fontSize: '0.8rem' }}
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
              <h2 className="display-sm">Paste Protocol OS Export</h2>
              <button type="button" className="btn btn-sm" onClick={() => setShowPasteModal(false)}>Close</button>
            </div>
            <form
              className="stack-v"
              onSubmit={(e) => {
                e.preventDefault();
                importProtocolPayload(pasteText);
              }}
            >
              <label className="field-label">
                Export JSON
                <textarea
                  rows={8}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Paste protocol-os-export/v1 JSON…"
                  required
                />
              </label>
              <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setShowPasteModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Importing…' : 'Import'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
