/**
 * Unified Dual-Track Stack Spreader (Systemic + Dermatology Skin & Hair/Scalp)
 * with Ownership Filtering, What-If Wishlist Simulation & Explainable Rationale
 * (F30, F31, F32, F33, F34, F35, F36, F37).
 *
 * Pure ESM, zero UI/DOM/Node-only dependencies.
 */

import {
  dkToday,
  dkValid,
  resolveEffectiveOwnership,
} from '../core/index.js';
import {
  analyzeStackInteractions,
  isDermatologyCompound,
  lookupCompound,
} from './interactions.js';
import { solveSystemicSchedule } from './systemic.js';
import { solveDermatologySchedule } from './dermatology.js';

function resolveOwnershipStatus(compoundId, memberId, ownershipByCompound) {
  if (!ownershipByCompound) return 'dont_have';

  // Array of OwnershipRecord objects (canonical hub state.ownership)
  if (Array.isArray(ownershipByCompound)) {
    const resolved = resolveEffectiveOwnership(compoundId, memberId, ownershipByCompound);
    return resolved?.status || 'dont_have';
  }

  // Map or plain object keyed by compoundId -> status string or OwnershipRecord
  const entry =
    ownershipByCompound instanceof Map
      ? ownershipByCompound.get(compoundId)
      : ownershipByCompound[compoundId];

  if (!entry) return 'dont_have';
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    const resolved = resolveEffectiveOwnership(compoundId, memberId, entry);
    return resolved?.status || 'dont_have';
  }
  return entry.status || 'dont_have';
}

function isOwnedStatus(status) {
  return status === 'have' || status === 'low_stock';
}

function normalizeWhatIfItem(entry, idx) {
  if (typeof entry === 'string') {
    return {
      id: `whatif_${idx}_${entry}`,
      compoundId: entry,
      isWhatIf: true,
    };
  }
  if (entry && typeof entry === 'object' && typeof entry.compoundId === 'string') {
    return {
      id: entry.id || `whatif_${idx}_${entry.compoundId}`,
      ...entry,
      isWhatIf: true,
    };
  }
  return null;
}

/**
 * Computes a complete deterministic dual-track schedule for a member stack.
 * Non-mutating: never alters the caller's `stack`, `member`, or `compoundsById`.
 */
export function suggestStackSchedule({
  stack = {},
  compoundsById = {},
  member = null,
  ownershipByCompound = null,
  dateKey = null,
  whatIfCompounds = [],
  haveOnly = undefined,
} = {}) {
  const memberId = member?.id || stack?.memberId || 'member_wife';
  const stackId = stack?.id || 'ephemeral_stack';
  const resolvedDateKey =
    dateKey && dkValid(dateKey) ? dateKey : dkToday(member?.routineAnchors?.tz || 'UTC');

  // Determine effective haveOnly filter (explicit request option > stack.haveOnly > stack.onlyOwned)
  const effectiveHaveOnly =
    typeof haveOnly === 'boolean'
      ? haveOnly
      : typeof stack?.haveOnly === 'boolean'
        ? stack.haveOnly
        : Boolean(stack?.onlyOwned);

  // Merge base stack items + non-mutating What-If items
  const baseItems = Array.isArray(stack?.items) ? stack.items : [];
  const mergedItems = [];

  for (let i = 0; i < baseItems.length; i++) {
    const item = baseItems[i];
    if (!item || !item.compoundId) continue;
    const compound = lookupCompound(compoundsById, item.compoundId);
    if (!compound) continue;
    mergedItems.push({
      stackItemId: item.id || `item_${i}_${compound.id}`,
      item,
      compound,
      ownershipStatus: resolveOwnershipStatus(compound.id, memberId, ownershipByCompound),
      isWhatIf: false,
    });
  }

  for (let i = 0; i < (whatIfCompounds || []).length; i++) {
    const normItem = normalizeWhatIfItem(whatIfCompounds[i], i);
    if (!normItem) continue;
    const compound = lookupCompound(compoundsById, normItem.compoundId);
    if (!compound) continue;
    mergedItems.push({
      stackItemId: normItem.id,
      item: normItem,
      compound,
      ownershipStatus: resolveOwnershipStatus(compound.id, memberId, ownershipByCompound),
      isWhatIf: true,
    });
  }

  // Compute stockSummary across all considered items (including What-If for shopping preview)
  const missing = [];
  let haveCount = 0;
  for (const entry of mergedItems) {
    if (isOwnedStatus(entry.ownershipStatus)) {
      haveCount += 1;
    } else {
      missing.push({
        compoundId: entry.compound.id,
        name: entry.compound.name,
        status: entry.ownershipStatus,
        isWhatIf: entry.isWhatIf,
      });
    }
  }
  const stockSummary = {
    total: mergedItems.length,
    have: haveCount,
    missing,
  };

  // Apply haveOnly filter for scheduling (What-If items are always included in preview)
  const activeEntries = effectiveHaveOnly
    ? mergedItems.filter((e) => e.isWhatIf || isOwnedStatus(e.ownershipStatus))
    : mergedItems;

  // Run full interaction analysis over active entries
  const analysis = analyzeStackInteractions({
    items: activeEntries.map((e) => e.item),
    compoundsById,
    member,
    ownershipByCompound,
  });

  // Partition into Systemic vs Dermatology tracks
  const systemicEntries = [];
  const dermEntries = [];
  for (const entry of activeEntries) {
    if (isDermatologyCompound(entry.compound)) {
      dermEntries.push(entry);
    } else {
      systemicEntries.push(entry);
    }
  }

  const systemicResult = solveSystemicSchedule({
    entries: systemicEntries,
    member,
    interactions: analysis,
    dateKey: resolvedDateKey,
  });

  const dermResult = solveDermatologySchedule({
    entries: dermEntries,
    interactions: analysis,
  });

  // Merge solver outcomes into unified interactions summary
  const autoSeparated = [...systemicResult.autoSeparated, ...dermResult.autoSeparated];
  const alternateDayPairs = [...systemicResult.alternateDayPairs, ...dermResult.alternateDayPairs];
  const cautions = [...analysis.cautions, ...systemicResult.unresolvedConflicts];

  // Build concise top-level explanations
  const explanations = [];
  if (analysis.hardStops.length > 0) {
    explanations.push(
      `CRITICAL: ${analysis.hardStops.length} hard-stop safety alert(s) detected — review hard-stop banner before using this stack.`,
    );
  }
  if (autoSeparated.length > 0) {
    explanations.push(
      `Automatically separated ${autoSeparated.length} incompatible pair(s) into distinct time slots.`,
    );
  }
  if (alternateDayPairs.length > 0) {
    explanations.push(
      `Scheduled ${alternateDayPairs.length} active pair(s) onto alternating days/nights to avoid irritation or antagonism.`,
    );
  }
  if (systemicResult.unresolvedConflicts.length > 0) {
    for (const u of systemicResult.unresolvedConflicts) {
      explanations.push(u.mechanism);
    }
  }
  if (analysis.synergies.length > 0) {
    explanations.push(`Co-located ${analysis.synergies.length} synergistic pair(s) for enhanced efficacy.`);
  }
  if (analysis.ulWarnings.length > 0) {
    explanations.push(
      `${analysis.ulWarnings.length} cumulative micronutrient(s) exceed the NIH Adult Tolerable Upper Intake Level (UL).`,
    );
  }
  if (dermResult.dermatology.skin.missingSpfWarning) {
    explanations.push(dermResult.dermatology.skin.missingSpfWarning);
  }
  if (whatIfCompounds && whatIfCompounds.length > 0) {
    explanations.push(
      `What-If simulation previewing ${whatIfCompounds.length} additional compound(s) without mutating your saved stack.`,
    );
  }
  if (effectiveHaveOnly && missing.length > 0) {
    explanations.push(
      `Have-only mode active: excluded ${missing.length} unowned/wishlist item(s) from active slots.`,
    );
  }

  return {
    memberId,
    stackId,
    dateKey: resolvedDateKey,
    generatedAt: new Date().toISOString(),
    systemic: systemicResult.systemic,
    dermatology: dermResult.dermatology,
    interactions: {
      hardStops: analysis.hardStops,
      autoSeparated,
      alternateDayPairs,
      cautions,
      synergies: analysis.synergies,
      ulWarnings: analysis.ulWarnings,
      redundancies: analysis.redundancies,
      safetyAlerts: analysis.safetyAlerts,
    },
    stockSummary,
    explanations,
  };
}
