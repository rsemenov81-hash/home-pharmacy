import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  AlertOctagon,
  AlertTriangle,
  Pin,
  CheckCircle2,
  Sparkles,
  FlaskConical,
  Sun,
  Moon,
  Scissors,
  Check,
  Search,
} from 'lucide-react';
import { SYSTEMIC_SLOTS, dkToday } from '../../core/index.js';
import { api } from '../lib/api.js';

const PICKER_SECTIONS = [
  { id: 'all', label: 'All' },
  { id: 'peptides', label: 'Peptides' },
  { id: 'peds', label: 'PEDs' },
  { id: 'vitamins_supplements', label: 'Vitamins' },
  { id: 'dermatology', label: 'Dermatology' },
];

export function StackBuilderView({
  members,
  activeMemberId,
  compounds,
  stacks,
  onRefresh,
}) {
  const [selectedStackId, setSelectedStackId] = useState('');
  const [haveOnly, setHaveOnly] = useState(false);
  const [whatIfEnabled, setWhatIfEnabled] = useState(false);
  const [whatIfIds, setWhatIfIds] = useState([]);
  const [spread, setSpread] = useState(null);
  const [loadingSpread, setLoadingSpread] = useState(false);
  const [showNewStack, setShowNewStack] = useState(false);
  const [newStackName, setNewStackName] = useState('');
  const [pinEditingItem, setPinEditingItem] = useState(null);
  const [pinDraftSlot, setPinDraftSlot] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [pickerSection, setPickerSection] = useState('all');
  const [pickerQuery, setPickerQuery] = useState('');
  const [optimisticItemsByStack, setOptimisticItemsByStack] = useState({});
  const [optimisticStacks, setOptimisticStacks] = useState([]);

  const memberStacks = useMemo(() => {
    const base = (stacks || []).filter((s) => s.memberId === activeMemberId);
    const seen = new Set(base.map((s) => s.id));
    const extras = optimisticStacks.filter((s) => s.memberId === activeMemberId && !seen.has(s.id));
    return [...base, ...extras];
  }, [stacks, optimisticStacks, activeMemberId]);

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

  const visiblePickerCompounds = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return (compounds || []).filter((c) => {
      if (pickerSection !== 'all' && c.sectionId !== pickerSection) return false;
      if (q && !`${c.name} ${c.subsection || ''} ${(c.aliases || []).join(' ')}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [compounds, pickerSection, pickerQuery]);

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
      if (created?.id) {
        latestItemsByStackRef.current.set(created.id, []);
        setOptimisticStacks((prev) => [...prev.filter((s) => s.id !== created.id), created]);
        setSelectedStackId(created.id);
      }
      setStatusMsg(`Created stack “${clean}”.`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err.message || 'Could not create stack.');
    }
  };

  const handleAddCompound = async (compound) => {
    setErrorMsg('');
    if (whatIfEnabled) {
      setWhatIfIds((prev) => (prev.includes(compound.id) ? prev : [...prev, compound.id]));
      setStatusMsg(`Previewing “${compound.name}” in What-If mode (stack unchanged).`);
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
          const created = createdRes.json?.stack;
          targetId = created?.id;
          if (targetId) {
            latestItemsByStackRef.current.set(targetId, [newItem]);
            setOptimisticStacks((prev) => [...prev.filter((s) => s.id !== targetId), created]);
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
        setStatusMsg(`Added “${compound.name}” to stack.`);
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
        // local toggle already applied
      }
    }
  };

  const handlePinSlot = async (compoundId, slotId, { close = false } = {}) => {
    if (!activeStack) return;
    const memberSnapshot = activeMemberId;
    const targetId = activeStack.id;
    const cur = latestItemsByStackRef.current.get(targetId) ?? [...(activeStack.items || [])];
    const nextItems = cur.map((i) =>
      i.compoundId === compoundId ? { ...i, pinnedSlot: slotId || null } : i,
    );
    latestItemsByStackRef.current.set(targetId, nextItems);
    setOptimisticItemsByStack((prev) => ({ ...prev, [targetId]: nextItems }));
    if (close) setPinEditingItem(null);

    await enqueueStackMutation(async () => {
      try {
        await api.patch(
          `/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks/${encodeURIComponent(targetId)}`,
          { items: latestItemsByStackRef.current.get(targetId) || nextItems },
        );
        setStatusMsg(slotId ? `Pinned to ${slotId.replace(/_/g, ' ')}.` : 'Returned to smart auto-timing.');
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
      setStatusMsg(`Logged ${doseAmount} ${doseUnit} ${item.name}.`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err.message || 'Could not log dose.');
    }
  };

  const interactions = spread?.interactions || {};
  const hardStops = interactions.hardStops || [];
  const autoSeparated = interactions.autoSeparated || [];
  const alternateDayPairs = interactions.alternateDayPairs || [];
  const ulWarnings = interactions.ulWarnings || [];
  const safetyAlerts = interactions.safetyAlerts || [];
  const cautions = interactions.cautions || [];
  const synergies = interactions.synergies || [];
  const missingSpf = spread?.dermatology?.skin?.missingSpfWarning || null;
  const microneedlingNotes = spread?.dermatology?.skin?.microneedlingBufferNotes || [];
  const slots = spread?.systemic?.slots || SYSTEMIC_SLOTS.map((s) => ({ slotId: s.id, label: s.label, suggestedTime: '—', items: [] }));

  return (
    <div className="stack-v">
      {/* Header */}
      <div className="space-between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">{activeMember?.name || 'MEMBER'} PROTOCOL</div>
          <h1 className="display-title" style={{ marginTop: 4 }}>Stack &amp; Smart Schedule</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Automatically arranges your peptides, PEDs, vitamins, and skincare around timing, food state, and interactions.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="btn-new-stack"
          onClick={() => setShowNewStack(true)}
        >
          <Plus size={14} /> New Stack
        </button>
      </div>

      {/* Sleek Control Bar */}
      <div className="card space-between">
        <div className="row-wrap">
          <select
            data-testid="stack-selector"
            aria-label="Select stack"
            value={activeStack?.id || ''}
            onChange={(e) => setSelectedStackId(e.target.value)}
            style={{ minWidth: 200, fontWeight: 600 }}
          >
            {memberStacks.length === 0 ? (
              <option value="">No stacks yet — tap + New Stack</option>
            ) : (
              memberStacks.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name} ({(st.items || []).length})
                </option>
              ))
            )}
          </select>

          {spread?.stockSummary ? (
            <span className="pill pill-accent num">
              {spread.stockSummary.have}/{spread.stockSummary.total} in cabinet
            </span>
          ) : null}
        </div>

        <div className="row-wrap">
          <label className={`toggle-chip${haveOnly ? ' active' : ''}`} data-testid="stack-toggle-have-only">
            <input
              type="checkbox"
              checked={haveOnly}
              onChange={(e) => handleToggleHaveOnly(e.target.checked)}
            />
            <span>In Stock Only</span>
          </label>

          <label className={`toggle-chip${whatIfEnabled ? ' active' : ''}`} data-testid="what-if-toggle">
            <input
              type="checkbox"
              checked={whatIfEnabled}
              onChange={(e) => {
                setWhatIfEnabled(e.target.checked);
                if (!e.target.checked) setWhatIfIds([]);
              }}
            />
            <FlaskConical size={13} />
            <span>What-If Preview</span>
          </label>
        </div>
      </div>

      {whatIfEnabled ? (
        <div className="banner-warn space-between" role="status">
          <span>
            <strong>What-If Preview Active</strong> — test adding wishlist items below without changing your saved stack ({whatIfIds.length} previewing).
          </span>
          {whatIfIds.length > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => setWhatIfIds([])}>
              Clear Preview
            </button>
          ) : null}
        </div>
      ) : null}

      {statusMsg ? (
        <div className="banner-ok" role="status">
          {statusMsg}
        </div>
      ) : null}

      {errorMsg ? (
        <div className="banner-danger" role="alert">
          {errorMsg}
        </div>
      ) : null}

      {/* NON-HIDEABLE HARD-STOP SAFETY BANNER */}
      {hardStops.length > 0 ? (
        <section className="banner-danger stack-sm" data-testid="hard-stop-banner" role="alert">
          <div className="row-wrap">
            <AlertOctagon size={18} />
            <strong>Safety Hard-Stop ({hardStops.length}) — Review Before Combining</strong>
          </div>
          {hardStops.map((hs, idx) => (
            <div key={hs.id || idx} style={{ fontSize: '0.88rem' }}>
              <strong>{hs.compoundName || (hs.compounds || []).map((c) => c.name).join(' + ')}:</strong>{' '}
              {hs.mechanism} — <em>{hs.recommendation}</em>
            </div>
          ))}
        </section>
      ) : null}

      {/* Interactions & Optimization Summary */}
      <section className="card stack-sm" data-testid="interaction-alerts">
        <div className="space-between">
          <div className="row-wrap">
            <AlertTriangle size={15} color="var(--accent)" />
            <h2 className="section-heading">Interactions &amp; Smart Spacing</h2>
          </div>
          {loadingSpread ? <span className="dim">Recalculating…</span> : null}
        </div>

        {hardStops.map((hs, idx) => (
          <div key={hs.id || `hs-${idx}`} className="banner-danger" style={{ fontSize: '0.84rem' }}>
            <strong>Hard-Stop ({hs.compoundName || (hs.compounds || []).map((c) => c.name).join(' + ')}):</strong>{' '}
            {hs.mechanism} — <em>{hs.recommendation}</em>
          </div>
        ))}

        {missingSpf ? (
          <div className="banner-warn" style={{ fontSize: '0.84rem' }}>
            <strong>Missing SPF:</strong> {missingSpf}
          </div>
        ) : null}

        {autoSeparated.map((sep, idx) => (
          <div key={sep.id || idx} className="banner-ok" style={{ fontSize: '0.84rem' }}>
            <strong>Auto-Separated:</strong>{' '}
            {(sep.compounds || []).map((c) => `${c.name} (${c.slotId.replace(/_/g, ' ')})`).join(' vs ')} — {sep.recommendation || sep.mechanism}
          </div>
        ))}

        {alternateDayPairs.map((alt, idx) => (
          <div key={alt.id || idx} className="banner-warn" style={{ fontSize: '0.84rem' }}>
            <strong>Alternating Nights/Days:</strong> {alt.recommendation || alt.mechanism}
          </div>
        ))}

        {ulWarnings.map((ul, idx) => (
          <div key={ul.nutrientKey || idx} className="banner-warn" style={{ fontSize: '0.84rem' }}>
            <strong>Upper Limit ({ul.nutrient}):</strong> {ul.totalAmount} {ul.unit} &gt; {ul.upperLimit} {ul.unit} — {ul.recommendation}
          </div>
        ))}

        {safetyAlerts.filter((a) => a.severity !== 'hard_stop').map((al, idx) => (
          <div key={al.id || idx} className="banner-warn" style={{ fontSize: '0.84rem' }}>
            <strong>Safety Note ({al.compoundName}):</strong> {al.mechanism}
          </div>
        ))}

        {cautions.map((c, idx) => (
          <div key={c.id || idx} className="muted" style={{ fontSize: '0.84rem' }}>
            • <strong>Caution:</strong> {c.mechanism}
          </div>
        ))}

        {synergies.map((s, idx) => (
          <div key={s.id || idx} style={{ fontSize: '0.84rem', color: 'var(--success)' }}>
            ✦ <strong>Synergy:</strong> {(s.compounds || []).map((c) => c.name).join(' + ')} — {s.reason}
          </div>
        ))}

        {hardStops.length === 0 &&
        autoSeparated.length === 0 &&
        alternateDayPairs.length === 0 &&
        ulWarnings.length === 0 &&
        cautions.length === 0 &&
        synergies.length === 0 &&
        !missingSpf ? (
          <p className="muted" style={{ margin: 0 }}>
            All clear — no conflicts detected. Add compounds below to generate your smart daily spread.
          </p>
        ) : null}
      </section>

      {/* DUAL-TRACK SCHEDULE HERO */}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        {/* Left: Systemic 8-Slot Timeline */}
        <section className="card stack-sm" data-testid="spread-systemic-timeline">
          <div className="space-between">
            <div>
              <div className="eyebrow">SYSTEMIC TRACK</div>
              <h2 className="section-heading">Daily Schedule</h2>
            </div>
            <span className="pill num">8 timing windows</span>
          </div>

          {slots.map((slot) => {
            const hasItems = (slot.items || []).length > 0;
            return (
              <div
                key={slot.slotId}
                className={`slot-card ${hasItems ? 'slot-populated' : 'slot-empty'}`}
                data-testid={`spread-slot-${slot.slotId}`}
              >
                <div className="space-between">
                  <strong style={{ fontSize: hasItems ? '0.92rem' : '0.8rem' }}>{slot.label}</strong>
                  <span className={`pill num ${hasItems ? 'pill-accent' : ''}`}>{slot.suggestedTime}</span>
                </div>

                {hasItems
                  ? slot.items.map((item) => (
                      <article key={item.stackItemId || item.compoundId} className="slot-item stack-sm">
                        <div className="space-between">
                          <div className="row-wrap">
                            <strong style={{ fontSize: '0.94rem' }}>{item.name}</strong>
                            {item.doseDisplay ? <span className="pill pill-accent num">{item.doseDisplay}</span> : null}
                            <span className={`pill pill-${item.ownershipStatus}`}>{item.ownershipStatus.replace(/_/g, ' ')}</span>
                            {item.isWhatIf ? <span className="pill pill-wishlist">What-If</span> : null}
                            {item.pinned ? <span className="pill pill-verified">Pinned</span> : null}
                          </div>

                          <div className="row-wrap">
                            <button
                              type="button"
                              className="btn btn-sm"
                              data-testid={`btn-pin-override-${item.compoundId}`}
                              onClick={() => {
                                setPinEditingItem({
                                  compoundId: item.compoundId,
                                  name: item.name,
                                  pinned: Boolean(item.pinned),
                                  initialSlot: slot.slotId,
                                });
                                setPinDraftSlot(slot.slotId);
                              }}
                            >
                              <Pin size={12} /> {item.pinned ? 'Pinned' : 'Pin'}
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

                        {item.pinConflictWarning ? (
                          <div className="banner-warn" style={{ fontSize: '0.78rem', padding: '0.4rem 0.65rem' }}>
                            {item.pinConflictWarning}
                          </div>
                        ) : null}

                        {(item.rationale || []).length > 0 ? (
                          <div className="row-wrap">
                            {item.rationale.map((r, i) => (
                              <span key={i} className="pill" style={{ fontSize: '0.7rem' }}>
                                <Sparkles size={9} /> {r}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))
                  : null}
              </div>
            );
          })}
        </section>

        {/* Right: Dermatology AM/PM + Skin Cycling + Hair/Scalp */}
        <div className="stack-v">
          <section className="card stack-sm" data-testid="spread-derm-am">
            <div className="space-between">
              <div className="row-wrap">
                <Sun size={16} color="var(--accent)" />
                <div>
                  <div className="eyebrow">MORNING SKINCARE</div>
                  <h2 className="section-heading">AM Layering (Steps 1–7)</h2>
                </div>
              </div>
            </div>
            {(spread?.dermatology?.skin?.am || []).length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No morning skincare steps in this stack yet.</p>
            ) : (
              spread.dermatology.skin.am.map((st, idx) => (
                <div key={st.compoundId || idx} className="card-subtle space-between">
                  <div>
                    <span className="pill pill-accent num" style={{ marginRight: 6 }}>Step {st.step}</span>
                    <strong>{st.name}</strong>
                  </div>
                  <span className="pill">
                    {(st.vehicleType || '').replace(/_/g, ' ')}
                    {st.waitTimeMinutes > 0 ? ` · wait ${st.waitTimeMinutes}m` : ''}
                  </span>
                </div>
              ))
            )}
          </section>

          <section className="card stack-sm" data-testid="spread-derm-pm">
            <div className="row-wrap">
              <Moon size={16} color="var(--accent)" />
              <div>
                <div className="eyebrow">EVENING SKINCARE</div>
                <h2 className="section-heading">PM Skin-Cycling Nights</h2>
              </div>
            </div>
            {(spread?.dermatology?.skin?.pmNights || []).length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No evening skincare actives in this stack yet.</p>
            ) : (
              spread.dermatology.skin.pmNights.map((night, idx) => (
                <div key={idx} className="slot-card slot-populated stack-sm">
                  <div className="space-between">
                    <strong>{night.nightLabel}</strong>
                    <span className="pill pill-accent">{night.theme}</span>
                  </div>
                  {(night.steps || []).map((st, sIdx) => (
                    <div key={st.compoundId || sIdx} className="space-between" style={{ fontSize: '0.86rem' }}>
                      <span>
                        <span className="num" style={{ color: 'var(--accent)', marginRight: 6 }}>{st.step}.</span>
                        {st.name}
                      </span>
                      <span className="dim">
                        {st.waitTimeMinutes > 0 ? `Wait ${st.waitTimeMinutes}m` : (st.vehicleType || '').replace(/_/g, ' ')}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
            {microneedlingNotes.map((note, idx) => (
              <div key={idx} className="banner-warn" style={{ fontSize: '0.82rem' }}>
                <strong>Microneedling Buffer:</strong> {note}
              </div>
            ))}
          </section>

          <section className="card stack-sm" data-testid="spread-hair-scalp">
            <div className="row-wrap">
              <Scissors size={15} color="var(--accent)" />
              <div>
                <div className="eyebrow">SCALP &amp; HAIR</div>
                <h2 className="section-heading">Hair Routine</h2>
              </div>
            </div>
            {['am', 'pm', 'weekly'].every((k) => (spread?.dermatology?.hairScalp?.[k] || []).length === 0) ? (
              <p className="muted" style={{ margin: 0 }}>No scalp or hair treatments in this stack yet.</p>
            ) : (
              ['am', 'pm', 'weekly'].map((bucket) => {
                const list = spread?.dermatology?.hairScalp?.[bucket] || [];
                if (list.length === 0) return null;
                return (
                  <div key={bucket} className="stack-sm">
                    <div className="eyebrow">{bucket}</div>
                    {list.map((st, idx) => (
                      <div key={st.compoundId || idx} className="card-subtle space-between">
                        <strong>{st.name}</strong>
                        <span className="pill">{(st.vehicleType || '').replace(/_/g, ' ')}</span>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </section>
        </div>
      </div>

      {/* Clean Searchable Cross-Section Compound Picker */}
      <section className="card stack-v" data-testid="stack-compound-picker">
        <div className="space-between">
          <div>
            <div className="eyebrow">{whatIfEnabled ? 'WHAT-IF SIMULATOR' : 'BUILD YOUR STACK'}</div>
            <h2 className="section-heading">
              {whatIfEnabled ? 'Pick Wishlist Compounds to Preview' : 'Choose Compounds Across All Sections'}
            </h2>
          </div>

          <div className="search-wrap" style={{ maxWidth: 240 }}>
            <Search size={13} className="search-icon" aria-hidden="true" />
            <input
              type="text"
              placeholder="Filter compounds…"
              aria-label="Filter compounds to add to stack"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="section-tabs">
          {PICKER_SECTIONS.map((ps) => (
            <button
              key={ps.id}
              type="button"
              className={`tab-btn${pickerSection === ps.id ? ' active' : ''}`}
              onClick={() => setPickerSection(ps.id)}
            >
              {ps.label}
            </button>
          ))}
        </div>

        <div className="grid-2">
          {visiblePickerCompounds.map((cmp) => {
            const inStack = stackItemIds.has(cmp.id);
            const inWhatIf = whatIfIds.includes(cmp.id);
            return (
              <div key={cmp.id} className="card-subtle space-between">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{cmp.name}</div>
                  <div className="dim">
                    {cmp.sectionId.replace(/_/g, ' ')}
                    {cmp.dosages?.rangeText ? ` · ${cmp.dosages.rangeText}` : ''}
                  </div>
                </div>

                {inStack && !whatIfEnabled ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-success"
                    onClick={() => handleRemoveFromStack(cmp.id)}
                    title="Click to remove from stack"
                  >
                    <Check size={13} /> In Stack
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    data-testid={`btn-add-to-stack-${cmp.id}`}
                    onClick={() => handleAddCompound(cmp)}
                    disabled={whatIfEnabled && inWhatIf}
                  >
                    {whatIfEnabled ? (inWhatIf ? 'Previewing' : '+ Preview') : '+ Add'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Pin Slot Override Sheet */}
      {pinEditingItem ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Pin slot override for ${pinEditingItem.name}`}
        >
          <div className="modal-card stack-v" style={{ maxWidth: 420 }}>
            <div className="space-between">
              <div>
                <div className="eyebrow">TIMING OVERRIDE</div>
                <h2 className="display-sm">Pin {pinEditingItem.name}</h2>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setPinEditingItem(null)}>
                Close
              </button>
            </div>
            <label className="field-label">
              Preferred Daily Window
              <select
                aria-label={`Select pinned slot for ${pinEditingItem.name}`}
                value={pinDraftSlot}
                onChange={(e) => {
                  const nextSlot = e.target.value;
                  setPinDraftSlot(nextSlot);
                  handlePinSlot(pinEditingItem.compoundId, nextSlot, { close: false });
                }}
              >
                <option value="">Auto (Smart Timing)</option>
                {SYSTEMIC_SLOTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
              {pinEditingItem.pinned ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handlePinSlot(pinEditingItem.compoundId, null, { close: true })}
                >
                  Unpin
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setPinEditingItem(null)}
              >
                Save Pin
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* New Stack Sheet */}
      {showNewStack ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Create New Stack">
          <div className="modal-card stack-v" style={{ maxWidth: 420 }}>
            <div className="space-between">
              <div>
                <div className="eyebrow">NEW PROTOCOL</div>
                <h2 className="display-sm">Create Stack</h2>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setShowNewStack(false)}>
                Close
              </button>
            </div>
            <form onSubmit={handleCreateStack} className="stack-v">
              <label className="field-label">
                Stack Name
                <input
                  type="text"
                  name="name"
                  placeholder="e.g., Daily Longevity & Skincare"
                  value={newStackName}
                  onChange={(e) => setNewStackName(e.target.value)}
                  autoFocus
                />
              </label>
              <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setShowNewStack(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">
                  Create Stack
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
