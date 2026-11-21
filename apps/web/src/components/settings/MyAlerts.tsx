import type { MyAlertPut, MyAlertRule } from '@home/shared';
import { useState } from 'react';
import { useMyAlerts, useSaveMyAlert } from '../../api/settings.js';
import { Empty, Panel, Skeleton } from '../Cards.js';
import { Status } from '../Status.js';
import { Switch } from '../Switch.js';

const LEVEL_WORD = { warning: 'warning', alert: 'urgent' } as const;

/** Settings → My alerts (docs/09 §7): each rule on or off, levels, rooms, back to normal. */
export function MyAlertsPanel() {
  const alerts = useMyAlerts();
  return (
    <Panel id="alerts-h" title="My alerts" flex="1 1 100%">
      {alerts.isPending ? (
        <Skeleton height={240} />
      ) : alerts.isError ? (
        <Empty>{alerts.error.message}</Empty>
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          <p className="small muted">
            Which alerts reach your phones. Changes save straight away and are yours only.
          </p>
          {alerts.data.groups.map((g) => (
            <section key={g.id} aria-labelledby={`ag-${g.id}`} className="stack" style={{ gap: 0 }}>
              <h3 id={`ag-${g.id}`} className="section-title">
                {g.name}
              </h3>
              <ul className="rules">
                {g.rules.map((r) => (
                  <RuleRow key={r.id} rule={r} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function RuleRow({ rule }: { rule: MyAlertRule }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useSaveMyAlert();
  const current: MyAlertPut = {
    enabled: rule.enabled,
    minLevel: rule.minLevel,
    entities: rule.entitiesSelected,
    notifyResolved: rule.notifyResolved,
  };
  const change = (patch: Partial<MyAlertPut> | null) => {
    setSaved(false);
    save.mutate(
      { ruleId: rule.id, body: patch === null ? null : { ...current, ...patch } },
      { onSuccess: () => setSaved(true) },
    );
  };
  const selected = rule.entitiesSelected ?? rule.entities.map((e) => e.id);
  const toggleEntity = (id: string) => {
    const next = selected.includes(id) ? selected.filter((e) => e !== id) : [...selected, id];
    // All of them = "all", so rooms added later are included too.
    change({ entities: next.length === rule.entities.length ? null : next });
  };
  const panelId = `rule-${rule.id}`;

  return (
    <li className="rule">
      <div className="rule-head">
        <button
          type="button"
          className="rule-name"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <span className="rule-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="stack" style={{ gap: 2 }}>
            <strong>{rule.name}</strong>
            <span className="small muted">{rule.description}</span>
          </span>
        </button>
        {rule.ruleEnabled ? (
          <Switch checked={rule.enabled} onChange={(on) => change({ enabled: on })} hideLabel>
            {`${rule.name}: ${rule.enabled ? 'on' : 'off'}`}
          </Switch>
        ) : (
          <span className="small muted">Off for everyone</span>
        )}
      </div>
      {rule.open.map((o) => (
        <p key={`${o.entity}${o.since}`} className="small">
          <Status tone={o.level === 'alert' ? 'bad' : 'warn'}>
            Open now · {o.label} · {LEVEL_WORD[o.level]} since{' '}
            {new Date(o.since).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Europe/London',
            })}
          </Status>
        </p>
      ))}
      {open && (
        <div id={panelId} className="rule-body">
          {rule.levels.length > 1 && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">Notify me for</span>
              <div role="group" aria-label="Notify me for" className="pills">
                {(
                  [
                    ['warning', 'Warnings and urgent'],
                    ['alert', 'Urgent only'],
                  ] as const
                ).map(([level, label]) => (
                  <button
                    key={level}
                    type="button"
                    className="pill"
                    aria-pressed={rule.minLevel === level}
                    onClick={() => change({ minLevel: level })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {rule.type !== 'event' && rule.entities.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">{rule.type === 'freshness' ? 'Sources' : 'Rooms'}</span>
              <div role="group" aria-label="Rooms" className="chips-row">
                {rule.entities.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className="pill"
                    aria-pressed={selected.includes(e.id)}
                    onClick={() => toggleEntity(e.id)}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {rule.resolvedNotice && (
            <Switch checked={rule.notifyResolved} onChange={(on) => change({ notifyResolved: on })}>
              Also tell me when it&apos;s back to normal
            </Switch>
          )}
          {!rule.isDefault && (
            <div>
              <button type="button" className="pill" onClick={() => change(null)}>
                Reset to default
              </button>
            </div>
          )}
        </div>
      )}
      {save.isError ? (
        <p className="small warn-text">Not saved: {save.error.message}</p>
      ) : (
        saved && (
          <p className="small muted" role="status">
            Saved
          </p>
        )
      )}
    </li>
  );
}
