/**
 * Offline-First State Cache, Theme Persistence & Salted SHA-256 Device PIN Lock
 * with 5-Attempt 30-Second Lockout (F4, F41).
 */

const CACHE_KEY = 'hp_offline_cache_v1';
const THEME_KEY = 'hp_theme_v1';
const PIN_CONFIG_KEY = 'hp_device_pin_v1';
const PIN_STATE_KEY = 'hp_device_pin_lock_state_v1';

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  return 'dark';
}

export function saveTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  try {
    window.localStorage.setItem(THEME_KEY, t);
  } catch {
    // ignore
  }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f3f1ea' : '#0c221b');
  }
  return t;
}

export function loadCachedHub() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveCachedHub(snapshot) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
    return { ok: true };
  } catch (err) {
    // Graceful QuotaExceededError handling (F41)
    return { ok: false, quotaExceeded: err?.name === 'QuotaExceededError' };
  }
}

// ---------------------------------------------------------------------------
// Device PIN Lock (Salted SHA-256 + 5-Fail 30s Lockout)
// ---------------------------------------------------------------------------

export function getPinConfig() {
  try {
    const raw = window.localStorage.getItem(PIN_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getPinLockState() {
  try {
    const raw = window.localStorage.getItem(PIN_STATE_KEY);
    return raw ? JSON.parse(raw) : { failedAttempts: 0, lockedUntil: 0 };
  } catch {
    return { failedAttempts: 0, lockedUntil: 0 };
  }
}

function savePinLockState(st) {
  try {
    window.localStorage.setItem(PIN_STATE_KEY, JSON.stringify(st));
  } catch {
    // ignore
  }
}

export async function configureDevicePin(pin) {
  const clean = String(pin || '').trim();
  if (clean.length < 4) {
    throw new Error('PIN must be at least 4 characters.');
  }
  const salt = randomSalt();
  const hash = await sha256Hex(`${salt}:${clean}`);
  const cfg = { enabled: true, salt, hash, updatedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(PIN_CONFIG_KEY, JSON.stringify(cfg));
    savePinLockState({ failedAttempts: 0, lockedUntil: 0 });
  } catch {
    // ignore
  }
  return cfg;
}

export function disableDevicePin() {
  try {
    window.localStorage.removeItem(PIN_CONFIG_KEY);
    window.localStorage.removeItem(PIN_STATE_KEY);
  } catch {
    // ignore
  }
}

export async function verifyDevicePin(candidatePin) {
  const cfg = getPinConfig();
  if (!cfg || !cfg.enabled) return { ok: true, unlocked: true };

  const lockState = getPinLockState();
  const now = Date.now();
  if (lockState.lockedUntil && lockState.lockedUntil > now) {
    const remainingSec = Math.ceil((lockState.lockedUntil - now) / 1000);
    return {
      ok: false,
      lockedOut: true,
      remainingSec,
      failedAttempts: lockState.failedAttempts,
      message: `Locked out after too many incorrect PIN attempts. Try again in ${remainingSec}s.`,
    };
  }

  const hash = await sha256Hex(`${cfg.salt}:${String(candidatePin || '').trim()}`);
  if (hash === cfg.hash) {
    savePinLockState({ failedAttempts: 0, lockedUntil: 0 });
    return { ok: true, unlocked: true };
  }

  const nextFailed = (lockState.failedAttempts || 0) + 1;
  if (nextFailed >= MAX_PIN_ATTEMPTS) {
    const lockedUntil = now + LOCKOUT_MS;
    savePinLockState({ failedAttempts: nextFailed, lockedUntil });
    return {
      ok: false,
      lockedOut: true,
      remainingSec: Math.ceil(LOCKOUT_MS / 1000),
      failedAttempts: nextFailed,
      message: `Too many wrong PIN attempts (${nextFailed}/${MAX_PIN_ATTEMPTS}). Locked out for 30 seconds.`,
    };
  }

  savePinLockState({ failedAttempts: nextFailed, lockedUntil: 0 });
  return {
    ok: false,
    lockedOut: false,
    failedAttempts: nextFailed,
    remainingAttempts: MAX_PIN_ATTEMPTS - nextFailed,
    message: `Incorrect PIN (${nextFailed}/${MAX_PIN_ATTEMPTS} attempts used).`,
  };
}
