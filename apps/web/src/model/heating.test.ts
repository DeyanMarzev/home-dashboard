import { describe, expect, it } from 'vitest';
import { hoursMinutes, setpointSegments } from './heating.js';

describe('setpointSegments', () => {
  it('splits the day by observed setpoint, merging repeats, with the rest unknown', () => {
    const segments = setpointSegments(
      [
        ['2026-11-06T00:00:00Z', 16],
        ['2026-11-06T03:00:00Z', 16],
        ['2026-11-06T06:00:00Z', 20.5],
      ],
      '2026-11-06',
      new Date('2026-11-06T12:00:00Z'),
    );
    expect(segments).toEqual([
      { start: 0, width: 25, value: 16, warm: false },
      { start: 25, width: 25, value: 20.5, warm: true },
      { start: 50, width: 50, value: null, warm: false },
    ]);
  });

  it('is all unknown without setpoints', () => {
    expect(setpointSegments([], '2026-11-06', new Date('2026-11-06T12:00:00Z'))).toEqual([
      { start: 0, width: 100, value: null, warm: false },
    ]);
  });

  it('uses the 25-hour day in October', () => {
    const [first] = setpointSegments(
      [['2026-10-24T23:00:00Z', 18]],
      '2026-10-25',
      new Date('2026-10-25T11:30:00Z'),
    );
    expect(first?.width).toBeCloseTo(50, 5); // 12.5 h of 25
  });
});

describe('hoursMinutes', () => {
  it('formats runtime', () => {
    expect(hoursMinutes(125)).toBe('2:05');
    expect(hoursMinutes(0)).toBe('0:00');
  });
});
