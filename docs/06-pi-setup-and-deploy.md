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

1. Zero Trust → Networks → Tunnels → Create tunnel (cloudflared). Copy the token into `CLOUDFLARE_TUNNEL_TOKEN`.
2. In the tunnel, add a public hostname: `home.deyan.uk` → service `http://api:3000`.
3. Zero Trust → Access → Applications → Add self-hosted app for `home.deyan.uk`. Policy: allow the owner's email(s). Copy the **Application Audience (AUD) tag** into `CF_ACCESS_AUD` and the team name into `CF_ACCESS_TEAM`.
4. For the Android app later: Access → Service credentials → create a service token, and add a policy rule allowing it (Service Auth).

## 6. Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api collector
```

Migrations run automatically when `api` starts (single runner, advisory lock so only one instance migrates).

Check: `https://home.deyan.uk` asks for login, then shows the dashboard.

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
