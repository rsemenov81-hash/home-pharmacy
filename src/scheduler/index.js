/**
 * Barrel export for Home Pharmacy Interaction Matrix & Dual-Track Stack Spreading Engine (`src/scheduler/`).
 * Pure ESM, zero UI/DOM/Node-only dependencies.
 */

export {
  CURATED_PAIR_INTERACTIONS,
  CURATED_SYNERGIES,
  analyzeStackInteractions,
  isDermatologyCompound,
  lookupCompound,
  normalizeNutrientKey,
} from './interactions.js';

export {
  buildSlotClockMap,
  slotSeparationHours,
  solveSystemicSchedule,
} from './systemic.js';

export { solveDermatologySchedule } from './dermatology.js';

export { suggestStackSchedule } from './spreader.js';
