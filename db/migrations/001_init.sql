-- 001 · Core schema (docs/02-data-model.md).
-- Every migration runs in a single transaction (packages/db/src/migrate.ts).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Mirrors config/sources.yaml; synced at startup by api and collector.
CREATE TABLE sources (
  id               text PRIMARY KEY,                -- 'smart_meters', stable forever
  name             text NOT NULL,                   -- 'Smart meters'
  kind             text NOT NULL CHECK (kind IN ('sensor','api','scrape','local','derived')),
  poll_interval    interval,                        -- NULL for push and cron-scheduled sources
  expected_delay   interval NOT NULL DEFAULT '0',   -- how far behind data normally is
  grace            interval,                        -- override; NULL = default rule
  enabled          boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One stream of numbers: a metric for an entity. Created on first write.
CREATE TABLE series (
  id          serial PRIMARY KEY,
  source_id   text NOT NULL REFERENCES sources(id),
  metric      text NOT NULL,                        -- 'temperature'
  entity      text NOT NULL DEFAULT '',             -- 'living_room'
  unit        text NOT NULL,                        -- '°C'
  value_type  text NOT NULL CHECK (value_type IN ('gauge','interval_total','state')),
  interval    interval,                             -- what each interval_total value covers
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
  PRIMARY KEY (series_id, ts)                       -- also serves "latest per series" (backward scan)
);
-- No default ts index: every query filters by series_id, so the primary key covers them,
-- and each extra index costs writes on the Pi.
SELECT create_hypertable('readings', by_range('ts', INTERVAL '7 days'), create_default_indexes => false);

-- Upsert pattern used by every collector (packages/db/src/readings.ts):
-- INSERT INTO readings (series_id, ts, value) VALUES ...
-- ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value, received_at = now();

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
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  level       text NOT NULL CHECK (level IN ('info','warning','alert')),
  source_id   text REFERENCES sources(id),
  kind        text NOT NULL,                        -- 'co2_high', 'source_late', 'new_device'
  message     text NOT NULL,
  data        jsonb,
  resolved_at timestamptz
);
CREATE INDEX ON events (ts DESC);
-- At most one open event of a kind per source (e.g. one open 'source_late' per source).
CREATE UNIQUE INDEX events_one_open_per_source_kind ON events (source_id, kind) WHERE resolved_at IS NULL;

CREATE TABLE tariffs (
  id               serial PRIMARY KEY,
  fuel             text NOT NULL CHECK (fuel IN ('electricity','gas','water')),
  unit_rate_pence  numeric(8,3) NOT NULL,           -- per kWh (or per m³ for water)
  standing_pence   numeric(8,3) NOT NULL DEFAULT 0, -- per day
  valid_from       date NOT NULL,
  valid_to         date
);

-- Newest reading per series, for freshness. For interval_total series the data covers
-- up to latest_ts + interval; the shared freshness logic adds that.
CREATE VIEW series_latest AS
SELECT s.id AS series_id, s.source_id, l.ts AS latest_ts, l.value, l.received_at
FROM series s
LEFT JOIN LATERAL (
  SELECT ts, value, received_at FROM readings r
  WHERE r.series_id = s.id ORDER BY ts DESC LIMIT 1
) l ON true;
