# 02 · Data model

PostgreSQL 17 + TimescaleDB. One generic readings table for every source, so adding a source never needs a schema change.

## Concepts

- **Source**: where data comes from (`room_sensors`, `nest`, `smart_meters`). Defined in `config/sources.yaml`, mirrored into the `sources` table at startup.
- **Series**: one stream of numbers from a source: a *metric* for an *entity* (`room_sensors` / `co2` / `kitchen`). Created automatically the first time a collector writes it.
- **Reading**: one value of a series at a time `ts`.

## Value types

| `value_type` | Meaning | Example | How to aggregate |
|---|---|---|---|
| `gauge` | Instantaneous measurement | temperature, CO₂, signal | avg / min / max |
| `interval_total` | Amount used during `[ts, ts + interval)` | kWh per 30 min, litres per hour | sum |
| `state` | Numeric code for a state | boiler 0 = off, 1 = heating | duration in state |

## Schema (migration `001_init.sql`)

The migration files in `db/migrations/` are the source of truth; this block mirrors `001_init.sql`.

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE sources (
  id               text PRIMARY KEY,                -- 'smart_meters'
  name             text NOT NULL,                   -- 'Smart meters'
  kind             text NOT NULL CHECK (kind IN ('sensor','api','scrape','local','derived')),
  poll_interval    interval,                        -- NULL for push and cron-scheduled sources
  expected_delay   interval NOT NULL DEFAULT '0',   -- how far behind data normally is
  grace            interval,                        -- override; NULL = default rule
  enabled          boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE series (
  id          serial PRIMARY KEY,
  source_id   text NOT NULL REFERENCES sources(id),
  metric      text NOT NULL,                        -- 'temperature'
  entity      text NOT NULL DEFAULT '',             -- 'living_room'
  unit        text NOT NULL,                        -- '°C'
  value_type  text NOT NULL CHECK (value_type IN ('gauge','interval_total','state')),
  interval    interval,                             -- required for interval_total
  label       text,                                 -- optional display name
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, metric, entity),
  CHECK ((value_type = 'interval_total') = (interval IS NOT NULL))
);

CREATE TABLE readings (
  series_id    int NOT NULL REFERENCES series(id),
  ts           timestamptz NOT NULL,                -- time the value is FOR
  value        double precision NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),  -- when we stored it
  PRIMARY KEY (series_id, ts)
);
-- No default ts index: every query filters by series_id, so the primary key covers them.
SELECT create_hypertable('readings', by_range('ts', INTERVAL '7 days'), create_default_indexes => false);

-- Upsert pattern used by every collector:
-- INSERT INTO readings (series_id, ts, value) VALUES ...
-- ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value, received_at = now();

-- No separate (series_id, ts DESC) index: the primary key serves "latest per series" with a
-- backward scan, and every extra index costs writes on the Pi.

CREATE TABLE collector_runs (
  id           bigserial PRIMARY KEY,
  source_id    text NOT NULL REFERENCES sources(id),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  ok           boolean,
  rows_written int,
  error        text
);
CREATE INDEX ON collector_runs (source_id, started_at DESC);

CREATE TABLE events (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  level      text NOT NULL CHECK (level IN ('info','warning','alert')),
  source_id  text REFERENCES sources(id),
  kind       text NOT NULL,                         -- 'co2_high', 'source_late', 'new_device'
  message    text NOT NULL,
  data       jsonb,
  resolved_at timestamptz
);
CREATE INDEX ON events (ts DESC);
-- At most one open event of a kind per source (e.g. one open 'source_late').
CREATE UNIQUE INDEX events_one_open_per_source_kind ON events (source_id, kind) WHERE resolved_at IS NULL;

CREATE TABLE tariffs (
  id               serial PRIMARY KEY,
  fuel             text NOT NULL CHECK (fuel IN ('electricity','gas','water')),
  unit_rate_pence  numeric(8,3) NOT NULL,          -- per kWh (or per m³ for water)
  standing_pence   numeric(8,3) NOT NULL DEFAULT 0,-- per day
  valid_from       date NOT NULL,
  valid_to         date
);
```

## Migrations

- Plain numbered SQL files in `db/migrations/` (`001_init.sql`, `002_...`), applied in order at startup by **both** `api` and `collector` (`packages/db/src/migrate.ts`), recorded in `schema_migrations` (version, name, sha256 checksum).
- Each file runs in **one transaction** holding a transaction-level advisory lock, so two processes starting at once can't both apply it. Anything that can't run in a transaction is not allowed in a migration (e.g. a continuous aggregate `WITH DATA`).
- **Never edit an applied migration.** The runner compares checksums and refuses to start if one changed. Add a new file instead.
- Tests run the migrations on PGlite (real Postgres in WebAssembly) with TimescaleDB's two functions in `001` stubbed and `002` skipped, and on real TimescaleDB when `TEST_DATABASE_URL` is set (see `packages/db/src/test/database.ts`).

## Writing readings

`createReadingWriter(sql).write(sourceId, readings)` in `packages/db/src/readings.ts` is the only way collectors write data:

- Validates every reading (`ReadingInputSchema` in `packages/shared`): snake_case keys, finite values, timestamps with a zone, `interval` exactly when `interval_total`. One bad reading rejects the whole batch.
- Creates missing series; rejects a reading whose unit, value type or interval differs from its existing series.
- Upserts on `(series_id, ts)` in chunks of 5,000 rows; repeated timestamps within a batch keep the last value.
- `NOTIFY readings` with `{"seriesId", "ts", "value"}` for the newest point of each series in the batch, in the same transaction (delivered on commit).
- All of it in one transaction: a failed batch writes nothing.

## Freshness view

The API computes freshness in TypeScript (shared logic), but needs the latest timestamp per series cheaply:

```sql
CREATE VIEW series_latest AS
SELECT s.id AS series_id, s.source_id, l.ts AS latest_ts, l.value, l.received_at
FROM series s
LEFT JOIN LATERAL (
  SELECT ts, value, received_at FROM readings r
  WHERE r.series_id = s.id ORDER BY ts DESC LIMIT 1
) l ON true;
```

For `interval_total` series, the `dataTo` used for freshness is `latest_ts + interval` (the end of the last complete interval). The shared logic handles that from the series' `interval`.

## Aggregates, compression, retention (migration `002_timescale_policies.sql`)

```sql
CREATE MATERIALIZED VIEW readings_hourly
WITH (timescaledb.continuous) AS
SELECT series_id,
       time_bucket(INTERVAL '1 hour', ts) AS bucket,
       avg(value) AS avg, min(value) AS min, max(value) AS max,
       sum(value) AS sum, count(*) AS n
FROM readings
GROUP BY series_id, bucket
WITH NO DATA;   -- WITH DATA can't run inside the migration's transaction; the policy fills it

SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset => INTERVAL '10 days',      -- covers late-arriving data (Thames is 3+ days late)
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');

-- TimescaleDB ≥ 2.18 names ("columnstore" = compression); checked against 2.31.
ALTER TABLE readings SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'series_id');
CALL add_columnstore_policy('readings', after => INTERVAL '14 days');   -- after late data has landed
SELECT add_retention_policy('readings', INTERVAL '90 days');      -- raw kept 90 days
-- readings_hourly is kept forever.
```

Daily totals for the UI are computed from `readings_hourly` using Europe/London day boundaries:

```sql
SELECT time_bucket(INTERVAL '1 day', bucket, 'Europe/London') AS day, sum(sum)
FROM readings_hourly WHERE series_id = $1 AND bucket >= $2 GROUP BY day ORDER BY day;
```

## Query rules for the API

- Range ≤ 48 h and raw requested → `readings`.
- Otherwise → `readings_hourly`, bucketed further in SQL (`1 day`, Europe/London).
- Downsample to at most ~600 points per series per response.
- `gauge` series aggregate with avg (plus min/max when asked); `interval_total` with sum; `state` with time-weighted share.

## Example series

| source_id | metric | entity | unit | value_type | interval |
|---|---|---|---|---|---|
| room_sensors | temperature | living_room | °C | gauge | |
| room_sensors | co2 | kitchen | ppm | gauge | |
| nest | target_temperature | hallway | °C | gauge | |
| nest | hvac_heating | boiler | state | state | |
| boiler_probes | temperature | boiler_flow | °C | gauge | |
| smart_meters | energy_import | electricity | kWh | interval_total | 30 min |
| smart_meters | energy_import | gas | kWh | interval_total | 30 min |
| thames_water | volume | mains | L | interval_total | 1 hour |
| pi_stats | cpu_temperature | pi | °C | gauge | |
| carbon_intensity | intensity | grid | gCO₂/kWh | gauge | |
