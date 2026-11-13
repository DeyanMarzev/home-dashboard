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

### 1.1 No SSD yet: start on the SD card

Everything works with the data on the SD card; the cost is SD card wear (the database writes all the time), so treat it as temporary and keep the Google Drive backups on (§8). Put the data outside the repo:

```bash
sudo mkdir -p /opt/home-dashboard-data/{postgres,mosquitto,backups}
sudo chown $USER /opt/home-dashboard-data /opt/home-dashboard-data/backups
```

and in `.env`: `DATA_DIR=/opt/home-dashboard-data`. The System page then shows only the SD card (no SSD bar).

### 1.2 Moving to the SSD later

Prepare the SSD as above (mounted at `/mnt/ssd`), then:

```bash
cd /opt/home-dashboard
docker compose down                                  # stops everything; the FastAPI project is untouched
sudo rsync -aHAX /opt/home-dashboard-data/ /mnt/ssd/home-dashboard/
# .env: DATA_DIR=/mnt/ssd/home-dashboard
docker compose up -d
```

Check the dashboard (and the SSD bar on the System page), then `sudo rm -rf /opt/home-dashboard-data`. If `scripts/install-backup-cron.sh` was run, run it again so the backup log moves too.

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
# <team>.cloudflareaccess.com
CF_ACCESS_TEAM=
# Access application audience tag
CF_ACCESS_AUD=
AUTH_DISABLED=false

HOME_LAT=
HOME_LON=
# e.g. the first half of the postcode, for Carbon Intensity
HOME_POSTCODE_OUTCODE=

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

# e.g. gdrive:home-dashboard-backups (optional)
BACKUP_RCLONE_REMOTE=
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

## 5b. Nest thermostat (M6)

Google's Smart Device Management (SDM) API needs a one-off setup, about 30 minutes. Use the **personal Google account the Nest is linked to** in the Google Home app (Device Access doesn't accept Google Workspace accounts). Google renames its console menus now and then: if a name below doesn't match, use the console's search box.

1. **Google Cloud project and OAuth client** (console.cloud.google.com):
   - Create a project (e.g. `home-dashboard`), then **APIs & Services → Library**: enable the **Smart Device Management API**.
   - **Google Auth Platform** (older consoles: *OAuth consent screen*): set it up as **External**; under **Audience**, add your Google account as a test user, then **Publish app** so it's **In production**. While it's in *Testing*, Google expires the refresh token after 7 days. You'll see an "unverified app" warning when you sign in in step 3; that's expected for your own app.
   - **Clients → Create client**: type **Web application**, authorised redirect URI exactly `https://www.google.com`. Copy the **client ID** and **client secret** into `.env` as `NEST_CLIENT_ID` and `NEST_CLIENT_SECRET`.
2. **Device Access project** (console.nest.google.com/device-access): accept the terms and pay Google's one-off registration fee (US$5). **Create project**: any name, paste the OAuth client ID from step 1, leave events (Pub/Sub) off. Copy the **Project ID** (a UUID) into `.env` as `NEST_PROJECT_ID`.
3. **Authorise once.** Open this link in a browser, with your two ids filled in:

   ```
   https://nestservices.google.com/partnerconnections/<NEST_PROJECT_ID>/auth?redirect_uri=https://www.google.com&access_type=offline&prompt=consent&client_id=<NEST_CLIENT_ID>&response_type=code&scope=https://www.googleapis.com/auth/sdm.service
   ```

   Sign in, tick your home and the thermostat, allow access. You end up on google.com with `?code=…` in the address bar. Within a few minutes (codes expire and work once), copy the **whole address** and turn it into the refresh token on the Pi, keeping the single quotes:

   ```bash
   docker compose up -d collector        # picks up NEST_CLIENT_ID / NEST_CLIENT_SECRET from .env
   docker compose exec collector node dist/tools/nest-token.js 'https://www.google.com/?code=…'
   ```

   Put the printed token in `.env` as `NEST_REFRESH_TOKEN` (`.env` only; don't paste it anywhere else).
4. `docker compose up -d collector`. The source is enabled in `config/sources.yaml`; until the `NEST_*` values are in, the System page shows it failing with the missing setting.
5. Check: `docker compose logs collector | grep nest` shows no errors; within 2 minutes the Heating page and the Overview show the thermostat's temperature, humidity, target and heating state. If Google later refuses the token, the System page shows a `nest_auth` alert: redo step 3.
6. Optional: capture a real response for the parser tests: `docker compose exec collector node dist/tools/nest-capture.js > nest.json` (ids and names are redacted) to replace `apps/collector/src/sources/nest/__fixtures__/devices-heating.json`.

The thermostat's room name in the Google Home app becomes the entity (`Hallway` → `hallway`); override with `options: { entity: hallway }` on `nest` in `config/sources.yaml`.

## 5c. Boiler pipe probes (when fitted)

Two DS18B20 probes on GPIO4 with a 4.7 kΩ pull-up, clipped to the flow and return pipes near the boiler. Enable 1-Wire (§3), then:

```bash
ls /sys/bus/w1/devices/                 # two 28-… entries
cat /sys/bus/w1/devices/28-*/temperature   # millidegrees; warm the flow pipe to tell them apart
```

Put the ids in `BOILER_FLOW_W1_ID` / `BOILER_RETURN_W1_ID`, set `boiler_probes: enabled: true`, `docker compose up -d collector`. Until the ids are set, the collector logs the probes it can see and writes nothing.

## 5d. Network measurements (netprobe, M9)

Set `MQTT_NETPROBE_PASSWORD` (and keep `MQTT_NETPROBE_USERNAME=netprobe`) in `.env`. For device counts from the Linksys MX4200, also set `ROUTER_PASSWORD` (the router's admin password, the one for the local web page; `ROUTER_URL` if it isn't the gateway). Without it, devices are counted with an ARP scan.

```bash
docker compose up -d --build netprobe mosquitto collector
docker compose logs -f netprobe        # "netprobe started"; problems are logged as "probe problem"
docker compose exec netprobe iw dev wlan0 link   # the Pi's own Wi-Fi (nothing if it's on Ethernet)
```

Within 5 minutes the Wi-Fi page shows devices and latency; within 30 the channel scan; the speed test runs daily at 12:00. To confirm the router's device format (docs/08 6b): `docker compose exec netprobe node dist/netprobe/router-capture.js > devices.json` and send the file (names and addresses are redacted).

## 5e. Smart meters (Bright)

Electricity and gas come from the Bright app's API (Hildebrand Glowmarkt), free, a day behind. First check the Bright app itself shows your half-hourly electricity and gas usage: the dashboard gets exactly that data.

In `.env`:

```bash
METER_PROVIDER=bright
BRIGHT_USERNAME=you@example.com     # the Bright app login
BRIGHT_PASSWORD=...
```

```bash
docker compose up -d collector
docker compose logs collector | grep smart_meters
```

The first run fetches the last 30 days, then it runs every 6 hours. The Energy page fills in, with its badge showing how far behind the data is (normally "1 day behind"). If the login is wrong, the System page shows Smart meters as Failing with "Bright refused the login".

To confirm the data format (docs/08 3b), capture it once and send the file (ids and personal details are redacted):

```bash
docker compose exec collector node dist/tools/bright-capture.js > bright.json
```

## 5f. Water (Thames Water)

Hourly water use from your Thames Water account (myaccount.thameswater.co.uk → My water use), about 3 days behind. There's no official API: the collector signs in to the account site once a day at 06:00 (never more than 3 attempts a day, so it can't lock the account). In `.env`:

```bash
WATER_PROVIDER=thames
THAMES_EMAIL=you@example.com     # your Thames Water account login
THAMES_PASSWORD=...
```

`THAMES_ACCOUNT_NUMBER` / `THAMES_METER_ID` only if the login has several accounts or meters. To check the sign-in now (and confirm the data format, docs/08 13), capture once; meter serials and personal details are redacted:

```bash
docker compose up -d collector
docker compose exec collector node dist/tools/thames-capture.js > thames.json
```

The Water page fills in after the next 06:00 run. The same run adds Thames Water's published metered rates (public page) to the tariffs, so water costs need no typing; set `surface_water_rebate: true` under `thames_water` → `options` in `config/sources.yaml` if your roof water doesn't drain to the public sewer. If Thames changes its site, the System page shows Thames Water as failing with the step that broke.

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

What happens every night at 03:00 (`scripts/backup.sh`, run by the host's cron):

1. `pg_dump -Fc` from the postgres container to `$DATA_DIR/backups/home-YYYY-MM-DD.dump` (on the SSD), written as `.partial` and renamed when complete.
2. Checked with `pg_restore --list` (a truncated dump fails here).
3. Only the newest **7** dumps are kept on the Pi.
4. If `BACKUP_RCLONE_REMOTE` is set, the dump is copied to Google Drive and copies older than **30 days** there are deleted.
5. The result goes into `events` (`kind: 'backup'`): the System page shows the last backup, its size and whether it reached Google Drive, turning red if it failed or is more than 36 h old. A failure names the step (`pg_dump`, `verify`, `copy to gdrive:…`).

The output goes to `$DATA_DIR/backups/backup.log` (trimmed to the last 2,000 lines).

### 8.1 Google Drive (rclone)

`rclone` runs on the Pi itself, not in a container. The Drive connection uses the `drive.file` scope: rclone can only see and delete the files it uploaded, never the rest of the Drive.

```bash
sudo apt install -y rclone
rclone config
```

In `rclone config`:

- `n` (new remote), name **`gdrive`**, storage **`drive`** (Google Drive).
- `client_id` and `client_secret`: leave empty.
- `scope`: **`drive.file`**.
- `service_account_file`: empty. Advanced config: `n`.
- "Use web browser to automatically authenticate?": **`n`** (the Pi has no browser). rclone prints a command like `rclone authorize "drive" "eyJ…"`.
- On the Windows PC: `winget install Rclone.Rclone`, open a new terminal, run that exact command, sign in to Google in the browser that opens, and paste the token it prints back into the Pi.
- Shared drive: `n`. Keep the remote: `y`. Quit: `q`.

Then in `.env`:

```bash
BACKUP_RCLONE_REMOTE=gdrive:home-dashboard-backups
```

The token rclone stores lives in `~/.config/rclone/rclone.conf` (mode 600), outside the repo.

### 8.2 Install the nightly job and run it once

Cron uses the Pi's own timezone (Debian's cron ignores `CRON_TZ`), so set it to UK time first:

```bash
sudo timedatectl set-timezone Europe/London
cd /opt/home-dashboard
scripts/install-backup-cron.sh     # idempotent; prints the installed line
scripts/backup.sh                  # run one now
rclone ls gdrive:home-dashboard-backups
```

The System page (Storage and backups) should now show "Last backup · just now · N MB" and "7 nightly on the Pi · 30 days off-site".

### 8.3 Restore test (do this monthly, and once now)

```bash
scripts/restore.sh --test          # newest dump; or: scripts/restore.sh --test /path/to/home-YYYY-MM-DD.dump
```

It restores into a scratch database (`home_restore_test`), prints row counts for `readings`, `series`, `events`, `sources` and `tariffs` next to the live ones, and drops the scratch database. The live database is not touched. Restored counts can be a little lower: rows written since the dump aren't in it. A restored `readings` count of 0, or an error, means the backups are not usable: investigate before relying on them.

To restore from Google Drive (e.g. after losing the SSD), copy a dump back first:

```bash
rclone copy gdrive:home-dashboard-backups/home-YYYY-MM-DD.dump "$DATA_DIR/backups/"
```

### 8.4 Real restore

```bash
scripts/restore.sh --replace /mnt/ssd/home-dashboard/backups/home-YYYY-MM-DD.dump
```

Asks for confirmation, stops `api` and `collector`, renames the live database to `home_old` (kept, in case), restores the dump into a fresh `home` and starts everything again. Collectors refill the gap since the dump where their source allows (delayed sources re-send overlapping windows). When happy: `docker compose exec postgres dropdb -U home home_old`.

### 8.5 Hardening, logs and resources (M10)

- **Containers:** every container has `no-new-privileges`. `api`, `collector` and `fake-sensor` drop all Linux capabilities and have a read-only root filesystem; `netprobe` keeps only `NET_ADMIN` and `NET_RAW`. Postgres isn't published to the host; the API only on `127.0.0.1:3000`.
- **HTTP:** the API sends a strict `Content-Security-Policy` (same-origin scripts only, no framing), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: same-origin`, on top of Cloudflare Access.
- **Logs:** Docker's `local` log driver, 10 MB × 3 files per container (about 200 MB at most for everything). `docker compose logs --tail=100 <service>`. The backup log trims itself.
- **Dependencies:** `pnpm audit:prod` (production dependencies only). 2026-11-07: no known vulnerabilities. The full `pnpm audit` also lists a moderate `minimatch` issue in dev-only lint tooling, which never runs on the Pi: accepted.
- **Resource check:** under normal load (fake sensor running, a page open in the browser):

  ```bash
  scripts/resource-check.sh
  ```

  Prints each container's memory against its limit (flagging anything above 80 %), plus `free -h` and disk use. If a container is near its limit, raise it only within the budget in `docs/01-architecture.md`.

## 9. Coexisting with the FastAPI project

- Don't publish host port 8000. Don't touch its systemd service or Python environment.
- Optional: publish it through the same tunnel on another hostname (`api.deyan.uk` → `http://host.docker.internal:8000`, with `extra_hosts: ["host.docker.internal:host-gateway"]` on `cloudflared`).
