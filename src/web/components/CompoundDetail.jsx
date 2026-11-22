import React, { useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Edit3, Syringe, ShieldAlert, ExternalLink } from 'lucide-react';
import {
  PK_DISCLAIMER,
  OWNERSHIP_STATUSES,
  resolveEffectiveOwnership,
  vialMath,
  oilDrawMath,
} from '../../core/index.js';
import { api } from '../lib/api.js';

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
      setMsg(`Ownership updated to ${nextStatus.replace(/_/g, ' ')} (${nextScope}).`);
      await onRefresh();
    } catch (err) {
      setMsg(err.message || 'Failed to update ownership.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setBusy(true);
    try {
      await api.post(`/api/v1/compounds/${encodeURIComponent(compound.id)}/verify`, {});
      setMsg('Profile verified!');
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
      setMsg('Compound profile saved.');
      await onRefresh();
    } catch (err) {
      setMsg(err.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-v" data-testid="compound-detail">
      <div className="space-between">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          <ArrowLeft size={14} /> Back to Sections
        </button>
        <div className="row-wrap">
          {compound.profileStatus !== 'verified' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-testid="btn-verify-compound"
              onClick={handleVerify}
              disabled={busy}
            >
              <CheckCircle2 size={14} /> Verify Profile
            </button>
          ) : (
            <span className="pill pill-verified">
              <CheckCircle2 size={12} /> Verified
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-edit-compound"
            onClick={() => setEditing((v) => !v)}
          >
            <Edit3 size={14} /> {editing ? 'Cancel Edit' : 'Edit Profile'}
          </button>
        </div>
      </div>

      {msg ? (
        <div className="banner-ok" role="status">
          {msg}
        </div>
      ) : null}

      <section className="card stack-v">
        <div className="space-between">
          <div>
            <h1 style={{ margin: 0, fontSize: '1.6rem', color: 'var(--gold)' }}>{compound.name}</h1>
            <div className="row-wrap" style={{ marginTop: '0.35rem' }}>
              <span className="pill">{section?.name || compound.sectionId}</span>
              {compound.subsection ? <span className="pill">{compound.subsection}</span> : null}
              {compound.dosages?.route ? <span className="pill">{compound.dosages.route}</span> : null}
              {compound.provenance?.evidenceTier ? <span className="pill">{compound.provenance.evidenceTier}</span> : null}
              <span className="pill num">Completeness: {compound.completenessPct ?? 0}%</span>
            </div>
          </div>

          <div className="row-wrap">
            <label className="field-label" style={{ minWidth: 150 }}>
              Ownership Status
              <select
                data-testid="ownership-status-select"
                value={ownStatus}
                onChange={(e) => handleOwnershipChange(e.target.value, ownScope)}
                disabled={busy}
              >
                {OWNERSHIP_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label" style={{ minWidth: 140 }}>
              Scope
              <select
                aria-label="Ownership scope"
                value={ownScope}
                onChange={(e) => handleOwnershipChange(ownStatus, e.target.value)}
                disabled={busy}
              >
                <option value="household">Shared (Household)</option>
                <option value={`member:${activeMemberId}`}>Personal ({activeMemberId})</option>
              </select>
            </label>
          </div>
        </div>

        {editing ? (
          <form onSubmit={handleSaveEdit} className="stack-v">
            <label className="field-label">
              Summary
              <textarea name="summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </label>
            <label className="field-label">
              Mechanism of Action
              <textarea name="mechanismOfAction" rows={3} value={mechanismOfAction} onChange={(e) => setMechanismOfAction(e.target.value)} />
            </label>
            <label className="field-label">
              Dosage Range
              <input type="text" name="rangeText" value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
            </label>
            <label className="field-label">
              Personal Reference Notes
              <textarea name="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <div>
              <button type="submit" className="btn btn-primary" data-testid="btn-save-compound" disabled={busy}>
                Save Changes
              </button>
            </div>
          </form>
        ) : (
          <div className="stack-v">
            <div>
              <h3 style={{ margin: '0 0 0.25rem' }}>What It Is</h3>
              <p style={{ margin: 0 }}>{compound.summary || 'No summary provided.'}</p>
              {compound.detailedDescription ? <p className="muted">{compound.detailedDescription}</p> : null}
            </div>
            <div>
              <h3 style={{ margin: '0 0 0.25rem' }}>Mechanism of Action</h3>
              <p style={{ margin: 0 }}>{compound.mechanismOfAction || 'Not documented yet.'}</p>
            </div>
            {(compound.useCaseScenarios || []).length > 0 ? (
              <div>
                <h3 style={{ margin: '0 0 0.25rem' }}>Use Cases &amp; Benefits</h3>
                <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                  {compound.useCaseScenarios.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="card stack-v">
          <h3 style={{ margin: 0, color: 'var(--gold)' }}>Dosing, Timing &amp; Cycles</h3>
          <div className="num"><strong>Range:</strong> {compound.dosages?.rangeText || '—'}</div>
          <div><strong>Frequency:</strong> {compound.dosages?.frequencyText || '—'}</div>
          <div><strong>Preferred Slots:</strong> {(compound.timingRules?.preferredSlots || []).join(', ') || 'Flexible'}</div>
          <div><strong>Food State:</strong> {compound.timingRules?.foodState || 'any'}</div>
          <div><strong>Half-Life:</strong> {compound.halfLife?.displayText || (compound.halfLife?.valueHours ? `${compound.halfLife.valueHours} hours` : 'Unmodeled')}</div>
          <div><strong>Cycles:</strong> {compound.cycles?.patternText || (compound.cycles?.continuous ? 'Continuous' : '—')}</div>
          {compound.storageNotes ? <div><strong>Storage:</strong> {compound.storageNotes}</div> : null}
          <p className="muted" style={{ fontSize: '0.78rem', margin: 0 }}>{PK_DISCLAIMER}</p>
        </section>

        <section className="card stack-v">
          <h3 style={{ margin: 0, color: 'var(--gold)' }}>Interactions, Contraindications &amp; Labs</h3>
          {(compound.doNotPairWith || []).length > 0 ? (
            <div className="stack-v">
              <strong>What NOT to Pair With:</strong>
              {compound.doNotPairWith.map((rule, i) => (
                <div key={i} className={rule.severity === 'hard_stop' ? 'banner-danger' : 'banner-warn'}>
                  <strong>{rule.targetRef}</strong> ({rule.severity}{rule.separationHours ? `, ≥${rule.separationHours}h` : ''}): {rule.recommendation || rule.mechanism}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>No compound-specific pairing conflicts listed (global pharmacology interaction bank still applies in Stack Builder).</p>
          )}
          {(compound.synergies || []).length > 0 ? (
            <div>
              <strong>Synergies:</strong>{' '}
              {compound.synergies.map((s) => `${s.targetRef} (${s.reason})`).join('; ')}
            </div>
          ) : null}
          {(compound.monitoringLabs || []).length > 0 ? (
            <div>
              <strong>Monitoring Labs:</strong> {compound.monitoringLabs.join(', ')}
            </div>
          ) : null}
        </section>
      </div>

      {/* Peptides U-100 Reconstitution Calculator */}
      {compound.sectionId === 'peptides' ? (
        <section className="card stack-v" data-testid="reconstitution-calc">
          <div className="row-wrap">
            <Syringe size={18} color="var(--emerald)" />
            <h3 style={{ margin: 0, color: 'var(--gold)' }}>U-100 Syringe Reconstitution Calculator</h3>
          </div>
          <div className="grid-3">
            <label className="field-label">
              Vial Size (mg)
              <input type="number" step="any" name="vialMg" value={vialMg} onChange={(e) => setVialMg(e.target.value)} />
            </label>
            <label className="field-label">
              Diluent Volume (mL)
              <input type="number" step="any" name="diluentMl" value={diluentMl} onChange={(e) => setDiluentMl(e.target.value)} />
            </label>
            <label className="field-label">
              Target Dose (mcg)
              <input type="number" step="any" name="doseMcg" value={targetMcg} onChange={(e) => setTargetMcg(e.target.value)} />
            </label>
          </div>
          {recon ? (
            <div className="banner-ok num">
              <strong>Draw: {Number(recon.unitsPerDose).toFixed(1).replace(/\.0$/, '')} units</strong> ({Number(recon.mlPerDose).toFixed(2)} mL on a U-100 syringe) — Concentration: {Math.round(recon.mcgPerMl)} mcg/mL ({Math.floor(recon.dosesPerVial)} doses/vial)
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Enter positive vial mg, diluent mL, and target mcg to calculate syringe draw.</p>
          )}
        </section>
      ) : null}

      {oilMath ? (
        <section className="card stack-v">
          <h3 style={{ margin: 0, color: 'var(--gold)' }}>Pre-Mixed Oil Concentration Draw</h3>
          <div className="banner-ok num">
            Concentration: {compound.sectionData.oilConcentrationMgPerMl} mg/mL → Draw {oilMath.mlPerDose.toFixed(2)} mL ({Math.round(oilMath.unitsPerDose)} U-100 ticks)
          </div>
        </section>
      ) : null}

      {/* Section Custom Fields */}
      {compound.customFields && Object.keys(compound.customFields).length > 0 ? (
        <section className="card stack-v">
          <h3 style={{ margin: 0, color: 'var(--gold)' }}>Custom Section Fields</h3>
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
                <div key={key}>
                  <strong>{label}:</strong>{' '}
                  <span>{display}{def?.unit ? ` ${def.unit}` : ''}</span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Citations & Provenance */}
      {(compound.provenance?.citations || []).length > 0 ? (
        <section className="card stack-v">
          <h3 style={{ margin: 0, color: 'var(--gold)' }}>Provenance &amp; Citations</h3>
          <div className="muted">
            Source: {compound.provenance.sourceModel || 'manual'} | Evidence Tier: {compound.provenance.evidenceTier || 'working_hypothesis'}
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {compound.provenance.citations.map((c, idx) => (
              <li key={idx}>
                <a href={c.url} target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)' }}>
                  {c.title || c.url} <ExternalLink size={12} />
                </a>
                {c.pmid ? ` (PMID: ${c.pmid})` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="banner-warn" style={{ fontSize: '0.82rem' }}>
        <ShieldAlert size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
        Personal educational reference profile — verify dosages, reconstitution solvents, and lab monitoring with a licensed clinician.
      </div>
    </div>
  );
}
