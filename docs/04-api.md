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

interface Freshness {         // see docs/03
  state: 'live' | 'delayed' | 'late';
  dataTo: string;
  lagSeconds: number;
  daysBehind: number;
  label: string;
}
```

Every response that contains data includes a `freshness` object for each series, and a combined `freshness` for the response when it contains several series.

## Endpoints

### `GET /api/health`
`{ ok: true, db: 'up' | 'down', version: string }`

### `GET /api/sources`
All sources with registry info, freshness of their newest series, and the last collector run.
```json
[{ "id": "smart_meters", "name": "Smart meters", "kind": "api", "poll": "6h",
   "expectedDelay": "1d", "enabled": true,
   "freshness": { "state": "delayed", "dataTo": "2026-11-05T23:30:00Z", "lagSeconds": 73800,
                  "daysBehind": 1, "label": "Data to 5 Nov · 1 day behind" },
   "lastRun": { "startedAt": "...", "ok": true, "rowsWritten": 96, "durationMs": 1900, "error": null },
   "errors24h": 0 }]
```

### `GET /api/series?source=&metric=&entity=`
List of `SeriesMeta`, filterable.

### `GET /api/latest?series=1,2,3` or `?source=room_sensors` or `?metric=co2`
Latest value per series:
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

### `GET /api/summary/energy?from=&to=`
Daily electricity and gas kWh and cost (using `tariffs`), baseload (lowest 30 min average overnight → W), totals. Freshness combined from `smart_meters`.

### `GET /api/summary/heating?date=`
Boiler minutes on, cycles, condensing share (minutes with `boiler_return` < 55 °C while heating ÷ minutes heating), warm-up rate, schedule-derived next change if available.

### `GET /api/summary/water?from=&to=`
Daily litres, hourly profile for a day, nightly minimum flow (leak check).

### `GET /api/events?limit=50&level=`
Recent events, newest first.

### `GET /api/tariffs` · `PUT /api/tariffs`
Read and replace tariff rows. Validate no overlapping periods per fuel.

### `GET /api/stream` (Server-Sent Events)
- `event: reading` → `{ seriesId, ts, value }` for every new live reading (from Postgres `LISTEN readings`).
- `event: freshness` → `{ sourceId, freshness }` when a source's state changes.
- `event: event` → a new `events` row.
- Heartbeat comment every 25 s (Cloudflare closes idle connections around 100 s).
- The web app falls back to polling `/api/latest` every 60 s if SSE drops.

## Errors

`{ "error": { "code": "BAD_REQUEST", "message": "..." } }` with the matching HTTP status. Never leak stack traces or upstream credentials.

## Performance

- Postgres pool max 10.
- Cache `GET /api/sources` and summary endpoints for 30 s in memory.
- Gzip responses. Target < 100 ms p95 on the Pi for `/api/latest` and 24 h `/api/readings`.
