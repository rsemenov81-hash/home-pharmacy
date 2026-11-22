import React, { useState } from 'react';
import {
  Layers,
  CalendarClock,
  Package,
  Sparkles,
  Settings,
  Sun,
  Moon,
  ShieldAlert,
  Lock,
  WifiOff,
} from 'lucide-react';
import { verifyDevicePin } from '../lib/state.js';

export function AuthGate({ onConnect, authError }) {
  const [tokenInput, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setBusy(true);
    try {
      await onConnect(tokenInput.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell" style={{ justifyContent: 'center', alignItems: 'center', padding: '1.5rem' }}>
      <main className="card stack-v" style={{ maxWidth: 440, width: '100%' }}>
        <div className="row-wrap">
          <Lock size={20} color="var(--gold)" />
          <h1 style={{ margin: 0, fontSize: '1.35rem', color: 'var(--gold)' }}>Home Pharmacy</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Sign in with your Household Admin Token or scoped API key to access your private household health hub.
        </p>
        {authError ? (
          <div className="banner-danger" role="alert">
            {authError}
          </div>
        ) : null}
        <form onSubmit={handleSubmit} className="stack-v">
          <label className="field-label" htmlFor="auth-token-input">
            Access Token / Passcode
            <input
              id="auth-token-input"
              type="password"
              name="token"
              placeholder="Enter household access token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Sign In & Unlock Hub'}
          </button>
        </form>
        <p className="muted" style={{ fontSize: '0.78rem', margin: 0 }}>
          Personal reference tool only — not medical advice. Private household records are never exposed publicly.
        </p>
      </main>
    </div>
  );
}

export function PinLockOverlay({ onUnlocked }) {
  const [pin, setPin] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [lockedOut, setLockedOut] = useState(false);

  const handleUnlock = async (e) => {
    e.preventDefault();
    const res = await verifyDevicePin(pin);
    if (res.ok) {
      setPin('');
      setErrorMsg('');
      setLockedOut(false);
      onUnlocked();
    } else {
      setPin('');
      setLockedOut(Boolean(res.lockedOut));
      setErrorMsg(res.message || 'Incorrect PIN.');
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Device PIN Lock">
      <div className="modal-card stack-v" style={{ maxWidth: 400 }}>
        <div className="row-wrap">
          <Lock size={20} color="var(--gold)" />
          <h2 style={{ margin: 0, color: 'var(--gold)' }}>Device Locked</h2>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Enter your device PIN to unlock Home Pharmacy.
        </p>
        {errorMsg ? (
          <div className="banner-danger" role="alert">
            {errorMsg}
          </div>
        ) : null}
        <form onSubmit={handleUnlock} className="stack-v">
          <label className="field-label" htmlFor="pin-unlock-input">
            Device PIN
            <input
              id="pin-unlock-input"
              type="password"
              inputMode="numeric"
              name="pin"
              aria-label="Enter PIN"
              placeholder="Enter device PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={lockedOut && false}>
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}

export function AppShell({
  activeTab,
  onTabChange,
  members,
  activeMemberId,
  onMemberChange,
  searchQuery,
  onSearchChange,
  theme,
  onToggleTheme,
  pendingProposalCount,
  offline,
  children,
}) {
  const navItems = [
    { id: 'sections', testId: 'nav-sections', label: 'Sections', Icon: Layers },
    { id: 'stack', testId: 'nav-stack', label: 'Stack & Spread', Icon: CalendarClock },
    { id: 'cabinet', testId: 'nav-cabinet', label: 'Cabinet', Icon: Package },
    { id: 'ai-hub', testId: 'nav-ai-hub', label: 'AI Hub', Icon: Sparkles, badge: pendingProposalCount },
    { id: 'settings', testId: 'nav-settings', label: 'Settings', Icon: Settings },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span aria-hidden="true">❖</span>
          <span>Home Pharmacy</span>
          <span className="brand-sub">Household Hub</span>
        </div>

        <div className="topbar-controls">
          <div className="search-wrap">
            <input
              type="text"
              data-testid="global-search-input"
              aria-label="Search compounds across all sections"
              placeholder="Search compounds, aliases, mechanisms…"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>

          <select
            data-testid="member-switcher"
            aria-label="Active household member"
            value={activeMemberId}
            onChange={(e) => onMemberChange(e.target.value)}
          >
            {(members || []).map((m) => (
              <option key={m.id} value={m.id} data-testid={`member-option-${m.id}`}>
                {m.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn-sm"
            data-testid="theme-toggle"
            aria-label="Toggle dark and light theme"
            onClick={onToggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </header>

      <nav className="primary-nav" aria-label="Primary sections">
        {navItems.map(({ id, testId, label, Icon, badge }) => (
          <button
            key={id}
            type="button"
            data-testid={testId}
            className={`nav-btn${activeTab === id ? ' active' : ''}`}
            onClick={() => onTabChange(id)}
          >
            <Icon size={15} />
            <span>{label}</span>
            {badge > 0 ? <span className="badge-count">{badge}</span> : null}
          </button>
        ))}
      </nav>

      {offline ? (
        <div className="banner-warn" role="status" style={{ margin: '0.75rem 1rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <WifiOff size={16} />
          <span>Offline mode — showing cached household catalog. Changes will sync when reconnected.</span>
        </div>
      ) : null}

      <main className="main-content">{children}</main>

      <footer className="disclaimer-footer" role="contentinfo">
        <ShieldAlert size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
        <strong>Medical & Harm-Reduction Notice:</strong> Home Pharmacy is a personal reference & scheduling tool only — not medical advice, diagnosis, or prescribing guidance. Consult a licensed healthcare professional for clinical decisions and lab monitoring.
      </footer>
    </div>
  );
}
