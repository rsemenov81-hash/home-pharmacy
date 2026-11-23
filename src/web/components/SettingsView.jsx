import React, { useEffect, useState } from 'react';
import {
  Users,
  ShieldCheck,
  RefreshCw,
  Lock,
  Download,
  Printer,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { api, getApiBaseUrl, setApiBaseUrl } from '../lib/api.js';
import { configureDevicePin, disableDevicePin, getPinConfig } from '../lib/state.js';

function triggerDownload(filename, content, mimeType) {
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // ignore download errors in restricted environments
  }
}

export function SettingsView({
  members,
  settings,
  rev,
  compounds,
  localMode = false,
  onConnectRemote,
  onRefresh,
  onLockNow,
}) {
  const [memberDrafts, setMemberDrafts] = useState({});
  const [newCompoundMode, setNewCompoundMode] = useState(
    settings?.aiWritePolicy?.newCompoundMode || 'auto_publish_ai_draft',
  );
  const [verifiedEditMode, setVerifiedEditMode] = useState(
    settings?.aiWritePolicy?.verifiedEditMode || 'always_propose',
  );
  const [snapshots, setSnapshots] = useState([]);
  const [pushConfig, setPushConfig] = useState(null);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());

  // PIN lock state
  const [pinCfg, setPinCfg] = useState(() => getPinConfig());
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');

  // Print preview modal/article
  const [showPrintReport, setShowPrintReport] = useState(false);

  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const map = {};
    for (const m of members || []) {
      map[m.id] = {
        name: m.name || '',
        biologicalSexContext: m.safetyContext?.biologicalSexContext || 'unspecified',
        pregnancyOrTrying: Boolean(m.safetyContext?.pregnancyOrTrying),
        activeRxMedsText: (m.safetyContext?.activeRxMeds || []).join(', '),
        allergiesText: (m.safetyContext?.allergies || []).join(', '),
        wake: m.routineAnchors?.wake || '07:00',
        breakfast: m.routineAnchors?.breakfast || '08:00',
        workout: m.routineAnchors?.workout || '06:30',
        lunch: m.routineAnchors?.lunch || '13:00',
        dinner: m.routineAnchors?.dinner || '19:00',
        bed: m.routineAnchors?.bed || '22:30',
      };
    }
    setMemberDrafts(map);
  }, [members]);

  useEffect(() => {
    setNewCompoundMode(settings?.aiWritePolicy?.newCompoundMode || 'auto_publish_ai_draft');
    setVerifiedEditMode(settings?.aiWritePolicy?.verifiedEditMode || 'always_propose');
  }, [settings]);

  const loadAux = async () => {
    try {
      const [sRes, pRes] = await Promise.all([
        api.get('/api/v1/snapshots'),
        api.get('/api/v1/push/config'),
      ]);
      setSnapshots(sRes.json?.snapshots || []);
      setPushConfig(pRes.json || null);
    } catch {
      // ignore if unavailable
    }
  };

  useEffect(() => {
    loadAux();
  }, []);

  const updateMemberField = (memberId, field, value) => {
    setMemberDrafts((prev) => ({
      ...prev,
      [memberId]: {
        ...(prev[memberId] || {}),
        [field]: value,
      },
    }));
  };

  const handleSaveMember = async (memberId) => {
    const draft = memberDrafts[memberId];
    if (!draft) return;
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      await api.patch(`/api/v1/members/${encodeURIComponent(memberId)}`, {
        name: draft.name.trim(),
        routineAnchors: {
          wake: draft.wake,
          breakfast: draft.breakfast,
          workout: draft.workout,
          lunch: draft.lunch,
          dinner: draft.dinner,
          bed: draft.bed,
        },
        safetyContext: {
          biologicalSexContext: draft.biologicalSexContext,
          pregnancyOrTrying: Boolean(draft.pregnancyOrTrying),
          activeRxMeds: draft.activeRxMedsText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          allergies: draft.allergiesText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      await onRefresh();
      setStatusMsg(`Saved household member "${draft.name}".`);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to update member.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAiPolicy = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      await api.patch('/api/v1/household/settings', {
        aiWritePolicy: {
          newCompoundMode,
          verifiedEditMode,
        },
      });
      await onRefresh();
      setStatusMsg('Updated AI Write Policy.');
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save AI Write Policy.');
    } finally {
      setBusy(false);
    }
  };

  const handleExportJson = async () => {
    setErrorMsg('');
    try {
      const res = await api.get('/api/v1/export/hub.json', { rawText: true });
      triggerDownload('home-pharmacy-export.json', res.text, 'application/json');
      setStatusMsg('Exported Home Pharmacy JSON backup (zero secrets).');
    } catch (err) {
      setErrorMsg(err.message || 'JSON export failed.');
    }
  };

  const handleExportCsv = async () => {
    setErrorMsg('');
    try {
      const res = await api.get('/api/v1/export/compounds.csv', { rawText: true });
      triggerDownload('home-pharmacy-compounds.csv', res.text, 'text/csv;charset=utf-8');
      setStatusMsg('Exported formula-safe Compounds CSV.');
    } catch (err) {
      setErrorMsg(err.message || 'CSV export failed.');
    }
  };

  const handlePrintReport = () => {
    setShowPrintReport(true);
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  };

  const handleRestoreSnapshot = async (dateKey) => {
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      await api.post(`/api/v1/snapshots/${encodeURIComponent(dateKey)}/restore`, {});
      await onRefresh();
      setStatusMsg(`Restored snapshot ${dateKey}.`);
    } catch (err) {
      setErrorMsg(err.message || 'Snapshot restore failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleEnablePin = async (e) => {
    e.preventDefault();
    setErrorMsg('');
    setStatusMsg('');
    if (pinInput.trim().length < 4) {
      setErrorMsg('PIN must be at least 4 characters.');
      return;
    }
    if (pinConfirm && pinConfirm.trim() !== pinInput.trim()) {
      setErrorMsg('PIN confirmation does not match.');
      return;
    }
    try {
      const cfg = await configureDevicePin(pinInput);
      setPinCfg(cfg);
      setPinInput('');
      setPinConfirm('');
      setStatusMsg('Device PIN lock enabled (salted SHA-256 + 5-fail 30s lockout).');
    } catch (err) {
      setErrorMsg(err.message || 'Failed to enable PIN lock.');
    }
  };

  const handleDisablePin = () => {
    disableDevicePin();
    setPinCfg(null);
    setStatusMsg('Device PIN lock disabled.');
  };

  return (
    <div className="stack-v">
      <div>
        <h1 style={{ margin: 0, fontSize: '1.45rem' }}>Household Settings, Sync & Security</h1>
        <p className="muted" style={{ margin: '0.2rem 0 0' }}>
          Manage spouse profiles, safety contexts, AI governance policy, backups/exports, and device PIN privacy lock.
        </p>
      </div>

      {statusMsg ? (
        <div className="banner-ok" role="status">
          <CheckCircle2 size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {statusMsg}
        </div>
      ) : null}

      {errorMsg ? (
        <div className="banner-danger" role="alert">
          <AlertTriangle size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {errorMsg}
        </div>
      ) : null}

      {/* 1. Household Members & Safety Context */}
      <section className="card stack-v" data-testid="settings-members">
        <div className="row-wrap">
          <Users size={17} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
            Household Members & Safety Context
          </h2>
        </div>

        <div className="grid-2">
          {(members || []).map((m) => {
            const d = memberDrafts[m.id] || {};
            return (
              <div key={m.id} className="slot-card stack-v">
                <div className="space-between">
                  <strong>{m.name}</strong>
                  <span className="pill">{m.role || 'admin'}</span>
                </div>
                <label className="field-label">
                  Display Name
                  <input
                    type="text"
                    value={d.name ?? ''}
                    onChange={(e) => updateMemberField(m.id, 'name', e.target.value)}
                  />
                </label>
                <div className="grid-2">
                  <label className="field-label">
                    Biological Sex Context
                    <select
                      value={d.biologicalSexContext || 'unspecified'}
                      onChange={(e) => updateMemberField(m.id, 'biologicalSexContext', e.target.value)}
                    >
                      <option value="female">female</option>
                      <option value="male">male</option>
                      <option value="unspecified">unspecified</option>
                    </select>
                  </label>
                  <label className="row-wrap" style={{ fontSize: '0.84rem', marginTop: '1.3rem' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(d.pregnancyOrTrying)}
                      onChange={(e) => updateMemberField(m.id, 'pregnancyOrTrying', e.target.checked)}
                    />
                    <span>Pregnancy / Trying (Teratogen Guard)</span>
                  </label>
                </div>
                <label className="field-label">
                  Active Rx Medications (comma-separated)
                  <input
                    type="text"
                    placeholder="e.g., Sertraline, Nitrates"
                    value={d.activeRxMedsText ?? ''}
                    onChange={(e) => updateMemberField(m.id, 'activeRxMedsText', e.target.value)}
                  />
                </label>
                <div className="grid-3">
                  <label className="field-label">
                    Wake
                    <input
                      type="time"
                      value={d.wake || '07:00'}
                      onChange={(e) => updateMemberField(m.id, 'wake', e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    Workout
                    <input
                      type="time"
                      value={d.workout || '06:30'}
                      onChange={(e) => updateMemberField(m.id, 'workout', e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    Bed
                    <input
                      type="time"
                      value={d.bed || '22:30'}
                      onChange={(e) => updateMemberField(m.id, 'bed', e.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => handleSaveMember(m.id)}
                >
                  Save {m.name}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. AI Governance & Write Policy */}
      <section className="card stack-v" data-testid="settings-ai-policy">
        <div className="row-wrap">
          <ShieldCheck size={17} color="var(--gold)" />
          <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
            AI Write Policy & Verification Guardrails
          </h2>
        </div>
        <form onSubmit={handleSaveAiPolicy} className="stack-v">
          <div className="grid-2">
            <label className="field-label">
              New AI-Researched Compounds
              <select value={newCompoundMode} onChange={(e) => setNewCompoundMode(e.target.value)}>
                <option value="auto_publish_ai_draft">Auto-publish as ai_draft (1-tap Verify)</option>
                <option value="hold_in_inbox">Hold in Proposals Inbox for review</option>
              </select>
            </label>
            <label className="field-label">
              AI Edits to Verified Profiles
              <select value={verifiedEditMode} onChange={(e) => setVerifiedEditMode(e.target.value)}>
                <option value="always_propose">Always route to Proposals Inbox (never silent overwrite)</option>
                <option value="allow_blank_fill">Allow filling blank fields only</option>
              </select>
            </label>
          </div>
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              Save AI Policy
            </button>
          </div>
        </form>
      </section>

      {/* 3. Sync, Snapshots & Multi-Format Export */}
      <section className="card stack-v" data-testid="settings-sync">
        <div className="space-between">
          <div className="row-wrap">
            <RefreshCw size={17} color="var(--gold)" />
            <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
              Cloud Sync, Snapshots & Multi-Format Export
            </h2>
          </div>
          <div className="row-wrap">
            <span className="pill">{localMode ? 'Local Browser Mode' : 'Cloud / Server Mode'}</span>
            <span className="pill num">Revision #{rev ?? 0}</span>
          </div>
        </div>

        {localMode ? (
          <div className="banner-ok" style={{ fontSize: '0.84rem' }}>
            Running privately in <strong>Local Browser Mode</strong> (saved in this browser). Everything works offline with zero server setup. To enable cross-device sync and live Gemini/Claude/Grok/GPT/Muse MCP access, deploy the Cloudflare Worker (see <code>DEPLOY.md</code>) and enter your Worker URL below.
          </div>
        ) : null}

        <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
          <label className="field-label" style={{ flex: '1 1 260px' }}>
            Hub Server URL (local or Cloudflare Worker)
            <input
              type="url"
              placeholder="https://home-pharmacy-hub.<subdomain>.workers.dev"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setApiBaseUrl(serverUrl);
              setStatusMsg('Updated Hub Server URL.');
            }}
          >
            Save URL
          </button>
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              await onRefresh();
              await loadAux();
              setStatusMsg('Synced latest household state from server.');
            }}
          >
            <RefreshCw size={14} /> Sync Now
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-export-json"
            onClick={handleExportJson}
          >
            <Download size={14} /> Export JSON
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-export-csv"
            onClick={handleExportCsv}
          >
            <Download size={14} /> Export CSV
          </button>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-print-report"
            onClick={handlePrintReport}
          >
            <Printer size={14} /> Print Report
          </button>
        </div>

        {pushConfig ? (
          <div className="muted" style={{ fontSize: '0.82rem' }}>
            Web Push Reminders: {pushConfig.enabled ? 'Enabled' : 'Available (configure VAPID keys to activate)'}
          </div>
        ) : null}

        {snapshots.length > 0 ? (
          <div className="stack-v">
            <h3 style={{ margin: 0, fontSize: '0.96rem' }}>Daily Point-in-Time Snapshots</h3>
            <div className="row-wrap">
              {snapshots.slice(0, 10).map((s) => {
                const dk = typeof s === 'string' ? s : s.dateKey || s.id;
                return (
                  <button
                    key={dk}
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => handleRestoreSnapshot(dk)}
                  >
                    <RotateCcw size={13} /> Restore {dk}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      {/* 4. Device PIN Lock (Salted SHA-256 + 5-Fail 30s Lockout) */}
      <section className="card stack-v" data-testid="settings-pin-lock">
        <div className="space-between">
          <div className="row-wrap">
            <Lock size={17} color="var(--gold)" />
            <h2 style={{ margin: 0, fontSize: '1.12rem', color: 'var(--gold)' }}>
              Device PIN Lock (Privacy Shield)
            </h2>
          </div>
          <span className={`pill ${pinCfg?.enabled ? 'pill-verified' : ''}`}>
            {pinCfg?.enabled ? 'PIN Lock Enabled' : 'Disabled'}
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Protect this device with a local salted SHA-256 PIN lock. Five consecutive incorrect attempts trigger a 30-second lockout.
        </p>

        {pinCfg?.enabled ? (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary btn-sm" onClick={onLockNow}>
              <Lock size={14} /> Lock Now
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={handleDisablePin}>
              Disable PIN
            </button>
          </div>
        ) : (
          <form onSubmit={handleEnablePin} className="row-wrap" style={{ alignItems: 'flex-end' }}>
            <label className="field-label">
              New Device PIN
              <input
                type="password"
                inputMode="numeric"
                name="pin"
                placeholder="4+ digits"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Confirm PIN
              <input
                type="password"
                inputMode="numeric"
                name="confirmPin"
                placeholder="Re-enter PIN"
                value={pinConfirm}
                onChange={(e) => setPinConfirm(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary">
              Enable PIN Lock
            </button>
          </form>
        )}
      </section>

      {/* Printable Report Section */}
      {showPrintReport ? (
        <article className="card stack-v">
          <div className="space-between">
            <h2 style={{ margin: 0, color: 'var(--gold)' }}>Home Pharmacy — Printable Summary Report</h2>
            <button type="button" className="btn btn-sm no-print" onClick={() => setShowPrintReport(false)}>
              Hide Preview
            </button>
          </div>
          <div className="banner-warn">
            <strong>Medical & Harm-Reduction Disclaimer:</strong> Personal reference report only — not medical advice. Review all compounds, dosages, and lab panels with a qualified healthcare clinician.
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Members: {(members || []).map((m) => m.name).join(', ')} • Total Catalog Compounds: {(compounds || []).length}
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {(compounds || []).map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> ({c.sectionId}) — {c.dosages?.rangeText || 'See profile'} • {c.summary}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </div>
  );
}
