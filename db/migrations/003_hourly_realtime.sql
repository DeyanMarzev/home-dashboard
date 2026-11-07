-- 003 · Real-time hourly rollups.
-- Since TimescaleDB 2.13 a continuous aggregate only returns materialized buckets by default,
-- and the refresh policy stops 1 hour short of now, so the latest hour(s) would be missing
-- from every chart that reads readings_hourly. Real-time mode fills them from raw readings.
ALTER MATERIALIZED VIEW readings_hourly SET (timescaledb.materialized_only = false);
