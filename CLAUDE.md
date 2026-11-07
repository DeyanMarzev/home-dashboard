# Home Dashboard

A self-hosted dashboard for one house: room sensors (temperature, humidity, CO₂, pressure), Nest heating, boiler pipe temperatures, gas and electricity, water, Wi-Fi and the Raspberry Pi's own health. Data comes from many sources; some are live, some arrive days late. Every number shown must say how fresh it is.

- **Runs on:** Raspberry Pi 4, 4 GB RAM, 64-bit Raspberry Pi OS (Lite). Boots from SD card; database lives on a USB SSD mounted at `/mnt/ssd`.
- **Public URL:** `https://home.deyan.uk` via Cloudflare Tunnel, behind Cloudflare Access (login required). DNS for `deyan.uk` is on Cloudflare.
- **Clients:** web app (browser) now, Android app later (Capacitor wrapper around the same web app).
- **Owner:** Deyan (UK, Europe/London timezone).

## Read these first

| Doc | What's in it |
|---|---|
| `docs/01-architecture.md` | Components, containers, network, memory budget, coexisting FastAPI project |
| `docs/02-data-model.md` | Database schema (TimescaleDB), retention, aggregates |
| `docs/03-sources-and-freshness.md` | Source registry, Live/Delayed/Late rules, every planned source |
| `docs/04-api.md` | REST + SSE endpoints and response shapes |
| `docs/05-frontend.md` | Pages, components, design tokens (from the approved mockup) |
| `docs/06-pi-setup-and-deploy.md` | Preparing the Pi, Cloudflare, deploying, backups |
| `docs/07-build-plan.md` | Milestones in order, with acceptance criteria |
| `docs/08-open-questions.md` | Things not decided yet: ask the owner, don't guess |

Work through `docs/07-build-plan.md` in order. Finish and verify one milestone before starting the next.

## Stack

- **Language:** TypeScript everywhere (strict mode, ESM). Node.js 24 LTS.
- **Monorepo:** pnpm workspaces.
  - `packages/shared`: types, zod schemas, the freshness logic, unit conversions. No runtime dependencies on Node-only APIs (the web app imports it too).
  - `apps/collector`: one process running all collectors on schedules, plus the MQTT subscriber.
  - `apps/api`: Fastify 5 HTTP API + Server-Sent Events, also serves the built web app.
  - `apps/web`: React + Vite + TanStack Query + React Router. Charts with Apache ECharts (tree-shaken imports).
  - `apps/mobile`: added in the last milestone (Capacitor, Android).
- **Database:** PostgreSQL 17 + TimescaleDB, accessed with `postgres` (postgres.js). Plain numbered SQL migrations in `db/migrations/`, applied by a small runner in `packages/db` or `apps/api` at startup.
- **Messaging:** Mosquitto (MQTT 5) for sensors.
- **Deployment:** Docker Compose on the Pi. All images must have `linux/arm64` variants.
- **Tests:** Vitest. Freshness logic and every collector's parser must have unit tests with recorded sample payloads.

## Commands (keep these working)

```bash
pnpm install
pnpm dev            # api + web + collector against local docker services
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose up -d --build   # on the Pi
```

## Rules

1. **Freshness is computed, never hardcoded.** No component shows "Live" or "1 day behind" as fixed text. The badge comes from `packages/shared/freshness.ts` applied to the source's registry entry and the series' latest timestamp. See `docs/03-sources-and-freshness.md`.
2. **New sources are config + one collector module.** Adding a source must not require changes to the API, the database schema or the freshness logic. If it does, the abstraction is wrong. Fix the abstraction.
3. **Two timestamps on every reading.** `ts` = the time the value is *for* (start of the interval for consumption totals). `received_at` = when we stored it. Never confuse them.
4. **Store UTC, display Europe/London.** `timestamptz` everywhere. Day boundaries for "per day" totals use Europe/London (watch the clocks changing in March and October).
5. **Writes are idempotent.** Collectors upsert on `(series_id, ts)`. Delayed sources re-send overlapping windows; that must not create duplicates.
6. **Secrets only in `.env`** (git-ignored). Commit `.env.example` with every variable and a comment. Never log tokens, passwords or full API responses that contain them.
7. **One collector failing never stops the others.** Each run is wrapped, timed, logged to `collector_runs`, and retried with backoff.
8. **Respect the Pi.** Memory limits in `docs/01-architecture.md` are hard limits. No heavy dependencies without a reason. Batch database writes.
9. **Don't touch the owner's existing FastAPI project** on the Pi. Don't bind port 8000. Don't modify system Python or its service.
10. **When something is listed in `docs/08-open-questions.md`, ask; don't invent.** Build the adapter interface and a fake/sample implementation, then stop and ask for the real details.

## Units and naming

- Temperature °C, humidity %, CO₂ ppm, pressure hPa, energy kWh, power W, water L, signal dBm, money pence (integer) in the database and £ in the UI.
- Metric keys are `snake_case` (`temperature`, `co2`, `energy_import`). Entity keys are `snake_case` rooms or devices (`living_room`, `kitchen`, `boiler_flow`).
- Source ids are `snake_case` and stable forever (`room_sensors`, `nest`, `smart_meters`, `thames_water`).

## Definition of done for any change

- `pnpm lint typecheck test build` pass.
- New collectors have a parser test using a recorded sample payload in `__fixtures__/`.
- `.env.example` and the relevant doc in `docs/` are updated in the same change.
- Works on arm64 (no x86-only binaries or images).
