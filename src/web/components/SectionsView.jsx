import React, { useMemo, useState } from 'react';
import { Plus, SlidersHorizontal, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react';
import { resolveEffectiveOwnership, CUSTOM_FIELD_TYPES, CANONICAL_ROUTES, CANONICAL_UNITS } from '../../core/index.js';
import { api } from '../lib/api.js';

function AddCompoundModal({ section, sections, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [sectionId, setSectionId] = useState(section?.id || 'peptides');
  const [subsection, setSubsection] = useState('');
  const [summary, setSummary] = useState('');
  const [mechanismOfAction, setMechanismOfAction] = useState('');
  const [route, setRoute] = useState(sectionId === 'dermatology' ? 'Topical' : sectionId === 'vitamins_supplements' ? 'Oral' : 'SubQ');
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
      setError(err.message || 'Validation failed — please check required fields.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add Compound">
      <div className="modal-card stack-v">
        <div className="space-between">
          <h2 style={{ margin: 0, color: 'var(--gold)' }}>Add Compound Profile</h2>
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
                placeholder="e.g., BPC-157, Thymosin Alpha-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Section *
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
              Subsection
              <input
                type="text"
                name="subsection"
                placeholder="e.g., Healing & Tissue"
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
            Summary (What it is) *
            <textarea
              name="summary"
              rows={2}
              placeholder="Concise description of the compound and primary purpose"
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
              placeholder="Receptors, enzymes, or signaling pathways"
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
                value={frequencyText}
                onChange={(e) => setFrequencyText(e.target.value)}
              />
            </label>
          </div>

          <div className="grid-3">
            <label className="field-label">
              Dosage Range
              <input type="text" name="rangeText" placeholder="250-500 mcg" value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
            </label>
            <label className="field-label">
              Half-Life
              <input type="text" name="halfLife" placeholder="~4 hours" value={halfLifeText} onChange={(e) => setHalfLifeText(e.target.value)} />
            </label>
            <label className="field-label">
              Cycle Pattern
              <input type="text" name="cycles" placeholder="6 weeks on, 2 off" value={cycleText} onChange={(e) => setCycleText(e.target.value)} />
            </label>
          </div>

          {(selectedSection?.customFields || []).length > 0 ? (
            <div className="stack-v">
              <strong style={{ fontSize: '0.85rem', color: 'var(--gold)' }}>Section Custom Fields</strong>
              {selectedSection.customFields.map((cf) => (
                <label key={cf.key} className="field-label">
                  {cf.label} {cf.required ? '*' : ''}
                  <input
                    type={cf.fieldType === 'number' ? 'number' : cf.fieldType === 'url' ? 'url' : 'text'}
                    name={`custom_${cf.key}`}
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
  const [subsections, setSubsections] = useState(section.subsections || []);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState('text');
  const [newOptions, setNewOptions] = useState('');
  const [newRequired, setNewRequired] = useState(false);
  const [newSub, setNewSub] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAddField = () => {
    setError('');
    const key = (newKey || newLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).trim();
    const label = (newLabel || newKey).trim();
    if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) {
      setError('Custom field key must start with a lowercase letter and use only a-z, 0-9, _.');
      return;
    }
    if (!label) {
      setError('Custom field label is required.');
      return;
    }
    const def = {
      key,
      label,
      fieldType: newType,
      required: newRequired,
      showOnCard: true,
    };
    if (newType === 'select' || newType === 'multiselect') {
      const opts = newOptions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.length === 0) {
        setError('Select/multiselect fields require comma-separated options.');
        return;
      }
      def.options = opts;
    }
    setCustomFields((prev) => [...prev.filter((f) => f.key !== key), def]);
    setNewKey('');
    setNewLabel('');
    setNewOptions('');
    setNewRequired(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    // If user typed a new field into the inputs and clicked Save directly without clicking Add Field first, include it!
    let finalFields = [...customFields];
    if (newKey.trim() || newLabel.trim()) {
      const key = (newKey.trim() || newLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
      const label = (newLabel.trim() || newKey.trim());
      if (key && /^[a-z][a-z0-9_]*$/.test(key) && label && !finalFields.some((f) => f.key === key)) {
        const def = { key, label, fieldType: newType, required: newRequired, showOnCard: true };
        if (newType === 'select' || newType === 'multiselect') {
          def.options = newOptions.split(',').map((s) => s.trim()).filter(Boolean);
        }
        finalFields.push(def);
      }
    }

    let finalSubs = [...subsections];
    if (newSub.trim() && !finalSubs.includes(newSub.trim())) {
      finalSubs.push(newSub.trim());
    }

    setSaving(true);
    try {
      await api.patch(`/api/v1/sections/${encodeURIComponent(section.id)}`, {
        aiResearchPrompt,
        customFields: finalFields,
        subsections: finalSubs,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to update section configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Customize ${section.name} Section`}>
      <div className="modal-card stack-v">
        <div className="space-between">
          <h2 style={{ margin: 0, color: 'var(--gold)' }}>Customize Section: {section.name}</h2>
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
            AI Research Prompt (injected into MCP &amp; AI Prompt Builder)
            <textarea
              name="aiResearchPrompt"
              rows={3}
              value={aiResearchPrompt}
              onChange={(e) => setAiResearchPrompt(e.target.value)}
            />
          </label>

          <div className="stack-v" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <strong style={{ color: 'var(--gold)' }}>Custom Fields ({customFields.length})</strong>
            {customFields.map((f) => (
              <div key={f.key} className="space-between" style={{ padding: '0.35rem 0.5rem', background: 'var(--bg-card)', borderRadius: 8 }}>
                <span>
                  <strong>{f.label}</strong> <code>({f.key}: {f.fieldType})</code>
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setCustomFields((prev) => prev.filter((x) => x.key !== f.key))}
                >
                  Remove
                </button>
              </div>
            ))}

            <div className="grid-2">
              <label className="field-label">
                Field Label
                <input
                  type="text"
                  name="fieldLabel"
                  placeholder="e.g., Third-Party Lab"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                />
              </label>
              <label className="field-label">
                Field Key
                <input
                  type="text"
                  name="fieldKey"
                  placeholder="e.g., third_party_lab"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                />
              </label>
            </div>
            <div className="grid-2">
              <label className="field-label">
                Field Type
                <select name="fieldType" value={newType} onChange={(e) => setNewType(e.target.value)}>
                  {CUSTOM_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label" style={{ justifyContent: 'flex-end' }}>
                <span className="row-wrap">
                  <input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} />
                  Required field
                </span>
              </label>
            </div>
            {(newType === 'select' || newType === 'multiselect') ? (
              <label className="field-label">
                Options (comma-separated)
                <input type="text" value={newOptions} onChange={(e) => setNewOptions(e.target.value)} placeholder="Option A, Option B" />
              </label>
            ) : null}
            <div>
              <button type="button" className="btn btn-sm" onClick={handleAddField}>
                + Add Custom Field
              </button>
            </div>
          </div>

          <label className="field-label">
            Add Subsection
            <div className="row-wrap">
              <input
                type="text"
                name="subsection"
                placeholder="New subsection name"
                value={newSub}
                onChange={(e) => setNewSub(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (newSub.trim() && !subsections.includes(newSub.trim())) {
                    setSubsections((p) => [...p, newSub.trim()]);
                    setNewSub('');
                  }
                }}
              >
                Add
              </button>
            </div>
          </label>

          <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Section Schema'}
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

  const activeSection = useMemo(
    () => sections.find((s) => s.id === activeSectionId) || sections[0] || null,
    [sections, activeSectionId],
  );

  const filteredCompounds = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase();
    return (compounds || []).filter((c) => {
      // When global search is active, search across ALL sections; otherwise filter by active section
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

  return (
    <div className="stack-v">
      <div className="space-between">
        <div>
          <h1 style={{ margin: 0, fontSize: '1.45rem' }}>
            {searchQuery.trim() ? `Search Results: "${searchQuery}"` : activeSection?.name || 'Health Sections'}
          </h1>
          <p className="muted" style={{ margin: '0.2rem 0 0' }}>
            {activeSection?.description || 'Shared household compound reference catalog across all sections.'}
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
              <SlidersHorizontal size={14} /> Customize Section
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

      {/* 4 Core Sections + Custom Section Tabs */}
      <div className="section-tabs" role="tablist" aria-label="Health Sections">
        {(sections || []).map((sec) => {
          const count = (compounds || []).filter((c) => c.sectionId === sec.id).length;
          return (
            <button
              key={sec.id}
              type="button"
              role="tab"
              aria-selected={activeSectionId === sec.id}
              data-testid={`section-tab-${sec.id}`}
              className={`tab-btn${activeSectionId === sec.id ? ' active' : ''}`}
              onClick={() => setActiveSectionId(sec.id)}
            >
              {sec.name} ({count})
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="row-wrap">
        <select
          data-testid="filter-ownership"
          aria-label="Filter by ownership status"
          value={ownershipFilter}
          onChange={(e) => setOwnershipFilter(e.target.value)}
        >
          <option value="all">All Ownership</option>
          <option value="have">Have</option>
          <option value="dont_have">Don&apos;t Have</option>
          <option value="wishlist">Wishlist</option>
          <option value="low_stock">Low Stock</option>
          <option value="ordered">Ordered</option>
        </select>

        <select
          data-testid="filter-status"
          aria-label="Filter by profile verification status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="verified">Verified</option>
          <option value="ai_draft">AI Draft</option>
          <option value="needs_review">Needs Review</option>
        </select>
      </div>

      {/* Compound Grid */}
      {filteredCompounds.length === 0 ? (
        <div className="card stack-v" style={{ textAlign: 'center', padding: '2rem' }}>
          <p className="muted" style={{ margin: 0 }}>
            No compounds match this section and filter yet. Add a compound, ask an AI via MCP, or load the Starter Reference Catalog in Cabinet.
          </p>
        </div>
      ) : (
        <div className="grid-3">
          {filteredCompounds.map((cmp) => {
            const effOwn = resolveEffectiveOwnership(cmp.id, activeMemberId, ownership || []);
            const ownStatus = effOwn?.status || 'dont_have';
            return (
              <article
                key={cmp.id}
                className="card compound-card"
                data-testid={`compound-card-${cmp.id}`}
                data-slug={cmp.slug}
                onClick={() => onSelectCompound(cmp.id)}
              >
                <div className="space-between">
                  <strong style={{ fontSize: '1rem', color: 'var(--text)' }}>{cmp.name}</strong>
                  <span className={`pill pill-${ownStatus}`}>{ownStatus.replace(/_/g, ' ')}</span>
                </div>
                <div className="row-wrap">
                  {cmp.subsection ? <span className="pill">{cmp.subsection}</span> : null}
                  {cmp.dosages?.route ? <span className="pill">{cmp.dosages.route}</span> : null}
                  <span className={`pill pill-${cmp.profileStatus}`}>
                    {cmp.profileStatus === 'verified' ? <CheckCircle2 size={11} /> : <Sparkles size={11} />}
                    {cmp.profileStatus}
                  </span>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {cmp.summary || cmp.mechanismOfAction || 'No summary yet.'}
                </p>
                {cmp.dosages?.rangeText ? (
                  <div className="num" style={{ fontSize: '0.8rem', color: 'var(--gold)' }}>
                    Dose: {cmp.dosages.rangeText}
                  </div>
                ) : null}
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
