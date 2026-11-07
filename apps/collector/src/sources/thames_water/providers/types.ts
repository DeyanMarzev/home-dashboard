import type { ReadingInput } from '@home/shared';
import type { Logger } from 'pino';
import type { CollectorEnv } from '../../../env.js';

/**
 * Where hourly water use comes from (docs/03 § thames_water). Returns `volume` interval_total
 * readings (litres per hour) on entity `mains`, and optionally `meter_reading` (m³, gauge).
 * Each call may log in, so the collector limits how often it's called.
 */
export interface WaterProvider {
  readonly id: string;
  fetch(
    from: Date,
    to: Date,
    ctx: { env: CollectorEnv; signal: AbortSignal; log: Logger },
  ): Promise<ReadingInput[]>;
}
