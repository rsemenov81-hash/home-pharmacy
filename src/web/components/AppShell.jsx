import React, { useState } from 'react';
import {
  Layers,
  CalendarClock,
  Package,
  Sparkles,
  Settings,
  Sun,
  Moon,
  Lock,
  WifiOff,
  Search,
  ChevronDown,
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
    <div className="auth-screen">
      <main className="glass auth-card stack-v">
        <div className="row-wrap">
          <span className="brand-mark">❖</span>
          <div>
            <div className="eyebrow">HOME PHARMACY</div>
            <h1 className="display-sm" style={{ marginTop: 2 }}>Unlock Your Hub</h1>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Enter your Household Access Token or scoped API key to open your private protocol hub.
        </p>
        {authError ? (
          <div className="banner-danger" role="alert">
            {authError}
          </div>
        ) : null}
        <form onSubmit={handleSubmit} className="stack-v">
          <label className="field-label" htmlFor="auth-token-input">
            Access Token
            <input
              id="auth-token-input"
              type="password"
              name="token"
              placeholder="Paste access token…"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <Lock size={15} /> {busy ? 'Unlocking…' : 'Sign In & Unlock'}
          </button>
        </form>
        <p className="dim" style={{ margin: 0, textAlign: 'center' }}>
          Personal reference tool only — not medical advice.
        </p>
      </main>
    </div>
  );
}

export function PinLockOverlay({ onUnlocked }) {
  const [pin, setPin] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const handleUnlock = async (e) => {
    e.preventDefault();
    const res = await verifyDevicePin(pin);
    if (res.ok) {
      setPin('');
      setErrorMsg('');
      onUnlocked();
    } else {
      setPin('');
      setErrorMsg(res.message || 'Incorrect PIN.');
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Device PIN Lock">
      <div className="modal-card stack-v" style={{ maxWidth: 380 }}>
        <div className="row-wrap">
          <span className="brand-mark"><Lock size={15} /></span>
          <div>
            <div className="eyebrow">PRIVACY SHIELD</div>
            <h2 className="display-sm">Device Locked</h2>
          </div>
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
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
          </label>
          <button type="submit" className="btn btn-primary">
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
    { id: 'sections', testId: 'nav-sections', label: 'Library', Icon: Layers },
    { id: 'stack', testId: 'nav-stack', label: 'Stack', Icon: CalendarClock },
    { id: 'cabinet', testId: 'nav-cabinet', label: 'Cabinet', Icon: Package },
    { id: 'ai-hub', testId: 'nav-ai-hub', label: 'AI Hub', Icon: Sparkles, badge: pendingProposalCount },
    { id: 'settings', testId: 'nav-settings', label: 'Settings', Icon: Settings },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">❖</span>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
              <span>Home Pharmacy</span>
              <span className="brand-sub">Household OS</span>
            </div>
          </div>

          <div className="topbar-controls">
            <div className="search-wrap">
              <Search size={14} className="search-icon" aria-hidden="true" />
              <input
                type="text"
                data-testid="global-search-input"
                aria-label="Search compounds across all sections"
                placeholder="Search compounds, aliases…"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>

            <div className="member-pill">
              <select
                className="member-select"
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
              <ChevronDown size={13} className="member-chevron" aria-hidden="true" />
            </div>

            <button
              type="button"
              className="btn btn-icon"
              data-testid="theme-toggle"
              aria-label="Toggle dark and light theme"
              onClick={onToggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
      </header>

      {offline ? (
        <div style={{ maxWidth: 1120, width: '100%', margin: '0.75rem auto 0', padding: '0 1rem' }}>
          <div className="banner-warn row-wrap" role="status">
            <WifiOff size={15} />
            <span>Offline — viewing cached household data.</span>
          </div>
        </div>
      ) : null}

      <main className="main-content">{children}</main>

      <footer className="disclaimer-footer" role="contentinfo">
        Personal reference &amp; scheduling tool only — not medical advice. Consult a licensed healthcare professional for clinical decisions and lab monitoring.
      </footer>

      <div className="pill-nav-wrap">
        <nav className="primary-nav" aria-label="Primary navigation">
          {navItems.map(({ id, testId, label, Icon, badge }) => (
            <button
              key={id}
              type="button"
              data-testid={testId}
              className={`nav-btn${activeTab === id ? ' active' : ''}`}
              onClick={() => onTabChange(id)}
            >
              <Icon size={18} strokeWidth={activeTab === id ? 2.2 : 1.8} />
              <span>{label}</span>
              {badge > 0 ? <span className="badge-count">{badge}</span> : null}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
