import { describe, expect, it } from 'vitest';
import {
  clipRuns,
  condensingShare,
  heatingTips,
  stateRuns,
  totalSeconds,
  warmUp,
} from './heating.js';

// Points every 2 minutes from 06:00 UTC on 6 Nov.
const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 6, minute)).toISOString();
const states = (...values: number[]) => values.map((v, i) => [at(i * 2), v] as const);
const HOLD = 360; // 3 × the Nest's 2-minute poll
const END = new Date(Date.UTC(2026, 10, 6, 12));

describe('stateRuns', () => {
  it('merges consecutive on-points into one run lasting until the next off-point', () => {
    expect(stateRuns(states(0, 1, 1, 1, 0, 0, 1, 0), HOLD, END)).toEqual([
      { from: at(2), to: at(8) },
      { from: at(12), to: at(14) },
    ]);
  });

  it('does not count a gap in the data as on', () => {
    const points = [
      [at(0), 1],
      [at(30), 1],
      [at(32), 0],
    ] as const;
    expect(stateRuns(points, HOLD, END)).toEqual([
      { from: at(0), to: at(6) },
      { from: at(30), to: at(32) },
    ]);
  });

  it('stops the last run at `until`', () => {
    expect(stateRuns(states(1), HOLD, new Date(Date.parse(at(3))))).toEqual([
      { from: at(0), to: at(3) },
    ]);
  });

  it('reads bucket averages above 0.5 as on', () => {
    expect(stateRuns(states(0.2, 0.8, 0.4), HOLD, END)).toEqual([{ from: at(2), to: at(4) }]);
  });
});

describe('clipRuns and totalSeconds', () => {
  it('clips runs to a window and adds them up', () => {
    const runs = [
      { from: at(0), to: at(20) },
      { from: at(40), to: at(50) },
    ];
    const clipped = clipRuns(runs, new Date(at(10)), new Date(at(45)));
    expect(clipped).toEqual([
      { from: at(10), to: at(20) },
      { from: at(40), to: at(45) },
    ]);
    expect(totalSeconds(clipped)).toBe(15 * 60);
  });
});

describe('condensingShare', () => {
  it('is the share of return readings below 55 °C while firing', () => {
    const runs = [{ from: at(0), to: at(10) }];
    const ret = [
      [at(0), 48],
      [at(2), 52],
      [at(4), 56],
      [at(6), 58],
      [at(20), 30],
    ] as const;
    expect(condensingShare(runs, ret)).toBe(0.5);
  });

  it('is null without probe readings during firing', () => {
    expect(condensingShare([{ from: at(0), to: at(10) }], [[at(30), 40]])).toBeNull();
  });
});

describe('warmUp', () => {
  const temps = [
    [at(0), 16],
    [at(60), 17.5],
    [at(120), 19],
  ] as const;

  it('averages the rise per hour over runs of 20 min or more', () => {
    const result = warmUp(
      [
        { from: at(0), to: at(120) },
        { from: at(130), to: at(140) },
      ],
      temps,
    );
    expect(result?.ratePerHour).toBeCloseTo(1.5);
    expect(result?.longest).toEqual({ from: at(0), to: at(120), startC: 16, endC: 19 });
  });

  it('is null with only short runs', () => {
    expect(warmUp([{ from: at(0), to: at(10) }], temps)).toBeNull();
  });
});

describe('heatingTips', () => {
  it('suggests a lower flow temperature when flow runs hot and condensing is poor', () => {
    expect(
      heatingTips({ flowPeakC: 66, condensingShare: 0.7, warmUp: null, shortCycles: 0 })[0]?.title,
    ).toBe('Lower the boiler flow temperature');
    expect(
      heatingTips({ flowPeakC: 66, condensingShare: 0.95, warmUp: null, shortCycles: 0 }),
    ).toEqual([]);
  });

  it('mentions long warm-ups and frequent short cycles', () => {
    const tips = heatingTips({
      flowPeakC: null,
      condensingShare: null,
      warmUp: { ratePerHour: 1.4, longest: { from: at(0), to: at(130), startC: 16, endC: 20.5 } },
      shortCycles: 4,
    });
    expect(tips.map((t) => t.title)).toEqual(['Longest warm-up took 2 h 10 min', '4 short cycles']);
  });
});
