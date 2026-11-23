import React, { useMemo, useState } from 'react';
import {
  Plus,
  SlidersHorizontal,
  Sparkles,
  Syringe,
  Flame,
  Leaf,
  Droplets,
  Layers,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import {
  resolveEffectiveOwnership,
  CUSTOM_FIELD_TYPES,
  CANONICAL_ROUTES,
  CANONICAL_UNITS,
} from '../../core/index.js';
import { api } from '../lib/api.js';

const SECTION_META = {
  peptides: {
    short: 'Peptides',
    editorial: 'Peptides',
    Icon: Syringe,
    cls: 'sec-peptides',
  },
  peds: {
    short: 'PEDs',
    editorial: 'Performance',
    Icon: Flame,
    cls: 'sec-peds',
  },
  vitamins_supplements: {
    short: 'Vitamins',
    editorial: 'Vitamins & Minerals',
    Icon: Leaf,
    cls: 'sec-vitamins_supplements',
  },
  dermatology: {
    short: 'Dermatology',
    editorial: 'Skin & Hair',
    Icon: Droplets,
    cls: 'sec-dermatology',
  },
};

const OWN_CUE = {
  have: 'In Cabinet',
  wishlist: 'Wishlist',
  low_stock: 'Low Stock',
  ordered: 'On Order',
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
            <div className="eyebrow">NEW MONOGRAPH</div>
            <h2 className="display-sm" style={{ marginTop: 2 }}>Add Compound</h2>
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

        <form onSubmit={handleSubmit} className="stack-v">
          <div className="grid-2">
            <label className="field-label">
              Compound Name *
              <input
                type="text"
                name="name"
                placeholder="e.g., Epitalon, Creatine"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </label>

            <label className="field-label">
              Section
              <select name="sectionId" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid-2">
            <label className="field-label">
              Category / Group
              <input
                type="text"
                name="subsection"
                placeholder="e.g., Healing & Tissue, Retinoids"
                value={subsection}
                onChange={(e) => setSubsection(e.target.value)}
              />
            </label>

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
          </div>

          <label className="field-label">
            Summary (What It Is) *
            <textarea
              name="summary"
              rows={2}
              placeholder="Concise overview of what this compound is and why you use it…"
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
              placeholder="How it works biologically (receptors, pathways)…"
              value={mechanismOfAction}
              onChange={(e) => setMechanismOfAction(e.target.value)}
            />
          </label>

          <div className="grid-3">
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

            <label className="field-label">
              Frequency
              <input
                type="text"
                name="frequencyText"
                placeholder="Daily, 2x/wk"
                value={frequencyText}
                onChange={(e) => setFrequencyText(e.target.value)}
              />
            </label>
          </div>

          <div className="grid-3">
            <label className="field-label">
              Typical Range
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
                placeholder="~4 hours"
                value={halfLifeText}
                onChange={(e) => setHalfLifeText(e.target.value)}
              />
            </label>

            <label className="field-label">
              Cycle Pattern
              <input
                type="text"
                name="cycles"
                placeholder="8w on / 4w off"
                value={cycleText}
                onChange={(e) => setCycleText(e.target.value)}
              />
            </label>
          </div>

          {(selectedSection?.customFields || []).length > 0 ? (
            <div className="card-subtle stack-sm">
              <div className="eyebrow">Custom Section Fields</div>
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
            <h2 className="display-sm" style={{ marginTop: 2 }}>Customize {section.name}</h2>
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
            AI Research Instructions (synced to all 5 AIs)
            <textarea
              name="aiResearchPrompt"
              rows={3}
              value={aiResearchPrompt}
              onChange={(e) => setAiResearchPrompt(e.target.value)}
              placeholder="Custom criteria every AI must research when adding profiles to this section…"
            />
          </label>

          <div className="stack-sm">
            <div className="eyebrow">Active Custom Fields ({customFields.length})</div>
            {customFields.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No custom fields added yet.
              </p>
            ) : (
              <div className="stack-sm">
                {customFields.map((cf) => (
                  <div key={cf.key} className="card-subtle space-between">
                    <div>
                      <strong>{cf.label}</strong>{' '}
                      <span className="pill mono">{cf.key}</span>{' '}
                      <span className="pill">{cf.fieldType}</span>
                      {cf.required ? <span className="pill pill-accent">required</span> : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => handleRemoveField(cf.key)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card-subtle stack-sm">
            <div className="eyebrow">Add a Custom Field</div>
            <div className="grid-2">
              <label className="field-label">
                Field Label
                <input
                  type="text"
                  name="fieldLabel"
                  placeholder="e.g., COA Batch URL"
                  value={fieldLabel}
                  onChange={(e) => setFieldLabel(e.target.value)}
                />
              </label>
              <label className="field-label">
                Field Key
                <input
                  type="text"
                  name="fieldKey"
                  placeholder="e.g., coa_url"
                  value={fieldKey}
                  onChange={(e) => setFieldKey(e.target.value)}
                />
              </label>
            </div>
            <div className="grid-2">
              <label className="field-label">
                Type
                <select name="fieldType" value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
                  {CUSTOM_FIELD_TYPES.map((ft) => (
                    <option key={ft} value={ft}>
                      {ft}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label" style={{ justifyContent: 'flex-end' }}>
                Required
                <label className="toggle-chip" style={{ marginTop: 2 }}>
                  <input
                    type="checkbox"
                    checked={fieldRequired}
                    onChange={(e) => setFieldRequired(e.target.checked)}
                  />
                  <span>Must be filled</span>
                </label>
              </label>
            </div>
            {(fieldType === 'select' || fieldType === 'multiselect') ? (
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
                <Plus size={13} /> Add Field
              </button>
            </div>
          </div>

          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Template'}
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
  const [activeSectionId, setActiveSectionId] = useState(sections[0]?.id || 'peptides');
  const [ownershipFilter, setOwnershipFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCustomizeModal, setShowCustomizeModal] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const activeSection = sections.find((s) => s.id === activeSectionId) || sections[0];
  const activeMeta = SECTION_META[activeSection?.id] || {
    short: activeSection?.name || 'Library',
    editorial: activeSection?.name || 'Library',
    Icon: Layers,
    cls: 'sec-custom',
  };

  const countBySection = useMemo(() => {
    const map = {};
    for (const c of compounds || []) {
      map[c.sectionId] = (map[c.sectionId] || 0) + 1;
    }
    return map;
  }, [compounds]);

  const filteredCompounds = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase();
    return (compounds || []).filter((c) => {
      if (!q && activeSection && c.sectionId !== activeSection.id) return false;
      const eff = resolveEffectiveOwnership(c.id, activeMemberId, ownership || []);
      const ownStatus = eff?.status || 'dont_have';
      if (ownershipFilter !== 'all' && ownStatus !== ownershipFilter) return false;
      if (statusFilter !== 'all' && c.profileStatus !== statusFilter) return false;
      if (q) {
        const hay = [
          c.name,
          c.slug,
          c.subsection,
          c.summary,
          c.mechanismOfAction,
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
  }, [compounds, ownership, activeMemberId, activeSection, ownershipFilter, statusFilter, searchQuery]);

  // Group compounds cleanly by subsection for Aesop/Protocol-OS porcelain sheets
  const groupedCompounds = useMemo(() => {
    const groups = new Map();
    for (const c of filteredCompounds) {
      const key = (c.subsection || '').trim() || 'General Monographs';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return [...groups.entries()];
  }, [filteredCompounds]);

  const handleSeedStarter = async () => {
    setSeeding(true);
    try {
      await api.post('/api/v1/seed/starter', {});
      await onRefresh();
    } finally {
      setSeeding(false);
    }
  };

  const formatMetaLine = (cmp) => {
    const parts = [];
    if (cmp.dosages?.route) parts.push(cmp.dosages.route);
    if (cmp.dosages?.defaultAmount != null && cmp.dosages?.defaultUnit) {
      parts.push(`${cmp.dosages.defaultAmount} ${cmp.dosages.defaultUnit}`);
    } else if (cmp.dosages?.rangeText) {
      parts.push(cmp.dosages.rangeText.split('(')[0].split(',')[0].trim().slice(0, 24));
    }
    if (typeof cmp.halfLife?.valueHours === 'number' && Number.isFinite(cmp.halfLife.valueHours)) {
      const h = cmp.halfLife.valueHours;
      parts.push(h >= 48 ? `t½ ~${Number((h / 24).toFixed(1))}d` : `t½ ~${Number(h.toFixed(1))}h`);
    } else if (cmp.dosages?.frequencyText) {
      parts.push(cmp.dosages.frequencyText);
    }
    return parts.join('  ·  ');
  };

  return (
    <div className="stack-v">
      {/* Editorial Monumental Header */}
      <div className="space-between" style={{ alignItems: 'flex-end', paddingTop: '0.2rem' }}>
        <div>
          <div className="eyebrow">
            {searchQuery.trim()
              ? `SEARCH · ${filteredCompounds.length} MATCHES`
              : `APOTHECARY · ${(compounds || []).length} MONOGRAPHS`}
          </div>
          <h1 className="editorial-title" style={{ marginTop: 6 }}>
            {searchQuery.trim() ? `“${searchQuery.trim()}”` : activeMeta.editorial}
          </h1>
          {activeSection?.description && !searchQuery.trim() ? (
            <p className="italic-sub" style={{ margin: '0.3rem 0 0' }}>
              {activeSection.description}
            </p>
          ) : null}
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-sm"
            data-testid="btn-customize-section"
            onClick={() => setShowCustomizeModal(true)}
          >
            <SlidersHorizontal size={13} strokeWidth={1.8} /> Customize
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="btn-add-compound"
            onClick={() => setShowAddModal(true)}
          >
            <Plus size={14} strokeWidth={2} /> Add Compound
          </button>
        </div>
      </div>

      {/* Organic Floating Category Pills + Whisper Filters */}
      <div className="space-between" style={{ gap: '0.65rem' }}>
        <div className="cat-pills" role="tablist" aria-label="Health sections">
          {(sections || []).map((sec) => {
            const meta = SECTION_META[sec.id] || { short: sec.name, Icon: Layers };
            const SecIcon = meta.Icon;
            const active = activeSection?.id === sec.id;
            return (
              <button
                key={sec.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={sec.name}
                data-testid={`section-tab-${sec.id}`}
                className={`cat-pill${active ? ' active' : ''}`}
                onClick={() => setActiveSectionId(sec.id)}
              >
                <SecIcon size={13} strokeWidth={1.8} />
                <span>{meta.short}</span>
                <span className="pill-num">{countBySection[sec.id] || 0}</span>
              </button>
            );
          })}
        </div>

        <div className="row-wrap" style={{ gap: '0.4rem' }}>
          <div className="select-pill ghost">
            <select
              data-testid="filter-ownership"
              aria-label="Filter by ownership"
              value={ownershipFilter}
              onChange={(e) => setOwnershipFilter(e.target.value)}
            >
              <option value="all">All Stock</option>
              <option value="have">have</option>
              <option value="dont_have">dont_have</option>
              <option value="wishlist">wishlist</option>
              <option value="low_stock">low_stock</option>
              <option value="ordered">ordered</option>
            </select>
            <ChevronDown size={12} strokeWidth={1.8} className="sel-chev" aria-hidden="true" />
          </div>

          <div className="select-pill ghost">
            <select
              data-testid="filter-status"
              aria-label="Filter by verification status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All Profiles</option>
              <option value="verified">verified</option>
              <option value="ai_draft">ai_draft</option>
              <option value="needs_review">needs_review</option>
            </select>
            <ChevronDown size={12} strokeWidth={1.8} className="sel-chev" aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* Sculptural Porcelain Grouped Compound Index */}
      {filteredCompounds.length === 0 ? (
        <div className="atelier-card stack-sm" style={{ textAlign: 'center', padding: '3rem 1.5rem', alignItems: 'center' }}>
          <Sparkles size={26} strokeWidth={1.5} color="var(--accent)" />
          <h2 className="display-sm" style={{ marginTop: 4 }}>
            {(compounds || []).length === 0 ? 'Your Apothecary Is Ready' : 'No Matching Monographs'}
          </h2>
          <p className="muted" style={{ margin: 0, maxWidth: 440 }}>
            {(compounds || []).length === 0
              ? 'Load the 26-compound Starter Reference Library across Peptides, PEDs, Vitamins, and Dermatology, or author your first monograph.'
              : 'Clear your search or filters to browse every compound in this discipline.'}
          </p>
          {(compounds || []).length === 0 ? (
            <div className="row-wrap" style={{ marginTop: '0.75rem', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={seeding}
                onClick={handleSeedStarter}
              >
                <Sparkles size={14} strokeWidth={1.8} /> {seeding ? 'Loading Library…' : 'Load 26 Starter Monographs'}
              </button>
              <button type="button" className="btn" onClick={() => setShowAddModal(true)}>
                <Plus size={14} /> Add Compound
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="stack-v" style={{ gap: '1.35rem' }}>
          {groupedCompounds.map(([groupName, groupItems]) => (
            <section key={groupName}>
              <div className="section-h">
                <span>{groupName}</span>
                <span className="sh-count">{String(groupItems.length).padStart(2, '0')}</span>
              </div>

              <div className="list-sheet">
                {groupItems.map((cmp) => {
                  const effOwn = resolveEffectiveOwnership(cmp.id, activeMemberId, ownership || []);
                  const ownStatus = effOwn?.status || 'dont_have';
                  const secMeta = SECTION_META[cmp.sectionId] || { Icon: Layers, cls: 'sec-custom' };
                  const RowIcon = secMeta.Icon;
                  const metaLine = formatMetaLine(cmp);
                  const ownLabel = OWN_CUE[ownStatus] || '';
                  const isDraft = cmp.profileStatus && cmp.profileStatus !== 'verified';

                  return (
                    <article
                      key={cmp.id}
                      className="list-row clickable compound-card"
                      data-testid={`compound-card-${cmp.id}`}
                      data-slug={cmp.slug}
                      onClick={() => onSelectCompound(cmp.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectCompound(cmp.id);
                        }
                      }}
                    >
                      <div className={`row-medallion ${secMeta.cls}`} aria-hidden="true">
                        <RowIcon size={17} strokeWidth={1.7} />
                      </div>

                      <div className="row-body">
                        <div className="row-title">{cmp.name}</div>
                        {metaLine ? <div className="row-meta">{metaLine}</div> : null}
                        {cmp.summary ? <div className="row-desc">{cmp.summary}</div> : null}
                      </div>

                      <div className="row-trailing">
                        {ownLabel ? (
                          <span className={`status-cue ${ownStatus}`}>
                            <span className="dot" />
                            {ownLabel}
                          </span>
                        ) : null}
                        {isDraft ? (
                          <span className="status-cue ai_draft">
                            <span className="dot" />
                            {cmp.profileStatus === 'ai_draft' ? 'AI Draft' : 'Review'}
                          </span>
                        ) : null}
                        <ChevronRight size={16} strokeWidth={1.6} className="row-chevron" aria-hidden="true" />
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
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
