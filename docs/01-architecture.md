# 01 · Architecture

## Overview

```
 Browser (home.deyan.uk)      Android app (later)
            \                     /
             \                   /
         Cloudflare: DNS · TLS · Access login
                       |
            (outbound tunnel, no open ports)
                       |
 ┌──────────────── Raspberry Pi 4 (Docker Compose) ────────────────┐
 │                                                                  │
 │  cloudflared ──► api (Fastify + built web app) ──► postgres      │
 │                        ▲  SSE                       (Timescale)  │
 │                        │                               ▲         │
 │  mosquitto ──────► collector (all collectors) ─────────┘         │
 │     ▲                     │                                      │
 └─────┼─────────────────────┼──────────────────────────────────────┘
       │                     │
  ESP32 room sensors     External APIs: Nest SDM, Open-Meteo,
  (MQTT over Wi-Fi)      Carbon Intensity, smart meters, Thames Water
                         Local hardware: DS18B20 probes, Pi stats, Wi-Fi
```

## Containers

| Service | Image | Purpose | Memory limit |
|---|---|---|---|
| `postgres` | `timescale/timescaledb:2.31.0-pg17` | All data | 1 GB |
| `mosquitto` | `eclipse-mosquitto:2.1.2-alpine` | MQTT broker for sensors | 64 MB |
| `collector` | built from `apps/collector` | Runs every collector + MQTT subscriber | 256 MB |
| `api` | built from `apps/api` | REST, SSE, serves `apps/web` build | 384 MB |
| `cloudflared` | `cloudflare/cloudflared:2026.10.7` | Tunnel to Cloudflare | 128 MB |

Image tags are pinned in `docker-compose.yml`; all have `linux/arm64` variants (checked 2026-11-07). `api` and `collector` are built from the root `Dockerfile` (targets `api` / `collector`, base `node:24-trixie-slim`).

Total about 1.8 GB, leaving room for the OS, page cache and the owner's existing FastAPI project on a 4 GB Pi.

### Postgres tuning for 4 GB Pi (set via `command:` args or a mounted conf)

```
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 8MB
maintenance_work_mem = 64MB
max_connections = 30
timescaledb.max_background_workers = 4
max_worker_processes = 8
wal_compression = on
```

Disable `timescaledb-tune` auto-tuning in the image (`NO_TS_TUNE=true`) so these values stick.

## Network and ports

- All services share one Docker network (`home`). Services talk by name (`postgres:5432`, `mosquitto:1883`, `api:3000`).
- **Published host ports:** only `1883` (MQTT) so ESP32 sensors on the home Wi-Fi can reach the broker. Optionally `127.0.0.1:3000` for local debugging.
- **Postgres is not published.** If a host port is ever needed, use `127.0.0.1:5433` (5432 may already be used on the host).
- **Port 8000 is taken** by the owner's existing FastAPI project (runs outside Docker). Never bind it.
- MQTT requires username/password (`mosquitto_passwd` file). Anonymous access off.

### Containers that need host access

| Need | How |
|---|---|
| Pi CPU temperature, throttling, memory, disk | Mount `/sys` and `/proc` read-only into `collector` (`/host/sys`, `/host/proc`) and the SSD + root fs for `statfs`. Throttle flags: `/sys/devices/platform/soc/soc:firmware/get_throttled` (verify on the Pi; fallback: a host cron running `vcgencmd get_throttled` that publishes to MQTT). |
| DS18B20 boiler pipe probes (1-Wire on GPIO4) | Mount `/sys/bus/w1/devices` read-only. Requires `dtoverlay=w1-gpio` on the host. |
| Wi-Fi scans, ARP scans, ping | A separate small container `netprobe` with `network_mode: host` and `cap_add: [NET_ADMIN, NET_RAW]`, publishing results to MQTT. Added in a later milestone. |

## Public access

- Cloudflare Tunnel (remotely managed, token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`).
- Public hostname `home.deyan.uk` → `http://api:3000`.
- Cloudflare Access application on `home.deyan.uk`: allow listed emails only. A service token for the Android app.
- The API also verifies the `Cf-Access-Jwt-Assertion` header (defence in depth). See `docs/04-api.md`.
- Optional later: the same tunnel can publish the owner's FastAPI project on another hostname (`http://host.docker.internal:8000` with `extra_hosts: ["host.docker.internal:host-gateway"]`).

## Storage

- SSD mounted at `/mnt/ssd` (ext4, by UUID in `/etc/fstab`, `nofail`).
- Postgres data: `/mnt/ssd/home-dashboard/postgres` (bind mount).
- Mosquitto data/logs: `/mnt/ssd/home-dashboard/mosquitto`.
- Backups: `/mnt/ssd/home-dashboard/backups`, then copied off the Pi (see `docs/06-pi-setup-and-deploy.md`).
- The repo itself can live on the SD card: `/opt/home-dashboard`.

## Data flow

1. **Push sources** (room sensors): ESP32 → MQTT topic → `collector` subscriber → batch insert every 5 s.
2. **Pull sources** (APIs, files, scrapes): scheduler in `collector` runs each source on its `poll` schedule → parse → upsert.
3. **Derived values** (dew point, costs, degree-days, baseload): computed in SQL views or at query time in the API, never stored as if they were measurements. Exception: daily rollups that are expensive can be stored in a `derived` source with clear lineage.
4. `collector` sends `NOTIFY readings, '<series_id>'` after each batch. `api` `LISTEN`s and pushes updates to browsers over SSE.

## Failure handling

- Each collector run writes a row to `collector_runs` (start, end, ok, rows, error).
- Exponential backoff per source on failure (cap at the source's poll interval × 4).
- Freshness turns **Late** automatically if a source stops delivering. That's the primary alert signal (see `docs/03`).
- All containers `restart: unless-stopped`. Healthchecks on `postgres`, `mosquitto`, `api`.

## Repository layout

```
home-dashboard/
  CLAUDE.md
  docs/
  config/
    sources.yaml            # the source registry (source of truth)
  db/
    migrations/             # 001_init.sql, 002_...
  packages/
    shared/                 # types, zod, freshness, units
  apps/
    collector/
      src/sources/<source_id>/  # one folder per source: index.ts, parse.ts, __fixtures__/
    api/
    web/
    mobile/                 # last milestone
  docker/
    mosquitto/mosquitto.conf
    postgres/postgresql.conf
  docker-compose.yml
  .env.example
```
