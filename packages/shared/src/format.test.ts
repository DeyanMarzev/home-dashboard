import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatLongDate,
  formatMinutes,
  formatNumber,
  formatUptime,
  formatWhen,
  humanise,
} from './format.js';

const now = new Date('2026-11-06T13:41:30Z');

describe('formatAgo', () => {
  it.each([
    ['2026-11-06T13:41:00Z', '30 s ago'],
    ['2026-11-06T13:39:00Z', '2 min ago'],
    ['2026-11-06T10:40:00Z', '3 h ago'],
    ['2026-11-05T23:30:00Z', '5 Nov 23:30'],
  ])('%s → %s', (ts, text) => {
    expect(formatAgo(ts, now)).toBe(text);
  });
});

describe('formatWhen', () => {
  it('shows only the time today, the date otherwise (London time)', () => {
    expect(formatWhen('2026-11-06T13:10:00Z', now)).toBe('13:10');
    expect(formatWhen('2026-07-01T12:10:00Z', new Date('2026-07-02T12:00:00Z'))).toBe(
      '1 Jul 13:10',
    );
  });
});

describe('formatMinutes', () => {
  it.each([
    [0, '0 min'],
    [1800, '30 min'],
    [5400, '1 h 30 min'],
    [25200, '7 h'],
  ])('%i s → %s', (s, text) => {
    expect(formatMinutes(s)).toBe(text);
  });
});

describe('other formats', () => {
  it('formats numbers the British way', () => {
    expect(formatNumber(1240)).toBe('1,240');
    expect(formatNumber(20.44, 1)).toBe('20.4');
  });

  it('formats uptime', () => {
    expect(formatUptime(23 * 86400 + 500)).toBe('23 d');
    expect(formatUptime(7300)).toBe('2 h');
  });

  it('formats the page date in London', () => {
    expect(formatLongDate(new Date('2026-11-06T13:41:00Z'))).toBe('Friday 6 November');
    expect(formatLongDate(new Date('2026-07-01T23:30:00Z'))).toBe('Thursday 2 July');
  });

  it('humanises keys', () => {
    expect(humanise('living_room')).toBe('Living room');
  });
});
