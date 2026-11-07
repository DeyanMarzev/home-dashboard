# 03 · Sources and freshness

## The source registry: `config/sources.yaml`

This file is the source of truth. On startup, `collector` and `api` read it, validate it with zod, and upsert it into the `sources` table. Disabling a source = `enabled: false`.

```yaml
sources:
  room_sensors:
    name: Room sensors
    kind: sensor            # pushed over MQTT
    expected_delay: 0s
    push_interval: 30s      # how often sensors normally report (used for the Live window)
    mqtt_topic: home/sensors/+/+     # home/sensors/<entity>/<metric>

  pi_stats:
    name: Raspberry Pi
    kind: local
    poll: 1m
    expected_delay: 0s

  boiler_probes:
    name: Boiler pipe probes
    kind: local
    poll: 30s
    expected_delay: 0s

  nest:
    name: Nest thermostat
    kind: api
    poll: 2m
    expected_delay: 0s

  open_meteo:
    name: Open-Meteo weather
    kind: api
    poll: 15m
    expected_delay: 0s

  carbon_intensity:
    name: Grid carbon intensity
    kind: api
    poll: 30m
    expected_delay: 0s

  smart_meters:
    name: Smart meters
    kind: api
    poll: 6h
    expected_delay: 1d       # readings arrive the next day
    grace: 12h

  thames_water:
    name: Thames Water
    kind: scrape
    poll: "cron: 0 6 * * *"  # daily 06:00 Europe/London
    expected_delay: 3d
    grace: 1d
```

Durations use the format `30s`, `15m`, `6h`, `1d` (`1d` = exactly 24 h). `poll` may also be a cron string (Europe/London).

Validation (`packages/shared/src/registry.ts`, every problem reported at once; api and collector refuse to start on an invalid registry):

- Keys allowed per source: `name`, `description` (shown in the data sources table), `kind`, `poll`, `push_interval`, `expected_delay` (default `0s`), `grace`, `enabled` (default `true`), `mqtt_topic`, `options`. Unknown keys are errors, so typos are caught.
- `options`: free-form, non-secret settings for the source's collector (secrets go in `.env`).
- `kind: sensor` (push) needs `push_interval` and no `poll`; every other kind needs `poll`.
- A live-capable source (`expected_delay` ≤ 15m) can't use a cron `poll`: its Live window comes from the poll interval.
- Removing a source from the file disables it in the database; its history stays.
- Sources whose collector isn't built yet are listed with `enabled: false`.

## Freshness: one rule for every source

Implemented once in `packages/shared/src/freshness.ts`, used by the API (in responses) and the web app (to re-tick badges every minute without refetching). Fully unit-tested, including clock-change days.

### Inputs

- `expected_delay`, `poll` / `push_interval`, optional `grace` from the registry.
- `data_to`: the newest point the data covers. For `gauge`/`state` series = latest `ts`. For `interval_total` = latest `ts + interval`.
- `now`.

### Rules

```
LIVE_THRESHOLD = 15 minutes

lag = now - data_to

if expected_delay <= LIVE_THRESHOLD:                 # a live-capable source
    window = max(3 × (poll or push_interval), 5 minutes)
    state  = lag <= window ? 'live' : 'late'
else:                                                 # a delayed source
    grace  = source.grace ?? 12 hours
    state  = lag <= expected_delay + grace ? 'delayed' : 'late'
```

### Output (`Freshness` type)

```ts
type FreshnessState = 'live' | 'delayed' | 'late';

interface Freshness {
  state: FreshnessState;
  dataTo: string | null;     // ISO timestamp, UTC; null = never reported
  lagSeconds: number | null;
  daysBehind: number | null; // whole calendar days between the last day covered and today, in Europe/London
  label: string;             // ready to render, see below
  compactLabel: string;      // for tiles
}
```

### Labels

| State | Label | Example |
|---|---|---|
| live | `Live` | Live |
| delayed | `Data to {d MMM} · {n} day(s) behind` | Data to 5 Nov · 1 day behind |
| delayed (compact, for tiles) | `{n} day(s) behind` | 3 days behind |
| delayed, already covers today | `Data to {d MMM} · up to date` (compact: `Up to date`) | Data to 6 Nov · up to date |
| late | `No data since {HH:mm}` if today, else `No data since {d MMM}` (same compact) | No data since 13:10 |
| never reported | `No data yet` (state `late`) | No data yet |

"The last day covered" is the London date of `dataTo` for gauges, and of `dataTo` minus 1 ms for `interval_total` series, so half-hourly data ending at 00:00 on 6 Nov reads "Data to 5 Nov". Month names are fixed English abbreviations (`Sep`, not ICU's `Sept`). `retick(freshness, policy, now)` recomputes a freshness for a later moment (the web app's badges use it every 30 s). The implementation (`freshness(policy, latest, now)`, `retick`, `combineFreshness`, `freshnessPolicy(source)`) is in `packages/shared/src/freshness.ts` and `registry.ts`.

### Combining

A panel or tile built from several series shows the **worst** state: `late` > `delayed` > `live`. For two delayed series with different `dataTo`, show the oldest. Expose `combineFreshness(list)` from the shared package.

### Which series count

A source's freshness is that of its newest series (the one whose data reaches furthest). **Metrics named `forecast_*` never count**: they are predictions with future timestamps and would make a dead source look Live (`packages/db/src/latest.ts`). Collectors must name forecasts that way.

### Late → events

The `collector` checks freshness every 5 minutes (first check 5 minutes after startup; `apps/collector/src/late-check.ts`). When a source goes `late`, it inserts an `events` row (`kind: 'source_late'`, level `warning`, message e.g. "Room sensors: no data since 13:10", `data` = the freshness object), and resolves it when the source recovers. No duplicate open events per source (unique index). A source that never reported counts as late ("no data yet"). Disabled sources never stay late. Inserting or resolving an event sends `NOTIFY events, '<id>'`.

## The collector process

`apps/collector` runs every enabled source that has a module in `src/sources/index.ts`:

- **Pull sources** (`PullLoop`): interval sources run immediately at startup (2 s apart), then at a fixed rate; cron sources at the next match in Europe/London. Each run gets a time limit (its poll interval, 30 s–5 min; 10 min for cron) and an `AbortSignal`, and is logged to `collector_runs` (start, finish, ok, rows, error ≤ 500 chars).
- **Retries**: after a failure the next attempt waits min(poll, 5 min), doubling each consecutive failure, capped at poll × 4 (1 day for cron). Source-specific limits (e.g. Thames Water's 3 logins a day) belong in the source's module.
- **Push sources** (MQTT): one summary row per minute in `collector_runs` (rows written, last error), not one per 1 s write.
- Errors anywhere are caught and logged; one source failing never affects another. `collector_runs` older than 30 days are pruned every 6 h.
- An enabled source without a module, or a module not in the registry, is logged as a warning at startup.

## Adding a new source (checklist)

1. Add an entry to `config/sources.yaml`.
2. Create `apps/collector/src/sources/<id>/` with:
   - `index.ts` exporting a `Collector` (`id`, `run(ctx)` for pull sources or `subscribe(ctx)` for push sources).
   - `parse.ts`: pure function, raw payload → `ReadingInput[]` (`{ metric, entity, unit, valueType, interval?, ts, value }`).
   - `__fixtures__/` with at least one recorded real payload (secrets removed) and `parse.test.ts`.
3. Add any env vars to `.env.example` with comments.
4. Done: series are created on first write; freshness, API and UI pick it up automatically.

```ts
interface CollectorContext {
  source: SourceConfig;
  writeReadings(r: ReadingInput[]): Promise<number>;  // batches, upserts, creates series, NOTIFYs
  log: Logger;
  env: Env;
  lastDataTo(metric: string, entity?: string): Promise<Date | null>; // resume from where we left off
}
```

## Planned sources

### room_sensors (push, MQTT): live

- Topic `home/sensors/<entity>/<metric>`, payload JSON `{ "value": 20.6, "ts": "2026-11-06T13:41:00Z", "rssi": -48 }`. `ts` optional (default: receive time). `rssi` becomes a `wifi_rssi` series for that entity (feeds the Wi-Fi "signal by room" panel).
- Also accepted: a bare number payload (`20.6`), common in ESP32 firmware.
- Units are fixed per metric: `temperature` °C, `humidity` %, `co2` ppm, `pressure` hPa. Unknown metrics are rejected.
- Rejected and logged (grouped per reason at each flush), never stored: bad topics, non-snake_case entities, non-JSON, `ts` without a zone, `ts` more than 5 min in the future or 7 days in the past (a sensor that never got NTP time), `rssi` outside −120…0.
- Clients connect with MQTT 3.1.1, the most widely supported version; Mosquitto accepts 3.1.1 and 5. Sensors use `MQTT_SENSOR_USERNAME` (publish-only on `home/sensors/#`).
- Writes are batched every 1 s. If the database is down, up to 20,000 readings are kept and retried; beyond that the oldest are dropped and the drop is reported in `collector_runs`.
- **Fake sensor** (`apps/collector/src/tools/fake-sensor.ts`, built into the collector image rather than `scripts/` so it can run on the Pi): publishes realistic values for `living_room`, `kitchen`, `bedroom` every 30 s through the same topic contract. Local: `pnpm fake-sensor`. Pi: `docker compose --profile fake up -d fake-sensor`.
- Entities from the mockup: `living_room`, `kitchen`, `bedroom`. Metrics: `temperature`, `humidity`, `co2`, `pressure`.
- **Open question:** what hardware the existing sensors are and how they report today. See `docs/08`. Build the MQTT path; if the existing sensors can't publish MQTT, a bridge collector is added later.

### pi_stats (local): live

- CPU temperature (`/host/sys/class/thermal/thermal_zone0/temp`, millidegrees).
- Throttle flags (`get_throttled` bitmask): store as `state` series `throttle_flags`; the API decodes bits: 0 under-voltage now, 1 frequency capped now, 2 throttled now, 3 soft temp limit now, 16–19 the same "has occurred since boot".
- Memory (`/host/proc/meminfo`), load (`/host/proc/loadavg`), uptime, disk usage for `/` and `/mnt/ssd` (`statfs`), database size (`pg_database_size`).
- Series (entity `pi` unless noted): `cpu_temperature` °C · `throttle_flags` (state, `flags`) · `memory_total`, `memory_used` MB (used = total − available) · `load_1m`, `load_5m`, `load_15m` · `uptime` s · `disk_used`, `disk_free` GB for entities `sd_card` and `ssd` (free = available to non-root, as `df` shows) · `database_size` MB.
- The thermal and throttle files only exist on a Pi; if missing, those two metrics are skipped with one warning. The fixture in `__fixtures__/` is representative; replace it with a capture from the Pi.

### boiler_probes (local): live

- Two DS18B20 on 1-Wire: `/sys/bus/w1/devices/28-*/temperature` (millidegrees). Map sensor IDs to `boiler_flow` / `boiler_return` via env (`BOILER_FLOW_W1_ID`, `BOILER_RETURN_W1_ID`).
- Hardware not installed yet: the collector must handle "no devices" quietly (log once, no crash).
- Implemented (`apps/collector/src/sources/boiler_probes/`): reads `temperature` (or `w1_slave` on older kernels, CRC checked) under `/host/sys/bus/w1/devices`. Rejects the 85 °C power-on value and −127 °C (disconnected). A configured probe that's missing fails the run (the other probe's reading is still stored). Series: `temperature` on entities `boiler_flow` and `boiler_return`.

### nest (Google Smart Device Management API): live

- OAuth2 refresh token flow. Env: `NEST_PROJECT_ID`, `NEST_CLIENT_ID`, `NEST_CLIENT_SECRET`, `NEST_REFRESH_TOKEN`. Device is a Nest Learning Thermostat 3rd gen.
- `GET https://smartdevicemanagement.googleapis.com/v1/enterprises/{project}/devices`.
- Traits → series (entity `hallway` unless noted):
  - `sdm.devices.traits.Temperature.ambientTemperatureCelsius` → `temperature`
  - `sdm.devices.traits.Humidity.ambientHumidityPercent` → `humidity`
  - `sdm.devices.traits.ThermostatTemperatureSetpoint.heatCelsius` → `target_temperature`
  - `sdm.devices.traits.ThermostatHvac.status` → `hvac_heating` (state on entity `boiler`: 1 when `HEATING`, else 0)
  - `sdm.devices.traits.ThermostatMode.mode`, `ThermostatEco.mode` → states
- Poll every 2 min; on HTTP 429 back off. Refresh access token before expiry; log refresh failures as events.
- Boiler running time, cycles and "warm-up rate" are derived from `hvac_heating` + temperatures at query time.
- Implemented (`apps/collector/src/sources/nest/`): token from `https://oauth2.googleapis.com/token`, cached until 2 min before expiry; a refused refresh token opens one `nest_auth` alert event (resolved on the next success). An offline thermostat fails the run instead of storing stale values as current. SDM has no timestamps: readings are stamped with the poll time. Entity = the room's display name in snake_case (override with `options.entity`). Extra states: `thermostat_mode` (0 off, 1 heat, 2 cool, 3 heat-cool), `eco_mode` (0 off, 1 manual eco). No `target_temperature` while eco is on or the mode is off.
- SDM doesn't expose the schedule, so the Heating page shows the target temperatures observed so far today, not the plan.

### open_meteo: live

- `https://api.open-meteo.com/v1/forecast` with `latitude`, `longitude` from env (`HOME_LAT`, `HOME_LON`), `current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m`, `hourly=temperature_2m` for the next 24 h.
- No API key. Entity `outdoor`.
- Store forecast separately (metric `forecast_temperature`) so it's never confused with measurements.
- Requested with `timeformat=unixtime` (no time zone ambiguity) and `wind_speed_unit=kmh`. Series: `temperature` °C, `humidity` %, `precipitation` mm, `weather_code` (state, `wmo`), `wind_speed` km/h, `forecast_temperature` °C (24 hourly points). The parser fails if Open-Meteo answers in other units.

### carbon_intensity (NESO Carbon Intensity API): live

- Regional current value and 48 h forecast by postcode outcode (env `HOME_POSTCODE_OUTCODE`).
- `https://api.carbonintensity.org.uk/regional/postcode/{outcode}` (current) and `/regional/intensity/{from}/fw48h/postcode/{outcode}` (forecast). Verified 2026-11-07: current returns `data` as a list of one region, forecast returns the region object; timestamps like `2026-11-07T11:30Z`.
- Series: `intensity` gCO₂/kWh (entity `grid`, ts = start of the current half-hour), `intensity_index` (state 0 very low … 4 very high), `generation_share` % per fuel (entity = fuel: `gas`, `wind`, `solar`, …), `forecast_intensity` gCO₂/kWh for the next 48 h. Regional values are forecasts by nature; NESO publishes no regional actuals.
- Also store generation mix if cheap. Used for "greenest window" and for per-half-hour emissions of the household's electricity.

### smart_meters: 1 day behind

- Electricity and gas, half-hourly `interval_total` kWh. Data for day D arrives on day D+1.
- **Open question:** which provider/API the owner will use (supplier API such as Octopus, or a DCC-based service such as Hildebrand Glowmarkt/Bright, or n3rgy). Implement behind an interface `MeterProvider { fetch(from, to): ReadingInput[] }` with a `fake` provider generating plausible data until confirmed.
- Each run fetches from `lastDataTo - 2 days` to now (overlap is safe because writes are upserts).
- Gas from some providers comes in m³: convert with `kWh = m³ × 1.02264 × CV / 3.6` (CV default 39.5, configurable).

### thames_water (scrape): 3 days behind

- No official API. Log into the customer account and fetch hourly usage (unofficial endpoint used by the account web pages). Env: `THAMES_EMAIL`, `THAMES_PASSWORD`, `THAMES_ACCOUNT_NUMBER`, `THAMES_METER_ID`.
- Daily at 06:00 Europe/London; fetch the last 7 days each run (upsert).
- Treat as fragile: strict parsing, clear error messages, never retry more than 3× per day (avoid account lockout).
- Derived: night-time leak check = minimum hourly volume between 00:00 and 05:00 for each night; alert if > 0 for 3 nights in a row.

### Later sources (separate milestones)

- `wifi` (netprobe container): Pi's own link (`iw dev wlan0 link`), channel scan (`iw dev wlan0 scan`), device count (`arp-scan --localnet`), ping latency/loss to router and 1.1.1.1. Router API if the owner's router supports one (open question).
- `speed_test`: daily at 12:00 (Ookla CLI arm64 or equivalent).
- `smart_plugs`: per-appliance power/energy (brand is an open question; Shelly and Tapo have local APIs).
