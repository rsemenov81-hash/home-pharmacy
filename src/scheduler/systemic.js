/**
 * Deterministic Systemic 8-Slot Timing, Separation, Synergy Co-Location,
 * Cycle-Phase Awareness & Weekly Injection Load Balancer (F31, F32, F34, F35, F36).
 *
 * Pure ESM, zero UI/DOM/Node-only dependencies.
 */

import {
  DEFAULT_ROUTINE_ANCHORS,
  INJECTABLE_ROUTES,
  SYSTEMIC_SLOTS,
  SYSTEMIC_SLOT_IDS,
  cycleStatus as computeCycleStatus,
  dkDow,
  dkToday,
  dkValid,
  formatDose,
  normRoute,
  parseFiniteNumber,
} from '../core/index.js';

const TIMED_SLOT_IDS = Object.freeze([
  'waking_fasted',
  'morning_am',
  'pre_workout',
  'intra_post_workout',
  'midday_lunch',
  'evening_dinner',
  'bedtime_fasted',
]);

const MEAL_SLOT_SET = new Set(['morning_am', 'midday_lunch', 'evening_dinner']);
const FASTED_SLOT_SET = new Set(['waking_fasted', 'bedtime_fasted']);
const EVENING_SLEEP_SLOT_SET = new Set(['evening_dinner', 'bedtime_fasted']);
const INJECTABLE_SET = new Set(INJECTABLE_ROUTES.map((r) => normRoute(r)));

// ---------------------------------------------------------------------------
// Anchor Clock Time Helpers
// ---------------------------------------------------------------------------

function parseHHMM(str, fallback = '08:00') {
  const s = typeof str === 'string' && /^\d{1,2}:\d{2}$/.test(str.trim()) ? str.trim() : fallback;
  const [hStr, mStr] = s.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return parseHHMM(fallback, '08:00');
  }
  return h * 60 + m;
}

function formatMinutesHHMM(totalMinutes) {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function buildSlotClockMap(routineAnchors = {}) {
  const anchors = {
    ...DEFAULT_ROUTINE_ANCHORS,
    ...(routineAnchors && typeof routineAnchors === 'object' ? routineAnchors : {}),
  };
  const map = new Map();
  for (const slot of SYSTEMIC_SLOTS) {
    if (!slot.anchorKey) {
      map.set(slot.id, { minutes: null, suggestedTime: 'PRN' });
      continue;
    }
    const baseMins = parseHHMM(anchors[slot.anchorKey], DEFAULT_ROUTINE_ANCHORS[slot.anchorKey] || '08:00');
    const mins = ((baseMins + (slot.offsetMinutes || 0)) % 1440 + 1440) % 1440;
    map.set(slot.id, { minutes: mins, suggestedTime: formatMinutesHHMM(mins) });
  }
  return map;
}

export function slotSeparationHours(slotA, slotB, slotClockMap) {
  if (!slotA || !slotB) return 0;
  if (slotA === slotB) return 0;
  if (slotA === 'prn' || slotB === 'prn') return 24;
  const a = slotClockMap.get(slotA)?.minutes;
  const b = slotClockMap.get(slotB)?.minutes;
  if (a == null || b == null) return 0;
  const diff = Math.abs(a - b);
  const circular = Math.min(diff, 1440 - diff);
  return circular / 60;
}

// ---------------------------------------------------------------------------
// Cycle Status & Cadence Helpers
// ---------------------------------------------------------------------------

function buildCycleStatusForItem(item, compound, dateKey) {
  const itemCycle = item.cycle && typeof item.cycle === 'object' ? item.cycle : {};
  const cmpCycle = compound.cycles && typeof compound.cycles === 'object' ? compound.cycles : {};

  const startDate = itemCycle.startDate || item.cycleStartDate || item.startDate || null;
  const endDate = itemCycle.endDate || item.cycleEndDate || item.endDate || null;
  const cycleDays = itemCycle.cycleDays ?? item.cycleDays ?? cmpCycle.cycleDays ?? null;
  const offDays = itemCycle.offDays ?? item.offDays ?? cmpCycle.offDays ?? null;
  const continuous =
    itemCycle.continuous !== undefined
      ? itemCycle.continuous
      : startDate && cycleDays > 0
        ? false
        : cmpCycle.continuous !== false;

  if (!startDate && !endDate && continuous) {
    return {
      phase: 'active',
      status: 'continuous',
      isActive: true,
      isEndingSoon: false,
      endingSoon: false,
      day: null,
      totalDays: null,
      daysRemaining: null,
      dateKey,
      label: cmpCycle.patternText || 'Continuous',
    };
  }

  const plan = {
    startDate,
    endDate,
    cycleDays,
    offDays,
    continuous,
    timeline: item.timeline || itemCycle.timeline || undefined,
  };

  const cs = computeCycleStatus(plan, dateKey, { endingSoonDays: 3 });
  return {
    ...cs,
    endingSoon: Boolean(cs.isEndingSoon),
    currentDay: cs.day,
  };
}

function parseCadenceType(item, compound) {
  const cadenceObj = item.cadence && typeof item.cadence === 'object' ? item.cadence : null;
  const rawType =
    cadenceObj?.type ||
    item.frequency ||
    compound.dosages?.frequencyText ||
    'daily';
  const s = String(rawType).toLowerCase().trim();

  if (Array.isArray(cadenceObj?.daysOfWeek) && cadenceObj.daysOfWeek.length > 0) {
    const validDays = [...new Set(cadenceObj.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
      (a, b) => a - b,
    );
    if (validDays.length > 0) {
      return { kind: 'fixed', daysOfWeek: validDays, perWeek: validDays.length };
    }
  }

  if (s === 'prn' || s.includes('as needed') || s.includes('prn')) {
    return { kind: 'prn', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], perWeek: 0 };
  }
  if (s === 'weekly' || s === '1x_week' || s === 'qw' || s.includes('once weekly') || s.includes('1x/week')) {
    return { kind: 'flexible', perWeek: 1, patterns: [[1], [2], [3], [4], [5], [6], [0]] };
  }
  if (s === '2x_week' || s === 'biw' || s.includes('2x/week') || s.includes('twice weekly') || s.includes('2x week')) {
    return {
      kind: 'flexible',
      perWeek: 2,
      patterns: [
        [1, 4],
        [2, 5],
        [3, 6],
        [0, 3],
        [0, 4],
        [1, 5],
        [2, 6],
      ],
    };
  }
  if (s === 'mwf') {
    return { kind: 'fixed', daysOfWeek: [1, 3, 5], perWeek: 3 };
  }
  if (s === '3x_week' || s === 'tiw' || s.includes('3x/week') || s.includes('3x week')) {
    return {
      kind: 'flexible',
      perWeek: 3,
      patterns: [
        [1, 3, 5],
        [2, 4, 6],
        [0, 2, 4],
        [0, 3, 5],
      ],
    };
  }
  if (s === 'eod' || s.includes('every other day')) {
    return {
      kind: 'flexible',
      perWeek: 4,
      patterns: [
        [0, 2, 4, 6],
        [1, 3, 5],
      ],
    };
  }
  if (s === '5on_2off' || s.includes('5 on') || s.includes('5-on') || s.includes('weekdays')) {
    return { kind: 'fixed', daysOfWeek: [1, 2, 3, 4, 5], perWeek: 5 };
  }
  return { kind: 'daily', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], perWeek: 7 };
}

function isInjectableCompound(compound) {
  const route = normRoute(compound.dosages?.route || '');
  return INJECTABLE_SET.has(route);
}

// ---------------------------------------------------------------------------
// Slot Scoring & Feasibility
// ---------------------------------------------------------------------------

function scoreSlotForCompound(slotId, compound, { isWorkoutDay }) {
  const tr = compound.timingRules || {};
  const preferred = Array.isArray(tr.preferredSlots) ? tr.preferredSlots : [];
  const avoided = new Set(Array.isArray(tr.avoidSlots) ? tr.avoidSlots : []);
  const foodState = tr.foodState || 'any';
  const workoutRel = tr.workoutRelation || 'any';
  const circadian = tr.circadianEffect || 'neutral';

  // PRN handling
  if (slotId === 'prn') {
    if (preferred.includes('prn')) return 1000;
    if (avoided.has('prn')) return -10000;
    return -500; // Don't spill scheduled daily items into PRN unless preferred
  }

  let score = 0;

  // Avoid slots: strong negative penalty
  if (avoided.has(slotId)) {
    score -= 2000;
  }

  // Circadian protection: stimulants NEVER placed in evening_dinner or bedtime_fasted
  if (circadian === 'stimulating' && EVENING_SLEEP_SLOT_SET.has(slotId)) {
    score -= 5000;
  }
  if (circadian === 'stimulating' && (slotId === 'morning_am' || slotId === 'waking_fasted' || slotId === 'midday_lunch')) {
    score += 80;
  }
  if (circadian === 'sedating') {
    if (slotId === 'bedtime_fasted') score += 160;
    else if (slotId === 'evening_dinner') score += 130;
    else score -= 40;
  }

  // Workout-day awareness
  if (!isWorkoutDay) {
    if (slotId === 'pre_workout' || slotId === 'intra_post_workout') {
      score -= 3000;
    }
    if ((workoutRel === 'pre_workout' || preferred.includes('pre_workout')) && slotId === 'morning_am') {
      score += 320;
    }
    if ((workoutRel === 'post_workout' || preferred.includes('intra_post_workout')) && (slotId === 'morning_am' || slotId === 'midday_lunch')) {
      score += 240;
    }
  } else {
    if (workoutRel === 'pre_workout' || workoutRel === 'training_days_only') {
      if (slotId === 'pre_workout') score += 260;
    }
    if (workoutRel === 'post_workout') {
      if (slotId === 'intra_post_workout') score += 260;
    }
  }

  // Preferred slots (ordered by priority)
  const prefIdx = preferred.indexOf(slotId);
  if (prefIdx !== -1) {
    score += 300 - prefIdx * 30;
  }

  // Food state affinity
  if (foodState === 'fasted') {
    if (FASTED_SLOT_SET.has(slotId)) score += 220;
    else score -= 350;
  } else if (foodState === 'with_fat' || foodState === 'with_meal') {
    if (MEAL_SLOT_SET.has(slotId)) score += 180;
    else if (FASTED_SLOT_SET.has(slotId)) score -= 300;
  }

  // Mild preference for morning_am as sensible default for neutral unconstrained items
  if (slotId === 'morning_am') score += 15;
  else if (slotId === 'midday_lunch') score += 10;
  else if (slotId === 'evening_dinner') score += 5;

  return score;
}

function isSlotStrictlyForbidden(slotId, compound, { isWorkoutDay }) {
  const tr = compound.timingRules || {};
  const avoided = new Set(Array.isArray(tr.avoidSlots) ? tr.avoidSlots : []);
  if (avoided.has(slotId)) return true;
  if (tr.circadianEffect === 'stimulating' && EVENING_SLEEP_SLOT_SET.has(slotId)) return true;
  if (!isWorkoutDay && (slotId === 'pre_workout' || slotId === 'intra_post_workout')) return true;
  if (tr.foodState === 'fasted' && !FASTED_SLOT_SET.has(slotId) && !(tr.preferredSlots || []).includes(slotId)) {
    return true;
  }
  return false;
}

function formatItemDoseDisplay(item, compound) {
  const amt = parseFiniteNumber(item.doseAmount ?? item.dose?.amount ?? compound.dosages?.defaultAmount);
  const unit = item.doseUnit ?? item.dose?.unit ?? compound.dosages?.defaultUnit ?? '';
  if (amt !== null && unit) {
    const formatted = formatDose(amt, unit);
    if (formatted) return formatted;
    return `${amt} ${unit}`;
  }
  return compound.dosages?.rangeText || 'Per protocol';
}

// ---------------------------------------------------------------------------
// Main Systemic 4-Pass Solver
// ---------------------------------------------------------------------------

export function solveSystemicSchedule({
  entries = [], // [{ stackItemId, item, compound, ownershipStatus, isWhatIf }]
  member = null,
  interactions = {},
  dateKey = dkToday(),
}) {
  const resolvedDateKey = dkValid(dateKey) ? dateKey : dkToday(member?.routineAnchors?.tz || 'UTC');
  const todayDow = dkDow(resolvedDateKey);
  const anchors = {
    ...DEFAULT_ROUTINE_ANCHORS,
    ...(member?.routineAnchors || {}),
  };
  const workoutDays = Array.isArray(anchors.workoutDays)
    ? anchors.workoutDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : DEFAULT_ROUTINE_ANCHORS.workoutDays;
  const isWorkoutDay = workoutDays.includes(todayDow);
  const slotClockMap = buildSlotClockMap(anchors);

  // Build pair conflict & synergy adjacency maps for systemic items
  const entryById = new Map();
  const stateById = new Map();

  for (const entry of entries) {
    const { compound, item } = entry;
    const cs = buildCycleStatusForItem(item, compound, resolvedDateKey);
    const isInactiveCycle =
      cs.phase === 'upcoming' || cs.phase === 'off_cycle' || cs.phase === 'expired' || cs.phase === 'inactive';

    const cadence = parseCadenceType(item, compound);
    const tr = compound.timingRules || {};
    const isTrainingOnly = tr.workoutRelation === 'training_days_only';

    const state = {
      ...entry,
      cycleStatus: cs,
      isInactiveCycle,
      cadence,
      isTrainingOnly,
      isInjectable: isInjectableCompound(compound),
      pinned: Boolean(item.pinnedSlot && SYSTEMIC_SLOT_IDS.includes(item.pinnedSlot)),
      pinnedSlot: item.pinnedSlot && SYSTEMIC_SLOT_IDS.includes(item.pinnedSlot) ? item.pinnedSlot : null,
      slotId: null,
      daysOfWeek: [],
      rationale: [],
      pinConflictWarning: null,
    };

    entryById.set(compound.id, entry);
    stateById.set(compound.id, state);
  }

  // Active systemic entries (not upcoming/off_cycle/expired)
  const allStates = [...stateById.values()];
  const activeStates = allStates.filter((s) => !s.isInactiveCycle);

  // Build avoid_same_slot pairs (only among active systemic compounds)
  const avoidPairs = [];
  for (const rule of interactions.avoidSameSlot || []) {
    const [idA, idB] = rule.compoundIds || [];
    if (!stateById.has(idA) || !stateById.has(idB)) continue;
    if (stateById.get(idA).isInactiveCycle || stateById.get(idB).isInactiveCycle) continue;
    avoidPairs.push({
      idA,
      idB,
      separationHours: parseFiniteNumber(rule.separationHours) || 2,
      rule,
    });
  }

  // Build alternate_days pairs among systemic compounds
  const altDayPairs = [];
  for (const rule of interactions.alternateDays || []) {
    const [idA, idB] = rule.compoundIds || [];
    if (!stateById.has(idA) || !stateById.has(idB)) continue;
    altDayPairs.push({ idA, idB, rule });
  }

  // Build co-locate synergy pairs among active systemic compounds
  const synergyPairs = [];
  for (const syn of interactions.synergies || []) {
    if (syn.coLocate === false) continue;
    const [idA, idB] = syn.compoundIds || [];
    if (!stateById.has(idA) || !stateById.has(idB)) continue;
    if (stateById.get(idA).isInactiveCycle || stateById.get(idB).isInactiveCycle) continue;
    // Do not co-locate if they also conflict
    const conflicts = avoidPairs.some(
      (p) => (p.idA === idA && p.idB === idB) || (p.idA === idB && p.idB === idA),
    );
    if (conflicts) continue;

    // For curated-bank synergies (not explicitly declared on the compounds), respect
    // disjoint explicit preferredSlots when both compounds declare distinct preferred slots.
    if (syn.source === 'curated_bank') {
      const prefA = stateById.get(idA).compound.timingRules?.preferredSlots || [];
      const prefB = stateById.get(idB).compound.timingRules?.preferredSlots || [];
      if (prefA.length > 0 && prefB.length > 0 && !prefA.some((s) => prefB.includes(s))) {
        continue;
      }
    }
    synergyPairs.push({ idA, idB, syn });
  }

  // -------------------------------------------------------------------------
  // PASS 0 & PASS 1: Pinned Slots + Base Deterministic Slot Scoring
  // -------------------------------------------------------------------------
  for (const st of allStates) {
    if (st.pinned) {
      st.slotId = st.pinnedSlot;
      st.rationale.push(`Pinned by user to ${st.pinnedSlot.replace(/_/g, ' ')}`);
      continue;
    }

    if (st.cadence.kind === 'prn' || (st.compound.timingRules?.preferredSlots || []).includes('prn')) {
      st.slotId = 'prn';
      st.rationale.push('As-needed (PRN) administration');
      continue;
    }

    let bestSlot = 'morning_am';
    let bestScore = -Infinity;
    for (const slotId of TIMED_SLOT_IDS) {
      const sc = scoreSlotForCompound(slotId, st.compound, { isWorkoutDay });
      if (sc > bestScore) {
        bestScore = sc;
        bestSlot = slotId;
      }
    }
    st.slotId = bestSlot;

    // Initial rationale chips
    const tr = st.compound.timingRules || {};
    if (tr.foodState === 'fasted') st.rationale.push('Fasted window preference');
    else if (tr.foodState === 'with_fat') st.rationale.push('With fat-containing meal for absorption');
    else if (tr.foodState === 'with_meal') st.rationale.push('With meal for GI comfort');

    if (tr.circadianEffect === 'stimulating') st.rationale.push('Daytime slot to protect sleep');
    else if (tr.circadianEffect === 'sedating') st.rationale.push('Evening/bedtime for calming effect');

    if (!isWorkoutDay && (tr.workoutRelation === 'pre_workout' || (tr.preferredSlots || []).includes('pre_workout'))) {
      st.rationale.push('Rest-day fallback to Morning / Breakfast');
    } else if (tr.preferredSlots?.includes(bestSlot)) {
      st.rationale.push(`Matches preferred slot (${bestSlot.replace(/_/g, ' ')})`);
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2: Synergy Co-Location (Connected Components)
  // -------------------------------------------------------------------------
  if (synergyPairs.length > 0) {
    // Union-Find over synergy edges
    const parent = new Map();
    const find = (x) => {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
      return parent.get(x);
    };
    const union = (x, y) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent.set(ry, rx);
    };
    for (const { idA, idB } of synergyPairs) union(idA, idB);

    const groups = new Map();
    for (const { idA, idB } of synergyPairs) {
      const root = find(idA);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root).add(idA);
      groups.get(root).add(idB);
    }

    for (const memberSet of groups.values()) {
      const groupStates = [...memberSet].map((id) => stateById.get(id)).filter(Boolean);
      if (groupStates.length < 2) continue;

      const pinnedInGroup = groupStates.filter((s) => s.pinned);
      let targetSlot = null;

      if (pinnedInGroup.length === 1) {
        targetSlot = pinnedInGroup[0].slotId;
      } else if (pinnedInGroup.length === 0) {
        // Pick slot maximizing total group score (excluding forbidden slots for any member)
        let bestScore = -Infinity;
        for (const slotId of TIMED_SLOT_IDS) {
          const forbidden = groupStates.some((s) => isSlotStrictlyForbidden(slotId, s.compound, { isWorkoutDay }));
          if (forbidden) continue;
          const total = groupStates.reduce(
            (acc, s) => acc + scoreSlotForCompound(slotId, s.compound, { isWorkoutDay }),
            0,
          );
          if (total > bestScore) {
            bestScore = total;
            targetSlot = slotId;
          }
        }
      }

      if (targetSlot) {
        for (const st of groupStates) {
          if (!st.pinned && !isSlotStrictlyForbidden(targetSlot, st.compound, { isWorkoutDay })) {
            st.slotId = targetSlot;
            const partnerNames = groupStates
              .filter((other) => other.compound.id !== st.compound.id)
              .map((other) => other.compound.name)
              .join(', ');
            st.rationale.push(`Co-located for synergy with ${partnerNames}`);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // PASS 3: SeparationHours Conflict Solver & Unresolvable Constraint Guard
  // -------------------------------------------------------------------------
  const autoSeparated = [];
  const unresolvedConflicts = [];

  const getConflictsFor = (compoundId, candidateSlot) => {
    const conflicts = [];
    for (const p of avoidPairs) {
      let otherId = null;
      if (p.idA === compoundId) otherId = p.idB;
      else if (p.idB === compoundId) otherId = p.idA;
      if (!otherId) continue;
      const otherState = stateById.get(otherId);
      if (!otherState || !otherState.slotId) continue;
      const sep = slotSeparationHours(candidateSlot, otherState.slotId, slotClockMap);
      if (candidateSlot === otherState.slotId || sep < p.separationHours - 1e-6) {
        conflicts.push({ pair: p, otherState, actualHours: sep });
      }
    }
    return conflicts;
  };

  // Iterative greedy separation pass (deterministic order by compound ID)
  const sortedPairs = [...avoidPairs].sort((p1, p2) =>
    `${p1.idA}:${p1.idB}`.localeCompare(`${p2.idA}:${p2.idB}`),
  );

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const pair of sortedPairs) {
      const stA = stateById.get(pair.idA);
      const stB = stateById.get(pair.idB);
      if (!stA || !stB) continue;

      const currentSep = slotSeparationHours(stA.slotId, stB.slotId, slotClockMap);
      const violated = stA.slotId === stB.slotId || currentSep < pair.separationHours - 1e-6;
      if (!violated) continue;

      if (stA.pinned && stB.pinned) {
        continue; // Both pinned -> handled after loop via pinConflictWarning
      }

      // Candidates to move: try moving unpinned item(s), preferring the one with higher feasible alternative score
      const movable = [];
      if (!stB.pinned) movable.push(stB);
      if (!stA.pinned) movable.push(stA);

      let bestMove = null;
      for (const candidate of movable) {
        for (const slotId of TIMED_SLOT_IDS) {
          if (slotId === candidate.slotId) continue;
          if (isSlotStrictlyForbidden(slotId, candidate.compound, { isWorkoutDay })) continue;
          const remainingConflicts = getConflictsFor(candidate.compound.id, slotId);
          if (remainingConflicts.length > 0) continue;
          const score = scoreSlotForCompound(slotId, candidate.compound, { isWorkoutDay });
          if (!bestMove || score > bestMove.score) {
            bestMove = { candidate, slotId, score };
          }
        }
      }

      if (bestMove) {
        bestMove.candidate.slotId = bestMove.slotId;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Evaluate final status of every avoid_same_slot pair
  for (const pair of sortedPairs) {
    const stA = stateById.get(pair.idA);
    const stB = stateById.get(pair.idB);
    if (!stA || !stB) continue;

    const finalSep = slotSeparationHours(stA.slotId, stB.slotId, slotClockMap);
    const stillViolated = stA.slotId === stB.slotId || finalSep < pair.separationHours - 1e-6;

    if (!stillViolated) {
      autoSeparated.push({
        id: pair.rule.id || `sep_${stA.compound.id}_${stB.compound.id}`,
        compoundIds: [stA.compound.id, stB.compound.id],
        compounds: [
          { id: stA.compound.id, name: stA.compound.name, slotId: stA.slotId, suggestedTime: slotClockMap.get(stA.slotId)?.suggestedTime },
          { id: stB.compound.id, name: stB.compound.name, slotId: stB.slotId, suggestedTime: slotClockMap.get(stB.slotId)?.suggestedTime },
        ],
        requiredSeparationHours: pair.separationHours,
        achievedSeparationHours: Math.round(finalSep * 100) / 100,
        mechanism: pair.rule.mechanism,
        recommendation: pair.rule.recommendation,
      });
      stA.rationale.push(`Separated from ${stB.compound.name} (≥${pair.separationHours}h)`);
      stB.rationale.push(`Separated from ${stA.compound.name} (≥${pair.separationHours}h)`);
    } else if (stA.pinned || stB.pinned) {
      const warnMsg = `Pin conflict: ${stA.compound.name} and ${stB.compound.name} require ≥${pair.separationHours}h separation (${pair.rule.mechanism})`;
      if (stA.pinned) stA.pinConflictWarning = stA.pinConflictWarning ? `${stA.pinConflictWarning}; ${warnMsg}` : warnMsg;
      if (stB.pinned) stB.pinConflictWarning = stB.pinConflictWarning ? `${stB.pinConflictWarning}; ${warnMsg}` : warnMsg;
    } else {
      unresolvedConflicts.push({
        id: `unresolved_${stA.compound.id}_${stB.compound.id}`,
        type: 'unresolved_slot_conflict',
        compoundIds: [stA.compound.id, stB.compound.id],
        compounds: [
          { id: stA.compound.id, name: stA.compound.name, slotId: stA.slotId },
          { id: stB.compound.id, name: stB.compound.name, slotId: stB.slotId },
        ],
        severity: 'caution',
        mechanism: `Unresolved slot conflict: could not separate ${stA.compound.name} and ${stB.compound.name} by ≥${pair.separationHours}h within allowed non-avoided slots (${stA.slotId}).`,
        recommendation: `Insufficient compatible slots to satisfy all competing timing constraints; consider alternating days or relaxing a slot restriction.`,
      });
      stA.rationale.push(`Unresolved slot conflict with ${stB.compound.name} (best-effort placement)`);
      stB.rationale.push(`Unresolved slot conflict with ${stA.compound.name} (best-effort placement)`);
    }
  }

  // Also check if a pinned item violates its own avoidSlots or circadian stimulant protection
  for (const st of allStates) {
    if (!st.pinned) continue;
    const tr = st.compound.timingRules || {};
    if ((tr.avoidSlots || []).includes(st.slotId)) {
      const w = `Pinned to avoided slot "${st.slotId}".`;
      st.pinConflictWarning = st.pinConflictWarning ? `${st.pinConflictWarning}; ${w}` : w;
    } else if (tr.circadianEffect === 'stimulating' && EVENING_SLEEP_SLOT_SET.has(st.slotId)) {
      const w = `Pinned stimulating compound to late slot "${st.slotId}" (may disrupt sleep).`;
      st.pinConflictWarning = st.pinConflictWarning ? `${st.pinConflictWarning}; ${w}` : w;
    }
  }

  // -------------------------------------------------------------------------
  // PASS 4: Weekly Cadence, Alternate Days & Injection Load Balancing
  // -------------------------------------------------------------------------
  const injectionLoadByDay = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
  const alternateDayPairs = [];

  // 4a. First assign fixed-day & daily items (and training_days_only constraints)
  for (const st of allStates) {
    if (st.isInactiveCycle) {
      st.daysOfWeek = [];
      continue;
    }
    if (st.isTrainingOnly) {
      if (st.cadence.kind === 'fixed') {
        const filtered = st.cadence.daysOfWeek.filter((d) => workoutDays.includes(d));
        st.daysOfWeek = filtered.length > 0 ? filtered : [...workoutDays];
      } else {
        st.daysOfWeek = [...workoutDays].sort((a, b) => a - b);
      }
      if (st.isInjectable) {
        for (const d of st.daysOfWeek) injectionLoadByDay[String(d)] += 1;
      }
      continue;
    }
    if (st.cadence.kind === 'daily' || st.cadence.kind === 'fixed' || st.cadence.kind === 'prn') {
      st.daysOfWeek = [...st.cadence.daysOfWeek].sort((a, b) => a - b);
      if (st.isInjectable && st.cadence.kind !== 'prn') {
        for (const d of st.daysOfWeek) injectionLoadByDay[String(d)] += 1;
      }
    }
  }

  // 4b. Assign flexible-cadence items (e.g., 2x_week, 3x_week, weekly) minimizing peak injection load
  const flexibleItems = activeStates
    .filter((s) => !s.isTrainingOnly && s.cadence.kind === 'flexible')
    .sort((a, b) => (b.cadence.perWeek || 0) - (a.cadence.perWeek || 0) || a.compound.id.localeCompare(b.compound.id));

  for (const st of flexibleItems) {
    const patterns = st.cadence.patterns || [[1, 4]];
    let bestPattern = patterns[0];
    let bestCost = Infinity;

    for (const pat of patterns) {
      // Cost: strongly penalize peak daily load, then total overlap load
      let peak = 0;
      let sum = 0;
      for (const d of pat) {
        const nextLoad = injectionLoadByDay[String(d)] + (st.isInjectable ? 1 : 0);
        if (nextLoad > peak) peak = nextLoad;
        sum += nextLoad;
      }
      const cost = peak * 100 + sum;
      if (cost < bestCost) {
        bestCost = cost;
        bestPattern = pat;
      }
    }

    st.daysOfWeek = [...bestPattern].sort((a, b) => a - b);
    if (st.isInjectable) {
      for (const d of st.daysOfWeek) injectionLoadByDay[String(d)] += 1;
      st.rationale.push(`Balanced weekly injection days (${st.daysOfWeek.length}x/wk)`);
    }
  }

  // 4c. Resolve systemic alternate_days pairs into disjoint day schedules
  for (const pair of altDayPairs) {
    const stA = stateById.get(pair.idA);
    const stB = stateById.get(pair.idB);
    if (!stA || !stB || stA.isInactiveCycle || stB.isInactiveCycle) continue;
    const overlap = stA.daysOfWeek.filter((d) => stB.daysOfWeek.includes(d));
    if (overlap.length > 0) {
      stA.daysOfWeek = [1, 3, 5];
      stB.daysOfWeek = [2, 4, 6];
      stA.rationale.push(`Alternating days from ${stB.compound.name}`);
      stB.rationale.push(`Alternating days from ${stA.compound.name}`);
    }
    alternateDayPairs.push({
      id: pair.rule.id || `alt_${stA.compound.id}_${stB.compound.id}`,
      compoundIds: [stA.compound.id, stB.compound.id],
      compounds: [
        { id: stA.compound.id, name: stA.compound.name, daysOfWeek: stA.daysOfWeek },
        { id: stB.compound.id, name: stB.compound.name, daysOfWeek: stB.daysOfWeek },
      ],
      mechanism: pair.rule.mechanism,
      recommendation: pair.rule.recommendation,
    });
  }

  // Recompute exact injectionLoadByDay after any alternate-day adjustment
  for (let d = 0; d <= 6; d++) injectionLoadByDay[String(d)] = 0;
  const weeklyGrid = { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] };

  for (const st of allStates) {
    if (st.isInactiveCycle) continue;
    for (const d of st.daysOfWeek) {
      const key = String(d);
      weeklyGrid[key].push({
        stackItemId: st.stackItemId,
        compoundId: st.compound.id,
        name: st.compound.name,
        sectionId: st.compound.sectionId,
        slotId: st.slotId,
        suggestedTime: slotClockMap.get(st.slotId)?.suggestedTime || 'PRN',
        doseDisplay: formatItemDoseDisplay(st.item, st.compound),
        isInjectable: st.isInjectable,
        isWhatIf: st.isWhatIf,
      });
      if (st.isInjectable && st.cadence.kind !== 'prn') {
        injectionLoadByDay[key] += 1;
      }
    }
  }

  // Assemble canonical 8 slots for the requested dateKey
  const slots = SYSTEMIC_SLOTS.map((slotDef) => {
    const slotItems = allStates
      .filter((st) => {
        if (st.slotId !== slotDef.id) return false;
        // Omit training_days_only items on non-workout rest days
        if (st.isTrainingOnly && !isWorkoutDay) return false;
        return true;
      })
      .sort((a, b) => a.compound.name.localeCompare(b.compound.name) || a.compound.id.localeCompare(b.compound.id))
      .map((st) => {
        // Ensure every item has at least one rationale chip
        const rationale =
          st.rationale.length > 0
            ? [...new Set(st.rationale)]
            : [`Scheduled in ${slotDef.label} based on profile timing`];

        const out = {
          stackItemId: st.stackItemId,
          compoundId: st.compound.id,
          name: st.compound.name,
          sectionId: st.compound.sectionId,
          doseDisplay: formatItemDoseDisplay(st.item, st.compound),
          ownershipStatus: st.ownershipStatus,
          isWhatIf: Boolean(st.isWhatIf),
          pinned: st.pinned,
          daysOfWeek: st.daysOfWeek,
          cycleStatus: st.cycleStatus,
          rationale,
        };
        if (st.pinConflictWarning) {
          out.pinConflictWarning = st.pinConflictWarning;
        }
        return out;
      });

    return {
      slotId: slotDef.id,
      label: slotDef.label,
      suggestedTime: slotClockMap.get(slotDef.id)?.suggestedTime || 'PRN',
      items: slotItems,
    };
  });

  return {
    systemic: {
      slots,
      weeklyGrid,
      injectionLoadByDay,
    },
    autoSeparated,
    alternateDayPairs,
    unresolvedConflicts,
  };
}
