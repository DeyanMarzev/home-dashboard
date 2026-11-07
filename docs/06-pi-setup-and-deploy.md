# 06 · Pi setup and deploy

Target: Raspberry Pi 4, 4 GB RAM, Raspberry Pi OS Lite 64-bit (`uname -m` → `aarch64`), booting from SD card. An existing FastAPI project runs on port 8000 outside Docker. Leave it alone.

Claude Code: you can't run these on the Pi yourself. Produce the files and a `scripts/` folder where useful, and give the owner exact commands to run. Prefer idempotent scripts.

## 1. SSD for data

```bash
lsblk -f                                   # find the SSD, e.g. /dev/sda1
sudo mkfs.ext4 -L homedata /dev/sda1       # ONLY if the SSD is new/empty, this erases it
sudo mkdir -p /mnt/ssd
sudo blkid /dev/sda1                       # copy the UUID
echo 'UUID=<uuid> /mnt/ssd ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a && df -h /mnt/ssd
sudo mkdir -p /mnt/ssd/home-dashboard/{postgres,mosquitto,backups}
```

Use a blue USB 3 port. If the SSD disconnects under load, it's usually the USB-SATA adapter (UAS quirk) or power. Note it as a known issue rather than working around it silently.

## 2. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # log out and back in
docker compose version
```

Memory limits in `docker-compose.yml` only work if the kernel's memory cgroup is enabled. Check:

```bash
docker info 2>&1 | grep -i 'memory limit'   # no output = OK; "No memory limit support" = not enabled
```

If it isn't enabled, append ` cgroup_enable=memory cgroup_memory=1` to the end of the single line in `/boot/firmware/cmdline.txt` and reboot.

## 3. 1-Wire for boiler probes (when the hardware is fitted)

Add `dtoverlay=w1-gpio` to `/boot/firmware/config.txt`, reboot, check `ls /sys/bus/w1/devices/` shows `28-…` entries.

## 4. Get the code and configure

```bash
sudo mkdir -p /opt/home-dashboard && sudo chown $USER /opt/home-dashboard
git clone <repo-url> /opt/home-dashboard
cd /opt/home-dashboard
cp .env.example .env && nano .env
```

Generate passwords with `openssl rand -hex 24`. Then check the file is complete (Compose refuses to start if a required value is empty):

```bash
docker compose config --quiet && echo OK
```

MQTT users are created from `.env` each time the `mosquitto` container starts (`docker/mosquitto/entrypoint.sh`): `MQTT_USERNAME` is the collector (reads `home/#`), `MQTT_SENSOR_USERNAME` is what the ESP32 sensors use (may only publish to `home/sensors/#`).

`.env.example` must list at least:

```
NODE_ENV=production
TZ=Europe/London
DATA_DIR=/mnt/ssd/home-dashboard

POSTGRES_USER=home
POSTGRES_PASSWORD=
POSTGRES_DB=home

MQTT_USERNAME=collector
MQTT_PASSWORD=
MQTT_SENSOR_USERNAME=sensors
MQTT_SENSOR_PASSWORD=

CLOUDFLARE_TUNNEL_TOKEN=
CF_ACCESS_TEAM=            # <team>.cloudflareaccess.com
CF_ACCESS_AUD=             # Access application audience tag
AUTH_DISABLED=false

HOME_LAT=
HOME_LON=
HOME_POSTCODE_OUTCODE=     # e.g. the first half of the postcode, for Carbon Intensity

NEST_PROJECT_ID=
NEST_CLIENT_ID=
NEST_CLIENT_SECRET=
NEST_REFRESH_TOKEN=

METER_PROVIDER=fake        # fake | <provider chosen later>
# provider-specific variables added when chosen

THAMES_EMAIL=
THAMES_PASSWORD=
THAMES_ACCOUNT_NUMBER=
THAMES_METER_ID=

BOILER_FLOW_W1_ID=
BOILER_RETURN_W1_ID=

BACKUP_RCLONE_REMOTE=      # e.g. gdrive:home-dashboard-backups (optional)
```

## 5. Cloudflare (DNS is already on Cloudflare)

Do these in order: the Access application goes in **before** the tunnel's public hostname, so `home.deyan.uk` is never reachable without a login, not even for a minute. (The API would still answer 401 without a valid Access token, but don't rely on that alone.)

All of this is in the Cloudflare dashboard → **Zero Trust**. Menu names move around from time to time; search the Zero Trust dashboard for the bold names if a path below doesn't match.

### 5.1 Team name and login method

1. First time in Zero Trust: pick a **team name** and the **Free** plan (free for up to 50 users; Cloudflare may ask for a payment method even on Free).
2. Find the team name later under **Settings** → team domain `<team>.cloudflareaccess.com`. Put `<team>` in `.env` as `CF_ACCESS_TEAM` (the full domain also works).
3. Login method: **One-time PIN** is on by default (Cloudflare emails you a code). That's enough. Adding Google as an identity provider is optional.

### 5.2 Access application (the login wall)

1. **Access → Applications → Add an application → Self-hosted.**
2. Name `Home dashboard`; public hostname: subdomain `home`, domain `deyan.uk`, no path.
3. Session duration: your choice (e.g. 1 month, so the phone doesn't keep asking).
4. Policy: name `Owner`, action **Allow**, Include → **Emails** → `deyanmarzev@gmail.com`.
5. Save. Open the application again and copy its **Application Audience (AUD) Tag** into `.env` as `CF_ACCESS_AUD`.

### 5.3 Tunnel

1. **Networks → Tunnels → Create a tunnel → Cloudflared**, name it `home-pi`.
2. On the install screen choose **Docker**. Don't run the command it shows; just copy the long token after `--token` into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`. (`docker compose` runs `cloudflared` for you.)
3. Next → **Public hostname**: subdomain `home`, domain `deyan.uk`, service type **HTTP**, URL `api:3000`. Save. If Cloudflare says a DNS record for `home` already exists, delete that record in the DNS tab first.

### 5.4 Check it (after `docker compose up -d --build`, §6)

```bash
docker compose ps                                  # all services "running"/"healthy"
curl -s  http://127.0.0.1:3000/api/health          # {"ok":true,...}: health is open on the Pi
curl -si http://127.0.0.1:3000/ | head -1          # HTTP/1.1 401: no Access token, no page
```

- In the Zero Trust dashboard the tunnel shows **Healthy**.
- In a private browser window, `https://home.deyan.uk` shows the Cloudflare login. Enter your email and the emailed code, then you see **"Home dashboard is running"**.
- From outside, every path (including `/api/health`) goes through the login first. Only the Pi itself can reach `/api/health` without one.

Troubleshooting:

| You see | Likely cause |
|---|---|
| Browser: `{"error":{"code":"UNAUTHORIZED"...}}` after logging in | `CF_ACCESS_AUD` or `CF_ACCESS_TEAM` doesn't match the Access app. `docker compose logs api \| grep rejected` shows the reason (`ERR_JWT_CLAIM_VALIDATION_FAILED` = wrong AUD or team). Fix `.env`, then `docker compose up -d api`. |
| Browser: `SERVICE_UNAVAILABLE` | The Pi can't fetch Access's signing keys from `https://<team>.cloudflareaccess.com`. Check the Pi's internet/DNS. |
| Cloudflare error 502 / 1033 | Tunnel is up but `api` isn't answering (`docker compose ps`, `docker compose logs api`), or the hostname's service URL isn't `http://api:3000`. |
| `api` exits with "Invalid environment" | The message lists exactly which `.env` values are missing or wrong. |

### 5.5 Service token (for the Android app, M11)

**Access → Service credentials → Service Tokens → Create.** Then in the `Home dashboard` application add a second policy: action **Service Auth**, Include → **Service Token** → the new token. Nothing changes in the API.

## 6. Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api collector
```

Migrations run automatically when `api` and `collector` start (advisory lock, so only one applies each migration), and both sync `config/sources.yaml` into the `sources` table. Look for `database ready` in the logs.

To change the source registry: edit `config/sources.yaml` (it is bind-mounted into both containers), then `docker compose restart api collector`. An invalid file stops both with a message listing every problem; fix it and restart.

Check: `https://home.deyan.uk` asks for login, then shows the dashboard.

### Check the collectors (M3)

Put `HOME_LAT`, `HOME_LON` and `HOME_POSTCODE_OUTCODE` in `.env` first (`docker compose up -d collector` after changing it).

```bash
docker compose --profile fake up -d fake-sensor     # three fake rooms over MQTT
docker compose logs -f collector                    # "collector started", "MQTT connected"
docker compose exec postgres psql -U home -d home -c \
  "select s.source_id, count(*) from readings r join series s on s.id = r.series_id group by 1"
docker compose exec postgres psql -U home -d home -c \
  "select source_id, started_at, ok, rows_written, error from collector_runs order by id desc limit 10"
```

Expect rows for `room_sensors`, `pi_stats`, `open_meteo` and `carbon_intensity`, and runs with `ok = t`. Then the Late test:

```bash
docker compose stop fake-sensor     # within ~10 min: one open source_late event for room_sensors
docker compose exec postgres psql -U home -d home -c \
  "select id, ts, source_id, message, resolved_at from events order by id desc limit 5"
docker compose start fake-sensor    # within ~5 min: that event gets resolved_at
```

(Room sensors turn Late 5 minutes after the last reading; the checker runs every 5 minutes, so the event appears 5–10 minutes after stopping.) Leave the fake sensor stopped when you're done: `docker compose stop fake-sensor`.

### Check the API (M4)

Every route except `/api/health` needs a Cloudflare Access token, so test through the tunnel with a service token (create one as in §5.5 if you haven't yet):

```bash
# A service token (docs/06 §5.5) lets curl through Cloudflare Access:
export CF_ID=<client id> CF_SECRET=<client secret>
H="-H CF-Access-Client-Id:$CF_ID -H CF-Access-Client-Secret:$CF_SECRET"
curl -s $H https://home.deyan.uk/api/sources | head -c 600; echo
curl -s $H "https://home.deyan.uk/api/latest?source=room_sensors" | head -c 600; echo
curl -sN $H https://home.deyan.uk/api/stream      # with the fake sensor running: "event: reading" lines every 30 s
```

The stream should show a fake-sensor `reading` within about 2 s of it being published (the collector writes every second). Ctrl+C to stop.

## 7. Updating

```bash
cd /opt/home-dashboard && git pull && docker compose up -d --build
```

Builds on the Pi are slow; acceptable for v1. Later option: build `linux/arm64` images in GitHub Actions and `docker compose pull`.

## 8. Backups

- Nightly at 03:00: `pg_dump -Fc` from the postgres container to `/mnt/ssd/home-dashboard/backups/home-YYYY-MM-DD.dump`, keep 7.
- If `BACKUP_RCLONE_REMOTE` is set, copy the newest dump off the Pi with `rclone`.
- Write the result to `events` (`kind: 'backup'`) so the System page can show "Last backup".
- Provide `scripts/backup.sh` and `scripts/restore.sh`, and a host cron line (or a tiny `backup` container with cron).
- Document a restore test in this file once done.

## 9. Coexisting with the FastAPI project

- Don't publish host port 8000. Don't touch its systemd service or Python environment.
- Optional: publish it through the same tunnel on another hostname (`api.deyan.uk` → `http://host.docker.internal:8000`, with `extra_hosts: ["host.docker.internal:host-gateway"]` on `cloudflared`).
