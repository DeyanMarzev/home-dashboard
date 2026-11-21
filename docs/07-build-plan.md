# 07 · Build plan

Work in this order. Each milestone ends with its checks passing and a short note to the owner on what to run on the Pi and what to look at. Don't start the next milestone until the owner confirms the current one works on the Pi, unless the owner says to continue.

M11 (phone app and notifications) only depends on M3–M5. If the owner asks, do it straight after M5.

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
- `collector_runs` logging, backoff, `source_late` events. Events are written only through `openEvent()` / `resolveEvent()` (`packages/db/src/events.ts`). M11 builds alerts on them.

**Done when:** on the Pi, readings for all four sources appear in the database; stopping the fake sensor turns `room_sensors` Late within the window and creates one event; restarting it resolves the event.

## M4 · API

- All endpoints in `docs/04` except summaries and the "Users and notifications" section (M11); SSE stream with `LISTEN`; Access JWT middleware.

**Done when:** endpoint tests pass with a seeded test DB; `curl` through the tunnel with a service token returns data; SSE delivers a fake-sensor reading within 2 s.

## M5 · Web app: Overview, Rooms, System

- Design tokens, fonts, shared components (`FreshnessBadge` first), these three pages with real data.

**Done when:** pages match the mockup's layout at 1440 px and 390 px widths; badges come from data (verified by stopping a source and watching it turn Late without reloading).

## M6 · Nest + heating

- `nest` collector (OAuth refresh; raises `nest_auth` via `openEvent()` when refresh fails, resolves it on success), `boiler_probes` collector (handles "no probes yet"), `/api/summary/heating`, Heating page.

**Done when:** live Nest values appear; running time and cycles match the Nest app's history for a test day within a few minutes.

## M7 · Energy

- `smart_meters` collector behind `MeterProvider` with the `fake` provider first; real provider once the owner confirms which (see `docs/08`).
- `tariffs` + edit UI, `/api/summary/energy`, Energy page, Overview energy tiles.

**Done when:** daily totals for a test day match the provider's own app; badges show "1 day behind" and turn Late if a day is missed.

## M8 · Water

- `thames_water` collector (careful login, 3 tries max per day), leak check (raises `water_leak` via `openEvent()`), `/api/summary/water`, Water page.

**Done when:** hourly data for the last 7 days loads and matches the Thames Water website; the leak check is correct for a seeded test night with non-zero flow.

## M9 · Wi-Fi and speed test

- `netprobe` container (host network), `wifi` and `speed_test` sources, Wi-Fi page. Router integration only if the owner's router supports it (see `docs/08`).
- **New-device alert** (`docs/10` §5), added after M9 was built. It needs users and roles, so build it **after M11 step 2**: `network_devices` migration (`005`), arp-scan every 5 min with baseline on the first scan, `network_new_device` events for any new device (wired or Wi-Fi, guests included), admin `/api/network/devices` endpoints, "Devices" card on the Wi-Fi page (admins only). If M11 isn't built yet, the events still appear in the events list and start notifying once M11 lands.

**Done when:** (existing Wi-Fi checks) and `docs/10` §7 item 3 passes once M11 exists.

## M10 · Backups and hardening

- Backup/restore scripts, backup events (kind `backup`: `info` on success, `warning` on failure), restore test documented; log rotation; dependency audit; container resource check (`docker stats`) under normal load.

## M11 · Phone app (PWA), users and notifications

Full spec: `docs/09-phone-app-and-notifications.md`, plus the extra rules in `docs/10-extra-alerts.md`. This replaces the earlier Capacitor/Firebase plan. Rules for events that already exist (`water_leak`, `backup`, `nest_auth`, `roborock_auth`, `vacuum_not_charging`) and for the vacuum's `battery` readings work as soon as the engine is in; `network_new_device` starts when that alert is built.

Build in this order, checking each step before the next:

1. **PWA shell** (built 21 Nov 2026; to check on the owner's phone): manifest (`crossorigin="use-credentials"`), icons, service worker via `vite-plugin-pwa` (`injectManifest`), install button, update toast, bottom nav at ≤ 640 px, session-expired handling in `apiFetch`.
2. **Users and roles** (built 21 Nov 2026; needs `ADMIN_EMAILS` in `.env`): migration `004_users_notifications.sql` (`docs/02` § Users and notifications), user upsert from the Access JWT, `ADMIN_EMAILS`, role checks on admin routes (including `PUT /api/tariffs`), `/api/me`, `/api/users`.
3. **Alert engine** (collector; built 21 Nov 2026, Met Office warnings included): `config/alerts.yaml` + zod schema, overrides, threshold state machine with `alert_state`, `freshness` rule (declares M3's existing `source_late` events; the late check stays as built), `event` rules, `pi_undervoltage` from `pi_stats`, reload on `alert_rules_changed`, and `scripts/backup.sh` resolving open `backup` warnings after a good backup (today they stay open). Include the `docs/10` §1 engine changes (single-level thresholds, event escalation/update, custom titles, `resolvedName`, `resolvedNotice`, `options`), the `docs/10` rules in the YAML (vacuum, weather; `network_new_device` too, though nothing raises it until the new-device alert is built), and the **`met_office_warnings` collector** for Waltham Forest (`docs/10` §4) with its fixture-based tests.
4. **Dispatcher** (api): `LISTEN events`, catch-up on start and every minute, `shouldNotify`, `WebPushChannel` + `FakeChannel`, retries, cleanup of gone subscriptions, `notification_log`, rate limit, VAPID env + `scripts/generate-vapid-keys`.
5. **Settings UI:** This device, My alerts, Quiet hours and pause, My devices; admin Alert thresholds (including rule `options` switches) and Users; recent notifications on System. Weather events in the Overview alerts strip with colour as text and the Met Office link.
6. **Optional:** `HEALTHCHECK_PING_URL` ping from the collector.

Also: `scripts/fake-sensor.ts --co2-spike <room> --ppm <n> --minutes <n>`; the owner steps in `docs/06` §5 and §10 are checked against what was built.

**Done when:** every item in `docs/09` §10 and `docs/10` §7 item 2 passes on the owner's phone and a second person's phone, and the tests in `docs/09` §9 and `docs/10` §6 are green.

## M12 · Robot vacuum

**Built** as source `roborock` (2026-11-15; battery and state 2026-11-21): runs per floor on the Misc page's calendar, battery and state on its Vacuum panel, and a `vacuum_not_charging` warning event (`docs/03` § roborock, `docs/10` §3). No Overview tile (owner, 21 Nov 2026).

Left to do, as part of M11 step 3: the `vacuum_not_charging`, `vacuum_battery_low` and `roborock_auth` rules in `config/alerts.yaml`.

**Done when:** `docs/10` §7 item 1 passes.
