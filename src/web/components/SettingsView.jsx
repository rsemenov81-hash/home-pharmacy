import React, { useEffect, useState } from 'react';
import {
  Lock,
  Download,
  Printer,
  RotateCcw,
  RefreshCw,
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
        name: draft.name,
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
          pregnancyOrTrying: draft.pregnancyOrTrying,
          activeRxMeds: draft.activeRxMedsText.split(',').map((s) => s.trim()).filter(Boolean),
          allergies: draft.allergiesText.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      await onRefresh();
      setStatusMsg(`Saved profile for ${draft.name || memberId}.`);
    } catch (err) {
      setErrorMsg(err.message || 'Could not save member profile.');
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
      setStatusMsg('Updated AI governance rules.');
    } catch (err) {
      setErrorMsg(err.message || 'Could not update AI rules.');
    } finally {
      setBusy(false);
    }
  };

  const handleExportJson = async () => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await api.get('/api/v1/export/hub.json', { rawText: true });
      triggerDownload('home-pharmacy-export.json', res.text, 'application/json');
      setStatusMsg('Exported full household JSON backup.');
    } catch (err) {
      setErrorMsg(err.message || 'JSON export failed.');
    }
  };

  const handleExportCsv = async () => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await api.get('/api/v1/export/compounds.csv', { rawText: true });
      triggerDownload('home-pharmacy-catalog.csv', res.text, 'text/csv;charset=utf-8');
      setStatusMsg('Exported spreadsheet-safe CSV.');
    } catch (err) {
      setErrorMsg(err.message || 'CSV export failed.');
    }
  };

  const handlePrintReport = () => {
    setShowPrintReport(true);
    setStatusMsg('Prepared printable household summary report.');
    try {
      if (typeof window !== 'undefined' && typeof window.print === 'function') {
        setTimeout(() => {
          try {
            window.print();
          } catch {
            // ignore
          }
        }, 120);
      }
    } catch {
      // ignore
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
    if (pinConfirm && pinInput !== pinConfirm) {
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
      setErrorMsg(err.message || 'Could not enable PIN.');
    }
  };

  const handleDisablePin = () => {
    disableDevicePin();
    setPinCfg(null);
    setStatusMsg('Device PIN lock disabled.');
  };

  return (
    <div className="stack-v">
      <div style={{ paddingTop: '0.2rem' }}>
        <div className="eyebrow">PREFERENCES &amp; PRIVACY</div>
        <h1 className="editorial-title" style={{ marginTop: 6 }}>Settings</h1>
        <p className="italic-sub" style={{ margin: '0.3rem 0 0' }}>
          Personalize daily routines, safety checks, backups, and device privacy.
        </p>
      </div>

      {statusMsg ? (
        <div className="banner-ok" role="status">
          <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {statusMsg}
        </div>
      ) : null}

      {errorMsg ? (
        <div className="banner-danger" role="alert">
          <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {errorMsg}
        </div>
      ) : null}

      {/* 1. Household Members */}
      <section className="stack-sm" data-testid="settings-members">
        <div className="section-h">
          <span>Household Profiles</span>
          <span className="sh-count">{String((members || []).length).padStart(2, '0')}</span>
        </div>

        <div className="grid-2">
          {(members || []).map((m) => {
            const d = memberDrafts[m.id] || {};
            return (
              <div key={m.id} className="atelier-card stack-sm">
                <div className="space-between">
                  <div className="row-wrap" style={{ gap: '0.55rem' }}>
                    <span className="member-avatar" style={{ width: 28, height: 28 }}>
                      {(m.name || 'M').charAt(0).toUpperCase()}
                    </span>
                    <h2 className="display-sm" style={{ fontSize: '1.35rem' }}>{m.name}</h2>
                  </div>
                  <span className="pill mono">{m.role || 'admin'}</span>
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
                  <label className={`toggle-chip${d.pregnancyOrTrying ? ' active' : ''}`} style={{ alignSelf: 'end', height: 42 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(d.pregnancyOrTrying)}
                      onChange={(e) => updateMemberField(m.id, 'pregnancyOrTrying', e.target.checked)}
                    />
                    <span>Pregnancy Guard</span>
                  </label>
                </div>

                <label className="field-label">
                  Active Prescription Meds
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

                <div style={{ paddingTop: '0.25rem' }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => handleSaveMember(m.id)}>
                    Save {m.name}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. AI Governance */}
      <section className="atelier-card stack-sm" data-testid="settings-ai-policy">
        <div>
          <div className="eyebrow">AI GOVERNANCE</div>
          <h2 className="display-sm" style={{ marginTop: 2 }}>Write &amp; Verification Policy</h2>
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
      <section className="atelier-card stack-sm" data-testid="settings-sync">
        <div className="space-between">
          <div>
            <div className="eyebrow">DATA &amp; SYNC</div>
            <h2 className="display-sm" style={{ marginTop: 2 }}>Backups &amp; Reports</h2>
          </div>
          <div className="row-wrap">
            <span className="pill pill-accent mono">{localMode ? 'Local Mode' : 'Cloud Server'}</span>
            <span className="pill mono">Rev #{rev ?? 0}</span>
          </div>
        </div>

        {localMode ? (
          <div className="banner-ok" style={{ fontSize: '0.83rem' }}>
            Running privately in <strong>Local Browser Mode</strong> on this device. Connect a Cloudflare Worker URL below whenever you want live multi-device sync and 5-AI MCP access.
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
            <RefreshCw size={13} strokeWidth={1.8} /> Sync Now
          </button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="btn-export-json" onClick={handleExportJson}>
            <Download size={13} strokeWidth={1.8} /> Export JSON
          </button>
          <button type="button" className="btn btn-sm" data-testid="btn-export-csv" onClick={handleExportCsv}>
            <Download size={13} strokeWidth={1.8} /> Export CSV
          </button>
          <button type="button" className="btn btn-sm" data-testid="btn-print-report" onClick={handlePrintReport}>
            <Printer size={13} strokeWidth={1.8} /> Print Report
          </button>
        </div>

        <details style={{ paddingTop: '0.4rem', borderTop: '1px solid var(--hair-subtle)' }}>
          <summary className="eyebrow" style={{ cursor: 'pointer' }}>
            Cloud Server URL &amp; Snapshots
          </summary>
          <div className="stack-sm" style={{ marginTop: '0.75rem' }}>
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
      <section className="atelier-card stack-sm" data-testid="settings-pin-lock">
        <div className="space-between">
          <div>
            <div className="eyebrow">PRIVACY SHIELD</div>
            <h2 className="display-sm" style={{ marginTop: 2 }}>Device PIN Lock</h2>
          </div>
          <span className={`pill mono ${pinCfg?.enabled ? 'pill-verified' : ''}`}>
            {pinCfg?.enabled ? 'Enabled' : 'Off'}
          </span>
        </div>

        <p className="muted" style={{ margin: 0 }}>
          Lock Home Pharmacy on this device with a local PIN (5 consecutive wrong attempts trigger a 30-second lockout).
        </p>

        {pinCfg?.enabled ? (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary btn-sm" onClick={onLockNow}>
              <Lock size={13} strokeWidth={1.8} /> Lock Now
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
        <article className="atelier-card stack-sm">
          <div className="space-between">
            <h2 className="display-sm">Home Pharmacy — Summary Report</h2>
            <button type="button" className="btn btn-sm no-print" onClick={() => setShowPrintReport(false)}>Hide</button>
          </div>
          <div className="banner-warn" style={{ fontSize: '0.83rem' }}>
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
