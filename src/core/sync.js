/**
 * Offline-first LWW state sync, 90-day tombstones, Hub JSON export/import,
 * lossless `protocol-os-export/v1` importer, formula-safe CSV serializers,
 * and secret-free AI Context Bundle builder.
 *
 * Pure ESM, zero external runtime dependencies (Node 22 + browser + Cloudflare Workers).
 * Acyclic DAG Layer 5 (imports constants.js, dedup.js, calculators.js, schema.js).
 */

import {
  HUB_EXPORT_FORMAT,
  PROTOCOL_OS_FORMAT_RE,
  SYNC_COLLECTIONS,
  TOMBSTONE_RETENTION_DAYS,
  DEFAULT_CONTEXT_MAX_TOKENS,
  OWNERSHIP_STATUSES,
  LOW_STOCK_DOSE_THRESHOLD,
  DAY_MS,
  CORE_SECTION_IDS,
  deepClone,
} from './constants.js';
import { normName, checkDuplicateCompound, resolveCanonicalMolecule } from './dedup.js';
import { getPreferredSolvent, canonicalizeDose, normalizeUnit, parseFiniteNumber } from './calculators.js';
import {
  slugify,
  normalizeRoute,
  createDefaultHubState,
  normalizeCompoundProfile,
  resolveEffectiveOwnership,
} from './schema.js';

// ---------------------------------------------------------------------------
// 1. Deterministic Serialization, Revisions & Tombstones
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization recursively sorting plain-object keys
 * lexicographically while preserving array index order.
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        item === undefined || typeof item === 'function' || typeof item === 'symbol' ? 'null' : stableStringify(item),
      )
      .join(',')}]`;
  }
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pairs = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    pairs.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(',')}}`;
}

/**
 * Canonical string body of a record with volatile sync-metadata keys stripped.
 */
export function canonicalBodyOf(record) {
  if (!record || typeof record !== 'object') return stableStringify(record);
  const copy = { ...record };
  delete copy.updatedAt;
  delete copy._dirty;
  return stableStringify(copy);
}

/**
 * Parse a revision number from integer, numeric string, quoted ETag (`"5"`),
 * or Cloudflare weak ETag (`W/"5"`). Returns non-negative integer or `null`.
 */
export function parseRevision(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    let s = raw.trim();
    if (!s) return null;
    if (/^W\//i.test(s)) s = s.slice(2).trim();
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      s = s.slice(1, -1).trim();
    }
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

export function nextRevision(raw) {
  return (parseRevision(raw) ?? 0) + 1;
}

export function emptyTombstones() {
  const out = {};
  for (const k of SYNC_COLLECTIONS) out[k] = {};
  return out;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizeTombstones(raw) {
  const out = emptyTombstones();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of SYNC_COLLECTIONS) {
    if (
      Object.prototype.hasOwnProperty.call(raw, k) &&
      raw[k] &&
      typeof raw[k] === 'object' &&
      !Array.isArray(raw[k])
    ) {
      const colMap = {};
      for (const [id, ts] of Object.entries(raw[k])) {
        if (DANGEROUS_KEYS.has(id)) continue;
        colMap[id] = ts;
      }
      out[k] = colMap;
    }
  }
  return out;
}

/**
 * Prune tombstones strictly older than `retentionDays` (default 90).
 * Invalid clock input (`nowIso`) never deletes tombstones.
 */
export function pruneTombstones(tombstones, nowIso, retentionDays = TOMBSTONE_RETENTION_DAYS) {
  const normalized = normalizeTombstones(tombstones);
  const nowMs = typeof nowIso === 'string' ? Date.parse(nowIso) : typeof nowIso === 'number' ? nowIso : NaN;
  if (!Number.isFinite(nowMs)) {
    return { tombstones: normalized, prunedCount: 0 };
  }
  const safeDays =
    typeof retentionDays === 'number' && Number.isFinite(retentionDays)
      ? Math.max(0, retentionDays)
      : TOMBSTONE_RETENTION_DAYS;
  const cutoffMs = nowMs - safeDays * DAY_MS;
  let prunedCount = 0;

  for (const col of SYNC_COLLECTIONS) {
    const map = normalized[col];
    for (const [id, ts] of Object.entries(map)) {
      const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
      if (!Number.isFinite(ms) || ms < cutoffMs) {
        delete map[id];
        prunedCount++;
      }
    }
  }

  return { tombstones: normalized, prunedCount };
}

function compareTimestamps(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  const va = Number.isFinite(ta);
  const vb = Number.isFinite(tb);
  if (va && !vb) return 1;
  if (!va && vb) return -1;
  if (!va && !vb) return 0;
  if (ta > tb) return 1;
  if (ta < tb) return -1;
  return 0;
}

function isValidTimestampString(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function pickValidTimestamp(...candidates) {
  for (const c of candidates) {
    if (isValidTimestampString(c)) return c;
  }
  return null;
}

/**
 * Capture a lightweight sync baseline snapshot for `prepareSyncState`.
 */
export function snapshotState(state) {
  const collections = {};
  for (const col of SYNC_COLLECTIONS) {
    const map = {};
    const list = Array.isArray(state?.[col]) ? state[col] : [];
    for (const row of list) {
      if (!row || typeof row !== 'object' || row.id == null) continue;
      const id = String(row.id);
      Object.defineProperty(map, id, {
        value: {
          hash: canonicalBodyOf(row),
          updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    collections[col] = map;
  }

  const settingsObj =
    state?.settings && typeof state.settings === 'object' && !Array.isArray(state.settings) ? state.settings : {};
  return {
    collections,
    settings: {
      hash: canonicalBodyOf(settingsObj),
      updatedAt: typeof settingsObj.updatedAt === 'string' ? settingsObj.updatedAt : null,
    },
  };
}

/**
 * Pure sync preparation step:
 * - Stamps unstamped or body-changed records with `nowIso`
 * - Clears tombstones on revived records
 * - Records tombstones for IDs present in `baseSnapshot` that vanished
 * - Prunes tombstones older than 90 days
 * Strictly idempotent when called again against `snapshotState(res.state)`.
 */
export function prepareSyncState(state, baseSnapshot = null, nowIso = new Date().toISOString()) {
  const prepared = deepClone(state && typeof state === 'object' ? state : {});
  const tombstones = normalizeTombstones(prepared.meta?.tombstones);

  let changed = false;
  let stampedCount = 0;
  let tombstonedCount = 0;

  for (const col of SYNC_COLLECTIONS) {
    const list = Array.isArray(prepared[col]) ? prepared[col] : [];
    const baseCol = baseSnapshot?.collections?.[col] || null;
    const seenIds = new Set();
    const nextList = [];

    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      if (row.id == null) {
        nextList.push(row);
        continue;
      }
      const id = String(row.id);
      seenIds.add(id);

      if (Object.prototype.hasOwnProperty.call(tombstones[col], id)) {
        delete tombstones[col][id];
        changed = true;
      }

      const curHash = canonicalBodyOf(row);
      const prev =
        baseCol && Object.prototype.hasOwnProperty.call(baseCol, id) ? baseCol[id] : undefined;

      if (isValidTimestampString(row.updatedAt) && (!prev || prev.hash === curHash)) {
        nextList.push(row);
      } else {
        nextList.push({ ...row, updatedAt: nowIso });
        changed = true;
        stampedCount++;
      }
    }

    if (baseCol) {
      for (const prevId of Object.keys(baseCol)) {
        if (!seenIds.has(prevId) && !DANGEROUS_KEYS.has(prevId)) {
          tombstones[col][prevId] = nowIso;
          changed = true;
          tombstonedCount++;
        }
      }
    }

    prepared[col] = nextList;
  }

  // Settings change detection
  const curSettings =
    prepared.settings && typeof prepared.settings === 'object' && !Array.isArray(prepared.settings)
      ? prepared.settings
      : {};
  const curSettingsHash = canonicalBodyOf(curSettings);
  const prevSettings = baseSnapshot?.settings;
  if (prevSettings) {
    if (prevSettings.hash !== curSettingsHash) {
      prepared.settings = { ...curSettings, updatedAt: nowIso };
      changed = true;
      stampedCount++;
    } else {
      prepared.settings = curSettings;
    }
  } else if (Object.keys(curSettings).length > 0 && !isValidTimestampString(curSettings.updatedAt)) {
    prepared.settings = { ...curSettings, updatedAt: nowIso };
    changed = true;
    stampedCount++;
  } else {
    prepared.settings = curSettings;
  }

  // Prune expired tombstones
  const pruned = pruneTombstones(tombstones, nowIso, TOMBSTONE_RETENTION_DAYS);
  if (pruned.prunedCount > 0) changed = true;

  prepared.meta = {
    ...(prepared.meta && typeof prepared.meta === 'object' && !Array.isArray(prepared.meta) ? prepared.meta : {}),
    migrations: Array.isArray(prepared.meta?.migrations) ? [...prepared.meta.migrations] : [],
    tombstones: pruned.tombstones,
  };

  return {
    state: prepared,
    changed,
    stampedCount,
    tombstonedCount,
    prunedCount: pruned.prunedCount,
  };
}

/**
 * Pure non-mutating ID-keyed upsert preserving order of `existingList`.
 */
export function upsertById(existingList = [], incomingList = []) {
  const out = deepClone(Array.isArray(existingList) ? existingList : []);
  const indexById = new Map();
  out.forEach((item, idx) => {
    if (item && typeof item === 'object' && item.id != null) {
      indexById.set(String(item.id), idx);
    }
  });

  for (const inc of Array.isArray(incomingList) ? incomingList : []) {
    if (!inc || typeof inc !== 'object') continue;
    if (inc.id == null) {
      out.push(deepClone(inc));
      continue;
    }
    const id = String(inc.id);
    const cloned = deepClone(inc);
    if (indexById.has(id)) {
      out[indexById.get(id)] = cloned;
    } else {
      indexById.set(id, out.length);
      out.push(cloned);
    }
  }
  return out;
}

/**
 * Conflict-safe Last-Write-Wins (LWW) merge across all 8 collections, settings,
 * migrations, revisions, and 90-day tombstones. Pure and non-mutating.
 */
export function mergeStates(localState, remoteState, options = {}) {
  const {
    nowIso = new Date().toISOString(),
    retentionDays = TOMBSTONE_RETENTION_DAYS,
    preferLocalOnTie = true,
    prune = true,
  } = options || {};

  const loc = localState && typeof localState === 'object' ? localState : {};
  const rem = remoteState && typeof remoteState === 'object' ? remoteState : {};

  // 1. Tombstone CRDT union (max timestamp per collection + ID)
  const locTombs = normalizeTombstones(loc.meta?.tombstones);
  const remTombs = normalizeTombstones(rem.meta?.tombstones);
  let mergedTombs = emptyTombstones();

  for (const col of SYNC_COLLECTIONS) {
    const ids = new Set([...Object.keys(locTombs[col]), ...Object.keys(remTombs[col])]);
    for (const id of ids) {
      if (DANGEROUS_KEYS.has(id)) continue;
      const lTs = Object.prototype.hasOwnProperty.call(locTombs[col], id) ? locTombs[col][id] : undefined;
      const rTs = Object.prototype.hasOwnProperty.call(remTombs[col], id) ? remTombs[col][id] : undefined;
      mergedTombs[col][id] = compareTimestamps(rTs, lTs) > 0 ? rTs : lTs ?? rTs;
    }
  }

  if (prune !== false) {
    mergedTombs = pruneTombstones(mergedTombs, nowIso, retentionDays).tombstones;
  }

  const isAlive = (rec, tombTs) => {
    if (!isValidTimestampString(tombTs)) return true;
    const recTs = pickValidTimestamp(rec?.updatedAt, rec?.timestamp);
    // Record must be strictly newer than the deletion tombstone to survive/revive
    return compareTimestamps(recTs, tombTs) > 0;
  };

  // Helper: deduplicate duplicate IDs within a single side by LWW winner
  const collapseSide = (list) => {
    const order = [];
    const byId = new Map();
    const noId = [];
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.id == null) {
        noId.push(rec);
        continue;
      }
      const id = String(rec.id);
      if (!byId.has(id)) {
        order.push(id);
        byId.set(id, rec);
      } else {
        const prev = byId.get(id);
        const cmp = compareTimestamps(
          pickValidTimestamp(rec.updatedAt, rec.timestamp),
          pickValidTimestamp(prev.updatedAt, prev.timestamp),
        );
        if (cmp > 0) {
          byId.set(id, rec);
        }
      }
    }
    return { order, byId, noId };
  };

  // 2. Per-collection LWW merge
  const merged = {};
  for (const col of SYNC_COLLECTIONS) {
    const locList = Array.isArray(loc[col]) ? loc[col] : [];
    const remList = Array.isArray(rem[col]) ? rem[col] : [];

    const locSide = collapseSide(locList);
    const remSide = collapseSide(remList);

    const seenIds = new Set();
    const result = [];

    for (const noIdRec of locSide.noId) {
      result.push(deepClone(noIdRec));
    }

    for (const id of locSide.order) {
      seenIds.add(id);
      const lRec = locSide.byId.get(id);
      const rRec = remSide.byId.get(id);
      let winner = lRec;
      if (rRec) {
        const cmp = compareTimestamps(
          pickValidTimestamp(rRec.updatedAt, rRec.timestamp),
          pickValidTimestamp(lRec.updatedAt, lRec.timestamp),
        );
        if (cmp > 0 || (cmp === 0 && preferLocalOnTie === false)) {
          winner = rRec;
        }
      }

      const tombTs = Object.prototype.hasOwnProperty.call(mergedTombs[col], id)
        ? mergedTombs[col][id]
        : undefined;
      if (isAlive(winner, tombTs)) {
        result.push(deepClone(winner));
      }
    }

    for (const noIdRec of remSide.noId) {
      result.push(deepClone(noIdRec));
    }

    for (const id of remSide.order) {
      if (seenIds.has(id)) continue;
      const rRec = remSide.byId.get(id);
      const tombTs = Object.prototype.hasOwnProperty.call(mergedTombs[col], id)
        ? mergedTombs[col][id]
        : undefined;
      if (isAlive(rRec, tombTs)) {
        result.push(deepClone(rRec));
      }
    }

    if (col === 'auditLog') {
      result.sort((a, b) => {
        const cmp = compareTimestamps(
          pickValidTimestamp(a.timestamp, a.updatedAt),
          pickValidTimestamp(b.timestamp, b.updatedAt),
        );
        if (cmp !== 0) return cmp;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
    }

    merged[col] = result;
  }

  // 3. Settings LWW merge
  const locSettings =
    loc.settings && typeof loc.settings === 'object' && !Array.isArray(loc.settings) ? loc.settings : {};
  const remSettings =
    rem.settings && typeof rem.settings === 'object' && !Array.isArray(rem.settings) ? rem.settings : {};
  const settingsCmp = compareTimestamps(remSettings.updatedAt, locSettings.updatedAt);
  const mergedSettings =
    settingsCmp > 0 || (settingsCmp === 0 && preferLocalOnTie === false)
      ? { ...deepClone(locSettings), ...deepClone(remSettings) }
      : { ...deepClone(remSettings), ...deepClone(locSettings) };

  // 4. Meta & Envelope
  const migrations = [
    ...new Set([
      ...(Array.isArray(rem.meta?.migrations) ? deepClone(rem.meta.migrations) : []),
      ...(Array.isArray(loc.meta?.migrations) ? deepClone(loc.meta.migrations) : []),
    ]),
  ];

  const locSyncedAt = typeof loc._syncedAt === 'string' && loc._syncedAt ? loc._syncedAt : null;
  const remSyncedAt = typeof rem._syncedAt === 'string' && rem._syncedAt ? rem._syncedAt : null;
  const syncedAtCmp = compareTimestamps(remSyncedAt, locSyncedAt);
  const mergedSyncedAt = syncedAtCmp > 0 ? remSyncedAt : locSyncedAt || remSyncedAt || null;

  const safeSchemaVer = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : 1);
  const mergedSchemaVersion =
    typeof loc.schemaVersion === 'string' && loc.schemaVersion
      ? loc.schemaVersion
      : typeof rem.schemaVersion === 'string' && rem.schemaVersion
        ? rem.schemaVersion
        : null;

  return {
    ...(mergedSchemaVersion ? { schemaVersion: mergedSchemaVersion } : {}),
    _schemaVersion: Math.max(safeSchemaVer(loc._schemaVersion), safeSchemaVer(rem._schemaVersion)),
    _rev: Math.max(parseRevision(loc._rev) ?? 0, parseRevision(rem._rev) ?? 0),
    _syncedAt: mergedSyncedAt,
    ...merged,
    settings: mergedSettings,
    meta: {
      ...(rem.meta && typeof rem.meta === 'object' && !Array.isArray(rem.meta) ? deepClone(rem.meta) : {}),
      ...(loc.meta && typeof loc.meta === 'object' && !Array.isArray(loc.meta) ? deepClone(loc.meta) : {}),
      migrations,
      tombstones: mergedTombs,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Secret & Privacy Sanitization Helpers
// ---------------------------------------------------------------------------

const BENIGN_TOKEN_KEYS = new Set([
  'estimatedtokens',
  'maxestimatedtokens',
  'tokencount',
  'tokenbudget',
  'maxtokens',
  'prompttokens',
  'completiontokens',
  'totaltokens',
  'inputtokens',
  'outputtokens',
]);

function splitKeySegments(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const COMPACT_SENSITIVE_RE =
  /^(?:pin|pins|jwt|jwts|passwd|pwd|authorization|.*(?:tokens?|secrets?|passcodes?|passwords?|passphrases?|credentials?|cookies?|jwts?|apikeys?|privatekeys?|secretkeys?|signingkeys?|encryptionkeys?|decryptionkeys?|masterkeys?|accesskeys?|authkeys?|byokkeys?|oauthclients?|oauthcodes?|oauthgrants?|oauthsessions?|pushsubscriptions?|authorizationheaders?|authheaders?)|.*(?:passcode|password|passphrase|pin|token|key|apikey|secret|auth|credential)(?:hash|hashes|salt|salts|digest|digests)|.*(?:device|lock|household|user|member|app|admin|security|unlock|backup|recovery)pins?|.*pin(?:code|codes|value|values|number|numbers|secret|secrets))$/;

function isSensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false;
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!compact || BENIGN_TOKEN_KEYS.has(compact)) return false;

  if (COMPACT_SENSITIVE_RE.test(compact)) return true;

  const joined = splitKeySegments(key).join('_');
  if (
    /^(?:secret|secrets|token|tokens|passcode|passcodes|password|passwords|passphrase|passphrases|pin|pins|jwt|jwts|credential|credentials|authorization|cookie|cookies)$/.test(
      joined,
    )
  ) {
    return true;
  }
  if (
    /(?:^|_)(?:api_keys?|private_keys?|secret_keys?|signing_keys?|encryption_keys?|decryption_keys?|master_keys?|access_keys?|auth_keys?|byok_keys?|oauth_(?:clients?|tokens?|codes?|secrets?|grants?|sessions?)|push_subscriptions?|authorization_headers?|auth_headers?|authorization|credentials?|cookies?|jwts?)$/.test(
      joined,
    )
  ) {
    return true;
  }
  if (/(?:^|_)(?:tokens?|secrets?|passcodes?|passwords?|passphrases?)$/.test(joined)) {
    return true;
  }
  if (
    /(?:^|_)(?:passcode|password|passphrase|pin|token|key|api_key|secret|auth|credential)_(?:hash|hashes|salt|salts|digest|digests)$/.test(
      joined,
    )
  ) {
    return true;
  }
  if (
    /(?:^|_)(?:(?:device|lock|household|user|member|app|admin|security|unlock|backup|recovery)_pins?|pin_(?:code|codes|value|values|number|numbers|secret|secrets))$/.test(
      joined,
    )
  ) {
    return true;
  }
  return false;
}

function _stripSecrets(value, seen) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) {
    const re = new RegExp(value.source, value.flags);
    re.lastIndex = value.lastIndex;
    return re;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const item of value) out.add(_stripSecrets(item, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value.entries()) {
      if (typeof k === 'string' && (DANGEROUS_KEYS.has(k) || isSensitiveKey(k))) continue;
      out.set(_stripSecrets(k, seen), _stripSecrets(v, seen));
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(_stripSecrets(item, seen));
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k) || isSensitiveKey(k)) continue;
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = _stripSecrets(v, seen);
  }
  return out;
}

/**
 * Recursively clone `value` while stripping any credentials, tokens, passcodes,
 * API keys, OAuth secrets, PIN hashes/salts, private keys, and prototype-pollution keys.
 */
export function stripSecrets(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  return _stripSecrets(value, new WeakMap());
}

const REDACT_PEM_RE =
  /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,32}PRIVATE KEY-----|$)/g;

const REDACT_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const REDACT_BASIC_HEADER_RE =
  /\b(Authorization['"]?\s*[:=]\s*['"]?Basic\s+)[A-Za-z0-9+/=]{4,}/gi;

const REDACT_BASIC_AUTH_URL_RE =
  /\b([a-z][a-z0-9+.-]{0,24}:\/\/)([^/\s?#@"'<>:]*):([^/\s?#@"'<>]+)@/gi;

const REDACT_PROVIDER_KEY_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|hp_(?:live|test|key|read|propose|write)_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

const REDACT_QUERY_SECRET_RE =
  /([?&](?:(?:x[_-]?)?api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|admin[_-]?token|bearer[_-]?token|token|client[_-]?secret|secret[_-]?key|private[_-]?key|secret|passcode|password|passphrase|pin|jwt|key)=)[^&\s#'"]+/gi;

const REDACT_KV_RE =
  /\b((?:[A-Za-z0-9]+[_-]){0,3}(?:(?:x|openai|gemini|anthropic|claude|grok|byok|hub)?api[_-]?key|apikey|(?:access|refresh|sync|auth|bearer|session|admin|oauth|id|csrf|api|hub|user|device)?token|(?:oauth)?(?:client|webhook|oauth|shared|signing|app|master)?secret|(?:vapid)?(?:secret|private|signing|encryption|decryption|master|access|auth|byok)[_-]?key|(?:authorization|auth)[_-]?header|(?:device|lock|household|user|member|app|admin|security|unlock)[_-]?pin|pin[_-]?codes?|(?:household|admin|user)?passcode|(?:admin|user|db|root|master)?password|passphrase|passwd|pwd|(?:client|user|oauth)?credentials?|(?:session|auth|refresh)?cookies?|(?:access|auth|user)?jwt|(?:household|admin|user|device|lock)?(?:passcode|password|passphrase|pin|token|key|api[_-]?key|secret|auth|credential)[_-]?(?:hash|salt|digest)|pin))(['"]?\s*[:=]\s*)(\[REDACTED(?:_KEY|_PRIVATE_KEY)?\]|"(?:\\.|[^"\\\r\n])*(?:"|\\?)|'(?:\\.|[^'\\\r\n])*(?:'|\\?)|[^\s'",;&}\])#]+)/gi;

function hasUnescapedClosingQuote(val, quote) {
  if (val.length < 2 || !val.startsWith(quote) || !val.endsWith(quote)) return false;
  let backslashes = 0;
  for (let i = val.length - 2; i >= 1 && val[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

/**
 * Redact accidentally embedded PEM private keys, bearer tokens, Basic-Auth headers/URLs,
 * provider/hub API keys, bare JWTs, JSON/quoted/unquoted key-value secrets (including
 * unclosed/truncated quotes), passcodes/PINs, and URL query tokens inside free text.
 * All passes are strictly O(N) linear time and idempotent.
 */
export function redactSensitiveText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  if (out.includes('PRIVATE KEY-----')) {
    out = out.replace(REDACT_PEM_RE, '[REDACTED_PRIVATE_KEY]');
  }
  out = out.replace(REDACT_BEARER_RE, 'Bearer [REDACTED]');
  if (out.includes(':') || out.includes('=')) {
    out = out.replace(REDACT_BASIC_HEADER_RE, '$1[REDACTED]');
  }
  if (out.includes('://') && out.includes('@')) {
    out = out.replace(REDACT_BASIC_AUTH_URL_RE, '$1[REDACTED]:[REDACTED]@');
  }
  out = out.replace(REDACT_PROVIDER_KEY_RE, '[REDACTED_KEY]');
  if (out.includes('?') || out.includes('&')) {
    out = out.replace(REDACT_QUERY_SECRET_RE, '$1[REDACTED]');
  }
  if (out.includes(':') || out.includes('=')) {
    out = out.replace(REDACT_KV_RE, (match, key, sep, val) => {
      if (BENIGN_TOKEN_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
        return match;
      }
      if (val === '[REDACTED]' || val === '[REDACTED_KEY]' || val === '[REDACTED_PRIVATE_KEY]') {
        return `${key}${sep}[REDACTED]`;
      }
      if (val.startsWith('"')) {
        return hasUnescapedClosingQuote(val, '"') ? `${key}${sep}"[REDACTED]"` : `${key}${sep}"[REDACTED]`;
      }
      if (val.startsWith("'")) {
        return hasUnescapedClosingQuote(val, "'") ? `${key}${sep}'[REDACTED]'` : `${key}${sep}'[REDACTED]`;
      }
      return `${key}${sep}[REDACTED]`;
    });
  }
  return out;
}

function _redactStringsDeep(value, seen) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) {
    const re = new RegExp(value.source, value.flags);
    re.lastIndex = value.lastIndex;
    return re;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const item of value) out.add(_redactStringsDeep(item, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value.entries()) {
      if (typeof k === 'string' && DANGEROUS_KEYS.has(k)) continue;
      out.set(_redactStringsDeep(k, seen), _redactStringsDeep(v, seen));
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const v of value) out.push(_redactStringsDeep(v, seen));
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = _redactStringsDeep(v, seen);
  }
  return out;
}

function redactStringsDeep(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  return _redactStringsDeep(value, new WeakMap());
}

// ---------------------------------------------------------------------------
// 3. `home-pharmacy-export/v1` Full JSON Export, Validation & Import (F43)
// ---------------------------------------------------------------------------

const OWNERSHIP_STATUS_SET = new Set(OWNERSHIP_STATUSES);

export function exportHubJson(state, options = {}) {
  const {
    memberId = null,
    sectionIds = null,
    includeLogs = true,
    includeAuditLog = true,
    includeProposals = true,
    exportedAt = new Date().toISOString(),
  } = options || {};

  const src = state && typeof state === 'object' ? state : {};
  const secFilter = Array.isArray(sectionIds) && sectionIds.length > 0 ? new Set(sectionIds) : null;

  let members = Array.isArray(src.members) ? src.members : [];
  if (memberId) {
    members = members.filter((m) => m && m.id === memberId);
  }

  let sections = Array.isArray(src.sections) ? src.sections : [];
  if (secFilter) {
    sections = sections.filter((s) => s && secFilter.has(s.id));
  }

  let compounds = Array.isArray(src.compounds) ? src.compounds : [];
  if (secFilter) {
    compounds = compounds.filter((c) => c && secFilter.has(c.sectionId));
  }
  const compoundIdSet = new Set(compounds.map((c) => c?.id).filter(Boolean));

  let ownership = Array.isArray(src.ownership) ? src.ownership : [];
  if (memberId) {
    ownership = ownership.filter((o) => o && (o.scope === 'household' || o.scope === `member:${memberId}`));
  }
  if (secFilter) {
    ownership = ownership.filter((o) => o && compoundIdSet.has(o.compoundId));
  }

  let stacks = Array.isArray(src.stacks) ? src.stacks : [];
  if (memberId) {
    stacks = stacks.filter((s) => s && s.memberId === memberId);
  }

  let logs = includeLogs && Array.isArray(src.logs) ? src.logs : [];
  if (includeLogs && memberId) {
    logs = logs.filter((l) => l && l.memberId === memberId);
  }

  const proposals = includeProposals && Array.isArray(src.proposals) ? src.proposals : [];
  const auditLog = includeAuditLog && Array.isArray(src.auditLog) ? src.auditLog : [];
  const settings =
    src.settings && typeof src.settings === 'object' && !Array.isArray(src.settings) ? src.settings : {};
  const meta = {
    migrations: Array.isArray(src.meta?.migrations) ? [...src.meta.migrations] : [],
    tombstones: normalizeTombstones(src.meta?.tombstones),
  };

  return stripSecrets({
    _format: HUB_EXPORT_FORMAT,
    _schemaVersion: src._schemaVersion || 1,
    exportedAt,
    filter: {
      memberId: memberId || null,
      sectionIds: secFilter ? [...secFilter] : null,
    },
    members,
    sections,
    compounds,
    ownership,
    stacks,
    logs,
    proposals,
    auditLog,
    settings,
    meta,
  });
}

export function validateHubExport(input) {
  const errors = [];
  const warnings = [];
  let parsed = input;

  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      return {
        ok: false,
        format: null,
        schemaVersion: null,
        exportedAt: null,
        counts: null,
        skipped: 0,
        errors: [`Invalid JSON: ${err.message}`],
        warnings,
        sanitized: null,
      };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      format: null,
      schemaVersion: null,
      exportedAt: null,
      counts: null,
      skipped: 0,
      errors: ['Export payload must be a JSON object.'],
      warnings,
      sanitized: null,
    };
  }

  if (typeof parsed._format === 'string' && PROTOCOL_OS_FORMAT_RE.test(parsed._format)) {
    return {
      ok: false,
      format: parsed._format,
      schemaVersion: null,
      exportedAt: null,
      counts: null,
      skipped: 0,
      errors: ['File is a Protocol OS export — use importProtocolOsExport instead.'],
      warnings,
      sanitized: null,
    };
  }

  if (parsed._format !== HUB_EXPORT_FORMAT) {
    return {
      ok: false,
      format: parsed._format || null,
      schemaVersion: null,
      exportedAt: null,
      counts: null,
      skipped: 0,
      errors: [`Unsupported or missing _format (expected "${HUB_EXPORT_FORMAT}").`],
      warnings,
      sanitized: null,
    };
  }

  const container = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data : parsed;

  const rowChecks = {
    members: (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim() && typeof r.name === 'string' && r.name.trim(),
    sections: (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim() && typeof r.name === 'string' && r.name.trim(),
    compounds: (r) =>
      r &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.trim() &&
      typeof r.name === 'string' &&
      r.name.trim() &&
      typeof r.sectionId === 'string' &&
      r.sectionId.trim(),
    ownership: (r) =>
      r &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.trim() &&
      typeof r.compoundId === 'string' &&
      r.compoundId.trim() &&
      OWNERSHIP_STATUS_SET.has(r.status),
    stacks: (r) =>
      r &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.trim() &&
      typeof r.memberId === 'string' &&
      r.memberId.trim() &&
      typeof r.name === 'string' &&
      r.name.trim(),
    logs: (r) =>
      r &&
      typeof r === 'object' &&
      typeof r.id === 'string' &&
      r.id.trim() &&
      typeof r.memberId === 'string' &&
      r.memberId.trim() &&
      typeof r.datetime === 'string' &&
      r.datetime.trim(),
    proposals: (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim(),
    auditLog: (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim(),
  };

  const sanitized = {
    _schemaVersion:
      Number.isSafeInteger(parsed._schemaVersion) && parsed._schemaVersion >= 1 ? parsed._schemaVersion : 1,
    settings: container.settings && typeof container.settings === 'object' && !Array.isArray(container.settings) ? container.settings : {},
    meta: {
      migrations: Array.isArray(container.meta?.migrations) ? [...container.meta.migrations] : [],
      tombstones: normalizeTombstones(container.meta?.tombstones),
    },
  };

  const counts = {};
  let totalValid = 0;
  let skipped = 0;

  for (const col of SYNC_COLLECTIONS) {
    if (container[col] === undefined) {
      sanitized[col] = [];
      counts[col] = 0;
      continue;
    }
    if (!Array.isArray(container[col])) {
      errors.push(`Collection "${col}" must be an array.`);
      counts[col] = 0;
      sanitized[col] = [];
      continue;
    }
    const validRows = [];
    for (const row of container[col]) {
      if (rowChecks[col](row)) {
        validRows.push(row);
      } else {
        skipped++;
      }
    }
    sanitized[col] = validRows;
    counts[col] = validRows.length;
    totalValid += validRows.length;
  }

  let cleanSanitized = null;
  if (errors.length === 0) {
    const cleaned = stripSecrets(sanitized);
    const hasSettings =
      cleaned.settings && typeof cleaned.settings === 'object' && Object.keys(cleaned.settings).length > 0;
    if (totalValid === 0 && !hasSettings) {
      errors.push('Export contains zero valid records and no settings.');
    } else {
      cleanSanitized = cleaned;
    }
  }
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} malformed row(s) during validation.`);
  }

  return {
    ok: errors.length === 0,
    format: parsed._format,
    schemaVersion: sanitized._schemaVersion,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
    counts,
    skipped,
    errors,
    warnings,
    sanitized: cleanSanitized,
  };
}

export function importHubJson(currentState, input, options = {}) {
  const { mode = 'merge', nowIso = new Date().toISOString() } = options || {};
  const check = validateHubExport(input);
  if (!check.ok) {
    return {
      ok: false,
      state: currentState,
      imported: null,
      skipped: check.skipped,
      errors: check.errors,
      warnings: check.warnings,
    };
  }

  const incoming = check.sanitized;

  if (mode === 'lww') {
    const nextState = mergeStates(currentState, incoming, { nowIso });
    return {
      ok: true,
      state: nextState,
      imported: check.counts,
      skipped: check.skipped,
      warnings: check.warnings,
      errors: [],
    };
  }

  const computeRevivedUpdatedAt = (recUpdatedAt, tombTs) => {
    let candidate = isValidTimestampString(recUpdatedAt) ? recUpdatedAt : nowIso;
    if (tombTs) {
      if (compareTimestamps(candidate, tombTs) <= 0 || compareTimestamps(nowIso, candidate) > 0) {
        if (compareTimestamps(nowIso, tombTs) > 0) {
          candidate = nowIso;
        } else {
          const tMs = Date.parse(tombTs);
          candidate = Number.isFinite(tMs) ? new Date(tMs + 1).toISOString() : nowIso;
        }
      }
    }
    return candidate;
  };

  if (mode === 'replace') {
    const defaults = createDefaultHubState({ now: nowIso });
    const nextState = deepClone(defaults);
    const prevTombstones = normalizeTombstones(currentState?.meta?.tombstones);
    for (const col of SYNC_COLLECTIONS) {
      nextState[col] = incoming[col].map((r) => {
        const cloned = deepClone(r);
        const id = cloned && cloned.id != null ? String(cloned.id) : null;
        const tombTs =
          id && Object.prototype.hasOwnProperty.call(prevTombstones[col], id)
            ? prevTombstones[col][id]
            : null;
        const baseTs =
          isValidTimestampString(cloned.updatedAt) && compareTimestamps(cloned.updatedAt, nowIso) >= 0
            ? cloned.updatedAt
            : nowIso;
        return { ...cloned, updatedAt: computeRevivedUpdatedAt(baseTs, tombTs) };
      });
    }
    // Guarantee at least 1 member
    if (nextState.members.length === 0) {
      nextState.members = defaults.members;
    }
    // Guarantee all 4 core sections exist
    const presentSecIds = new Set(nextState.sections.map((s) => s.id));
    for (const coreSec of defaults.sections) {
      if (!presentSecIds.has(coreSec.id)) {
        nextState.sections.push(coreSec);
      }
    }
    nextState.settings = { ...defaults.settings, ...deepClone(incoming.settings), updatedAt: nowIso };
    nextState.meta = {
      migrations: [...new Set(incoming.meta?.migrations || [])],
      tombstones: emptyTombstones(),
      createdAt: defaults.meta.createdAt,
      updatedAt: nowIso,
    };
    nextState._rev = nextRevision(currentState?._rev);
    return {
      ok: true,
      state: nextState,
      imported: check.counts,
      skipped: check.skipped,
      warnings: check.warnings,
      errors: [],
    };
  }

  // Default mode: 'merge' (safe non-destructive restore/merge; revives tombstoned IDs cleanly!)
  const nextState = deepClone(currentState && typeof currentState === 'object' ? currentState : createDefaultHubState({ now: nowIso }));
  const tombstones = normalizeTombstones(nextState.meta?.tombstones);

  for (const col of SYNC_COLLECTIONS) {
    const stampedIncoming = incoming[col].map((r) => {
      const cloned = deepClone(r);
      let tombTs = null;
      if (cloned && cloned.id != null) {
        const id = String(cloned.id);
        if (Object.prototype.hasOwnProperty.call(tombstones[col], id)) {
          tombTs = tombstones[col][id];
          delete tombstones[col][id];
        }
      }
      return { ...cloned, updatedAt: computeRevivedUpdatedAt(cloned.updatedAt, tombTs) };
    });
    nextState[col] = upsertById(nextState[col] || [], stampedIncoming);
  }

  nextState.settings = {
    ...(nextState.settings && typeof nextState.settings === 'object' && !Array.isArray(nextState.settings)
      ? nextState.settings
      : {}),
    ...deepClone(incoming.settings),
    updatedAt: nowIso,
  };
  nextState.meta = {
    ...(nextState.meta && typeof nextState.meta === 'object' && !Array.isArray(nextState.meta) ? nextState.meta : {}),
    migrations: [
      ...new Set([
        ...(Array.isArray(nextState.meta?.migrations) ? nextState.meta.migrations : []),
        ...(Array.isArray(incoming.meta?.migrations) ? incoming.meta.migrations : []),
      ]),
    ],
    tombstones,
    updatedAt: nowIso,
  };

  return {
    ok: true,
    state: nextState,
    imported: check.counts,
    skipped: check.skipped,
    warnings: check.warnings,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// 4. Lossless `protocol-os-export/v1` Importer (F43)
// ---------------------------------------------------------------------------

export function validateProtocolOsExport(input) {
  const errors = [];
  const warnings = [];
  let parsed = input;

  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      return {
        ok: false,
        format: null,
        exportedAt: null,
        activeProfile: null,
        protocols: [],
        vials: [],
        storage: [],
        logs: [],
        meta: {},
        skipped: 0,
        errors: [`Invalid JSON: ${err.message}`],
        warnings,
      };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      format: null,
      exportedAt: null,
      activeProfile: null,
      protocols: [],
      vials: [],
      storage: [],
      logs: [],
      meta: {},
      skipped: 0,
      errors: ['Payload must be a JSON object.'],
      warnings,
    };
  }

  if (parsed._format === HUB_EXPORT_FORMAT) {
    return {
      ok: false,
      format: parsed._format,
      exportedAt: null,
      activeProfile: null,
      protocols: [],
      vials: [],
      storage: [],
      logs: [],
      meta: {},
      skipped: 0,
      errors: ['File is already a Home Pharmacy export — use importHubJson instead.'],
      warnings,
    };
  }

  const hasProtocolOsFormat = typeof parsed._format === 'string' && PROTOCOL_OS_FORMAT_RE.test(parsed._format);
  const hasRawArrays =
    Array.isArray(parsed.protocols) ||
    Array.isArray(parsed.vials) ||
    Array.isArray(parsed.logs) ||
    Array.isArray(parsed.storage);

  if (!hasProtocolOsFormat && !hasRawArrays) {
    return {
      ok: false,
      format: parsed._format || null,
      exportedAt: null,
      activeProfile: null,
      protocols: [],
      vials: [],
      storage: [],
      logs: [],
      meta: {},
      skipped: 0,
      errors: ['Payload is not a recognized Protocol OS export.'],
      warnings,
    };
  }

  let skipped = 0;
  const protocols = [];
  for (const p of Array.isArray(parsed.protocols) ? parsed.protocols : []) {
    if (
      p &&
      typeof p === 'object' &&
      !Array.isArray(p) &&
      p.id != null &&
      (p.peptideId || p.peptideName) &&
      (p.schedule || p.timeline || p.doseMcg != null || p.doseAmount != null)
    ) {
      protocols.push(deepClone(p));
    } else {
      skipped++;
    }
  }

  const vials = [];
  for (const v of Array.isArray(parsed.vials) ? parsed.vials : []) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.id != null) vials.push(deepClone(v));
    else skipped++;
  }

  const storage = [];
  for (const s of Array.isArray(parsed.storage) ? parsed.storage : []) {
    if (s && typeof s === 'object' && !Array.isArray(s) && s.id != null) storage.push(deepClone(s));
    else skipped++;
  }

  const logs = [];
  for (const l of Array.isArray(parsed.logs) ? parsed.logs : []) {
    if (
      l &&
      typeof l === 'object' &&
      !Array.isArray(l) &&
      l.id != null &&
      typeof l.datetime === 'string' &&
      l.datetime.trim()
    ) {
      logs.push(deepClone(l));
    } else {
      skipped++;
    }
  }

  const total = protocols.length + vials.length + storage.length + logs.length;
  if (total === 0) {
    errors.push('Protocol OS export contains zero usable records.');
  }
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} malformed legacy row(s).`);
  }

  return {
    ok: errors.length === 0,
    format: parsed._format || 'protocol-os-raw',
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
    activeProfile:
      typeof parsed.activeProfile === 'string' && parsed.activeProfile.trim()
        ? parsed.activeProfile.trim()
        : typeof parsed.profile === 'string' && parsed.profile.trim()
          ? parsed.profile.trim()
          : null,
    protocols,
    vials,
    storage,
    logs,
    meta: parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? deepClone(parsed.meta) : {},
    skipped,
    errors,
    warnings,
  };
}

const LEGACY_PED_KEYS = new Set([
  'testosterone',
  'testosteronecyp',
  'testosteronecypionate',
  'testcyp',
  'testosteroneenanthate',
  'teste',
  'deca',
  'nandrolonedecanoate',
  'npp',
  'nandrolonephenylpropionate',
  'anavar',
  'oxandrolone',
  'primobolan',
  'methenoloneenanthate',
  'masteron',
  'lgd4033',
  'ligandrol',
  'ostarine',
  'mk2866',
  'rad140',
  'anastrozole',
  'exemestane',
  'enclomiphene',
  'tamoxifen',
  'hcg',
  'humanchorionicgonadotropin',
  'tadalafil',
  'cialis',
  'finasteride',
  'dutasteride',
  'ace031',
  'follistatin',
  'flrg242',
  'slupp332',
]);

const LEGACY_SUPP_RE =
  /\b(?:vitamin|magnesium|omega|fish\s*oil|zinc|iron|creatine|collagen|nac|tudca|l-carnitine|l-glutathione|coq10|berberine|theanine|ashwagandha|probiotic|electrolyte)\b/i;

const LEGACY_DERM_RE =
  /\b(?:tretinoin|retin-a|adapalene|minoxidil|azelaic|ketoconazole|spf|sunscreen|glycolic|salicylic|niacinamide|serum|cream|shampoo|foam)\b/i;

function classifyLegacySection({ id, name, route, oil, kind, category }) {
  const normRouteVal = normalizeRoute(route);
  const nk = normName(id || name);
  const nameStr = String(name || id || '');

  if (normRouteVal === 'Topical' || LEGACY_DERM_RE.test(nameStr)) {
    return 'dermatology';
  }
  if (oil === true || LEGACY_PED_KEYS.has(nk) || /^(?:anabolic|hormone|aas|trt|sarm|ped)$/i.test(String(category || ''))) {
    return 'peds';
  }
  if (kind === 'supp' || LEGACY_SUPP_RE.test(nameStr)) {
    return 'vitamins_supplements';
  }
  return 'peptides';
}

function mapLegacyTimeOfDayToSlot(tod) {
  if (!tod || typeof tod !== 'string') return null;
  const t = tod.trim().toLowerCase();
  if (t === 'am' || t === 'morning') return 'morning_am';
  if (t === 'waking' || t === 'fasted_am') return 'waking_fasted';
  if (t === 'pre_workout' || t === 'preworkout') return 'pre_workout';
  if (t === 'post_workout' || t === 'postworkout') return 'intra_post_workout';
  if (t === 'midday' || t === 'lunch' || t === 'noon') return 'midday_lunch';
  if (t === 'pm' || t === 'evening' || t === 'dinner') return 'evening_dinner';
  if (t === 'bedtime' || t === 'night' || t === 'sleep') return 'bedtime_fasted';
  if (t === 'prn') return 'prn';
  return null;
}

/**
 * Lossless, idempotent importer for `protocol-os-export/v1` exports.
 * Maps compounds, vials, storage, protocols/cycles/timelines, and logs cleanly
 * without overwriting verified profiles or duplicating entries on repeat runs.
 */
export function importProtocolOsExport(currentState, input, options = {}) {
  const check = validateProtocolOsExport(input);
  if (!check.ok) {
    return {
      ok: false,
      state: currentState,
      summary: null,
      warnings: check.warnings,
      errors: check.errors,
    };
  }

  const nowIso = options.nowIso || new Date().toISOString();
  const nextState = deepClone(
    currentState && typeof currentState === 'object' ? currentState : createDefaultHubState({ now: nowIso }),
  );
  nextState.members = Array.isArray(nextState.members) ? nextState.members : [];
  nextState.compounds = Array.isArray(nextState.compounds) ? nextState.compounds : [];
  nextState.ownership = Array.isArray(nextState.ownership) ? nextState.ownership : [];
  nextState.stacks = Array.isArray(nextState.stacks) ? nextState.stacks : [];
  nextState.logs = Array.isArray(nextState.logs) ? nextState.logs : [];
  nextState.auditLog = Array.isArray(nextState.auditLog) ? nextState.auditLog : [];
  nextState.meta = {
    ...(nextState.meta && typeof nextState.meta === 'object' && !Array.isArray(nextState.meta) ? nextState.meta : {}),
    migrations: Array.isArray(nextState.meta?.migrations) ? [...nextState.meta.migrations] : [],
    tombstones: normalizeTombstones(nextState.meta?.tombstones),
  };

  const defaultMemberId = options.targetMemberId || nextState.members[0]?.id || 'member_wife';
  const profileMap = options.profileMap && typeof options.profileMap === 'object' ? options.profileMap : {};
  const onlyProfile = options.onlyProfile || null;

  const resolveMemberId = (legacyProfile) => {
    if (!legacyProfile) return defaultMemberId;
    if (
      Object.prototype.hasOwnProperty.call(profileMap, legacyProfile) &&
      typeof profileMap[legacyProfile] === 'string' &&
      profileMap[legacyProfile]
    ) {
      return profileMap[legacyProfile];
    }
    const lp = String(legacyProfile).trim().toLowerCase();
    const matched = nextState.members.find(
      (m) => m && (String(m.id).toLowerCase() === lp || String(m.name).toLowerCase() === lp),
    );
    return matched ? matched.id : defaultMemberId;
  };

  // Filter by onlyProfile if requested
  const protocolOwnerMap = new Map(check.protocols.map((p) => [String(p.id), p.profile || null]));
  const protocols = onlyProfile
    ? check.protocols.filter((p) => (p.profile || check.activeProfile) === onlyProfile)
    : check.protocols;
  const vials = onlyProfile
    ? check.vials.filter((v) => !v.inventoryProfile || v.inventoryProfile === onlyProfile)
    : check.vials;
  const storageList = check.storage;
  const logs = onlyProfile
    ? check.logs.filter((l) => (l.profile || protocolOwnerMap.get(String(l.protocolId)) || check.activeProfile) === onlyProfile)
    : check.logs;

  // Pre-index vials & protocol metadata BEFORE compound creation so pen/blend linkages,
  // pre-mixed oil routes, IU vial units, and protocol dosing/cycle/slot metadata reconcile losslessly.
  const isIuVial = (v) =>
    Boolean(
      v &&
        typeof v === 'object' &&
        (normalizeUnit(v.doseUnit) === 'IU' ||
          normalizeUnit(v.unitLabel) === 'IU' ||
          parseFiniteNumber(v.vialIU ?? v.iuPerVial) > 0),
    );

  const resolveVialUnit = (v) => {
    if (!v || typeof v !== 'object') return null;
    if (isIuVial(v)) return 'IU';
    return normalizeUnit(v.doseUnit) || null;
  };

  const vialsById = new Map();
  const oilPeptides = new Set();
  const vialUnitsByPeptide = new Map();
  for (const v of vials) {
    if (v && v.id != null) vialsById.set(String(v.id), v);
    if (v && v.oil === true) {
      const k1 = normName(v.peptideId || '');
      const k2 = normName(v.peptideName || v.peptide || '');
      if (k1) oilPeptides.add(k1);
      if (k2) oilPeptides.add(k2);
    }
    if (v && v.peptideId !== '__pen__') {
      const vu = isIuVial(v) ? 'IU' : 'mass';
      for (const rawKey of [v.peptideId, v.peptideName, v.peptide]) {
        const nk = normName(rawKey || '');
        if (!nk) continue;
        if (!vialUnitsByPeptide.has(nk)) vialUnitsByPeptide.set(nk, new Set());
        vialUnitsByPeptide.get(nk).add(vu);
      }
    }
  }

  const getUnambiguousIuVialUnit = (peptideId, name) => {
    const nk = normName(peptideId || name || '');
    const set = nk ? vialUnitsByPeptide.get(nk) : null;
    if (set && set.size === 1 && set.has('IU')) return 'IU';
    return null;
  };

  const doseByPeptide = new Map();
  const protocolRoutesByPeptide = new Map();
  for (const p of protocols) {
    const pid = p.peptideId || p.peptideName;
    if (pid && parseFiniteNumber(p.doseMcg) > 0 && !doseByPeptide.has(String(pid))) {
      doseByPeptide.set(String(pid), parseFiniteNumber(p.doseMcg));
    }
    const pk = normName(p.peptideId || p.peptideName || '');
    const pRoute = normalizeRoute(p.route);
    if (pk && pRoute && p.peptideId !== '__pen__') {
      if (!protocolRoutesByPeptide.has(pk)) protocolRoutesByPeptide.set(pk, new Set());
      protocolRoutesByPeptide.get(pk).add(pRoute);
    }
  }

  const getUnambiguousProtocolRoute = (peptideId, name) => {
    const pk = normName(peptideId || name || '');
    const set = pk ? protocolRoutesByPeptide.get(pk) : null;
    if (set && set.size === 1) return [...set][0];
    return null;
  };

  const componentWeightMcg = (c) => {
    if (!c || typeof c !== 'object') return NaN;
    if (c.mcg != null) return parseFiniteNumber(c.mcg);
    if (c.mg != null) return parseFiniteNumber(c.mg) * 1000;
    if (c.g != null) return parseFiniteNumber(c.g) * 1_000_000;
    if (c.amount != null) {
      const u = normalizeUnit(c.unit || 'mcg');
      if (u === 'mg') return parseFiniteNumber(c.amount) * 1000;
      if (u === 'g') return parseFiniteNumber(c.amount) * 1_000_000;
      return parseFiniteNumber(c.amount);
    }
    if (c.fraction != null) return parseFiniteNumber(c.fraction);
    return NaN;
  };

  let compoundsCreated = 0;
  let compoundsMatched = 0;
  let ownershipUpserted = 0;
  let stackItemsUpserted = 0;
  let logsUpserted = 0;
  const warnings = [...check.warnings];

  // Map legacy key -> resolved Home Pharmacy compoundId, plus linked vialId -> compoundId
  const legacyKeyToCompoundId = new Map();
  const vialIdToCompoundId = new Map();

  const enrichUnverifiedCompound = (existing, meta, sectionData) => {
    if (!existing || existing.profileStatus === 'verified') return;

    // Non-destructively fill missing sectionData keys
    existing.sectionData = { ...sectionData, ...(existing.sectionData || {}) };
    if (
      sectionData.ingredients &&
      (!existing.sectionData.ingredients || Object.keys(existing.sectionData.ingredients).length < 2)
    ) {
      existing.sectionData.ingredients = sectionData.ingredients;
    }

    // Reconcile dosage metadata (never clobbering existing amounts unless upgrading IU unit)
    const canonDose = canonicalizeDose({
      doseMcg: meta.doseMcg,
      doseUnit: meta.doseUnit,
      doseValue: meta.doseValue,
      doseAmount: meta.doseAmount,
    });
    const metaUnit = normalizeUnit(meta.doseUnit) || canonDose?.doseUnit || null;
    const metaAmount = parseFiniteNumber(canonDose?.doseValue ?? canonDose?.doseAmount);
    existing.dosages = existing.dosages && typeof existing.dosages === 'object' ? existing.dosages : {};

    if (metaUnit === 'IU' && existing.dosages.defaultUnit !== 'IU') {
      existing.dosages.defaultUnit = 'IU';
    }
    if (existing.dosages.defaultAmount == null && metaAmount > 0) {
      const resolvedUnit = metaUnit || existing.dosages.defaultUnit || 'mcg';
      existing.dosages.defaultAmount = metaAmount;
      existing.dosages.defaultUnit = resolvedUnit;
      if (!existing.dosages.rangeText) {
        existing.dosages.rangeText = `${metaAmount} ${resolvedUnit}`;
      }
    } else if (!existing.dosages.defaultUnit && metaUnit) {
      existing.dosages.defaultUnit = metaUnit;
    }

    // Reconcile cycles
    existing.cycles = existing.cycles && typeof existing.cycles === 'object' ? existing.cycles : {};
    if (existing.cycles.cycleDays == null && Number.isInteger(meta.cycleDays) && meta.cycleDays > 0) {
      existing.cycles.cycleDays = meta.cycleDays;
      existing.cycles.continuous = false;
      if (!existing.cycles.patternText) {
        existing.cycles.patternText = `${meta.cycleDays}-day cycle`;
      }
    }

    // Reconcile timingRules
    const slot = mapLegacyTimeOfDayToSlot(meta.timeOfDay);
    if (slot) {
      existing.timingRules =
        existing.timingRules && typeof existing.timingRules === 'object' ? existing.timingRules : {};
      if (!Array.isArray(existing.timingRules.preferredSlots) || existing.timingRules.preferredSlots.length === 0) {
        existing.timingRules.preferredSlots = [slot];
      }
      if (!existing.timingRules.timingNotes && meta.timeOfDay) {
        existing.timingRules.timingNotes = `Legacy timing: ${meta.timeOfDay}`;
      }
    }
  };

  const ensureCompound = (meta) => {
    const isPenBlend =
      meta.peptideId === '__pen__' ||
      meta.isBlend === true ||
      (meta.isPen === true && Array.isArray(meta.penComponents) && meta.penComponents.length >= 2) ||
      (Array.isArray(meta.penComponents) && meta.penComponents.length >= 2);

    const trimmedPenName = typeof meta.penName === 'string' && meta.penName.trim() ? meta.penName.trim() : null;
    const rawId = isPenBlend
      ? trimmedPenName ||
        (meta.vialId != null ? `pen_${meta.vialId}` : null) ||
        (meta.peptideId && meta.peptideId !== '__pen__' ? meta.peptideId : null) ||
        meta.name ||
        `pen_${meta.protocolId || 'mix'}`
      : meta.peptideId || meta.name || 'unnamed';
    const displayName = meta.name || trimmedPenName || meta.peptideId || 'Imported Compound';
    const route = normalizeRoute(meta.route) || (meta.oil ? 'IM' : 'SubQ');
    const sectionId = classifyLegacySection({
      id: meta.peptideId,
      name: displayName,
      route,
      oil: meta.oil,
      kind: meta.kind,
      category: meta.category,
    });

    // Build sectionData & halfLife candidate
    const sectionData = {};
    let halfLife = { valueHours: null, displayText: 'Imported — verify half-life', kind: 'unmodeled' };

    if (isPenBlend) {
      const comps = Array.isArray(meta.penComponents) ? meta.penComponents : [];
      const weights = comps.map((c) => ({
        key: c?.peptideId || c?.id || c?.name || null,
        val: componentWeightMcg(c),
      }));
      const total = weights.reduce((acc, w) => acc + (Number.isFinite(w.val) && w.val > 0 ? w.val : 0), 0);
      const ingredients = {};
      if (total > 0) {
        for (const w of weights) {
          if (w.key && Number.isFinite(w.val) && w.val > 0) {
            const k = String(w.key);
            if (DANGEROUS_KEYS.has(k)) continue;
            const prev = Object.prototype.hasOwnProperty.call(ingredients, k) ? ingredients[k] : 0;
            ingredients[k] = prev + w.val / total;
          }
        }
        for (const k of Object.keys(ingredients)) {
          ingredients[k] = Number(ingredients[k].toFixed(4));
        }
      }
      sectionData.form = meta.isPen || meta.peptideId === '__pen__' ? 'pen' : 'lyophilized';
      if (Object.keys(ingredients).length >= 2) sectionData.ingredients = ingredients;
      halfLife = {
        valueHours: null,
        displayText: 'N/A — multi-component pen (unmodeled)',
        route,
        kind: 'unmodeled',
      };
    } else if (sectionId === 'peptides') {
      sectionData.form = meta.isPen ? 'pen' : route === 'Oral' ? 'oral' : route === 'Nasal' ? 'nasal' : 'lyophilized';
      sectionData.preferredSolvent = meta.solvent || getPreferredSolvent(meta.peptideId || displayName);
      if (parseFiniteNumber(meta.vialMg) > 0) sectionData.typicalVialMg = parseFiniteNumber(meta.vialMg);
      if (parseFiniteNumber(meta.vialIU) > 0) sectionData.typicalVialIU = parseFiniteNumber(meta.vialIU);
      if (parseFiniteNumber(meta.diluentMl) > 0) sectionData.defaultDiluentMl = parseFiniteNumber(meta.diluentMl);
      sectionData.injectionSiteRotation = route === 'SubQ' || route === 'IM';
      if (meta.ingredients && typeof meta.ingredients === 'object' && !Array.isArray(meta.ingredients) && Object.keys(meta.ingredients).length >= 2) {
        sectionData.ingredients = deepClone(meta.ingredients);
        halfLife = {
          valueHours: null,
          displayText: 'N/A — multi-component blend (unmodeled)',
          route,
          kind: 'unmodeled',
        };
      }
    } else if (sectionId === 'peds') {
      if (meta.oil) {
        sectionData.oilPreMixed = true;
        if (parseFiniteNumber(meta.oilConcentrationMgPerMl) > 0) {
          sectionData.oilConcentrationMgPerMl = parseFiniteNumber(meta.oilConcentrationMgPerMl);
        }
      }
    }

    // Direct vial linkage (e.g., penVialId / blendVialId on protocol -> exact same compound as vial)
    if (meta.linkedVialId != null && vialIdToCompoundId.has(String(meta.linkedVialId))) {
      const linkedCid = vialIdToCompoundId.get(String(meta.linkedVialId));
      const existing = nextState.compounds.find((c) => c && c.id === linkedCid);
      if (existing) {
        enrichUnverifiedCompound(existing, meta, sectionData);
        compoundsMatched++;
        return existing.id;
      }
    }

    const lookupKey = `${normName(rawId)}|${sectionId}|${route}`;
    if (legacyKeyToCompoundId.has(lookupKey)) {
      const existingId = legacyKeyToCompoundId.get(lookupKey);
      const existing = nextState.compounds.find((c) => c && c.id === existingId);
      if (existing) enrichUnverifiedCompound(existing, meta, sectionData);
      return existingId;
    }

    const cand = {
      name: displayName,
      sectionId,
      dosages: { route },
      sectionData,
    };

    const baseSlug = slugify(rawId) || slugify(displayName) || 'imported';
    let deterministicSlug = baseSlug;
    let deterministicId = `pos_cmp_${baseSlug}`;

    // Check deterministic ID match while respecting multi-route/cross-section variants!
    const baseIdMatch = nextState.compounds.find((c) => c && c.id === deterministicId);
    if (baseIdMatch) {
      const baseRoute = normalizeRoute(baseIdMatch.dosages?.route);
      const sameVariant =
        baseIdMatch.sectionId === sectionId && (!baseRoute || !route || baseRoute === route);
      if (sameVariant) {
        enrichUnverifiedCompound(baseIdMatch, meta, sectionData);
        compoundsMatched++;
        legacyKeyToCompoundId.set(lookupKey, baseIdMatch.id);
        return baseIdMatch.id;
      }
      // Distinct route or section variant (e.g. SubQ GHK-Cu vs Topical GHK-Cu): disambiguate ID
      const routeSuffix = slugify(route || sectionId) || 'variant';
      deterministicSlug = `${baseSlug}-${routeSuffix}`;
      deterministicId = `pos_cmp_${baseSlug}_${routeSuffix}`;
      const disambiguatedMatch = nextState.compounds.find((c) => c && c.id === deterministicId);
      if (disambiguatedMatch) {
        enrichUnverifiedCompound(disambiguatedMatch, meta, sectionData);
        compoundsMatched++;
        legacyKeyToCompoundId.set(lookupKey, disambiguatedMatch.id);
        return disambiguatedMatch.id;
      }
    }

    // Check duplicate/alias/blend fingerprint against existing catalog
    const dup = checkDuplicateCompound(cand, nextState.compounds);
    if (dup.isDuplicate && dup.existingCompoundId) {
      const existing = nextState.compounds.find((c) => c && c.id === dup.existingCompoundId);
      if (existing) {
        enrichUnverifiedCompound(existing, meta, sectionData);
        compoundsMatched++;
        legacyKeyToCompoundId.set(lookupKey, existing.id);
        return existing.id;
      }
    }

    // Create new canonical compound profile
    const canonDose = canonicalizeDose({
      doseMcg: meta.doseMcg,
      doseUnit: meta.doseUnit,
      doseValue: meta.doseValue,
      doseAmount: meta.doseAmount,
    });
    const normMetaUnit = normalizeUnit(meta.doseUnit);
    const defaultUnit = normMetaUnit === 'IU' ? 'IU' : canonDose?.doseUnit || normMetaUnit || 'mcg';
    const defaultAmount =
      parseFiniteNumber(canonDose?.doseValue ?? canonDose?.doseAmount) > 0
        ? parseFiniteNumber(canonDose?.doseValue ?? canonDose?.doseAmount)
        : null;

    const slot = mapLegacyTimeOfDayToSlot(meta.timeOfDay);

    const newCompound = normalizeCompoundProfile(
      {
        id: deterministicId,
        slug: deterministicSlug,
        name: displayName,
        canonicalMolecule: isPenBlend ? undefined : resolveCanonicalMolecule(displayName) || undefined,
        sectionId,
        subsection: isPenBlend ? 'Blends & Pens' : '',
        summary: `Imported from Protocol OS (${displayName}).`,
        timingRules: {
          preferredSlots: slot ? [slot] : [],
          avoidSlots: [],
          foodState: 'any',
          workoutRelation: 'any',
          circadianEffect: 'neutral',
          timingNotes: meta.timeOfDay ? `Legacy timing: ${meta.timeOfDay}` : '',
        },
        halfLife,
        dosages: {
          rangeText: defaultAmount ? `${defaultAmount} ${defaultUnit}` : '',
          defaultAmount,
          defaultUnit,
          route,
          frequencyText: '',
        },
        cycles: {
          patternText: meta.cycleDays ? `${meta.cycleDays}-day cycle` : '',
          cycleDays: Number.isInteger(meta.cycleDays) && meta.cycleDays > 0 ? meta.cycleDays : null,
          offDays: null,
          continuous: !meta.cycleDays,
        },
        sectionData,
        customFields: meta.peptideId ? { legacyPeptideId: String(meta.peptideId) } : {},
        profileStatus: 'needs_review',
        provenance: {
          sourceModel: 'import:protocol-os',
          researchedAt: nowIso,
          evidenceTier: 'working_hypothesis',
          confidence: 'medium',
          citations: [],
        },
      },
      { now: nowIso },
    );

    nextState.compounds.push(newCompound);
    compoundsCreated++;
    legacyKeyToCompoundId.set(lookupKey, newCompound.id);
    return newCompound.id;
  };

  // Step 4 & 5a: Extract & map vials -> compounds + ownership
  const incomingOwnership = [];
  for (const v of vials) {
    const totalMg = parseFiniteNumber(v.vialMg ?? v.mgPerVial ?? v.totalMg);
    const rawVialIU = parseFiniteNumber(v.vialIU ?? v.iuPerVial);
    const effectiveVialUnit = resolveVialUnit(v);

    const totalMcg =
      parseFiniteNumber(v.totalMcg) > 0 ? parseFiniteNumber(v.totalMcg) : totalMg > 0 ? totalMg * 1000 : NaN;
    const vialMl = parseFiniteNumber(v.vialMl ?? v.diluentMl ?? v.waterMl);
    const oilConc =
      v.oil && parseFiniteNumber(v.concentrationMgPerMl) > 0
        ? parseFiniteNumber(v.concentrationMgPerMl)
        : v.oil && totalMg > 0 && vialMl > 0
          ? totalMg / vialMl
          : NaN;

    const inferredRoute =
      v.route ||
      (v.oil === true ? 'IM' : getUnambiguousProtocolRoute(v.peptideId, v.peptideName || v.peptide) || 'SubQ');

    const compoundId = ensureCompound({
      peptideId: v.peptideId,
      name: v.peptideName || v.peptide || v.penName || v.peptideId,
      route: inferredRoute,
      oil: v.oil === true,
      oilConcentrationMgPerMl: oilConc,
      vialMg: totalMg,
      vialIU: rawVialIU,
      diluentMl: vialMl,
      solvent: v.solvent,
      doseUnit: effectiveVialUnit,
      isPen: v.isPen === true,
      isBlend: Array.isArray(v.penComponents) && v.penComponents.length >= 2,
      penName: v.penName,
      penComponents: v.penComponents,
      vialId: v.id,
    });
    if (v.id != null) {
      vialIdToCompoundId.set(String(v.id), compoundId);
    }

    const remMcg = parseFiniteNumber(v.remainingMcg);
    const refDose =
      parseFiniteNumber(v.doseMcg) > 0 ? parseFiniteNumber(v.doseMcg) : doseByPeptide.get(String(v.peptideId || '')) || NaN;
    let remainingDoses = null;
    if (parseFiniteNumber(v.remainingDoses) >= 0) {
      remainingDoses = Math.floor(parseFiniteNumber(v.remainingDoses) + 1e-9);
    } else if (remMcg >= 0 && refDose > 0) {
      remainingDoses = Math.floor(remMcg / refDose + 1e-9);
    }

    const rawQty = parseFiniteNumber(v.vialCount ?? v.quantity);
    const quantity = Number.isFinite(rawQty) && rawQty >= 0 ? rawQty : 1;

    let status = 'have';
    if (
      v.active === false ||
      (Number.isFinite(rawQty) && rawQty <= 0) ||
      (Number.isFinite(remMcg) && remMcg <= 0) ||
      remainingDoses === 0
    ) {
      status = 'dont_have';
    } else if (remainingDoses != null && remainingDoses <= LOW_STOCK_DOSE_THRESHOLD) {
      status = 'low_stock';
    }

    let scope = 'household';
    if (v.inventoryProfile) {
      scope = `member:${resolveMemberId(v.inventoryProfile)}`;
    } else if (options.ownershipScope === 'member') {
      scope = `member:${defaultMemberId}`;
    }

    const reconstitution = {};
    if (Number.isFinite(totalMg) && totalMg > 0) reconstitution.vialMg = totalMg;
    if (Number.isFinite(rawVialIU) && rawVialIU > 0) reconstitution.vialIU = rawVialIU;
    if (Number.isFinite(vialMl) && vialMl > 0) reconstitution.diluentMl = vialMl;
    reconstitution.solvent = v.solvent || getPreferredSolvent(v.peptideId || v.peptideName);
    if (parseFiniteNumber(v.mcgPerMl) > 0) reconstitution.mcgPerMl = parseFiniteNumber(v.mcgPerMl);
    if (parseFiniteNumber(v.mcgPerUnit) > 0) reconstitution.mcgPerUnit = parseFiniteNumber(v.mcgPerUnit);
    if (parseFiniteNumber(v.unitsPerDose) > 0) reconstitution.unitsPerDose = parseFiniteNumber(v.unitsPerDose);
    if (Number.isFinite(totalMcg) && totalMcg > 0) reconstitution.totalMcg = totalMcg;
    if (Number.isFinite(remMcg) && remMcg >= 0) reconstitution.remainingMcg = remMcg;
    if (v.oil === true) {
      reconstitution.oilPreMixed = true;
      if (Number.isFinite(oilConc) && oilConc > 0) reconstitution.oilConcentrationMgPerMl = oilConc;
    }
    if (v.isPen) {
      reconstitution.isPen = true;
      if (v.penColor) reconstitution.penColor = v.penColor;
      if (v.penName) reconstitution.penName = v.penName;
      if (Array.isArray(v.penComponents)) reconstitution.penComponents = deepClone(v.penComponents);
    }

    incomingOwnership.push({
      id: `pos_vial_${v.id}`,
      compoundId,
      scope,
      status,
      quantity,
      unit: v.isPen ? 'pen' : 'vial',
      ...(v.vendor ? { vendor: String(v.vendor) } : {}),
      ...(v.expiryDate ? { expiryDate: String(v.expiryDate).slice(0, 10) } : {}),
      ...(v.openedAt || v.reconstitutedAt ? { openedAt: String(v.openedAt || v.reconstitutedAt).slice(0, 10) } : {}),
      remainingDoses,
      reconstitution,
      ...(v.notes ? { notes: String(v.notes) } : {}),
      updatedAt: typeof v.updatedAt === 'string' && v.updatedAt ? v.updatedAt : nowIso,
    });
  }

  // Step 5b: Legacy storage[] records
  for (const s of storageList) {
    const sMg = parseFiniteNumber(s.vialMg ?? s.mgPerVial ?? s.totalMg);
    const sOil =
      s.oil === true ||
      oilPeptides.has(normName(s.peptideId || '')) ||
      oilPeptides.has(normName(s.peptideName || s.peptide || ''));
    const sRoute =
      s.route ||
      (sOil ? 'IM' : getUnambiguousProtocolRoute(s.peptideId, s.peptideName || s.peptide) || 'SubQ');

    const compoundId = ensureCompound({
      peptideId: s.peptideId,
      name: s.peptideName || s.peptide || s.peptideId,
      route: sRoute,
      vialMg: sMg,
      oil: sOil,
    });
    const qty = parseFiniteNumber(s.vialCount ?? s.quantity);
    incomingOwnership.push({
      id: `pos_storage_${s.id}`,
      compoundId,
      scope: s.inventoryProfile ? `member:${resolveMemberId(s.inventoryProfile)}` : 'household',
      status: Number.isFinite(qty) && qty <= 0 ? 'dont_have' : 'have',
      quantity: Number.isFinite(qty) ? qty : 1,
      unit: 'vial',
      ...(s.vendor ? { vendor: String(s.vendor) } : {}),
      ...(Number.isFinite(sMg) && sMg > 0 ? { reconstitution: { vialMg: sMg } } : {}),
      ...(s.notes ? { notes: String(s.notes) } : {}),
      updatedAt: typeof s.updatedAt === 'string' && s.updatedAt ? s.updatedAt : nowIso,
    });
  }

  nextState.ownership = upsertById(nextState.ownership, incomingOwnership);
  ownershipUpserted = incomingOwnership.length;

  // Step 6: Protocols -> per-member stacks & stack items (preserving timelines, cycles, IU/mg/g units)
  const itemsByMember = new Map();
  const protocolCompoundMap = new Map();
  const protocolUnitMap = new Map();

  for (const p of protocols) {
    const memberId = resolveMemberId(p.profile || (!options.targetMemberId ? check.activeProfile : null));

    const linkedVialId = p.penVialId ?? p.blendVialId ?? p.vialId ?? null;
    const linkedVial = linkedVialId != null ? vialsById.get(String(linkedVialId)) || null : null;

    const inheritedUnit =
      normalizeUnit(p.doseUnit) ||
      resolveVialUnit(linkedVial) ||
      getUnambiguousIuVialUnit(p.peptideId, p.peptideName || p.peptide) ||
      null;

    const pNormId = normName(p.peptideId || '');
    const pNormName = normName(p.peptideName || p.peptide || '');
    const inheritedOil =
      p.oil === true ||
      linkedVial?.oil === true ||
      (!p.route && (oilPeptides.has(pNormId) || oilPeptides.has(pNormName)));
    const resolvedRoute = normalizeRoute(p.route) || (inheritedOil ? 'IM' : 'SubQ');

    const linkedPenComps =
      Array.isArray(p.penComponents) && p.penComponents.length > 0
        ? p.penComponents
        : Array.isArray(linkedVial?.penComponents) && linkedVial.penComponents.length > 0
          ? linkedVial.penComponents
          : undefined;
    const isPenOrBlend =
      p.peptideId === '__pen__' ||
      p.isPen === true ||
      p.isBlend === true ||
      linkedVial?.isPen === true ||
      Boolean(p.blendVialId) ||
      (Array.isArray(linkedPenComps) && linkedPenComps.length >= 2);

    const linkedVialMg = linkedVial
      ? parseFiniteNumber(linkedVial.vialMg ?? linkedVial.mgPerVial ?? linkedVial.totalMg)
      : NaN;
    const linkedVialIU = linkedVial
      ? parseFiniteNumber(linkedVial.vialIU ?? linkedVial.iuPerVial)
      : NaN;
    const linkedDiluentMl = linkedVial
      ? parseFiniteNumber(linkedVial.vialMl ?? linkedVial.diluentMl ?? linkedVial.waterMl)
      : NaN;
    const linkedOilConc =
      inheritedOil && linkedVial
        ? parseFiniteNumber(linkedVial.concentrationMgPerMl) > 0
          ? parseFiniteNumber(linkedVial.concentrationMgPerMl)
          : linkedVialMg > 0 && linkedDiluentMl > 0
            ? linkedVialMg / linkedDiluentMl
            : NaN
        : NaN;

    const compoundId = ensureCompound({
      peptideId: p.peptideId,
      name: p.peptideName || p.peptide || linkedVial?.peptideName || p.peptideId,
      route: resolvedRoute,
      oil: inheritedOil,
      oilConcentrationMgPerMl: linkedOilConc,
      vialMg: linkedVialMg,
      vialIU: linkedVialIU,
      diluentMl: linkedDiluentMl,
      kind: p.kind,
      category: p.category,
      doseMcg: p.doseMcg,
      doseUnit: inheritedUnit,
      doseValue: p.doseValue,
      doseAmount: p.doseAmount,
      cycleDays: p.cycleDays,
      ingredients: p.ingredients,
      timeOfDay: p.schedule?.timeOfDay,
      isPen: p.peptideId === '__pen__' || p.isPen === true || linkedVial?.isPen === true,
      isBlend: isPenOrBlend,
      penName: p.penName || linkedVial?.penName || null,
      penComponents: linkedPenComps,
      vialId: linkedVial?.id ?? (p.penVialId ?? p.blendVialId ?? null),
      linkedVialId: linkedVial ? linkedVial.id : null,
      protocolId: p.id,
    });
    protocolCompoundMap.set(String(p.id), compoundId);

    let effectiveProtoUnit = inheritedUnit;
    if (!effectiveProtoUnit && compoundId) {
      const matchedComp = nextState.compounds.find((c) => c && c.id === compoundId);
      if (matchedComp?.dosages?.defaultUnit === 'IU') {
        effectiveProtoUnit = 'IU';
      }
    }
    const canon = canonicalizeDose(effectiveProtoUnit ? { ...p, doseUnit: effectiveProtoUnit } : p);

    const sched = p.schedule && typeof p.schedule === 'object' ? p.schedule : {};
    const every = parseFiniteNumber(sched.every);
    const normalizedSched = {
      daysOfWeek: Array.isArray(sched.days) ? [...sched.days] : [0, 1, 2, 3, 4, 5, 6],
      days: Array.isArray(sched.days) ? [...sched.days] : [0, 1, 2, 3, 4, 5, 6],
      ...(Number.isFinite(every) && every > 1 ? { every: Math.round(every), everyNDays: Math.round(every) } : {}),
      ...(sched.anchor ? { anchor: sched.anchor, anchorDate: sched.anchor } : {}),
      prn: Array.isArray(sched.days) && sched.days.length === 0 && !(every > 1),
      ...(sched.timeOfDay ? { timeOfDay: sched.timeOfDay } : {}),
    };

    const customUnit = canon?.doseUnit || effectiveProtoUnit || 'mcg';
    const customDose = parseFiniteNumber(canon?.doseValue ?? canon?.doseAmount);
    const resolvedDoseMcg = parseFiniteNumber(canon?.doseMcg ?? p.doseMcg);
    protocolUnitMap.set(String(p.id), customUnit);

    const stackItem = {
      id: `pos_item_${p.id}`,
      compoundId,
      active: p.active !== false,
      doseAmount: Number.isFinite(customDose) ? customDose : null,
      customDose: Number.isFinite(customDose) ? customDose : null,
      doseUnit: customUnit,
      customUnit,
      doseMcg: customUnit === 'IU' ? null : resolvedDoseMcg > 0 ? resolvedDoseMcg : null,
      route: resolvedRoute,
      customRoute: resolvedRoute,
      startDate: p.startDate || null,
      endDate: p.endDate || null,
      cycleDays: Number.isInteger(p.cycleDays) && p.cycleDays > 0 ? p.cycleDays : null,
      schedule: normalizedSched,
      pinnedSlot: mapLegacyTimeOfDayToSlot(sched.timeOfDay),
      timeline: Array.isArray(p.timeline) ? deepClone(p.timeline) : [],
      notes: typeof p.notes === 'string' ? p.notes : '',
      legacyProtocolId: String(p.id),
      legacyProfile: p.profile || null,
    };

    if (!itemsByMember.has(memberId)) itemsByMember.set(memberId, []);
    itemsByMember.get(memberId).push(stackItem);
    stackItemsUpserted++;
  }

  let stacksUpdated = 0;
  for (const [memberId, incomingItems] of itemsByMember.entries()) {
    const stackId = `pos_stack_${memberId}`;
    const existingStack = nextState.stacks.find((s) => s && s.id === stackId);
    if (existingStack) {
      existingStack.items = upsertById(existingStack.items || [], incomingItems);
      existingStack.updatedAt = nowIso;
    } else {
      nextState.stacks.push({
        id: stackId,
        memberId,
        name: options.stackName || 'Imported Protocol OS Stack',
        description: 'Imported from protocol-os-export/v1.',
        active: true,
        onlyOwned: false,
        items: incomingItems,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
    stacksUpdated++;
  }

  // Step 7: Logs mapping (preserving skipped, backfilled, needsReview, IU/mg/g units, and top-level profile)
  const incomingLogs = [];
  for (const l of logs) {
    const ownerProfile =
      l.profile ||
      protocolOwnerMap.get(String(l.protocolId)) ||
      (!options.targetMemberId ? check.activeProfile : null) ||
      null;
    const memberId = resolveMemberId(ownerProfile);

    const linkedLogVial = l.vialId != null ? vialsById.get(String(l.vialId)) || null : null;
    const logProtoUnit = l.protocolId != null ? protocolUnitMap.get(String(l.protocolId)) || null : null;
    const initialLogUnit =
      normalizeUnit(l.doseUnit) ||
      logProtoUnit ||
      resolveVialUnit(linkedLogVial) ||
      getUnambiguousIuVialUnit(l.peptideId, l.peptide || l.peptideName) ||
      null;

    const linkedCid =
      (l.protocolId != null ? protocolCompoundMap.get(String(l.protocolId)) : null) ||
      (l.vialId != null ? vialIdToCompoundId.get(String(l.vialId)) : null) ||
      ensureCompound({
        peptideId: l.peptideId,
        name: l.peptide || l.peptideName || l.peptideId,
        route: l.route,
        doseMcg: l.doseMcg,
        doseUnit: initialLogUnit,
        doseValue: l.doseValue,
        doseAmount: l.doseAmount,
      });

    let inheritedLogUnit = initialLogUnit;
    if (!inheritedLogUnit && linkedCid) {
      const matchedComp = nextState.compounds.find((c) => c && c.id === linkedCid);
      if (matchedComp?.dosages?.defaultUnit === 'IU') {
        inheritedLogUnit = 'IU';
      }
    }

    const canon = canonicalizeDose(inheritedLogUnit ? { ...l, doseUnit: inheritedLogUnit } : l);
    const normU = inheritedLogUnit || canon?.doseUnit || 'mcg';
    const isIU = normU === 'IU';
    const rawDoseMcg = parseFiniteNumber(canon?.doseMcg ?? l.doseMcg);
    const doseValue = isIU
      ? parseFiniteNumber(canon?.doseValue ?? l.doseValue ?? l.doseAmount ?? l.doseMcg)
      : parseFiniteNumber(canon?.doseValue ?? l.doseValue ?? l.doseAmount);

    incomingLogs.push({
      id: `pos_log_${l.id}`,
      memberId,
      stackId: `pos_stack_${memberId}`,
      compoundId: linkedCid,
      compoundName: l.peptide || l.peptideName || linkedCid,
      datetime: l.datetime,
      doseMcg: isIU ? null : Number.isFinite(rawDoseMcg) ? rawDoseMcg : null,
      doseValue: Number.isFinite(doseValue) ? doseValue : 0,
      doseAmount: Number.isFinite(doseValue) ? doseValue : 0,
      doseUnit: normU,
      ...(parseFiniteNumber(l.doseMl) >= 0 ? { doseMl: parseFiniteNumber(l.doseMl) } : {}),
      route: normalizeRoute(l.route) || l.route || null,
      ...(l.site ? { site: String(l.site) } : {}),
      ...(l.vialId != null ? { vialId: `pos_vial_${l.vialId}` } : {}),
      skipped: l.skipped === true,
      backfilled: l.backfilled === true,
      needsReview: l.needsReview === true,
      ...(l.notes ? { notes: String(l.notes) } : {}),
      legacyLogId: String(l.id),
      updatedAt: typeof l.updatedAt === 'string' && l.updatedAt ? l.updatedAt : nowIso,
    });
  }

  nextState.logs = upsertById(nextState.logs, incomingLogs);
  logsUpserted = incomingLogs.length;

  // Step 8: Meta & Audit Trail
  const legacyMigrations = Array.isArray(check.meta?.migrations)
    ? check.meta.migrations.map((m) => (String(m).startsWith('protocol-os:') ? String(m) : `protocol-os:${m}`))
    : [];
  nextState.meta.migrations = [...new Set([...nextState.meta.migrations, ...legacyMigrations])];

  nextState.auditLog = upsertById(nextState.auditLog, [
    {
      id: `pos_import_${nowIso}`,
      timestamp: nowIso,
      updatedAt: nowIso,
      actor: 'import:protocol-os',
      action: 'import_protocol_os',
      summary: `Imported Protocol OS export: ${compoundsCreated} created, ${compoundsMatched} matched, ${ownershipUpserted} ownership, ${stackItemsUpserted} stack items, ${logsUpserted} logs.`,
    },
  ]);

  return {
    ok: true,
    state: nextState,
    summary: {
      compoundsCreated,
      compoundsMatched,
      ownershipUpserted,
      stacksUpdated,
      stackItemsUpserted,
      logsUpserted,
      skipped: check.skipped,
    },
    warnings,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// 5. Formula-Safe CSV Serializers (F43)
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV cell escaping with spreadsheet formula-injection neutralization.
 * Prefixes cells starting with `=`, `+`, `-`, `@`, `\t`, `\r` (or leading
 * whitespace/control chars followed by `=`, `+`, `-`, `@`) with a single quote `'`.
 */
const CSV_LEADING_INVISIBLE_FORMULA_RE = /^[\s\p{Cc}\p{Cf}\u034f\u115f\u1160\u180e\u3164\uffa0]+[=+\-@]/u;

export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const s = String(value);
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  }
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) || CSV_LEADING_INVISIBLE_FORMULA_RE.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportCompoundsCsv(state, options = {}) {
  const { sectionId = null, memberId = null, ownershipStatus = null } = options || {};
  const src = state && typeof state === 'object' ? state : {};
  const compounds = Array.isArray(src.compounds) ? src.compounds : [];
  const ownership = Array.isArray(src.ownership) ? src.ownership : [];
  const sectionsById = new Map(
    (Array.isArray(src.sections) ? src.sections : [])
      .filter((s) => s && typeof s === 'object' && s.id != null)
      .map((s) => [s.id, s.name]),
  );

  const headers = [
    'ID',
    'Name',
    'Section ID',
    'Section',
    'Subsection',
    'Route',
    'Ownership Status',
    'Ownership Scope',
    'Default Dose',
    'Unit',
    'Frequency',
    'Half-Life',
    'Cycle Pattern',
    'Timing Slots',
    'Evidence Tier',
    'Profile Status',
    'Summary',
    'Mechanism of Action',
    'Do Not Pair With',
    'Synergies',
    'Monitoring Labs',
    'Notes',
  ];

  const rows = [headers.map(escapeCsvCell).join(',')];

  for (const c of compounds) {
    if (!c || typeof c !== 'object') continue;
    if (sectionId && c.sectionId !== sectionId) continue;

    const effOwn = resolveEffectiveOwnership(c.id, memberId, ownership);
    if (ownershipStatus && effOwn.status !== ownershipStatus) continue;

    const doNotPairStr = Array.isArray(c.doNotPairWith)
      ? c.doNotPairWith
          .filter((r) => r && typeof r === 'object')
          .map((r) => `${r.targetRef || ''} (${r.severity || ''})`)
          .join('; ')
      : '';
    const synStr = Array.isArray(c.synergies)
      ? c.synergies
          .filter((s) => s && typeof s === 'object')
          .map((s) => s.targetRef || '')
          .join('; ')
      : '';

    const cells = [
      c.id,
      redactSensitiveText(c.name || ''),
      redactSensitiveText(c.sectionId || ''),
      redactSensitiveText(sectionsById.get(c.sectionId) || c.sectionId || ''),
      redactSensitiveText(c.subsection || ''),
      redactSensitiveText(c.dosages?.route || ''),
      effOwn.status,
      effOwn.scope,
      c.dosages?.defaultAmount ?? '',
      redactSensitiveText(c.dosages?.defaultUnit || ''),
      redactSensitiveText(c.dosages?.frequencyText || ''),
      redactSensitiveText(c.halfLife?.displayText || (c.halfLife?.valueHours ? `${c.halfLife.valueHours}h` : '')),
      redactSensitiveText(c.cycles?.patternText || (c.cycles?.continuous ? 'Continuous' : '')),
      Array.isArray(c.timingRules?.preferredSlots)
        ? redactSensitiveText(c.timingRules.preferredSlots.join('; '))
        : '',
      c.provenance?.evidenceTier || '',
      c.profileStatus || '',
      redactSensitiveText(c.summary || ''),
      redactSensitiveText(c.mechanismOfAction || ''),
      redactSensitiveText(doNotPairStr),
      redactSensitiveText(synStr),
      Array.isArray(c.monitoringLabs) ? redactSensitiveText(c.monitoringLabs.join('; ')) : '',
      redactSensitiveText(c.notes || ''),
    ];

    rows.push(cells.map(escapeCsvCell).join(','));
  }

  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function exportLogsCsv(state, options = {}) {
  const { memberId = null, includeSkipped = true } = options || {};
  const src = state && typeof state === 'object' ? state : {};
  const logs = Array.isArray(src.logs) ? src.logs : [];

  const headers = [
    'Log ID',
    'Member ID',
    'Datetime',
    'Compound',
    'Dose',
    'Unit',
    'Volume (mL)',
    'Route',
    'Site',
    'Status',
    'Notes',
  ];

  const rows = [headers.map(escapeCsvCell).join(',')];

  for (const l of logs) {
    if (!l || typeof l !== 'object') continue;
    if (memberId && l.memberId !== memberId) continue;
    if (!includeSkipped && l.skipped === true) continue;

    const status = l.skipped ? 'skipped' : l.needsReview ? 'needs_review' : 'taken';
    const cells = [
      l.id || '',
      l.memberId || '',
      l.datetime || '',
      redactSensitiveText(l.compoundName || l.compoundId || ''),
      l.doseAmount ?? l.doseValue ?? l.doseMcg ?? '',
      redactSensitiveText(l.doseUnit || ''),
      l.doseMl ?? '',
      redactSensitiveText(l.route || ''),
      redactSensitiveText(l.site || ''),
      status,
      redactSensitiveText(l.notes || ''),
    ];
    rows.push(cells.map(escapeCsvCell).join(','));
  }

  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// 6. Token-Efficient, Secret-Free AI Context Bundle Builder (F28)
// ---------------------------------------------------------------------------

export function buildContextBundle(state, options = {}) {
  const {
    format = 'md',
    memberId = null,
    sectionIds = null,
    ownershipStatuses = null,
    includeDontHave = true,
    includeFullProfiles = false,
    includeLogs = false,
    maxEstimatedTokens = DEFAULT_CONTEXT_MAX_TOKENS,
    generatedAt = new Date().toISOString(),
  } = options || {};

  const src = state && typeof state === 'object' ? state : {};
  const secFilter = Array.isArray(sectionIds) && sectionIds.length > 0 ? new Set(sectionIds) : null;
  const ownStatusFilter =
    Array.isArray(ownershipStatuses) && ownershipStatuses.length > 0 ? new Set(ownershipStatuses) : null;

  // 1. Allowlist projection
  const allMembers = (Array.isArray(src.members) ? src.members : []).filter((m) => m && typeof m === 'object');
  const members = memberId ? allMembers.filter((m) => m.id === memberId) : allMembers;

  const allSections = (Array.isArray(src.sections) ? src.sections : []).filter((s) => s && typeof s === 'object');
  const sections = secFilter ? allSections.filter((s) => secFilter.has(s.id)) : allSections;

  const allStacks = (Array.isArray(src.stacks) ? src.stacks : []).filter((st) => st && typeof st === 'object');
  const stacks = memberId ? allStacks.filter((s) => s.memberId === memberId) : allStacks;

  const allOwnership = Array.isArray(src.ownership) ? src.ownership : [];
  const ownership = memberId
    ? allOwnership.filter((o) => o && (o.scope === 'household' || o.scope === `member:${memberId}`))
    : allOwnership;

  // Track active stack compound IDs so they are NEVER dropped by ownership filter
  const activeStackCompoundIds = new Set();
  for (const st of stacks) {
    if (st && st.active !== false && Array.isArray(st.items)) {
      for (const it of st.items) {
        if (it && it.active !== false && it.compoundId) {
          activeStackCompoundIds.add(it.compoundId);
        }
      }
    }
  }

  const allCompounds = Array.isArray(src.compounds) ? src.compounds : [];
  const projectedCompounds = [];
  for (const c of allCompounds) {
    if (!c || typeof c !== 'object') continue;
    if (secFilter && !secFilter.has(c.sectionId)) continue;

    const effOwn = resolveEffectiveOwnership(c.id, memberId, ownership);
    const inActiveStack = activeStackCompoundIds.has(c.id);

    const allowedByOwnership =
      ownStatusFilter
        ? ownStatusFilter.has(effOwn.status)
        : includeDontHave || effOwn.status !== 'dont_have';

    if (!allowedByOwnership && !inActiveStack) continue;

    const missingFromStock = inActiveStack && (effOwn.status === 'dont_have' || effOwn.status === 'wishlist');

    projectedCompounds.push({
      id: c.id,
      name: c.name,
      aliases: c.aliases || [],
      sectionId: c.sectionId,
      subsection: c.subsection || '',
      canonicalMolecule: c.canonicalMolecule || null,
      relatedCompoundIds: c.relatedCompoundIds || [],
      ownershipStatus: effOwn.status,
      ownershipScope: effOwn.scope,
      missingFromStock,
      profileStatus: c.profileStatus || 'ai_draft',
      evidenceTier: c.provenance?.evidenceTier || 'working_hypothesis',
      summary: c.summary || '',
      dosages: c.dosages || {},
      timingRules: c.timingRules || {},
      halfLife: c.halfLife || {},
      cycles: c.cycles || {},
      doNotPairWith: c.doNotPairWith || [],
      synergies: c.synergies || [],
      ...(includeFullProfiles
        ? {
            detailedDescription: c.detailedDescription || '',
            mechanismOfAction: c.mechanismOfAction || '',
            useCaseScenarios: c.useCaseScenarios || [],
            contraindications: c.contraindications || [],
            sideEffects: c.sideEffects || [],
            monitoringLabs: c.monitoringLabs || [],
            storageNotes: c.storageNotes || '',
            sectionData: c.sectionData || {},
            customFields: c.customFields || {},
            notes: c.notes || '',
          }
        : {}),
    });
  }

  const projectedLogs = includeLogs
    ? (Array.isArray(src.logs) ? src.logs : [])
        .filter((l) => l && (!memberId || l.memberId === memberId))
        .slice(-50)
        .map((l) => ({
          id: l.id,
          memberId: l.memberId,
          compoundId: l.compoundId,
          datetime: l.datetime,
          doseAmount: l.doseAmount ?? l.doseValue ?? l.doseMcg ?? null,
          doseUnit: l.doseUnit || '',
          route: l.route || null,
          skipped: Boolean(l.skipped),
          notes: l.notes || '',
        }))
    : [];

  // 2 & 3. Secret stripping + deep text redaction
  const rawBundleData = {
    generatedAt,
    disclaimer: 'Personal health reference hub — informational only, not medical advice.',
    householdName: src.settings?.householdName || 'Home Pharmacy',
    filter: {
      memberId: memberId || null,
      sectionIds: secFilter ? [...secFilter] : null,
      ownershipStatuses: ownStatusFilter ? [...ownStatusFilter] : null,
      includeDontHave,
      includeFullProfiles,
    },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      routineAnchors: m.routineAnchors || {},
      safetyContext: m.safetyContext || {},
    })),
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      subsections: s.subsections || [],
      customFields: s.customFields || [],
      aiResearchPrompt: s.aiResearchPrompt || '',
    })),
    stacks: stacks.map((st) => ({
      id: st.id,
      memberId: st.memberId,
      name: st.name,
      active: st.active !== false,
      items: Array.isArray(st.items) ? st.items.filter((it) => it && typeof it === 'object') : [],
    })),
    compounds: projectedCompounds,
    ...(includeLogs ? { recentLogs: projectedLogs } : {}),
  };

  const data = redactStringsDeep(stripSecrets(rawBundleData));
  const compoundsById = new Map(data.compounds.map((c) => [c.id, c]));

  let content;
  if (format === 'json') {
    content = JSON.stringify(data, null, 2);
  } else {
    const lines = [];
    lines.push(`# ${data.householdName} — AI Context Bundle`);
    lines.push(`> Generated: ${data.generatedAt} | ${data.disclaimer}`);
    lines.push('');

    lines.push('## Members & Safety Context');
    if (data.members.length === 0) {
      lines.push('- (none)');
    } else {
      for (const m of data.members) {
        const sc = m.safetyContext || {};
        const a = m.routineAnchors || {};
        lines.push(
          `- **${m.name}** (\`${m.id}\`): sex=${sc.biologicalSexContext || 'unspecified'}, pregnancyOrTrying=${Boolean(sc.pregnancyOrTrying)}, allergies=[${(sc.allergies || []).join(', ')}], rxMeds=[${(sc.activeRxMeds || []).join(', ')}], anchors=wake ${a.wake || '?'}/workout ${a.workout || '?'}/bed ${a.bed || '?'} (${a.tz || 'UTC'})`,
        );
      }
    }
    lines.push('');

    lines.push('## Active Stacks');
    if (data.stacks.length === 0) {
      lines.push('- (none)');
    } else {
      for (const st of data.stacks) {
        lines.push(`### ${st.name} (member: \`${st.memberId}\`, active: ${st.active})`);
        if (!st.items || st.items.length === 0) {
          lines.push('- (no items)');
        } else {
          for (const it of st.items) {
            const c = compoundsById.get(it.compoundId);
            const cName = c?.name || it.compoundId;
            const doseStr = it.doseAmount != null ? `${it.doseAmount} ${it.doseUnit || ''}`.trim() : c?.dosages?.rangeText || 'default';
            const stockTag = c?.missingFromStock ? ' [missing from stock]' : c ? ` [${c.ownershipStatus}]` : '';
            lines.push(`- ${cName} (\`${it.compoundId}\`): ${doseStr} via ${it.route || c?.dosages?.route || '?'}${stockTag}`);
          }
        }
      }
    }
    lines.push('');

    lines.push('## Sections & Custom Schema');
    for (const s of data.sections) {
      const cfList = (Array.isArray(s.customFields) ? s.customFields : [])
        .filter((f) => f && typeof f === 'object')
        .map((f) => `${f.key}:${f.fieldType}${f.required ? '*' : ''}`)
        .join(', ');
      const subList = Array.isArray(s.subsections) ? s.subsections.join(', ') : '';
      lines.push(`- **${s.name}** (\`${s.id}\`) | subsections: ${subList || 'none'} | customFields: ${cfList || 'none'}`);
      if (s.aiResearchPrompt) {
        lines.push(`  - Research Prompt: ${s.aiResearchPrompt}`);
      }
    }
    lines.push('');

    lines.push('## Compounds');
    if (data.compounds.length === 0) {
      lines.push('- (none)');
    } else {
      const grouped = new Map();
      for (const c of data.compounds) {
        if (!grouped.has(c.sectionId)) grouped.set(c.sectionId, []);
        grouped.get(c.sectionId).push(c);
      }
      for (const [secId, list] of grouped.entries()) {
        lines.push(`### Section: ${secId}`);
        for (const c of list) {
          const stockTag = c.missingFromStock ? ' [missing from stock]' : ` [${c.ownershipStatus}]`;
          const slots = Array.isArray(c.timingRules?.preferredSlots) ? c.timingRules.preferredSlots.join('/') : '';
          const hl = c.halfLife?.displayText || (c.halfLife?.valueHours ? `${c.halfLife.valueHours}h` : 'unmodeled');
          const dnp = (Array.isArray(c.doNotPairWith) ? c.doNotPairWith : [])
            .filter((r) => r && typeof r === 'object')
            .map((r) => `${r.targetRef}:${r.severity}`)
            .join(', ');
          lines.push(
            `- **${c.name}** (\`${c.id}\`)${stockTag} — ${c.dosages?.route || '?'} ${c.dosages?.defaultAmount ?? ''} ${c.dosages?.defaultUnit || ''} | slots: ${slots || 'any'} | t1/2: ${hl}${dnp ? ` | avoid: ${dnp}` : ''}`,
          );
          if (c.summary) lines.push(`  - What it is: ${c.summary}`);
          if (includeFullProfiles) {
            if (c.mechanismOfAction) lines.push(`  - MoA: ${c.mechanismOfAction}`);
            if (Array.isArray(c.useCaseScenarios) && c.useCaseScenarios.length > 0) {
              lines.push(`  - Use cases: ${c.useCaseScenarios.join('; ')}`);
            }
            if (Array.isArray(c.contraindications) && c.contraindications.length > 0) {
              lines.push(`  - Contraindications: ${c.contraindications.join('; ')}`);
            }
            if (c.sectionData && Object.keys(c.sectionData).length > 0) {
              lines.push(`  - Section data: ${JSON.stringify(c.sectionData)}`);
            }
            if (c.customFields && Object.keys(c.customFields).length > 0) {
              lines.push(`  - Custom fields: ${JSON.stringify(c.customFields)}`);
            }
            if (c.notes) {
              lines.push(`  - Notes: ${c.notes}`);
            }
          }
        }
      }
    }

    if (includeLogs) {
      lines.push('');
      lines.push('## Recent Logs');
      const logsArr = Array.isArray(data.recentLogs) ? data.recentLogs : [];
      if (logsArr.length === 0) {
        lines.push('- (none)');
      } else {
        for (const l of logsArr) {
          const c = compoundsById.get(l.compoundId);
          const cLabel = c?.name || l.compoundId || 'unknown';
          const dosePart = l.doseAmount != null ? `${l.doseAmount} ${l.doseUnit || ''}`.trim() : '—';
          const statusPart = l.skipped ? ' [skipped]' : '';
          const notesPart = l.notes ? ` — ${l.notes}` : '';
          lines.push(
            `- ${l.datetime || '?'} | \`${l.memberId || '?'}\` | ${cLabel}: ${dosePart}${l.route ? ` (${l.route})` : ''}${statusPart}${notesPart}`,
          );
        }
      }
    }

    content = lines.join('\n');
  }

  const estimatedChars = content.length;
  const estimatedTokens = Math.ceil(estimatedChars / 4);
  const exceedsTokenBudget = Number.isFinite(maxEstimatedTokens) && maxEstimatedTokens > 0 && estimatedTokens > maxEstimatedTokens;
  const warnings = [];
  if (exceedsTokenBudget) {
    warnings.push(
      `Estimated context size (${estimatedTokens} tokens) exceeds configured budget (${maxEstimatedTokens} tokens). Consider filtering by memberId, sectionIds, or disabling includeFullProfiles.`,
    );
  }

  return {
    format: format === 'json' ? 'json' : 'md',
    content,
    data,
    stats: {
      memberCount: data.members.length,
      sectionCount: data.sections.length,
      compoundCount: data.compounds.length,
      stackCount: data.stacks.length,
      estimatedChars,
      estimatedTokens,
      exceedsTokenBudget,
    },
    warnings,
  };
}
