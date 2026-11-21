import {
  formatLondonDayMonth,
  humanise,
  parseDuration,
  type AdminRule,
  type AlertRuleOverride,
} from '@home/shared';
import { useState } from 'react';
import { useAlertRuleActions, useAlertRules } from '../../api/settings.js';
import { Empty, Panel, Skeleton } from '../Cards.js';
import { Switch } from '../Switch.js';

const LEVELS = [
  ['warning', 'Warning'],
  ['alert', 'Urgent'],
  ['clear', 'Back to normal at'],
] as const;
type LevelKey = (typeof LEVELS)[number][0];
type Draft = Partial<Record<LevelKey, { level: string; minutes: string }>>;

const minutesOf = (d: string) => String(parseDuration(d) / 60);

/** Settings → Alert thresholds (admins; docs/09 §7): the household's shared levels. */
export function AdminRulesPanel() {
  const rules = useAlertRules(true);
  return (
    <Panel id="thresholds-h" title="Alert thresholds (admin)" flex="1 1 100%">
      {rules.isPending ? (
        <Skeleton height={200} />
      ) : rules.isError ? (
        <Empty>{rules.error.message}</Empty>
      ) : (
        <div className="stack">
          <p className="small muted">
            For everyone in the house. Changes apply within a minute, without a restart.
          </p>
          <ul className="rules">
            {rules.data.items.map((r) => (
              <AdminRuleRow key={r.id} rule={r} />
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function AdminRuleRow({ rule }: { rule: AdminRule }) {
  const { patch, reset } = useAlertRuleActions();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [problem, setProblem] = useState<string | null>(null);
  const levels = LEVELS.filter(([k]) => rule.effective[k]);
  const value = (k: LevelKey) => ({
    level: draft[k]?.level ?? String(rule.effective[k]!.level),
    minutes: draft[k]?.minutes ?? minutesOf(rule.effective[k]!.for),
  });
  const dirty = Object.keys(draft).length > 0;

  const send = (params: AlertRuleOverride) => {
    setProblem(null);
    patch.mutate(
      { id: rule.id, params },
      { onSuccess: () => setDraft({}), onError: (err) => setProblem(err.message) },
    );
  };
  const save = () => {
    const params: AlertRuleOverride = {};
    for (const [k] of levels) {
      const d = draft[k];
      if (!d) continue;
      const level = Number(d.level);
      const minutes = Number(d.minutes);
      if (!Number.isFinite(level) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        setProblem('Levels must be numbers, durations whole minutes from 1 to 1440');
        return;
      }
      params[k] = { level, for: `${minutes}m` };
    }
    send(params);
  };

  return (
    <li className="rule">
      <div className="rule-head">
        <button
          type="button"
          className="rule-name"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="rule-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="stack" style={{ gap: 2 }}>
            <strong>{rule.name}</strong>
            {rule.override && (
              <span className="small muted">
                Changed{rule.override.updatedBy ? ` by ${rule.override.updatedBy}` : ''} on{' '}
                {formatLondonDayMonth(new Date(rule.override.updatedAt))}
              </span>
            )}
          </span>
        </button>
        <Switch checked={rule.effective.enabled} onChange={(on) => send({ enabled: on })}>
          On for everyone
        </Switch>
      </div>
      {open && (
        <div className="rule-body">
          {levels.length > 0 && (
            <div className="levels">
              {levels.map(([k, label]) => (
                <div key={k} className="level-row">
                  <span className="small">
                    {label}
                    {k !== 'clear' && ` (${rule.direction ?? ''})`}
                  </span>
                  <label className="field">
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      aria-label={`${label} level`}
                      value={value(k).level}
                      onChange={(e) =>
                        setDraft({ ...draft, [k]: { ...value(k), level: e.target.value } })
                      }
                    />
                    <span className="small muted">{rule.unit ?? ''}</span>
                  </label>
                  <label className="field">
                    <span className="small muted">for</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={1440}
                      aria-label={`${label} for how many minutes`}
                      value={value(k).minutes}
                      onChange={(e) =>
                        setDraft({ ...draft, [k]: { ...value(k), minutes: e.target.value } })
                      }
                    />
                    <span className="small muted">min</span>
                  </label>
                </div>
              ))}
            </div>
          )}
          {Object.entries(rule.effective.options ?? {}).map(([name, v]) =>
            typeof v === 'boolean' ? (
              <Switch key={name} checked={v} onChange={(on) => send({ options: { [name]: on } })}>
                {humanise(name.replace(/([A-Z])/g, '_$1').toLowerCase())}
              </Switch>
            ) : null,
          )}
          <div className="row" style={{ gap: 8 }}>
            {dirty && (
              <>
                <button
                  type="button"
                  className="pill pill--primary"
                  disabled={patch.isPending}
                  onClick={save}
                >
                  Save
                </button>
                <button type="button" className="pill" onClick={() => setDraft({})}>
                  Cancel
                </button>
              </>
            )}
            {rule.override && !dirty && (
              <button
                type="button"
                className="pill"
                disabled={reset.isPending}
                onClick={() => reset.mutate(rule.id)}
              >
                Reset to defaults
              </button>
            )}
          </div>
          {levels.length > 0 && (
            <p className="small muted">
              Defaults:{' '}
              {levels
                .map(([k, label]) => {
                  const d = rule.defaults[k];
                  return d ? `${label.toLowerCase()} ${d.level} for ${minutesOf(d.for)} min` : null;
                })
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      )}
      {problem && <p className="small warn-text">{problem}</p>}
    </li>
  );
}
