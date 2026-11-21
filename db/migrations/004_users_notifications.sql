-- 004 · Users, push notifications and alert rules (M11; docs/02 § Users and notifications,
-- docs/09). Rules themselves live in config/alerts.yaml, so rule_id columns are plain text.

-- --- events: entity, rule link and dispatch state ------------------------------------------

ALTER TABLE events
  ADD COLUMN entity                 text NOT NULL DEFAULT '',  -- 'kitchen', a MAC, a warning id; '' = source-wide
  ADD COLUMN rule_id                text,                      -- set when the event should notify
  ADD COLUMN escalated_at           timestamptz,
  ADD COLUMN dispatched_at          timestamptz,               -- opened/escalated push handled
  ADD COLUMN resolved_dispatched_at timestamptz;               -- resolved push handled

-- One open event per source + kind + entity (was: per source + kind). Rows without a source
-- (backups) stay unconstrained, as before: NULLs are distinct.
DROP INDEX events_one_open_per_source_kind;
CREATE UNIQUE INDEX events_one_open ON events (source_id, kind, entity) WHERE resolved_at IS NULL;

-- Dispatcher work queue: only rows that notify.
CREATE INDEX events_to_dispatch ON events (ts)
  WHERE rule_id IS NOT NULL AND (dispatched_at IS NULL OR resolved_dispatched_at IS NULL);

-- NOTIFY 'events' with the id on insert and when level, resolved_at or escalated_at change.
-- Replaces the explicit pg_notify calls in the TypeScript helpers, and also covers
-- scripts/backup.sh's plain INSERTs. The API's SSE stream and dispatcher listen on it.
CREATE FUNCTION events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('events', NEW.id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER events_notify_insert AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify();
CREATE TRIGGER events_notify_update AFTER UPDATE OF level, resolved_at, escalated_at ON events
  FOR EACH ROW EXECUTE FUNCTION events_notify();

-- --- people ---------------------------------------------------------------------------------

CREATE TABLE users (
  id                   serial PRIMARY KEY,
  email                text NOT NULL UNIQUE CHECK (email = lower(email)),  -- from the Access JWT
  name                 text,
  role                 text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  enabled              boolean NOT NULL DEFAULT true,
  tz                   text NOT NULL DEFAULT 'Europe/London',
  quiet_start          time,                                    -- local time in tz; may cross midnight
  quiet_end            time,
  urgent_ignores_quiet boolean NOT NULL DEFAULT true,
  paused_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz,
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

CREATE TABLE push_subscriptions (
  id              serial PRIMARY KEY,
  user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  label           text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count   int NOT NULL DEFAULT 0
);
CREATE INDEX ON push_subscriptions (user_id);

-- --- alert rules ----------------------------------------------------------------------------

-- One row per user per rule, only once the user changes something (no row = rule defaults).
CREATE TABLE user_alert_prefs (
  user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id         text NOT NULL,
  enabled         boolean NOT NULL,
  min_level       text NOT NULL CHECK (min_level IN ('warning','alert')),
  entities        text[],                   -- NULL = all
  notify_resolved boolean NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rule_id)
);

-- Admin changes on top of config/alerts.yaml (deep-merged).
CREATE TABLE alert_rule_overrides (
  rule_id    text PRIMARY KEY,
  params     jsonb NOT NULL,                -- { enabled?, warning?, alert?, clear?, options? }
  updated_by int REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Threshold engine state, one row per rule and series.
CREATE TABLE alert_state (
  rule_id       text NOT NULL,
  series_id     int NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  warning_since timestamptz,
  alert_since   timestamptz,
  clear_since   timestamptz,
  last_value    double precision,
  last_ts       timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, series_id)
);

CREATE TABLE notification_log (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  event_id        bigint REFERENCES events(id) ON DELETE CASCADE,  -- NULL for test pushes
  user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id int REFERENCES push_subscriptions(id) ON DELETE SET NULL,
  phase           text NOT NULL CHECK (phase IN ('opened','escalated','resolved','test','rate_limit')),
  status          text NOT NULL CHECK (status IN ('sent','failed','gone',
                    'skipped_disabled','skipped_level','skipped_entity','skipped_paused',
                    'skipped_quiet','skipped_rate_limited')),
  error           text
);
CREATE INDEX ON notification_log (ts DESC);
CREATE INDEX ON notification_log (user_id, ts DESC);
