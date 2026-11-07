#!/usr/bin/env bash
# Installs (or updates) the nightly backup in the current user's crontab: 03:00 Pi local time.
# Idempotent: run it again after moving the repo.
# Debian's cron ignores CRON_TZ, so 03:00 is in the Pi's own timezone: set it to Europe/London
# (docs/06 § Backups).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

TZ_NOW="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
if [ "$TZ_NOW" != "Europe/London" ]; then
  echo "warning: the Pi's timezone is $TZ_NOW, so the backup runs at 03:00 $TZ_NOW."
  echo "         To use UK time: sudo timedatectl set-timezone Europe/London"
fi

LOG="$BACKUP_DIR/backup.log"
LINE="0 3 * * * cd $REPO_DIR && scripts/backup.sh >> $LOG 2>&1; tail -n 2000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG"
mkdir -p "$BACKUP_DIR"
( crontab -l 2>/dev/null | grep -v 'scripts/backup.sh' || true ; echo "$LINE" ) | crontab -
echo "Installed:"
crontab -l | grep 'backup.sh'
