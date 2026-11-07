#!/usr/bin/env bash
# Nightly database backup (docs/06 § Backups). Run on the Pi from the repo directory or cron:
#   scripts/backup.sh
# 1. pg_dump -Fc inside the postgres container → $DATA_DIR/backups/home-YYYY-MM-DD.dump
# 2. checks the dump is readable (pg_restore --list), keeps the newest 7
# 3. copies it off the Pi with rclone if BACKUP_RCLONE_REMOTE is set (e.g. gdrive:home-dashboard-backups),
#    keeping 30 days there
# 4. records a `backup` event (shown on the System page), or a warning event if anything failed
set -euo pipefail
source "$(dirname "$0")/lib.sh"

KEEP_LOCAL=7
KEEP_REMOTE_DAYS=30
REMOTE="$(env_get BACKUP_RCLONE_REMOTE)"
STAMP="$(TZ=Europe/London date +%F)"
FILE="$BACKUP_DIR/home-$STAMP.dump"
STEP="start"

fail() {
  log "backup FAILED at: $STEP"
  record_event warning "Backup failed: $STEP" "{\"step\": \"$STEP\"}"
  rm -f "$FILE.partial"
  exit 1
}
trap fail ERR

mkdir -p "$BACKUP_DIR"
STEP="pg_dump"
log "dumping $PG_DB to $FILE"
docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc >"$FILE.partial"
mv "$FILE.partial" "$FILE"

STEP="verify"
docker compose exec -T postgres pg_restore --list <"$FILE" >/dev/null
BYTES="$(stat -c %s "$FILE")"
SIZE="$(numfmt --to=iec --suffix=B "$BYTES")"
log "dump ok: $SIZE"

STEP="prune local"
ls -1t "$BACKUP_DIR"/home-*.dump 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f --

OFFSITE=false
if [ -n "$REMOTE" ]; then
  STEP="copy to $REMOTE"
  command -v rclone >/dev/null || { log "rclone is not installed (docs/06 § Backups)"; false; }
  rclone copy "$FILE" "$REMOTE" --quiet
  rclone delete "$REMOTE" --min-age "${KEEP_REMOTE_DAYS}d" --include 'home-*.dump' --quiet
  OFFSITE=true
  log "copied to $REMOTE"
fi

trap - ERR
WHERE=$([ "$OFFSITE" = true ] && echo " · copied to $REMOTE" || echo " · on the Pi only")
record_event info "Backup finished · $SIZE$WHERE" "{\"file\": \"$(basename "$FILE")\", \"bytes\": $BYTES, \"offsite\": $OFFSITE, \"keptLocal\": $KEEP_LOCAL, \"keptRemoteDays\": $KEEP_REMOTE_DAYS}"
log "done"
