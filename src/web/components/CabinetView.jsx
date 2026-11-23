import React, { useMemo, useRef, useState } from 'react';
import {
  Package,
  Sparkles,
  Upload,
  AlertTriangle,
  CheckCircle2,
  Syringe,
  Flame,
  Leaf,
  Droplets,
  Layers,
  ChevronDown,
} from 'lucide-react';
import { OWNERSHIP_STATUSES, resolveEffectiveOwnership } from '../../core/index.js';
import { api } from '../lib/api.js';

const STATUS_META = [
  { key: 'have', label: 'In Cabinet', color: 'var(--success)' },
  { key: 'low_stock', label: 'Low Stock', color: 'var(--warn)' },
  { key: 'ordered', label: 'On Order', color: 'var(--cyan)' },
  { key: 'wishlist', label: 'Wishlist', color: 'var(--accent)' },
];

const SECTION_ICON = {
  peptides: { Icon: Syringe, cls: 'sec-peptides' },
  peds: { Icon: Flame, cls: 'sec-peds' },
  vitamins_supplements: { Icon: Leaf, cls: 'sec-vitamins_supplements' },
  dermatology: { Icon: Droplets, cls: 'sec-dermatology' },
};

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
      setNotice(`Loaded Starter Reference Library (${added} profiles ready across all 4 sections).`);
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

  const totalDenom = Math.max(1, counts.total);

  return (
    <div className="stack-v">
      <div className="space-between" style={{ alignItems: 'flex-end', paddingTop: '0.2rem' }}>
        <div>
          <div className="eyebrow">INVENTORY &amp; STOCK · {counts.total} TOTAL</div>
          <h1 className="editorial-title" style={{ marginTop: 6 }}>The Cabinet</h1>
          <p className="italic-sub" style={{ margin: '0.3rem 0 0' }}>
            Track household inventory on hand, monitor low stock, and import Protocol OS backups.
          </p>
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-import-protocol-os"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={13} strokeWidth={1.8} /> Import Protocol OS
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-load-starter-catalog"
            disabled={busy}
            onClick={handleLoadStarter}
          >
            <Sparkles size={13} strokeWidth={1.8} /> Load Starter Library
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
          <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {notice}
        </div>
      ) : null}

      {errorMsg ? (
        <div className="banner-danger" role="alert">
          <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {errorMsg}
        </div>
      ) : null}

      {/* Architectural Stock Coverage Bar + 4 Hairline Stat Columns (ZERO nested stat boxes!) */}
      <section className="atelier-card stack-sm">
        <div className="space-between">
          <span className="eyebrow">STOCK COVERAGE</span>
          <span className="dim mono">{counts.have} of {counts.total} on hand</span>
        </div>

        <div className="coverage-bar" aria-hidden="true">
          {STATUS_META.map(({ key, color }) => {
            const pct = ((counts[key] || 0) / totalDenom) * 100;
            if (pct <= 0) return null;
            return <div key={key} className="coverage-seg" style={{ width: `${pct}%`, background: color }} />;
          })}
        </div>

        <div className="stat-ribbon" style={{ borderTop: 'none', paddingTop: '0.5rem' }}>
          {STATUS_META.map(({ key, label, color }) => {
            const active = statusFilter === key;
            return (
              <button
                key={key}
                type="button"
                className="stat-cell interactive"
                onClick={() => setStatusFilter(active ? 'all' : key)}
              >
                <span className="stat-k" style={{ color: active ? color : undefined }}>{label}</span>
                <span className="stat-v lg" style={{ color }}>{counts[key] || 0}</span>
                <span className="stat-sub">{active ? 'Filtering · tap to clear' : 'Tap to filter'}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Organic Status Filter Pills */}
      <div className="cat-pills">
        <button
          type="button"
          className={`cat-pill${statusFilter === 'all' ? ' active' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All <span className="pill-num">{counts.total}</span>
        </button>
        {OWNERSHIP_STATUSES.map((st) => (
          <button
            key={st}
            type="button"
            className={`cat-pill${statusFilter === st ? ' active' : ''}`}
            onClick={() => setStatusFilter(st)}
          >
            {st.replace(/_/g, ' ')} <span className="pill-num">{counts[st] || 0}</span>
          </button>
        ))}
      </div>

      {/* Sculptural Porcelain Inventory List */}
      <div data-testid="cabinet-list">
        {items.length === 0 ? (
          <div className="atelier-card stack-sm" style={{ textAlign: 'center', padding: '2.6rem 1.4rem', alignItems: 'center' }}>
            <Package size={26} strokeWidth={1.5} color="var(--accent)" />
            <h2 className="display-sm">
              {(compounds || []).length === 0 ? 'Your Cabinet Is Empty' : 'No Items in This View'}
            </h2>
            <p className="muted" style={{ margin: 0, maxWidth: 440 }}>
              {(compounds || []).length === 0
                ? 'Load the 26-compound Starter Library or import your Protocol OS export to populate your cabinet.'
                : 'Select All above to view every item in your household catalog.'}
            </p>
          </div>
        ) : (
          <div className="list-sheet">
            {items.map(({ compound, own }) => {
              const sec = sectionsById.get(compound.sectionId);
              const meta = SECTION_ICON[compound.sectionId] || { Icon: Layers, cls: 'sec-custom' };
              const RowIcon = meta.Icon;
              const lowRunOut =
                typeof own.remainingDoses === 'number' && Number.isFinite(own.remainingDoses) && own.remainingDoses <= 3;

              return (
                <article key={compound.id} className="list-row">
                  <div className={`row-medallion ${meta.cls}`} aria-hidden="true">
                    <RowIcon size={16} strokeWidth={1.7} />
                  </div>

                  <div className="row-body">
                    <button
                      type="button"
                      onClick={() => onSelectCompound(compound.id)}
                      className="row-title"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        textAlign: 'left',
                      }}
                    >
                      {compound.name}
                    </button>
                    <div className="row-meta">
                      {[
                        sec?.name || compound.sectionId,
                        own.status !== 'dont_have'
                          ? own.scope === 'household'
                            ? 'Shared'
                            : 'Personal'
                          : compound.dosages?.route || '',
                        own.remainingDoses != null
                          ? `${own.remainingDoses} doses left`
                          : own.quantity != null
                            ? `Qty ${own.quantity} ${own.unit || ''}`.trim()
                            : '',
                        own.expiryDate ? `Exp ${own.expiryDate}` : '',
                      ]
                        .filter(Boolean)
                        .join('  ·  ')}
                    </div>
                    {lowRunOut ? (
                      <div className="dim" style={{ color: 'var(--warn)', marginTop: 2 }}>
                        Low stock: {own.remainingDoses} dose(s) remaining
                      </div>
                    ) : null}
                  </div>

                  <div className="select-pill">
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
                    <ChevronDown size={12} strokeWidth={1.8} className="sel-chev" aria-hidden="true" />
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
