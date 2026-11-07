import { formatLongDate } from '@home/shared';
import { useSources } from '../api/hooks.js';
import { Panel } from '../components/Cards.js';
import { PageHeader } from '../components/PageHeader.js';
import { NotConnected, SourceBadge } from '../components/PageBits.js';
import { useNow } from '../lib/now-context.js';

/** Pages whose sources come in later milestones: says which sources they need and their state. */
export function NotYetPage({
  title,
  sourceIds,
  milestone,
}: {
  title: string;
  sourceIds: string[];
  milestone: string;
}) {
  const now = useNow();
  const { data } = useSources();
  const sources = sourceIds.map((id) => ({ id, source: data?.find((s) => s.id === id) }));
  return (
    <div className="page">
      <PageHeader title={title} subtitle={formatLongDate(now)} />
      <Panel id="soon-h" title={`${title} is coming`}>
        <p className="meta">
          This page is built with its data sources ({milestone} in docs/07-build-plan.md).
        </p>
        <ul className="list">
          {sources.map(({ id, source }) => (
            <li key={id}>
              <span>{source?.name ?? id}</span>
              {source ? (
                <SourceBadge source={source} />
              ) : (
                <span className="badge badge--neutral">Not set up</span>
              )}
            </li>
          ))}
        </ul>
        {sources.every((s) => !s.source?.enabled) && (
          <NotConnected source={undefined}>No data for this page yet</NotConnected>
        )}
      </Panel>
    </div>
  );
}
