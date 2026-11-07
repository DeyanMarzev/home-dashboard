# Shared helpers for the host scripts. Source it; don't run it.
# Reads single values from .env without executing it (passwords may contain $ or quotes).

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

env_get() {
  # env_get KEY [default]: the value after KEY= on its line, inline "# comment" removed.
  local line
  line="$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  printf '%s' "${line:-${2:-}}"
}

log() { printf '%s %s\n' "$(TZ=Europe/London date '+%Y-%m-%d %H:%M:%S')" "$*"; }

PG_USER="$(env_get POSTGRES_USER home)"
PG_DB="$(env_get POSTGRES_DB home)"
DATA_DIR="$(env_get DATA_DIR /mnt/ssd/home-dashboard)"
BACKUP_DIR="$DATA_DIR/backups"

psql_exec() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "${2:-$PG_DB}" -qAt -c "$1"; }

# Records a backup event for the System page (docs/06 § Backups). Never fails the caller.
record_event() {
  local level="$1" message="$2" data="$3"
  local sql
  sql="insert into events (level, kind, message, data) values ('$level', 'backup', \$m\$$message\$m\$, \$d\$$data\$d\$::jsonb)"
  psql_exec "$sql" >/dev/null 2>&1 || log "warning: could not record the backup event"
}
