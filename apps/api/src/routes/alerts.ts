import { ALERT_RULES_CHANNEL, type Sql } from '@home/db';
import {
  AlertRuleOverrideSchema,
  defaultPref,
  formatAlertValue,
  formatDuration,
  formatHeldFor,
  humanise,
  mergeRule,
  MyAlertPutSchema,
  ruleLevels,
  type AdminRule,
  type AlertLevel,
  type AlertPref,
  type AlertRule,
  type AlertRuleOverride,
  type MyAlertRule,
  type MyAlertsResponse,
  type NotificationLogItem,
  type Registry,
  type RuleSettings,
  type ThresholdRule,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { RulesStore } from '../push/rules.js';
import { requireAdmin, requirePerson } from '../users.js';
import { parseInput } from '../validate.js';

const RuleParams = z.object({ ruleId: z.string().regex(/^[a-z][a-z0-9_]*$/) });
const AdminRuleParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/) });
const LogQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

interface SeriesRow {
  source_id: string;
  metric: string;
  entity: string;
  label: string | null;
  unit: string;
}

const matches = (rule: ThresholdRule, s: SeriesRow) =>
  s.metric === rule.match.metric &&
  (!rule.match.sources || rule.match.sources.includes(s.source_id)) &&
  (!rule.match.entities || rule.match.entities.includes(s.entity));

/** "Warning above 1,000 ppm for 15 min · Urgent above 1,500 ppm for 10 min" */
function thresholdDescription(rule: ThresholdRule, unit: string): string {
  const word = rule.direction === 'above' ? 'above' : 'below';
  const part = (name: string, l: { level: number; for: number }) =>
    `${name} ${word} ${formatAlertValue(l.level, unit)} for ${formatHeldFor(l.for * 1000)}`;
  return [part('Warning', rule.warning), ...(rule.alert ? [part('Urgent', rule.alert)] : [])].join(
    ' · ',
  );
}

/** A rule's adjustable settings in the YAML's terms (durations like `15m`). */
function settingsOf(rule: AlertRule): RuleSettings {
  const level = (l: { level: number; for: number } | undefined) =>
    l && { level: l.level, for: formatDuration(l.for) };
  if (rule.type === 'threshold') {
    return {
      enabled: rule.enabled,
      warning: level(rule.warning),
      ...(rule.alert && { alert: level(rule.alert) }),
      clear: level(rule.clear),
    };
  }
  return {
    enabled: rule.enabled,
    ...(rule.type === 'event' && rule.options && { options: rule.options }),
  };
}

/** Two overrides on top of each other: level fields merge, the rest is replaced. */
function combine(a: AlertRuleOverride, b: AlertRuleOverride): AlertRuleOverride {
  const out: AlertRuleOverride = { ...a, ...b };
  for (const k of ['warning', 'alert', 'clear'] as const) {
    if (a[k] || b[k]) out[k] = { ...a[k], ...b[k] };
  }
  if (a.options || b.options) out.options = { ...a.options, ...b.options };
  return out;
}

/** Settings → My alerts, admin Alert thresholds and the notification log (docs/04). */
export function registerAlertRoutes(
  app: FastifyInstance,
  deps: { db: Sql; rules: RulesStore | null; registry: Registry | null },
): void {
  const { db, registry } = deps;
  const loaded = () => {
    const current = deps.rules?.get();
    const file = deps.rules?.file;
    if (!current || !file)
      throw new HttpError(503, 'RULES_UNAVAILABLE', 'Alert rules are not loaded on the Pi');
    return { current, file };
  };
  const series = () => db<SeriesRow[]>`select source_id, metric, entity, label, unit from series`;

  /** What the "Rooms" chips offer for a rule. */
  function entitiesOf(rule: AlertRule, all: SeriesRow[]): { id: string; label: string }[] {
    if (rule.type === 'threshold') {
      const seen = new Map<string, string>();
      for (const s of all.filter((s) => matches(rule, s)))
        if (!seen.has(s.entity)) seen.set(s.entity, s.label ?? humanise(s.entity));
      return [...seen].map(([id, label]) => ({ id, label }));
    }
    if (rule.type === 'freshness') {
      return (registry?.sources ?? [])
        .filter(
          (s) => s.enabled && (rule.match.sources === '*' || rule.match.sources.includes(s.id)),
        )
        .map((s) => ({ id: s.id, label: s.name }));
    }
    return [];
  }

  app.get('/api/me/alerts', async (request): Promise<MyAlertsResponse> => {
    const { user } = requirePerson(request);
    const { current } = loaded();
    const [all, prefRows, openRows] = await Promise.all([
      series(),
      db<(AlertPref & { rule_id: string })[]>`
        select rule_id, enabled, min_level as "minLevel", entities, notify_resolved as "notifyResolved"
        from user_alert_prefs where user_id = ${user.id}`,
      db<
        {
          rule_id: string;
          entity: string;
          source_id: string | null;
          level: AlertLevel;
          since: Date;
        }[]
      >`
        select rule_id, entity, source_id, level, ts as since from events
        where resolved_at is null and rule_id is not null and level in ('warning', 'alert')
        order by ts`,
    ]);
    const prefs = new Map(prefRows.map((p) => [p.rule_id, p]));

    const item = (rule: AlertRule): MyAlertRule => {
      const entities = entitiesOf(rule, all);
      const labels = new Map(entities.map((e) => [e.id, e.label]));
      const saved = prefs.get(rule.id);
      const pref = saved ?? defaultPref(rule, user.role);
      const unit = rule.type === 'threshold' ? (all.find((s) => matches(rule, s))?.unit ?? '') : '';
      return {
        id: rule.id,
        name: rule.name,
        type: rule.type,
        description:
          rule.description ??
          (rule.type === 'threshold'
            ? thresholdDescription(rule, unit)
            : rule.type === 'freshness'
              ? 'When a data source stops sending data'
              : (rule.advice ?? rule.name)),
        levels: ruleLevels(rule),
        entities,
        resolvedNotice: rule.resolvedNotice,
        ruleEnabled: rule.enabled,
        enabled: pref.enabled,
        minLevel: pref.minLevel,
        entitiesSelected: pref.entities,
        notifyResolved: pref.notifyResolved,
        isDefault: !saved,
        open: openRows
          .filter((e) => e.rule_id === rule.id)
          .map((e) => {
            const key = rule.type === 'freshness' ? (e.source_id ?? '') : e.entity;
            return {
              entity: key,
              label: labels.get(key) ?? (key ? humanise(key) : rule.name),
              level: e.level,
              since: e.since.toISOString(),
            };
          }),
      };
    };
    return {
      groups: current.groups
        .map((g) => ({
          id: g.id,
          name: g.name,
          rules: current.rules.filter((r) => r.group === g.id).map(item),
        }))
        .filter((g) => g.rules.length > 0),
    };
  });

  app.put('/api/me/alerts/:ruleId', async (request, reply) => {
    const { user } = requirePerson(request);
    const { ruleId } = parseInput(RuleParams, request.params);
    const body = parseInput(MyAlertPutSchema, request.body);
    const rule = loaded().current.rules.find((r) => r.id === ruleId);
    if (!rule) throw new HttpError(404, 'NOT_FOUND', 'No such alert');
    if (!ruleLevels(rule).includes(body.minLevel))
      throw new HttpError(400, 'BAD_REQUEST', `This alert has no ${body.minLevel} level`);
    await db`
      insert into user_alert_prefs (user_id, rule_id, enabled, min_level, entities, notify_resolved)
      values (${user.id}, ${ruleId}, ${body.enabled}, ${body.minLevel}, ${body.entities}, ${body.notifyResolved})
      on conflict (user_id, rule_id) do update set
        enabled = excluded.enabled, min_level = excluded.min_level, entities = excluded.entities,
        notify_resolved = excluded.notify_resolved, updated_at = now()`;
    return reply.code(204).send();
  });

  app.delete('/api/me/alerts/:ruleId', async (request, reply) => {
    const { user } = requirePerson(request);
    const { ruleId } = parseInput(RuleParams, request.params);
    await db`delete from user_alert_prefs where user_id = ${user.id} and rule_id = ${ruleId}`;
    return reply.code(204).send();
  });

  // --- Admin: alert thresholds ----------------------------------------------------------

  async function adminItems(): Promise<AdminRule[]> {
    const { current, file } = loaded();
    const [all, overrides] = await Promise.all([
      series(),
      db<{ rule_id: string; updated_at: Date; who: string | null }[]>`
        select o.rule_id, o.updated_at, coalesce(u.name, u.email) as who
        from alert_rule_overrides o left join users u on u.id = o.updated_by`,
    ]);
    const byId = new Map(overrides.map((o) => [o.rule_id, o]));
    return current.rules.map((rule) => {
      const raw = file.rules.find((r) => r.id === rule.id)!;
      const base = mergeRule(raw, undefined);
      const o = byId.get(rule.id);
      return {
        id: rule.id,
        group: rule.group,
        name: rule.name,
        type: rule.type,
        direction: rule.type === 'threshold' ? rule.direction : null,
        unit: rule.type === 'threshold' ? (all.find((s) => matches(rule, s))?.unit ?? null) : null,
        effective: settingsOf(rule),
        defaults: 'rule' in base ? settingsOf(base.rule) : settingsOf(rule),
        override: o ? { updatedBy: o.who, updatedAt: o.updated_at.toISOString() } : null,
      };
    });
  }

  const changed = async () => {
    await db`select pg_notify(${ALERT_RULES_CHANNEL}, '')`;
    await deps.rules?.reload();
  };

  app.get('/api/alert-rules', async (request) => {
    requireAdmin(request);
    return { items: await adminItems() };
  });

  app.patch('/api/alert-rules/:id', async (request) => {
    const me = requireAdmin(request);
    const { id } = parseInput(AdminRuleParams, request.params);
    const patch = parseInput(AlertRuleOverrideSchema, request.body);
    const raw = loaded().file.rules.find((r) => r.id === id);
    if (!raw) throw new HttpError(404, 'NOT_FOUND', 'No such alert rule');
    const [existing] = await db<{ params: unknown }[]>`
      select params from alert_rule_overrides where rule_id = ${id}`;
    const before = existing ? AlertRuleOverrideSchema.safeParse(existing.params) : null;
    const params = combine(before?.success ? before.data : {}, patch);
    const merged = mergeRule(raw, params);
    if ('problems' in merged) throw new HttpError(400, 'BAD_REQUEST', merged.problems.join('; '));
    await db`
      insert into alert_rule_overrides (rule_id, params, updated_by, updated_at)
      values (${id}, ${JSON.stringify(params)}::text::jsonb, ${me.id}, now())
      on conflict (rule_id) do update set
        params = excluded.params, updated_by = excluded.updated_by, updated_at = now()`;
    request.log.info({ rule: id, params }, 'alert rule changed');
    await changed();
    return (await adminItems()).find((r) => r.id === id)!;
  });

  app.delete('/api/alert-rules/:id/override', async (request, reply) => {
    requireAdmin(request);
    const { id } = parseInput(AdminRuleParams, request.params);
    await db`delete from alert_rule_overrides where rule_id = ${id}`;
    await changed();
    return reply.code(204).send();
  });

  // --- Admin: recent notifications (System page) -----------------------------------------

  app.get('/api/notifications/log', async (request): Promise<{ items: NotificationLogItem[] }> => {
    requireAdmin(request);
    const { limit } = parseInput(LogQuery, request.query);
    const rows = await db<
      {
        ts: Date;
        who: string;
        rule_id: string | null;
        entity: string | null;
        phase: string;
        status: string;
        device: string | null;
      }[]
    >`
      select l.ts, coalesce(u.name, u.email) as who, e.rule_id, e.entity, l.phase, l.status,
             p.label as device
      from notification_log l
      join users u on u.id = l.user_id
      left join events e on e.id = l.event_id
      left join push_subscriptions p on p.id = l.subscription_id
      order by l.ts desc, l.id desc limit ${limit}`;
    return {
      items: rows.map((r) => ({
        ts: r.ts.toISOString(),
        user: r.who,
        ruleId: r.rule_id,
        entity: r.entity || null,
        phase: r.phase,
        status: r.status,
        device: r.device,
      })),
    };
  });
}
