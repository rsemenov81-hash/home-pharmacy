import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  api,
  bootstrapTokenFromUrl,
  getAuthToken,
  getCustomApiBaseUrl,
  setAuthToken,
} from './lib/api.js';
import {
  isLocalModeEnabled,
  setLocalModeEnabled,
  shouldAutoEnterLocalMode,
} from './lib/local-backend.js';
import { getPinConfig, loadCachedHub, loadTheme, saveCachedHub, saveTheme } from './lib/state.js';
import { AppShell, AuthGate, PinLockOverlay } from './components/AppShell.jsx';
import { SectionsView } from './components/SectionsView.jsx';
import { CompoundDetail } from './components/CompoundDetail.jsx';
import { StackBuilderView } from './components/StackBuilderView.jsx';
import { CabinetView } from './components/CabinetView.jsx';
import { AiHubView } from './components/AiHubView.jsx';
import { SettingsView } from './components/SettingsView.jsx';

function App() {
  const [bootConfig] = useState(() => {
    const token = bootstrapTokenFromUrl();
    const hasCustomApiUrl = Boolean(getCustomApiBaseUrl());
    const useLocal = shouldAutoEnterLocalMode({ hasToken: Boolean(token), hasCustomApiUrl });
    if (useLocal) {
      setLocalModeEnabled(true);
    }
    return { initialToken: token, useLocal };
  });

  const [theme, setTheme] = useState(() => saveTheme(loadTheme()));
  const [authenticated, setAuthenticated] = useState(false);
  const [booting, setBooting] = useState(() => Boolean(bootConfig.initialToken || bootConfig.useLocal));
  const [authError, setAuthError] = useState('');
  const [pinLocked, setPinLocked] = useState(() => Boolean(getPinConfig()?.enabled));
  const [offline, setOffline] = useState(false);
  const [localMode, setLocalMode] = useState(() => isLocalModeEnabled());

  const [hub, setHub] = useState(null);
  const [activeTab, setActiveTab] = useState('sections');
  const [activeMemberId, setActiveMemberId] = useState('member_wife');
  const [selectedCompoundId, setSelectedCompoundId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadHubState = useCallback(async ({ allowOfflineFallback = true } = {}) => {
    try {
      const res = await api.get('/api/v1/sync');
      const data = res.json;
      setHub(data);
      setAuthenticated(true);
      setAuthError('');
      setOffline(false);
      setLocalMode(isLocalModeEnabled());
      saveCachedHub(data);
      setActiveMemberId((prev) => {
        const members = data?.members || [];
        if (members.some((m) => m.id === prev)) return prev;
        return members[0]?.id || 'member_wife';
      });
      return true;
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        setAuthToken('');
        setAuthenticated(false);
        setHub(null);
        setAuthError('Invalid or unauthorized access token. Please sign in with a valid household token.');
        return false;
      }
      if (allowOfflineFallback) {
        const cached = loadCachedHub();
        if (cached && (getAuthToken() || isLocalModeEnabled())) {
          setHub(cached);
          setAuthenticated(true);
          setOffline(true);
          return true;
        }
      }
      setAuthError(err?.message || 'Unable to connect to Home Pharmacy backend.');
      return false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      if (!bootConfig.initialToken && !bootConfig.useLocal) {
        if (active) {
          setAuthenticated(false);
          setBooting(false);
        }
        return;
      }
      await loadHubState({ allowOfflineFallback: true });
      if (active) setBooting(false);
    }
    boot();
    return () => {
      active = false;
    };
  }, [bootConfig, loadHubState]);

  // Register Service Worker for offline PWA resilience & optional push reminders
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }, []);

  // Online/offline listeners
  useEffect(() => {
    const onOnline = () => {
      if (getAuthToken() || isLocalModeEnabled()) loadHubState({ allowOfflineFallback: true });
    };
    const onOffline = () => {
      if (!isLocalModeEnabled()) setOffline(true);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadHubState]);

  const handleConnect = async (token) => {
    setLocalModeEnabled(false);
    setLocalMode(false);
    setAuthToken(token);
    setAuthError('');
    await loadHubState({ allowOfflineFallback: false });
  };

  const handleToggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(saveTheme(next));
  };

  const handleTabChange = (tab) => {
    setSelectedCompoundId(null);
    setActiveTab(tab);
  };

  const members = hub?.members || [];
  const sections = hub?.sections || [];
  const compounds = hub?.compounds || [];
  const ownership = hub?.ownership || [];
  const stacks = hub?.stacks || [];
  const proposals = hub?.proposals || [];

  const pendingProposalCount = useMemo(
    () => proposals.filter((p) => p.status === 'pending').length,
    [proposals],
  );

  const selectedCompound = useMemo(
    () => (selectedCompoundId ? compounds.find((c) => c.id === selectedCompoundId) || null : null),
    [selectedCompoundId, compounds],
  );

  if (booting) {
    return (
      <div className="app-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p className="muted">Loading Home Pharmacy…</p>
      </div>
    );
  }

  if (!authenticated) {
    return <AuthGate onConnect={handleConnect} authError={authError} />;
  }

  if (pinLocked) {
    return <PinLockOverlay onUnlocked={() => setPinLocked(false)} />;
  }

  return (
    <AppShell
      activeTab={activeTab}
      onTabChange={handleTabChange}
      members={members}
      activeMemberId={activeMemberId}
      onMemberChange={setActiveMemberId}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      theme={theme}
      onToggleTheme={handleToggleTheme}
      pendingProposalCount={pendingProposalCount}
      offline={offline}
    >
      {selectedCompound ? (
        <CompoundDetail
          compound={selectedCompound}
          section={sections.find((s) => s.id === selectedCompound.sectionId)}
          ownership={ownership}
          activeMemberId={activeMemberId}
          onBack={() => setSelectedCompoundId(null)}
          onRefresh={() => loadHubState({ allowOfflineFallback: true })}
        />
      ) : activeTab === 'sections' ? (
        <SectionsView
          sections={sections}
          compounds={compounds}
          ownership={ownership}
          activeMemberId={activeMemberId}
          searchQuery={searchQuery}
          onSelectCompound={(id) => setSelectedCompoundId(id)}
          onRefresh={() => loadHubState({ allowOfflineFallback: true })}
        />
      ) : activeTab === 'stack' ? (
        <StackBuilderView
          members={members}
          activeMemberId={activeMemberId}
          compounds={compounds}
          stacks={stacks}
          onRefresh={() => loadHubState({ allowOfflineFallback: true })}
        />
      ) : activeTab === 'cabinet' ? (
        <CabinetView
          compounds={compounds}
          sections={sections}
          ownership={ownership}
          activeMemberId={activeMemberId}
          searchQuery={searchQuery}
          onSelectCompound={(id) => setSelectedCompoundId(id)}
          onRefresh={() => loadHubState({ allowOfflineFallback: true })}
        />
      ) : activeTab === 'ai-hub' ? (
        <AiHubView
          sections={sections}
          proposals={proposals}
          activeMemberId={activeMemberId}
          onRefresh={() => loadHubState({ allowOfflineFallback: true })}
        />
      ) : (
        <SettingsView
          members={members}
          settings={hub?.settings || {}}
          rev={hub?._rev ?? 0}
          compounds={compounds}
          localMode={localMode}
          onConnectRemote={handleConnect}
          onRefresh={() => loadHubState({ allowOfflineFallback: true })}
          onLockNow={() => setPinLocked(true)}
        />
      )}
    </AppShell>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
