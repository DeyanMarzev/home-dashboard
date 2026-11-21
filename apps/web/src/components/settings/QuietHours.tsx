import {
  addLondonDays,
  formatLondonTime,
  formatWhen,
  londonDateString,
  londonLocalTime,
  londonParts,
} from '@home/shared';
import { useMe } from '../../api/hooks.js';
import { usePatchMe } from '../../api/settings.js';
import { useNow } from '../../lib/now-context.js';
import { Empty, Panel, Skeleton } from '../Cards.js';
import { Status } from '../Status.js';
import { Switch } from '../Switch.js';

/** The next 07:00 London time. */
function next7am(now: Date): Date {
  const today = londonDateString(now);
  return londonParts(now).hour < 7
    ? londonLocalTime(today, 7, 0)
    : londonLocalTime(addLondonDays(today, 1), 7, 0);
}

/** Settings → Quiet hours and pause (docs/09 §7). */
export function QuietHoursPanel() {
  const me = useMe();
  const patch = usePatchMe();
  const now = useNow();

  if (me.isPending)
    return (
      <Panel id="quiet-h" title="Quiet hours and pause" flex="1 1 360px">
        <Skeleton height={160} />
      </Panel>
    );
  if (me.isError)
    return (
      <Panel id="quiet-h" title="Quiet hours and pause" flex="1 1 360px">
        <Empty>{me.error.message}</Empty>
      </Panel>
    );
  const m = me.data;
  const quiet = m.quietStart !== null && m.quietEnd !== null;
  const paused = m.pausedUntil !== null && new Date(m.pausedUntil) > now;
  const pauseFor = (until: Date | null) =>
    patch.mutate({ pausedUntil: until === null ? null : until.toISOString() });

  return (
    <Panel id="quiet-h" title="Quiet hours and pause" flex="1 1 360px">
      <div className="stack">
        <Switch
          checked={quiet}
          onChange={(on) =>
            patch.mutate(
              on
                ? { quietStart: '23:00', quietEnd: '07:00' }
                : { quietStart: null, quietEnd: null },
            )
          }
        >
          Quiet hours
        </Switch>
        {quiet && (
          <div className="row" style={{ gap: 12, alignItems: 'end' }}>
            <label className="field">
              <span className="small muted">From</span>
              <input
                type="time"
                value={m.quietStart!}
                onChange={(e) =>
                  e.target.value &&
                  patch.mutate({ quietStart: e.target.value, quietEnd: m.quietEnd })
                }
              />
            </label>
            <label className="field">
              <span className="small muted">To</span>
              <input
                type="time"
                value={m.quietEnd!}
                onChange={(e) =>
                  e.target.value &&
                  patch.mutate({ quietStart: m.quietStart, quietEnd: e.target.value })
                }
              />
            </label>
          </div>
        )}
        <Switch
          checked={m.urgentIgnoresQuiet}
          onChange={(on) => patch.mutate({ urgentIgnoresQuiet: on })}
        >
          Urgent alerts still come through
        </Switch>
        <p className="note">
          Alerts during quiet hours aren&apos;t sent later. You&apos;ll still see them in the app.
        </p>

        <strong>Pause all notifications</strong>
        {paused ? (
          <>
            <Status tone="warn">Paused until {formatWhen(m.pausedUntil!, now)}</Status>
            <div>
              <button type="button" className="pill" onClick={() => pauseFor(null)}>
                Resume
              </button>
            </div>
          </>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="pill"
              onClick={() => pauseFor(new Date(now.getTime() + 3600_000))}
            >
              1 hour
            </button>
            <button
              type="button"
              className="pill"
              onClick={() => pauseFor(new Date(now.getTime() + 8 * 3600_000))}
            >
              8 hours
            </button>
            <button type="button" className="pill" onClick={() => pauseFor(next7am(now))}>
              Until {formatLondonTime(next7am(now))}
              {londonParts(now).hour < 7 ? '' : ' tomorrow'}
            </button>
          </div>
        )}
        {patch.isError && <p className="small warn-text">Not saved: {patch.error.message}</p>}
      </div>
    </Panel>
  );
}
