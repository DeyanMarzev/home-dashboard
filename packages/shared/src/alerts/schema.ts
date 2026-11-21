import { z } from 'zod';
import { DURATION_PATTERN, parseDuration } from '../duration.js';

/**
 * config/alerts.yaml (docs/09 §3, docs/10 §1–2): which alert rules exist, their wording and
 * default thresholds. Admin edits are stored as overrides (`alert_rule_overrides.params`)
 * and deep-merged on top; the merged rule is validated with the same schema.
 */

export const ALERT_LEVELS = ['warning', 'alert'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];
export const AUDIENCES = ['all', 'admins', 'none'] as const;

const snake = z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected a snake_case id');

/** `15m` → 900; `for` durations are between 1 minute and 24 hours. */
const ForDuration = z
  .string()
  .regex(DURATION_PATTERN, 'expected a duration like 15m or 6h')
  .transform(parseDuration)
  .refine((s) => s >= 60 && s <= 86_400, 'must be between 1 min and 24 h');

const Level = z.strictObject({ level: z.number().finite(), for: ForDuration });

const common = {
  id: snake,
  group: snake,
  name: z.string().min(1),
  advice: z.string().min(1).optional(),
  /** Where tapping the notification goes; threshold rules add `#<entity>`. */
  link: z.string().regex(/^\//, 'must start with /'),
  /** Title for the "back to normal" push (default: "<name> back to normal"). */
  resolvedName: z.string().min(1).optional(),
  /** false: never send a "back to normal" push for this rule. */
  resolvedNotice: z.boolean().default(true),
  /** false (admin override): the rule is off for everyone. */
  enabled: z.boolean().default(true),
  defaults: z.strictObject({ audience: z.enum(AUDIENCES), minLevel: z.enum(ALERT_LEVELS) }),
};

const ThresholdRuleSchema = z.strictObject({
  ...common,
  type: z.literal('threshold'),
  match: z.strictObject({
    metric: snake,
    sources: z.array(snake).min(1).optional(),
    entities: z.array(snake).min(1).optional(),
  }),
  direction: z.enum(['above', 'below']),
  warning: Level,
  /** Optional: a rule with only `warning` never escalates (docs/10 §1.1). */
  alert: Level.optional(),
  clear: Level,
});

const FreshnessRuleSchema = z.strictObject({
  ...common,
  type: z.literal('freshness'),
  match: z.strictObject({ sources: z.union([z.literal('*'), z.array(snake).min(1)]) }),
  level: z.enum(ALERT_LEVELS),
});

const EventRuleSchema = z.strictObject({
  ...common,
  type: z.literal('event'),
  level: z.enum(ALERT_LEVELS),
  /** Rule-specific switches admins can override (docs/10 §1.6). */
  options: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
});

export const AlertRuleSchema = z
  .discriminatedUnion('type', [ThresholdRuleSchema, FreshnessRuleSchema, EventRuleSchema])
  .superRefine((rule, ctx) => {
    if (rule.type !== 'threshold') return;
    for (const problem of thresholdOrderProblems(rule))
      ctx.addIssue({ code: 'custom', message: problem });
  });

export type AlertRule = z.output<typeof AlertRuleSchema>;
export type ThresholdRule = Extract<AlertRule, { type: 'threshold' }>;
export type FreshnessRule = Extract<AlertRule, { type: 'freshness' }>;
export type EventRule = Extract<AlertRule, { type: 'event' }>;

/** above: clear < warning ≤ alert; below: clear > warning ≥ alert (hysteresis, docs/09 §3). */
function thresholdOrderProblems(r: ThresholdRule): string[] {
  const out: string[] = [];
  if (r.direction === 'above') {
    if (!(r.clear.level < r.warning.level)) out.push('clear must be below the warning level');
    if (r.alert && !(r.warning.level <= r.alert.level))
      out.push('the urgent level must be at or above the warning level');
  } else {
    if (!(r.clear.level > r.warning.level)) out.push('clear must be above the warning level');
    if (r.alert && !(r.warning.level >= r.alert.level))
      out.push('the urgent level must be at or below the warning level');
  }
  return out;
}

/** The levels a rule can reach: `['warning']` for single-level rules. */
export function ruleLevels(rule: AlertRule): AlertLevel[] {
  if (rule.type === 'threshold') return rule.alert ? ['warning', 'alert'] : ['warning'];
  return [rule.level];
}

export const AlertsFileSchema = z.strictObject({
  groups: z.array(z.strictObject({ id: snake, name: z.string().min(1) })).min(1),
  /** Validated one by one (after merging overrides), so one bad rule names itself. */
  rules: z.array(z.record(z.string(), z.unknown())).min(1),
});
export type AlertsFile = z.output<typeof AlertsFileSchema>;
export type AlertGroup = AlertsFile['groups'][number];

const PartialLevel = z.strictObject({ level: z.number().finite(), for: z.string() }).partial();

/** What an admin may change (docs/09 §3 Admin overrides). Durations as in the YAML (`15m`). */
export const AlertRuleOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  warning: PartialLevel.optional(),
  alert: PartialLevel.optional(),
  clear: PartialLevel.optional(),
  options: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
});
export type AlertRuleOverride = z.output<typeof AlertRuleOverrideSchema>;

/**
 * YAML rule + override → the effective rule, or the problems (as admin-facing text). An
 * override can't add a level, or options, the YAML doesn't define.
 */
export function mergeRule(
  raw: Record<string, unknown>,
  override: AlertRuleOverride | undefined,
): { rule: AlertRule } | { problems: string[] } {
  const merged: Record<string, unknown> = { ...raw };
  const problems: string[] = [];
  if (override) {
    if (override.enabled !== undefined) merged.enabled = override.enabled;
    for (const key of ['warning', 'alert', 'clear'] as const) {
      const change = override[key];
      if (!change) continue;
      const base = raw[key];
      if (base === undefined || base === null || typeof base !== 'object') {
        problems.push(`${key}: this rule has no ${key} level to change`);
        continue;
      }
      merged[key] = { ...base, ...change };
    }
    if (override.options) {
      const base = raw.options;
      if (!base || typeof base !== 'object') problems.push('options: this rule has no options');
      else {
        for (const k of Object.keys(override.options)) {
          if (!(k in base)) problems.push(`options.${k}: not an option of this rule`);
        }
        merged.options = { ...base, ...override.options };
      }
    }
  }
  const parsed = AlertRuleSchema.safeParse(merged);
  if (!parsed.success) {
    problems.push(
      ...parsed.error.issues.map((i) =>
        i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
      ),
    );
  }
  return problems.length > 0 || !parsed.success ? { problems } : { rule: parsed.data };
}

export interface AlertRules {
  groups: AlertGroup[];
  rules: AlertRule[];
  /** Rules left out, with why: a bad override falls back to the YAML rule. */
  problems: string[];
}

/**
 * The effective rules: each YAML rule with its override. A YAML rule that's invalid is left
 * out (and named); an invalid override is ignored for that rule (and named).
 */
export function buildAlertRules(
  file: AlertsFile,
  overrides: ReadonlyMap<string, AlertRuleOverride>,
): AlertRules {
  const groupIds = new Set(file.groups.map((g) => g.id));
  const seen = new Set<string>();
  const rules: AlertRule[] = [];
  const problems: string[] = [];
  file.rules.forEach((raw, i) => {
    const id = typeof raw.id === 'string' ? raw.id : `rules[${i}]`;
    const base = mergeRule(raw, undefined);
    if ('problems' in base) {
      problems.push(`${id}: ${base.problems.join('; ')}`);
      return;
    }
    if (seen.has(base.rule.id)) {
      problems.push(`${id}: duplicate rule id`);
      return;
    }
    seen.add(base.rule.id);
    if (!groupIds.has(base.rule.group)) {
      problems.push(`${id}: unknown group "${base.rule.group}"`);
      return;
    }
    const override = overrides.get(base.rule.id);
    const merged = override ? mergeRule(raw, override) : base;
    if ('problems' in merged) {
      problems.push(`${id}: override ignored (${merged.problems.join('; ')})`);
      rules.push(base.rule);
    } else rules.push(merged.rule);
  });
  return { groups: file.groups, rules, problems };
}
