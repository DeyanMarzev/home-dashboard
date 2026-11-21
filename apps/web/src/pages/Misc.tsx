import {
  addLondonDays,
  formatAgo,
  formatLondonTime,
  formatLongDate,
  londonDayBounds,
  londonDateString,
  upcomingCollections,
  VACUUM_LOW_BATTERY,
  type Bin,
} from '@home/shared';
import { useState } from 'react';
import { useLatest, useMisc, useReadings, useSeriesList, useSource } from '../api/hooks.js';
import { Empty, Panel, Skeleton } from '../components/Cards.js';
import { NotConnected, SourceBadge } from '../components/PageBits.js';
import { PageHeader } from '../components/PageHeader.js';
import { Status } from '../components/Status.js';
import { useNow } from '../lib/now-context.js';
import { weekdayLabel } from '../model/energy.js';
import {
  addMonths,
  floorLabel,
  floorRank,
  floorStyle,
  floorsByDay,
  formatMinutes,
  formatMonth,
  londonMonth,
  monthBounds,
  monthWeeks,
  runsOfDay,
  vacuumNow,
  type FloorDay,
} from '../model/vacuum.js';

const BIN_COLOURS = ['green', 'black', 'brown', 'blue', 'grey', 'purple'];

/** A wheelie bin in the bin's colour (outlined, so a black bin shows in dark mode). */
function BinIcon({ colour }: { colour: string }) {
  const fill = BIN_COLOURS.includes(colour) ? `var(--bin-${colour})` : 'var(--chart-muted)';
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 6.5h16M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M5.5 6.5l1.2 13a1.5 1.5 0 0 0 1.5 1.4h7.6a1.5 1.5 0 0 0 1.5-1.4l1.2-13z"
        fill={fill}
        stroke="var(--text-secondary)"
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
      <path d="M10 10v8M14 10v8" stroke="var(--surface)" strokeWidth={1.2} opacity={0.5} />
    </svg>
  );
}

function Bins({ bins }: { bins: readonly Bin[] }) {
  return (
    <span className="bins">
      {bins.map((b) => (
        <span key={b.name} className="bin">
          <BinIcon colour={b.colour} />
          {b.name}
        </span>
      ))}
    </span>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

export function MiscPage() {
  const now = useNow();
  return (
    <div className="page">
      <PageHeader title="Misc" subtitle={formatLongDate(now)} />
      <div className="row">
        <BinsPanel />
        <VacuumPanel />
      </div>
    </div>
  );
}

function BinsPanel() {
  const now = useNow();
  const misc = useMisc();
  const today = londonDateString(now);
  const tomorrow = addLondonDays(today, 1);
  const collections = upcomingCollections(misc.data?.bins ?? [], today, 42);
  const [next, ...later] = collections;
  const when = (date: string) => {
    if (date === today) return 'Today';
    if (date === tomorrow) return 'Tomorrow';
    const days = Math.round(
      (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000,
    );
    return `In ${days} days`;
  };

  return (
    <Panel id="bins-h" title="Bin collection" flex="0 1 760px">
      {misc.isPending ? (
        <Skeleton height={160} />
      ) : misc.isError ? (
        <Empty>{misc.error.message}</Empty>
      ) : !next ? (
        <Empty>No bins set up: add them to config/misc.yaml</Empty>
      ) : (
        <div className="stack">
          <div className="stack" style={{ gap: 8 }}>
            <span className="small muted">Next collection</span>
            <span className="big big--sm">
              {weekday(next.date)} {weekdayLabel(next.date).split(' ').slice(1).join(' ')}
            </span>
            <span>
              <Status tone={next.date === tomorrow ? 'warn' : next.date === today ? 'bad' : 'good'}>
                {when(next.date)}
                {next.date === tomorrow && ': put them out tonight'}
                {next.date === today && ': out this morning'}
              </Status>
            </span>
            <Bins bins={next.bins} />
          </div>
          {later.length > 0 && (
            <>
              <span className="small muted">After that</span>
              <ul className="collections">
                {later.slice(0, 6).map((c) => (
                  <li key={c.date}>
                    <span>
                      <strong>{weekdayLabel(c.date)}</strong>{' '}
                      <span className="small muted">· {when(c.date).toLowerCase()}</span>
                    </span>
                    <Bins bins={c.bins} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="note">
            From config/misc.yaml. Bank holidays (Christmas, New Year) can move collections: check
            the council&apos;s notice.
          </p>
        </div>
      )}
    </Panel>
  );
}

/** A floor's mark: its colour, or hatched grey for a map beyond the three floors. */
function FloorMark({ entity, className }: { entity: string; className: string }) {
  const style = floorStyle(entity);
  return (
    <span
      className={`${className}${style.kind === 'other' ? ` ${className}--other` : ''}`}
      style={style.kind === 'solid' ? { background: style.colour } : undefined}
      aria-hidden="true"
    />
  );
}

/**
 * The robot's battery and what it's doing, from the hourly check. Off its dock and not busy
 * (idle, paused, error) it runs flat, so that's shown as a problem (the collector also raises
 * it on the Overview).
 */
function VacuumBattery({ now }: { now: Date }) {
  const latest = useLatest({ source: 'roborock', entity: 'vacuum' });
  const robot = vacuumNow(latest.data?.items);
  if (!robot) return null;
  const { battery, state } = robot;
  const stranded = state?.place === 'stranded';
  const low = battery !== null && battery < VACUUM_LOW_BATTERY;
  const fill = low ? 'bad' : stranded ? 'warn' : 'good';
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="vacuum-now">
        <span className="big big--sm">
          {battery === null ? '–' : `${battery}%`}
          <span className="unit"> battery</span>
        </span>
        {state && (
          <Status tone={stranded ? 'bad' : state.place === 'docked' ? 'good' : 'muted'}>
            {state.label}
          </Status>
        )}
      </div>
      {battery !== null && (
        <div className="progress-track" role="img" aria-label={`Battery ${battery}%`}>
          <div
            className={`progress-fill progress-fill--${fill}`}
            style={{ width: `${Math.max(0, Math.min(100, battery))}%` }}
          />
        </div>
      )}
      <span className="small muted">
        Checked {formatAgo(robot.ts, now)}
        {stranded && (
          <span className="warn-text"> · not charging: check it&apos;s on its dock</span>
        )}
      </span>
    </div>
  );
}

const WEEK_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Which floor the Roborock cleaned each day (docs/05 § Misc, docs/03 § roborock). */
function VacuumPanel() {
  const now = useNow();
  const source = useSource('roborock');
  const series = useSeriesList('roborock');
  const thisMonth = londonMonth(now);
  const today = londonDateString(now);
  const [month, setMonth] = useState(thisMonth);
  const [picked, setPicked] = useState<string | null>(null);

  const minutes = (series.data ?? []).filter((s) => s.metric === 'clean_minutes');
  const runSeries = (series.data ?? []).filter(
    (s) => s.metric === 'clean_minutes' || s.metric === 'clean_area',
  );
  const bounds = monthBounds(month);
  const daily = useReadings(
    minutes.map((s) => s.id),
    '30d',
    {
      between: { from: bounds.from.toISOString(), to: bounds.to.toISOString() },
      bucket: '1d',
      agg: 'sum',
    },
  );
  const days = floorsByDay(daily.data);
  const latestDay = [...days.keys()].sort().at(-1);
  const selected = picked?.startsWith(month) ? picked : (latestDay ?? null);
  const dayBounds = selected ? londonDayBounds(selected) : null;
  const detail = useReadings(dayBounds ? runSeries.map((s) => s.id) : [], '24h', {
    between: dayBounds
      ? { from: dayBounds.from.toISOString(), to: dayBounds.to.toISOString() }
      : { from: '', to: '' },
    bucket: 'raw',
  });
  const runs = runsOfDay(detail.data);
  const floors = [...minutes].sort((a, b) => floorRank(a.entity) - floorRank(b.entity));

  // Hidden until the source is in config/sources.yaml (like the boiler probes).
  if (!source) return null;

  const describe = (date: string, list: FloorDay[] | undefined) =>
    `${weekdayLabel(date)}: ${list?.length ? list.map((f) => `${f.label} ${formatMinutes(f.minutes)}`).join(', ') : 'no cleaning'}`;

  return (
    <Panel
      id="vacuum-h"
      title="Vacuum"
      flex="1 1 420px"
      badge={<SourceBadge source={source} compact />}
    >
      {!source.enabled ? (
        <NotConnected source={source} />
      ) : series.isPending ? (
        <Skeleton height={300} />
      ) : (
        <div className="stack">
          <VacuumBattery now={now} />
          <div className="cal-head">
            <button
              type="button"
              className="cal-nav"
              aria-label="Previous month"
              onClick={() => setMonth(addMonths(month, -1))}
            >
              ‹
            </button>
            <strong>{formatMonth(month)}</strong>
            <button
              type="button"
              className="cal-nav"
              aria-label="Next month"
              disabled={month >= thisMonth}
              onClick={() => setMonth(addMonths(month, 1))}
            >
              ›
            </button>
          </div>
          <div className="cal" role="grid" aria-label={`Vacuum runs, ${formatMonth(month)}`}>
            <div className="cal-row" role="row">
              {WEEK_HEAD.map((d) => (
                <span key={d} className="cal-weekday" role="columnheader">
                  {d}
                </span>
              ))}
            </div>
            {monthWeeks(month).map((week, w) => (
              <div className="cal-row" role="row" key={w}>
                {week.map((date, i) =>
                  date === null ? (
                    <span key={i} className="cal-day cal-day--pad" role="gridcell" />
                  ) : (
                    <button
                      key={date}
                      type="button"
                      role="gridcell"
                      className={`cal-day${date === today ? ' cal-day--today' : ''}${date === selected ? ' cal-day--picked' : ''}`}
                      disabled={date > today}
                      aria-label={describe(date, days.get(date))}
                      aria-selected={date === selected}
                      title={describe(date, days.get(date))}
                      onClick={() => setPicked(date)}
                    >
                      <span className="cal-date">{Number(date.slice(8))}</span>
                      <span className="cal-marks">
                        {days.get(date)?.map((f) => (
                          <FloorMark key={f.entity} entity={f.entity} className="cal-mark" />
                        ))}
                      </span>
                    </button>
                  ),
                )}
              </div>
            ))}
          </div>
          {floors.length > 0 && (
            <ul className="cal-legend" aria-label="Floors">
              {floors.map((f) => (
                <li key={f.entity}>
                  <FloorMark entity={f.entity} className="cal-swatch" />
                  {floorLabel(f)}
                </li>
              ))}
            </ul>
          )}
          {daily.isError ? (
            <Empty>{daily.error.message}</Empty>
          ) : minutes.length === 0 ? (
            <Empty>No runs stored yet: they appear after the robot&apos;s next clean</Empty>
          ) : selected === null ? (
            <p className="small muted">No cleaning this month.</p>
          ) : (
            <div className="stack" style={{ gap: 4 }}>
              <span className="small muted">{weekdayLabel(selected)}</span>
              {detail.isPending ? (
                <Skeleton height={40} />
              ) : runs.length === 0 ? (
                <p className="small muted">
                  {days.has(selected)
                    ? 'Run details are kept for 90 days.'
                    : 'No cleaning that day.'}
                </p>
              ) : (
                <ul className="runs">
                  {runs.map((r) => (
                    <li key={`${r.entity}${r.ts}`}>
                      <FloorMark entity={r.entity} className="cal-swatch" />
                      <span className="runs-time">{formatLondonTime(new Date(r.ts))}</span>
                      <span className="runs-floor">{r.label}</span>
                      <span className="small muted">
                        {formatMinutes(r.minutes)}
                        {r.areaM2 !== null && ` · ${r.areaM2.toFixed(1)} m²`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
