import { describe, expect, it } from 'vitest';
import { defaultPref, inQuietHours, shouldNotify, type NotifyUser } from './prefs.js';
import { AlertRuleSchema, type AlertRule } from './schema.js';

const rule = (over: Record<string, unknown> = {}): AlertRule =>
  AlertRuleSchema.parse({
    id: 'co2_high',
    group: 'air',
    name: 'CO₂ high',
    type: 'threshold',
    match: { metric: 'co2' },
    direction: 'above',
    warning: { level: 1000, for: '15m' },
    alert: { level: 1500, for: '10m' },
    clear: { level: 900, for: '5m' },
    link: '/rooms',
    defaults: { audience: 'all', minLevel: 'warning' },
    ...over,
  });

const user = (over: Partial<NotifyUser> = {}): NotifyUser => ({
  role: 'member',
  enabled: true,
  tz: 'Europe/London',
  quietStart: null,
  quietEnd: null,
  urgentIgnoresQuiet: true,
  pausedUntil: null,
  ...over,
});

const NOON = new Date('2026-11-21T12:00:00Z');
const warn = { level: 'warning' as const, entity: 'kitchen' };
const urgent = { level: 'alert' as const, entity: 'kitchen' };
const send = { send: true };
const skip = (reason: string) => ({ send: false, reason });

describe('shouldNotify', () => {
  it('sends by default for everyone when the audience is all', () => {
    expect(shouldNotify(user(), rule(), null, warn, 'opened', NOON)).toEqual(send);
  });

  it('applies the audience and minimum level defaults by role', () => {
    const admins = rule({ defaults: { audience: 'admins', minLevel: 'warning' } });
    expect(shouldNotify(user(), admins, null, warn, 'opened', NOON)).toEqual(
      skip('skipped_disabled'),
    );
    expect(shouldNotify(user({ role: 'admin' }), admins, null, warn, 'opened', NOON)).toEqual(send);
    const none = rule({ defaults: { audience: 'none', minLevel: 'warning' } });
    expect(shouldNotify(user({ role: 'admin' }), none, null, warn, 'opened', NOON)).toEqual(
      skip('skipped_disabled'),
    );
    const urgentOnly = rule({ defaults: { audience: 'all', minLevel: 'alert' } });
    expect(shouldNotify(user(), urgentOnly, null, warn, 'opened', NOON)).toEqual(
      skip('skipped_level'),
    );
    expect(shouldNotify(user(), urgentOnly, null, urgent, 'escalated', NOON)).toEqual(send);
  });

  it('gives every skip reason, in order', () => {
    const pref = {
      enabled: true,
      minLevel: 'warning' as const,
      entities: null,
      notifyResolved: true,
    };
    expect(shouldNotify(user({ enabled: false }), rule(), pref, warn, 'opened', NOON)).toEqual(
      skip('skipped_disabled'),
    );
    expect(shouldNotify(user(), rule({ enabled: false }), pref, warn, 'opened', NOON)).toEqual(
      skip('skipped_disabled'),
    );
    expect(shouldNotify(user(), rule(), { ...pref, enabled: false }, warn, 'opened', NOON)).toEqual(
      skip('skipped_disabled'),
    );
    expect(
      shouldNotify(user(), rule(), { ...pref, entities: ['bedroom'] }, warn, 'opened', NOON),
    ).toEqual(skip('skipped_entity'));
    expect(
      shouldNotify(
        user({ pausedUntil: new Date(NOON.getTime() + 60_000) }),
        rule(),
        pref,
        urgent,
        'opened',
        NOON,
      ),
    ).toEqual(skip('skipped_paused'));
    expect(
      shouldNotify(
        user({ pausedUntil: new Date(NOON.getTime() - 60_000) }),
        rule(),
        pref,
        warn,
        'opened',
        NOON,
      ),
    ).toEqual(send);
  });

  it('sends "back to normal" only when wanted, judged by the highest level reached', () => {
    const wants = {
      enabled: true,
      minLevel: 'alert' as const,
      entities: null,
      notifyResolved: true,
    };
    expect(shouldNotify(user(), rule(), null, urgent, 'resolved', NOON)).toEqual(
      skip('skipped_disabled'),
    );
    expect(shouldNotify(user(), rule(), wants, urgent, 'resolved', NOON)).toEqual(send);
    expect(shouldNotify(user(), rule(), wants, warn, 'resolved', NOON)).toEqual(
      skip('skipped_level'),
    );
    expect(
      shouldNotify(user(), rule({ resolvedNotice: false }), wants, urgent, 'resolved', NOON),
    ).toEqual(skip('skipped_disabled'));
  });

  it('holds back during quiet hours, except urgent ones when allowed', () => {
    const quiet = user({ quietStart: '23:00', quietEnd: '07:00' });
    const night = new Date('2026-11-21T23:30:00Z');
    expect(shouldNotify(quiet, rule(), null, warn, 'opened', night)).toEqual(skip('skipped_quiet'));
    expect(shouldNotify(quiet, rule(), null, urgent, 'opened', night)).toEqual(send);
    expect(
      shouldNotify({ ...quiet, urgentIgnoresQuiet: false }, rule(), null, urgent, 'opened', night),
    ).toEqual(skip('skipped_quiet'));
    expect(shouldNotify(quiet, rule(), null, warn, 'opened', NOON)).toEqual(send);
  });
});

describe('inQuietHours', () => {
  const quiet = user({ quietStart: '23:00', quietEnd: '07:00' });
  const day = user({ quietStart: '13:00', quietEnd: '14:30' });

  it('crosses midnight', () => {
    expect(inQuietHours(quiet, new Date('2026-11-21T22:59:00Z'))).toBe(false);
    expect(inQuietHours(quiet, new Date('2026-11-21T23:00:00Z'))).toBe(true);
    expect(inQuietHours(quiet, new Date('2026-11-22T06:59:00Z'))).toBe(true);
    expect(inQuietHours(quiet, new Date('2026-11-22T07:00:00Z'))).toBe(false);
    expect(inQuietHours(day, new Date('2026-11-21T13:30:00Z'))).toBe(true);
    expect(inQuietHours(day, new Date('2026-11-21T14:30:00Z'))).toBe(false);
  });

  it('uses London time across the clock changes in March and October', () => {
    // Summer (BST): 23:30 London is 22:30 UTC.
    expect(inQuietHours(quiet, new Date('2026-07-01T22:30:00Z'))).toBe(true);
    expect(inQuietHours(quiet, new Date('2026-07-01T06:30:00Z'))).toBe(false); // 07:30 BST
    // Last Sunday of March 2026 (29th): 06:30 UTC is 07:30 BST, past the end.
    expect(inQuietHours(quiet, new Date('2026-03-29T06:30:00Z'))).toBe(false);
    expect(inQuietHours(quiet, new Date('2026-03-29T05:30:00Z'))).toBe(true);
    // Last Sunday of October 2026 (25th): 06:30 UTC is 06:30 GMT, still quiet.
    expect(inQuietHours(quiet, new Date('2026-10-25T06:30:00Z'))).toBe(true);
  });

  it('is off without both times', () => {
    expect(inQuietHours(user(), NOON)).toBe(false);
  });
});

describe('defaultPref', () => {
  it('leaves "back to normal" off', () => {
    expect(defaultPref(rule(), 'admin')).toEqual({
      enabled: true,
      minLevel: 'warning',
      entities: null,
      notifyResolved: false,
    });
  });
});
