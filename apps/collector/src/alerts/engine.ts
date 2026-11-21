import { loadAlertRules, openEvent, resolveEvent, type Sql } from '@home/db';
import {
  evaluateThreshold,
  formatAlertValue,
  freshness,
  freshnessPolicy,
  humanise,
  windowSeconds,
  type AlertLevel,
  type AlertRules,
  type AlertsFile,
  type ReadingPoint,
  type Registry,
  type ThresholdRule,
} from '@home/shared';
import type { Logger } from 'pino';
import { SOURCE_LATE } from '../late-check.js';

/** Events older than this when the engine first sees them never notify (no stale pushes). */
const ADOPT_WITHIN_MS = 60 * 60_000;

interface SeriesRow {
  id: number;
  source_id: string;
  metric: string;
  entity: string;
  unit: string;
  label: string | null;
}

/**
 * The alert engine (docs/09 §3), run every minute in the collector:
 * - threshold rules: evaluated from each matching series' recent readings (whoever wrote
 *   them, the netprobe container included); opens, escalates and resolves their events;
 * - event and freshness rules: "adopts" open events whose kind is a rule id by setting
 *   `rule_id`, so the dispatcher (api) knows they notify. Covers every writer, even
 *   scripts/backup.sh's plain SQL;
 * - a rule switched off by an admin: its threshold events are resolved, and other events
 *   stop notifying (`rule_id` cleared) but stay visible.
 */
export class AlertEngine {
  private rules: AlertRules | null = null;
  private dirty = true;
  private reportedProblems = '';

  constructor(private readonly o: { db: Sql; registry: Registry; file: AlertsFile; log: Logger }) {}

  /** An admin changed an override (NOTIFY alert_rules_changed): reload before the next tick. */
  markDirty(): void {
    this.dirty = true;
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.dirty || !this.rules) {
      this.rules = await loadAlertRules(this.o.db, this.o.file);
      this.dirty = false;
      const problems = this.rules.problems.join('\n');
      if (problems !== this.reportedProblems) {
        if (problems) this.o.log.warn({ problems: this.rules.problems }, 'alert rule problems');
        this.reportedProblems = problems;
      }
    }
    const rules = this.rules.rules;
    await this.switchOff(rules.filter((r) => !r.enabled));
    const live = rules.filter((r) => r.enabled);
    await this.thresholds(
      live.filter((r): r is ThresholdRule => r.type === 'threshold'),
      now,
    );
    await this.adopt(live, now);
  }

  private async thresholds(rules: ThresholdRule[], now: Date): Promise<void> {
    if (rules.length === 0) return;
    const { db, registry, log } = this.o;
    const series = await db<SeriesRow[]>`
      select id, source_id, metric, entity, unit, label from series
      where metric = any(${[...new Set(rules.map((r) => r.match.metric))]}::text[])`;
    const openRows = await db<
      { rule_id: string; source_id: string; entity: string; level: AlertLevel }[]
    >`
      select rule_id, source_id, entity, level from events
      where resolved_at is null and rule_id = any(${rules.map((r) => r.id)}::text[])`;
    const open = new Map(openRows.map((e) => [`${e.rule_id}|${e.source_id}|${e.entity}`, e.level]));

    for (const rule of rules) {
      const matched = series.filter(
        (s) =>
          s.metric === rule.match.metric &&
          (!rule.match.sources || rule.match.sources.includes(s.source_id)) &&
          (!rule.match.entities || rule.match.entities.includes(s.entity)),
      );
      if (matched.length === 0) continue;
      const sources = new Map(registry.sources.map((s) => [s.id, s]));
      const cadence = Math.max(
        0,
        ...matched.map((s) => {
          const src = sources.get(s.source_id);
          return src ? (freshnessPolicy(src).cadenceSeconds ?? 0) : 0;
        }),
      );
      const from = new Date(now.getTime() - windowSeconds(rule, cadence) * 1000);
      const rows = await db<{ series_id: number; ts: Date; value: number }[]>`
        select series_id, ts, value from readings
        where series_id = any(${matched.map((s) => s.id)}::int[]) and ts > ${from} and ts <= ${now}
        order by series_id, ts`;
      const points = new Map<number, ReadingPoint[]>();
      for (const r of rows) {
        const list = points.get(r.series_id) ?? [];
        list.push({ ts: r.ts.getTime(), value: r.value });
        points.set(r.series_id, list);
      }

      for (const s of matched) {
        const pts = points.get(s.id) ?? [];
        const src = sources.get(s.source_id);
        const last = pts.at(-1);
        // A disabled or unknown source, or one gone Late, freezes the state.
        const stale =
          !src?.enabled ||
          !last ||
          freshness(freshnessPolicy(src), { ts: new Date(last.ts) }, now).state === 'late';
        const key = `${rule.id}|${s.source_id}|${s.entity}`;
        const action = evaluateThreshold(rule, pts, open.get(key) ?? null, now.getTime(), stale);
        if (action.kind === 'none') continue;

        const label = s.label ?? humanise(s.entity);
        if (action.kind === 'resolve') {
          await resolveEvent(db, s.source_id, rule.id, s.entity);
          log.info({ rule: rule.id, entity: s.entity, value: action.value }, 'alert resolved');
          continue;
        }
        const level = action.kind === 'open' ? action.level : 'alert';
        await openEvent(db, {
          level,
          sourceId: s.source_id,
          kind: rule.id,
          entity: s.entity,
          ruleId: rule.id,
          message: `${rule.name} · ${label} ${formatAlertValue(action.value, s.unit)}`,
          data: {
            value: action.value,
            unit: s.unit,
            label,
            since: new Date(action.since).toISOString(),
          },
        });
        log.info(
          { rule: rule.id, entity: s.entity, level, value: action.value },
          `alert ${action.kind === 'open' ? 'opened' : 'escalated'}`,
        );
      }
    }
  }

  /** Gives open events of event and freshness rules their rule_id (and wakes the dispatcher). */
  private async adopt(rules: AlertRules['rules'], now: Date): Promise<void> {
    const since = new Date(now.getTime() - ADOPT_WITHIN_MS);
    const kinds = rules.filter((r) => r.type === 'event').map((r) => r.id);
    if (kinds.length > 0) {
      await this.o.db`
        with adopted as (
          update events set rule_id = kind
          where rule_id is null and resolved_at is null and level in ('warning', 'alert')
            and kind = any(${kinds}::text[]) and ts > ${since}
          returning id)
        select pg_notify('events', id::text) from adopted`;
    }
    for (const rule of rules) {
      if (rule.type !== 'freshness') continue;
      const all = rule.match.sources === '*';
      const sources = all ? [] : (rule.match.sources as string[]);
      await this.o.db`
        with adopted as (
          update events set rule_id = ${rule.id}
          where rule_id is null and resolved_at is null and level in ('warning', 'alert')
            and kind = ${SOURCE_LATE} and ts > ${since}
            and (${all}::boolean or source_id = any(${sources}::text[]))
          returning id)
        select pg_notify('events', id::text) from adopted`;
    }
  }

  /** Rules switched off by an admin (docs/09 §3 Admin overrides). */
  private async switchOff(rules: AlertRules['rules']): Promise<void> {
    if (rules.length === 0) return;
    const thresholdIds = rules.filter((r) => r.type === 'threshold').map((r) => r.id);
    const otherIds = rules.filter((r) => r.type !== 'threshold').map((r) => r.id);
    if (thresholdIds.length > 0) {
      await this.o.db`
        update events set resolved_at = now(),
          data = coalesce(data, '{}'::jsonb) || '{"reason": "rule_disabled"}'::jsonb
        where resolved_at is null and rule_id = any(${thresholdIds}::text[])`;
    }
    if (otherIds.length > 0) {
      await this.o.db`
        update events set rule_id = null where resolved_at is null and rule_id = any(${otherIds}::text[])`;
    }
  }
}
