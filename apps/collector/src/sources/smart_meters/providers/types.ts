import type { ReadingInput } from '@home/shared';
import type { Logger } from 'pino';
import type { CollectorEnv } from '../../../env.js';

/**
 * Where half-hourly electricity and gas data comes from (docs/03 § smart_meters). Each
 * provider returns `energy_import` interval_total readings (kWh per 30 min) on entities
 * `electricity` and `gas`, converting gas m³ with `gasKwhFromM3` where needed.
 */
export interface MeterProvider {
  readonly id: string;
  fetch(
    from: Date,
    to: Date,
    ctx: { env: CollectorEnv; signal: AbortSignal; log: Logger },
  ): Promise<ReadingInput[]>;
}
