import type { AlertLevel, AlertRule } from './schema.js';

/** Who gets which alert (docs/09 §4). Pure: the dispatcher supplies everything. */

export type Phase = 'opened' | 'escalated' | 'resolved';

export interface NotifyUser {
  role: 'member' | 'admin';
  enabled: boolean;
  tz: string;
  /** "23:00" / "07:00", local time in tz; null = no quiet hours. */
  quietStart: string | null;
  quietEnd: string | null;
  urgentIgnoresQuiet: boolean;
  pausedUntil: Date | null;
}

/** A user's own choice for a rule (`user_alert_prefs`); null = the rule's defaults. */
export interface AlertPref {
  enabled: boolean;
  minLevel: AlertLevel;
  entities: string[] | null;
  notifyResolved: boolean;
}

export type SkipReason =
  'skipped_disabled' | 'skipped_level' | 'skipped_entity' | 'skipped_paused' | 'skipped_quiet';

export type Decision = { send: true } | { send: false; reason: SkipReason };

const RANK: Record<AlertLevel, number> = { warning: 1, alert: 2 };

/** The rule's defaults for this user, when they haven't changed anything. */
export function defaultPref(rule: AlertRule, role: NotifyUser['role']): AlertPref {
  const { audience, minLevel } = rule.defaults;
  return {
    enabled: audience === 'all' || (audience === 'admins' && role === 'admin'),
    minLevel,
    entities: null,
    // "Back to normal" pushes are opt-in (docs/02 § Choices made).
    notifyResolved: false,
  };
}

/** Minutes since local midnight in `tz`, for quiet hours (DST-correct via Intl). */
function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return get('hour') * 60 + get('minute');
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Inside [start, end) local time; a window like 23:00–07:00 crosses midnight. */
export function inQuietHours(user: NotifyUser, now: Date): boolean {
  if (!user.quietStart || !user.quietEnd) return false;
  const t = localMinutes(now, user.tz);
  const start = toMinutes(user.quietStart);
  const end = toMinutes(user.quietEnd);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * docs/09 §4 Decision function, in its order. `level` is the event's level: for `resolved`
 * that is the highest it reached (events never de-escalate).
 */
export function shouldNotify(
  user: NotifyUser,
  rule: AlertRule,
  pref: AlertPref | null,
  event: { level: AlertLevel; entity: string },
  phase: Phase,
  now: Date,
): Decision {
  const p = pref ?? defaultPref(rule, user.role);
  if (!user.enabled) return { send: false, reason: 'skipped_disabled' };
  if (!rule.enabled || !p.enabled) return { send: false, reason: 'skipped_disabled' };
  if (phase === 'resolved' && (!p.notifyResolved || !rule.resolvedNotice))
    return { send: false, reason: 'skipped_disabled' };
  if (RANK[event.level] < RANK[p.minLevel]) return { send: false, reason: 'skipped_level' };
  if (p.entities && !p.entities.includes(event.entity))
    return { send: false, reason: 'skipped_entity' };
  if (user.pausedUntil && user.pausedUntil > now) return { send: false, reason: 'skipped_paused' };
  const urgentGetsThrough = event.level === 'alert' && user.urgentIgnoresQuiet;
  if (inQuietHours(user, now) && !urgentGetsThrough)
    return { send: false, reason: 'skipped_quiet' };
  return { send: true };
}
