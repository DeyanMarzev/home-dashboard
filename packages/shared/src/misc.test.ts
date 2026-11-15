import { describe, expect, it } from 'vitest';
import { MiscFileSchema, toMiscResponse, upcomingCollections, type Bin } from './misc.js';

// The owner's bins (2026-11-15): green weekly, black and brown fortnightly, all on Thursdays,
// first on Thursday 19 November.
const bins: Bin[] = [
  { name: 'Green', colour: 'green', everyWeeks: 1, collectedOn: '2026-11-19' },
  { name: 'Black', colour: 'black', everyWeeks: 2, collectedOn: '2026-11-19' },
  { name: 'Brown', colour: 'brown', everyWeeks: 2, collectedOn: '2026-11-19' },
];
const names = (c: { bins: Bin[] }) => c.bins.map((b) => b.name).join(' ');

describe('upcomingCollections', () => {
  it('lists each Thursday with the bins that go out', () => {
    const next = upcomingCollections(bins, '2026-11-15', 28);
    expect(next.map((c) => `${c.date} ${names(c)}`)).toEqual([
      '2026-11-19 Green Black Brown',
      '2026-11-26 Green',
      '2026-12-03 Green Black Brown',
      '2026-12-10 Green',
    ]);
  });

  it('includes today, and works from any anchor date, past or future', () => {
    expect(names(upcomingCollections(bins, '2026-12-03', 1)[0]!)).toBe('Green Black Brown');
    const later = [{ ...bins[1]!, collectedOn: '2027-02-25' }]; // 14 weeks on: same fortnight
    expect(upcomingCollections(later, '2026-11-15', 21).map((c) => c.date)).toEqual([
      '2026-11-19',
      '2026-12-03',
    ]);
  });

  it('keeps Thursdays across the clock change and the new year', () => {
    const dates = upcomingCollections([bins[0]!], '2026-12-20', 21).map((c) => c.date);
    expect(dates).toEqual(['2026-12-24', '2026-12-31', '2027-01-07']);
    const spring = upcomingCollections([bins[0]!], '2027-03-25', 8).map((c) => c.date);
    expect(spring).toEqual(['2027-03-25', '2027-04-01']); // clocks change 28 March 2027
  });
});

describe('MiscFileSchema', () => {
  it('reads the YAML shape and turns it into the API shape', () => {
    const file = MiscFileSchema.parse({
      bins: [{ name: 'Green', colour: 'green', every_weeks: 1, collected_on: '2026-11-19' }],
    });
    expect(toMiscResponse(file)).toEqual({
      bins: [{ name: 'Green', colour: 'green', everyWeeks: 1, collectedOn: '2026-11-19' }],
    });
    expect(MiscFileSchema.parse({})).toEqual({ bins: [] });
  });

  it('rejects typos and bad values', () => {
    expect(() =>
      MiscFileSchema.parse({
        bins: [{ name: 'Green', colour: 'green', every_week: 1, collected_on: '2026-11-19' }],
      }),
    ).toThrow();
    expect(() =>
      MiscFileSchema.parse({
        bins: [{ name: 'Green', colour: 'green', every_weeks: 1, collected_on: '19/11/2026' }],
      }),
    ).toThrow();
  });
});
