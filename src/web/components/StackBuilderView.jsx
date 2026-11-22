import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, AlertOctagon, AlertTriangle, Pin, CheckCircle2, Sparkles, FlaskConical } from 'lucide-react';
import { SYSTEMIC_SLOTS, dkToday } from '../../core/index.js';
import { api } from '../lib/api.js';

export function StackBuilderView({
  members,
  activeMemberId,
  compounds,
  stacks,
  onRefresh,
}) {
  const memberStacks = useMemo(
    () => (stacks || []).filter((s) => s.memberId === activeMemberId),
    [stacks, activeMemberId],
  );
  const [selectedStackId, setSelectedStackId] = useState('');
  const [haveOnly, setHaveOnly] = useState(false);
  const [whatIfEnabled, setWhatIfEnabled] = useState(false);
  const [whatIfIds, setWhatIfIds] = useState([]);
  const [spread, setSpread] = useState(null);
  const [loadingSpread, setLoadingSpread] = useState(false);
  const [showNewStack, setShowNewStack] = useState(false);
  const [newStackName, setNewStackName] = useState('');
  const [pinEditingId, setPinEditingId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [optimisticItemsByStack, setOptimisticItemsByStack] = useState({});

  const pendingOpsRef = useRef(0);
  const queueRef = useRef(Promise.resolve());
  const latestItemsByStackRef = useRef(new Map());

  const activeStack = useMemo(() => {
    if (selectedStackId) {
      const hit = memberStacks.find((s) => s.id === selectedStackId);
      if (hit) return hit;
    }
    return memberStacks.find((s) => s.active !== false) || memberStacks[0] || null;
  }, [memberStacks, selectedStackId]);

  useEffect(() => {
    if (pendingOpsRef.current === 0) {
      const nextMap = new Map();
      for (const st of memberStacks) {
        nextMap.set(st.id, [...(st.items || [])]);
      }
      latestItemsByStackRef.current = nextMap;
      setOptimisticItemsByStack({});
    }
  }, [memberStacks]);

  useEffect(() => {
    if (activeStack) {
      setSelectedStackId(activeStack.id);
      setHaveOnly(Boolean(activeStack.haveOnly ?? activeStack.onlyOwned));
    } else {
      setSelectedStackId('');
      setSpread(null);
    }
  }, [activeMemberId, activeStack?.id]);

  // Compute dual-track schedule from server whenever activeStack, haveOnly, or whatIfIds change
  useEffect(() => {
    let cancelled = false;
    async function fetchSpread() {
      if (!activeStack) {
        setSpread(null);
        return;
      }
      setLoadingSpread(true);
      setErrorMsg('');
      try {
        const res = await api.post(
          `/api/v1/members/${encodeURIComponent(activeMemberId)}/stacks/${encodeURIComponent(activeStack.id)}/schedule`,
          {
            dateKey: dkToday('UTC'),
            haveOnly,
            whatIfCompounds: whatIfEnabled ? whatIfIds.map((id) => ({ compoundId: id })) : [],
          },
        );
        if (!cancelled) {
          setSpread(res.json?.schedule || res.json?.spread || res.json);
        }
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message || 'Failed to compute schedule.');
      } finally {
        if (!cancelled) setLoadingSpread(false);
      }
    }
    fetchSpread();
    return () => {
      cancelled = true;
    };
  }, [activeMemberId, activeStack?.id, activeStack?.updatedAt, activeStack?.items?.length, haveOnly, whatIfEnabled, whatIfIds.join(',')]);

  const activeMember = members.find((m) => m.id === activeMemberId);
  const effectiveItems = useMemo(() => {
    if (!activeStack) return [];
    if (optimisticItemsByStack[activeStack.id]) return optimisticItemsByStack[activeStack.id];
    return activeStack.items || [];
  }, [activeStack, optimisticItemsByStack]);

  const stackItemIds = useMemo(
    () => new Set(effectiveItems.map((i) => i.compoundId)),
    [effectiveItems],
  );

  const enqueueStackMutation = (fn) => {
    pendingOpsRef.current += 1;
    const run = queueRef.current.catch(() => {}).then(async () => {
      try {
        await fn();
      } finally {
        pendingOpsRef.current = Math.max(0, pendingOpsRef.current - 1);
        if (pendingOpsRef.current === 0) {
          await onRefresh();
        }
      }
    });
    queueRef.current = run.catch(() => {});
    return run;
  };

  const handleCreateStack = async (e) => {
    e.preventDefault();
    const clean = newStackName.trim() || `${activeMember?.name || 'Member'} Stack`;
    setErrorMsg('');
    try {
      const res = await api.post(`/api/v1/members/${encodeURIComponent(activeMemberId)}/stacks`, {
        name: clean,
        active: true,
        haveOnly: false,
        items: [],
      });
      const created = res.json?.stack;
      setNewStackName('');
      setShowNewStack(false);
      await onRefresh();
      if (created?.id) {
        latestItemsByStackRef.current.set(created.id, []);
        setSelectedStackId(created.id);
      }
      setStatusMsg(`Created stack "${clean}".`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not create stack.');
    }
  };

  const handleAddCompound = async (compound) => {
    setErrorMsg('');
    if (whatIfEnabled) {
      setWhatIfIds((prev) => (prev.includes(compound.id) ? prev : [...prev, compound.id]));
      setStatusMsg(`Added "${compound.name}" to What-If preview (non-mutating).`);
      return;
    }

    const memberSnapshot = activeMemberId;
    const stackSnapshot = activeStack;
    const newItem = {
      compoundId: compound.id,
      doseAmount: compound.dosages?.defaultAmount || 1,
      doseUnit: compound.dosages?.defaultUnit || 'mg',
      frequency: 'daily',
    };

    if (stackSnapshot?.id) {
      const cur = latestItemsByStackRef.current.get(stackSnapshot.id) ?? [...(stackSnapshot.items || [])];
      const nextItems = [...cur.filter((i) => i.compoundId !== compound.id), newItem];
      latestItemsByStackRef.current.set(stackSnapshot.id, nextItems);
      setOptimisticItemsByStack((prev) => ({ ...prev, [stackSnapshot.id]: nextItems }));
    }

    await enqueueStackMutation(async () => {
      try {
        let targetId = stackSnapshot?.id || null;
        if (!targetId) {
          const createdRes = await api.post(`/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks`, {
            name: `${activeMember?.name || 'Primary'} Stack`,
            active: true,
            items: [],
          });
          targetId = createdRes.json?.stack?.id;
          if (targetId) {
            latestItemsByStackRef.current.set(targetId, [newItem]);
            setSelectedStackId(targetId);
          }
        }
        if (!targetId) return;
        const nextItems = latestItemsByStackRef.current.get(targetId) || [newItem];
        await api.patch(
          `/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks/${encodeURIComponent(targetId)}`,
          { items: nextItems },
        );
        setSelectedStackId(targetId);
        setStatusMsg(`Added "${compound.name}" to stack.`);
      } catch (err) {
        setErrorMsg(err.message || 'Could not add compound to stack.');
      }
    });
  };

  const handleRemoveFromStack = async (compoundId) => {
    if (!activeStack) return;
    const memberSnapshot = activeMemberId;
    const targetId = activeStack.id;
    const cur = latestItemsByStackRef.current.get(targetId) ?? [...(activeStack.items || [])];
    const nextItems = cur.filter((i) => i.compoundId !== compoundId);
    latestItemsByStackRef.current.set(targetId, nextItems);
    setOptimisticItemsByStack((prev) => ({ ...prev, [targetId]: nextItems }));

    await enqueueStackMutation(async () => {
      try {
        await api.patch(
          `/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks/${encodeURIComponent(targetId)}`,
          { items: latestItemsByStackRef.current.get(targetId) || nextItems },
        );
      } catch (err) {
        setErrorMsg(err.message || 'Could not remove compound from stack.');
      }
    });
  };

  const handleToggleHaveOnly = async (nextVal) => {
    setHaveOnly(nextVal);
    if (activeStack) {
      try {
        await api.patch(
          `/api/v1/members/${encodeURIComponent(activeMemberId)}/stacks/${encodeURIComponent(activeStack.id)}`,
          { haveOnly: nextVal },
        );
        await onRefresh();
      } catch {
        // local state already toggled
      }
    }
  };

  const handlePinSlot = async (compoundId, slotId) => {
    if (!activeStack) return;
    const memberSnapshot = activeMemberId;
    const targetId = activeStack.id;
    const cur = latestItemsByStackRef.current.get(targetId) ?? [...(activeStack.items || [])];
    const nextItems = cur.map((i) =>
      i.compoundId === compoundId ? { ...i, pinnedSlot: slotId || null } : i,
    );
    latestItemsByStackRef.current.set(targetId, nextItems);
    setOptimisticItemsByStack((prev) => ({ ...prev, [targetId]: nextItems }));

    await enqueueStackMutation(async () => {
      try {
        await api.patch(
          `/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks/${encodeURIComponent(targetId)}`,
          { items: latestItemsByStackRef.current.get(targetId) || nextItems },
        );
        setPinEditingId(null);
        setStatusMsg(slotId ? `Pinned item to ${slotId.replace(/_/g, ' ')}.` : 'Unpinned item override.');
      } catch (err) {
        setErrorMsg(err.message || 'Failed to pin slot.');
      }
    });
  };

  const handleLogDose = async (item, slotId) => {
    setErrorMsg('');
    const cmp = compounds.find((c) => c.id === item.compoundId);
    const doseAmount = cmp?.dosages?.defaultAmount || 1;
    const doseUnit = cmp?.dosages?.defaultUnit || 'mg';
    try {
      await api.post(`/api/v1/members/${encodeURIComponent(activeMemberId)}/logs`, {
        compoundId: item.compoundId,
        dose: doseAmount,
        doseAmount,
        unit: doseUnit,
        doseUnit,
        slot: slotId,
        takenAt: new Date().toISOString(),
        skipped: false,
      });
      setStatusMsg(`Logged ${doseAmount} ${doseUnit} ${item.name} (${slotId}).`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err.message || 'Could not log dose.');
    }
  };

  const hardStops = spread?.interactions?.hardStops || [];
  const autoSeparated = spread?.interactions?.autoSeparated || [];
  const alternateDayPairs = spread?.interactions?.alternateDayPairs || [];
  const cautions = spread?.interactions?.cautions || [];
  const ulWarnings = spread?.interactions?.ulWarnings || [];
  const synergies = spread?.interactions?.synergies || [];
  const safetyAlerts = spread?.interactions?.safetyAlerts || [];
  const missingSpf = spread?.dermatology?.skin?.missingSpfWarning || null;
  const microNotes = spread?.dermatology?.skin?.microneedlingBufferNotes || [];

  return (
    <div className="stack-v">
      <div className="space-between">
        <div>
          <h1 style={{ margin: 0, fontSize: '1.45rem' }}>
            Stack Builder &amp; Smart Spreader — {activeMember?.name || activeMemberId}
          </h1>
          <p className="muted" style={{ margin: '0.2rem 0 0' }}>
            Pick compounds across all 4 sections. The dual-track solver separates conflicts, co-locates synergies, and organizes Systemic + Dermatology routines.
          </p>
        </div>

        <div className="row-wrap">
          <select
            data-testid="stack-selector"
            aria-label="Select stack"
            value={activeStack?.id || ''}
            onChange={(e) => setSelectedStackId(e.target.value)}
          >
            {memberStacks.length === 0 ? <option value="">No stacks yet</option> : null}
            {memberStacks.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name} ({(st.items || []).length} items)
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-new-stack"
            onClick={() => setShowNewStack((v) => !v)}
          >
            <Plus size={14} /> New Stack
          </button>
        </div>
      </div>

      {showNewStack ? (
        <form onSubmit={handleCreateStack} className="card row-wrap" role="dialog" aria-label="Create New Stack">
          <input
            type="text"
            name="stackName"
            placeholder="Stack name (e.g., Q4 Longevity & Derm)"
            value={newStackName}
            onChange={(e) => setNewStackName(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
            required
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Create Stack
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setShowNewStack(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {/* Controls: Have-Only & What-If Wishlist Simulation */}
      <div className="card space-between">
        <div className="row-wrap">
          <label className="row-wrap" style={{ cursor: 'pointer', fontWeight: 600 }}>
            <input
              type="checkbox"
              data-testid="stack-toggle-have-only"
              checked={haveOnly}
              onChange={(e) => handleToggleHaveOnly(e.target.checked)}
            />
            <span>Have-Only Mode (schedule owned items only)</span>
          </label>

          <label className="row-wrap" style={{ cursor: 'pointer', fontWeight: 600 }}>
            <input
              type="checkbox"
              data-testid="what-if-toggle"
              checked={whatIfEnabled}
              onChange={(e) => {
                setWhatIfEnabled(e.target.checked);
                if (!e.target.checked) setWhatIfIds([]);
              }}
            />
            <FlaskConical size={14} />
            <span>What-If Wishlist Simulation</span>
          </label>
        </div>

        {spread?.stockSummary ? (
          <div className="row-wrap num">
            <span className="pill pill-have">
              In Stock: {spread.stockSummary.have}/{spread.stockSummary.total}
            </span>
            {spread.stockSummary.missing?.length > 0 ? (
              <span className="pill pill-wishlist">
                Missing/Wishlist: {spread.stockSummary.missing.length}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {statusMsg ? <div className="banner-ok" role="status">{statusMsg}</div> : null}
      {errorMsg ? <div className="banner-danger" role="alert">{errorMsg}</div> : null}

      {/* NON-HIDEABLE HARD-STOP BANNER */}
      {hardStops.length > 0 ? (
        <section className="banner-danger stack-v" data-testid="hard-stop-banner" role="alert">
          <div className="row-wrap">
            <AlertOctagon size={20} />
            <strong>HARD-STOP SAFETY ALERT ({hardStops.length}) — Do NOT Combine Without Clinician Clearance</strong>
          </div>
          {hardStops.map((hs, idx) => (
            <div key={hs.id || idx} style={{ fontSize: '0.9rem' }}>
              <strong>{hs.compoundName || (hs.compounds || []).map((c) => c.name).join(' + ')}:</strong>{' '}
              {hs.mechanism} — <em>{hs.recommendation}</em>
            </div>
          ))}
        </section>
      ) : null}

      {/* Interaction & Safety Alerts Panel */}
      <section className="card stack-v" data-testid="interaction-alerts">
        <div className="row-wrap">
          <AlertTriangle size={16} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--gold)' }}>
            Interactions, Separation &amp; Safety Analysis
          </h2>
        </div>

        {hardStops.map((hs, idx) => (
          <div key={hs.id || `hs-${idx}`} className="banner-danger" style={{ fontSize: '0.86rem' }}>
            <strong>Hard-Stop ({hs.compoundName || (hs.compounds || []).map((c) => c.name).join(' + ')}):</strong>{' '}
            {hs.mechanism} — <em>{hs.recommendation}</em>
          </div>
        ))}

        {missingSpf ? (
          <div className="banner-warn">
            <strong>Missing SPF Warning:</strong> {missingSpf}
          </div>
        ) : null}

        {autoSeparated.map((sep, idx) => (
          <div key={sep.id || idx} className="banner-ok" style={{ fontSize: '0.86rem' }}>
            <strong>Auto-Separated:</strong>{' '}
            {(sep.compounds || []).map((c) => `${c.name} (${c.slotId})`).join(' vs ')} — {sep.recommendation || sep.mechanism}
          </div>
        ))}

        {alternateDayPairs.map((alt, idx) => (
          <div key={alt.id || idx} className="banner-warn" style={{ fontSize: '0.86rem' }}>
            <strong>Alternating Days/Nights:</strong> {alt.recommendation || alt.mechanism}
          </div>
        ))}

        {ulWarnings.map((ul, idx) => (
          <div key={ul.nutrientKey || idx} className="banner-warn" style={{ fontSize: '0.86rem' }}>
            <strong>Adult UL Exceeded ({ul.nutrient}):</strong> {ul.totalAmount} {ul.unit} &gt; {ul.upperLimit} {ul.unit} — {ul.recommendation}
          </div>
        ))}

        {safetyAlerts.filter((a) => a.severity !== 'hard_stop').map((al, idx) => (
          <div key={al.id || idx} className="banner-warn" style={{ fontSize: '0.86rem' }}>
            <strong>Safety Alert ({al.compoundName}):</strong> {al.mechanism}
          </div>
        ))}

        {cautions.map((c, idx) => (
          <div key={c.id || idx} className="muted" style={{ fontSize: '0.85rem' }}>
            • <strong>Caution:</strong> {c.mechanism}
          </div>
        ))}

        {synergies.map((s, idx) => (
          <div key={s.id || idx} className="muted" style={{ fontSize: '0.85rem', color: 'var(--emerald)' }}>
            ✦ <strong>Synergy:</strong> {(s.compounds || []).map((c) => c.name).join(' + ')} — {s.reason}
          </div>
        ))}

        {hardStops.length === 0 &&
        autoSeparated.length === 0 &&
        alternateDayPairs.length === 0 &&
        ulWarnings.length === 0 &&
        cautions.length === 0 &&
        !missingSpf ? (
          <p className="muted" style={{ margin: 0 }}>
            No conflicts detected in the current stack.
          </p>
        ) : null}
      </section>

      {/* Compound Picker Across All 4 Sections */}
      <section className="card stack-v" data-testid="stack-compound-picker">
        <div className="space-between">
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--gold)' }}>
            {whatIfEnabled ? 'Add Compounds to What-If Preview' : 'Add Compounds to Stack (All Sections)'}
          </h2>
          <span className="muted">{compounds.length} available in catalog</span>
        </div>

        <div className="row-wrap">
          {(compounds || []).map((cmp) => {
            const inStack = stackItemIds.has(cmp.id);
            const inWhatIf = whatIfIds.includes(cmp.id);
            return (
              <div key={cmp.id} className="row-wrap" style={{ padding: '0.35rem 0.55rem', background: 'var(--bg-elev)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>{cmp.name}</span>
                <span className="pill">{cmp.sectionId}</span>
                {inStack && !whatIfEnabled ? (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => handleRemoveFromStack(cmp.id)}>
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    data-testid={`btn-add-to-stack-${cmp.id}`}
                    onClick={() => handleAddCompound(cmp)}
                    disabled={whatIfEnabled && inWhatIf}
                  >
                    {whatIfEnabled ? (inWhatIf ? 'In What-If' : '+ What-If') : '+ Add'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* DUAL-TRACK SPREAD OUTPUT */}
      {loadingSpread ? <div className="card muted">Computing optimal dual-track schedule…</div> : null}

      <div className="grid-2">
        {/* Track 1: Systemic 8-Slot Timeline */}
        <section className="card stack-v" data-testid="spread-systemic-timeline">
          <h2 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--gold)' }}>
            Systemic Schedule (8 Daily Slots)
          </h2>
          {(spread?.systemic?.slots || SYSTEMIC_SLOTS.map((s) => ({ slotId: s.id, label: s.label, suggestedTime: '—', items: [] }))).map((slot) => (
            <div key={slot.slotId} className="slot-card" data-testid={`spread-slot-${slot.slotId}`}>
              <div className="space-between">
                <strong>{slot.label}</strong>
                <span className="pill num">{slot.suggestedTime}</span>
              </div>
              {(slot.items || []).length === 0 ? (
                <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>No items scheduled</div>
              ) : (
                slot.items.map((item) => (
                  <article key={item.stackItemId || item.compoundId} className="slot-item stack-v" style={{ gap: '0.35rem' }}>
                    <div className="space-between">
                      <div className="row-wrap">
                        <strong>{item.name}</strong>
                        <span className="pill num">{item.doseDisplay}</span>
                        <span className={`pill pill-${item.ownershipStatus}`}>{item.ownershipStatus}</span>
                        {item.isWhatIf ? <span className="pill pill-wishlist">What-If</span> : null}
                        {item.pinned ? <span className="pill pill-verified">Pinned</span> : null}
                      </div>
                      <div className="row-wrap">
                        <button
                          type="button"
                          className="btn btn-sm"
                          data-testid={`btn-pin-override-${item.compoundId}`}
                          onClick={() => setPinEditingId(pinEditingId === item.compoundId ? null : item.compoundId)}
                        >
                          <Pin size={12} /> {item.pinned ? 'Change Pin' : 'Pin'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          data-testid={`btn-log-dose-${item.compoundId}`}
                          onClick={() => handleLogDose(item, slot.slotId)}
                        >
                          <CheckCircle2 size={12} /> Log
                        </button>
                      </div>
                    </div>

                    {pinEditingId === item.compoundId ? (
                      <div
                        role="dialog"
                        aria-label={`Pin slot override for ${item.name}`}
                        className="row-wrap"
                        style={{ padding: '0.5rem', background: 'var(--bg-card)', borderRadius: 8, border: '1px solid var(--border-strong)' }}
                      >
                        <select
                          aria-label={`Select pinned slot for ${item.name}`}
                          defaultValue={slot.slotId}
                          onChange={(e) => handlePinSlot(item.compoundId, e.target.value)}
                        >
                          <option value="">Auto (Unpin)</option>
                          {SYSTEMIC_SLOTS.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                        {item.pinned ? (
                          <button type="button" className="btn btn-sm" onClick={() => handlePinSlot(item.compoundId, null)}>
                            Unpin
                          </button>
                        ) : null}
                        <button type="button" className="btn btn-sm" onClick={() => setPinEditingId(null)}>
                          Close
                        </button>
                      </div>
                    ) : null}

                    {item.pinConflictWarning ? (
                      <div className="banner-warn" style={{ fontSize: '0.78rem', padding: '0.4rem 0.6rem' }}>
                        {item.pinConflictWarning}
                      </div>
                    ) : null}

                    {(item.rationale || []).length > 0 ? (
                      <div className="row-wrap">
                        {item.rationale.map((r, i) => (
                          <span key={i} className="pill" style={{ fontSize: '0.72rem' }}>
                            <Sparkles size={10} /> {r}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          ))}
        </section>

        {/* Track 2: Dermatology Skin (AM/PM Skin Cycling) + Hair/Scalp */}
        <div className="stack-v">
          <section className="card stack-v" data-testid="spread-derm-am">
            <h2 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--gold)' }}>
              Dermatology — Skin AM Routine (Steps 1–7)
            </h2>
            {missingSpf ? (
              <div className="banner-warn" style={{ fontSize: '0.84rem' }}>
                {missingSpf}
              </div>
            ) : null}
            {(spread?.dermatology?.skin?.am || []).length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No AM facial products in stack.</p>
            ) : (
              spread.dermatology.skin.am.map((st) => (
                <div key={st.compoundId} className="slot-card">
                  <div className="space-between">
                    <strong>
                      Step {st.step}: {st.name}
                    </strong>
                    <span className="pill">{st.vehicleType}{st.waitTimeMinutes > 0 ? ` · wait ${st.waitTimeMinutes}m` : ''}</span>
                  </div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>{(st.rationale || []).join(' · ')}</div>
                </div>
              ))
            )}
          </section>

          <section className="card stack-v" data-testid="spread-derm-pm">
            <h2 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--gold)' }}>
              Dermatology — Skin PM Nights &amp; Skin Cycling
            </h2>
            {microNotes.map((note, idx) => (
              <div key={idx} className="banner-warn" style={{ fontSize: '0.84rem' }}>
                {note}
              </div>
            ))}
            {(spread?.dermatology?.skin?.pmNights || []).length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No PM facial routines in stack.</p>
            ) : (
              spread.dermatology.skin.pmNights.map((night, idx) => (
                <div key={idx} className="slot-card stack-v" style={{ gap: '0.4rem' }}>
                  <div className="space-between">
                    <strong>{night.nightLabel}</strong>
                    <span className="pill">Days: {(night.daysOfWeek || []).join(', ')}</span>
                  </div>
                  {(night.steps || []).map((st) => (
                    <div key={st.compoundId} className="space-between" style={{ fontSize: '0.86rem' }}>
                      <span>
                        Step {st.step}: <strong>{st.name}</strong>
                      </span>
                      <span className="muted">{st.waitTimeMinutes > 0 ? `Wait ${st.waitTimeMinutes}m` : st.vehicleType}</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </section>

          <section className="card stack-v" data-testid="spread-hair-scalp">
            <h2 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--gold)' }}>
              Dermatology — Hair &amp; Scalp Track (Isolated)
            </h2>
            {['am', 'pm', 'weekly'].map((bucket) => {
              const items = spread?.dermatology?.hairScalp?.[bucket] || [];
              if (items.length === 0) return null;
              return (
                <div key={bucket} className="slot-card stack-v" style={{ gap: '0.35rem' }}>
                  <strong style={{ textTransform: 'uppercase', fontSize: '0.8rem', color: 'var(--gold)' }}>
                    Hair / Scalp — {bucket}
                  </strong>
                  {items.map((st) => (
                    <div key={`${bucket}_${st.compoundId}`} className="space-between">
                      <span>{st.name}</span>
                      <span className="pill">{st.vehicleType}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {(spread?.dermatology?.hairScalp?.am?.length || 0) +
              (spread?.dermatology?.hairScalp?.pm?.length || 0) +
              (spread?.dermatology?.hairScalp?.weekly?.length || 0) === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No hair or scalp treatments in stack.</p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
