import { EVENTS_CHANNEL, pushTargets, type PushTarget, type Sql } from '@home/db';
import {
  buildPushMessage,
  shouldNotify,
  testPushMessage,
  type AlertLevel,
  type AlertPref,
  type AlertRules,
  type NotifyUser,
  type Phase,
  type PushMessage,
} from '@home/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { NotificationSource } from '../stream.js';
import { endpointHint, type Channel, type PushPayload } from './channel.js';

/** `data.recipients` (user ids) limits an event to those people; absent = everyone. */
function recipientsOf(data: unknown): Set<number> | null {
  const list = (data as { recipients?: unknown } | null)?.recipients;
  return Array.isArray(list)
    ? new Set(list.filter((v): v is number => typeof v === 'number'))
    : null;
}

/** Events (or escalations, resolutions) older than this are marked handled, never pushed. */
const STALE_MS = 60 * 60_000;
const SAFETY_TICK_MS = 60_000;
const CLEANUP_MS = 6 * 3600_000;
const BATCH = 50;
/** docs/09 §5 Rate limit. */
const MAX_PER_HOUR = 20;
/** Waits before retrying a 429/5xx: 5 s, 30 s, 2 min, then "failed". */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

interface EventRow {
  id: string;
  ts: Date;
  level: AlertLevel | 'info';
  source_id: string | null;
  kind: string;
  entity: string;
  rule_id: string;
  message: string;
  data: unknown;
  escalated_at: Date | null;
  resolved_at: Date | null;
  was_dispatched?: Date | null;
}

interface UserRow extends NotifyUser {
  id: number;
}

type LogStatus =
  | 'sent'
  | 'failed'
  | 'gone'
  | 'skipped_disabled'
  | 'skipped_level'
  | 'skipped_entity'
  | 'skipped_paused'
  | 'skipped_quiet'
  | 'skipped_rate_limited';

export interface DispatcherOptions {
  db: Sql;
  channel: Channel;
  /** The current effective rules (null while config/alerts.yaml can't be read). */
  rules: () => AlertRules | null;
  log: FastifyBaseLogger;
  now?: () => Date;
  retryDelaysMs?: number[];
}

/**
 * Turns alert events into pushes (docs/09 §5), in the api. Woken by NOTIFY `events`, a
 * one-minute safety tick and startup. Each event is claimed (dispatched_at set) before
 * anything is sent, so a restart never sends it twice; then, per user, `shouldNotify`
 * decides, and every decision or delivery is written to notification_log.
 */
export class Dispatcher {
  private running: Promise<void> | null = null;
  private again = false;
  private timers: NodeJS.Timeout[] = [];
  private unlisten: (() => Promise<void>) | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => Date;
  private readonly delays: number[];

  constructor(private readonly o: DispatcherOptions) {
    this.now = o.now ?? (() => new Date());
    this.delays = o.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  async start(notifications: NotificationSource): Promise<void> {
    this.unlisten = await notifications.listen(EVENTS_CHANNEL, () => this.wake());
    this.timers.push(
      setInterval(() => this.wake(), SAFETY_TICK_MS),
      setInterval(() => void this.cleanup(), CLEANUP_MS),
    );
    this.wake(); // catch up on anything left from before a restart
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.unlisten?.();
  }

  /** Runs a pass now, or right after the current one. */
  wake(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain()
      .catch((err: unknown) => this.o.log.error({ err }, 'push dispatch failed'))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  /** One full pass (tests); resolves once sends and their retries have finished. */
  async runOnce(): Promise<void> {
    await this.drain();
    await this.settle();
  }

  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private async drain(): Promise<void> {
    while ((await this.openedBatch()) + (await this.resolvedBatch()) > 0) {
      /* keep going until both queues are empty */
    }
  }

  private async openedBatch(): Promise<number> {
    const rows = await this.o.db<EventRow[]>`
      with claimed as (
        select id from events
        where rule_id is not null and dispatched_at is null and resolved_at is null
        order by ts limit ${BATCH} for update skip locked)
      update events e set dispatched_at = now() from claimed where e.id = claimed.id
      returning e.id, e.ts, e.level, e.source_id, e.kind, e.entity, e.rule_id, e.message, e.data,
                e.escalated_at, e.resolved_at`;
    for (const e of rows) {
      const at = e.escalated_at ?? e.ts;
      if (this.now().getTime() - at.getTime() > STALE_MS) continue; // too old to push
      await this.deliver(e, e.escalated_at ? 'escalated' : 'opened');
    }
    return rows.length;
  }

  private async resolvedBatch(): Promise<number> {
    const rows = await this.o.db<EventRow[]>`
      with claimed as (
        select id, dispatched_at as was_dispatched from events
        where rule_id is not null and resolved_at is not null and resolved_dispatched_at is null
        order by resolved_at limit ${BATCH} for update skip locked)
      update events e
        set resolved_dispatched_at = now(), dispatched_at = coalesce(e.dispatched_at, now())
      from claimed where e.id = claimed.id
      returning e.id, e.ts, e.level, e.source_id, e.kind, e.entity, e.rule_id, e.message, e.data,
                e.escalated_at, e.resolved_at, claimed.was_dispatched`;
    for (const e of rows) {
      // Never announced (it ended within a minute), or ended long ago: nothing to say.
      if (!e.was_dispatched) continue;
      if (this.now().getTime() - e.resolved_at!.getTime() > STALE_MS) continue;
      await this.deliver(e, 'resolved');
    }
    return rows.length;
  }

  private async deliver(e: EventRow, phase: Phase): Promise<void> {
    if (e.level === 'info') return;
    const rule = this.o.rules()?.rules.find((r) => r.id === e.rule_id);
    if (!rule) {
      this.o.log.warn(
        { rule: e.rule_id, event: Number(e.id) },
        'event for an unknown rule: not pushed',
      );
      return;
    }
    const { db } = this.o;
    const now = this.now();
    const [users, prefRows] = await Promise.all([
      db<UserRow[]>`
        select id, role, enabled, tz,
          to_char(quiet_start, 'HH24:MI') as "quietStart", to_char(quiet_end, 'HH24:MI') as "quietEnd",
          urgent_ignores_quiet as "urgentIgnoresQuiet", paused_until as "pausedUntil"
        from users`,
      db<(AlertPref & { user_id: number })[]>`
        select user_id, enabled, min_level as "minLevel", entities, notify_resolved as "notifyResolved"
        from user_alert_prefs where rule_id = ${rule.id}`,
    ]);
    const prefs = new Map(prefRows.map((p) => [p.user_id, p]));

    let currentValue: number | null = null;
    if (phase === 'resolved' && rule.type === 'threshold' && e.source_id) {
      const [latest] = await db<{ value: number }[]>`
        select r.value from readings r join series s on s.id = r.series_id
        where s.source_id = ${e.source_id} and s.metric = ${rule.match.metric} and s.entity = ${e.entity}
        order by r.ts desc limit 1`;
      currentValue = latest?.value ?? null;
    }
    const message = buildPushMessage(rule, { ...e, level: e.level }, phase, now, currentValue);
    const payload: PushPayload = {
      v: 1,
      phase,
      eventId: Number(e.id),
      ruleId: rule.id,
      level: e.level,
      ...message,
      ts: now.toISOString(),
    };

    // Personal reminders name who asked ("tell me when it connects"): nobody else is asked.
    const only = recipientsOf(e.data);
    const wanted: number[] = [];
    for (const user of users) {
      if (only && !only.has(user.id)) continue;
      const decision = shouldNotify(
        user,
        rule,
        prefs.get(user.id) ?? null,
        e as { level: AlertLevel; entity: string },
        phase,
        now,
      );
      if (!decision.send) {
        await this.log(Number(e.id), user.id, null, phase, decision.reason);
        continue;
      }
      if (await this.rateLimited(user.id)) {
        await this.log(Number(e.id), user.id, null, phase, 'skipped_rate_limited');
        await this.tooMany(user.id);
        continue;
      }
      wanted.push(user.id);
    }
    for (const target of await pushTargets(db, wanted)) {
      this.track(this.sendWithRetry(target, payload, Number(e.id)));
    }
  }

  /** "Send test notification" (POST /api/me/devices/:id/test). */
  sendTest(target: PushTarget): void {
    const payload = this.payload('test', testPushMessage(target.label));
    this.track(this.sendWithRetry(target, payload, null));
  }

  private payload(phase: 'test' | 'rate_limit', m: PushMessage): PushPayload {
    return {
      v: 1,
      phase,
      eventId: null,
      ruleId: null,
      level: null,
      ...m,
      ts: this.now().toISOString(),
    };
  }

  private async rateLimited(userId: number): Promise<boolean> {
    const [row] = await this.o.db<{ n: number }[]>`
      select count(*)::int as n from notification_log
      where user_id = ${userId} and status = 'sent' and phase in ('opened', 'escalated', 'resolved')
        and ts > now() - interval '1 hour'`;
    return (row?.n ?? 0) >= MAX_PER_HOUR;
  }

  /** At most one "Too many alerts" push per user per hour. */
  private async tooMany(userId: number): Promise<void> {
    const [recent] = await this.o.db`
      select 1 from notification_log
      where user_id = ${userId} and phase = 'rate_limit' and ts > now() - interval '1 hour' limit 1`;
    if (recent) return;
    const payload = this.payload('rate_limit', {
      title: 'Too many alerts',
      body: 'Open the app to see them all.',
      tag: 'rate_limit',
      url: '/',
    });
    for (const target of await pushTargets(this.o.db, [userId])) {
      this.track(this.sendWithRetry(target, payload, null));
    }
  }

  private track(p: Promise<void>): void {
    const tracked = p.catch((err: unknown) => this.o.log.error({ err }, 'push send crashed'));
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  private async sendWithRetry(target: PushTarget, payload: PushPayload, eventId: number | null) {
    const { db, channel, log } = this.o;
    for (let attempt = 0; ; attempt++) {
      const result = await channel.send(target, payload);
      if (result.ok) {
        await db`update push_subscriptions set last_success_at = now(), failure_count = 0
                 where id = ${target.id}`;
        await this.log(eventId, target.userId, target.id, payload.phase, 'sent');
        return;
      }
      if (result.gone) {
        await this.log(eventId, target.userId, target.id, payload.phase, 'gone');
        await db`delete from push_subscriptions where id = ${target.id}`;
        log.info({ device: endpointHint(target.endpoint) }, 'push subscription gone: removed');
        return;
      }
      const wait = this.delays[attempt];
      if (!result.retry || wait === undefined) {
        await db`update push_subscriptions set failure_count = failure_count + 1 where id = ${target.id}`;
        await this.log(eventId, target.userId, target.id, payload.phase, 'failed', result.error);
        log.warn({ device: endpointHint(target.endpoint), error: result.error }, 'push failed');
        return;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async log(
    eventId: number | null,
    userId: number,
    subscriptionId: number | null,
    phase: PushPayload['phase'],
    status: LogStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.o.db`
      insert into notification_log (event_id, user_id, subscription_id, phase, status, error)
      values (${eventId}, ${userId}, ${subscriptionId}, ${phase}, ${status}, ${error})`;
  }

  /** docs/09 §5: notification_log keeps 90 days. */
  private async cleanup(): Promise<void> {
    try {
      await this.o.db`delete from notification_log where ts < now() - interval '90 days'`;
    } catch (err) {
      this.o.log.warn({ err }, 'notification log cleanup failed');
    }
  }
}
