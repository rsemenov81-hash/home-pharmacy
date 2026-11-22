/**
 * Pure domain calculators for Home Pharmacy:
 * - Reconstitution & U-100 syringe draw math (mass & IU, solvent overrides)
 * - Pre-mixed oil draw math (PEDs)
 * - Blend multi-component per-shot breakdown
 * - 8-site injection rotation
 * - Structured half-life & PK dose-equivalent decay (with strict refusal for blends/unmodeled/IU-mass mismatch)
 * - DST-safe UTC-noon calendar, dated timeline revisions & cycleStatus
 * - Supply run-out projection & stock deduction
 * - Advisory dose-sanity gate (evaluateDose + softenVerdict) & adherence
 *
 * Pure ESM, zero external dependencies, Node 22 + browser + Cloudflare Workers compatible.
 * Acyclic DAG Layer 2 (imports only constants.js and dedup.js).
 */

import {
  HOUR_MS,
  DAY_MS,
  LOW_STOCK_DOSE_THRESHOLD,
  SOLVENT_OVERRIDES,
  SOLVENT_LABELS,
  INJECTION_SITES,
  DEFAULT_DOSE_CEILINGS,
  MASS_TO_MCG,
  CANONICAL_UNITS,
  PK_DISCLAIMER,
  PEPTIDE_SOLVENTS,
  deepClone,
} from './constants.js';
import { normName, isBlendCompound } from './dedup.js';

// ---------------------------------------------------------------------------
// 1. Strict Numeric, Unit Normalization & Solvent Helpers
// ---------------------------------------------------------------------------

const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

function makeNullProtoMap(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

const getSolventLabel = (s) => (hasOwn(SOLVENT_LABELS, s) ? SOLVENT_LABELS[s] : String(s));

/**
 * Strictly parse finite numbers without JavaScript boolean/empty/array coercion bugs.
 * Returns NaN for booleans, null, undefined, '', objects, arrays, NaN, Infinity.
 */
export function parseFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

const UNIT_ALIASES = makeNullProtoMap({
  mcg: 'mcg',
  ug: 'mcg',
  'µg': 'mcg',
  'μg': 'mcg',
  mg: 'mg',
  g: 'g',
  iu: 'IU',
  ml: 'mL',
  '%': '%',
  drop: 'drops',
  drops: 'drops',
  pump: 'pumps',
  pumps: 'pumps',
  spray: 'sprays',
  sprays: 'sprays',
  cap: 'caps',
  caps: 'caps',
  capsule: 'caps',
  capsules: 'caps',
  scoop: 'scoops',
  scoops: 'scoops',
  pea_size: 'pea_size',
  peasize: 'pea_size',
  'pea-size': 'pea_size',
});

const CANONICAL_UNIT_SET = new Set(CANONICAL_UNITS);

export function normalizeUnit(unit) {
  if (typeof unit !== 'string') return null;
  const raw = unit.trim();
  if (!raw) return null;
  if (CANONICAL_UNIT_SET.has(raw)) return raw;
  const lower = raw.toLowerCase();
  if (hasOwn(UNIT_ALIASES, lower)) return UNIT_ALIASES[lower];
  return null;
}

function hasNonEmptyRawUnit(raw) {
  if (raw == null) return false;
  if (typeof raw === 'string') return raw.trim() !== '';
  return true;
}

function formatRawUnitLabel(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) return '[]';
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

export function unitDimension(unit) {
  const u = normalizeUnit(unit);
  if (!u) return 'unknown';
  if (u === 'mcg' || u === 'mg' || u === 'g') return 'mass';
  if (u === 'IU') return 'IU';
  if (u === 'mL') return 'volume';
  return 'count_or_topical';
}

/**
 * Convert strictly mass units ('mcg', 'mg', 'g') into mcg.
 * NEVER converts 'IU', 'mL', '%', or unknown units (returns null).
 */
export function toMassMcg(value, unit) {
  const n = parseFiniteNumber(value);
  if (!Number.isFinite(n)) return null;
  const u = normalizeUnit(unit);
  if (!u || !hasOwn(MASS_TO_MCG, u)) return null;
  const out = n * MASS_TO_MCG[u];
  return Number.isFinite(out) ? out : null;
}

export function toCanonicalAmount(value, unit) {
  const n = parseFiniteNumber(value);
  if (!Number.isFinite(n)) return null;
  const u = normalizeUnit(unit);
  if (!u) return null;
  const dim = unitDimension(u);
  if (dim === 'mass' && hasOwn(MASS_TO_MCG, u)) {
    const amount = n * MASS_TO_MCG[u];
    if (!Number.isFinite(amount)) return null;
    return {
      amount,
      dimension: 'mass',
      canonicalUnit: 'mcg',
      originalUnit: u,
    };
  }
  return {
    amount: n,
    dimension: dim,
    canonicalUnit: u,
    originalUnit: u,
  };
}

/**
 * Harmonize legacy protocol-os dose records (`{ doseMcg, doseUnit, doseValue }`)
 * and modern Home Pharmacy dose records (`{ doseAmount, doseUnit }`).
 * Strictly preserves IU independence.
 */
export function canonicalizeDose(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = { ...record };
  const rawUnit = out.doseUnit ?? out.unit ?? null;
  const normU = rawUnit != null ? normalizeUnit(rawUnit) : null;

  const hasDoseAmount = out.doseAmount != null || out.amount != null;
  const hasDoseMcg = out.doseMcg != null;

  if (hasDoseMcg && !hasDoseAmount) {
    const m = parseFiniteNumber(out.doseMcg);
    if (!(m > 0)) {
      if (out.doseUnit !== undefined || out.doseValue !== undefined) {
        out.doseUnit = null;
        out.doseValue = null;
      }
      return out;
    }
    if (normU === 'IU') {
      out.doseUnit = 'IU';
      out.doseValue = m;
      out.doseAmount = m;
    } else if (normU === 'mg') {
      out.doseUnit = 'mg';
      out.doseValue = m / 1000;
      out.doseAmount = m / 1000;
    } else if (normU === 'g') {
      out.doseUnit = 'g';
      out.doseValue = m / 1_000_000;
      out.doseAmount = m / 1_000_000;
    } else {
      out.doseUnit = normU || 'mcg';
      out.doseValue = m;
      out.doseAmount = m;
    }
    return out;
  }

  if (hasDoseAmount) {
    const rawAmt = out.doseAmount ?? out.amount;
    const n = parseFiniteNumber(rawAmt);
    if (!(n > 0)) {
      out.doseValue = null;
      return out;
    }
    const u = normU || 'mcg';
    out.doseUnit = u;
    out.doseValue = n;
    out.doseAmount = n;
    if (unitDimension(u) === 'mass') {
      out.doseMcg = toMassMcg(n, u);
    } else if (u === 'IU') {
      // Never falsely claim an IU dose is mass in mcg on new records
      if (!hasDoseMcg) out.doseMcg = null;
    }
  }

  return out;
}

function formatTrimmedNumber(n, maxDecimals = 2) {
  const factor = 10 ** maxDecimals;
  const scaled = n * factor;
  let rounded = Number.isFinite(scaled) ? Math.round(scaled) / factor : n;
  if (Object.is(rounded, -0)) rounded = 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  }).format(rounded);
}

export function formatDose(amount, unit) {
  const n = parseFiniteNumber(amount);
  if (!Number.isFinite(n)) return '—';
  const raw = String(unit || '').trim();
  const u = raw === 'mass' ? 'mcg' : normalizeUnit(raw) || raw;

  if (u === 'IU') {
    return `${formatTrimmedNumber(n, 2)} IU`;
  }
  if (raw === 'mass' || u === 'mcg') {
    if (Math.abs(n) >= 1_000_000) {
      return `${formatTrimmedNumber(n / 1_000_000, 3)} g`;
    }
    if (Math.abs(n) >= 1000) {
      return `${formatTrimmedNumber(n / 1000, 3)} mg`;
    }
    return `${formatTrimmedNumber(n, 2)} mcg`;
  }
  if (!u) return formatTrimmedNumber(n, 3);
  return `${formatTrimmedNumber(n, 3)} ${u}`;
}

// Normalized solvent override lookup covering canonical IDs, slugs, and aliases
const NORMALIZED_SOLVENT_MAP = makeNullProtoMap({
  ara290: 'PBS',
  cibinetide: 'PBS',
  igf1lr3: 'acetic_acid',
  igflr3: 'acetic_acid',
  longr3igf1: 'acetic_acid',
  aod9604: 'acetic_acid',
});

const SOLVENT_TOKEN_PATTERNS = [
  { re: /\b(?:ara[-\s]?290|cibinetide)\b/i, solvent: 'PBS' },
  { re: /\b(?:igf[-\s]?1[-\s]?lr3|igf1[-\s]?lr3|long[-\s]?r3[-\s]?igf[-\s]?1)\b/i, solvent: 'acetic_acid' },
  { re: /\b(?:aod[-\s]?9604)\b/i, solvent: 'acetic_acid' },
];

const VALID_SOLVENT_SET = new Set(PEPTIDE_SOLVENTS);

function matchAllSolventsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  const seen = new Set();
  const add = (solvent, token) => {
    if (!solvent || solvent === 'BAC' || seen.has(solvent)) return;
    seen.add(solvent);
    found.push({ solvent, token });
  };
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();
  if (hasOwn(SOLVENT_OVERRIDES, lowered)) add(SOLVENT_OVERRIDES[lowered], trimmed);
  const nk = normName(text);
  if (nk && hasOwn(NORMALIZED_SOLVENT_MAP, nk)) add(NORMALIZED_SOLVENT_MAP[nk], trimmed);
  for (const { re, solvent } of SOLVENT_TOKEN_PATTERNS) {
    const m = re.exec(text);
    if (m) add(solvent, m[0]);
  }
  return found;
}

export function getSolventInfo(compoundOrId, components = null) {
  // 1. Collect blend components if present
  const compEntries = [];
  if (Array.isArray(components)) {
    for (const c of components) {
      if (typeof c === 'string') {
        compEntries.push({ id: c, name: c });
      } else if (c && typeof c === 'object') {
        const id = c.id || c.compoundId || c.peptideId || c.name || '';
        compEntries.push({ id: String(id), name: String(c.name || id) });
      }
    }
  } else if (compoundOrId && typeof compoundOrId === 'object') {
    const ing = compoundOrId.sectionData?.ingredients || compoundOrId.ingredients;
    if (ing && typeof ing === 'object' && !Array.isArray(ing)) {
      for (const k of Object.keys(ing)) {
        compEntries.push({ id: k, name: k });
      }
    }
  }

  if (compEntries.length > 0) {
    const found = [];
    for (const comp of compEntries) {
      const matches = [
        ...matchAllSolventsFromText(comp.id),
        ...matchAllSolventsFromText(comp.name),
      ];
      const addedForComp = new Set();
      for (const m of matches) {
        if (addedForComp.has(m.solvent)) continue;
        addedForComp.add(m.solvent);
        found.push({ solvent: m.solvent, id: comp.id, name: comp.name });
      }
    }
    if (found.length > 0) {
      const distinctSolvents = [...new Set(found.map((f) => f.solvent))];
      const first = found[0];
      if (distinctSolvents.length > 1) {
        return {
          solvent: first.solvent,
          label: getSolventLabel(first.solvent),
          isOverride: true,
          solventConflict: true,
          triggeredBy: found.map((f) => f.id),
          warning: `Blend mixes components requiring incompatible solvents (${distinctSolvents.join(' vs ')}).`,
        };
      }
      return {
        solvent: first.solvent,
        label: getSolventLabel(first.solvent),
        isOverride: true,
        solventConflict: false,
        triggeredBy: first.id,
        warning: `Preferred solvent: ${getSolventLabel(first.solvent)} (required by ${first.name}, not plain BAC).`,
      };
    }
  }

  // 2. Explicit sectionData.preferredSolvent
  if (compoundOrId && typeof compoundOrId === 'object') {
    const explicit = compoundOrId.sectionData?.preferredSolvent || compoundOrId.preferredSolvent;
    if (explicit && VALID_SOLVENT_SET.has(explicit) && explicit !== 'BAC') {
      const label = getSolventLabel(explicit);
      const name = compoundOrId.name || compoundOrId.id || 'this compound';
      return {
        solvent: explicit,
        label,
        isOverride: true,
        solventConflict: false,
        triggeredBy: compoundOrId.id || compoundOrId.slug || name,
        warning: `Preferred solvent: ${label} (specified for ${name}, not plain BAC).`,
      };
    }

    // 3. Match across compound metadata fields (detecting multi-solvent string blends too)
    const candidates = [
      compoundOrId.id,
      compoundOrId.slug,
      compoundOrId.canonicalMolecule,
      compoundOrId.name,
      ...(Array.isArray(compoundOrId.aliases) ? compoundOrId.aliases : []),
    ].filter((x) => typeof x === 'string' && x.trim());

    const found = [];
    const seenSolvents = new Set();
    for (const text of candidates) {
      for (const m of matchAllSolventsFromText(text)) {
        if (!seenSolvents.has(m.solvent)) {
          seenSolvents.add(m.solvent);
          found.push({ solvent: m.solvent, token: m.token, text });
        }
      }
    }
    if (found.length > 1) {
      const distinctSolvents = found.map((f) => f.solvent);
      return {
        solvent: found[0].solvent,
        label: getSolventLabel(found[0].solvent),
        isOverride: true,
        solventConflict: true,
        triggeredBy: found.map((f) => f.token),
        warning: `Blend mixes components requiring incompatible solvents (${distinctSolvents.join(' vs ')}).`,
      };
    }
    if (found.length === 1) {
      const s = found[0].solvent;
      const label = getSolventLabel(s);
      const displayName = compoundOrId.name || found[0].text;
      return {
        solvent: s,
        label,
        isOverride: true,
        solventConflict: false,
        triggeredBy: compoundOrId.id || found[0].text,
        warning: `Preferred solvent: ${label} (required by ${displayName}, not plain BAC).`,
      };
    }
  } else if (typeof compoundOrId === 'string') {
    const found = matchAllSolventsFromText(compoundOrId);
    if (found.length > 1) {
      const distinctSolvents = found.map((f) => f.solvent);
      return {
        solvent: found[0].solvent,
        label: getSolventLabel(found[0].solvent),
        isOverride: true,
        solventConflict: true,
        triggeredBy: found.map((f) => f.token),
        warning: `Blend mixes components requiring incompatible solvents (${distinctSolvents.join(' vs ')}).`,
      };
    }
    if (found.length === 1) {
      const s = found[0].solvent;
      const label = getSolventLabel(s);
      return {
        solvent: s,
        label,
        isOverride: true,
        solventConflict: false,
        triggeredBy: compoundOrId,
        warning: `Preferred solvent: ${label} (required by ${compoundOrId}, not plain BAC).`,
      };
    }
  }

  return {
    solvent: 'BAC',
    label: getSolventLabel('BAC'),
    isOverride: false,
    solventConflict: false,
    triggeredBy: null,
    warning: null,
  };
}

export function getPreferredSolvent(compoundOrId, components = null) {
  return getSolventInfo(compoundOrId, components).solvent;
}

export const solventForCompound = getPreferredSolvent;

// ---------------------------------------------------------------------------
// 2. Reconstitution, Pre-Mixed Oil, Blend Breakdown & 8-Site Rotation
// ---------------------------------------------------------------------------

/**
 * Reconstitution & U-100 syringe draw calculator (F11).
 * Supports both options object and legacy positional `(vialMg, diluentMl, doseMcg)`.
 * Strictly guards IU vs mass dimensional independence.
 */
export function vialMath(inputOrMg, diluentMlArg, doseMcgArg) {
  let opts;
  if (inputOrMg && typeof inputOrMg === 'object' && !Array.isArray(inputOrMg)) {
    opts = inputOrMg;
  } else {
    opts = {
      vialMg: inputOrMg,
      diluentMl: diluentMlArg,
      doseMcg: doseMcgArg,
    };
  }

  const diluentMl = parseFiniteNumber(opts.diluentMl);
  if (!(diluentMl > 0)) {
    return { ok: false, code: 'INVALID_DILUENT', error: 'diluentMl must be a finite number greater than 0.' };
  }

  const syringeScale = opts.syringeScale === undefined ? 100 : parseFiniteNumber(opts.syringeScale);
  if (!(syringeScale > 0)) {
    return { ok: false, code: 'INVALID_SYRINGE_SCALE', error: 'syringeScale must be a finite number greater than 0.' };
  }

  const hasVialMg = opts.vialMg !== undefined && opts.vialMg !== null;
  const hasVialIU = opts.vialIU !== undefined && opts.vialIU !== null;

  if (hasVialMg && hasVialIU) {
    return { ok: false, code: 'AMBIGUOUS_VIAL_UNIT', error: 'Specify either vialMg or vialIU, not both.' };
  }
  if (!hasVialMg && !hasVialIU) {
    return { ok: false, code: 'INVALID_VIAL_AMOUNT', error: 'Provide a positive vialMg or vialIU amount.' };
  }

  // Solvent resolution
  const recommendedSolventInfo = getSolventInfo(opts.compound || opts.compoundId || null);
  let solventInfo = recommendedSolventInfo;
  let solventMismatchWarning = null;
  if (opts.solvent && VALID_SOLVENT_SET.has(opts.solvent)) {
    const selectedLabel = getSolventLabel(opts.solvent);
    if (recommendedSolventInfo.isOverride && opts.solvent !== recommendedSolventInfo.solvent) {
      solventMismatchWarning = {
        code: 'SOLVENT_MISMATCH',
        severity: 'warn',
        message: `Selected solvent ${selectedLabel} conflicts with recommended ${recommendedSolventInfo.label} for this compound.`,
      };
    }
    solventInfo = {
      ...recommendedSolventInfo,
      solvent: opts.solvent,
      label: selectedLabel,
      isOverride: opts.solvent !== 'BAC',
      warning:
        opts.solvent !== 'BAC'
          ? recommendedSolventInfo.solvent === opts.solvent && recommendedSolventInfo.warning
            ? recommendedSolventInfo.warning
            : `Preferred solvent: ${selectedLabel}.`
          : null,
    };
  }

  const normalizedDoseUnit = opts.doseUnit != null ? normalizeUnit(opts.doseUnit) : null;
  if (opts.doseUnit != null && !normalizedDoseUnit) {
    return { ok: false, code: 'INVALID_DOSE', error: `Unrecognized doseUnit "${opts.doseUnit}".` };
  }

  if (hasVialMg) {
    const vialMg = parseFiniteNumber(opts.vialMg);
    if (!(vialMg > 0)) {
      return { ok: false, code: 'INVALID_VIAL_AMOUNT', error: 'vialMg must be a finite number greater than 0.' };
    }

    // Strict IU dimension guard
    if (normalizedDoseUnit === 'IU' || (opts.doseIU !== undefined && opts.doseIU !== null)) {
      return {
        ok: false,
        code: 'UNIT_DIMENSION_MISMATCH',
        error: 'Cannot compute an IU dose from a mass (mg) vial — IU and mass are independent dimensions.',
      };
    }
    if (normalizedDoseUnit && unitDimension(normalizedDoseUnit) !== 'mass') {
      return {
        ok: false,
        code: 'UNIT_DIMENSION_MISMATCH',
        error: `Incompatible doseUnit "${normalizedDoseUnit}" for a mass (mg) vial.`,
      };
    }

    let doseMcgNormalized = 0;
    if (opts.doseAmount !== undefined && opts.doseAmount !== null) {
      const amt = parseFiniteNumber(opts.doseAmount);
      if (!(amt >= 0)) {
        return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount must be a finite number >= 0.' };
      }
      doseMcgNormalized = amt === 0 ? 0 : toMassMcg(amt, normalizedDoseUnit || 'mcg');
      if (doseMcgNormalized === null) {
        return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount overflowed finite mass range.' };
      }
    } else if (opts.doseMcg !== undefined && opts.doseMcg !== null) {
      const amt = parseFiniteNumber(opts.doseMcg);
      if (!(amt >= 0)) {
        return { ok: false, code: 'INVALID_DOSE', error: 'doseMcg must be a finite number >= 0.' };
      }
      doseMcgNormalized = amt;
    }

    const totalMcg = vialMg * 1000;
    const mgPerMl = vialMg / diluentMl;
    const mcgPerMl = totalMcg / diluentMl;
    const mcgPerUnit = mcgPerMl / syringeScale;
    const mlPerDose = doseMcgNormalized > 0 ? doseMcgNormalized / mcgPerMl : 0;
    const unitsPerDose = mlPerDose * syringeScale;
    const dosesPerVial = doseMcgNormalized > 0 ? Math.floor(totalMcg / doseMcgNormalized + 1e-9) : 0;
    if (
      !Number.isFinite(totalMcg) ||
      !Number.isFinite(mgPerMl) ||
      !Number.isFinite(mcgPerMl) ||
      !Number.isFinite(mcgPerUnit) ||
      !Number.isFinite(mlPerDose) ||
      !Number.isFinite(unitsPerDose) ||
      !Number.isFinite(dosesPerVial)
    ) {
      return { ok: false, code: 'NUMERIC_OVERFLOW', error: 'Reconstitution calculation exceeded finite numeric range.' };
    }
    const overVial = doseMcgNormalized > totalMcg + 1e-9;
    const overBarrel = unitsPerDose > syringeScale + 1e-9;

    const warnings = [];
    if (overVial) {
      warnings.push({ code: 'DOSE_EXCEEDS_VIAL', severity: 'warn', message: 'Dose exceeds total vial content.' });
    }
    if (overBarrel) {
      warnings.push({
        code: 'EXCEEDS_U100_BARREL',
        severity: 'warn',
        message: `Draw exceeds a full 1 mL U-${syringeScale} syringe (${syringeScale} units).`,
      });
    }
    if (solventMismatchWarning) {
      warnings.push(solventMismatchWarning);
    } else if (solventInfo.isOverride && solventInfo.warning) {
      warnings.push({ code: 'SPECIAL_SOLVENT', severity: 'warn', message: solventInfo.warning });
    }

    return {
      ok: true,
      dimension: 'mass',
      unit: 'mcg',
      vialMg,
      totalMcg,
      diluentMl,
      mgPerMl,
      mcgPerMl,
      mcgPerUnit,
      doseMcg: doseMcgNormalized,
      mlPerDose,
      volPerDose: mlPerDose,
      unitsPerDose,
      dosesPerVial,
      totalDoses: dosesPerVial,
      overVial,
      overBarrel,
      solvent: solventInfo.solvent,
      solventLabel: solventInfo.label,
      warnings,
    };
  }

  // IU Vial path
  const vialIU = parseFiniteNumber(opts.vialIU);
  if (!(vialIU > 0)) {
    return { ok: false, code: 'INVALID_VIAL_AMOUNT', error: 'vialIU must be a finite number greater than 0.' };
  }

  if (
    (normalizedDoseUnit && normalizedDoseUnit !== 'IU') ||
    (opts.doseMcg !== undefined && opts.doseMcg !== null)
  ) {
    return {
      ok: false,
      code: 'UNIT_DIMENSION_MISMATCH',
      error: 'Cannot compute a mass (mcg/mg/g) dose from an IU vial — IU and mass are independent dimensions.',
    };
  }

  let doseIUNormalized = 0;
  if (opts.doseIU !== undefined && opts.doseIU !== null) {
    const amt = parseFiniteNumber(opts.doseIU);
    if (!(amt >= 0)) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseIU must be a finite number >= 0.' };
    }
    doseIUNormalized = amt;
  } else if (opts.doseAmount !== undefined && opts.doseAmount !== null) {
    const amt = parseFiniteNumber(opts.doseAmount);
    if (!(amt >= 0)) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount must be a finite number >= 0.' };
    }
    doseIUNormalized = amt;
  }

  const iuPerMl = vialIU / diluentMl;
  const iuPerUnit = iuPerMl / syringeScale;
  const mlPerDose = doseIUNormalized > 0 ? doseIUNormalized / iuPerMl : 0;
  const unitsPerDose = mlPerDose * syringeScale;
  const dosesPerVial = doseIUNormalized > 0 ? Math.floor(vialIU / doseIUNormalized + 1e-9) : 0;
  if (
    !Number.isFinite(iuPerMl) ||
    !Number.isFinite(iuPerUnit) ||
    !Number.isFinite(mlPerDose) ||
    !Number.isFinite(unitsPerDose) ||
    !Number.isFinite(dosesPerVial)
  ) {
    return { ok: false, code: 'NUMERIC_OVERFLOW', error: 'Reconstitution calculation exceeded finite numeric range.' };
  }
  const overVial = doseIUNormalized > vialIU + 1e-9;
  const overBarrel = unitsPerDose > syringeScale + 1e-9;

  const warnings = [];
  if (overVial) {
    warnings.push({ code: 'DOSE_EXCEEDS_VIAL', severity: 'warn', message: 'Dose exceeds total vial IU content.' });
  }
  if (overBarrel) {
    warnings.push({
      code: 'EXCEEDS_U100_BARREL',
      severity: 'warn',
      message: `Draw exceeds a full 1 mL U-${syringeScale} syringe (${syringeScale} units).`,
    });
  }
  if (solventMismatchWarning) {
    warnings.push(solventMismatchWarning);
  } else if (solventInfo.isOverride && solventInfo.warning) {
    warnings.push({ code: 'SPECIAL_SOLVENT', severity: 'warn', message: solventInfo.warning });
  }

  return {
    ok: true,
    dimension: 'IU',
    unit: 'IU',
    vialIU,
    totalIU: vialIU,
    totalMcg: null,
    mcgPerMl: null,
    mcgPerUnit: null,
    diluentMl,
    iuPerMl,
    iuPerUnit,
    doseIU: doseIUNormalized,
    mlPerDose,
    volPerDose: mlPerDose,
    unitsPerDose,
    dosesPerVial,
    totalDoses: dosesPerVial,
    overVial,
    overBarrel,
    solvent: solventInfo.solvent,
    solventLabel: solventInfo.label,
    warnings,
  };
}

/**
 * Pre-mixed injectable oil draw math (F12, oilPreMixed).
 */
export function oilDrawMath(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'Input object is required.' };
  }

  const syringeScale = input.syringeScale === undefined ? 100 : parseFiniteNumber(input.syringeScale);
  if (!(syringeScale > 0)) {
    return { ok: false, code: 'INVALID_SYRINGE_SCALE', error: 'syringeScale must be a finite number greater than 0.' };
  }

  const rawUnit = input.doseUnit === undefined ? 'mg' : input.doseUnit;
  const normU = normalizeUnit(rawUnit);
  if (!normU || unitDimension(normU) !== 'mass') {
    return {
      ok: false,
      code: 'UNIT_DIMENSION_MISMATCH',
      error: `Pre-mixed oil calculations require a mass unit (mg/mcg/g); got "${rawUnit}".`,
    };
  }

  const hasConc = input.concentrationMgPerMl !== undefined && input.concentrationMgPerMl !== null;
  const hasTotal = input.totalMg !== undefined && input.totalMg !== null;
  const hasVialMl = input.vialMl !== undefined && input.vialMl !== null;

  const conc = hasConc ? parseFiniteNumber(input.concentrationMgPerMl) : NaN;
  const totalMgIn = hasTotal ? parseFiniteNumber(input.totalMg) : NaN;
  const vialMlIn = hasVialMl ? parseFiniteNumber(input.vialMl) : NaN;

  if (hasConc && !(conc > 0)) {
    return { ok: false, code: 'INVALID_CONCENTRATION', error: 'concentrationMgPerMl must be a finite number > 0.' };
  }
  if (hasTotal && !(totalMgIn > 0)) {
    return { ok: false, code: 'INVALID_CONCENTRATION', error: 'totalMg must be a finite number > 0.' };
  }
  if (hasVialMl && !(vialMlIn > 0)) {
    return { ok: false, code: 'INVALID_CONCENTRATION', error: 'vialMl must be a finite number > 0.' };
  }

  let mgPerMl;
  if (hasConc && hasTotal && hasVialMl) {
    const implied = totalMgIn / vialMlIn;
    if (Math.abs(conc - implied) / conc > 0.01) {
      return {
        ok: false,
        code: 'CONCENTRATION_MISMATCH',
        error: `concentrationMgPerMl (${conc}) does not match totalMg / vialMl (${implied.toFixed(2)}).`,
      };
    }
    mgPerMl = conc;
  } else if (hasConc) {
    mgPerMl = conc;
  } else if (hasTotal && hasVialMl) {
    mgPerMl = totalMgIn / vialMlIn;
  } else {
    return {
      ok: false,
      code: 'INVALID_CONCENTRATION',
      error: 'Provide concentrationMgPerMl or both totalMg and vialMl.',
    };
  }

  const resolvedTotalMg = hasTotal ? totalMgIn : hasVialMl ? mgPerMl * vialMlIn : null;
  const resolvedVialMl = hasVialMl ? vialMlIn : hasTotal ? totalMgIn / mgPerMl : null;

  let doseMcg;
  if (input.doseMg !== undefined && input.doseMg !== null) {
    const d = parseFiniteNumber(input.doseMg);
    if (!(d >= 0)) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseMg must be a finite number >= 0.' };
    }
    doseMcg = d * 1000;
    if (!Number.isFinite(doseMcg)) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseMg overflowed finite mass range.' };
    }
  } else if (input.doseAmount !== undefined && input.doseAmount !== null) {
    const d = parseFiniteNumber(input.doseAmount);
    if (!(d >= 0)) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount must be a finite number >= 0.' };
    }
    doseMcg = toMassMcg(d, normU);
    if (doseMcg === null) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount overflowed finite mass range.' };
    }
  } else {
    doseMcg = 0;
  }

  const doseMgResolved = doseMcg / 1000;
  const mcgPerMl = mgPerMl * 1000;
  const mgPerUnit = mgPerMl / syringeScale;
  const mlPerDose = doseMgResolved > 0 ? doseMgResolved / mgPerMl : 0;
  const unitsPerDose = mlPerDose * syringeScale;
  const dosesPerVial =
    resolvedTotalMg != null && resolvedTotalMg > 0 && doseMgResolved > 0
      ? Math.floor(resolvedTotalMg / doseMgResolved + 1e-9)
      : null;
  if (
    !Number.isFinite(mgPerMl) ||
    !Number.isFinite(mcgPerMl) ||
    !Number.isFinite(mgPerUnit) ||
    !Number.isFinite(doseMcg) ||
    !Number.isFinite(doseMgResolved) ||
    !Number.isFinite(mlPerDose) ||
    !Number.isFinite(unitsPerDose) ||
    (resolvedTotalMg !== null && !Number.isFinite(resolvedTotalMg)) ||
    (resolvedVialMl !== null && !Number.isFinite(resolvedVialMl)) ||
    (dosesPerVial !== null && !Number.isFinite(dosesPerVial))
  ) {
    return { ok: false, code: 'NUMERIC_OVERFLOW', error: 'Oil draw calculation exceeded finite numeric range.' };
  }
  const overVial = resolvedTotalMg != null && resolvedTotalMg > 0 && doseMgResolved > resolvedTotalMg + 1e-9;
  const overBarrel = unitsPerDose > syringeScale + 1e-9;

  const warnings = [];
  if (overVial) {
    warnings.push({ code: 'DOSE_EXCEEDS_VIAL', severity: 'warn', message: 'Dose exceeds total vial oil content.' });
  }
  if (overBarrel) {
    warnings.push({
      code: 'EXCEEDS_U100_BARREL',
      severity: 'warn',
      message: 'Draw exceeds 1 mL U-100 syringe capacity — use a 3 mL IM barrel or split injection.',
    });
  }
  if (mlPerDose > 3) {
    warnings.push({
      code: 'LARGE_IM_VOLUME',
      severity: 'warn',
      message: 'Single draw volume exceeds 3 mL — consider splitting across injection sites.',
    });
  }

  return {
    ok: true,
    oilPreMixed: true,
    requiresReconstitution: false,
    mgPerMl,
    mcgPerMl,
    mgPerUnit,
    totalMg: resolvedTotalMg,
    vialMl: resolvedVialMl,
    doseMg: doseMgResolved,
    doseMcg,
    mlPerDose,
    volPerDose: mlPerDose,
    unitsPerDose,
    dosesPerVial,
    totalDoses: dosesPerVial,
    overVial,
    overBarrel,
    warnings,
  };
}

/**
 * Multi-component blend per-shot breakdown calculator (F11).
 * Supports both ratio-map (`ingredients` + `vialMg`) and component-array (`components[]`)
 * inputs, and dose-driven (`doseAmount`/`doseMcg`), unit-driven (`drawUnits`), or
 * volume-driven (`drawMl`) shot sizing.
 */
export function blendBreakdown(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'Input object is required.' };
  }

  const diluentMl = parseFiniteNumber(input.diluentMl);
  if (!(diluentMl > 0)) {
    return { ok: false, code: 'INVALID_DILUENT', error: 'diluentMl must be a finite number greater than 0.' };
  }

  const syringeScale = input.syringeScale === undefined ? 100 : parseFiniteNumber(input.syringeScale);
  if (!(syringeScale > 0)) {
    return { ok: false, code: 'INVALID_SYRINGE_SCALE', error: 'syringeScale must be a finite number greater than 0.' };
  }

  const rawItems = [];
  let totalVialMg = NaN;

  if (Array.isArray(input.components) && input.components.length > 0) {
    let hasMass = false;
    let hasFraction = false;
    let massSumMg = 0;

    for (const c of input.components) {
      if (!c || typeof c !== 'object') {
        return { ok: false, code: 'INVALID_COMPONENTS', error: 'Each component must be an object.' };
      }
      const id = String(c.id || c.compoundId || c.peptideId || c.name || '').trim();
      const name = String(c.name || id).trim();
      if (!id) {
        return { ok: false, code: 'INVALID_COMPONENTS', error: 'Each component must have an id or name.' };
      }

      if (c.mg != null || c.mcg != null) {
        hasMass = true;
        const mg = c.mg != null ? parseFiniteNumber(c.mg) : parseFiniteNumber(c.mcg) / 1000;
        if (!(mg > 0)) {
          return { ok: false, code: 'INVALID_COMPONENTS', error: `Component "${name}" mass must be > 0.` };
        }
        massSumMg += mg;
        rawItems.push({ id, name, weight: mg });
      } else if (c.fraction != null) {
        hasFraction = true;
        const frac = parseFiniteNumber(c.fraction);
        if (!(frac > 0)) {
          return { ok: false, code: 'INVALID_COMPONENTS', error: `Component "${name}" fraction must be > 0.` };
        }
        rawItems.push({ id, name, weight: frac });
      } else {
        return { ok: false, code: 'INVALID_COMPONENTS', error: `Component "${name}" requires mg, mcg, or fraction.` };
      }
    }

    if (hasMass && hasFraction) {
      return { ok: false, code: 'INVALID_COMPONENTS', error: 'Do not mix mass and fraction components in one blend.' };
    }

    if (hasMass) {
      if (input.vialMg != null) {
        const explicitVialMg = parseFiniteNumber(input.vialMg);
        if (!(explicitVialMg > 0)) {
          return { ok: false, code: 'INVALID_VIAL_AMOUNT', error: 'Total blend vialMg must be a finite number > 0.' };
        }
        if (Math.abs(explicitVialMg - massSumMg) / Math.max(explicitVialMg, massSumMg) > 0.01) {
          return {
            ok: false,
            code: 'VIAL_MASS_MISMATCH',
            error: `Explicit vialMg (${explicitVialMg}) contradicts sum of component masses (${massSumMg}).`,
          };
        }
        totalVialMg = explicitVialMg;
      } else {
        totalVialMg = massSumMg;
      }
    } else {
      totalVialMg = parseFiniteNumber(input.vialMg);
    }
  } else if (input.ingredients && typeof input.ingredients === 'object' && !Array.isArray(input.ingredients)) {
    const entries = Object.entries(input.ingredients);
    if (entries.length === 0) {
      return { ok: false, code: 'INVALID_COMPONENTS', error: 'ingredients map must be non-empty.' };
    }
    const namesById = input.namesById && typeof input.namesById === 'object' ? input.namesById : {};
    for (const [id, rawVal] of entries) {
      const w = parseFiniteNumber(rawVal);
      if (!(w > 0)) {
        return { ok: false, code: 'INVALID_COMPONENTS', error: `Ingredient "${id}" weight must be > 0.` };
      }
      const customName =
        hasOwn(namesById, id) && typeof namesById[id] === 'string' && namesById[id].trim()
          ? namesById[id].trim()
          : id;
      rawItems.push({ id, name: customName, weight: w });
    }
    totalVialMg = parseFiniteNumber(input.vialMg);
  } else {
    return { ok: false, code: 'INVALID_COMPONENTS', error: 'Provide either ingredients map or components array.' };
  }

  if (!(Number.isFinite(totalVialMg) && totalVialMg > 0)) {
    return { ok: false, code: 'INVALID_VIAL_AMOUNT', error: 'Total blend vialMg must be a finite number > 0.' };
  }

  const sumWeights = rawItems.reduce((acc, it) => acc + it.weight, 0);
  if (!(Number.isFinite(sumWeights) && sumWeights > 0)) {
    return { ok: false, code: 'INVALID_COMPONENTS', error: 'Component weights must sum to > 0.' };
  }

  const totalVialMcg = totalVialMg * 1000;
  const totalMcgPerMl = totalVialMcg / diluentMl;
  const totalMcgPerUnit = totalMcgPerMl / syringeScale;

  // Resolve shot sizing
  let mlPerDose = 0;
  let unitsPerDose = 0;
  let totalDoseMcg = 0;

  if (input.drawMl !== undefined && input.drawMl !== null) {
    const dMl = parseFiniteNumber(input.drawMl);
    if (!(dMl >= 0)) return { ok: false, code: 'INVALID_DOSE', error: 'drawMl must be finite >= 0.' };
    mlPerDose = dMl;
    unitsPerDose = dMl * syringeScale;
    totalDoseMcg = dMl * totalMcgPerMl;
  } else if (input.drawUnits !== undefined && input.drawUnits !== null) {
    const dU = parseFiniteNumber(input.drawUnits);
    if (!(dU >= 0)) return { ok: false, code: 'INVALID_DOSE', error: 'drawUnits must be finite >= 0.' };
    unitsPerDose = dU;
    mlPerDose = dU / syringeScale;
    totalDoseMcg = mlPerDose * totalMcgPerMl;
  } else if (input.doseAmount !== undefined && input.doseAmount !== null) {
    const amt = parseFiniteNumber(input.doseAmount);
    if (!(amt >= 0)) return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount must be finite >= 0.' };
    const u = input.doseUnit != null ? normalizeUnit(input.doseUnit) : 'mcg';
    if (!u || unitDimension(u) !== 'mass') {
      return { ok: false, code: 'UNIT_DIMENSION_MISMATCH', error: 'Blend dose requires a mass unit (mcg/mg/g).' };
    }
    totalDoseMcg = amt === 0 ? 0 : toMassMcg(amt, u);
    if (totalDoseMcg === null || !Number.isFinite(totalDoseMcg)) {
      return { ok: false, code: 'INVALID_DOSE', error: 'doseAmount overflowed finite mass range.' };
    }
    mlPerDose = totalDoseMcg / totalMcgPerMl;
    unitsPerDose = mlPerDose * syringeScale;
  } else if (input.doseMcg !== undefined && input.doseMcg !== null) {
    if (hasNonEmptyRawUnit(input.doseUnit)) {
      const u = normalizeUnit(input.doseUnit);
      if (!u || unitDimension(u) !== 'mass') {
        return { ok: false, code: 'UNIT_DIMENSION_MISMATCH', error: 'Blend dose requires a mass unit (mcg/mg/g).' };
      }
    }
    const dMcg = parseFiniteNumber(input.doseMcg);
    if (!(dMcg >= 0)) return { ok: false, code: 'INVALID_DOSE', error: 'doseMcg must be finite >= 0.' };
    totalDoseMcg = dMcg;
    mlPerDose = totalDoseMcg / totalMcgPerMl;
    unitsPerDose = mlPerDose * syringeScale;
  }

  const components = rawItems.map((it) => {
    const normalizedFraction = it.weight / sumWeights;
    const vialMg = totalVialMg * normalizedFraction;
    const vialMcg = vialMg * 1000;
    const mcgPerMl = vialMcg / diluentMl;
    const mcgPerUnit = mcgPerMl / syringeScale;
    const mcgPerShot = mlPerDose * mcgPerMl;
    const mgPerShot = mcgPerShot / 1000;
    const pct = Math.round(normalizedFraction * 1000) / 10;
    return {
      id: it.id,
      name: it.name,
      fraction: normalizedFraction,
      pct,
      vialMg,
      vialMcg,
      mcgPerMl,
      mcgPerUnit,
      mcgPerShot,
      mgPerShot,
    };
  });

  const dosesPerVial = totalDoseMcg > 0 ? Math.floor(totalVialMcg / totalDoseMcg + 1e-9) : 0;
  const allFinite =
    Number.isFinite(totalVialMcg) &&
    Number.isFinite(totalMcgPerMl) &&
    Number.isFinite(totalMcgPerUnit) &&
    Number.isFinite(totalDoseMcg) &&
    Number.isFinite(mlPerDose) &&
    Number.isFinite(unitsPerDose) &&
    Number.isFinite(dosesPerVial) &&
    components.every(
      (c) =>
        Number.isFinite(c.fraction) &&
        Number.isFinite(c.vialMg) &&
        Number.isFinite(c.vialMcg) &&
        Number.isFinite(c.mcgPerMl) &&
        Number.isFinite(c.mcgPerUnit) &&
        Number.isFinite(c.mcgPerShot) &&
        Number.isFinite(c.mgPerShot),
    );
  if (!allFinite) {
    return { ok: false, code: 'NUMERIC_OVERFLOW', error: 'Blend calculation exceeded finite numeric range.' };
  }
  const overVial = totalDoseMcg > totalVialMcg + 1e-9;
  const overBarrel = unitsPerDose > syringeScale + 1e-9;

  const solventInfo = getSolventInfo(null, components);
  const warnings = [];
  if (overVial) {
    warnings.push({ code: 'DOSE_EXCEEDS_VIAL', severity: 'warn', message: 'Blend shot exceeds total vial content.' });
  }
  if (overBarrel) {
    warnings.push({
      code: 'EXCEEDS_U100_BARREL',
      severity: 'warn',
      message: `Blend draw exceeds a full 1 mL U-${syringeScale} syringe (${syringeScale} units).`,
    });
  }
  if (solventInfo.solventConflict) {
    warnings.push({ code: 'SOLVENT_CONFLICT', severity: 'warn', message: solventInfo.warning });
  } else if (solventInfo.isOverride && solventInfo.warning) {
    warnings.push({ code: 'SPECIAL_SOLVENT', severity: 'warn', message: solventInfo.warning });
  }

  return {
    ok: true,
    vialMg: totalVialMg,
    totalVialMcg,
    diluentMl,
    totalMcgPerMl,
    totalMcgPerUnit,
    totalDoseMcg,
    totalDoseMg: totalDoseMcg / 1000,
    mlPerDose,
    volPerDose: mlPerDose,
    unitsPerDose,
    dosesPerVial,
    overVial,
    overBarrel,
    solvent: solventInfo.solvent,
    solventLabel: solventInfo.label,
    solventConflict: solventInfo.solventConflict,
    components,
    warnings,
  };
}

const SITE_SLUG_ALIASES = makeNullProtoMap({
  abdomen_l: 'L abdomen',
  abdomen_r: 'R abdomen',
  thigh_l: 'L thigh',
  thigh_r: 'R thigh',
  glute_l: 'L glute',
  glute_r: 'R glute',
  delt_l: 'L delt',
  delt_r: 'R delt',
});

function resolveSiteValue(site, sites) {
  if (!site || typeof site !== 'string') return null;
  const trimmed = site.trim();
  if (sites.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const mapped = hasOwn(SITE_SLUG_ALIASES, lower) ? SITE_SLUG_ALIASES[lower] : null;
  if (mapped && sites.includes(mapped)) return mapped;
  return trimmed;
}

export function rotateSite(lastSite, sites = INJECTION_SITES) {
  if (!Array.isArray(sites) || sites.length === 0) return null;
  const resolved = resolveSiteValue(lastSite, sites);
  const idx = sites.indexOf(resolved);
  return sites[(idx + 1) % sites.length];
}

export function nextInjectionSite(logs = [], options = {}) {
  const {
    compoundId = null,
    equivalentIds = null,
    memberId = null,
    sites = INJECTION_SITES,
  } = options || {};

  const siteList = Array.isArray(sites) && sites.length > 0 ? sites : INJECTION_SITES;
  const idSet = Array.isArray(equivalentIds)
    ? new Set(equivalentIds.map(String))
    : compoundId != null
      ? new Set([String(compoundId)])
      : null;

  const counts = {};
  for (const s of siteList) {
    if (s !== '__proto__') counts[s] = 0;
  }

  let last = null;
  let lastTs = -Infinity;

  for (const l of logs || []) {
    if (!l || typeof l !== 'object') continue;
    if (l.skipped === true) continue;
    if (!l.site || typeof l.site !== 'string' || !l.site.trim()) continue;

    if (memberId != null) {
      const owner = l.memberId ?? l.profile ?? null;
      if (owner !== memberId) continue;
    }

    if (idSet) {
      const cid = l.compoundId ?? l.peptideId ?? null;
      if (cid == null || !idSet.has(String(cid))) continue;
    }

    const siteVal = resolveSiteValue(l.site, siteList);
    if (Object.prototype.hasOwnProperty.call(counts, siteVal)) {
      counts[siteVal] += 1;
    }

    let ts = parseDoseTime(l.datetime);
    if (!Number.isFinite(ts) && typeof l.datetime === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(l.datetime)) {
        ts = dkParse(l.datetime);
      } else {
        ts = Date.parse(l.datetime);
      }
    }
    if (!Number.isFinite(ts)) ts = -Infinity;

    if (last === null || ts > lastTs || (ts === lastTs && String(l.datetime || '') > String(last.datetime || ''))) {
      last = { site: siteVal, datetime: l.datetime ?? null };
      lastTs = ts;
    }
  }

  const nextSite = rotateSite(last?.site ?? null, siteList);
  return {
    nextSite,
    lastSite: last?.site ?? null,
    lastAt: last?.datetime ?? null,
    index: siteList.indexOf(nextSite),
    totalSites: siteList.length,
    counts,
  };
}

// ---------------------------------------------------------------------------
// 3. Structured Half-Life & PK Dose-Equivalent Decay Engine (F10)
// ---------------------------------------------------------------------------

/**
 * Strict ISO / datetime-local timestamp parser with calendar & DST spring-forward guard.
 * Returns epoch ms or NaN.
 */
export function parseDoseTime(value) {
  if (typeof value !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!m) return NaN;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const hh = +m[4];
  const mm = +m[5];
  const ss = +(m[6] || 0);
  if (mo < 1 || mo > 12) return NaN;
  const maxDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > maxDay) return NaN;
  if (hh > 23 || mm > 59 || ss > 59) return NaN;

  const t = Date.parse(value);
  if (!Number.isFinite(t)) return NaN;
  // Zone-less datetime-local: reject nonexistent local wall-clock times during DST spring-forward jump
  if (!m[7]) {
    const dt = new Date(t);
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() + 1 !== mo ||
      dt.getDate() !== d ||
      dt.getHours() !== hh ||
      dt.getMinutes() !== mm
    ) {
      return NaN;
    }
  }
  return t;
}

const PK_ROUTE_MAP = makeNullProtoMap({
  subq: 'sc',
  sc: 'sc',
  sq: 'sc',
  subcutaneous: 'sc',
  im: 'im',
  intramuscular: 'im',
  oral: 'oral',
  po: 'oral',
  tablet: 'oral',
  capsule: 'oral',
  sl: 'sl',
  sublingual: 'sl',
  nasal: 'nasal',
  intranasal: 'nasal',
  spray: 'nasal',
  iv: 'iv',
  intravenous: 'iv',
  topical: 'topical',
  device: 'device',
  microneedling: 'device',
  led: 'device',
  inj: 'inj',
  pen: 'inj',
});

function normalizePkRoute(route) {
  if (!route || typeof route !== 'string') return null;
  const clean = route.trim().toLowerCase();
  if (!clean) return null;
  return hasOwn(PK_ROUTE_MAP, clean) ? PK_ROUTE_MAP[clean] : null;
}

function parseAllowedPkRoutes(routeText) {
  if (!routeText || typeof routeText !== 'string') return null;
  const tokens = routeText
    .split(/[/,|&]|\bor\b/i)
    .map((s) => normalizePkRoute(s))
    .filter(Boolean);
  return tokens.length > 0 ? new Set(tokens) : null;
}

function isRouteCompatible(hlRoute, queryRoute) {
  const allowed = parseAllowedPkRoutes(hlRoute);
  if (!allowed) return true;
  if (queryRoute == null || (typeof queryRoute === 'string' && !queryRoute.trim())) return true;
  const q = normalizePkRoute(queryRoute);
  if (!q) return false;
  if (q === 'inj') return allowed.has('sc') || allowed.has('im');
  return allowed.has(q);
}

/**
 * Extract modelable elimination/depot/biological half-life in hours.
 * Strict refusal invariants:
 * - Refuses blends (`isBlendCompound` or `options.isBlend`)
 * - Refuses `kind === 'unmodeled'` even if `valueHours` is accidentally set
 * - Refuses null/missing/non-positive/non-finite `valueHours`
 * - Refuses explicit route mismatch (e.g. Oral half-life queried with SL or IV)
 */
export function extractHalfLifeHours(halfLifeOrCompound, options = {}) {
  if (options?.isBlend === true) return null;
  if (typeof halfLifeOrCompound === 'number') {
    return Number.isFinite(halfLifeOrCompound) && halfLifeOrCompound > 0 ? halfLifeOrCompound : null;
  }
  if (!halfLifeOrCompound || typeof halfLifeOrCompound !== 'object') return null;

  if (isBlendCompound(halfLifeOrCompound)) return null;

  const hl =
    halfLifeOrCompound.halfLife && typeof halfLifeOrCompound.halfLife === 'object'
      ? halfLifeOrCompound.halfLife
      : halfLifeOrCompound;

  if (!hl || typeof hl !== 'object') return null;
  if (hl.kind === 'unmodeled') return null;
  if (hl.valueHours === null || hl.valueHours === undefined) return null;

  const hours = parseFiniteNumber(hl.valueHours);
  if (!(hours > 0)) return null;

  const hlRoute = hl.route || halfLifeOrCompound.dosages?.route || null;
  if (options?.route && hlRoute && !isRouteCompatible(hlRoute, options.route)) {
    return null;
  }

  return hours;
}

function normalizePkEntries(entries, options = {}) {
  if (!Array.isArray(entries)) return { ok: false, entries: [], dimension: null };

  const filterDim = options?.dimension
    ? options.dimension
    : options?.unit
      ? unitDimension(options.unit)
      : null;

  if (filterDim && filterDim !== 'mass' && filterDim !== 'IU') {
    return { ok: false, entries: [], dimension: 'unsupported' };
  }

  const seenDimensions = new Set();
  const normalized = [];

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.skipped === true) continue;

    const at = typeof e.at === 'number' ? e.at : parseDoseTime(e.datetime);
    if (!Number.isFinite(at)) continue;

    const rawUnit = e.unit ?? e.doseUnit ?? null;
    const hasRawUnit = hasNonEmptyRawUnit(rawUnit);
    const normU = hasRawUnit ? normalizeUnit(rawUnit) : null;
    const dim = normU ? unitDimension(normU) : null;

    if (hasRawUnit && (!normU || (dim !== 'mass' && dim !== 'IU'))) {
      if (filterDim) continue;
      return { ok: false, entries: [], dimension: 'unsupported' };
    }

    // Untagged entries (no unit/doseUnit, including `{ at, doseMcg }` or `{ at, amount }`)
    // are ALWAYS `'mass'` and are NEVER coerced into `'IU'` via `filterDim`.
    const entryDim = dim || 'mass';

    if (filterDim && entryDim !== filterDim) {
      continue;
    }

    let amt = NaN;
    if (normU === 'IU') {
      amt = parseFiniteNumber(e.amount ?? e.doseAmount ?? e.doseValue ?? e.doseMcg);
    } else if (normU && dim === 'mass') {
      if (e.amount != null) {
        amt = toMassMcg(e.amount, normU);
      } else if (e.doseAmount != null) {
        amt = toMassMcg(e.doseAmount, normU);
      } else if (e.doseValue != null) {
        amt = toMassMcg(e.doseValue, normU);
      } else if (e.doseMcg != null) {
        amt = parseFiniteNumber(e.doseMcg);
      }
    } else if (e.amount != null) {
      amt = parseFiniteNumber(e.amount);
    } else if (e.doseAmount != null) {
      amt = parseFiniteNumber(e.doseAmount);
    } else if (e.doseMcg != null) {
      amt = parseFiniteNumber(e.doseMcg);
    }

    if (!(amt > 0)) continue;

    seenDimensions.add(entryDim);
    normalized.push({ at, amount: amt, dimension: entryDim });
  }

  // Strict IU independence guard: never sum IU and mass together
  if (!filterDim && seenDimensions.size > 1) {
    return { ok: false, entries: [], dimension: 'mixed' };
  }

  return {
    ok: true,
    entries: normalized,
    dimension: filterDim || (seenDimensions.has('IU') ? 'IU' : 'mass'),
  };
}

/**
 * Exponential dose-equivalent remaining at timestamp `time`.
 * Returns `null` if unmodelable, blend, invalid time/half-life, or mixed IU+mass entries.
 */
export function remainingAt(entries, time, halfLifeOrHours, options = {}) {
  const t = typeof time === 'number' ? time : parseDoseTime(time);
  if (!Number.isFinite(t)) return null;
  const hours = extractHalfLifeHours(halfLifeOrHours, options);
  if (hours == null) return null;

  const norm = normalizePkEntries(entries, options);
  if (!norm.ok) return null;

  let sum = 0;
  for (const e of norm.entries) {
    if (e.at <= t) {
      sum += e.amount * 2 ** (-(t - e.at) / HOUR_MS / hours);
    }
  }
  return sum;
}

/**
 * O(logs + samples) single forward-sweep PK curve with exact vertical dose steps.
 */
export function levelSeries(entries, now, halfLifeOrHours, options = {}) {
  const opts = typeof options === 'number' ? { days: options } : options || {};
  const days = opts.days === undefined ? 7 : parseFiniteNumber(opts.days);
  const samples = opts.samples === undefined ? 120 : Math.floor(parseFiniteNumber(opts.samples));

  const nowMs = typeof now === 'number' ? now : parseDoseTime(now);
  const hours = extractHalfLifeHours(halfLifeOrHours, opts);
  if (!Number.isFinite(nowMs) || hours == null || !(days > 0) || !(samples >= 1)) {
    return null;
  }

  const norm = normalizePkEntries(entries, opts);
  if (!norm.ok) return null;

  const start = nowMs - days * 24 * HOUR_MS;
  if (!Number.isFinite(start) || !(nowMs > start)) return null;
  const sorted = norm.entries.filter((e) => e.at <= nowMs).sort((a, b) => a.at - b.at);

  const timesSet = new Set();
  for (let i = 0; i <= samples; i++) {
    timesSet.add(start + ((nowMs - start) * i) / samples);
  }
  for (const e of sorted) {
    if (e.at >= start) timesSet.add(e.at);
  }

  let amount = 0;
  let cursor = 0;
  while (cursor < sorted.length && sorted[cursor].at < start) {
    const e = sorted[cursor++];
    amount += e.amount * 2 ** (-(start - e.at) / HOUR_MS / hours);
  }

  const sortedTimes = [...timesSet].sort((a, b) => a - b);
  const points = [];
  let lastTime = start;

  for (const time of sortedTimes) {
    amount *= 2 ** (-(time - lastTime) / HOUR_MS / hours);
    if (cursor < sorted.length && sorted[cursor].at === time) {
      points.push({ time, amount });
    }
    while (cursor < sorted.length && sorted[cursor].at <= time) {
      amount += sorted[cursor++].amount;
    }
    points.push({ time, amount });
    lastTime = time;
  }

  return points;
}

/**
 * Compute PK curve along with optional `[minHours, maxHours]` uncertainty band.
 */
export function levelSeriesWithBand(entries, now, halfLifeOrCompound, options = {}) {
  const hours = extractHalfLifeHours(halfLifeOrCompound, options);
  if (hours == null) return null;

  const hl =
    halfLifeOrCompound && typeof halfLifeOrCompound === 'object'
      ? halfLifeOrCompound.halfLife && typeof halfLifeOrCompound.halfLife === 'object'
        ? halfLifeOrCompound.halfLife
        : halfLifeOrCompound
      : null;

  const points = levelSeries(entries, now, hours, options);
  if (!points) return null;

  const minH = hl ? parseFiniteNumber(hl.minHours) : NaN;
  const maxH = hl ? parseFiniteNumber(hl.maxHours) : NaN;
  const hasRange =
    Number.isFinite(minH) &&
    Number.isFinite(maxH) &&
    minH > 0 &&
    maxH > 0 &&
    minH <= hours &&
    hours <= maxH &&
    minH < maxH;

  return {
    hours,
    range: hasRange ? [minH, maxH] : null,
    kind: hl?.kind || 'elimination',
    points,
    low: hasRange ? levelSeries(entries, now, minH, options) : null,
    high: hasRange ? levelSeries(entries, now, maxH, options) : null,
    disclaimer: PK_DISCLAIMER,
  };
}

export function formatLevel(amount, unit) {
  if (amount == null || !Number.isFinite(amount) || amount < 0 || unit === 'unknown') return '—';
  if (amount === 0) return unit === 'IU' ? '0 IU' : '0 mcg';

  if (unit === 'IU') {
    if (amount < 0.01) return '<0.01 IU';
    return `${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(amount)} IU`;
  }

  if (amount < 0.01) return '<0.01 mcg';
  if (amount >= 1_000_000) {
    return `${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(amount / 1_000_000)} g`;
  }
  if (amount >= 1000) {
    return `${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(amount / 1000)} mg`;
  }
  return `${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(amount)} mcg`;
}

/**
 * High-level household-aware PK estimator with strict member isolation,
 * latest-edit deduplication, IU independence, and refusal invariants.
 */
export function buildCompoundLevels({
  logs = [],
  compound,
  memberId = null,
  now = Date.now(),
  days = 7,
  includeSeries = false,
} = {}) {
  const nowMs = typeof now === 'number' ? now : parseDoseTime(now);
  const hl = compound?.halfLife || null;
  const ignored = { skipped: 0, future: 0, invalid: 0, duplicate: 0, unassigned: 0 };
  const flags = { localTimes: 0, backfilled: 0, needsReview: 0 };

  const unique = new Map();
  const targetIds = new Set(
    [compound?.id, compound?.slug, compound?.canonicalMolecule]
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.toLowerCase()),
  );

  for (const l of logs || []) {
    if (!l || typeof l !== 'object') continue;
    if (memberId != null) {
      const owner = l.memberId ?? l.profile ?? null;
      if (!owner) {
        ignored.unassigned++;
        continue;
      }
      if (owner !== memberId) continue;
    }

    // Match compound when compound.id is present and log specifies a compound/peptide ID
    if (targetIds.size > 0) {
      const logCid = l.compoundId ?? l.peptideId ?? null;
      if (logCid != null && !targetIds.has(String(logCid).toLowerCase())) {
        continue;
      }
    }

    const key = l.id == null ? Symbol('log') : String(l.id);
    const prior = unique.get(key);
    if (prior) {
      ignored.duplicate++;
      const prevTs = Date.parse(prior.updatedAt) || 0;
      const curTs = Date.parse(l.updatedAt) || 0;
      if (curTs <= prevTs) continue;
    }
    unique.set(key, l);
  }

  const isHcg =
    normName(compound?.canonicalMolecule || compound?.slug || compound?.id || compound?.name || '') === 'hcg';

  const entries = [];
  const seenDims = new Set();
  const seenRoutes = new Set();

  for (const l of unique.values()) {
    if (l.skipped === true) {
      ignored.skipped++;
      continue;
    }
    const at = parseDoseTime(l.datetime);
    if (!Number.isFinite(at)) {
      ignored.invalid++;
      continue;
    }
    if (Number.isFinite(nowMs) && at > nowMs) {
      ignored.future++;
      continue;
    }

    const rawUnit = l.doseUnit ?? l.unit ?? null;
    const hasRawUnit = hasNonEmptyRawUnit(rawUnit);
    const normU = hasRawUnit ? normalizeUnit(rawUnit) : null;
    let dim;
    let amt = NaN;

    if (normU === 'IU') {
      dim = 'IU';
      amt = parseFiniteNumber(l.doseAmount ?? l.doseValue ?? l.amount ?? l.doseMcg);
    } else if (normU && unitDimension(normU) === 'mass') {
      dim = 'mass';
      if (l.doseAmount != null) amt = toMassMcg(l.doseAmount, normU);
      else if (l.amount != null) amt = toMassMcg(l.amount, normU);
      else if (l.doseValue != null) amt = toMassMcg(l.doseValue, normU);
      else if (l.doseMcg != null) amt = parseFiniteNumber(l.doseMcg);
    } else if (!hasRawUnit && isHcg) {
      // Untagged HCG log: cannot guess whether it is IU or mass -> unknown
      dim = 'unknown';
      amt = parseFiniteNumber(l.doseAmount ?? l.doseValue ?? l.amount ?? l.doseMcg);
    } else if (!hasRawUnit && l.doseMcg != null) {
      dim = 'mass';
      amt = parseFiniteNumber(l.doseMcg);
    } else {
      dim = 'unknown';
      amt = parseFiniteNumber(l.doseAmount ?? l.doseValue ?? l.amount ?? l.doseMcg);
    }

    if (!(amt > 0)) {
      ignored.invalid++;
      continue;
    }

    seenDims.add(dim);
    const hasRawRoute = l.route != null && (typeof l.route !== 'string' || l.route.trim() !== '');
    const rawLr = hasRawRoute ? (typeof l.route === 'string' ? l.route.trim() : formatRawUnitLabel(l.route)) : null;
    const lr = normalizePkRoute(l.route);
    if (rawLr) seenRoutes.add(lr || rawLr);

    if (typeof l.datetime === 'string' && !/(Z|[+-]\d{2}:\d{2})$/.test(l.datetime)) {
      flags.localTimes++;
    }
    if (l.backfilled) flags.backfilled++;
    if (l.needsReview) flags.needsReview++;

    entries.push({
      id: l.id ?? null,
      at,
      datetime: l.datetime,
      amount: amt,
      unit: dim === 'IU' ? 'IU' : dim === 'mass' ? 'mcg' : rawUnit || 'unknown',
      dimension: dim,
      route: lr,
    });
  }

  entries.sort((a, b) => b.at - a.at);

  const dimension =
    seenDims.size > 1
      ? 'mixed'
      : seenDims.size === 1
        ? [...seenDims][0]
        : normalizeUnit(compound?.dosages?.defaultUnit) === 'IU'
          ? 'IU'
          : unitDimension(compound?.dosages?.defaultUnit || 'mcg');

  const unit = dimension === 'IU' ? 'IU' : dimension === 'mass' ? 'mcg' : 'unknown';

  const unmodelable = (reason) => ({
    modelable: false,
    reason,
    kind: hl?.kind || 'unmodeled',
    remaining: null,
    remainingLow: null,
    remainingHigh: null,
    formattedRemaining: '—',
    series: null,
    unit,
    dimension,
    entries,
    ignored,
    flags,
    disclaimer: PK_DISCLAIMER,
  });

  if (!Number.isFinite(nowMs)) {
    return unmodelable('invalid_timestamp');
  }
  if (!compound || typeof compound !== 'object') {
    return unmodelable('No compound profile supplied.');
  }
  if (isBlendCompound(compound)) {
    return unmodelable('Multi-component blends cannot be modeled with a single half-life.');
  }
  if (!hl || hl.kind === 'unmodeled' || hl.valueHours == null) {
    return unmodelable('Compound half-life is unmodeled or unspecified.');
  }
  if (dimension === 'mixed') {
    return unmodelable('Logs contain mixed IU and mass units — refusing to combine independent dimensions.');
  }
  if (dimension !== 'mass' && dimension !== 'IU') {
    return unmodelable(`Unsupported or ambiguous unit dimension "${dimension}" for PK decay estimation.`);
  }

  // Verify route compatibility for any logged explicit routes
  const hlRoute = hl.route || compound.dosages?.route || null;
  for (const r of seenRoutes) {
    if (hlRoute && !isRouteCompatible(hlRoute, r)) {
      return unmodelable(`Logged route "${r}" is incompatible with reference half-life route "${hlRoute}".`);
    }
  }

  const hours = extractHalfLifeHours(compound);
  if (hours == null) {
    return unmodelable('Half-life value is invalid or non-positive.');
  }

  const rem = remainingAt(entries, nowMs, hours, { dimension });
  const minH = parseFiniteNumber(hl.minHours);
  const maxH = parseFiniteNumber(hl.maxHours);
  const hasRange = Number.isFinite(minH) && Number.isFinite(maxH) && minH > 0 && minH <= hours && hours <= maxH && minH < maxH;

  const remainingLow = hasRange ? remainingAt(entries, nowMs, minH, { dimension }) : null;
  const remainingHigh = hasRange ? remainingAt(entries, nowMs, maxH, { dimension }) : null;

  let series = null;
  if (includeSeries) {
    series = levelSeriesWithBand(entries, nowMs, compound, { days, dimension });
  }

  return {
    modelable: true,
    reason: null,
    hours,
    kind: hl.kind || 'elimination',
    remaining: rem,
    remainingLow,
    remainingHigh,
    formattedRemaining: formatLevel(rem, dimension === 'IU' ? 'IU' : 'mass'),
    series,
    unit,
    dimension,
    entries,
    ignored,
    flags,
    disclaimer: PK_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// 4. DST-Safe UTC-Noon Calendar, Schedule Primitives, Revisions & cycleStatus
// ---------------------------------------------------------------------------

/**
 * Parse a `YYYY-MM-DD` date key to UTC noon (`12:00:00Z`) epoch ms.
 * Strictly rejects impossible calendar dates (e.g. `2026-02-29`, `2026-02-30`, `2026-04-31`).
 */
export function dkParse(dk) {
  if (typeof dk !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(dk);
  if (!m) return NaN;
  if (dk.length > 10 && !Number.isFinite(parseDoseTime(dk))) {
    return NaN;
  }
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12) return NaN;
  const maxDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > maxDay) return NaN;
  return Date.UTC(y, mo - 1, d, 12, 0, 0, 0);
}

export function dkValid(dk) {
  return Number.isFinite(dkParse(dk));
}

export function dkFromUTC(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 0 || y > 9999) return null;
  const ys = String(y).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${ys}-${mo}-${day}`;
}

export function dkOf(value) {
  if (typeof value === 'string' && dkValid(value)) {
    return value.slice(0, 10);
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return dkFromUTC(value.getTime());
  }
  return null;
}

export function dkToday(timeZone) {
  const now = new Date();
  if (typeof timeZone === 'string' && timeZone.trim()) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone.trim(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
    } catch {
      // Fall back to local calendar date
    }
  }
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function dkAdd(dk, days) {
  const t = dkParse(dk);
  if (!Number.isFinite(t) || !Number.isFinite(days)) return null;
  return dkFromUTC(t + Math.trunc(days) * DAY_MS);
}

export function dkDiff(a, b) {
  const ta = dkParse(a);
  const tb = dkParse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return NaN;
  return Math.round((ta - tb) / DAY_MS);
}

export function dkDow(dk) {
  const t = dkParse(dk);
  return Number.isFinite(t) ? new Date(t).getUTCDay() : NaN;
}

const TIMELINE_FIELDS = ['schedule', 'doseAmount', 'doseUnit', 'doseMcg', 'doseValue', 'slot', 'pinnedSlot'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function normSchedule(schedule, fallbackAnchor = null) {
  const s = schedule && typeof schedule === 'object' ? schedule : {};
  const timeOfDay = typeof s.timeOfDay === 'string' ? s.timeOfDay : undefined;
  const rawEvery = s.every ?? s.everyNDays;
  const every = rawEvery != null ? Math.round(parseFiniteNumber(rawEvery)) : NaN;

  if (Number.isFinite(every) && every > 1) {
    const anchor = dkOf(s.anchor ?? s.anchorDate) || dkOf(fallbackAnchor) || null;
    const out = { days: [0, 1, 2, 3, 4, 5, 6], every, anchor };
    if (timeOfDay !== undefined) out.timeOfDay = timeOfDay;
    return out;
  }

  const rawDays = Array.isArray(s.days) ? s.days : Array.isArray(s.daysOfWeek) ? s.daysOfWeek : null;
  let days;
  if (rawDays !== null) {
    const set = new Set();
    for (const d of rawDays) {
      const n = Math.trunc(parseFiniteNumber(d));
      if (Number.isFinite(n) && n >= 0 && n <= 6) set.add(n);
    }
    days = [...set].sort((a, b) => a - b);
  } else if (s.prn === true) {
    days = [];
  } else {
    days = [0, 1, 2, 3, 4, 5, 6];
  }

  const out = { days };
  if (timeOfDay !== undefined) out.timeOfDay = timeOfDay;
  return out;
}

export function isPrnSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  if (schedule.prn === true) return true;
  const every = Math.round(parseFiniteNumber(schedule.every ?? schedule.everyNDays));
  if (Number.isFinite(every) && every > 1) return false;
  const days = Array.isArray(schedule.days)
    ? schedule.days
    : Array.isArray(schedule.daysOfWeek)
      ? schedule.daysOfWeek
      : null;
  return Array.isArray(days) && days.length === 0;
}

export function freqPerWeek(schedule) {
  if (!schedule || typeof schedule !== 'object') return 7;
  if (schedule.prn === true) return null;
  const every = Math.round(parseFiniteNumber(schedule.every ?? schedule.everyNDays));
  if (Number.isFinite(every) && every > 1) return 7 / every;
  const days = Array.isArray(schedule.days)
    ? schedule.days
    : Array.isArray(schedule.daysOfWeek)
      ? schedule.daysOfWeek
      : null;
  if (Array.isArray(days)) return days.length === 0 ? null : days.length;
  return 7;
}

export function scheduleLabel(schedule, short = false) {
  if (!schedule || typeof schedule !== 'object') return short ? 'Daily' : 'Daily';
  if (isPrnSchedule(schedule)) return 'PRN';
  const every = Math.round(parseFiniteNumber(schedule.every ?? schedule.everyNDays));
  if (Number.isFinite(every) && every > 1) {
    if (every === 2) return short ? 'EOD' : 'Every other day';
    return short ? `q${every}d` : `Every ${every} days`;
  }
  const days = normSchedule(schedule).days;
  if (days.length === 7) return 'Daily';
  if (days.length === 5 && days.join(',') === '1,2,3,4,5') return short ? 'M–F' : 'Mon–Fri (5 on / 2 off)';
  if (days.length === 3 && days.join(',') === '1,3,5') return 'MWF';
  return days.map((d) => DOW_SHORT[d]).join(short ? '/' : ', ');
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function cloneTimelineFieldValue(val) {
  return deepClone(val);
}

function makeBaselineSnapshot(plan, existingTimeline = []) {
  const usedIds = new Set(
    (Array.isArray(existingTimeline) ? existingTimeline : [])
      .map((e) => e?.id)
      .filter((id) => typeof id === 'string'),
  );
  let id = 'rev_base';
  let suffix = 1;
  while (usedIds.has(id)) {
    id = `rev_base_${suffix++}`;
  }
  const baseline = { id, from: null, _baseline: true };
  for (const f of TIMELINE_FIELDS) {
    if (hasOwn(plan, f) && plan[f] !== undefined) {
      baseline[f] = cloneTimelineFieldValue(plan[f]);
    }
  }
  return baseline;
}

export function timelineSorted(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];
  return timeline
    .filter((e) => e && typeof e === 'object')
    .sort((a, b) => {
      const af = a.from == null ? null : dkOf(a.from) || String(a.from);
      const bf = b.from == null ? null : dkOf(b.from) || String(b.from);
      if (af == null && bf == null) return 0;
      if (af == null) return -1;
      if (bf == null) return 1;
      return String(af).localeCompare(String(bf));
    });
}

export function planAt(plan, dk) {
  if (!plan || typeof plan !== 'object') return plan;
  const tl = timelineSorted(plan.timeline);
  const out = { ...plan, _effectiveFrom: null };
  for (const f of TIMELINE_FIELDS) {
    if (hasOwn(out, f) && out[f] !== undefined) {
      out[f] = cloneTimelineFieldValue(out[f]);
    }
  }
  if (tl.length === 0) {
    return out;
  }

  const dkNorm = dkOf(dk);

  const hasCompleteBaseline = tl.some((e) => e.from == null && e._baseline === true);
  const hasAnyBaseline = hasCompleteBaseline || tl.some((e) => e.from == null);

  if (hasCompleteBaseline) {
    // Complete snapshot baseline is the sole authority for all TIMELINE_FIELDS.
    for (const f of TIMELINE_FIELDS) {
      delete out[f];
    }
  } else if (hasAnyBaseline) {
    // Legacy/hand-crafted partial `from: null` baseline (e.g. protocol-os import):
    // Reset only fields managed by at least one valid timeline entry so untouched top-level
    // fields (like `schedule` or `doseUnit`) remain intact while revision-introduced
    // fields cannot leak backward into pre-revision queries.
    const managedFields = new Set();
    for (const entry of tl) {
      if (entry.from != null && dkOf(entry.from) == null) continue;
      for (const f of TIMELINE_FIELDS) {
        if (hasOwn(entry, f) && entry[f] !== undefined) managedFields.add(f);
      }
    }
    for (const f of managedFields) {
      delete out[f];
    }
  }
  // Future-only timeline (no `from == null` entry): top-level `plan` fields ARE the baseline.

  for (const entry of tl) {
    const entryFrom = entry.from == null ? null : dkOf(entry.from);
    const applies = entry.from == null || (dkNorm != null && entryFrom != null && entryFrom <= dkNorm);
    if (!applies) continue;

    for (const f of TIMELINE_FIELDS) {
      if (hasOwn(entry, f) && entry[f] !== undefined) {
        out[f] = cloneTimelineFieldValue(entry[f]);
      }
    }
    out._effectiveFrom = entryFrom;
  }
  return out;
}

export function nextPlanRevision(plan, dk) {
  const dkNorm = dkOf(dk);
  if (!plan || !dkNorm) return null;
  const tl = timelineSorted(plan.timeline);
  for (const entry of tl) {
    if (entry && entry.from != null) {
      const entryFrom = dkOf(entry.from);
      if (entryFrom && entryFrom > dkNorm) {
        return entry;
      }
    }
  }
  return null;
}

export function dueOn(plan, dk) {
  const dkNorm = dkOf(dk);
  if (!plan || !dkNorm) return false;
  const s = plan.schedule && typeof plan.schedule === 'object' ? plan.schedule : {};
  if (isPrnSchedule(s)) return false;
  const every = Math.round(parseFiniteNumber(s.every ?? s.everyNDays));
  if (Number.isFinite(every) && every > 1) {
    const anchor = dkOf(s.anchor ?? s.anchorDate) || dkOf(plan.startDate);
    if (!anchor) return true;
    const diff = dkDiff(dkNorm, anchor);
    return ((diff % every) + every) % every === 0;
  }
  const days = Array.isArray(s.days)
    ? s.days
    : Array.isArray(s.daysOfWeek)
      ? s.daysOfWeek
      : [0, 1, 2, 3, 4, 5, 6];
  if (days.length === 0) return false;
  return days.includes(dkDow(dkNorm));
}

export function inRange(plan, dk) {
  const dkNorm = dkOf(dk);
  if (!plan || !dkNorm) return false;
  const startDk = dkOf(plan.startDate);
  const endDk = dkOf(plan.endDate);
  if (startDk && dkNorm < startDk) return false;
  if (endDk && dkNorm > endDk) return false;
  return true;
}

export function activeOn(plan, dk) {
  const dkNorm = dkOf(dk);
  if (!plan || !dkNorm) return false;
  if (plan.active === false && !dkOf(plan.endDate)) return false;
  return inRange(plan, dkNorm);
}

export function materializePlan(plan, todayDk = dkToday()) {
  const todayNorm = dkOf(todayDk);
  if (!plan || typeof plan !== 'object' || !todayNorm) return plan;

  const tl = timelineSorted(plan.timeline);
  const hasTimeline = tl.length > 0;
  const hasAnyBaseline = hasTimeline && tl.some((e) => e.from == null);
  const eff = hasTimeline ? planAt(plan, todayNorm) : plan;

  // Compute FINAL desired schedule (including 7-day mirror for `every > 1`) BEFORE
  // diffing against `plan`, guaranteeing `materializePlan(m1, d) === m1` even on
  // `every > 1` plans with timelines.
  let desiredSchedule = eff.schedule;
  const every = Math.round(parseFiniteNumber(desiredSchedule?.every ?? desiredSchedule?.everyNDays));
  if (desiredSchedule && typeof desiredSchedule === 'object' && Number.isFinite(every) && every > 1) {
    const weekDays = [];
    const probePlan = { ...plan, schedule: desiredSchedule };
    for (let i = 0; i < 7; i++) {
      const dk = dkAdd(todayNorm, i);
      if (dueOn(probePlan, dk)) weekDays.push(dkDow(dk));
    }
    const sortedWeek = [...new Set(weekDays)].sort((a, b) => a - b);
    if (!deepEqual(desiredSchedule.days || [], sortedWeek)) {
      desiredSchedule = { ...desiredSchedule, days: sortedWeek };
    }
  }

  let changed = false;
  let timelineMutatedTopLevel = false;
  const next = { ...plan };

  if (hasTimeline) {
    for (const f of TIMELINE_FIELDS) {
      const targetVal = f === 'schedule' ? desiredSchedule : eff[f];
      const rawEffVal = eff[f];
      if (targetVal === undefined) {
        if (hasOwn(next, f)) {
          delete next[f];
          changed = true;
          timelineMutatedTopLevel = true;
        }
      } else if (!hasOwn(plan, f) || !deepEqual(plan[f], targetVal)) {
        next[f] = cloneTimelineFieldValue(targetVal);
        changed = true;
        if (eff._effectiveFrom !== null && (!hasOwn(plan, f) || !deepEqual(plan[f], rawEffVal))) {
          timelineMutatedTopLevel = true;
        }
      }
    }

    // Preserve pre-`from` baseline before mutating top-level fields on a future-only timeline.
    if (!hasAnyBaseline && timelineMutatedTopLevel) {
      const baseline = makeBaselineSnapshot(plan, tl);
      next.timeline = timelineSorted([baseline, ...tl.map((e) => deepClone(e))]);
      changed = true;
    }
  } else if (desiredSchedule !== plan.schedule && !deepEqual(plan.schedule, desiredSchedule)) {
    next.schedule = cloneTimelineFieldValue(desiredSchedule);
    changed = true;
  }

  const endDk = dkOf(next.endDate);
  if (endDk && endDk < todayNorm && next.active !== false) {
    next.active = false;
    changed = true;
  }

  return changed ? next : plan;
}

export function applyRevision(plan, fromDk, fields = {}, todayDk = dkToday()) {
  if (!plan || typeof plan !== 'object') return plan;
  if (fromDk !== null && fromDk !== undefined && dkOf(fromDk) === null) {
    return plan;
  }

  const safeFields = fields && typeof fields === 'object' ? fields : {};
  const existingTl = timelineSorted(plan.timeline);
  const tl = existingTl.map((e) => deepClone(e));

  // Capture complete baseline snapshot if no `from == null` baseline exists yet
  // (covers both fresh plans with no timeline AND future-only timelines).
  // If an existing `from == null` entry lacks `_baseline: true` (legacy partial
  // protocol-os or hand-crafted timeline), promote it to `_baseline: true` by
  // backfilling ONLY active top-level TIMELINE_FIELDS not previously managed by
  // ANY valid entry in `existingTl`.
  if (!tl.some((e) => e.from == null)) {
    tl.unshift(makeBaselineSnapshot(plan, tl));
  } else if (!tl.some((e) => e.from == null && e._baseline === true)) {
    const baseIdx = tl.findIndex((e) => e.from == null);
    const prevManaged = new Set();
    for (const e of existingTl) {
      if (e.from != null && dkOf(e.from) == null) continue;
      for (const f of TIMELINE_FIELDS) {
        if (hasOwn(e, f) && e[f] !== undefined) prevManaged.add(f);
      }
    }
    const promoted = { ...tl[baseIdx], _baseline: true };
    for (const f of TIMELINE_FIELDS) {
      if (!prevManaged.has(f) && hasOwn(plan, f) && plan[f] !== undefined) {
        promoted[f] = cloneTimelineFieldValue(plan[f]);
      }
    }
    tl[baseIdx] = promoted;
  }

  const normalizedFrom = fromDk == null ? null : dkOf(fromDk);
  const customId = typeof safeFields.id === 'string' && safeFields.id.trim() ? safeFields.id : null;
  let autoId = `rev_${normalizedFrom || 'base'}_${tl.length}`;
  if (!customId) {
    const usedIds = new Set(tl.map((e) => e?.id).filter((id) => typeof id === 'string'));
    let suffix = tl.length;
    while (usedIds.has(autoId)) {
      autoId = `rev_${normalizedFrom || 'base'}_${++suffix}`;
    }
  }
  const revId = customId || autoId;
  const entry = { id: revId, from: normalizedFrom };
  for (const f of TIMELINE_FIELDS) {
    if (hasOwn(safeFields, f) && safeFields[f] !== undefined) {
      entry[f] = cloneTimelineFieldValue(safeFields[f]);
    }
  }

  let sameIdx = -1;
  if (normalizedFrom === null) {
    for (let i = tl.length - 1; i >= 0; i--) {
      if (tl[i].from == null) {
        sameIdx = i;
        break;
      }
    }
  } else {
    sameIdx = tl.findIndex((e) => e.from != null && dkOf(e.from) === normalizedFrom);
  }

  if (sameIdx >= 0) {
    tl[sameIdx] = { ...tl[sameIdx], ...entry, id: customId || tl[sameIdx].id };
  } else {
    tl.push(entry);
  }

  const updated = { ...plan, timeline: timelineSorted(tl) };
  return materializePlan(updated, todayDk);
}

export function removeRevision(plan, entryId, todayDk = dkToday()) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.timeline)) return plan;
  const removed = plan.timeline.find((e) => e && e.id === entryId);
  if (!removed) return plan;

  const remaining = plan.timeline.filter((e) => !e || e.id !== entryId);
  const sortedRemaining = timelineSorted(remaining).map((e) => deepClone(e));
  const updated = { ...plan, timeline: sortedRemaining };

  // Fallback ghost cleanup for hand-crafted/legacy partial `from: null` timelines without `_baseline: true`:
  // If `removed` was the only timeline entry defining field `f`, clear materialized `updated[f]`.
  const hasCompleteBaseline = sortedRemaining.some((e) => e.from == null && e._baseline === true);
  const hasAnyBaseline = sortedRemaining.some((e) => e.from == null);
  if (!hasCompleteBaseline && hasAnyBaseline) {
    for (const f of TIMELINE_FIELDS) {
      if (!hasOwn(removed, f) || removed[f] === undefined) continue;
      const stillInTimeline = sortedRemaining.some((e) => hasOwn(e, f) && e[f] !== undefined);
      if (!stillInTimeline && hasOwn(updated, f) && deepEqual(updated[f], removed[f])) {
        delete updated[f];
      }
    }
  }

  return materializePlan(updated, todayDk);
}

/**
 * Deterministic cycle-phase & timeline-revision state machine (F35).
 */
export function cycleStatus(plan, dateKey, options = {}) {
  const { endingSoonDays = 7, revisionHorizonDays = 14 } = options || {};
  const dkNorm = dkOf(dateKey);

  const makeResult = (overrides) => ({
    phase: 'unknown',
    status: 'unknown',
    activeDayCode: null,
    isActive: false,
    isEndingSoon: false,
    day: null,
    totalDays: null,
    daysRemaining: null,
    daysUntilStart: null,
    daysPastEnd: null,
    cycleNumber: null,
    startDate: null,
    cycleEndDate: null,
    nextOnDate: null,
    effectiveFrom: null,
    nextRevision: null,
    dateKey: dkNorm || (typeof dateKey === 'string' ? dateKey : null),
    label: 'Unknown',
    ...overrides,
  });

  if (!plan || typeof plan !== 'object' || !dkNorm) {
    return makeResult({ error: 'INVALID_INPUT' });
  }

  const effective = planAt(plan, dkNorm);
  const upRev = nextPlanRevision(plan, dkNorm);
  const nextRevInfo = upRev
    ? {
        id: upRev.id ?? null,
        from: dkOf(upRev.from) || upRev.from,
        daysUntil: dkDiff(upRev.from, dkNorm),
        withinHorizon: dkDiff(upRev.from, dkNorm) <= revisionHorizonDays,
      }
    : null;

  const startDk = dkOf(plan.startDate);
  const endDk = dkOf(plan.endDate);
  const cycleDaysRaw = plan.cycleDays ?? plan.cycles?.cycleDays ?? null;
  const offDaysRaw = plan.offDays ?? plan.cycles?.offDays ?? null;
  const continuousFlag = plan.continuous ?? plan.cycles?.continuous ?? false;

  const cycleDays = cycleDaysRaw != null ? Math.trunc(parseFiniteNumber(cycleDaysRaw)) : null;
  const offDays = offDaysRaw != null ? Math.trunc(parseFiniteNumber(offDaysRaw)) : null;

  const common = {
    startDate: startDk,
    effectiveFrom: effective?._effectiveFrom ?? null,
    nextRevision: nextRevInfo,
  };

  if (plan.active === false && !endDk) {
    return makeResult({
      ...common,
      phase: 'inactive',
      status: 'inactive',
      isActive: false,
      label: 'Inactive',
    });
  }

  if (startDk && dkNorm < startDk) {
    const daysUntilStart = dkDiff(startDk, dkNorm);
    return makeResult({
      ...common,
      phase: 'upcoming',
      status: 'upcoming',
      isActive: false,
      daysUntilStart,
      label: `Starts in ${daysUntilStart}d (${startDk})`,
    });
  }

  if (endDk && dkNorm > endDk) {
    const daysPastEnd = dkDiff(dkNorm, endDk);
    return makeResult({
      ...common,
      phase: 'expired',
      status: 'expired',
      isActive: false,
      daysPastEnd,
      cycleEndDate: endDk,
      label: `Ended ${daysPastEnd}d ago (${endDk})`,
    });
  }

  // Repeating on/off cycle
  if (startDk && cycleDays > 0 && offDays > 0) {
    const elapsed = dkDiff(dkNorm, startDk);
    const period = cycleDays + offDays;
    const cycleNumber = Math.floor(elapsed / period) + 1;
    const pos = elapsed % period;

    if (pos >= cycleDays) {
      const offDay = pos - cycleDays + 1;
      const daysRemaining = offDays - offDay + 1;
      const nextOnDate = dkAdd(dkNorm, daysRemaining);
      return makeResult({
        ...common,
        phase: 'off_cycle',
        status: 'off_cycle',
        isActive: false,
        day: offDay,
        totalDays: offDays,
        daysRemaining,
        cycleNumber,
        nextOnDate,
        label: `Off-cycle day ${offDay} of ${offDays} (next on ${nextOnDate})`,
      });
    }

    const day = pos + 1;
    const daysRemaining = cycleDays - day + 1;
    const cycleEndDate = dkAdd(dkNorm, daysRemaining - 1);
    const activeDayCode = `active_day_${day}_of_${cycleDays}`;
    const isEndingSoon = daysRemaining <= endingSoonDays;
    return makeResult({
      ...common,
      phase: isEndingSoon ? 'ending_soon' : 'active',
      status: isEndingSoon ? 'ending_soon' : activeDayCode,
      activeDayCode,
      isActive: true,
      isEndingSoon,
      day,
      totalDays: cycleDays,
      daysRemaining,
      cycleNumber,
      cycleEndDate,
      label: isEndingSoon
        ? `Ending soon — Day ${day} of ${cycleDays} (${daysRemaining}d left)`
        : `Day ${day} of ${cycleDays}`,
    });
  }

  // Finite single cycle (`cycleDays > 0` without `offDays`)
  if (startDk && cycleDays > 0 && !(offDays > 0)) {
    const effectiveEnd = endDk || dkAdd(startDk, cycleDays - 1);
    const elapsed = dkDiff(dkNorm, startDk);
    if (effectiveEnd && dkNorm > effectiveEnd) {
      const daysPastEnd = dkDiff(dkNorm, effectiveEnd);
      return makeResult({
        ...common,
        phase: 'expired',
        status: 'expired',
        isActive: false,
        day: elapsed + 1,
        totalDays: cycleDays,
        daysPastEnd,
        cycleEndDate: effectiveEnd,
        label: `Cycle completed ${daysPastEnd}d ago (${effectiveEnd})`,
      });
    }
    const day = elapsed + 1;
    const daysRemaining = effectiveEnd ? dkDiff(effectiveEnd, dkNorm) + 1 : Math.max(1, cycleDays - day + 1);
    const activeDayCode = `active_day_${day}_of_${cycleDays}`;
    const isEndingSoon = daysRemaining <= endingSoonDays;
    return makeResult({
      ...common,
      phase: isEndingSoon ? 'ending_soon' : 'active',
      status: isEndingSoon ? 'ending_soon' : activeDayCode,
      activeDayCode,
      isActive: true,
      isEndingSoon,
      day,
      totalDays: cycleDays,
      daysRemaining,
      cycleNumber: 1,
      cycleEndDate: effectiveEnd,
      label: isEndingSoon
        ? `Ending soon — Day ${day} of ${cycleDays} (${daysRemaining}d left)`
        : `Day ${day} of ${cycleDays}`,
    });
  }

  // Explicit endDate without cycleDays
  if (endDk && dkNorm <= endDk) {
    const daysRemaining = dkDiff(endDk, dkNorm) + 1;
    const day = startDk ? dkDiff(dkNorm, startDk) + 1 : null;
    const totalDays = startDk ? dkDiff(endDk, startDk) + 1 : null;
    const activeDayCode = day && totalDays ? `active_day_${day}_of_${totalDays}` : null;
    const isEndingSoon = daysRemaining <= endingSoonDays;
    return makeResult({
      ...common,
      phase: isEndingSoon ? 'ending_soon' : 'active',
      status: isEndingSoon ? 'ending_soon' : activeDayCode || 'active',
      activeDayCode,
      isActive: true,
      isEndingSoon,
      day,
      totalDays,
      daysRemaining,
      cycleEndDate: endDk,
      label: isEndingSoon
        ? `Ending soon (${daysRemaining}d left until ${endDk})`
        : activeDayCode
          ? `Day ${day} of ${totalDays}`
          : `Active until ${endDk}`,
    });
  }

  // Continuous
  const day = startDk ? dkDiff(dkNorm, startDk) + 1 : null;
  return makeResult({
    ...common,
    phase: 'continuous',
    status: 'continuous',
    isActive: true,
    day,
    totalDays: null,
    label: continuousFlag ? 'Continuous' : day ? `Continuous (Day ${day})` : 'Continuous',
  });
}

// ---------------------------------------------------------------------------
// 5. Supply Run-Out Projection & Stock Deduction (F9)
// ---------------------------------------------------------------------------

export function deductSupply(remainingAmount, doseAmount) {
  const rem = parseFiniteNumber(remainingAmount);
  const dose = parseFiniteNumber(doseAmount);
  if (!Number.isFinite(rem) || !Number.isFinite(dose) || dose < 0) return null;
  return Math.max(0, rem - dose);
}

export function projectSupplyRunOut({
  remainingDoses = null,
  remainingAmount = null,
  totalAmount = null,
  doseAmount = null,
  plan = null,
  todayDk = dkToday(),
  loggedToday = false,
  maxHorizonDays = 400,
  lowStockThreshold = LOW_STOCK_DOSE_THRESHOLD,
} = {}) {
  const todayNorm = dkOf(todayDk);
  if (!todayNorm) {
    return { ok: false, code: 'INVALID_DATE', error: 'todayDk must be a valid YYYY-MM-DD date key.' };
  }

  let dosesLeft;
  const remDosesNum = remainingDoses != null ? parseFiniteNumber(remainingDoses) : NaN;
  const remAmtNum = remainingAmount != null ? parseFiniteNumber(remainingAmount) : NaN;
  const doseAmtNum = doseAmount != null ? parseFiniteNumber(doseAmount) : NaN;
  const totalAmtNum = totalAmount != null ? parseFiniteNumber(totalAmount) : NaN;

  if (remainingDoses != null) {
    if (!(remDosesNum >= 0)) {
      return { ok: false, code: 'INVALID_SUPPLY', error: 'remainingDoses must be finite >= 0.' };
    }
    dosesLeft = Math.max(0, Math.floor(remDosesNum + 1e-9));
  } else if (remainingAmount != null && doseAmount != null) {
    if (!(remAmtNum >= 0) || !(doseAmtNum > 0)) {
      return {
        ok: false,
        code: 'INVALID_SUPPLY',
        error: 'remainingAmount must be >= 0 and doseAmount must be > 0.',
      };
    }
    const ratio = remAmtNum / doseAmtNum;
    if (!Number.isFinite(ratio)) {
      return {
        ok: false,
        code: 'INVALID_SUPPLY',
        error: 'Supply ratio exceeded finite numeric range.',
      };
    }
    dosesLeft = Math.max(0, Math.floor(ratio + 1e-9));
  } else {
    return {
      ok: false,
      code: 'INVALID_SUPPLY',
      error: 'Provide remainingDoses or both remainingAmount and doseAmount.',
    };
  }

  const rawHorizon = parseFiniteNumber(maxHorizonDays);
  const horizon = Number.isFinite(rawHorizon) ? Math.max(0, Math.min(3650, Math.trunc(rawHorizon))) : 400;
  const rawThreshold = parseFiniteNumber(lowStockThreshold);
  const threshold = Number.isFinite(rawThreshold) ? Math.max(0, rawThreshold) : LOW_STOCK_DOSE_THRESHOLD;

  const pctRemaining =
    Number.isFinite(totalAmtNum) && totalAmtNum > 0 && Number.isFinite(remAmtNum)
      ? Math.max(0, Math.min(1, remAmtNum / totalAmtNum))
      : null;

  const depleted = dosesLeft === 0;
  const lowStock = dosesLeft <= threshold;
  const alertLevel = depleted ? 'out' : lowStock ? 'low' : 'ok';
  const suggestedOwnershipStatus = depleted ? 'dont_have' : lowStock ? 'low_stock' : 'have';

  let lastCoveredDateKey = null;
  let runOutDateKey = null;

  const hasTimeline = Boolean(plan && Array.isArray(plan.timeline) && plan.timeline.length > 0);
  const isPrn = Boolean(plan && !hasTimeline && isPrnSchedule(plan.schedule));

  if (plan && !isPrn) {
    let count = 0;
    const startOffset = loggedToday ? 1 : 0;
    for (let i = startOffset; i <= horizon; i++) {
      const dk = dkAdd(todayNorm, i);
      if (!dk) break;
      if (!activeOn(plan, dk)) continue;
      const cs = cycleStatus(plan, dk);
      if (!cs.isActive) continue;
      const pr = planAt(plan, dk);
      if (isPrnSchedule(pr.schedule) || !dueOn(pr, dk)) continue;

      count++;
      if (count <= dosesLeft) {
        lastCoveredDateKey = dk;
      } else {
        runOutDateKey = dk;
        break;
      }
    }
  }

  const daysUntilRunOut = runOutDateKey ? dkDiff(runOutDateKey, todayNorm) : null;
  const coversHorizon = Boolean(plan && !isPrn && runOutDateKey === null);

  return {
    ok: true,
    dosesLeft,
    pctRemaining,
    depleted,
    lowStock,
    lowStockThreshold: threshold,
    alertLevel,
    suggestedOwnershipStatus,
    lastCoveredDateKey,
    runOutDateKey,
    daysUntilRunOut,
    coversHorizon,
  };
}

// ---------------------------------------------------------------------------
// 6. Advisory Dose-Sanity Gate & Adherence (F38)
// ---------------------------------------------------------------------------

function lookupCeiling(compoundId, compoundName, context = {}) {
  if (context.maxCeiling != null) {
    if (typeof context.maxCeiling === 'object') {
      const maxAmount = parseFiniteNumber(context.maxCeiling.maxAmount ?? context.maxCeiling.amount);
      const u = normalizeUnit(context.maxCeiling.unit || context.maxCeilingUnit || 'mcg');
      const per = context.maxCeiling.per || 'dose';
      if (maxAmount > 0 && u) {
        const isMass = unitDimension(u) === 'mass';
        const maxMcg = isMass ? toMassMcg(maxAmount, u) : null;
        if (isMass && maxMcg === null) return null;
        return {
          maxAmount,
          maxMcg,
          unit: u,
          per,
        };
      }
    } else {
      const maxAmount = parseFiniteNumber(context.maxCeiling);
      const u = normalizeUnit(context.maxCeilingUnit || context.defaultUnit || 'mcg');
      if (maxAmount > 0 && u) {
        const isMass = unitDimension(u) === 'mass';
        const maxMcg = isMass ? toMassMcg(maxAmount, u) : null;
        if (isMass && maxMcg === null) return null;
        return {
          maxAmount,
          maxMcg,
          unit: u,
          per: context.maxCeilingPer || 'dose',
        };
      }
    }
  }

  const keys = [
    compoundId,
    context.canonicalMolecule,
    compoundName,
  ]
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim().toLowerCase());

  for (const k of keys) {
    if (hasOwn(DEFAULT_DOSE_CEILINGS, k)) return DEFAULT_DOSE_CEILINGS[k];
    const nk = normName(k);
    if (nk) {
      for (const [ck, cv] of Object.entries(DEFAULT_DOSE_CEILINGS)) {
        if (normName(ck) === nk) return cv;
      }
    }
  }
  return null;
}

/**
 * Evaluate a logged/proposed dose against 7 sanity checks.
 * Call `softenVerdict(verdict)` (or `evaluateAdvisoryDose`) to apply the
 * Home Pharmacy advisory policy: hard-block ONLY missing/<=0/non-finite doses;
 * flag all other warnings as CONFIRM + needsReview.
 */
export function evaluateDose(input = {}, context = {}) {
  const compoundId = input.compoundId ?? input.peptideId ?? context.compoundId ?? null;
  const compoundName = input.compoundName ?? input.peptideName ?? context.compoundName ?? compoundId ?? 'compound';

  const rawInputUnit = input.doseUnit ?? input.unit ?? null;
  const hasExplicitInputUnit = hasNonEmptyRawUnit(rawInputUnit);
  const rawUnit = hasExplicitInputUnit ? rawInputUnit : (context.defaultUnit ?? null);
  const hasRawUnit = hasNonEmptyRawUnit(rawUnit);
  const inputUnit = hasRawUnit ? normalizeUnit(rawUnit) : null;
  const invalidUnit = hasRawUnit && !inputUnit;

  let canonicalVal = NaN;
  let dimension = 'unknown';
  let displayUnit = invalidUnit ? formatRawUnitLabel(rawUnit) : inputUnit || 'mcg';

  if (invalidUnit) {
    canonicalVal = parseFiniteNumber(input.doseAmount ?? input.doseMcg);
    dimension = 'unknown';
    displayUnit = formatRawUnitLabel(rawUnit);
  } else if (input.doseAmount !== undefined && input.doseAmount !== null) {
    const n = parseFiniteNumber(input.doseAmount);
    if (inputUnit && unitDimension(inputUnit) === 'mass') {
      canonicalVal = Number.isFinite(n) ? (toMassMcg(n, inputUnit) ?? NaN) : NaN;
      dimension = 'mass';
      displayUnit = inputUnit;
    } else if (inputUnit === 'IU') {
      canonicalVal = n;
      dimension = 'IU';
      displayUnit = 'IU';
    } else if (inputUnit) {
      canonicalVal = n;
      dimension = unitDimension(inputUnit);
      displayUnit = inputUnit;
    } else {
      canonicalVal = n;
      dimension = 'mass';
      displayUnit = 'mcg';
    }
  } else if (input.doseMcg !== undefined && input.doseMcg !== null) {
    const n = parseFiniteNumber(input.doseMcg);
    if (inputUnit && unitDimension(inputUnit) !== 'mass') {
      canonicalVal = n;
      dimension = unitDimension(inputUnit);
      displayUnit = inputUnit;
    } else {
      canonicalVal = n;
      dimension = 'mass';
      displayUnit = inputUnit || 'mcg';
    }
  }

  const validNum = Number.isFinite(canonicalVal) && canonicalVal > 0;
  const freq =
    context.freqPerWeek != null
      ? parseFiniteNumber(context.freqPerWeek)
      : context.schedule
        ? freqPerWeek(context.schedule)
        : null;

  const impliedPerDose = validNum ? canonicalVal : null;
  const impliedDaily = validNum && Number.isFinite(freq) && freq > 0 ? canonicalVal * (freq / 7) : null;
  const impliedWeekly = validNum && Number.isFinite(freq) && freq > 0 ? canonicalVal * freq : null;

  const isMass = dimension === 'mass';
  const impliedPerDoseMcg = isMass ? impliedPerDose : null;
  const impliedDailyMcg = isMass ? impliedDaily : null;
  const impliedWeeklyMcg = isMass ? impliedWeekly : null;

  const flags = [];
  const reasons = [];
  let unwritable = false;

  // 1. INVALID_DOSE (ONLY unwritable hard-block!)
  if (!validNum) {
    unwritable = true;
    flags.push('INVALID_DOSE');
    reasons.push('missing/invalid dose (must be a finite number greater than 0)');
  }

  // 1b. INVALID_UNIT (unrecognized non-empty unit — softened by softenVerdict to CONFIRM + needsReview, never PASS)
  if (invalidUnit) {
    flags.push('INVALID_UNIT');
    reasons.push(`unrecognized dose unit "${formatRawUnitLabel(rawUnit)}"`);
  }

  // 2. VOLUME_AS_MASS
  if (input.enteredAsVolume === true) {
    flags.push('VOLUME_AS_MASS');
    reasons.push('dose appears to have been entered as syringe volume (mL/units) instead of mass/IU');
  }

  // 3. UNKNOWN_COMPOUND
  if (context.knownCompound === false) {
    flags.push('UNKNOWN_COMPOUND');
    reasons.push(`compound "${compoundName}" is not recognized in catalog`);
  }

  const effectiveInputUnit = inputUnit || (!invalidUnit ? displayUnit : null);

  // Resolve prior dose & unit
  const priorUnitRaw = context.priorUnit ?? context.priorDoseUnit ?? null;
  const hasRawPriorUnit = hasNonEmptyRawUnit(priorUnitRaw);
  const priorUnit = hasRawPriorUnit ? normalizeUnit(priorUnitRaw) : null;
  const invalidPriorUnit = hasRawPriorUnit && !priorUnit;
  let priorCanonical = NaN;
  let priorDim = priorUnit ? unitDimension(priorUnit) : null;

  if (invalidPriorUnit) {
    priorCanonical = NaN;
    priorDim = 'unknown';
  } else if (context.priorDoseAmount != null) {
    const pn = parseFiniteNumber(context.priorDoseAmount);
    if (priorUnit && unitDimension(priorUnit) === 'mass') {
      priorCanonical = toMassMcg(pn, priorUnit) ?? NaN;
      priorDim = 'mass';
    } else {
      priorCanonical = pn;
      priorDim = priorDim || 'mass';
    }
  } else if (context.priorDoseMcg != null) {
    priorCanonical = parseFiniteNumber(context.priorDoseMcg);
    priorDim = priorUnit && unitDimension(priorUnit) !== 'mass' ? unitDimension(priorUnit) : 'mass';
  }

  // 4. UNIT_SWITCH
  if (priorUnit && inputUnit && priorUnit !== inputUnit) {
    flags.push('UNIT_SWITCH');
    reasons.push(`unit switched from ${priorUnit} to ${inputUnit}`);
  } else if (priorUnit && !inputUnit && !invalidUnit && priorDim && priorDim !== dimension) {
    flags.push('UNIT_SWITCH');
    reasons.push(`unit switched from ${priorUnit} to ${effectiveInputUnit}`);
  }

  // Mass units (mcg/mg/g) are commensurable via mcg conversion; all non-mass dimensions
  // (IU, volume, count_or_topical) require exact unit equality (`drops !== pumps`).
  const sameDimAsPrior =
    !invalidPriorUnit &&
    (!priorDim ||
      (priorDim === dimension &&
        (dimension === 'mass' || (priorUnit != null && priorUnit === effectiveInputUnit))));

  // 5. DOSE_JUMP_5X
  if (validNum && !invalidUnit && Number.isFinite(priorCanonical) && priorCanonical > 0 && sameDimAsPrior && canonicalVal >= 5 * priorCanonical) {
    const ratio = Math.round((canonicalVal / priorCanonical) * 10) / 10;
    flags.push('DOSE_JUMP_5X');
    reasons.push(`dose jump is ${ratio}x prior dose (>= 5x threshold)`);
  }

  // 6. CEILING_BREACH / UNIT_DIMENSION_MISMATCH
  const ceiling = lookupCeiling(compoundId, compoundName, context);
  if (ceiling && validNum && !invalidUnit) {
    const ceilDim = unitDimension(ceiling.unit);
    const nonMassCeilingUnitMismatch = ceilDim !== 'mass' && ceiling.unit !== effectiveInputUnit;
    if (ceilDim !== dimension || nonMassCeilingUnitMismatch) {
      flags.push('UNIT_DIMENSION_MISMATCH');
      reasons.push(
        `entered unit "${effectiveInputUnit}" (${dimension}) does not match reference ceiling unit "${ceiling.unit}" (${ceilDim})`,
      );
    } else {
      const limitVal = ceilDim === 'mass' ? ceiling.maxMcg : ceiling.maxAmount;
      let compareVal = impliedPerDose;
      if (ceiling.per === 'week' && impliedWeekly != null) compareVal = impliedWeekly;
      else if (ceiling.per === 'day' && impliedDaily != null) compareVal = impliedDaily;

      if (limitVal != null && compareVal != null && compareVal > limitVal + 1e-9) {
        flags.push('CEILING_BREACH');
        reasons.push(
          `exceeds advisory ceiling of ${ceiling.maxAmount} ${ceiling.unit} per ${ceiling.per}`,
        );
      }
    }
  }

  // 7. WEEKLY_JUMP_5X
  const priorFreq = context.priorFreqPerWeek != null ? parseFiniteNumber(context.priorFreqPerWeek) : freq;
  if (
    validNum &&
    !invalidUnit &&
    Number.isFinite(priorCanonical) &&
    priorCanonical > 0 &&
    Number.isFinite(priorFreq) &&
    priorFreq > 0 &&
    impliedWeekly != null &&
    sameDimAsPrior &&
    impliedWeekly >= 5 * (priorCanonical * priorFreq)
  ) {
    const ratio = Math.round((impliedWeekly / (priorCanonical * priorFreq)) * 10) / 10;
    flags.push('WEEKLY_JUMP_5X');
    reasons.push(`implied weekly total jumped ${ratio}x prior weekly total (>= 5x threshold)`);
  }

  // 8. Scheduled unit / dimension compatibility guard (never PASS on IU vs mass or non-mass mismatch)
  const rawScheduledUnit = context.scheduledDoseUnit ?? null;
  const hasScheduledUnit = hasNonEmptyRawUnit(rawScheduledUnit);
  const scheduledUnit = hasScheduledUnit ? normalizeUnit(rawScheduledUnit) : null;
  const scheduledDim = scheduledUnit ? unitDimension(scheduledUnit) : null;

  if (validNum && !invalidUnit) {
    if (hasScheduledUnit && !scheduledUnit) {
      flags.push('INVALID_UNIT');
      reasons.push(`unrecognized scheduled dose unit "${formatRawUnitLabel(rawScheduledUnit)}"`);
    } else if (scheduledUnit && effectiveInputUnit) {
      const dimMismatch = scheduledDim !== dimension;
      const nonMassUnitMismatch = scheduledDim !== 'mass' && scheduledUnit !== effectiveInputUnit;
      if (dimMismatch || nonMassUnitMismatch) {
        if (!flags.includes('UNIT_DIMENSION_MISMATCH')) flags.push('UNIT_DIMENSION_MISMATCH');
        if (!flags.includes('UNIT_SWITCH')) flags.push('UNIT_SWITCH');
        reasons.push(
          `logged unit "${effectiveInputUnit}" (${dimension}) does not match scheduled unit "${scheduledUnit}" (${scheduledDim})`,
        );
      }
    } else if (!hasScheduledUnit && context.scheduledDoseMcg != null && dimension !== 'mass') {
      if (!flags.includes('UNIT_DIMENSION_MISMATCH')) flags.push('UNIT_DIMENSION_MISMATCH');
      if (!flags.includes('UNIT_SWITCH')) flags.push('UNIT_SWITCH');
      reasons.push(`logged unit "${effectiveInputUnit}" (${dimension}) does not match scheduled mass dose (mcg)`);
    }
  }

  const base = {
    flags,
    reasons,
    dimension,
    displayUnit,
    impliedPerDose,
    impliedDaily,
    impliedWeekly,
    impliedPerDoseMcg,
    impliedDailyMcg,
    impliedWeeklyMcg,
  };

  if (flags.length > 0) {
    return {
      ...base,
      decision: 'BLOCK',
      unwritable,
      hardBlocked: unwritable,
      severity: unwritable ? 'error' : 'block',
      needsReview: !unwritable,
      message: `BLOCKED — ${reasons.join('; ')}. Re-enter the intended dose before logging.`,
    };
  }

  // Resolve scheduled dose comparison for PASS vs CONFIRM
  let scheduledCanonical = NaN;
  if (context.scheduledDoseAmount != null) {
    const su = scheduledUnit || normalizeUnit(displayUnit);
    scheduledCanonical =
      su && unitDimension(su) === 'mass'
        ? toMassMcg(context.scheduledDoseAmount, su)
        : parseFiniteNumber(context.scheduledDoseAmount);
  } else if (context.scheduledDoseMcg != null) {
    scheduledCanonical = parseFiniteNumber(context.scheduledDoseMcg);
  }

  const routeChanged = Boolean(context.scheduledRoute && input.route && String(context.scheduledRoute).toLowerCase() !== String(input.route).toLowerCase());
  const freqChanged = Boolean(
    context.scheduledFreqPerWeek != null &&
      freq != null &&
      Math.abs(parseFiniteNumber(context.scheduledFreqPerWeek) - freq) > 1e-9,
  );

  const scheduledUnitCompatible =
    !scheduledUnit ||
    (scheduledDim === dimension && (scheduledDim === 'mass' || scheduledUnit === effectiveInputUnit));

  if (
    scheduledUnitCompatible &&
    Number.isFinite(scheduledCanonical) &&
    scheduledCanonical > 0 &&
    Math.abs(canonicalVal - scheduledCanonical) <= 1e-9 &&
    !routeChanged &&
    !freqChanged
  ) {
    return {
      ...base,
      decision: 'PASS',
      unwritable: false,
      hardBlocked: false,
      severity: 'ok',
      needsReview: false,
      reasons: ['scheduled check-off matches protocol'],
      message: 'Matches scheduled protocol dose.',
    };
  }

  const changeReasons = [];
  if (Number.isFinite(scheduledCanonical) && Math.abs(canonicalVal - scheduledCanonical) > 1e-9) {
    changeReasons.push('differs from scheduled dose');
  } else if (!Number.isFinite(scheduledCanonical)) {
    changeReasons.push('ad-hoc or off-schedule dose');
  }
  if (routeChanged) changeReasons.push('route changed from schedule');
  if (freqChanged) changeReasons.push('frequency changed from schedule');

  return {
    ...base,
    decision: 'CONFIRM',
    unwritable: false,
    hardBlocked: false,
    severity: 'info',
    needsReview: true,
    reasons: changeReasons,
    message: `Please confirm: ${changeReasons.join('; ')}.`,
  };
}

/**
 * Advisory policy softener (F38):
 * Hard-blocks ONLY missing / <= 0 / NaN / non-finite doses (`INVALID_DOSE`).
 * All other sanity-gate alerts downgrade to CONFIRM + `needsReview: true`.
 */
export function softenVerdict(verdict) {
  if (!verdict || verdict.decision !== 'BLOCK') return verdict;
  const isUnwritable =
    verdict.unwritable === true ||
    (Array.isArray(verdict.flags) && verdict.flags.includes('INVALID_DOSE')) ||
    (Array.isArray(verdict.reasons) && verdict.reasons.some((r) => /missing\/invalid dose/i.test(r)));

  if (isUnwritable) {
    return {
      ...verdict,
      decision: 'BLOCK',
      unwritable: true,
      hardBlocked: true,
      severity: 'error',
    };
  }

  return {
    ...verdict,
    decision: 'CONFIRM',
    severity: 'warn',
    wasBlocked: true,
    hardBlocked: false,
    unwritable: false,
    needsReview: true,
    message: String(verdict.message || '')
      .replace(/^BLOCKED — /, 'WARNING — ')
      .replace(
        / Re-enter the intended dose before logging\.$/,
        ' Log it anyway if this is what you intended — it will be flagged for review.',
      ),
  };
}

export function evaluateAdvisoryDose(input, context = {}) {
  return softenVerdict(evaluateDose(input, context));
}

/**
 * Compute DST-safe adherence statistics over a trailing N-day window (F38).
 * Strict member isolation: unassigned logs never count toward a member.
 */
export function computeAdherence({
  plan,
  logs = [],
  memberId = null,
  compoundId = null,
  todayDk = dkToday(),
  days = 30,
} = {}) {
  const parsedDays = parseFiniteNumber(days);
  const windowDays = Math.min(3650, Math.max(1, Math.trunc(Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 30)));
  const todayNorm = dkOf(todayDk);
  if (!plan || !todayNorm) {
    return { days: windowDays, expected: 0, taken: 0, skipped: 0, missed: 0, pct: null, isPrn: false };
  }

  const hasTimeline = Array.isArray(plan.timeline) && plan.timeline.length > 0;
  const isPrn = !hasTimeline && isPrnSchedule(plan.schedule);
  const startDk = dkAdd(todayNorm, -(windowDays - 1));
  if (!startDk) {
    return { days: windowDays, expected: 0, taken: 0, skipped: 0, missed: 0, pct: null, isPrn };
  }

  // Index logs by date key with strict member & compound scoping
  const statusByDk = new Map(); // dk -> 'taken' | 'skipped'
  for (const l of logs || []) {
    if (!l || typeof l !== 'object') continue;
    if (memberId != null) {
      const owner = l.memberId ?? l.profile ?? null;
      if (!owner || owner !== memberId) continue;
    }
    const cid = compoundId ?? plan.compoundId ?? plan.peptideId ?? null;
    if (cid != null) {
      const logCid = l.compoundId ?? l.peptideId ?? null;
      if (logCid != null && String(logCid) !== String(cid)) continue;
    }
    if (typeof l.datetime === 'string' && l.datetime.length > 10 && !Number.isFinite(parseDoseTime(l.datetime))) {
      continue;
    }
    const dk = dkOf(l.datetime);
    if (!dk || dk < startDk || dk > todayNorm) continue;

    if (l.skipped === true) {
      if (!statusByDk.has(dk)) statusByDk.set(dk, 'skipped');
    } else {
      // A non-skipped dose takes precedence over a skipped entry on the same day
      statusByDk.set(dk, 'taken');
    }
  }

  let expected = 0;
  let taken = 0;
  let skipped = 0;
  let missed = 0;

  if (isPrn) {
    for (const st of statusByDk.values()) {
      if (st === 'taken') taken++;
      else if (st === 'skipped') skipped++;
    }
    return { days: windowDays, expected: 0, taken, skipped, missed: 0, pct: null, isPrn: true };
  }

  for (let i = 0; i < windowDays; i++) {
    const dk = dkAdd(startDk, i);
    if (!dk) continue;
    if (!activeOn(plan, dk)) continue;
    const cs = cycleStatus(plan, dk);
    if (!cs.isActive) continue;
    const eff = planAt(plan, dk);
    if (isPrnSchedule(eff.schedule) || !dueOn(eff, dk)) continue;

    expected++;
    const st = statusByDk.get(dk);
    if (st === 'taken') taken++;
    else if (st === 'skipped') skipped++;
    else missed++;
  }

  return {
    days: windowDays,
    expected,
    taken,
    skipped,
    missed,
    pct: expected > 0 ? Math.round((taken / expected) * 100) : null,
    isPrn: false,
  };
}
