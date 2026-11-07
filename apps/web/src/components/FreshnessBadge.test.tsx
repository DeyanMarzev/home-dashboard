import { freshness, type FreshnessPolicy, type SourceInfo } from '@home/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFreshnessNow } from '../lib/freshness.js';
import { NowContext } from '../lib/now-context.js';
import { FreshnessBadge } from './FreshnessBadge.js';

const roomSensors: FreshnessPolicy = {
  expectedDelaySeconds: 0,
  cadenceSeconds: 30,
  graceSeconds: null,
};
const lastReading = new Date('2026-11-06T13:10:00Z');
// What the API returned at 13:11: Live.
const fetched = freshness(roomSensors, { ts: lastReading }, new Date('2026-11-06T13:11:00Z'));

function client() {
  const qc = new QueryClient();
  qc.setQueryData<Partial<SourceInfo>[]>(
    ['sources'],
    [{ id: 'room_sensors', policy: roomSensors }],
  );
  return qc;
}

function Badge() {
  const at = useFreshnessNow();
  return <FreshnessBadge freshness={at(fetched, 'room_sensors')} />;
}

function renderAt(now: Date, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <NowContext.Provider value={now}>
        <Badge />
      </NowContext.Provider>
    </QueryClientProvider>
  );
}

describe('FreshnessBadge', () => {
  it('turns Late on its own as the clock moves, with no refetch', () => {
    const qc = client();
    const { rerender } = render(renderAt(new Date('2026-11-06T13:12:00Z'), qc));
    expect(screen.getByText('Live')).toBeTruthy();

    rerender(renderAt(new Date('2026-11-06T13:16:00Z'), qc)); // 6 min after the last reading
    expect(screen.getByText('No data since 13:10')).toBeTruthy();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('renders each state with text, never colour alone', () => {
    const delayed = freshness(
      { expectedDelaySeconds: 86400, cadenceSeconds: 21600, graceSeconds: 43200 },
      { ts: '2026-11-05T23:30:00Z', intervalSeconds: 1800 },
      new Date('2026-11-06T14:00:00Z'),
    );
    const { container, rerender } = render(<FreshnessBadge freshness={delayed} />);
    expect(container.textContent).toBe('Data to 5 Nov · 1 day behind');
    expect(container.querySelector('.badge--delayed svg')).toBeTruthy();
    rerender(<FreshnessBadge freshness={delayed} compact />);
    expect(container.textContent).toBe('1 day behind');
  });
});
