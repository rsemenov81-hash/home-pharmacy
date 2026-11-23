import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Edit3,
  Syringe,
  ShieldAlert,
  ExternalLink,
  Clock,
  Activity,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import {
  PK_DISCLAIMER,
  OWNERSHIP_STATUSES,
  resolveEffectiveOwnership,
  vialMath,
  oilDrawMath,
} from '../../core/index.js';
import { api } from '../lib/api.js';

function HalfLifeCurve({ halfLifeHours }) {
  const points = useMemo(() => {
    if (!halfLifeHours || !Number.isFinite(halfLifeHours) || halfLifeHours <= 0) return null;
    const maxH = halfLifeHours * 5;
    const pts = [];
    for (let i = 0; i <= 50; i += 1) {
      const t = (i / 50) * maxH;
      const pct = Math.pow(0.5, t / halfLifeHours);
      const x = 14 + (i / 50) * 612;
      const y = 98 - pct * 82;
      pts.push({ x, y });
    }
    const linePath = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L626,98 L14,98 Z`;
    return { linePath, areaPath, maxH };
  }, [halfLifeHours]);

  if (!points) return null;

  const fmtSpan = (h) => (h >= 48 ? `${(h / 24).toFixed(1).replace(/\.0$/, '')}d` : `${Number(h.toFixed(1))}h`);

  return (
    <section className="card stack-sm">
      <div className="space-between">
        <div className="row-wrap">
          <Activity size={16} color="var(--accent)" />
          <h3 className="section-heading">Estimated Elimination Curve (5 Half-Lives)</h3>
        </div>
        <span className="pill pill-accent num">t½ ~{fmtSpan(halfLifeHours)}</span>
      </div>
      <svg viewBox="0 0 640 124" className="pk-svg" role="img" aria-label={`Exponential decay curve for half-life ${halfLifeHours} hours`}>
        <defs>
          <linearGradient id="pkAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <line x1="14" y1="98" x2="626" y2="98" stroke="var(--border)" strokeWidth="1" />
        <line x1="14" y1="57" x2="626" y2="57" stroke="var(--border-subtle)" strokeWidth="1" strokeDasharray="4 5" />
        <line x1="136.4" y1="16" x2="136.4" y2="98" stroke="var(--border-subtle)" strokeWidth="1" strokeDasharray="3 4" />
        <path d={points.areaPath} fill="url(#pkAreaGrad)" />
        <path d={points.linePath} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="14" cy="16" r="4" fill="var(--accent)" />
        <circle cx="136.4" cy="57" r="4" fill="var(--success)" />
        <text x="14" y="116" fontSize="11" fill="var(--text-dim)" fontFamily="var(--mono)">0h · 100%</text>
        <text x="144" y="52" fontSize="11" fill="var(--success)" fontFamily="var(--mono)">1× t½ ({fmtSpan(halfLifeHours)} · 50%)</text>
        <text x="626" y="116" fontSize="11" fill="var(--text-dim)" textAnchor="end" fontFamily="var(--mono)">
          5× t½ ({fmtSpan(points.maxH)} · ~3%)
        </text>
      </svg>
      <p className="dim" style={{ margin: 0 }}>{PK_DISCLAIMER}</p>
    </section>
  );
}

export function CompoundDetail({
  compound,
  section,
  ownership,
  activeMemberId,
  onBack,
  onRefresh,
}) {
  const effOwn = useMemo(
    () => resolveEffectiveOwnership(compound.id, activeMemberId, ownership || []),
    [compound.id, activeMemberId, ownership],
  );

  const [ownStatus, setOwnStatus] = useState(effOwn?.status || 'dont_have');
  const [ownScope, setOwnScope] = useState(effOwn?.scope || 'household');
  useEffect(() => {
    setOwnStatus(effOwn?.status || 'dont_have');
    setOwnScope(effOwn?.scope || 'household');
  }, [compound.id, activeMemberId, effOwn?.status, effOwn?.scope]);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(compound.summary || '');
  const [mechanismOfAction, setMechanismOfAction] = useState(compound.mechanismOfAction || '');
  const [notes, setNotes] = useState(compound.notes || '');
  const [rangeText, setRangeText] = useState(compound.dosages?.rangeText || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // Reconstitution calculator state (Peptides)
  const [vialMg, setVialMg] = useState(String(compound.sectionData?.typicalVialMg || 5));
  const [diluentMl, setDiluentMl] = useState(String(compound.sectionData?.defaultDiluentMl || 2));
  const [targetMcg, setTargetMcg] = useState(
    String(
      compound.dosages?.defaultUnit === 'mg'
        ? (compound.dosages?.defaultAmount || 0.25) * 1000
        : compound.dosages?.defaultAmount || 250,
    ),
  );

  const recon = useMemo(() => {
    const res = vialMath({
      vialMg: Number(vialMg),
      diluentMl: Number(diluentMl),
      doseMcg: Number(targetMcg),
    });
    return res && res.ok ? res : null;
  }, [vialMg, diluentMl, targetMcg]);

  const oilMath = useMemo(() => {
    if (compound.sectionId !== 'peds' || !compound.sectionData?.oilConcentrationMgPerMl) return null;
    const res = oilDrawMath({
      concentrationMgPerMl: Number(compound.sectionData.oilConcentrationMgPerMl),
      doseMg: Number(compound.dosages?.defaultAmount || 50),
    });
    return res && res.ok ? res : null;
  }, [compound]);

  const handleOwnershipChange = async (nextStatus, nextScope = ownScope) => {
    setOwnStatus(nextStatus);
    setOwnScope(nextScope);
    setBusy(true);
    try {
      await api.put(`/api/v1/ownership/${encodeURIComponent(compound.id)}`, {
        scope: nextScope,
        status: nextStatus,
      });
      setMsg(`Updated stock status to ${nextStatus.replace(/_/g, ' ')}.`);
      await onRefresh();
    } catch (err) {
      setMsg(err.message || 'Could not update ownership.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setBusy(true);
    try {
      await api.post(`/api/v1/compounds/${encodeURIComponent(compound.id)}/verify`, {});
      setMsg('Profile marked as Verified.');
      await onRefresh();
    } catch (err) {
      setMsg(err.message || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/api/v1/compounds/${encodeURIComponent(compound.id)}`, {
        summary,
        mechanismOfAction,
        notes,
        dosages: {
          ...compound.dosages,
          rangeText,
        },
      });
      setEditing(false);
      setMsg('Saved profile changes.');
      await onRefresh();
    } catch (err) {
      setMsg(err.message || 'Failed to save changes.');
    } finally {
      setBusy(false);
    }
  };

  const sd = compound.sectionData || {};

  return (
    <div className="stack-v" data-testid="compound-detail">
      {/* Top Action Bar */}
      <div className="space-between">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          <ArrowLeft size={14} /> Library
        </button>

        <div className="row-wrap">
          {compound.profileStatus !== 'verified' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="btn-verify-compound"
              disabled={busy}
              onClick={handleVerify}
            >
              <CheckCircle2 size={14} /> Verify Profile
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-edit-compound"
            onClick={() => setEditing(!editing)}
          >
            <Edit3 size={14} /> {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {msg ? (
        <div className="banner-ok" role="status">
          {msg}
        </div>
      ) : null}

      {/* Hero Monograph Header */}
      <section className="glass stack-v">
        <div className="space-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow">{section?.name || compound.sectionId}{compound.subsection ? ` · ${compound.subsection}` : ''}</div>
            <h1 className="display-title" style={{ marginTop: 4 }}>{compound.name}</h1>
            {(compound.aliases || []).length > 0 ? (
              <p className="dim" style={{ margin: '0.25rem 0 0' }}>
                Also known as: {compound.aliases.join(', ')}
              </p>
            ) : null}
          </div>

          <div className="row-wrap">
            <span className={`pill pill-${compound.profileStatus}`}>
              {compound.profileStatus === 'verified' ? <CheckCircle2 size={11} /> : <Sparkles size={11} />}
              {compound.profileStatus}
            </span>
            {typeof compound.completenessPct === 'number' ? (
              <span className="pill num">{compound.completenessPct}% complete</span>
            ) : null}
          </div>
        </div>

        {/* 4 At-a-Glance Hero Metrics */}
        <div className="grid-4">
          <div className="metric-tile">
            <span className="metric-label">Typical Dose</span>
            <span className="metric-value num">{compound.dosages?.rangeText || '—'}</span>
            <span className="dim">{compound.dosages?.frequencyText || 'Flexible'}</span>
          </div>
          <div className="metric-tile">
            <span className="metric-label">Route &amp; Timing</span>
            <span className="metric-value">{compound.dosages?.route || '—'}</span>
            <span className="dim">
              {(compound.timingRules?.preferredSlots || []).slice(0, 2).map((s) => s.replace(/_/g, ' ')).join(', ') || 'Flexible'}
            </span>
          </div>
          <div className="metric-tile">
            <span className="metric-label">Half-Life</span>
            <span className="metric-value num">
              {compound.halfLife?.displayText || (compound.halfLife?.valueHours ? `${compound.halfLife.valueHours}h` : 'Unmodeled')}
            </span>
            <span className="dim">{compound.halfLife?.kind || 'reference'}</span>
          </div>
          <div className="metric-tile">
            <span className="metric-label">Cycle Pattern</span>
            <span className="metric-value">{compound.cycles?.patternText || (compound.cycles?.continuous ? 'Continuous' : '—')}</span>
            <span className="dim">Food: {(compound.timingRules?.foodState || 'any').replace(/_/g, ' ')}</span>
          </div>
        </div>

        {/* Ownership & Inventory Quick Strip */}
        <div className="card-subtle space-between">
          <div>
            <div className="eyebrow">CABINET STATUS</div>
            <div className="muted" style={{ marginTop: 2 }}>
              Track whether you have this on hand or want to add it to your wishlist.
            </div>
          </div>
          <div className="row-wrap">
            <select
              data-testid="ownership-status-select"
              aria-label="Ownership status"
              value={ownStatus}
              disabled={busy}
              onChange={(e) => handleOwnershipChange(e.target.value, ownScope)}
            >
              {OWNERSHIP_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
            <select
              aria-label="Ownership scope"
              value={ownScope}
              disabled={busy}
              onChange={(e) => handleOwnershipChange(ownStatus, e.target.value)}
            >
              <option value="household">Shared Household</option>
              <option value={`member:${activeMemberId}`}>Personal Only</option>
            </select>
          </div>
        </div>
      </section>

      {/* Inline Edit Sheet or Editorial Monograph */}
      {editing ? (
        <section className="glass">
          <form onSubmit={handleSaveEdit} className="stack-v">
            <h2 className="section-heading">Edit Profile Details</h2>
            <label className="field-label">
              Summary (What It Is)
              <textarea name="summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </label>
            <label className="field-label">
              Mechanism of Action
              <textarea name="mechanismOfAction" rows={3} value={mechanismOfAction} onChange={(e) => setMechanismOfAction(e.target.value)} />
            </label>
            <div className="grid-2">
              <label className="field-label">
                Dosage Range
                <input type="text" name="rangeText" value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
              </label>
              <label className="field-label">
                Personal Notes
                <input type="text" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>
            <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" data-testid="btn-save-compound" disabled={busy}>
                {busy ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <div className="grid-2">
          <section className="card stack-v">
            <div>
              <div className="eyebrow">OVERVIEW</div>
              <p style={{ margin: '0.35rem 0 0', color: 'var(--text-2)' }}>
                {compound.summary || 'No summary documented yet.'}
              </p>
              {compound.detailedDescription ? (
                <p className="muted" style={{ margin: '0.5rem 0 0' }}>{compound.detailedDescription}</p>
              ) : null}
            </div>
            <hr className="divider" />
            <div>
              <div className="eyebrow">MECHANISM OF ACTION</div>
              <p style={{ margin: '0.35rem 0 0', color: 'var(--text-2)' }}>
                {compound.mechanismOfAction || 'Not documented yet.'}
              </p>
            </div>
            {(compound.useCaseScenarios || []).length > 0 ? (
              <>
                <hr className="divider" />
                <div>
                  <div className="eyebrow">USE CASES</div>
                  <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.15rem', color: 'var(--text-2)' }}>
                    {compound.useCaseScenarios.map((u, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>{u}</li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}
          </section>

          <section className="card stack-v">
            <div>
              <div className="eyebrow">WHAT NOT TO PAIR WITH</div>
              {(compound.doNotPairWith || []).length > 0 ? (
                <div className="stack-sm" style={{ marginTop: '0.5rem' }}>
                  {compound.doNotPairWith.map((rule, i) => (
                    <div key={i} className={rule.severity === 'hard_stop' ? 'banner-danger' : 'banner-warn'} style={{ fontSize: '0.84rem' }}>
                      <div className="space-between" style={{ marginBottom: 3 }}>
                        <strong>{rule.targetRef}</strong>
                        <span className={`pill ${rule.severity === 'hard_stop' ? 'pill-danger' : 'pill-low_stock'}`}>
                          {rule.severity.replace(/_/g, ' ')}{rule.separationHours ? ` · ≥${rule.separationHours}h` : ''}
                        </span>
                      </div>
                      <div>{rule.recommendation || rule.mechanism}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted" style={{ margin: '0.35rem 0 0' }}>
                  No compound-specific pairing conflicts listed (built-in pharmacology &amp; dermatology interaction checks still run automatically in Stack).
                </p>
              )}
            </div>

            {(compound.synergies || []).length > 0 ? (
              <>
                <hr className="divider" />
                <div>
                  <div className="eyebrow">SYNERGIES</div>
                  <div className="stack-sm" style={{ marginTop: '0.4rem' }}>
                    {compound.synergies.map((s, i) => (
                      <div key={i} className="banner-ok" style={{ padding: '0.5rem 0.75rem', fontSize: '0.83rem' }}>
                        <strong>{s.targetRef}</strong> — {s.reason}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {(compound.monitoringLabs || []).length > 0 ? (
              <>
                <hr className="divider" />
                <div>
                  <div className="eyebrow">MONITORING LABS</div>
                  <div className="row-wrap" style={{ marginTop: '0.4rem' }}>
                    {compound.monitoringLabs.map((lab, i) => (
                      <span key={i} className="pill">{lab}</span>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {compound.storageNotes ? (
              <>
                <hr className="divider" />
                <div className="muted">
                  <strong style={{ color: 'var(--text)' }}>Storage:</strong> {compound.storageNotes}
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}

      {/* Section-Specific Advanced Modules */}
      {compound.sectionId === 'peptides' ? (
        <section className="glass stack-v" data-testid="reconstitution-calc">
          <div className="space-between">
            <div className="row-wrap">
              <Syringe size={17} color="var(--accent)" />
              <div>
                <div className="eyebrow">SHOT CALCULATOR</div>
                <h3 className="section-heading">U-100 Syringe Reconstitution</h3>
              </div>
            </div>
            {recon ? (
              <span className="pill pill-accent num" style={{ fontSize: '0.85rem', padding: '0.3rem 0.75rem' }}>
                Draw {Number(recon.unitsPerDose).toFixed(1).replace(/\.0$/, '')} units
              </span>
            ) : null}
          </div>

          <div className="grid-3">
            <label className="field-label">
              Vial Size (mg)
              <input type="number" step="any" name="vialMg" value={vialMg} onChange={(e) => setVialMg(e.target.value)} />
            </label>
            <label className="field-label">
              BAC Water Diluent (mL)
              <input type="number" step="any" name="diluentMl" value={diluentMl} onChange={(e) => setDiluentMl(e.target.value)} />
            </label>
            <label className="field-label">
              Target Dose (mcg)
              <input type="number" step="any" name="doseMcg" value={targetMcg} onChange={(e) => setTargetMcg(e.target.value)} />
            </label>
          </div>

          {recon ? (
            <div className="stack-sm">
              <div className="syringe-track" aria-hidden="true">
                <div
                  className="syringe-fill"
                  style={{ width: `${Math.min(100, Math.max(4, Number(recon.unitsPerDose)))}%` }}
                />
              </div>
              <div className="banner-ok num space-between">
                <span>
                  <strong>{Number(recon.unitsPerDose).toFixed(1).replace(/\.0$/, '')} units</strong> ({Number(recon.mlPerDose).toFixed(2)} mL on U-100 syringe)
                </span>
                <span>
                  {Math.round(recon.mcgPerMl)} mcg/mL · {Math.floor(recon.dosesPerVial)} doses/vial
                </span>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Enter positive vial mg, diluent mL, and target mcg.</p>
          )}
        </section>
      ) : null}

      {oilMath ? (
        <section className="glass stack-sm">
          <div className="eyebrow">OIL CONCENTRATION DRAW</div>
          <div className="banner-ok num">
            {sd.oilConcentrationMgPerMl} mg/mL → Draw <strong>{oilMath.mlPerDose.toFixed(2)} mL</strong> ({Math.round(oilMath.unitsPerDose)} U-100 ticks)
          </div>
        </section>
      ) : null}

      {compound.sectionId === 'dermatology' && (sd.vehicleType || sd.layeringStep || sd.amPmSuitability) ? (
        <section className="card stack-sm">
          <div className="eyebrow">DERMATOLOGY APPLICATION SPEC</div>
          <div className="grid-4">
            <div className="metric-tile">
              <span className="metric-label">Vehicle</span>
              <span className="metric-value">{(sd.vehicleType || '—').replace(/_/g, ' ')}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Layer Step</span>
              <span className="metric-value num">{sd.layeringStep ? `Step ${sd.layeringStep} of 7` : '—'}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">AM / PM</span>
              <span className="metric-value">{(sd.amPmSuitability || 'both').replace(/_/g, ' ')}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Wait / Photo</span>
              <span className="metric-value num">
                {sd.waitTimeMinutes ? `${sd.waitTimeMinutes}m` : '0m'} · {sd.photosensitivity ? 'SPF req.' : 'Non-photo'}
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {/* Visual Half-Life Decay Curve when numeric half-life is modeled */}
      {compound.halfLife?.valueHours ? (
        <HalfLifeCurve halfLifeHours={compound.halfLife.valueHours} displayText={compound.halfLife.displayText} />
      ) : null}

      {/* Section Custom Fields */}
      {compound.customFields && Object.keys(compound.customFields).length > 0 ? (
        <section className="card stack-sm">
          <div className="eyebrow">CUSTOM SECTION FIELDS</div>
          <div className="grid-2">
            {Object.entries(compound.customFields).map(([key, val]) => {
              const def = (section?.customFields || []).find((f) => f.key === key);
              const label = def?.label || key;
              const display = Array.isArray(val)
                ? val.join(', ')
                : typeof val === 'boolean'
                  ? (val ? 'Yes' : 'No')
                  : val == null
                    ? '—'
                    : String(val);
              return (
                <div key={key} className="metric-tile">
                  <span className="metric-label">{label}</span>
                  <span style={{ fontWeight: 600 }}>{display}{def?.unit ? ` ${def.unit}` : ''}</span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Provenance & Citations */}
      {(compound.provenance?.citations || []).length > 0 ? (
        <section className="card stack-sm">
          <div className="space-between">
            <div className="eyebrow">SOURCES &amp; EVIDENCE</div>
            <span className="pill">
              {compound.provenance.sourceModel || 'manual'} · {(compound.provenance.evidenceTier || 'reference').replace(/_/g, ' ')}
            </span>
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.15rem' }}>
            {compound.provenance.citations.map((c, idx) => (
              <li key={idx} style={{ marginBottom: 4 }}>
                <a href={c.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                  {c.title || c.url} <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
                </a>
                {c.pmid ? <span className="dim"> (PMID: {c.pmid})</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="dim row-wrap" style={{ justifyContent: 'center' }}>
        <ShieldAlert size={13} />
        <span>Educational reference profile — verify dosages, solvents, and lab monitoring with a clinician.</span>
      </div>
    </div>
  );
}
