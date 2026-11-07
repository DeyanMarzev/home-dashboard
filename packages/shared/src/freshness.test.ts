import { describe, expect, it } from 'vitest';
import {
  combineFreshness,
  dataToOf,
  freshness,
  type Freshness,
  type FreshnessPolicy,
} from './freshness.js';

// Policies as in config/sources.yaml (docs/03).
const roomSensors: FreshnessPolicy = {
  expectedDelaySeconds: 0,
  cadenceSeconds: 30,
  graceSeconds: null,
};
const openMeteo: FreshnessPolicy = {
  expectedDelaySeconds: 0,
  cadenceSeconds: 900,
  graceSeconds: null,
};
const smartMeters: FreshnessPolicy = {
  expectedDelaySeconds: 86400,
  cadenceSeconds: 21600,
  graceSeconds: 12 * 3600,
};
const thamesWater: FreshnessPolicy = {
  expectedDelaySeconds: 3 * 86400,
  cadenceSeconds: null,
  graceSeconds: 86400,
};

const HALF_HOUR = 1800;
const at = (iso: string) => new Date(iso);

describe('live sources', () => {
  // 30 s push → window = max(3 × 30 s, 5 min) = 5 min.
  it('is Live within the window', () => {
    const f = freshness(roomSensors, { ts: '2026-11-06T13:10:00Z' }, at('2026-11-06T13:14:59Z'));
    expect(f).toEqual({
      state: 'live',
      dataTo: '2026-11-06T13:10:00.000Z',
      lagSeconds: 299,
      daysBehind: 0,
      label: 'Live',
      compactLabel: 'Live',
    });
  });

  it('is Live exactly at the edge of the window', () => {
    expect(
      freshness(roomSensors, { ts: '2026-11-06T13:10:00Z' }, at('2026-11-06T13:15:00Z')).state,
    ).toBe('live');
  });

  it('turns Late just past the window, showing the time it stopped (London time)', () => {
    const f = freshness(roomSensors, { ts: '2026-11-06T13:10:00Z' }, at('2026-11-06T13:15:01Z'));
    expect(f.state).toBe('late');
    expect(f.label).toBe('No data since 13:10');
    expect(f.compactLabel).toBe('No data since 13:10');
  });

  it('shows the late time in BST during summer', () => {
    const f = freshness(roomSensors, { ts: '2026-07-01T12:10:00Z' }, at('2026-07-01T14:00:00Z'));
    expect(f.label).toBe('No data since 13:10');
  });

  it('shows the date when it stopped on an earlier day', () => {
    const f = freshness(roomSensors, { ts: '2026-11-04T22:00:00Z' }, at('2026-11-06T09:00:00Z'));
    expect(f.state).toBe('late');
    expect(f.label).toBe('No data since 4 Nov');
    expect(f.daysBehind).toBe(2);
  });

  it('uses 3 × the poll interval when that is longer than 5 minutes', () => {
    // 15 min poll → 45 min window.
    expect(
      freshness(openMeteo, { ts: '2026-11-06T12:00:00Z' }, at('2026-11-06T12:45:00Z')).state,
    ).toBe('live');
    expect(
      freshness(openMeteo, { ts: '2026-11-06T12:00:00Z' }, at('2026-11-06T12:45:01Z')).state,
    ).toBe('late');
  });

  it('falls back to a 5 minute window when the cadence is unknown', () => {
    const policy = { expectedDelaySeconds: 0, cadenceSeconds: null, graceSeconds: null };
    expect(
      freshness(policy, { ts: '2026-11-06T12:00:00Z' }, at('2026-11-06T12:05:00Z')).state,
    ).toBe('live');
    expect(
      freshness(policy, { ts: '2026-11-06T12:00:00Z' }, at('2026-11-06T12:05:01Z')).state,
    ).toBe('late');
  });

  it('treats a delay of up to 15 minutes as live-capable', () => {
    const policy = { expectedDelaySeconds: 15 * 60, cadenceSeconds: 60, graceSeconds: null };
    expect(
      freshness(policy, { ts: '2026-11-06T12:00:00Z' }, at('2026-11-06T12:01:00Z')).state,
    ).toBe('live');
  });

  it('clamps a slightly-future timestamp (clock skew) to zero lag', () => {
    const f = freshness(roomSensors, { ts: '2026-11-06T12:00:05Z' }, at('2026-11-06T12:00:00Z'));
    expect(f.lagSeconds).toBe(0);
    expect(f.state).toBe('live');
  });
});

describe('delayed sources', () => {
  // Half-hourly data for 5 Nov; the last interval 23:30–00:00 ends at 00:00 on 6 Nov.
  const fifthNovComplete = { ts: '2026-11-05T23:30:00Z', intervalSeconds: HALF_HOUR };

  it('is Delayed within expected delay + grace, labelled by the last day covered', () => {
    const f = freshness(smartMeters, fifthNovComplete, at('2026-11-06T14:00:00Z'));
    expect(f).toEqual({
      state: 'delayed',
      dataTo: '2026-11-06T00:00:00.000Z',
      lagSeconds: 14 * 3600,
      daysBehind: 1,
      label: 'Data to 5 Nov · 1 day behind',
      compactLabel: '1 day behind',
    });
  });

  it('is still Delayed at exactly expected delay + grace (1 d + 12 h)', () => {
    expect(freshness(smartMeters, fifthNovComplete, at('2026-11-07T12:00:00Z')).state).toBe(
      'delayed',
    );
  });

  it('turns Late after expected delay + grace', () => {
    const f = freshness(smartMeters, fifthNovComplete, at('2026-11-07T12:00:01Z'));
    expect(f.state).toBe('late');
    expect(f.label).toBe('No data since 5 Nov');
    expect(f.daysBehind).toBe(2);
  });

  it('uses the default 12 h grace when none is configured', () => {
    const policy = { ...smartMeters, graceSeconds: null };
    expect(freshness(policy, fifthNovComplete, at('2026-11-07T12:00:00Z')).state).toBe('delayed');
    expect(freshness(policy, fifthNovComplete, at('2026-11-07T12:00:01Z')).state).toBe('late');
  });

  it('pluralises days', () => {
    // Thames Water: hourly, 3 days behind is normal.
    const f = freshness(
      thamesWater,
      { ts: '2026-11-03T23:00:00Z', intervalSeconds: 3600 },
      at('2026-11-06T09:00:00Z'),
    );
    expect(f.state).toBe('delayed');
    expect(f.label).toBe('Data to 3 Nov · 3 days behind');
    expect(f.compactLabel).toBe('3 days behind');
  });

  it('says "up to date" when a delayed source already covers today', () => {
    const f = freshness(
      smartMeters,
      { ts: '2026-11-06T09:00:00Z', intervalSeconds: HALF_HOUR },
      at('2026-11-06T14:00:00Z'),
    );
    expect(f.label).toBe('Data to 6 Nov · up to date');
    expect(f.compactLabel).toBe('Up to date');
  });
});

describe('interval_total series', () => {
  it('cover up to ts + interval', () => {
    expect(dataToOf({ ts: '2026-11-05T23:30:00Z', intervalSeconds: HALF_HOUR }).toISOString()).toBe(
      '2026-11-06T00:00:00.000Z',
    );
    expect(dataToOf({ ts: '2026-11-05T22:00:00Z', intervalSeconds: 3600 }).toISOString()).toBe(
      '2026-11-05T23:00:00.000Z',
    );
  });

  it('gauges cover up to their ts', () => {
    expect(dataToOf({ ts: '2026-11-05T23:30:00Z' }).toISOString()).toBe('2026-11-05T23:30:00.000Z');
    expect(
      dataToOf({ ts: new Date('2026-11-05T23:30:00Z'), intervalSeconds: null }).toISOString(),
    ).toBe('2026-11-05T23:30:00.000Z');
  });

  it('measure lag from the end of the interval, not its start', () => {
    const f = freshness(
      roomSensors,
      { ts: '2026-11-06T12:00:00Z', intervalSeconds: HALF_HOUR },
      at('2026-11-06T12:34:00Z'),
    );
    expect(f.lagSeconds).toBe(4 * 60);
    expect(f.state).toBe('live');
  });
});

describe('Europe/London day counting across clock changes', () => {
  // Clocks go forward on Sun 29 Mar 2026 (01:00 GMT → 02:00 BST)
  // and back on Sun 25 Oct 2026 (02:00 BST → 01:00 GMT).

  it('March: counts London days, not UTC days, just after midnight BST', () => {
    // Data for 28 Mar complete (ends 00:00 GMT 29 Mar). Now 00:30 BST on 30 Mar = 23:30 UTC on 29 Mar.
    const latest = { ts: '2026-03-28T23:30:00Z', intervalSeconds: HALF_HOUR };
    const f = freshness(smartMeters, latest, at('2026-03-29T23:30:00Z'));
    expect(f.daysBehind).toBe(2); // UTC dates would say 1
    expect(f.label).toBe('Data to 28 Mar · 2 days behind');
  });

  it('March: the 23-hour day still counts as one day', () => {
    // Data for 28 Mar complete; now 23:59 BST on 29 Mar.
    const latest = { ts: '2026-03-28T23:30:00Z', intervalSeconds: HALF_HOUR };
    expect(freshness(smartMeters, latest, at('2026-03-29T22:59:00Z')).daysBehind).toBe(1);
  });

  it('March: a BST interval ending at local midnight belongs to the previous day', () => {
    // Last half-hour of 30 Mar (BST): 23:30–00:00 BST = 22:30–23:00 UTC.
    const latest = { ts: '2026-03-30T22:30:00Z', intervalSeconds: HALF_HOUR };
    const f = freshness(smartMeters, latest, at('2026-03-31T10:00:00Z'));
    expect(f.label).toBe('Data to 30 Mar · 1 day behind');
  });

  it('October: counts London days, not UTC days, just after midnight BST', () => {
    // Data for 23 Oct complete (ends 00:00 BST 24 Oct = 23:00 UTC 23 Oct).
    // Now 00:30 BST on 25 Oct = 23:30 UTC on 24 Oct, the night the clocks go back.
    const latest = { ts: '2026-10-23T22:30:00Z', intervalSeconds: HALF_HOUR };
    const f = freshness(smartMeters, latest, at('2026-10-24T23:30:00Z'));
    expect(f.daysBehind).toBe(2); // UTC dates would say 1
    expect(f.label).toBe('Data to 23 Oct · 2 days behind');
  });

  it('October: the 25-hour day is labelled with the right date', () => {
    // Last half-hour of 25 Oct (GMT again): 23:30–00:00 GMT.
    const latest = { ts: '2026-10-25T23:30:00Z', intervalSeconds: HALF_HOUR };
    const f = freshness(smartMeters, latest, at('2026-10-26T09:00:00Z'));
    expect(f.label).toBe('Data to 25 Oct · 1 day behind');
  });

  it('October: late time shows GMT after the change', () => {
    const f = freshness(roomSensors, { ts: '2026-10-25T13:10:00Z' }, at('2026-10-25T15:00:00Z'));
    expect(f.label).toBe('No data since 13:10');
  });
});

describe('never reported', () => {
  it('is Late with "No data yet"', () => {
    expect(freshness(smartMeters, null, at('2026-11-06T12:00:00Z'))).toEqual({
      state: 'late',
      dataTo: null,
      lagSeconds: null,
      daysBehind: null,
      label: 'No data yet',
      compactLabel: 'No data yet',
    });
  });
});

describe('combineFreshness', () => {
  const now = at('2026-11-06T14:00:00Z');
  const live = freshness(roomSensors, { ts: '2026-11-06T13:59:00Z' }, now);
  const delayed1 = freshness(
    smartMeters,
    { ts: '2026-11-05T23:30:00Z', intervalSeconds: HALF_HOUR },
    now,
  );
  const delayed3 = freshness(
    thamesWater,
    { ts: '2026-11-03T23:00:00Z', intervalSeconds: 3600 },
    now,
  );
  const late = freshness(roomSensors, { ts: '2026-11-06T13:10:00Z' }, now);
  const never = freshness(roomSensors, null, now);

  it('returns null for nothing', () => {
    expect(combineFreshness([])).toBeNull();
  });

  it('returns the only item', () => {
    expect(combineFreshness([live])).toBe(live);
  });

  it('worst state wins: late > delayed > live', () => {
    expect(combineFreshness([live, delayed1])).toBe(delayed1);
    expect(combineFreshness([delayed1, late, live])).toBe(late);
  });

  it('shows the oldest of two delayed series', () => {
    expect(combineFreshness([delayed1, delayed3])).toBe(delayed3);
    expect(combineFreshness([delayed3, delayed1])).toBe(delayed3);
  });

  it('a never-reported series is the oldest late one', () => {
    expect(combineFreshness([late, never, live])).toBe(never);
    expect(combineFreshness([never, late])).toBe(never);
  });

  it('is order-independent', () => {
    const all: Freshness[] = [live, delayed1, delayed3, late, never];
    expect(combineFreshness(all)).toBe(never);
    expect(combineFreshness([...all].reverse())).toBe(never);
  });
});
