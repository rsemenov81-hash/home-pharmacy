import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Edit3,
  ShieldAlert,
  ExternalLink,
  Sparkles,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import {
  PK_DISCLAIMER,
  OWNERSHIP_STATUSES,
  resolveEffectiveOwnership,
  vialMath,
  oilDrawMath,
} from '../../core/index.js';
import { api } from '../lib/api.js';

function GraduatedSyringeBarrel({ units }) {
  const clamped = Math.max(0, Math.min(100, Number(units) || 0));
  const fillW = (clamped / 100) * 440;
  const ticks = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  return (
    <svg
      viewBox="0 0 560 72"
      className="syringe-svg"
      role="img"
      aria-label={`U-100 insulin syringe draw gauge showing ${clamped.toFixed(1)} units`}
    >
      <defs>
        <linearGradient id="hpBarrelLiquid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.92" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.52" />
        </linearGradient>
        <linearGradient id="hpGlassGlare" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="45%" stopColor="#ffffff" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.06" />
        </linearGradient>
      </defs>

      {/* Needle hub */}
      <line x1="8" y1="28" x2="36" y2="28" stroke="var(--ink-dim)" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="36" y="21" width="14" height="14" rx="3" fill="var(--surface-well-strong)" stroke="var(--hair-strong)" strokeWidth="1" />

      {/* Plunger rod */}
      <rect x={56 + fillW} y="25" width={Math.max(18, 464 - fillW)} height="6" rx="2" fill="var(--surface-well-strong)" />
      <rect x="520" y="14" width="8" height="28" rx="3" fill="var(--ink-dim)" opacity="0.55" />

      {/* Translucent syringe barrel */}
      <rect x="52" y="10" width="452" height="36" rx="8" fill="var(--surface-well)" stroke="var(--hair-strong)" strokeWidth="1.2" />

      {/* Golden liquid draw column */}
      {fillW > 0 ? (
        <rect x="54" y="12" width={fillW} height="32" rx="6" fill="url(#hpBarrelLiquid)" />
      ) : null}

      {/* Plunger rubber stopper */}
      <rect x={Math.min(496, 54 + fillW)} y="12" width="7" height="32" rx="2" fill="var(--ink)" opacity="0.72" />

      {/* Glass specular sheen */}
      <rect x="53" y="11" width="450" height="14" rx="6" fill="url(#hpGlassGlare)" pointerEvents="none" />

      {/* Graduated tick marks */}
      {ticks.map((t) => {
        const x = 56 + (t / 100) * 440;
        const major = t % 20 === 0;
        return (
          <g key={t}>
            <line
              x1={x}
              y1={major ? 34 : 38}
              x2={x}
              y2={46}
              stroke="var(--ink-2)"
              strokeOpacity={major ? 0.55 : 0.3}
              strokeWidth={major ? 1.2 : 0.9}
            />
            {major ? (
              <text
                x={x}
                y="62"
                textAnchor="middle"
                fontSize="10"
                fill="var(--ink-dim)"
                fontFamily="var(--mono)"
              >
                {t}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function HalfLifeCurve({ halfLifeHours }) {
  const points = useMemo(() => {
    if (!halfLifeHours || !Number.isFinite(halfLifeHours) || halfLifeHours <= 0) return null;
    const maxH = halfLifeHours * 5;
    const pts = [];
    for (let i = 0; i <= 50; i += 1) {
      const t = (i / 50) * maxH;
      const pct = Math.pow(0.5, t / halfLifeHours);
      const x = 16 + (i / 50) * 608;
      const y = 104 - pct * 84;
      pts.push({ x, y });
    }
    const linePath = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L624,104 L16,104 Z`;
    return { linePath, areaPath, maxH };
  }, [halfLifeHours]);

  if (!points) return null;

  const fmtSpan = (h) => (h >= 48 ? `${(h / 24).toFixed(1).replace(/\.0$/, '')}d` : `${Number(h.toFixed(1))}h`);

  return (
    <section className="atelier-card stack-sm">
      <div className="space-between">
        <div>
          <div className="eyebrow">PHARMACOKINETICS</div>
          <h3 className="display-sm" style={{ marginTop: 2 }}>Elimination Curve</h3>
        </div>
        <span className="pill pill-accent mono">t½ ~{fmtSpan(halfLifeHours)}</span>
      </div>

      <svg
        viewBox="0 0 640 132"
        className="pk-svg"
        role="img"
        aria-label={`Exponential decay curve for half-life ${halfLifeHours} hours`}
      >
        <defs>
          <linearGradient id="hpPkWash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <line x1="16" y1="104" x2="624" y2="104" stroke="var(--hair)" strokeWidth="1" />
        <line x1="16" y1="62" x2="624" y2="62" stroke="var(--hair-subtle)" strokeWidth="1" strokeDasharray="3 5" />
        <line x1="137.6" y1="20" x2="137.6" y2="104" stroke="var(--hair-subtle)" strokeWidth="1" strokeDasharray="3 4" />
        <path d={points.areaPath} fill="url(#hpPkWash)" />
        <path d={points.linePath} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="16" cy="20" r="4" fill="var(--accent)" />
        <circle cx="137.6" cy="62" r="4.5" fill="var(--surface)" stroke="var(--success)" strokeWidth="2.2" />
        <text x="16" y="124" fontSize="10.5" fill="var(--ink-dim)" fontFamily="var(--mono)">0h · 100%</text>
        <text x="148" y="57" fontSize="10.5" fill="var(--success)" fontFamily="var(--mono)">
          1× t½ ({fmtSpan(halfLifeHours)} · 50%)
        </text>
        <text x="624" y="124" fontSize="10.5" fill="var(--ink-dim)" textAnchor="end" fontFamily="var(--mono)">
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
          ...(compound.dosages || {}),
          rangeText,
        },
      });
      setEditing(false);
      setMsg('Saved monograph changes.');
      await onRefresh();
    } catch (err) {
      setMsg(err.message || 'Could not save changes.');
    } finally {
      setBusy(false);
    }
  };

  const customFieldEntries = Object.entries(compound.customFields || {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  const sectionFieldLabelMap = new Map(
    (section?.customFields || []).map((f) => [f.key, f.label || f.key]),
  );

  const doseHero =
    compound.dosages?.defaultAmount != null && compound.dosages?.defaultUnit
      ? `${compound.dosages.defaultAmount} ${compound.dosages.defaultUnit}`
      : (compound.dosages?.rangeText || 'See notes').split('(')[0].trim();

  const hlHero =
    typeof compound.halfLife?.valueHours === 'number' && Number.isFinite(compound.halfLife.valueHours)
      ? compound.halfLife.valueHours >= 48
        ? `~${Number((compound.halfLife.valueHours / 24).toFixed(1))}d`
        : `~${Number(compound.halfLife.valueHours.toFixed(1))}h`
      : (compound.halfLife?.displayText || 'Unmodeled').split('(')[0].trim();

  return (
    <div className="stack-v" data-testid="compound-detail">
      {/* Quiet Top Bar */}
      <div className="space-between">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={1.8} /> Library
        </button>

        <div className="row-wrap">
          {compound.profileStatus !== 'verified' ? (
            <button
              type="button"
              className="btn btn-success btn-sm"
              data-testid="btn-verify-compound"
              disabled={busy}
              onClick={handleVerify}
            >
              <CheckCircle2 size={14} strokeWidth={1.8} /> Verify Profile
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-edit-compound"
            onClick={() => setEditing((v) => !v)}
          >
            <Edit3 size={13} strokeWidth={1.8} /> {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {msg ? (
        <div className="banner-ok" role="status">
          {msg}
        </div>
      ) : null}

      {/* Editorial Monograph Hero Sheet */}
      <section className="atelier-card stack-v">
        <div>
          <div className="space-between" style={{ alignItems: 'center' }}>
            <div className="eyebrow">
              {section?.name || compound.sectionId}
              {compound.subsection ? ` · ${compound.subsection}` : ''}
            </div>
            <div className="row-wrap" style={{ gap: '0.35rem' }}>
              <span className={`pill pill-${compound.profileStatus || 'verified'}`}>
                {compound.profileStatus === 'verified' ? <CheckCircle2 size={10} /> : <Sparkles size={10} />}
                {(compound.profileStatus || 'verified').replace(/_/g, ' ')}
              </span>
              {typeof compound.completenessPct === 'number' ? (
                <span className="pill mono">{compound.completenessPct}%</span>
              ) : null}
            </div>
          </div>

          <h1 className="editorial-title" style={{ marginTop: 8 }}>{compound.name}</h1>

          {(compound.aliases || []).length > 0 ? (
            <div className="italic-sub" style={{ marginTop: 4 }}>
              Also known as {(compound.aliases || []).join(', ')}
            </div>
          ) : null}
        </div>

        {/* Oura / Protocol-OS Hairline 4-Column Stat Ribbon (ZERO nested boxes!) */}
        <div className="stat-ribbon">
          <div className="stat-cell">
            <span className="stat-k">Typical Dose</span>
            <span className="stat-v">{doseHero}</span>
            <span className="stat-sub">{compound.dosages?.frequencyText || 'See protocol'}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-k">Route</span>
            <span className="stat-v">{compound.dosages?.route || 'Standard'}</span>
            <span className="stat-sub">
              {(compound.timingRules?.preferredSlots || []).slice(0, 2).map((s) => s.replace(/_/g, ' ')).join(', ') || 'Flexible timing'}
            </span>
          </div>
          <div className="stat-cell">
            <span className="stat-k">Half-Life</span>
            <span className="stat-v">{hlHero}</span>
            <span className="stat-sub">{compound.halfLife?.kind || 'reference'}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-k">Cycle</span>
            <span className="stat-v" style={{ fontSize: '0.96rem' }}>
              {compound.cycles?.continuous ? 'Continuous' : (compound.cycles?.patternText || 'Cycled').split(',')[0]}
            </span>
            <span className="stat-sub">
              Food: {(compound.timingRules?.foodState || 'any').replace(/_/g, ' ')}
            </span>
          </div>
        </div>

        {/* Sleek Inline Cabinet Ownership Row */}
        <div
          className="space-between"
          style={{ paddingTop: '0.95rem', borderTop: '1px solid var(--hair-subtle)' }}
        >
          <div>
            <div className="eyebrow">CABINET STATUS</div>
            <div className="dim" style={{ marginTop: 2 }}>
              Mark whether you have this on hand or want to add it to your wishlist.
            </div>
          </div>
          <div className="row-wrap">
            <div className="select-pill">
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
              <ChevronDown size={12} strokeWidth={1.8} className="sel-chev" aria-hidden="true" />
            </div>

            <div className="select-pill">
              <select
                aria-label="Ownership scope"
                value={ownScope}
                disabled={busy}
                onChange={(e) => handleOwnershipChange(ownStatus, e.target.value)}
              >
                <option value="household">Shared Household</option>
                <option value={`member:${activeMemberId}`}>Personal Only</option>
              </select>
              <ChevronDown size={12} strokeWidth={1.8} className="sel-chev" aria-hidden="true" />
            </div>
          </div>
        </div>
      </section>

      {/* Edit Form */}
      {editing ? (
        <form onSubmit={handleSaveEdit} className="atelier-card stack-v">
          <h2 className="display-sm">Edit Monograph</h2>
          <label className="field-label">
            Summary
            <textarea name="summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="field-label">
            Mechanism of Action
            <textarea
              name="mechanismOfAction"
              rows={3}
              value={mechanismOfAction}
              onChange={(e) => setMechanismOfAction(e.target.value)}
            />
          </label>
          <div className="grid-2">
            <label className="field-label">
              Dosage Range
              <input type="text" name="rangeText" value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
            </label>
            <label className="field-label">
              Notes
              <input type="text" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </div>
          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" data-testid="btn-save-compound" disabled={busy}>
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Peptide Precision U-100 Syringe Instrument */}
      {compound.sectionId === 'peptides' ? (
        <section className="draw-instrument" data-testid="reconstitution-calc">
          <div className="space-between">
            <div>
              <div className="eyebrow">THE DRAW · U-100 INSULIN SYRINGE</div>
              <h2 className="display-sm" style={{ marginTop: 2 }}>Reconstitution Instrument</h2>
            </div>
            {recon ? (
              <span className="pill mono">{Math.round(recon.mcgPerMl)} mcg/mL</span>
            ) : null}
          </div>

          {recon ? (
            <>
              <div className="draw-readout">
                <div className="draw-big">
                  <span className="draw-num">{Number(recon.unitsPerDose).toFixed(1)}</span>
                  <span className="draw-unit">units</span>
                </div>
                <div className="draw-meta">
                  <div>{Number(recon.mlPerDose).toFixed(2)} mL draw · {targetMcg} mcg</div>
                  <div>{recon.dosesPerVial} doses per {vialMg} mg vial</div>
                </div>
              </div>
              <GraduatedSyringeBarrel units={recon.unitsPerDose} />
            </>
          ) : (
            <p className="muted" style={{ margin: '0.65rem 0 1rem' }}>
              Enter positive vial size, diluent volume, and target dose to calibrate the syringe gauge.
            </p>
          )}

          <div className="grid-3">
            <label className="field-label">
              Vial Size (mg)
              <input
                type="number"
                step="any"
                name="vialMg"
                aria-label="Vial mg"
                value={vialMg}
                onChange={(e) => setVialMg(e.target.value)}
              />
            </label>
            <label className="field-label">
              BAC Water (mL)
              <input
                type="number"
                step="any"
                name="diluentMl"
                aria-label="Diluent mL"
                value={diluentMl}
                onChange={(e) => setDiluentMl(e.target.value)}
              />
            </label>
            <label className="field-label">
              Target Dose (mcg)
              <input
                type="number"
                step="any"
                name="targetDoseMcg"
                aria-label="Target dose mcg"
                value={targetMcg}
                onChange={(e) => setTargetMcg(e.target.value)}
              />
            </label>
          </div>
        </section>
      ) : null}

      {/* PED Oil Draw Spec & Harm Reduction */}
      {compound.sectionId === 'peds' && (oilMath || compound.sectionData?.harmReductionFlags) ? (
        <section className="atelier-card stack-sm">
          <div className="eyebrow">HARM REDUCTION &amp; OIL DRAW</div>
          {oilMath ? (
            <div className="draw-readout" style={{ margin: '0.25rem 0 0.4rem' }}>
              <div className="draw-big">
                <span className="draw-num" style={{ fontSize: '2rem' }}>{Number(oilMath.mlPerDose).toFixed(2)}</span>
                <span className="draw-unit">mL ({Number(oilMath.unitsPerDose).toFixed(1)} units)</span>
              </div>
              <div className="draw-meta">
                Pre-mixed oil · {compound.sectionData.oilConcentrationMgPerMl} mg/mL
              </div>
            </div>
          ) : null}
          {compound.sectionData?.harmReductionFlags?.highVirilizationRiskForWomen ? (
            <div className="banner-danger">
              <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              <strong>Female Virilization Caution:</strong> High androgenic risk for female users.
            </div>
          ) : null}
          {compound.sectionData?.harmReductionFlags?.hepatotoxic17aa ? (
            <div className="banner-warn">
              <strong>17α-Alkylated Hepatotoxicity:</strong> Never stack with another 17aa oral compound; monitor ALT/AST/GGT.
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Dermatology Layering Spec Ribbon */}
      {compound.sectionId === 'dermatology' && compound.sectionData ? (
        <section className="atelier-card stack-sm">
          <div className="eyebrow">DERMATOLOGY PROTOCOL SPECIFICATIONS</div>
          <div className="stat-ribbon" style={{ borderTop: 'none', paddingTop: '0.35rem' }}>
            <div className="stat-cell">
              <span className="stat-k">Layer Step</span>
              <span className="stat-v">
                {compound.sectionData.layerOrder != null ? `Step 0${compound.sectionData.layerOrder}` : '—'}
              </span>
            </div>
            <div className="stat-cell">
              <span className="stat-k">Vehicle</span>
              <span className="stat-v" style={{ fontSize: '0.96rem' }}>
                {(compound.sectionData.vehicleType || 'Topical').replace(/_/g, ' ')}
              </span>
            </div>
            <div className="stat-cell">
              <span className="stat-k">Sun Sensitivity</span>
              <span className="stat-v" style={{ fontSize: '0.96rem' }}>
                {compound.sectionData.photosensitizing ? 'PM Only + SPF' : 'Day Safe'}
              </span>
            </div>
            <div className="stat-cell">
              <span className="stat-k">Target Area</span>
              <span className="stat-v" style={{ fontSize: '0.96rem' }}>
                {(compound.sectionData.targetArea || 'Face').replace(/_/g, ' ')}
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {/* Elimination Curve */}
      {compound.halfLife?.valueHours ? (
        <HalfLifeCurve halfLifeHours={compound.halfLife.valueHours} />
      ) : null}

      {/* Editorial Clinical Monograph Body */}
      <section className="atelier-card stack-v">
        <div>
          <div className="eyebrow">OVERVIEW</div>
          <p style={{ margin: '0.45rem 0 0', color: 'var(--ink-2)', lineHeight: 1.65 }}>
            {compound.summary}
          </p>
          {compound.detailedDescription && compound.detailedDescription !== compound.summary ? (
            <p className="muted" style={{ margin: '0.55rem 0 0', lineHeight: 1.65 }}>
              {compound.detailedDescription}
            </p>
          ) : null}
        </div>

        {compound.mechanismOfAction ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }}>
            <div className="eyebrow">MECHANISM OF ACTION</div>
            <p style={{ margin: '0.45rem 0 0', color: 'var(--ink-2)', lineHeight: 1.65 }}>
              {compound.mechanismOfAction}
            </p>
          </div>
        ) : null}

        {(compound.useCaseScenarios || []).length > 0 ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }}>
            <div className="eyebrow">KEY APPLICATIONS</div>
            <div className="cat-pills" style={{ marginTop: '0.55rem' }}>
              {compound.useCaseScenarios.map((u, idx) => (
                <span key={idx} className="pill">{u}</span>
              ))}
            </div>
          </div>
        ) : null}

        {(compound.dosages?.rangeText || compound.timingRules?.timingNotes) ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }}>
            <div className="eyebrow">DOSING &amp; TIMING NOTES</div>
            {compound.dosages?.rangeText ? (
              <p className="muted" style={{ margin: '0.45rem 0 0' }}>
                <strong style={{ color: 'var(--ink)' }}>Range:</strong> {compound.dosages.rangeText}
              </p>
            ) : null}
            {compound.timingRules?.timingNotes ? (
              <p className="muted" style={{ margin: '0.3rem 0 0' }}>
                {compound.timingRules.timingNotes}
              </p>
            ) : null}
            {compound.halfLife?.displayText ? (
              <p className="dim" style={{ margin: '0.3rem 0 0' }}>
                Half-life note: {compound.halfLife.displayText}
              </p>
            ) : null}
          </div>
        ) : null}

        {(compound.doNotPairWith || []).length > 0 ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }} className="stack-sm">
            <div className="eyebrow" style={{ color: 'var(--danger)' }}>DO NOT PAIR WITH</div>
            {compound.doNotPairWith.map((rule, idx) => (
              <div
                key={idx}
                className={rule.severity === 'hard_stop' ? 'banner-danger' : 'banner-warn'}
              >
                <div className="space-between" style={{ marginBottom: 4 }}>
                  <strong style={{ fontSize: '0.88rem' }}>{rule.targetRef.replace(/_/g, ' ')}</strong>
                  <span className={`pill mono ${rule.severity === 'hard_stop' ? 'pill-danger' : 'pill-ai_draft'}`}>
                    {rule.severity.replace(/_/g, ' ')}
                    {rule.separationHours ? ` · ${rule.separationHours}h apart` : ''}
                  </span>
                </div>
                <div style={{ fontSize: '0.83rem' }}>{rule.recommendation || rule.mechanism}</div>
              </div>
            ))}
          </div>
        ) : null}

        {(compound.synergies || []).length > 0 ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }} className="stack-sm">
            <div className="eyebrow" style={{ color: 'var(--success)' }}>SYNERGIES</div>
            {compound.synergies.map((syn, idx) => (
              <div key={idx} className="banner-ok">
                <strong>{syn.targetRef.replace(/_/g, ' ')}</strong> — {syn.reason}
              </div>
            ))}
          </div>
        ) : null}

        {(compound.monitoringLabs || []).length > 0 || compound.storageNotes ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }} className="stack-sm">
            {(compound.monitoringLabs || []).length > 0 ? (
              <div>
                <div className="eyebrow">MONITORING LABS</div>
                <div className="cat-pills" style={{ marginTop: '0.45rem' }}>
                  {compound.monitoringLabs.map((lab, i) => (
                    <span key={i} className="pill">{lab}</span>
                  ))}
                </div>
              </div>
            ) : null}
            {compound.storageNotes ? (
              <p className="muted" style={{ margin: '0.35rem 0 0' }}>
                <strong style={{ color: 'var(--ink)' }}>Storage:</strong> {compound.storageNotes}
              </p>
            ) : null}
          </div>
        ) : null}

        {customFieldEntries.length > 0 ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }} className="stack-sm">
            <div className="eyebrow">CUSTOM SECTION FIELDS</div>
            {customFieldEntries.map(([key, val]) => {
              const displayVal = Array.isArray(val) ? val.join(', ') : String(val);
              const isUrl = typeof val === 'string' && /^https?:\/\//i.test(val);
              return (
                <div key={key} className="space-between" style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--hair-subtle)' }}>
                  <span className="muted">{sectionFieldLabelMap.get(key) || key}</span>
                  {isUrl ? (
                    <a href={val} target="_blank" rel="noopener noreferrer" className="row-wrap" style={{ fontSize: '0.84rem', gap: '0.3rem' }}>
                      {displayVal} <ExternalLink size={12} />
                    </a>
                  ) : (
                    <strong className="mono" style={{ fontSize: '0.84rem' }}>{displayVal}</strong>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {(compound.provenance?.citations || []).length > 0 ? (
          <div style={{ paddingTop: '1rem', borderTop: '1px solid var(--hair-subtle)' }} className="stack-sm">
            <div className="eyebrow">LITERATURE CITATIONS</div>
            <div className="row-wrap">
              {compound.provenance.citations.map((cit, i) => (
                <a
                  key={i}
                  href={cit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm"
                >
                  {cit.title || cit.url} <ExternalLink size={11} />
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
