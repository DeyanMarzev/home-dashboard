# 10 · Extra alerts: robot vacuum, weather warnings, new network device

Added 21 Nov 2026 at the owner's request. This extends `docs/09` (alert rules, dispatcher, preferences). Read `docs/09` first. This doc lists only what is new or changed.

Owner decisions (21 Nov 2026, also in `docs/08` → Decided): the vacuum is the Roborock already built as source `roborock`, and only its notifications are new; the home area is Walthamstow (London Borough of Waltham Forest); new-device alerts cover wired and Wi-Fi devices, guests included.

## Summary

| Rule id | Alert | Type | Source | Default (audience · level) | Built in |
|---|---|---|---|---|---|
| `vacuum_not_charging` | Robot vacuum found off its dock and not charging | event | `roborock` (built) | all · warnings | M11 step 3 |
| `vacuum_battery_low` | Robot vacuum battery below 50 % for more than 6 h (backup for the one above) | threshold | `roborock` (built) | all · warnings | M11 step 3 |
| `weather_warning` | Met Office severe weather warning for Waltham Forest | event | `met_office_warnings` (new) | all · warnings | M11 step 3 |
| `network_new_device` | A device never seen before joins the home network (wired or Wi-Fi) | event | `wifi` (M9) | admins · warnings | after M11 step 2 |

Rule ids are stable forever (user preferences are stored against them).

## 1. Changes to the alert engine (on top of `docs/09` §3)

1. **Single-level threshold rules.** `alert` is optional on `threshold` rules. A rule with only `warning` has `levels: ['warning']`, never escalates, and the "Notify me for" control is hidden. Validation becomes: `above`: `clear < warning` (and `warning ≤ alert` when `alert` exists); `below`: `clear > warning` (and `warning ≥ alert` when `alert` exists). An admin override can't add a level the YAML doesn't define.
2. **Event rules can escalate and update.** When `openEvent` is called for a `(source, kind, entity)` that already has an open event (today it does nothing then):
   - higher level → escalate: set `level`, `escalated_at = now()`, `dispatched_at = NULL` (the dispatcher sends an `escalated` push with the same tag);
   - same or lower level → update `message` and `data` only, no push. Never de-escalate the stored level.
3. **Custom titles for event rules.** `openEvent`'s input gains optional `title`, stored in `data.title`. The message builder uses it instead of the rule name for `opened` and `escalated` (no "Urgent:" prefix when a custom title is given; the title already says it).
4. **`resolvedName`** (optional, any rule): the title used for the resolved push, followed by ` · <entity label>` for threshold rules. Default stays as in `docs/09`.
5. **`resolvedNotice: false`** (optional, any rule): never send a resolved push for this rule. `shouldNotify` treats it as `notifyResolved = false`. The "back to normal" switch is hidden in Settings.
6. **`options`** (optional, event rules): rule-specific settings that admins can override like thresholds (stored in `alert_rule_overrides.params.options`, validated by a per-rule zod schema). Shown as switches on the admin Alert thresholds screen.
7. Two new groups.

## 2. Additions to `config/alerts.yaml`

```yaml
groups:
  - { id: air,     name: Rooms & air }
  - { id: heating, name: Heating }
  - { id: weather, name: Weather }              # new
  - { id: home,    name: Energy & water }
  - { id: devices, name: Devices & network }    # new
  - { id: system,  name: System }

rules:
  # ... existing rules from docs/09 ...

  - id: vacuum_not_charging                    # raised by the roborock collector (built)
    group: devices
    name: Vacuum isn't charging
    resolvedName: Vacuum charging again
    type: event
    level: warning
    link: /misc
    defaults: { audience: all, minLevel: warning }

  - id: vacuum_battery_low                     # backup for vacuum_not_charging
    group: devices
    name: Vacuum battery low
    resolvedName: Vacuum battery OK
    type: threshold
    match: { metric: battery, sources: [roborock], entities: [vacuum] }
    direction: below
    warning: { level: 50, for: 6h }             # single level: no alert block
    clear:   { level: 55, for: 10m }
    advice: Check it's on its dock and the dock has power.
    link: /misc
    defaults: { audience: all, minLevel: warning }

  - id: weather_warning
    group: weather
    name: Weather warning
    type: event
    level: warning                              # yellow; the collector passes 'alert' for amber and red
    link: /
    defaults: { audience: all, minLevel: warning }

  - id: network_new_device
    group: devices
    name: New device on the network
    type: event
    level: warning
    resolvedNotice: false
    options: { ignoreRandomised: false }        # owner wants guests' phones too: keep false
    link: /wifi
    defaults: { audience: admins, minLevel: warning }
```

### Messages

| Rule · phase | Title | Body |
|---|---|---|
| vacuum not charging · opened | `Vacuum isn't charging` | `Idle at 14:02, battery 63%. Check it's on its dock` (the event's message, `docs/09` §3 Messages) |
| vacuum not charging · resolved | `Vacuum charging again` | (only to users with "back to normal" on) |
| vacuum battery · opened | `Vacuum battery low · Vacuum` | `42 % for 6 h. Check it's on its dock and the dock has power.` |
| vacuum battery · resolved | `Vacuum battery OK · Vacuum` | `78 %.` |
| weather · opened | `Yellow warning · Wind` | `Tue 25 Nov 06:00 – 21:00. Strong winds may disrupt travel.` |
| weather · escalated | `Amber warning · Wind` | same format, new text |
| weather · resolved | `Warning ended · Wind` | `The amber wind warning has ended.` |
| new device · opened | `New device on the network` | `Samsung device · 192.168.1.47. Open Wi-Fi to name it or mark it as yours.` (`Unknown device` when there's no vendor; add `· wired` when known to be wired) |

Times in Europe/London, `en-GB` formatting, as in `docs/09`.

## 3. Robot vacuum (`roborock`, built)

**Already built** (`docs/03` § roborock): a Roborock S8 read through the `roborock` helper container (python-roborock, read-only), polled **every hour** (the owner finds that enough). What exists:

- Series on entity `vacuum`: `battery` (%, gauge) and `state` (the robot's own `get_status.state` code, value type `state`), both stamped with the poll time. `vacuumState()` in `packages/shared/src/vacuum.ts` names the code and says where the robot is: `docked`, `busy`, `stranded` or `unknown`.
- The `vacuum_not_charging` warning event: opened when a poll finds the robot `stranded` (off the charger, idle, paused, error, charging problem), resolved by the next poll that finds it docked or busy. It already shows on the Overview's alerts strip.
- The `roborock_auth` alert event when the Roborock sign-in is refused (rule in `docs/09` §3).
- UI: battery %, a bar, the state and "Checked N min ago" at the top of the Misc page's Vacuum panel. **No Overview tile** (owner, 21 Nov 2026).

**Left to do (M11 step 3):** the two rules in §2. Nothing in the collector changes.

### Notes

- `vacuum_not_charging` is the main alert: it comes within about an hour of the robot being left off its dock. `vacuum_battery_low` is a backup (e.g. the robot sends a state code `vacuumState()` doesn't know, which never warns); both can be open at once, with different tags.
- With hourly polls, "under 50 % for 6 h" is about six low readings in a row; the 1-minute engine tick lets `for` elapse between readings.
- If the battery goes completely flat, the vacuum stops answering, the source turns Late, and the threshold state freezes (`docs/09` stale-data rule). Only `source_late` (admins) covers that case. Say so in the rule's Settings description: "If the vacuum goes offline you'll get 'Data source stopped' instead (admins)."

## 4. Met Office weather warnings (`met_office_warnings`)

**Owner decision:** the home is in Walthamstow, London Borough of Waltham Forest. Met Office region: London & South East England. Only warnings that cover Waltham Forest should alert.

### Registry entry

```yaml
  met_office_warnings:
    name: Met Office warnings
    kind: api
    poll: 15m
    expected_delay: 0s
    enabled: true
```

### Feed

- The Met Office publishes free RSS feeds of UK severe weather warnings, one per region. The URL used by Home Assistant setups is `https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/<code>`, with `se` for London & South East England. **Check the current URL and region code on https://weather.metoffice.gov.uk/guides/rss before building**, and record a real payload as a fixture.
- No API key. Send a `User-Agent` with a contact (reuse `VAPID_SUBJECT`'s address). Use conditional GET (`ETag` / `If-Modified-Since`).
- Use is subject to the Met Office website terms: wherever a warning's text is shown in the app, show its link to the Met Office page.
- Treat the format as fragile: parse strictly, and if the structure changes, fail the run (logged in `collector_runs`, the source turns Late, `source_late` tells admins). Never guess.

### Env

```
MET_OFFICE_REGION=se                 # London & South East England (confirm the code on the Met Office RSS page)
MET_OFFICE_AREAS=Waltham Forest      # only warnings that name these areas alert; empty = any warning in the region
MET_OFFICE_FEED_URL=                 # dev/test only: override the feed URL (e.g. a local fixture)
```

### Area matching

- A London-wide warning may not list individual boroughs. Count a warning as covering the home if its text names `Waltham Forest`, **or** names `London` / `Greater London` as a whole, or covers the whole region.
- If the RSS items don't include affected-area names at all, follow each item's link to the Met Office warning page (once per warning, cached) and read the local authorities listed there. If that isn't possible either, alert for every warning in the region and tell the owner that the filter couldn't be applied. Don't silently drop warnings.
- Test this against real fixtures, including one that names Waltham Forest, one London-wide, and one for elsewhere in the region (e.g. Kent only), which must not alert.

### Collector logic (every 15 min)

1. Fetch and parse each item: id (guid, else link), colour (yellow / amber / red), weather type (rain, thunderstorms, wind, snow, lightning, ice, extreme heat, fog), valid from / to, link, short description, affected-areas text.
2. Keep items whose valid-to is in the future and that cover the home (Area matching above).
3. For each kept item: `openEvent(sql, { sourceId: 'met_office_warnings', kind: 'weather_warning', entity: <slug of the item id, ≤ 64 chars>, level: yellow → 'warning', amber/red → 'alert', title: 'Amber warning · Wind', message: '<validity>. <first sentence of the description>', data: { colour, type, validFrom, validTo, url } })`. A warning changing colour escalates (or updates) through §1.2.
4. Resolve (`resolveEvent(sql, 'met_office_warnings', 'weather_warning', entity)`) every open warning that's no longer in the kept set.
5. Write readings so freshness works (a source with only events would always look Late): `active_warnings` (count, gauge) and `warning_level` (state: 0 none, 1 yellow, 2 amber, 3 red), entity `home_area`, `ts` = run time.

### Behaviour

- Amber and red are `alert` level ("Urgent"), so by default they come through quiet hours. Yellow respects quiet hours.
- Overview alerts strip: weather events show a colour chip **with the colour written as text**, the validity, and a "Details on Met Office" link (`data.url`).

## 5. New device on the network (`network_new_device`)

Part of the `wifi` source (`netprobe` container, M9), but built **after M11 step 2**: it needs `users` (who marked a device as known) and admin roles. `arp-scan --localnet` already runs every 5 minutes; today it only counts devices.

**Owner decision:** alert for **any** new device that connects, wired or Wi-Fi, **guests included**. The owner wants to know whenever a new device connects. No wired devices are connected at the moment.

### Detection

- From the existing `arp-scan --localnet` in the `wifi` collector, run every 5 min. This sees wired and Wi-Fi devices on the Pi's subnet, which is what the owner wants, so no router API is needed for this alert. If a router API turns up later (`docs/08` #6), it may add hostnames or a wired/Wi-Fi flag, but it must not narrow the alert.
- Keep `ignoreRandomised: false` so guests' phones (which use private, randomised addresses) do alert.
- A device that connects briefly between scans can be missed. That's accepted in v1.

### Table (migration `005_network_devices.sql`, after `004_users_notifications.sql`)

```sql
CREATE TABLE network_devices (
  mac              text PRIMARY KEY CHECK (mac = lower(mac)),   -- 'aa:bb:cc:dd:ee:ff'
  first_seen       timestamptz NOT NULL DEFAULT now(),
  last_seen        timestamptz NOT NULL DEFAULT now(),
  last_ip          inet,
  hostname         text,
  vendor           text,                     -- from the MAC prefix (OUI); NULL when randomised or unknown
  randomised       boolean NOT NULL DEFAULT false,  -- locally administered bit set (2nd bit of 1st octet)
  label            text,                     -- set by an admin, e.g. 'Deyan''s Pixel'
  known            boolean NOT NULL DEFAULT false,
  marked_known_by  int REFERENCES users(id) ON DELETE SET NULL,
  marked_known_at  timestamptz
);
```

### Logic (each scan)

1. Upsert every MAC seen: `last_seen`, `last_ip`, hostname if available.
2. **Baseline:** on the very first scan (table empty), insert everything with `known = true` and raise nothing. Tell the owner in the M9 note to check the Wi-Fi page's device list after the first scan, and to "Forget" anything they don't recognise.
3. A MAC not in the table → insert with `known = false`, then, unless (`randomised` and `options.ignoreRandomised`), `openEvent(sql, { sourceId: 'wifi', kind: 'network_new_device', entity: mac, level: 'warning', message, data: { ip, vendor, hostname, randomised } })`.
4. A MAC is only ever alerted once. Forgetting a device (DELETE below) lets it alert again.
5. The open event resolves when an admin marks the device as known, or automatically after 24 h. `resolvedNotice: false`, so resolving never pushes.
6. Vendor lookup: a small bundled OUI table (prefix → vendor name), loaded once. Keep it light (the Pi's memory limits apply). No network lookups.

### Privacy and noise

- Phones use a private (randomised) Wi-Fi address per network. It's usually stable for that network, so a phone alerts once. Some phones can be set to change it periodically, which causes repeat alerts for the same phone. The owner chose to include these; if it gets noisy, admins can switch on `ignoreRandomised`, and the `docs/09` rate limit applies anyway.
- Device lists, hostnames and MACs are **admin-only** (household privacy). Members keep seeing the device count only.
- Never log full MAC lists at info level.

### API (admin)

- `GET /api/network/devices?known=true|false` → `[{ mac, label, vendor, hostname, lastIp, randomised, known, firstSeen, lastSeen, markedKnownBy }]`.
- `PATCH /api/network/devices/:mac` → body `{ label?, known? }`. Setting `known: true` records who and when, and resolves the open event.
- `DELETE /api/network/devices/:mac` → forget it (it alerts again next time it appears).
- Members get 403 `FORBIDDEN` on all three.

### Wi-Fi page (admins)

- A "Devices" card: new (unknown) devices first, each with a "New" badge (text, not colour alone), vendor, IP, first and last seen, and buttons **This is ours**, **Rename** and **Forget**.
- The push deep-links to `/wifi#<mac>`.

## 6. Tests

Unit (`packages/shared` and collector parsers):

- Single-level threshold rule: doesn't open before 6 h, opens at 6 h, never escalates, resolves above 55 % after 10 min, and validation accepts a rule with no `alert` block.
- `openEvent` on an open event: higher level escalates once, same or lower only updates, never a second open row.
- `resolvedNotice: false` → no resolved push, and `GET /api/me/alerts` reports it so the switch is hidden.
- Vacuum: already covered (`apps/collector/src/sources/roborock/parse.test.ts`, `packages/shared/src/vacuum.test.ts`). Add: the `vacuum_not_charging` event gets `rule_id` and its push title/body split at ` · `.
- Met Office parser with recorded fixtures: no warnings, one yellow, yellow + amber, Waltham Forest named (alerts), London-wide (alerts), elsewhere in the region only (doesn't alert), expired item ignored, malformed feed fails the run.
- Network: baseline raises nothing, a new MAC raises one event, the next scan doesn't duplicate, marking known resolves it, randomised detection, a randomised (guest) MAC alerts with the default options.

Integration (`FakeChannel`):

- Vacuum: seeded `battery` readings on `roborock`/`vacuum` at 40 % for 6 h → one push to users with the rule on; 40 % for 5 h 59 min → none. A `vacuum_not_charging` event → one push to everyone by default; resolving it → "Vacuum charging again" only to users with "back to normal" on.
- Weather: yellow Waltham Forest fixture → `opened`; amber fixture for the same id → `escalated` with the same tag; empty fixture → `resolved` only to users with "back to normal" on. With 0 warnings the source stays Live.
- New device: admins get the push, members don't by default. A member gets 403 on `/api/network/devices`.

## 7. Done when

1. Lifting the robot off its dock and restarting the collector (`docker compose restart collector`) gets the owner's phone "Vacuum isn't charging" within a minute. Tapping it opens the Misc page. Putting it back and restarting again resolves it. With the rule's `for` temporarily set to 5 min by an admin, a low battery reading gets "Vacuum battery low · Vacuum".
2. With `MET_OFFICE_FEED_URL` pointing at a yellow Waltham Forest fixture, a push arrives; a fixture for elsewhere in the region sends nothing. Switching to an amber fixture replaces it with "Amber warning" (and it comes through quiet hours). An empty fixture sends "Warning ended" to users who want back-to-normal notices.
3. Connecting a new phone or laptop (including a guest phone with a private address) to the Wi-Fi gets admins a "New device on the network" push within 10 min. Plugging a new device into the router by cable does the same. "This is ours" resolves it, and reconnecting doesn't alert again. Members get nothing by default and can't see the device list.
4. `pnpm lint typecheck test build` pass, and `docker stats` shows every container within its memory limit.
