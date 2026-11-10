import type { Sql } from 'postgres';
import { EVENTS_CHANNEL } from './events.js';

export interface PublishedTariff {
  fuel: 'electricity' | 'gas' | 'water';
  /** Per kWh, or per m³ for water. */
  unitRatePence: number;
  /** Per day. */
  standingPence: number;
  /** London date (YYYY-MM-DD) the rates took effect. */
  validFrom: string;
  /** Who published them, for the event message ("Thames Water"). */
  publisher: string;
}

/**
 * Adds rates fetched from a supplier's public page, the same way the tariff editor would:
 * the previous row for the fuel now ends the day before, so dates never overlap. Skipped
 * (returns false) when a row for the fuel already starts on or after that date: rates the
 * owner entered win, and re-fetching the same rates changes nothing. Records an info event.
 */
export async function addPublishedTariff(sql: Sql, t: PublishedTariff): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [later] = await tx`
      select 1 from tariffs where fuel = ${t.fuel} and valid_from >= ${t.validFrom}::date limit 1`;
    if (later) return false;
    await tx`
      update tariffs set valid_to = ${t.validFrom}::date - 1
      where fuel = ${t.fuel} and (valid_to is null or valid_to >= ${t.validFrom}::date)`;
    await tx`
      insert into tariffs (fuel, unit_rate_pence, standing_pence, valid_from)
      values (${t.fuel}, ${t.unitRatePence}, ${t.standingPence}, ${t.validFrom}::date)`;
    const [event] = await tx<{ id: string }[]>`
      insert into events (level, source_id, kind, message, data, resolved_at)
      values ('info', null, 'tariff_updated',
              ${`${t.fuel[0]!.toUpperCase()}${t.fuel.slice(1)} rates from ${t.publisher} added: ${t.unitRatePence} p per ${t.fuel === 'water' ? 'm³' : 'kWh'}, ${t.standingPence} p a day, from ${t.validFrom}`},
              ${JSON.stringify(t)}::jsonb, now())
      returning id`;
    await tx`select pg_notify(${EVENTS_CHANNEL}, ${event!.id})`;
    return true;
  });
}
