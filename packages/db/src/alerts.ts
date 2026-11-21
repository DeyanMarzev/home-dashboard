import {
  AlertRuleOverrideSchema,
  AlertsFileSchema,
  buildAlertRules,
  type AlertRuleOverride,
  type AlertRules,
  type AlertsFile,
} from '@home/shared';
import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { parse } from 'yaml';

export class AlertsFileError extends Error {
  override name = 'AlertsFileError';
}

/** Postgres NOTIFY channel: an admin changed a rule override (the collector reloads). */
export const ALERT_RULES_CHANNEL = 'alert_rules_changed';

/** Reads and checks the shape of config/alerts.yaml (each rule is validated when built). */
export async function loadAlertsFile(path: string): Promise<AlertsFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new AlertsFileError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  const parsed = AlertsFileSchema.safeParse(parse(text) ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new AlertsFileError(`Invalid ${path}:\n  - ${problems.join('\n  - ')}`);
  }
  return parsed.data;
}

/** Admin overrides from the database; a malformed row is skipped (and named in `problems`). */
export async function loadAlertOverrides(
  sql: Sql,
): Promise<{ overrides: Map<string, AlertRuleOverride>; problems: string[] }> {
  const rows = await sql<{ rule_id: string; params: unknown }[]>`
    select rule_id, params from alert_rule_overrides`;
  const overrides = new Map<string, AlertRuleOverride>();
  const problems: string[] = [];
  for (const row of rows) {
    const parsed = AlertRuleOverrideSchema.safeParse(row.params);
    if (parsed.success) overrides.set(row.rule_id, parsed.data);
    else problems.push(`${row.rule_id}: stored override is malformed and ignored`);
  }
  return { overrides, problems };
}

/** The effective rules: config/alerts.yaml with the admins' overrides. */
export async function loadAlertRules(sql: Sql, file: AlertsFile): Promise<AlertRules> {
  const { overrides, problems } = await loadAlertOverrides(sql);
  const built = buildAlertRules(file, overrides);
  return { ...built, problems: [...problems, ...built.problems] };
}
