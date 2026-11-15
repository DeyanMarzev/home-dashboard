import {
  addLondonDays,
  formatLongDate,
  londonDateString,
  upcomingCollections,
  type Bin,
} from '@home/shared';
import { useMisc } from '../api/hooks.js';
import { Empty, Panel, Skeleton } from '../components/Cards.js';
import { PageHeader } from '../components/PageHeader.js';
import { Status } from '../components/Status.js';
import { useNow } from '../lib/now-context.js';
import { weekdayLabel } from '../model/energy.js';

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
