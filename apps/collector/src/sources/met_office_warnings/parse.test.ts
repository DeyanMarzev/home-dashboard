import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  coversHome,
  formatValidity,
  parseWarningsFeed,
  warningEvent,
  warningReadings,
  WarningsFeedError,
} from './parse.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const HOME = ['Waltham Forest'];

describe('parseWarningsFeed', () => {
  it('reads the real feed with no warnings', () => {
    expect(parseWarningsFeed(fixture('se-none.xml'), new Date('2026-11-21T12:00:00Z'))).toEqual([]);
  });

  it('reads a real warning: colour, type, areas, London-time validity and its link', () => {
    const [w] = parseWarningsFeed(fixture('uk-one-yellow.xml'), new Date('2026-11-21T12:00:00Z'));
    expect(w).toEqual({
      id: 'w_ee79f19a_c3d0_4b76_963a_dd166d264efe',
      colour: 'yellow',
      type: 'rain',
      region: 'South West England',
      areas: ['Cornwall', 'Devon', 'Plymouth', 'Torbay'],
      validFrom: new Date('2026-11-22T06:00:00Z'),
      validTo: new Date('2026-11-22T23:59:00Z'),
      url: 'https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings#?date=2026-11-22&id=ee79f19a-c3d0-4b76-963a-dd166d264efe&referrer=rss',
    });
    // Somewhere else in the country: no alert for Waltham Forest.
    expect(coversHome(w!, HOME)).toBe(false);
  });

  it('finds the year from the weekday, across New Year', () => {
    const xml = fixture('uk-one-yellow.xml').replace(
      'valid from 0600 Sun 22 Nov to 2359 Sun 22 Nov',
      'valid from 1800 Thu 31 Dec to 0600 Fri 1 Jan',
    );
    const [w] = parseWarningsFeed(xml, new Date('2026-12-30T12:00:00Z'));
    expect(w?.validFrom).toEqual(new Date('2026-12-31T18:00:00Z'));
    expect(w?.validTo).toEqual(new Date('2027-01-01T06:00:00Z'));
  });

  it('fails the run on anything it does not understand', () => {
    const bad = (from: string, to: string) => () =>
      parseWarningsFeed(
        fixture('uk-one-yellow.xml').replace(from, to),
        new Date('2026-11-21T12:00:00Z'),
      );
    expect(() => parseWarningsFeed('<html>Service unavailable</html>', new Date())).toThrow(
      WarningsFeedError,
    );
    expect(bad('Yellow warning of rain affecting', 'Warning:')).toThrow(/title not understood/);
    expect(bad('valid from 0600 Sun', 'from 0600 Sun')).toThrow(/description not understood/);
    expect(bad('Sun 22 Nov to', 'Mon 22 Nov to')).toThrow(/isn't a Mon/);
    expect(bad('&amp;id=ee79f19a', '&amp;ref=ee79f19a')).toThrow(/no warning id/);
  });
});

describe('which warnings alert for the home', () => {
  const now = new Date('2026-11-23T10:00:00Z');
  const warnings = parseWarningsFeed(fixture('se-mixed.xml'), now);
  const kept = warnings.filter((w) => w.validTo > now && coversHome(w, HOME));

  it('keeps Waltham Forest and London-wide warnings, not Kent-only or expired ones', () => {
    expect(warnings).toHaveLength(4);
    expect(kept.map((w) => `${w.colour} ${w.type}`)).toEqual(['yellow wind', 'amber rain']);
  });

  it('counts every warning when no areas are set, or a warning names none', () => {
    expect(warnings.filter((w) => coversHome(w, [])).length).toBe(4);
    expect(coversHome({ ...warnings[2]!, areas: [] }, HOME)).toBe(true);
  });

  it('turns them into events: yellow is a warning, amber urgent, with the Met Office link', () => {
    expect(warningEvent(kept[0]!)).toEqual({
      level: 'warning',
      title: 'Yellow warning · Wind',
      message: 'Yellow warning of wind · Tue 24 Nov 06:00 – 21:00',
      data: {
        colour: 'yellow',
        type: 'wind',
        validFrom: '2026-11-24T06:00:00.000Z',
        validTo: '2026-11-24T21:00:00.000Z',
        url: expect.stringContaining('id=11111111-aaaa-4bbb-8ccc-000000000001') as string,
        areas: ['Barnet', 'Enfield', 'Haringey', 'Waltham Forest'],
      },
    });
    expect(warningEvent(kept[1]!)).toMatchObject({
      level: 'alert',
      title: 'Amber warning · Rain',
      message: 'Amber warning of rain · Mon 23 Nov 18:00 – Wed 25 Nov 06:00',
    });
  });

  it('reports the count and the highest colour, so the source stays Live with none', () => {
    const readings = warningReadings(kept, now);
    expect(readings.map((r) => [r.metric, r.value])).toEqual([
      ['active_warnings', 2],
      ['warning_level', 2],
    ]);
    expect(warningReadings([], now).map((r) => r.value)).toEqual([0, 0]);
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('formats validity in London time, summer included', () => {
    expect(formatValidity(new Date('2026-07-01T05:00:00Z'), new Date('2026-07-01T20:00:00Z'))).toBe(
      'Wed 1 Jul 06:00 – 21:00',
    );
  });
});
