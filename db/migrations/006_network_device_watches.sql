-- 006 · "Tell me when it connects / leaves" for devices on the network (docs/10 §5).

-- Whether the device is on the network now: false once it hasn't been seen for the away time
-- (rule option `awayMinutes`, default 60); true again when it's seen. Starts true.
ALTER TABLE network_devices ADD COLUMN present boolean NOT NULL DEFAULT true;

-- Per person and device: which reminders they want.
CREATE TABLE network_device_watches (
  user_id    int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mac        text NOT NULL REFERENCES network_devices(mac) ON DELETE CASCADE,
  on_connect boolean NOT NULL DEFAULT false,
  on_leave   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, mac)
);
CREATE INDEX ON network_device_watches (mac);
