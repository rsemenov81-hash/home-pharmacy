/**
 * Deterministic Dermatology (Skin Face/Body + Hair/Scalp) AM/PM Layering,
 * Photosensitivity/SPF Guard, Alternating-Night Skin-Cycling & Microneedling
 * Recovery Buffer Solver (F14, F33, F34, F36).
 *
 * Pure ESM, zero UI/DOM/Node-only dependencies.
 */

import { parseFiniteNumber } from '../core/index.js';

const VEHICLE_TO_STEP = Object.freeze({
  cleanser: 1,
  shampoo: 1,
  wash: 1,
  acid_toner: 2,
  toner: 2,
  exfoliant: 2,
  essence: 3,
  water_serum: 3,
  serum: 3,
  scalp_tonic: 3,
  solution: 3,
  gel: 4,
  anhydrous_serum: 4,
  emulsion: 4,
  foam: 4,
  treatment: 4,
  cream: 5,
  moisturizer: 5,
  lotion: 5,
  oil: 6,
  occlusive: 6,
  balm: 6,
  spf: 7,
  sunscreen: 7,
  device: 1,
});

const SKIN_AREAS = new Set(['face', 'neck', 'neck_chest', 'eye', 'body', 'brows_lashes']);

function norm(s) {
  return String(s ?? '').toLowerCase().trim();
}

function getTagsSet(compound) {
  return new Set((compound.tags || []).map((t) => norm(t).replace(/[\s-]+/g, '_')));
}

function getTargetAreas(compound) {
  const raw = compound.sectionData?.targetArea;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((a) => norm(a).replace(/[\s-]+/g, '_'));
  }
  const tags = getTagsSet(compound);
  const sub = norm(compound.subsection);
  if (tags.has('scalp_hair') || tags.has('scalp') || tags.has('hair') || sub.includes('hair') || sub.includes('scalp')) {
    return ['scalp_hair'];
  }
  return ['face'];
}

function isMicroneedling(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const role = norm(sd.skinCyclingRole);
  const mol = norm(compound.canonicalMolecule || compound.name);
  return (
    role === 'microneedling' ||
    tags.has('microneedling') ||
    sd.vehicleType === 'device' && mol.includes('microneedl') ||
    mol.includes('microneedl') ||
    mol.includes('dermapen')
  );
}

function isSpfProduct(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const v = norm(sd.vehicleType);
  const role = norm(sd.skinCyclingRole);
  const name = norm(compound.name);
  return (
    role === 'spf' ||
    v === 'spf' ||
    v === 'sunscreen' ||
    tags.has('spf') ||
    tags.has('sunscreen') ||
    /\bspf\b|sunscreen/i.test(name)
  );
}

function isBenzoylPeroxide(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const mol = norm(compound.canonicalMolecule || compound.name);
  return (
    sd.skinCyclingRole === 'benzoyl_peroxide' ||
    tags.has('benzoyl_peroxide') ||
    tags.has('bpo') ||
    mol.includes('benzoyl')
  );
}

function isRetinoid(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const role = norm(sd.skinCyclingRole);
  const mol = norm(compound.canonicalMolecule || compound.name);
  return (
    role === 'retinoid' ||
    tags.has('retinoid') ||
    tags.has('tretinoin') ||
    mol.includes('tretinoin') ||
    mol.includes('adapalene') ||
    mol.includes('tazarotene') ||
    mol.includes('retinol') ||
    mol.includes('retinal')
  );
}

function isExfoliantAcid(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const role = norm(sd.skinCyclingRole);
  const mol = norm(compound.canonicalMolecule || compound.name);
  return (
    role === 'exfoliant_aha_bha' ||
    role === 'exfoliant' ||
    tags.has('aha_bha') ||
    tags.has('aha') ||
    tags.has('bha') ||
    tags.has('exfoliant') ||
    mol.includes('glycolic') ||
    mol.includes('salicylic') ||
    mol.includes('lactic-acid') ||
    mol.includes('mandelic')
  );
}

function isCopperPeptideTopical(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const role = norm(sd.skinCyclingRole);
  const mol = norm(compound.canonicalMolecule || compound.name);
  return (
    role === 'copper_peptide' ||
    tags.has('copper_peptide') ||
    tags.has('ghk_cu') ||
    mol.includes('ghk-cu') ||
    mol.includes('ghk_cu')
  );
}

function isVitaminCTopical(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  const role = norm(sd.skinCyclingRole);
  const mol = norm(compound.canonicalMolecule || compound.name);
  return (
    role === 'antioxidant_vit_c' ||
    role === 'antioxidant' && (tags.has('vitamin_c') || mol.includes('vitamin-c') || mol.includes('ascorbic')) ||
    tags.has('vitamin_c') ||
    mol.includes('vitamin-c') ||
    mol.includes('ascorbic')
  );
}

function isPhotosensitizing(compound) {
  const sd = compound.sectionData || {};
  const tags = getTagsSet(compound);
  if (sd.photosensitivity === true || sd.photosensitivity === 'high_spf_required' || sd.photosensitivity === 'mild') {
    return true;
  }
  if (tags.has('photosensitizing') || tags.has('photosensitive')) return true;
  if (isRetinoid(compound) || isExfoliantAcid(compound)) return true;
  return false;
}

function isIrritatingPostMicroneedling(compound) {
  return (
    isRetinoid(compound) ||
    isExfoliantAcid(compound) ||
    isBenzoylPeroxide(compound) ||
    isVitaminCTopical(compound) ||
    norm(compound.canonicalMolecule || compound.name).includes('minoxidil')
  );
}

function resolveLayeringStep(compound) {
  const raw = compound.sectionData?.layeringStep;
  if (Number.isInteger(raw) && raw >= 1 && raw <= 7) return raw;
  const v = norm(compound.sectionData?.vehicleType);
  if (VEHICLE_TO_STEP[v]) return VEHICLE_TO_STEP[v];
  if (isSpfProduct(compound)) return 7;
  if (isRetinoid(compound)) return 4;
  if (isExfoliantAcid(compound)) return 2;
  return 3;
}

function resolveOptimalPh(compound) {
  const actives = compound.sectionData?.actives;
  if (Array.isArray(actives)) {
    for (const a of actives) {
      const ph = parseFiniteNumber(a?.optimalPh);
      if (ph !== null) return ph;
    }
  }
  return 5.5;
}

function sortDermSteps(steps) {
  return [...steps].sort(
    (a, b) =>
      a.step - b.step ||
      (a._ph ?? 5.5) - (b._ph ?? 5.5) ||
      a.name.localeCompare(b.name) ||
      a.compoundId.localeCompare(b.compoundId),
  );
}

function toPublicStep(entry, rationale, extra = {}) {
  const { compound, ownershipStatus, isWhatIf, item } = entry;
  const sd = compound.sectionData || {};
  const step = resolveLayeringStep(compound);
  const waitRaw = parseFiniteNumber(sd.waitTimeMinutes);
  const pinned = Boolean(
    item.pinnedSlot && ['derm_am', 'derm_pm', 'hair_am', 'hair_pm', 'derm_weekly'].includes(item.pinnedSlot),
  );

  const out = {
    step,
    stackItemId: entry.stackItemId,
    compoundId: compound.id,
    name: compound.name,
    vehicleType: sd.vehicleType || 'serum',
    waitTimeMinutes: waitRaw !== null && waitRaw >= 0 ? waitRaw : 0,
    rationale: Array.isArray(rationale) ? rationale : [rationale],
    ownershipStatus,
    isWhatIf: Boolean(isWhatIf),
    pinned,
    ...extra,
  };
  if (extra._ph !== undefined) delete out._ph;
  return out;
}

function isWeeklyCadence(item, compound) {
  const freq = norm(item.cadence?.type || item.frequency || compound.dosages?.frequencyText || '');
  return (
    freq === 'weekly' ||
    freq === '1x_week' ||
    freq === '2x_week' ||
    freq === '3x_week' ||
    freq.includes('weekly') ||
    freq.includes('2x/week') ||
    freq.includes('twice weekly') ||
    freq.includes('once weekly')
  );
}

function getConfiguredDays(item, fallbackDays = [0]) {
  const days = item.cadence?.daysOfWeek;
  if (Array.isArray(days) && days.length > 0) {
    const clean = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (clean.length > 0) return clean;
  }
  return [...fallbackDays];
}

// ---------------------------------------------------------------------------
// Main Dermatology Solver
// ---------------------------------------------------------------------------

export function solveDermatologySchedule({
  entries = [], // [{ stackItemId, item, compound, ownershipStatus, isWhatIf }]
  interactions = {},
}) {
  const skinEntries = [];
  const hairEntries = [];

  for (const entry of entries) {
    const areas = getTargetAreas(entry.compound);
    const hasHair = areas.some((a) => a === 'scalp_hair' || a === 'hair' || a === 'scalp');
    const hasSkin = areas.some((a) => SKIN_AREAS.has(a));

    if (hasHair && !hasSkin) {
      hairEntries.push(entry);
    } else if (hasHair && hasSkin) {
      // Multi-area device such as Microneedling (face + scalp_hair)
      skinEntries.push(entry);
      hairEntries.push(entry);
    } else {
      skinEntries.push(entry);
    }
  }

  const dermAutoSeparated = [];
  const dermAlternateDayPairs = [];

  // -------------------------------------------------------------------------
  // 1. Hair / Scalp Track (Strictly Isolated from Skin)
  // -------------------------------------------------------------------------
  const hairAm = [];
  const hairPm = [];
  const hairWeekly = [];

  for (const entry of hairEntries) {
    const { compound, item } = entry;
    const sd = compound.sectionData || {};
    const tr = compound.timingRules || {};
    const suit = norm(sd.amPmSuitability || 'both');
    const pinnedSlot = item.pinnedSlot || null;
    const weekly = isWeeklyCadence(item, compound) || isMicroneedling(compound) || norm(sd.vehicleType) === 'shampoo';

    if (pinnedSlot === 'hair_am') {
      hairAm.push(toPublicStep(entry, ['Pinned to Hair/Scalp AM']));
    } else if (pinnedSlot === 'hair_pm') {
      hairPm.push(toPublicStep(entry, ['Pinned to Hair/Scalp PM']));
    } else if (pinnedSlot === 'derm_weekly' || weekly) {
      const days = getConfiguredDays(item, isMicroneedling(compound) ? [0] : [1, 4]);
      hairWeekly.push(
        toPublicStep(entry, [isMicroneedling(compound) ? 'Weekly scalp microneedling (hold Minoxidil 24h)' : 'Scheduled weekly scalp care'], {
          daysOfWeek: days,
        }),
      );
    } else if (suit === 'am_only' || (tr.preferredSlots?.includes('derm_am') && !tr.preferredSlots?.includes('derm_pm') && suit !== 'both')) {
      hairAm.push(toPublicStep(entry, ['AM scalp application']));
    } else if (suit === 'pm_only' || (tr.preferredSlots?.includes('derm_pm') && !tr.preferredSlots?.includes('derm_am') && suit !== 'both')) {
      hairPm.push(toPublicStep(entry, ['PM scalp application']));
    } else {
      hairAm.push(toPublicStep(entry, ['AM scalp application']));
      hairPm.push(toPublicStep(entry, ['PM scalp application']));
    }
  }

  // -------------------------------------------------------------------------
  // 2. Skin (Face / Neck / Eye / Body) AM/PM Routing & Skin Cycling
  // -------------------------------------------------------------------------
  const hasRetinoidInSkin = skinEntries.some((e) => isRetinoid(e.compound));
  const hasCopperInSkin = skinEntries.some((e) => isCopperPeptideTopical(e.compound));
  const hasSpfInSkin = skinEntries.some((e) => isSpfProduct(e.compound));
  const hasPhotosensitizingInSkin = skinEntries.some((e) => isPhotosensitizing(e.compound));
  const microneedlingEntry = skinEntries.find((e) => isMicroneedling(e.compound)) || null;

  const amListRaw = [];
  const pmBaseRaw = [];
  const pmCyclingActives = [];

  // Build alternate_days adjacency among skin entries
  const skinEntryIds = new Set(skinEntries.map((e) => e.compound.id));
  const altAdj = new Map(); // id -> Set<id>
  const addAltEdge = (idA, idB, rule) => {
    if (!altAdj.has(idA)) altAdj.set(idA, new Set());
    if (!altAdj.has(idB)) altAdj.set(idB, new Set());
    if (!altAdj.get(idA).has(idB)) {
      altAdj.get(idA).add(idB);
      altAdj.get(idB).add(idA);
      dermAlternateDayPairs.push({
        id: rule?.id || `derm_alt_${[idA, idB].sort().join('_')}`,
        compoundIds: [idA, idB].sort(),
        mechanism: rule?.mechanism || 'Incompatible PM dermatology actives scheduled on alternating nights.',
        recommendation: rule?.recommendation || 'Alternate PM skin-cycling nights.',
      });
    }
  };

  for (const rule of interactions.alternateDays || []) {
    const [idA, idB] = rule.compoundIds || [];
    if (skinEntryIds.has(idA) && skinEntryIds.has(idB)) {
      // Microneedling is handled on its own dedicated night, not as a peer active
      if (microneedlingEntry && (idA === microneedlingEntry.compound.id || idB === microneedlingEntry.compound.id)) {
        continue;
      }
      addAltEdge(idA, idB, rule);
    }
  }

  for (const entry of skinEntries) {
    const { compound, item } = entry;
    if (microneedlingEntry && compound.id === microneedlingEntry.compound.id) {
      continue; // Handled in dedicated microneedling night
    }

    const sd = compound.sectionData || {};
    const tr = compound.timingRules || {};
    const suit = norm(sd.amPmSuitability || 'both');
    const photo = isPhotosensitizing(compound);
    const spf = isSpfProduct(compound);
    const bpo = isBenzoylPeroxide(compound);
    const vitC = isVitaminCTopical(compound);
    const pinnedSlot = item.pinnedSlot || null;
    const ph = resolveOptimalPh(compound);

    let goAm = false;
    let goPm = false;
    const amReasons = [];
    const pmReasons = [];

    if (pinnedSlot === 'derm_am') {
      goAm = true;
      amReasons.push('Pinned by user to AM routine');
    } else if (pinnedSlot === 'derm_pm') {
      goPm = true;
      pmReasons.push('Pinned by user to PM routine');
    } else if (spf || suit === 'am_only' || (tr.avoidSlots || []).includes('derm_pm')) {
      goAm = true;
      amReasons.push(spf ? 'Final AM UV protection step (Step 7)' : 'AM-only topical formulation');
    } else if (photo || suit === 'pm_only' || (tr.avoidSlots || []).includes('derm_am')) {
      // Photosensitizing actives NEVER go in AM
      goPm = true;
      pmReasons.push(photo ? 'PM-only due to photosensitivity / UV degradation' : 'PM-only active treatment');
    } else if (bpo && hasRetinoidInSkin) {
      // BPO oxidizes Tretinoin -> strictly AM only!
      goAm = true;
      goPm = false;
      amReasons.push('Routed to AM to avoid oxidizing PM retinoid');
      const retEntry = skinEntries.find((e) => isRetinoid(e.compound));
      if (retEntry) {
        dermAutoSeparated.push({
          id: `derm_sep_bpo_ret_${compound.id}_${retEntry.compound.id}`,
          compoundIds: [compound.id, retEntry.compound.id].sort(),
          compounds: [
            { id: compound.id, name: compound.name, slotId: 'derm_am' },
            { id: retEntry.compound.id, name: retEntry.compound.name, slotId: 'derm_pm' },
          ],
          mechanism: 'Benzoyl peroxide oxidizes retinoids on co-application.',
          recommendation: 'Placed Benzoyl Peroxide in AM and Retinoid in PM.',
        });
      }
    } else if (vitC && hasCopperInSkin) {
      goAm = true;
      goPm = false;
      amReasons.push('Routed to AM antioxidant step away from PM GHK-Cu');
    } else if (suit === 'both' || suit === 'am_or_pm') {
      goAm = true;
      goPm = true;
      amReasons.push(`Layering step ${resolveLayeringStep(compound)} (AM)`);
      pmReasons.push(`Layering step ${resolveLayeringStep(compound)} (PM base)`);
    } else {
      goPm = true;
      pmReasons.push(`Layering step ${resolveLayeringStep(compound)} (PM)`);
    }

    if (goAm) {
      amListRaw.push({ ...toPublicStep(entry, amReasons), _ph: ph });
    }
    if (goPm) {
      const isCycling =
        altAdj.has(compound.id) ||
        isRetinoid(compound) ||
        isExfoliantAcid(compound) ||
        isCopperPeptideTopical(compound);
      if (isCycling) {
        pmCyclingActives.push({ entry, reasons: pmReasons, ph });
      } else {
        pmBaseRaw.push({ ...toPublicStep(entry, pmReasons), _ph: ph });
      }
    }
  }

  const skinAm = sortDermSteps(amListRaw).map(({ _ph, ...rest }) => rest);

  // -------------------------------------------------------------------------
  // 3. Alternating-Night Skin Cycling + Microneedling Buffer
  // -------------------------------------------------------------------------
  const microneedlingBufferNotes = [];
  const microneedlingDays = microneedlingEntry ? getConfiguredDays(microneedlingEntry.item, [0]) : [];
  const microneedlingDaySet = new Set(microneedlingDays);

  if (microneedlingEntry) {
    const heldNames = [...skinEntries, ...hairEntries]
      .filter((e) => e.compound.id !== microneedlingEntry.compound.id && isIrritatingPostMicroneedling(e.compound))
      .map((e) => e.compound.name);
    const uniqueHeld = [...new Set(heldNames)];
    microneedlingBufferNotes.push(
      `Microneedling 12–24h recovery buffer active on day(s) [${microneedlingDays.join(', ')}]: hold irritating actives (${
        uniqueHeld.length > 0 ? uniqueHeld.join(', ') : 'retinoids, exfoliating acids, BPO, Vitamin C, and topical Minoxidil'
      }) for 24 hours post-session to protect barrier recovery.`,
    );
  }

  // Graph-color pmCyclingActives into conflict-free night buckets
  // Deterministic ordering: retinoid first, exfoliant second, copper peptide third, others by name
  const rolePriority = (c) => {
    if (isRetinoid(c)) return 1;
    if (isExfoliantAcid(c)) return 2;
    if (isCopperPeptideTopical(c)) return 3;
    return 4;
  };
  const sortedCycling = [...pmCyclingActives].sort(
    (a, b) =>
      rolePriority(a.entry.compound) - rolePriority(b.entry.compound) ||
      a.entry.compound.name.localeCompare(b.entry.compound.name),
  );

  const buckets = []; // [{ theme, label, actives: [] }]
  for (const active of sortedCycling) {
    const cid = active.entry.compound.id;
    const conflictsWith = altAdj.get(cid) || new Set();
    let placed = false;

    // Only place together in the same bucket if there is zero alternate_days conflict
    // AND they share the same cycling category (so Retinoid, Acid, Copper Peptide stay distinct nights!)
    for (const bucket of buckets) {
      const hasConflict = bucket.actives.some((other) => conflictsWith.has(other.entry.compound.id));
      if (!hasConflict && bucket.roleGroup === rolePriority(active.entry.compound)) {
        bucket.actives.push(active);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const c = active.entry.compound;
      let theme = 'active_treatment';
      let label = `PM Active Night (${c.name})`;
      if (isRetinoid(c)) {
        theme = 'retinoid';
        label = 'Night: Retinoid Treatment';
      } else if (isExfoliantAcid(c)) {
        theme = 'exfoliation';
        label = 'Night: Acid Exfoliation';
      } else if (isCopperPeptideTopical(c)) {
        theme = 'peptide_recovery';
        label = 'Night: Copper Peptide & Barrier';
      }
      buckets.push({
        roleGroup: rolePriority(c),
        theme,
        label,
        actives: [active],
      });
    }
  }

  // Available non-microneedling days of the week (preferred order Mon..Sat, Sun)
  const availableDays = [1, 2, 3, 4, 5, 6, 0].filter((d) => !microneedlingDaySet.has(d));
  const pmNights = [];

  if (buckets.length === 0) {
    // Simple nightly PM routine (no cycling actives)
    if (pmBaseRaw.length > 0 && availableDays.length > 0) {
      pmNights.push({
        nightLabel: 'Nightly PM Routine',
        daysOfWeek: [...availableDays].sort((a, b) => a - b),
        theme: 'barrier_recovery',
        steps: sortDermSteps(pmBaseRaw).map(({ _ph, ...rest }) => rest),
      });
    }
  } else if (buckets.length === 1) {
    const b = buckets[0];
    const combined = [
      ...pmBaseRaw,
      ...b.actives.map((a) => ({ ...toPublicStep(a.entry, a.reasons), _ph: a.ph })),
    ];
    pmNights.push({
      nightLabel: b.label,
      daysOfWeek: [...availableDays].sort((a, b) => a - b),
      theme: b.theme,
      steps: sortDermSteps(combined).map(({ _ph, ...rest }) => rest),
    });
  } else {
    // Distribute availableDays round-robin across the K conflict-free night buckets
    // guaranteeing every bucket gets >=1 day and all buckets are STRICTLY pairwise disjoint!
    const daysPerBucket = buckets.map(() => []);
    for (let i = 0; i < availableDays.length; i++) {
      daysPerBucket[i % buckets.length].push(availableDays[i]);
    }

    for (let idx = 0; idx < buckets.length; idx++) {
      const b = buckets[idx];
      const assigned = daysPerBucket[idx].sort((a, c) => a - c);
      const combined = [
        ...pmBaseRaw,
        ...b.actives.map((a) => ({
          ...toPublicStep(a.entry, [...a.reasons, `Skin-cycling alternating night (${b.theme})`]),
          _ph: a.ph,
        })),
      ];
      pmNights.push({
        nightLabel: `Night ${idx + 1} — ${b.label.replace(/^Night:\s*/i, '')}`,
        daysOfWeek: assigned,
        theme: b.theme,
        steps: sortDermSteps(combined).map(({ _ph, ...rest }) => rest),
      });
    }
  }

  // Dedicated Microneedling & Barrier Recovery Night (strictly holds irritating actives!)
  if (microneedlingEntry) {
    const gentleRecoverySteps = pmBaseRaw.filter(
      (s) => !isIrritatingPostMicroneedling(skinEntries.find((e) => e.compound.id === s.compoundId)?.compound),
    );
    const deviceStep = {
      ...toPublicStep(microneedlingEntry, [
        'Weekly microneedling session (hold retinoids/acids/BPO/Minoxidil 12–24h)',
      ]),
      _ph: 7.0,
    };
    const steps = sortDermSteps([deviceStep, ...gentleRecoverySteps]).map(({ _ph, ...rest }) => rest);
    pmNights.push({
      nightLabel: 'Microneedling & 24h Recovery Buffer Night',
      daysOfWeek: [...microneedlingDays].sort((a, b) => a - b),
      theme: 'microneedling_recovery',
      steps,
    });
  }

  // Missing SPF warning
  const missingSpfWarning =
    hasPhotosensitizingInSkin && !hasSpfInSkin
      ? 'Photosensitizing topical active(s) detected with no broad-spectrum SPF sunscreen in stack. Add a daily AM SPF 30–50+ sunscreen to prevent UV damage.'
      : null;

  return {
    dermatology: {
      skin: {
        am: skinAm,
        pmNights,
        missingSpfWarning,
        microneedlingBufferNotes,
      },
      hairScalp: {
        am: sortDermSteps(hairAm),
        pm: sortDermSteps(hairPm),
        weekly: sortDermSteps(hairWeekly),
      },
    },
    autoSeparated: dermAutoSeparated,
    alternateDayPairs: dermAlternateDayPairs,
  };
}
