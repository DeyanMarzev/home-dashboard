# 07 · Build plan

Work in this order. Each milestone ends with its checks passing and a short note to the owner on what to run on the Pi and what to look at. Don't start the next milestone until the owner confirms the current one works on the Pi, unless the owner says to continue.

## M0 · Repo skeleton

- pnpm workspace, TypeScript strict, ESLint + Prettier, Vitest, `packages/shared`, `apps/{collector,api,web}` placeholders.
- `docker-compose.yml` with all five services, memory limits, healthchecks, bind mounts under `${DATA_DIR}`; Postgres conf from `docs/01`; Mosquitto conf with password auth.
- `.env.example` complete.

**Done when:** `pnpm lint typecheck test build` pass; `docker compose config` is valid; all images resolve for `linux/arm64`.

## M1 · Route in: tunnel + Access + hello

- `api` serves `/api/health` and a static "Home dashboard is running" page.
- Cloudflare steps documented for the owner (`docs/06` §5).

**Done when:** `https://home.deyan.uk` asks for Cloudflare login, then shows the page; `/api/health` returns ok; requests without a valid Access JWT get 401 when hitting the origin directly.

## M2 · Database, registry, freshness

- Migrations `001_init.sql`, `002_timescale_policies.sql` (from `docs/02`), runner with advisory lock.
- `config/sources.yaml` loader + zod schema + sync to `sources`.
- `packages/shared/freshness.ts` + `combineFreshness`, with tests covering: live within window, live → late, delayed within grace, delayed → late, `interval_total` `dataTo` = ts + interval, Europe/London day counting across the last Sunday of October and March.
- `writeReadings` (series auto-create, batch upsert, `NOTIFY`).

**Done when:** tests pass; writing the same batch twice doesn't duplicate rows; `sources` table matches the YAML.

## M3 · First live collectors

- `pi_stats` (CPU temp, throttle flags, memory, load, uptime, disk, DB size).
- `room_sensors` MQTT subscriber (topic contract in `docs/03`) + a `scripts/fake-sensor.ts` that publishes realistic readings for three rooms, so the pipeline can be proven before real sensors are connected.
- `open_meteo`, `carbon_intensity`.
- `collector_runs` logging, backoff, `source_late` events.

**Done when:** on the Pi, readings for all four sources appear in the database; stopping the fake sensor turns `room_sensors` Late within the window and creates one event; restarting it resolves the event.

## M4 · API

- All endpoints in `docs/04` except summaries; SSE stream with `LISTEN`; Access JWT middleware.

**Done when:** endpoint tests pass with a seeded test DB; `curl` through the tunnel with a service token returns data; SSE delivers a fake-sensor reading within 2 s.

## M5 · Web app: Overview, Rooms, System

- Design tokens, fonts, shared components (`FreshnessBadge` first), these three pages with real data.

**Done when:** pages match the mockup's layout at 1440 px and 390 px widths; badges come from data (verified by stopping a source and watching it turn Late without reloading).

## M6 · Nest + heating

- `nest` collector (OAuth refresh), `boiler_probes` collector (handles "no probes yet"), `/api/summary/heating`, Heating page.

**Done when:** live Nest values appear; running time and cycles match the Nest app's history for a test day within a few minutes.

## M7 · Energy

- `smart_meters` collector behind `MeterProvider` with the `fake` provider first; real provider once the owner confirms which (see `docs/08`).
- `tariffs` + edit UI, `/api/summary/energy`, Energy page, Overview energy tiles.

**Done when:** daily totals for a test day match the provider's own app; badges show "1 day behind" and turn Late if a day is missed.

## M8 · Water

- `thames_water` collector (careful login, 3 tries max per day), leak check, `/api/summary/water`, Water page.

**Done when:** hourly data for the last 7 days loads and matches the Thames Water website; the leak check is correct for a seeded test night with non-zero flow.

## M9 · Wi-Fi and speed test

- `netprobe` container (host network), `wifi` and `speed_test` sources, Wi-Fi page. Router integration only if the owner's router supports it (see `docs/08`).

## M10 · Backups and hardening

- Backup/restore scripts, backup events, restore test documented; log rotation; dependency audit; container resource check (`docker stats`) under normal load.

## M11 · Android app

> **Deferred** by the owner (2026-11-07): build later, when asked. M0–M10 come first, including verifying them on the Pi.

- Capacitor in `apps/mobile` wrapping the web build; Access service token stored securely (Capacitor secure storage); app icon and name; bottom navigation; push notifications for `alert` events (Firebase Cloud Messaging) as a stretch goal.

**Done when:** a debug APK installs on the owner's phone and shows live data outside the home network.
