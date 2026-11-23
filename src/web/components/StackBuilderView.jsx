import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  AlertOctagon,
  Pin,
  Check,
  Sparkles,
  FlaskConical,
  Sun,
  Moon,
  Scissors,
  Search,
  ChevronDown,
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
  const [loggedIds, setLoggedIds] = useState(() => new Set());
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
    setErrorMsg('');
    const name = newStackName.trim() || `${activeMember?.name || 'Member'} Daily Stack`;
    try {
      const res = await api.post(`/api/v1/members/${encodeURIComponent(activeMemberId)}/stacks`, {
        name,
        active: true,
        haveOnly,
        items: [],
      });
      const created = res.json?.stack || res.json;
      setShowNewStack(false);
      setNewStackName('');
      if (created?.id) {
        latestItemsByStackRef.current.set(created.id, created.items || []);
        setOptimisticStacks((prev) => [
          ...prev.filter((s) => s.id !== created.id),
          { ...created, memberId: created.memberId || activeMemberId, items: created.items || [] },
        ]);
        setSelectedStackId(created.id);
      }
      setStatusMsg(`Created stack “${name}”.`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err.message || 'Could not create stack.');
    }
  };

  const handleAddCompound = async (compound) => {
    setErrorMsg('');
    if (whatIfEnabled) {
      setWhatIfIds((prev) => (prev.includes(compound.id) ? prev : [...prev, compound.id]));
      setStatusMsg(`Previewing “${compound.name}” in What-If mode.`);
      return;
    }

    const memberSnapshot = activeMemberId;
    const stackIdSnapshot = activeStack?.id || null;
    const newItem = {
      compoundId: compound.id,
      doseAmount: compound.dosages?.defaultAmount || 1,
      doseUnit: compound.dosages?.defaultUnit || 'mg',
      route: compound.dosages?.route || 'Oral',
      enabled: true,
    };

    if (stackIdSnapshot) {
      const cur = latestItemsByStackRef.current.get(stackIdSnapshot) ?? [...(activeStack?.items || [])];
      if (cur.some((i) => i.compoundId === compound.id)) return;
      const next = [...cur, newItem];
      latestItemsByStackRef.current.set(stackIdSnapshot, next);
      setOptimisticItemsByStack((prev) => ({ ...prev, [stackIdSnapshot]: next }));
    }

    await enqueueStackMutation(async () => {
      try {
        let targetId = stackIdSnapshot;
        if (!targetId) {
          const createdRes = await api.post(`/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks`, {
            name: `${activeMember?.name || 'Member'} Daily Stack`,
            active: true,
            haveOnly,
            items: [newItem],
          });
          const created = createdRes.json?.stack || createdRes.json;
          targetId = created?.id;
          if (targetId) {
            latestItemsByStackRef.current.set(targetId, [newItem]);
            setOptimisticStacks((prev) => [
              ...prev.filter((s) => s.id !== targetId),
              { ...created, memberId: created.memberId || memberSnapshot, items: [newItem] },
            ]);
            setSelectedStackId(targetId);
          }
          setStatusMsg(`Added “${compound.name}” to your new stack.`);
          return;
        }

        const latestItems = latestItemsByStackRef.current.get(targetId) || [];
        await api.patch(
          `/api/v1/members/${encodeURIComponent(memberSnapshot)}/stacks/${encodeURIComponent(targetId)}`,
          { items: latestItems },
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
        route: cmp?.dosages?.route || 'Oral',
        slot: slotId,
        status: 'taken',
        dateKey: dkToday('UTC'),
      });
      setLoggedIds((prev) => new Set([...prev, item.compoundId]));
      setStatusMsg(`Logged ${item.name} (${doseAmount} ${doseUnit}).`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err.message || 'Could not log dose.');
    }
  };

  const slots = spread?.systemic?.slots || SYSTEMIC_SLOTS.map((s) => ({
    slotId: s.id,
    label: s.label,
    suggestedTime: s.defaultTime,
    items: [],
  }));
  const populatedSlots = slots.filter((s) => (s.items || []).length > 0);
  const emptySlots = slots.filter((s) => (s.items || []).length === 0);

  const dermAm = spread?.dermatology?.skin?.am || [];
  const dermPmNights = spread?.dermatology?.skin?.pmNights || [];
  const hairScalp = spread?.dermatology?.hairScalp || {};
  const hairScalpCount = ['am', 'pm', 'weekly'].reduce((sum, k) => sum + (hairScalp[k]?.length || 0), 0);
  const missingSpf = spread?.dermatology?.skin?.missingSpfWarning || null;
  const microNotes = spread?.dermatology?.skin?.microneedlingBufferNotes || [];

  const hardStops = spread?.interactions?.hardStops || [];
  const autoSeparated = spread?.interactions?.autoSeparated || [];
  const alternateDayPairs = spread?.interactions?.alternateDayPairs || [];
  const ulWarnings = spread?.interactions?.ulWarnings || [];
  const cautions = spread?.interactions?.cautions || [];
  const synergies = spread?.interactions?.synergies || [];
  const safetyAlerts = spread?.safetyAlerts || [];
  const missingStock = spread?.stockSummary?.missing || [];

  const alertCount = hardStops.length + autoSeparated.length + ulWarnings.length + (missingSpf ? 1 : 0);

  return (
    <div className="stack-v">
      {/* Editorial Header */}
      <div className="space-between" style={{ alignItems: 'flex-end', paddingTop: '0.2rem' }}>
        <div>
          <div className="eyebrow">DAILY RHYTHM · {activeMember?.name || activeMemberId}</div>
          <h1 className="editorial-title" style={{ marginTop: 6 }}>Daily Stack</h1>
          <p className="italic-sub" style={{ margin: '0.3rem 0 0' }}>
            Conflict-aware systemic timing, skincare layering, and live adherence.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="btn-new-stack"
          onClick={() => setShowNewStack(true)}
        >
          <Plus size={14} strokeWidth={2} /> New Stack
        </button>
      </div>

      {/* Sleek Controls Strip */}
      <div className="space-between" style={{ gap: '0.6rem' }}>
        <div className="select-pill" style={{ minWidth: 220 }}>
          <select
            data-testid="stack-selector"
            aria-label="Select active stack"
            value={activeStack?.id || ''}
            onChange={(e) => setSelectedStackId(e.target.value)}
            style={{ width: '100%' }}
          >
            {memberStacks.length === 0 ? (
              <option value="">No stack yet — create one</option>
            ) : (
              memberStacks.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name} ({(st.items || []).length} items)
                </option>
              ))
            )}
          </select>
          <ChevronDown size={12} strokeWidth={1.8} className="sel-chev" aria-hidden="true" />
        </div>

        <div className="row-wrap">
          <label className={`toggle-chip${haveOnly ? ' active' : ''}`}>
            <input
              type="checkbox"
              data-testid="stack-toggle-have-only"
              checked={haveOnly}
              onChange={(e) => handleToggleHaveOnly(e.target.checked)}
            />
            <span>In Cabinet Only</span>
          </label>

          <label className={`toggle-chip${whatIfEnabled ? ' active' : ''}`}>
            <input
              type="checkbox"
              data-testid="what-if-toggle"
              checked={whatIfEnabled}
              onChange={(e) => {
                setWhatIfEnabled(e.target.checked);
                if (!e.target.checked) setWhatIfIds([]);
              }}
            />
            <FlaskConical size={12} strokeWidth={1.8} />
            <span>What-If Preview</span>
          </label>
        </div>
      </div>

      {whatIfEnabled ? (
        <div className="banner-warn space-between">
          <div>
            <strong>What-If Preview Active</strong> — previewing {whatIfIds.length} candidate(s) without saving changes.
          </div>
          {whatIfIds.length > 0 ? (
            <button type="button" className="btn btn-sm" onClick={() => setWhatIfIds([])}>Clear</button>
          ) : null}
        </div>
      ) : null}

      {statusMsg ? (
        <div className="banner-ok" role="status">{statusMsg}</div>
      ) : null}

      {errorMsg ? (
        <div className="banner-danger" role="alert">{errorMsg}</div>
      ) : null}

      {/* Non-Hideable Hard-Stop Safety Banner */}
      {hardStops.length > 0 ? (
        <div className="banner-danger stack-sm" data-testid="hard-stop-banner" role="alert">
          <div className="row-wrap">
            <AlertOctagon size={17} strokeWidth={2} />
            <strong>Safety Alert — {hardStops.length} Hard-Stop Interaction(s)</strong>
          </div>
          {hardStops.map((hs, idx) => (
            <div key={hs.id || idx} style={{ fontSize: '0.84rem' }}>
              <strong>{hs.code || 'Hard Stop'}:</strong> {hs.mechanism} {hs.recommendation}
            </div>
          ))}
        </div>
      ) : null}

      {/* Safety & Synergy Intelligence Summary */}
      <section className="atelier-card stack-sm" data-testid="interaction-alerts">
        <div className="space-between">
          <div className="eyebrow">SAFETY &amp; INTERACTION INTELLIGENCE</div>
          <span className={`pill mono ${hardStops.length > 0 ? 'pill-danger' : alertCount > 0 ? 'pill-ai_draft' : 'pill-verified'}`}>
            {hardStops.length > 0
              ? `${hardStops.length} hard stop`
              : alertCount > 0
                ? `${alertCount} notice${alertCount === 1 ? '' : 's'}`
                : 'All clear'}
          </span>
        </div>

        {hardStops.map((hs, idx) => (
          <div key={hs.id || `hs-${idx}`} className="banner-danger" style={{ fontSize: '0.83rem' }}>
            <strong>Hard Stop ({hs.code || 'Contraindicated'}):</strong> {hs.mechanism} {hs.recommendation}
          </div>
        ))}

        {missingSpf ? (
          <div className="banner-warn" style={{ fontSize: '0.83rem' }}>
            <strong>Missing SPF:</strong> {missingSpf}
          </div>
        ) : null}

        {autoSeparated.map((sep, idx) => (
          <div key={sep.id || idx} className="banner-ok" style={{ fontSize: '0.83rem' }}>
            <strong>Auto-Separated:</strong>{' '}
            {(sep.compounds || []).map((c) => `${c.name} (${c.slotId.replace(/_/g, ' ')})`).join(' vs ')} — {sep.recommendation || sep.mechanism}
          </div>
        ))}

        {alternateDayPairs.map((alt, idx) => (
          <div key={alt.id || idx} className="banner-warn" style={{ fontSize: '0.83rem' }}>
            <strong>Alternating Nights/Days:</strong> {alt.recommendation || alt.mechanism}
          </div>
        ))}

        {ulWarnings.map((ul, idx) => (
          <div key={ul.nutrientKey || idx} className="banner-warn" style={{ fontSize: '0.83rem' }}>
            <strong>Upper Limit ({ul.nutrient}):</strong> {ul.totalAmount} {ul.unit} &gt; {ul.upperLimit} {ul.unit} — {ul.recommendation}
          </div>
        ))}

        {safetyAlerts.filter((a) => a.severity !== 'hard_stop').map((al, idx) => (
          <div key={al.id || idx} className="banner-warn" style={{ fontSize: '0.83rem' }}>
            <strong>Safety Note ({al.compoundName}):</strong> {al.mechanism}
          </div>
        ))}

        {cautions.map((c, idx) => (
          <div key={c.id || idx} className="muted" style={{ fontSize: '0.83rem' }}>
            • <strong style={{ color: 'var(--ink)' }}>Caution:</strong> {c.mechanism}
          </div>
        ))}

        {synergies.map((s, idx) => (
          <div key={s.id || idx} style={{ fontSize: '0.83rem', color: 'var(--success)' }}>
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
            No conflicts detected. Add compounds below to automatically arrange your daily timing windows.
          </p>
        ) : null}
      </section>

      {/* SYSTEMIC TRACK — Protocol OS `.blk` Daily Rhythm Blocks */}
      <section className="stack-sm" data-testid="spread-systemic-timeline">
        <div className="section-h">
          <span>Systemic Schedule</span>
          <span className="sh-count">{loadingSpread ? 'syncing…' : `${populatedSlots.length} / 8 active`}</span>
        </div>

        {populatedSlots.map((slot) => (
          <div key={slot.slotId} className="blk" data-testid={`spread-slot-${slot.slotId}`}>
            <div className="blk-hd">
              <span className="blk-title">{slot.label}</span>
              <span className="blk-time">{slot.suggestedTime}</span>
            </div>

            {slot.items.map((item) => {
              const isLogged = loggedIds.has(item.compoundId);
              return (
                <article key={item.stackItemId || item.compoundId} className="blk-row">
                  <button
                    type="button"
                    className={`blk-disc${isLogged ? ' logged' : ''}`}
                    aria-label={`Quick log ${item.name}`}
                    onClick={() => handleLogDose(item, slot.slotId)}
                  >
                    {isLogged ? <Check size={14} strokeWidth={2.4} /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />}
                  </button>

                  <div className="row-body">
                    <div className="row-wrap" style={{ gap: '0.4rem' }}>
                      <span className="row-title">{item.name}</span>
                      {item.pinned ? <span className="pill pill-accent">Pinned</span> : null}
                      {item.isWhatIf ? <span className="pill pill-wishlist">What-If</span> : null}
                    </div>
                    <div className="row-meta">
                      {[
                        item.doseDisplay,
                        item.ownershipStatus ? item.ownershipStatus.replace(/_/g, ' ') : '',
                        ...(item.rationale || []).slice(0, 1),
                      ]
                        .filter(Boolean)
                        .join('  ·  ')}
                    </div>
                    {item.pinConflictWarning ? (
                      <div className="dim" style={{ color: 'var(--warn)', marginTop: 2 }}>
                        {item.pinConflictWarning}
                      </div>
                    ) : null}
                  </div>

                  <div className="row-wrap" style={{ flexShrink: 0, gap: '0.35rem' }}>
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
                      <Pin size={12} strokeWidth={1.8} /> {item.pinned ? 'Pinned' : 'Pin'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-testid={`btn-log-dose-${item.compoundId}`}
                      onClick={() => handleLogDose(item, slot.slotId)}
                    >
                      Log
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ))}

        {/* Quiet compact empty timing index so all 8 canonical slots remain in DOM without visual clutter */}
        {emptySlots.length > 0 ? (
          <div className="slot-empty-strip" style={{ paddingTop: '0.2rem' }}>
            {emptySlots.map((slot) => (
              <div key={slot.slotId} className="slot-empty-chip" data-testid={`spread-slot-${slot.slotId}`}>
                <span>{slot.label}</span>
                <span className="mono">{slot.suggestedTime}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* DERMATOLOGY TRACK — AM / PM / Hair Ritual Sheets */}
      <section className="stack-sm">
        <div className="section-h">
          <span>Skin &amp; Hair Ritual</span>
          <span className="sh-count">AM · PM · Scalp</span>
        </div>

        <div className="grid-2" style={{ alignItems: 'start' }}>
          {/* AM Facial Layering */}
          <div className="atelier-card stack-sm" data-testid="spread-derm-am">
            <div className="space-between">
              <div className="row-wrap" style={{ gap: '0.45rem' }}>
                <Sun size={15} strokeWidth={1.8} color="var(--accent)" />
                <h3 className="section-heading">Morning Layering</h3>
              </div>
              <span className="dim mono">Steps 1–7</span>
            </div>

            {dermAm.length === 0 ? (
              <p className="dim" style={{ margin: 0 }}>No morning skincare actives in this stack.</p>
            ) : (
              <div>
                {dermAm.map((st, idx) => (
                  <div key={st.compoundId || idx} className="ritual-step">
                    <span className="step-num">0{st.step || idx + 1}</span>
                    <div className="row-body">
                      <div className="row-title" style={{ fontSize: '0.9rem' }}>{st.name}</div>
                      <div className="row-meta">
                        {(st.vehicleType || 'Topical').replace(/_/g, ' ')}
                        {st.waitTimeMinutes > 0 ? `  ·  wait ${st.waitTimeMinutes}m` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* PM Skin Cycling */}
          <div className="atelier-card stack-sm" data-testid="spread-derm-pm">
            <div className="space-between">
              <div className="row-wrap" style={{ gap: '0.45rem' }}>
                <Moon size={15} strokeWidth={1.8} color="var(--accent)" />
                <h3 className="section-heading">Evening Skin Cycling</h3>
              </div>
              <span className="dim mono">{dermPmNights.length ? `${dermPmNights.length} nights` : 'Tonight'}</span>
            </div>

            {dermPmNights.length === 0 ? (
              <p className="dim" style={{ margin: 0 }}>No evening skincare actives scheduled.</p>
            ) : (
              <div className="stack-sm">
                {dermPmNights.map((night, idx) => (
                  <div
                    key={idx}
                    style={{
                      paddingTop: idx ? '0.65rem' : 0,
                      borderTop: idx ? '1px solid var(--hair-subtle)' : 'none',
                    }}
                    className="stack-sm"
                  >
                    <div className="space-between">
                      <strong style={{ fontSize: '0.86rem' }}>{night.nightLabel}</strong>
                      <span className="pill pill-accent">{night.theme}</span>
                    </div>
                    {(night.steps || []).map((st, sIdx) => (
                      <div key={st.compoundId || sIdx} className="ritual-step" style={{ padding: '0.42rem 0' }}>
                        <span className="step-num">0{st.step || sIdx + 1}</span>
                        <div className="row-body">
                          <div className="row-title" style={{ fontSize: '0.88rem' }}>{st.name}</div>
                          <div className="row-meta">
                            {(st.vehicleType || 'Topical').replace(/_/g, ' ')}
                            {st.waitTimeMinutes > 0 ? `  ·  wait ${st.waitTimeMinutes}m` : ''}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {microNotes.map((mn, i) => (
              <div key={i} className="banner-warn" style={{ fontSize: '0.78rem', padding: '0.5rem 0.7rem' }}>
                <strong>Microneedling Buffer:</strong> {mn}
              </div>
            ))}
          </div>
        </div>

        {/* Hair & Scalp Track */}
        <div className="atelier-card stack-sm" data-testid="spread-hair-scalp">
          <div className="space-between">
            <div className="row-wrap" style={{ gap: '0.45rem' }}>
              <Scissors size={14} strokeWidth={1.8} color="var(--accent)" />
              <h3 className="section-heading">Hair &amp; Scalp Protocol</h3>
            </div>
            <span className="dim mono">{hairScalpCount} items</span>
          </div>
          {hairScalpCount === 0 ? (
            <p className="dim" style={{ margin: 0 }}>No hair or scalp treatments in this stack.</p>
          ) : (
            <div className="stack-sm">
              {['am', 'pm', 'weekly'].map((bucket) => {
                const list = hairScalp[bucket] || [];
                if (list.length === 0) return null;
                return (
                  <div key={bucket} className="stack-sm">
                    <div className="eyebrow">{bucket}</div>
                    {list.map((item, idx) => (
                      <div
                        key={item.compoundId || idx}
                        className="space-between"
                        style={{ paddingTop: idx ? '0.42rem' : 0, borderTop: idx ? '1px solid var(--hair-subtle)' : 'none' }}
                      >
                        <strong style={{ fontSize: '0.9rem' }}>{item.name}</strong>
                        <span className="row-meta">{(item.vehicleType || 'Scalp').replace(/_/g, ' ')}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {missingStock.length > 0 ? (
          <div className="banner-warn" style={{ fontSize: '0.83rem' }}>
            <strong>Needed for this stack:</strong> {missingStock.map((m) => m.name).join(', ')}
          </div>
        ) : null}
      </section>

      {/* COMPOUND PICKER — Clean Grouped Porcelain Sheet */}
      <section className="stack-sm" data-testid="stack-compound-picker">
        <div className="section-h">
          <span>{whatIfEnabled ? 'Preview Additional Compounds' : 'Add to Stack'}</span>
          <span className="sh-count">{effectiveItems.length} in stack</span>
        </div>

        <div className="space-between" style={{ gap: '0.6rem' }}>
          <div className="cat-pills">
            {PICKER_SECTIONS.map((ps) => (
              <button
                key={ps.id}
                type="button"
                className={`cat-pill${pickerSection === ps.id ? ' active' : ''}`}
                style={{ padding: '0.38rem 0.78rem', fontSize: '0.76rem' }}
                onClick={() => setPickerSection(ps.id)}
              >
                {ps.label}
              </button>
            ))}
          </div>

          <div className="search-wrap" style={{ maxWidth: 210 }}>
            <Search size={13} strokeWidth={1.8} className="search-icon" aria-hidden="true" />
            <input
              type="text"
              placeholder="Filter compounds…"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="list-sheet" style={{ maxHeight: 360, overflowY: 'auto' }}>
          {visiblePickerCompounds.map((cmp) => {
            const inStack = stackItemIds.has(cmp.id);
            const inWhatIf = whatIfIds.includes(cmp.id);
            return (
              <div key={cmp.id} className="list-row" style={{ padding: '0.72rem 1.15rem' }}>
                <div className="row-body">
                  <div className="row-title" style={{ fontSize: '0.9rem' }}>{cmp.name}</div>
                  <div className="row-meta">
                    {[cmp.sectionId.replace(/_/g, ' '), cmp.dosages?.route].filter(Boolean).join('  ·  ')}
                  </div>
                </div>
                {inStack && !whatIfEnabled ? (
                  <button
                    type="button"
                    className="btn btn-success btn-sm"
                    onClick={() => handleRemoveFromStack(cmp.id)}
                  >
                    <Check size={12} strokeWidth={2.2} /> Added
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
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
                <h2 className="display-sm" style={{ marginTop: 2 }}>Pin {pinEditingItem.name}</h2>
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
                <h2 className="display-sm" style={{ marginTop: 2 }}>Create Stack</h2>
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
