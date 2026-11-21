-- 005 · Devices seen on the home network, for the new-device alert (docs/10 §5).
CREATE TABLE network_devices (
  mac              text PRIMARY KEY CHECK (mac = lower(mac)),   -- 'aa:bb:cc:dd:ee:ff'
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  last_ip          inet,
  hostname         text,                     -- the name the router knows it by, if any
  vendor           text,                     -- from the MAC prefix; NULL when randomised or unknown
  randomised       boolean NOT NULL DEFAULT false,  -- locally administered bit (private Wi-Fi address)
  wired            boolean,                  -- from the router when it says; NULL from ARP alone
  label            text,                     -- set by an admin, e.g. 'Deyan''s Pixel'
  known            boolean NOT NULL DEFAULT false,
  marked_known_by  int REFERENCES users(id) ON DELETE SET NULL,
  marked_known_at  timestamptz
);
