'use client';
import { useState } from 'react';

// timeBudget/elevationOrder are single-select (the route optimizer needs one
// concrete cutoff, not a ranking signal) — difficulty/activity stay
// multi-select, same interaction as before.
const FILTER_GROUPS = [
  {
    key: 'timeBudget',
    label: 'Time Budget',
    multiSelect: false,
    options: [
      { value: null, label: 'Any' },
      { value: 60, label: 'Under 1hr' },
      { value: 120, label: 'Under 2hrs' },
      { value: 180, label: 'Under 3hrs' }
    ]
  },
  { key: 'difficulty', label: 'Difficulty', multiSelect: true, options: ['Easy', 'Moderate', 'Hard'] },
  { key: 'activity', label: 'Activity', multiSelect: true, options: ['Hiking', 'Trail Running'] },
  {
    key: 'elevationOrder',
    label: 'Elevation Preference',
    multiSelect: false,
    options: [
      { value: null, label: 'Any' },
      { value: 'flat_first', label: 'Flat first' },
      { value: 'climb_early', label: 'Climb early' }
    ]
  }
];

export const EMPTY_LOOP_FILTERS = { timeBudget: null, difficulty: [], activity: [], elevationOrder: null };

export default function LoopFilterPanel({ filters, onChange }) {
  const [open, setOpen] = useState(false);
  const activeCount = FILTER_GROUPS.reduce((sum, group) => {
    const value = filters[group.key];
    return sum + (group.multiSelect ? (value?.length || 0) : (value != null ? 1 : 0));
  }, 0);

  const toggleMulti = (key, value) => {
    const current = filters[key];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    onChange({ ...filters, [key]: next });
  };

  const selectSingle = (key, value) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="absolute top-3 right-3 z-[1000]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="bg-[rgba(26,36,32,0.85)] backdrop-blur-md border border-forest-border hover:border-green-500/50 text-forest-text text-xs px-3 py-2 rounded-lg shadow-lg flex items-center gap-1.5 transition-colors"
      >
        Filters
        {activeCount > 0 && (
          <span className="bg-green-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">{activeCount}</span>
        )}
      </button>

      {open && (
        <div className="mt-2 bg-[rgba(26,36,32,0.95)] backdrop-blur-md border border-forest-border rounded-lg p-3 shadow-2xl w-64 space-y-3">
          {FILTER_GROUPS.map((group) => (
            <div key={group.key}>
              <p className="text-[10px] uppercase tracking-wide text-forest-muted mb-1.5">{group.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {group.options.map((opt) => {
                  const value = typeof opt === 'string' ? opt : opt.value;
                  const label = typeof opt === 'string' ? opt : opt.label;
                  const active = group.multiSelect
                    ? filters[group.key].includes(value)
                    : filters[group.key] === value;
                  return (
                    <button
                      key={String(value)}
                      onClick={() => (group.multiSelect ? toggleMulti(group.key, value) : selectSingle(group.key, value))}
                      className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                        active
                          ? 'bg-green-600 border-green-600 text-white'
                          : 'bg-forest-bg border-forest-border text-forest-text/80 hover:border-green-500/50'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {activeCount > 0 && (
            <button
              onClick={() => onChange(EMPTY_LOOP_FILTERS)}
              className="text-[11px] text-forest-muted hover:text-forest-text underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
