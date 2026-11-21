import { formatNumber } from '../format.js';
import { formatLondonTime } from '../london.js';
import type { Phase } from './prefs.js';
import type { AlertRule } from './schema.js';

/** Push notification text (docs/09 §3 Messages, docs/10 §2). Pure, en-GB, Europe/London. */

export interface MessageEvent {
  kind: string;
  entity: string;
  level: 'warning' | 'alert';
  /** "Head · rest", as shown on the Overview alerts strip. */
  message: string;
  data: unknown;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Same tag = the phone replaces the earlier notification (escalation, back to normal). */
  tag: string;
  url: string;
}

interface ThresholdData {
  value?: number;
  unit?: string;
  label?: string;
  since?: string;
}

const dataOf = (e: MessageEvent) =>
  (typeof e.data === 'object' && e.data !== null ? e.data : {}) as ThresholdData & {
    title?: string;
  };

/** 1240 ppm → "1,240 ppm"; 13.46 °C → "13.5 °C"; 42 % → "42%". */
export function formatAlertValue(value: number, unit: string): string {
  const digits = Number.isInteger(value) || Math.abs(value) >= 100 ? 0 : 1;
  return `${formatNumber(value, digits)}${unit === '%' ? '' : ' '}${unit}`;
}

/** 15 min, 2 h, 2 h 30 min. */
export function formatHeldFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const sentence = (text: string | undefined) => (text ? ` ${text}` : '');

/**
 * The push for one event and phase. `currentValue` is the series' latest value, for the
 * "back to normal" message of threshold rules.
 */
export function buildPushMessage(
  rule: AlertRule,
  event: MessageEvent,
  phase: Phase,
  now: Date,
  currentValue: number | null = null,
): PushMessage {
  const d = dataOf(event);
  const tag = `${rule.id}:${event.entity}`;
  const url =
    rule.type === 'threshold' && event.entity ? `${rule.link}#${event.entity}` : rule.link;

  if (rule.type === 'threshold') {
    const label = d.label ?? event.entity;
    const unit = d.unit ?? '';
    if (phase === 'resolved') {
      return {
        title: `${rule.resolvedName ?? `${rule.name}: back to normal`} · ${label}`,
        body:
          currentValue === null ? 'Back to normal.' : `${formatAlertValue(currentValue, unit)}.`,
        tag,
        url,
      };
    }
    const value = d.value === undefined ? '' : formatAlertValue(d.value, unit);
    const held =
      phase === 'opened' && d.since
        ? ` for ${formatHeldFor(now.getTime() - Date.parse(d.since))}`
        : '';
    return {
      title: `${phase === 'escalated' ? 'Urgent: ' : ''}${rule.name} · ${label}`,
      body: `${value}${held}.${sentence(rule.advice)}`.trim(),
      tag,
      url,
    };
  }

  // Event and freshness rules: the event's own "Head · rest" text.
  const cut = event.message.indexOf(' · ');
  const head = cut >= 0 ? event.message.slice(0, cut) : null;
  const rest = cut >= 0 ? event.message.slice(cut + 3) : event.message;
  if (phase === 'resolved') {
    const what = d.title ?? head ?? rule.name;
    return {
      title: rule.resolvedName
        ? `${rule.resolvedName}${d.title ? ` · ${d.title}` : ''}`
        : `Over: ${what}`,
      body: `Since ${formatLondonTime(now)}.`,
      tag,
      url,
    };
  }
  // A custom title already says how serious it is (e.g. "Amber warning · Rain").
  const title = d.title ?? head ?? rule.name;
  const urgent = phase === 'escalated' && !d.title ? 'Urgent: ' : '';
  return {
    title: `${urgent}${title}`,
    body: `${rest}${rest.endsWith('.') ? '' : '.'}${sentence(rule.advice)}`,
    tag,
    url,
  };
}

/** The "Send test notification" push. */
export function testPushMessage(deviceLabel: string): PushMessage {
  return {
    title: 'Test notification',
    body: `Notifications work on ${deviceLabel}.`,
    tag: 'test',
    url: '/settings',
  };
}
