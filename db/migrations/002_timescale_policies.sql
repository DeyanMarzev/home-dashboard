-- 002 · Hourly rollups, columnstore (compression) and retention (docs/02-data-model.md).
-- Uses the TimescaleDB ≥ 2.18 names (columnstore); checked against 2.31.

-- WITH NO DATA: a continuous aggregate created WITH DATA can't run inside a transaction.
-- The refresh policy below fills it.
CREATE MATERIALIZED VIEW readings_hourly
WITH (timescaledb.continuous) AS
SELECT series_id,
       time_bucket(INTERVAL '1 hour', ts) AS bucket,
       avg(value) AS avg, min(value) AS min, max(value) AS max,
       sum(value) AS sum, count(*) AS n
FROM readings
GROUP BY series_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset      => INTERVAL '10 days',   -- covers late-arriving data (Thames is 3+ days late)
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');

ALTER TABLE readings SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'series_id');
CALL add_columnstore_policy('readings', after => INTERVAL '14 days');  -- after late data has landed
SELECT add_retention_policy('readings', INTERVAL '90 days');           -- raw kept 90 days
-- readings_hourly is kept forever.
