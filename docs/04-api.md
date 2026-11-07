# 04 · API

Fastify 5, TypeScript, zod-validated inputs and outputs (schemas live in `packages/shared` so the web and Android apps get the same types). Base path `/api`. JSON only. The same server serves the built web app at `/` with SPA fallback.

## Auth

- Cloudflare Access sits in front of `home.deyan.uk`. Every request that reaches the API carries `Cf-Access-Jwt-Assertion`.
- Middleware verifies that JWT (RS256) against `https://${CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs` with audience `CF_ACCESS_AUD`. Cache the keys. Reject with 401 if missing or invalid.
- The Android app uses an Access **service token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers); Access then forwards a valid JWT, so the API needs no special case.
- `AUTH_DISABLED=true` for local development only. The API must refuse to start with `AUTH_DISABLED=true` when `NODE_ENV=production`.
- `/api/health` is unauthenticated (used by the Docker healthcheck), returns no data.
- Only RS256 is accepted; issuer must be `https://${CF_ACCESS_TEAM}.cloudflareaccess.com`; 30 s clock tolerance. `CF_ACCESS_TEAM` may be given as `team`, `team.cloudflareaccess.com` or the full URL.
- The check runs on every route, including static files and unknown paths (unauthenticated callers can't tell which paths exist). Rejections are logged with the reason code only, never the token.
- If Access's signing keys can't be fetched (network down), respond **503** `SERVICE_UNAVAILABLE`, not 401, so an outage isn't mistaken for a bad login.
- After verification the handler sees `request.identity`: `{ sub, email }` for a person, `{ sub, commonName }` for a service token.
- Implementation: `apps/api/src/auth.ts`; config validation in `apps/api/src/config.ts` (the API refuses to start and lists every problem if the environment is wrong; it also refuses port 8000).

## Common shapes

```ts
interface SeriesMeta {
  id: number;
  sourceId: string;
  metric: string;
  entity: string;
  unit: string;
  valueType: 'gauge' | 'interval_total' | 'state';
  interval?: string;          // ISO 8601 duration, e.g. 'PT30M'
  label?: string;
}

interface Freshness {         // see docs/03; type exported by packages/shared
  state: 'live' | 'delayed' | 'late';
  dataTo: string | null;      // null = never reported
  intervalSeconds: number | null; // interval_total series only; lets clients re-tick exactly
  lagSeconds: number | null;
  daysBehind: number | null;
  label: string;
  compactLabel: string;
}
```

Every response that contains data includes a `freshness` object for each series, and a combined `freshness` for the response when it contains several series.

## Endpoints

Schemas for every request and response are in `packages/shared/src/api.ts` (`*QuerySchema` validated at runtime; `*ResponseSchema` checked in the API's tests). Handlers: `apps/api/src/routes/data.ts`, `apps/api/src/stream.ts`. Query parameters that aren't listed are rejected (400), so typos don't silently return everything.

### `GET /api/health`
`{ ok: true, db: 'up' | 'down', version: string }`. Always 200 once the API is listening (it only starts listening after migrations and the registry sync). `db` is a `select 1` with a 2 s timeout.

### `GET /api/sources`
All sources in registry order (disabled ones too, with `enabled: false`), with freshness of their newest series (`forecast_*` excluded), the last collector run, and failed runs in the last 24 h. Cached 30 s.
```json
[{ "id": "smart_meters", "name": "Smart meters", "description": "Electricity and gas, half-hourly",
   "kind": "api", "poll": "6h", "pushInterval": null, "expectedDelay": "1d", "enabled": true,
   "policy": { "expectedDelaySeconds": 86400, "cadenceSeconds": 21600, "graceSeconds": 43200 },
   "freshness": { "state": "delayed", "dataTo": "2026-11-06T00:00:00Z", "lagSeconds": 50400,
                  "daysBehind": 1, "label": "Data to 5 Nov · 1 day behind", "compactLabel": "1 day behind" },
   "lastRun": { "startedAt": "...", "finishedAt": "...", "ok": true, "rowsWritten": 96, "durationMs": 1900, "error": null },
   "errors24h": 0 }]
```

`policy` is what freshness is computed from, so clients can re-tick badges with `retick()` from `packages/shared` without refetching.

### `GET /api/series?source=&metric=&entity=`
List of `SeriesMeta`, filterable (all filters combine), ordered by source, metric, entity.

### `GET /api/latest?series=1,2,3` or `?source=room_sensors` or `?metric=co2`
Latest value per series (filters combine, `entity=` also allowed; at least one of `series`, `source`, `metric`). A series with no readings has `ts`/`value` null and freshness "No data yet". The combined freshness is the worst of the items.
```json
{ "items": [{ "series": { ...SeriesMeta }, "ts": "...", "value": 780, "freshness": { ... } }],
  "freshness": { ...combined } }
```

### `GET /api/readings`
Query: `series` (comma ids, required), `from`, `to` (ISO, default last 24 h), `bucket` (`raw` | `5m` | `15m` | `1h` | `1d`, default chosen by range), `agg` (`auto` | `avg` | `sum` | `min` | `max`; `auto` = avg for gauge, sum for interval_total), `tz` (default `Europe/London`, used for `1d` buckets).
```json
{ "from": "...", "to": "...", "bucket": "1h",
  "series": [{ "meta": { ... }, "points": [["2026-11-05T00:00:00Z", 0.17], ...], "freshness": { ... } }],
  "freshness": { ...combined } }
```
Max 600 points per series; the server picks a coarser bucket if needed and says so in `bucket`.

- **Default bucket:** raw up to 2 h, otherwise the finest of `5m`, `15m`, `1h`, `1d` that fits 600 points (24 h → `5m`, 7 d → `1h`, 30 d → `1d`). A requested bucket is only ever made coarser, never finer. `raw` is limited to 48 h and is coarsened if any series has more than 600 readings in the range.
- **Where from:** `raw`, `5m`, `15m` from `readings` (`date_bin`); `1h`, `1d` from `readings_hourly` (real-time, see migration 003), averages weighted by sample count. `1d` buckets are calendar days in `tz` (23 h and 25 h days at the clock changes).
- **Points** are `[start of bucket (UTC), value]`, in time order; `series` comes back in the order asked. Unknown series ids → 404. Ranges are `[from, to)`, at most 600 days.
- `agg=auto`: `sum` for `interval_total`, `avg` otherwise (for 0/1 states that's the share of time on, when sampled evenly; exact time-weighting comes with the heating summary).

### `GET /api/summary/energy?from=&to=`
Daily electricity and gas kWh and cost (using `tariffs`), baseload (lowest 30 min average overnight → W), totals. Freshness combined from `smart_meters`.

`from`/`to` are London dates, inclusive (default: the 14 days ending the last day the meters cover; at most 400 days). Response (`EnergySummarySchema`):

```json
{ "from": "2026-10-23", "to": "2026-11-05", "latestDay": "2026-11-05",
  "days": [{ "date": "2026-11-05",
             "electricity": { "kwh": 9.7, "energyPence": 238, "standingPence": 61 },
             "gas": { "kwh": 32, "energyPence": 202, "standingPence": 32 },
             "complete": true, "outdoorC": 9.1, "degreeDays": 6.4 }],
  "month": { "from": "2026-11-01", "to": "2026-11-05", "costPence": 2332, "projectedPence": 13992 },
  "baseload": { "watts": 168, "night": "2026-11-05", "yearlyPence": 36056, "previousWatts": 142 },
  "carbon": { "electricityKg": 10.9, "gasKg": 41.5 },
  "freshness": { "...": "smart_meters" } }
```

- Days are summed from `readings_hourly` on London calendar days (46/48/50 half-hours). `complete` = every half-hour present for each fuel that has a series. `latestDay` = the newest complete day.
- Costs use the tariff valid on each date (`validTo` inclusive); `energyPence`/`standingPence` are null without one. Fixed rates only: time-of-use bands wait for question 4.
- `month` includes standing charges; the projection is straight-line over the days counted.
- `baseload` = the lowest half-hour between 00:00 and 05:00 on `latestDay` as a constant draw; `previousWatts` is the same 28 days earlier.
- Carbon: electricity = Σ kWh × the `carbon_intensity` recorded for the same half-hour (null if under 90 % of half-hours have one); gas = kWh × 0.183 kg/kWh (UK government factor). Cached 30 s. Logic: `apps/api/src/routes/energy.ts`, `packages/shared/src/energy.ts`.

### `GET /api/summary/heating?date=`
Boiler minutes on, cycles, condensing share (minutes with `boiler_return` < 55 °C while heating ÷ minutes heating), warm-up rate, schedule-derived next change if available.

`date` is a London calendar date (default today). Response (`HeatingSummarySchema` in `packages/shared`):

```json
{ "date": "2026-11-06",
  "boiler": { "heatingNow": false, "minutesOn": 125, "cycles": 3, "shortCycles": 1,
              "runs": [{ "from": "2026-11-06T06:00:00Z", "to": "2026-11-06T07:30:00Z" }] },
  "condensingShare": 0.71, "flowPeakC": 66,
  "warmUp": { "ratePerHour": 1.4, "longest": { "from": "...", "to": "...", "startC": 16, "endC": 20.5 } },
  "days": [{ "date": "2026-10-31", "minutesOn": 118, "cycles": 3 }, "... 7 days, oldest first"],
  "setpoints": [["2026-11-06T00:00:00Z", 16], ["2026-11-06T06:00:00Z", 20.5]],
  "tips": [{ "title": "Lower the boiler flow temperature", "detail": "..." }],
  "freshness": { "...": "combined nest + boiler_probes" } }
```

- Firing time: each `hvac_heating` reading holds until the next, at most 3 × the Nest's poll interval (a gap isn't counted as on). A run still going at the end of the day isn't a short cycle (< 15 min) yet.
- `heatingNow` is null for past days or when the Nest data isn't live. `condensingShare` and `flowPeakC` are null without probes; `warmUp` is null without firing runs of 20 min or more.
- No "next change": SDM doesn't expose schedules. `setpoints` are the targets observed during the day.
- Cached 30 s per date. Logic: `apps/api/src/routes/heating.ts` and `packages/shared/src/heating.ts`.

### `GET /api/summary/water?from=&to=`
Daily litres, hourly profile for a day, nightly minimum flow (leak check).

### `GET /api/events?limit=50&level=`
Recent events, newest first: `{ "items": [{ "id", "ts", "level", "sourceId", "kind", "message", "data", "resolvedAt" }] }`. `limit` 1–500.

### `GET /api/tariffs` · `PUT /api/tariffs`
Read and replace tariff rows. Validate no overlapping periods per fuel.

`{ "items": [{ "id", "fuel": "electricity" | "gas" | "water", "unitRatePence", "standingPence", "validFrom": "2026-10-01", "validTo": "2027-03-31" | null }] }`. `validTo` is the last day the rate applies (inclusive); null = still current. PUT takes `{ "items": [...] }` without ids, replaces every row in one transaction, and returns the new list. Pence have at most 3 decimals.

### `GET /api/stream` (Server-Sent Events)
- `event: reading` → `{ seriesId, ts, value }` for every new live reading (from Postgres `LISTEN readings`).
- `event: freshness` → `{ sourceId, freshness }` when a source's state changes.
- `event: event` → a new `events` row.
- Heartbeat comment every 25 s (Cloudflare closes idle connections around 100 s).
- The web app falls back to polling `/api/latest` every 60 s if SSE drops.
- On connect: `retry: 5000`, then one `freshness` event per source with its current state, so a client is in sync without a separate request.
- `freshness` is re-checked every 30 s, and within 1 s when a reading arrives for a source that isn't Live (so a badge flips back promptly).
- `event` is sent for new and for resolved events (`resolvedAt` set).
- Never compressed (compression would buffer the stream). At most 50 clients; more get 503. One Postgres `LISTEN` connection serves all clients. Clients that stop reading (> 1 MB buffered) are dropped.
- Through Cloudflare: browsers authenticate with the Access cookie (EventSource can't send headers); the Android app's service token headers work the same way.

## Errors

`{ "error": { "code": "BAD_REQUEST", "message": "..." } }` with the matching HTTP status. Never leak stack traces or upstream credentials.

## Performance

- Postgres pool max 10.
- Cache `GET /api/sources` and summary endpoints for 30 s in memory.
- Gzip responses over 1 KB (`@fastify/compress`); not the SSE stream. Target < 100 ms p95 on the Pi for `/api/latest` and 24 h `/api/readings`.
