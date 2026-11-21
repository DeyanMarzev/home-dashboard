import { ALERT_RULES_CHANNEL, loadAlertRules, type Sql } from '@home/db';
import type { AlertRules, AlertsFile } from '@home/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { NotificationSource } from '../stream.js';

const RELOAD_MS = 5 * 60_000;

/**
 * The effective alert rules in the api: config/alerts.yaml (read at startup) with the admins'
 * overrides, reloaded on NOTIFY alert_rules_changed and every 5 minutes.
 */
export class RulesStore {
  private current: AlertRules | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(private readonly o: { db: Sql; file: AlertsFile | null; log: FastifyBaseLogger }) {}

  get(): AlertRules | null {
    return this.current;
  }

  async reload(): Promise<void> {
    if (!this.o.file) return;
    try {
      this.current = await loadAlertRules(this.o.db, this.o.file);
    } catch (err) {
      this.o.log.warn({ err }, 'alert rules reload failed; keeping the previous ones');
    }
  }

  async start(notifications: NotificationSource): Promise<void> {
    await this.reload();
    this.unlisten = await notifications.listen(ALERT_RULES_CHANNEL, () => void this.reload());
    this.timer = setInterval(() => void this.reload(), RELOAD_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unlisten?.();
  }
}
