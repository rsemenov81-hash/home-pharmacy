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
    // ignore download errors
  }
}

export function SettingsView({
  members,
  settings,
  rev,
  compounds,
  localMode = false,
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

  const [pinCfg, setPinCfg] = useState(() => getPinConfig());
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
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
          activeRxMeds: draft.activeRxMedsText.split(',').map((s) => s.trim()).filter(Boolean),
          allergies: draft.allergiesText.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      await onRefresh();
      setStatusMsg(`Saved profile for ${draft.name}.`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not save member.');
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
        aiWritePolicy: { newCompoundMode, verifiedEditMode },
      });
      await onRefresh();
      setStatusMsg('Saved AI safety policy.');
    } catch (err) {
      setErrorMsg(err.message || 'Could not update policy.');
    } finally {
      setBusy(false);
    }
  };

  const handleExportJson = async () => {
    setErrorMsg('');
    try {
      const res = await api.get('/api/v1/export/hub.json', { rawText: true });
      triggerDownload('home-pharmacy-export.json', res.text, 'application/json');
      setStatusMsg('Downloaded JSON backup.');
    } catch (err) {
      setErrorMsg(err.message || 'JSON export failed.');
    }
  };

  const handleExportCsv = async () => {
    setErrorMsg('');
    try {
      const res = await api.get('/api/v1/export/compounds.csv', { rawText: true });
      triggerDownload('home-pharmacy-compounds.csv', res.text, 'text/csv;charset=utf-8');
      setStatusMsg('Downloaded CSV spreadsheet.');
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
      setStatusMsg(`Restored snapshot from ${dateKey}.`);
    } catch (err) {
      setErrorMsg(err.message || 'Restore failed.');
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
      setStatusMsg('Device PIN lock enabled.');
    } catch (err) {
      setErrorMsg(err.message || 'Failed to enable PIN.');
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
        <div className="eyebrow">PREFERENCES &amp; PRIVACY</div>
        <h1 className="display-title" style={{ marginTop: 4 }}>Settings</h1>
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          Personalize daily routines, safety checks, backups, and device lock.
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

      {/* 1. Household Members */}
      <section className="card stack-v" data-testid="settings-members">
        <div className="row-wrap">
          <Users size={16} color="var(--accent)" />
          <div>
            <div className="eyebrow">HOUSEHOLD PROFILES</div>
            <h2 className="section-heading">Members, Schedules &amp; Safety Context</h2>
          </div>
        </div>

        <div className="grid-2">
          {(members || []).map((m) => {
            const d = memberDrafts[m.id] || {};
            return (
              <div key={m.id} className="slot-card slot-populated stack-sm">
                <div className="space-between">
                  <strong>{m.name}</strong>
                  <span className="pill pill-accent">{m.role || 'admin'}</span>
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
                    Sex Context
                    <select
                      value={d.biologicalSexContext || 'unspecified'}
                      onChange={(e) => updateMemberField(m.id, 'biologicalSexContext', e.target.value)}
                    >
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                      <option value="unspecified">Unspecified</option>
                    </select>
                  </label>
                  <label className={`toggle-chip${d.pregnancyOrTrying ? ' active' : ''}`} style={{ alignSelf: 'end', height: 40 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(d.pregnancyOrTrying)}
                      onChange={(e) => updateMemberField(m.id, 'pregnancyOrTrying', e.target.checked)}
                    />
                    <span>Pregnancy Guard</span>
                  </label>
                </div>
                <label className="field-label">
                  Active Prescription Medications
                  <input
                    type="text"
                    placeholder="Comma-separated (e.g., Sertraline)"
                    value={d.activeRxMedsText ?? ''}
                    onChange={(e) => updateMemberField(m.id, 'activeRxMedsText', e.target.value)}
                  />
                </label>
                <div className="grid-3">
                  <label className="field-label">
                    Wake
                    <input type="time" value={d.wake || '07:00'} onChange={(e) => updateMemberField(m.id, 'wake', e.target.value)} />
                  </label>
                  <label className="field-label">
                    Workout
                    <input type="time" value={d.workout || '06:30'} onChange={(e) => updateMemberField(m.id, 'workout', e.target.value)} />
                  </label>
                  <label className="field-label">
                    Bedtime
                    <input type="time" value={d.bed || '22:30'} onChange={(e) => updateMemberField(m.id, 'bed', e.target.value)} />
                  </label>
                </div>
                <div>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => handleSaveMember(m.id)}>
                    Save {m.name}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. AI Safety Policy */}
      <section className="card stack-sm" data-testid="settings-ai-policy">
        <div className="row-wrap">
          <ShieldCheck size={16} color="var(--accent)" />
          <div>
            <div className="eyebrow">AI GOVERNANCE</div>
            <h2 className="section-heading">AI Write &amp; Verification Rules</h2>
          </div>
        </div>
        <form onSubmit={handleSaveAiPolicy} className="stack-sm">
          <div className="grid-2">
            <label className="field-label">
              When an AI adds a new compound
              <select value={newCompoundMode} onChange={(e) => setNewCompoundMode(e.target.value)}>
                <option value="auto_publish_ai_draft">Save as AI Draft (1-tap Verify)</option>
                <option value="hold_in_inbox">Hold in Proposals Inbox first</option>
              </select>
            </label>
            <label className="field-label">
              When an AI edits a verified profile
              <select value={verifiedEditMode} onChange={(e) => setVerifiedEditMode(e.target.value)}>
                <option value="always_propose">Always send to Proposals Inbox</option>
                <option value="allow_blank_fill">Allow filling blank fields only</option>
              </select>
            </label>
          </div>
          <div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              Save Rules
            </button>
          </div>
        </form>
      </section>

      {/* 3. Sync, Exports & Backups */}
      <section className="card stack-sm" data-testid="settings-sync">
        <div className="space-between">
          <div className="row-wrap">
            <RefreshCw size={16} color="var(--accent)" />
            <div>
              <div className="eyebrow">DATA &amp; SYNC</div>
              <h2 className="section-heading">Backups, Reports &amp; Cloud Sync</h2>
            </div>
          </div>
          <div className="row-wrap">
            <span className="pill pill-accent">{localMode ? 'Local Browser Mode' : 'Cloud Server'}</span>
            <span className="pill num">Rev #{rev ?? 0}</span>
          </div>
        </div>

        {localMode ? (
          <div className="banner-ok" style={{ fontSize: '0.84rem' }}>
            Running privately in <strong>Local Browser Mode</strong> (saved on this device). Connect a Cloudflare Worker URL below whenever you want live multi-device sync and 5-AI MCP access.
          </div>
        ) : null}

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              await onRefresh();
              await loadAux();
              setStatusMsg('Synced latest data.');
            }}
          >
            <RefreshCw size={13} /> Sync Now
          </button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="btn-export-json" onClick={handleExportJson}>
            <Download size={13} /> Export JSON
          </button>
          <button type="button" className="btn btn-sm" data-testid="btn-export-csv" onClick={handleExportCsv}>
            <Download size={13} /> Export CSV
          </button>
          <button type="button" className="btn btn-sm" data-testid="btn-print-report" onClick={handlePrintReport}>
            <Printer size={13} /> Print Report
          </button>
        </div>

        <details style={{ marginTop: 4 }}>
          <summary className="dim" style={{ cursor: 'pointer', fontWeight: 600 }}>
            Cloud Server URL &amp; Snapshots
          </summary>
          <div className="stack-sm" style={{ marginTop: '0.65rem' }}>
            <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
              <label className="field-label" style={{ flex: '1 1 240px' }}>
                Cloudflare Worker / Server URL
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
                  setStatusMsg('Updated server URL.');
                }}
              >
                Save URL
              </button>
            </div>
            {pushConfig ? (
              <div className="dim">
                Web Push Reminders: {pushConfig.enabled ? 'Enabled' : 'Ready when VAPID keys are configured'}
              </div>
            ) : null}
            {snapshots.length > 0 ? (
              <div className="row-wrap">
                {snapshots.slice(0, 8).map((s) => {
                  const dk = typeof s === 'string' ? s : s.dateKey || s.id;
                  return (
                    <button key={dk} type="button" className="btn btn-sm" disabled={busy} onClick={() => handleRestoreSnapshot(dk)}>
                      <RotateCcw size={12} /> Restore {dk}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </details>
      </section>

      {/* 4. Device PIN Lock */}
      <section className="card stack-sm" data-testid="settings-pin-lock">
        <div className="space-between">
          <div className="row-wrap">
            <Lock size={16} color="var(--accent)" />
            <div>
              <div className="eyebrow">PRIVACY SHIELD</div>
              <h2 className="section-heading">Device PIN Lock</h2>
            </div>
          </div>
          <span className={`pill ${pinCfg?.enabled ? 'pill-verified' : ''}`}>
            {pinCfg?.enabled ? 'Enabled' : 'Off'}
          </span>
        </div>

        <p className="muted" style={{ margin: 0 }}>
          Lock Home Pharmacy on this device with a local PIN (5 consecutive wrong tries trigger a 30-second lockout).
        </p>

        {pinCfg?.enabled ? (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary btn-sm" onClick={onLockNow}>
              <Lock size={13} /> Lock Now
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={handleDisablePin}>
              Disable PIN
            </button>
          </div>
        ) : (
          <form onSubmit={handleEnablePin} className="row-wrap" style={{ alignItems: 'flex-end' }}>
            <label className="field-label">
              New PIN
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

      {/* Printable Report */}
      {showPrintReport ? (
        <article className="card stack-sm">
          <div className="space-between">
            <h2 className="display-sm">Home Pharmacy — Summary Report</h2>
            <button type="button" className="btn btn-sm no-print" onClick={() => setShowPrintReport(false)}>Hide</button>
          </div>
          <div className="banner-warn" style={{ fontSize: '0.84rem' }}>
            <strong>Medical &amp; Harm-Reduction Disclaimer:</strong> Personal reference report only — not medical advice. Consult a qualified clinician for medical decisions and lab panels.
          </div>
          <div className="muted">
            Members: {(members || []).map((m) => m.name).join(', ')} · Total Compounds: {(compounds || []).length}
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.15rem' }}>
            {(compounds || []).map((c) => (
              <li key={c.id} style={{ marginBottom: 4 }}>
                <strong>{c.name}</strong> ({c.sectionId}) — {c.dosages?.rangeText || 'See profile'} · {c.summary}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </div>
  );
}
