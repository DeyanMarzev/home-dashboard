import { describe, expect, it } from 'vitest';
import {
  addLondonDays,
  formatLondonDayMonth,
  formatLondonTime,
  londonCalendarDaysBetween,
  londonDateString,
  londonDayBounds,
  londonMidnight,
  londonParts,
} from './london.js';

const at = (iso: string) => new Date(iso);

describe('londonParts', () => {
  it('is UTC+0 in winter', () => {
    expect(londonParts(at('2026-01-15T23:30:00Z'))).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 23,
      minute: 30,
    });
  });

  it('is UTC+1 in summer, rolling the date over at 23:00 UTC', () => {
    expect(londonParts(at('2026-07-15T23:30:00Z'))).toEqual({
      year: 2026,
      month: 7,
      day: 16,
      hour: 0,
      minute: 30,
    });
  });

  it('reports midnight as hour 0, not 24', () => {
    expect(londonParts(at('2026-01-15T00:00:00Z')).hour).toBe(0);
  });

  it('jumps from 00:59 GMT to 02:00 BST on 29 Mar 2026', () => {
    expect(formatLondonTime(at('2026-03-29T00:59:00Z'))).toBe('00:59');
    expect(formatLondonTime(at('2026-03-29T01:00:00Z'))).toBe('02:00');
  });

  it('repeats 01:00–01:59 on 25 Oct 2026', () => {
    expect(formatLondonTime(at('2026-10-25T00:30:00Z'))).toBe('01:30'); // BST
    expect(formatLondonTime(at('2026-10-25T01:30:00Z'))).toBe('01:30'); // GMT
  });
});

describe('londonCalendarDaysBetween', () => {
  it('is 0 within the same London day, even across UTC midnight in summer', () => {
    expect(londonCalendarDaysBetween(at('2026-07-15T23:10:00Z'), at('2026-07-16T22:50:00Z'))).toBe(
      0,
    );
  });

  it('counts the 23-hour and 25-hour days as one day each', () => {
    expect(londonCalendarDaysBetween(at('2026-03-28T12:00:00Z'), at('2026-03-30T12:00:00Z'))).toBe(
      2,
    );
    expect(londonCalendarDaysBetween(at('2026-10-24T12:00:00Z'), at('2026-10-26T12:00:00Z'))).toBe(
      2,
    );
  });

  it('is negative when the order is reversed', () => {
    expect(londonCalendarDaysBetween(at('2026-11-06T12:00:00Z'), at('2026-11-05T12:00:00Z'))).toBe(
      -1,
    );
  });
});

describe('formatLondonDayMonth', () => {
  it.each([
    ['2026-11-05T12:00:00Z', '5 Nov'],
    ['2026-09-30T12:00:00Z', '30 Sep'],
    ['2026-06-30T23:30:00Z', '1 Jul'], // BST
  ])('%s → %s', (iso, text) => {
    expect(formatLondonDayMonth(at(iso))).toBe(text);
  });
});

describe('London days', () => {
  it('starts days at local midnight in winter and summer', () => {
    expect(londonMidnight('2026-11-06').toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(londonMidnight('2026-07-01').toISOString()).toBe('2026-06-30T23:00:00.000Z');
  });

  it('has a 23-hour day in March and a 25-hour day in October', () => {
    const march = londonDayBounds('2026-03-29');
    expect((march.to.getTime() - march.from.getTime()) / 3600_000).toBe(23);
    const october = londonDayBounds('2026-10-25');
    expect(october.from.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect((october.to.getTime() - october.from.getTime()) / 3600_000).toBe(25);
  });

  it('names the London date of an instant', () => {
    expect(londonDateString(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
    expect(londonDateString(new Date('2026-11-06T23:30:00Z'))).toBe('2026-11-06');
  });

  it('adds calendar days', () => {
    expect(addLondonDays('2026-11-01', -7)).toBe('2026-10-25');
    expect(addLondonDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
