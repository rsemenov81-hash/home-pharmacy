import React, { useMemo, useState } from 'react';
import {
  Plus,
  SlidersHorizontal,
  CheckCircle2,
  Sparkles,
  Syringe,
  Flame,
  Pill,
  Droplets,
  Layers,
  Clock,
} from 'lucide-react';
import {
  resolveEffectiveOwnership,
  CUSTOM_FIELD_TYPES,
  CANONICAL_ROUTES,
  CANONICAL_UNITS,
} from '../../core/index.js';
import { api } from '../lib/api.js';

const SECTION_META = {
  peptides: { short: 'Peptides', Icon: Syringe },
  peds: { short: 'PEDs', Icon: Flame },
  vitamins_supplements: { short: 'Vitamins', Icon: Pill },
  dermatology: { short: 'Dermatology', Icon: Droplets },
};

const OWN_LABEL = {
  have: 'In Cabinet',
  dont_have: "Don't Have",
  wishlist: 'Wishlist',
  low_stock: 'Low Stock',
  ordered: 'Ordered',
};

function AddCompoundModal({ section, sections, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [sectionId, setSectionId] = useState(section?.id || 'peptides');
  const [subsection, setSubsection] = useState('');
  const [summary, setSummary] = useState('');
  const [mechanismOfAction, setMechanismOfAction] = useState('');
  const [route, setRoute] = useState(
    sectionId === 'dermatology' ? 'Topical' : sectionId === 'vitamins_supplements' ? 'Oral' : 'SubQ',
  );
  const [defaultAmount, setDefaultAmount] = useState('');
  const [defaultUnit, setDefaultUnit] = useState(sectionId === 'peptides' ? 'mcg' : 'mg');
  const [rangeText, setRangeText] = useState('');
  const [frequencyText, setFrequencyText] = useState('Daily');
  const [halfLifeText, setHalfLifeText] = useState('');
  const [cycleText, setCycleText] = useState('');
  const [customValues, setCustomValues] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedSection = sections.find((s) => s.id === sectionId) || section;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Compound name is required.');
      return;
    }
    if (!summary.trim()) {
      setError('Summary (what it is) is required.');
      return;
    }
    const amtNum = defaultAmount !== '' ? Number(defaultAmount) : null;
    if (defaultAmount !== '' && (!Number.isFinite(amtNum) || amtNum <= 0)) {
      setError('Default dose amount must be a positive number.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        sectionId,
        subsection: subsection.trim(),
        summary: summary.trim(),
        mechanismOfAction: mechanismOfAction.trim(),
        dosages: {
          rangeText: rangeText.trim() || (amtNum ? `${amtNum} ${defaultUnit}` : ''),
          defaultAmount: amtNum,
          defaultUnit,
          route,
          frequencyText: frequencyText.trim() || 'Daily',
        },
        halfLife: {
          displayText: halfLifeText.trim() || 'See monograph',
          kind: 'unmodeled',
        },
        cycles: {
          patternText: cycleText.trim() || 'Continuous',
          continuous: !cycleText.trim(),
        },
        customFields: customValues,
        profileStatus: 'ai_draft',
      };
      const res = await api.post('/api/v1/compounds', payload);
      await onCreated(res.json?.compound || res.json);
      onClose();
    } catch (err) {
      setError(err.message || 'Please check the required fields and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add Compound">
      <div className="modal-card stack-v">
        <div className="space-between">
          <div>
            <div className="eyebrow">NEW PROFILE</div>
            <h2 className="display-sm">Add Compound</h2>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <div className="banner-danger" role="alert">
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="stack-v" noValidate>
          <div className="grid-2">
            <label className="field-label">
              Compound Name *
              <input
                type="text"
                name="name"
                placeholder="e.g., BPC-157, Tretinoin 0.05%"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Section *
              <select
                name="sectionId"
                value={sectionId}
                onChange={(e) => {
                  const next = e.target.value;
                  setSectionId(next);
                  setRoute(next === 'dermatology' ? 'Topical' : next === 'vitamins_supplements' ? 'Oral' : 'SubQ');
                }}
              >
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field-label">
            What It Is (Summary) *
            <textarea
              name="summary"
              rows={2}
              placeholder="Concise overview of this compound and primary purpose…"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
            />
          </label>

          <label className="field-label">
            Mechanism of Action
            <textarea
              name="mechanismOfAction"
              rows={2}
              placeholder="Receptors, biological pathway, or topical action…"
              value={mechanismOfAction}
              onChange={(e) => setMechanismOfAction(e.target.value)}
            />
          </label>

          <div className="grid-3">
            <label className="field-label">
              Route
              <select name="route" value={route} onChange={(e) => setRoute(e.target.value)}>
                {CANONICAL_ROUTES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Default Dose
              <input
                type="number"
                step="any"
                name="defaultAmount"
                placeholder="250"
                value={defaultAmount}
                onChange={(e) => setDefaultAmount(e.target.value)}
              />
            </label>
            <label className="field-label">
              Unit
              <select name="defaultUnit" value={defaultUnit} onChange={(e) => setDefaultUnit(e.target.value)}>
                {CANONICAL_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid-3">
            <label className="field-label">
              Dosage Range
              <input
                type="text"
                name="rangeText"
                placeholder="250–500 mcg"
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
              />
            </label>
            <label className="field-label">
              Half-Life
              <input
                type="text"
                name="halfLife"
                placeholder="e.g., ~4–6 hours"
                value={halfLifeText}
                onChange={(e) => setHalfLifeText(e.target.value)}
              />
            </label>
            <label className="field-label">
              Cycle Pattern
              <input
                type="text"
                name="cycles"
                placeholder="8 weeks on / 4 off"
                value={cycleText}
                onChange={(e) => setCycleText(e.target.value)}
              />
            </label>
          </div>

          <div className="grid-2">
            <label className="field-label">
              Category / Subsection
              <input
                type="text"
                name="subsection"
                placeholder="Optional category"
                value={subsection}
                onChange={(e) => setSubsection(e.target.value)}
              />
            </label>
            <label className="field-label">
              Frequency
              <input
                type="text"
                name="frequencyText"
                placeholder="Daily, 3x/week, AM/PM…"
                value={frequencyText}
                onChange={(e) => setFrequencyText(e.target.value)}
              />
            </label>
          </div>

          {(selectedSection?.customFields || []).length > 0 ? (
            <div className="card-subtle stack-sm">
              <div className="eyebrow">CUSTOM SECTION FIELDS</div>
              <div className="grid-2">
                {selectedSection.customFields.map((cf) => (
                  <label key={cf.key} className="field-label">
                    {cf.label}
                    {cf.required ? ' *' : ''}
                    <input
                      type={cf.fieldType === 'number' ? 'number' : cf.fieldType === 'url' ? 'url' : 'text'}
                      name={`custom_${cf.key}`}
                      placeholder={cf.aiResearchInstruction || cf.label}
                      value={customValues[cf.key] ?? ''}
                      onChange={(e) =>
                        setCustomValues((prev) => ({
                          ...prev,
                          [cf.key]: cf.fieldType === 'number' ? Number(e.target.value) : e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" data-testid="btn-save-compound" disabled={saving}>
              {saving ? 'Saving…' : 'Save Compound'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CustomizeSectionModal({ section, onClose, onSaved }) {
  const [aiResearchPrompt, setAiResearchPrompt] = useState(section.aiResearchPrompt || '');
  const [customFields, setCustomFields] = useState(section.customFields || []);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldType, setFieldType] = useState('text');
  const [fieldRequired, setFieldRequired] = useState(false);
  const [fieldOptions, setFieldOptions] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAddField = () => {
    setError('');
    const key = (fieldKey || fieldLabel)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const label = fieldLabel.trim() || key;
    if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) {
      setError('Field key must start with a letter and use lowercase letters, numbers, or underscores.');
      return;
    }
    if (customFields.some((f) => f.key === key)) {
      setError(`Field "${key}" already exists.`);
      return;
    }
    const def = {
      key,
      label,
      fieldType,
      required: fieldRequired,
      showOnCard: true,
    };
    if (fieldType === 'select' || fieldType === 'multiselect') {
      const opts = fieldOptions.split(',').map((s) => s.trim()).filter(Boolean);
      if (opts.length === 0) {
        setError('Provide comma-separated options for select fields.');
        return;
      }
      def.options = opts;
    }
    setCustomFields([...customFields, def]);
    setFieldKey('');
    setFieldLabel('');
    setFieldOptions('');
    setFieldRequired(false);
  };

  const handleRemoveField = (key) => {
    setCustomFields(customFields.filter((f) => f.key !== key));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      let nextFields = [...customFields];
      if (fieldKey.trim() || fieldLabel.trim()) {
        const key = (fieldKey || fieldLabel)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (key && /^[a-z][a-z0-9_]*$/.test(key) && !nextFields.some((f) => f.key === key)) {
          const def = {
            key,
            label: fieldLabel.trim() || key,
            fieldType,
            required: fieldRequired,
            showOnCard: true,
          };
          if (fieldType === 'select' || fieldType === 'multiselect') {
            const opts = fieldOptions.split(',').map((s) => s.trim()).filter(Boolean);
            if (opts.length > 0) def.options = opts;
          }
          nextFields.push(def);
        }
      }
      await api.patch(`/api/v1/sections/${encodeURIComponent(section.id)}`, {
        aiResearchPrompt,
        customFields: nextFields,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save section changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Customize ${section.name}`}>
      <div className="modal-card stack-v">
        <div className="space-between">
          <div>
            <div className="eyebrow">SECTION TEMPLATE</div>
            <h2 className="display-sm">Customize {section.name}</h2>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <div className="banner-danger" role="alert">
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSave} className="stack-v">
          <label className="field-label">
            AI Research Instructions for This Section
            <textarea
              name="aiResearchPrompt"
              rows={3}
              value={aiResearchPrompt}
              onChange={(e) => setAiResearchPrompt(e.target.value)}
              placeholder="Tell your AIs what specific details to fill out for compounds in this section…"
            />
          </label>

          <div className="stack-sm">
            <div className="eyebrow">CUSTOM FIELDS ({customFields.length})</div>
            {customFields.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No custom fields added yet. Add any extra data you want tracked for this section.
              </p>
            ) : (
              customFields.map((f) => (
                <div key={f.key} className="card-subtle space-between">
                  <div>
                    <strong>{f.label}</strong>{' '}
                    <span className="pill num">{f.key}</span>{' '}
                    <span className="pill">{f.fieldType}</span>
                    {f.required ? <span className="pill pill-accent" style={{ marginLeft: 4 }}>Required</span> : null}
                  </div>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => handleRemoveField(f.key)}>
                    Archive
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="card-subtle stack-sm">
            <div className="eyebrow">ADD FIELD</div>
            <div className="grid-2">
              <label className="field-label">
                Field Key
                <input
                  type="text"
                  name="fieldKey"
                  placeholder="e.g., batch_number"
                  value={fieldKey}
                  onChange={(e) => setFieldKey(e.target.value)}
                />
              </label>
              <label className="field-label">
                Display Label
                <input
                  type="text"
                  name="fieldLabel"
                  placeholder="e.g., Batch Number"
                  value={fieldLabel}
                  onChange={(e) => setFieldLabel(e.target.value)}
                />
              </label>
            </div>
            <div className="grid-2">
              <label className="field-label">
                Type
                <select name="fieldType" value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
                  {CUSTOM_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle-chip" style={{ alignSelf: 'end', height: 40 }}>
                <input
                  type="checkbox"
                  checked={fieldRequired}
                  onChange={(e) => setFieldRequired(e.target.checked)}
                />
                <span>Required field</span>
              </label>
            </div>
            {fieldType === 'select' || fieldType === 'multiselect' ? (
              <label className="field-label">
                Options (comma-separated)
                <input
                  type="text"
                  placeholder="Option A, Option B"
                  value={fieldOptions}
                  onChange={(e) => setFieldOptions(e.target.value)}
                />
              </label>
            ) : null}
            <div>
              <button type="button" className="btn btn-sm" onClick={handleAddField}>
                + Add Field
              </button>
            </div>
          </div>

          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Section'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SectionsView({
  sections,
  compounds,
  ownership,
  activeMemberId,
  searchQuery,
  onSelectCompound,
  onRefresh,
}) {
  const [activeSectionId, setActiveSectionId] = useState('peptides');
  const [ownershipFilter, setOwnershipFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCustomizeModal, setShowCustomizeModal] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const activeSection = useMemo(
    () => sections.find((s) => s.id === activeSectionId) || sections[0] || null,
    [sections, activeSectionId],
  );

  const countBySection = useMemo(() => {
    const m = {};
    for (const c of compounds || []) {
      m[c.sectionId] = (m[c.sectionId] || 0) + 1;
    }
    return m;
  }, [compounds]);

  const filteredCompounds = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase();
    return (compounds || []).filter((c) => {
      if (!q && activeSection && c.sectionId !== activeSection.id) return false;
      if (statusFilter !== 'all' && c.profileStatus !== statusFilter) return false;
      if (ownershipFilter !== 'all') {
        const eff = resolveEffectiveOwnership(c.id, activeMemberId, ownership || []);
        const st = eff?.status || 'dont_have';
        if (st !== ownershipFilter) return false;
      }
      if (q) {
        const hay = [
          c.name,
          c.slug,
          c.summary,
          c.mechanismOfAction,
          c.subsection,
          c.notes,
          ...(c.aliases || []),
          ...(c.tags || []),
          ...(c.useCaseScenarios || []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [compounds, activeSection, ownershipFilter, statusFilter, activeMemberId, ownership, searchQuery]);

  const handleSeedStarter = async () => {
    setSeeding(true);
    try {
      await api.post('/api/v1/seed/starter', {});
      await onRefresh();
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="stack-v">
      {/* Clean iOS Large Header */}
      <div className="space-between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">
            {searchQuery.trim() ? 'GLOBAL SEARCH' : 'COMPOUND LIBRARY'}
          </div>
          <h1 className="display-title" style={{ marginTop: 4 }}>
            {searchQuery.trim() ? `“${searchQuery}”` : activeSection?.name || 'Health Library'}
          </h1>
          <p className="muted" style={{ margin: '0.3rem 0 0', maxWidth: 620 }}>
            {activeSection?.description || 'Curated profiles across peptides, PEDs, vitamins & supplements, and dermatology.'}
          </p>
        </div>

        <div className="row-wrap">
          {activeSection ? (
            <button
              type="button"
              className="btn btn-sm"
              data-testid="btn-customize-section"
              onClick={() => setShowCustomizeModal(true)}
            >
              <SlidersHorizontal size={14} /> Customize
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-add-compound"
            onClick={() => setShowAddModal(true)}
          >
            <Plus size={15} /> Add Compound
          </button>
        </div>
      </div>

      {/* Segmented Section Tabs + Compact Filters */}
      <div className="space-between">
        <div className="section-tabs" role="tablist" aria-label="Health Sections">
          {(sections || []).map((sec) => {
            const meta = SECTION_META[sec.id] || { short: sec.name, Icon: Layers };
            const Icon = meta.Icon;
            const cnt = countBySection[sec.id] || 0;
            return (
              <button
                key={sec.id}
                type="button"
                role="tab"
                aria-selected={activeSection?.id === sec.id}
                data-testid={`section-tab-${sec.id}`}
                className={`tab-btn${activeSection?.id === sec.id ? ' active' : ''}`}
                onClick={() => setActiveSectionId(sec.id)}
              >
                <Icon size={14} />
                <span>{sec.name}</span>
                {cnt > 0 ? <span className="tab-count">{cnt}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="row-wrap">
          <select
            data-testid="filter-ownership"
            aria-label="Filter by ownership"
            value={ownershipFilter}
            onChange={(e) => setOwnershipFilter(e.target.value)}
            style={{ padding: '0.42rem 0.7rem', fontSize: '0.82rem' }}
          >
            <option value="all">All Stock</option>
            <option value="have">In Cabinet</option>
            <option value="dont_have">Don&apos;t Have</option>
            <option value="wishlist">Wishlist</option>
            <option value="low_stock">Low Stock</option>
            <option value="ordered">Ordered</option>
          </select>

          <select
            data-testid="filter-status"
            aria-label="Filter by review status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '0.42rem 0.7rem', fontSize: '0.82rem' }}
          >
            <option value="all">All Profiles</option>
            <option value="verified">Verified</option>
            <option value="ai_draft">AI Draft</option>
            <option value="needs_review">Needs Review</option>
          </select>
        </div>
      </div>

      {/* Compound Grid */}
      {filteredCompounds.length === 0 ? (
        <div className="glass stack-v" style={{ textAlign: 'center', padding: '2.6rem 1.4rem', alignItems: 'center' }}>
          <div className="eyebrow">
            {(compounds || []).length === 0 ? 'GET STARTED' : 'NO MATCHES'}
          </div>
          <h2 className="display-sm">
            {(compounds || []).length === 0 ? 'Your Library Is Ready' : 'Nothing matches this filter'}
          </h2>
          <p className="muted" style={{ margin: 0, maxWidth: 460 }}>
            {(compounds || []).length === 0
              ? 'Load 26 curated reference profiles across Peptides, PEDs, Vitamins, and Dermatology — or add your first compound.'
              : 'Try switching sections, clearing search, or resetting your stock filter.'}
          </p>
          {(compounds || []).length === 0 ? (
            <div className="row-wrap" style={{ justifyContent: 'center', marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={seeding}
                onClick={handleSeedStarter}
              >
                <Sparkles size={15} /> {seeding ? 'Loading Library…' : 'Load 26 Starter Reference Profiles'}
              </button>
              <button type="button" className="btn" onClick={() => setShowAddModal(true)}>
                <Plus size={15} /> Add Compound
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid-3">
          {filteredCompounds.map((cmp) => {
            const effOwn = resolveEffectiveOwnership(cmp.id, activeMemberId, ownership || []);
            const ownStatus = effOwn?.status || 'dont_have';
            const shortDose =
              cmp.dosages?.defaultAmount != null && cmp.dosages?.defaultUnit
                ? `${cmp.dosages.defaultAmount} ${cmp.dosages.defaultUnit}`
                : (cmp.dosages?.rangeText || '').split('(')[0].split(',')[0].trim().slice(0, 24);
            const shortHl =
              typeof cmp.halfLife?.valueHours === 'number' && Number.isFinite(cmp.halfLife.valueHours)
                ? cmp.halfLife.valueHours >= 48
                  ? `t½ ~${Number((cmp.halfLife.valueHours / 24).toFixed(1))}d`
                  : `t½ ~${Number(cmp.halfLife.valueHours.toFixed(1))}h`
                : cmp.halfLife?.displayText
                  ? cmp.halfLife.displayText.split('(')[0].split('—')[0].trim().slice(0, 18)
                  : '';
            return (
              <article
                key={cmp.id}
                className="card compound-card"
                data-testid={`compound-card-${cmp.id}`}
                data-slug={cmp.slug}
                onClick={() => onSelectCompound(cmp.id)}
              >
                <div className="space-between" style={{ alignItems: 'flex-start', gap: '0.4rem' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 style={{ fontSize: '1rem', lineHeight: 1.25 }}>{cmp.name}</h3>
                    {cmp.subsection ? (
                      <div className="dim" style={{ marginTop: 2 }}>{cmp.subsection}</div>
                    ) : null}
                  </div>
                  <span className={`pill pill-${ownStatus}`}>
                    {OWN_LABEL[ownStatus] || ownStatus}
                  </span>
                </div>

                <p className="muted clamp-2" style={{ margin: 0 }}>
                  {cmp.summary || cmp.mechanismOfAction || 'Tap to view full monograph.'}
                </p>

                <div className="row-wrap" style={{ marginTop: 'auto', paddingTop: '0.45rem', borderTop: '1px solid var(--border-subtle)' }}>
                  {shortDose ? (
                    <span className="pill pill-accent num">{shortDose}</span>
                  ) : null}
                  {cmp.dosages?.route ? (
                    <span className="pill">{cmp.dosages.route}</span>
                  ) : null}
                  {shortHl ? (
                    <span className="pill num">
                      <Clock size={10} /> {shortHl}
                    </span>
                  ) : null}
                  {cmp.profileStatus !== 'verified' ? (
                    <span className={`pill pill-${cmp.profileStatus}`}>
                      <Sparkles size={10} /> {cmp.profileStatus === 'ai_draft' ? 'AI Draft' : 'Review'}
                    </span>
                  ) : (
                    <span className="pill pill-verified" title="Verified">
                      <CheckCircle2 size={10} /> Verified
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showAddModal && activeSection ? (
        <AddCompoundModal
          section={activeSection}
          sections={sections}
          onClose={() => setShowAddModal(false)}
          onCreated={async () => {
            await onRefresh();
          }}
        />
      ) : null}

      {showCustomizeModal && activeSection ? (
        <CustomizeSectionModal
          section={activeSection}
          onClose={() => setShowCustomizeModal(false)}
          onSaved={onRefresh}
        />
      ) : null}
    </div>
  );
}
