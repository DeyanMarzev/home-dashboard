import { z } from 'zod';
import { DURATION_PATTERN, parseDuration } from './duration.js';
import { SNAKE_CASE } from './ids.js';
import type { FreshnessPolicy } from './freshness.js';

/**
 * The source registry (`config/sources.yaml`, docs/03-sources-and-freshness.md).
 * This module validates the already-parsed YAML; reading the file is Node-side (@home/db).
 */

export const SOURCE_KINDS = ['sensor', 'api', 'scrape', 'local', 'derived'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type Poll = { type: 'every'; seconds: number } | { type: 'cron'; expression: string };

export interface SourceConfig {
  id: string;
  name: string;
  /** What it provides, shown in the data sources table, e.g. "Temp, humidity, CO₂, pressure". */
  description: string | null;
  kind: SourceKind;
  /** How a pull source is scheduled; null for push sources (kind `sensor`). */
  poll: Poll | null;
  /** How often a push source normally reports. */
  pushIntervalSeconds: number | null;
  expectedDelaySeconds: number;
  /** Override of the default grace for delayed sources; null = default rule. */
  graceSeconds: number | null;
  enabled: boolean;
  mqttTopic: string | null;
  /** Source-specific settings for its collector (anything not secret; secrets live in .env). */
  options: Record<string, unknown>;
}

export interface Registry {
  sources: SourceConfig[];
}

/** Sources with an expected delay at or below this are "live-capable" (docs/03). */
export const LIVE_THRESHOLD_SECONDS = 15 * 60;

const CRON_PREFIX = 'cron:';

const duration = z
  .string()
  .regex(DURATION_PATTERN, 'expected a duration like 30s, 15m, 6h or 1d')
  .transform(parseDuration);

const poll = z.string().transform((value, ctx): Poll => {
  const text = value.trim();
  if (text.startsWith(CRON_PREFIX)) {
    const expression = text.slice(CRON_PREFIX.length).trim();
    if (expression.split(/\s+/).length !== 5) {
      ctx.addIssue({ code: 'custom', message: `cron needs 5 fields, got "${expression}"` });
      return z.NEVER;
    }
    return { type: 'cron', expression };
  }
  if (!DURATION_PATTERN.test(text)) {
    ctx.addIssue({ code: 'custom', message: 'expected a duration like 15m or "cron: 0 6 * * *"' });
    return z.NEVER;
  }
  const seconds = parseDuration(text);
  if (seconds === 0) {
    ctx.addIssue({ code: 'custom', message: 'poll must be longer than 0s' });
    return z.NEVER;
  }
  return { type: 'every', seconds };
});

const SourceEntrySchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    kind: z.enum(SOURCE_KINDS),
    poll: poll.optional(),
    push_interval: duration.optional(),
    expected_delay: duration.default(0),
    grace: duration.optional(),
    enabled: z.boolean().default(true),
    mqtt_topic: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'sensor') {
      if (s.push_interval === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['push_interval'],
          message: 'push sources (kind: sensor) need push_interval',
        });
      }
      if (s.poll !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['poll'],
          message: 'push sources (kind: sensor) are not polled',
        });
      }
    } else if (s.poll === undefined) {
      ctx.addIssue({ code: 'custom', path: ['poll'], message: `kind: ${s.kind} needs poll` });
    }
    // A live source's Live window is derived from its cadence; a cron has no fixed cadence.
    if (s.poll?.type === 'cron' && s.expected_delay <= LIVE_THRESHOLD_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['poll'],
        message: 'a live source (expected_delay ≤ 15m) needs a duration poll, not cron',
      });
    }
  });

const RegistrySchema = z
  .strictObject({ sources: z.record(z.string(), SourceEntrySchema) })
  // Checked here rather than as the record's key schema: zod reports key errors only as
  // "Invalid key in record".
  .superRefine((registry, ctx) => {
    for (const id of Object.keys(registry.sources)) {
      if (!SNAKE_CASE.test(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', id],
          message: 'source ids must be snake_case, e.g. room_sensors',
        });
      }
    }
  });

export class RegistryError extends Error {
  override name = 'RegistryError';
}

/** Validates parsed `sources.yaml` content. Throws a RegistryError listing every problem. */
export function parseRegistry(raw: unknown): Registry {
  const result = RegistrySchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new RegistryError(`Invalid source registry:\n  - ${problems.join('\n  - ')}`);
  }
  return {
    sources: Object.entries(result.data.sources).map(([id, s]) => ({
      id,
      name: s.name,
      description: s.description ?? null,
      kind: s.kind,
      poll: s.poll ?? null,
      pushIntervalSeconds: s.push_interval ?? null,
      expectedDelaySeconds: s.expected_delay,
      graceSeconds: s.grace ?? null,
      enabled: s.enabled,
      mqttTopic: s.mqtt_topic ?? null,
      options: s.options,
    })),
  };
}

/** The registry fields freshness needs. */
export function freshnessPolicy(source: SourceConfig): FreshnessPolicy {
  return {
    expectedDelaySeconds: source.expectedDelaySeconds,
    cadenceSeconds:
      source.poll?.type === 'every' ? source.poll.seconds : source.pushIntervalSeconds,
    graceSeconds: source.graceSeconds,
  };
}
