#!/usr/bin/env bash
# Restore a backup (docs/06 § Backups).
#   scripts/restore.sh --test [file]     restore into a scratch database, compare row counts
#                                        with the live one, then drop it (safe; do this monthly)
#   scripts/restore.sh --replace <file>  replace the live database (stops api and collector)
# [file] defaults to the newest $DATA_DIR/backups/home-*.dump.
# TimescaleDB needs timescaledb_pre_restore()/post_restore() around pg_restore.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

MODE="${1:-}"
FILE="${2:-$(ls -1t "$BACKUP_DIR"/home-*.dump 2>/dev/null | head -n 1 || true)}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "No backup file found (looked in $BACKUP_DIR)"; exit 1; }

restore_into() {
  local db="$1"
  psql_exec "create database $db" postgres
  psql_exec "create extension if not exists timescaledb; select timescaledb_pre_restore();" "$db" >/dev/null
  # Warnings about circular foreign keys between Timescale catalog tables are expected;
  # anything else is a real problem, which the row counts will show.
  if ! docker compose exec -T postgres pg_restore -U "$PG_USER" -d "$db" --no-owner <"$FILE"; then
    log "pg_restore reported problems (above): check the row counts before trusting this restore"
  fi
  psql_exec "select timescaledb_post_restore();" "$db" >/dev/null
}

counts() {
  psql_exec "select 'readings', count(*) from readings union all select 'series', count(*) from series
             union all select 'events', count(*) from events union all select 'sources', count(*) from sources
             union all select 'tariffs', count(*) from tariffs" "$1" | sort
}

case "$MODE" in
  --test)
    DB=home_restore_test
    log "test restore of $(basename "$FILE") into $DB"
    psql_exec "drop database if exists $DB with (force)" postgres
    restore_into "$DB"
    LIVE="$(counts "$PG_DB")"
    RESTORED="$(counts "$DB")"
    psql_exec "drop database $DB with (force)" postgres
    printf '\n%-10s %12s %12s\n' table live restored
    paste <(echo "$LIVE") <(echo "$RESTORED") | awk -F'[|\t]' '{ printf "%-10s %12s %12s\n", $1, $2, $4 }'
    echo
    echo "Restored counts can be lower than live ones: rows written since the backup aren't in it."
    log "test restore finished; scratch database dropped"
    ;;
  --replace)
    echo "This REPLACES the live database '$PG_DB' with $(basename "$FILE")."
    read -r -p "Type the database name to continue: " answer
    [ "$answer" = "$PG_DB" ] || { echo "Cancelled."; exit 1; }
    docker compose stop api collector
    psql_exec "drop database if exists ${PG_DB}_old with (force)" postgres
    psql_exec "alter database $PG_DB rename to ${PG_DB}_old" postgres
    restore_into "$PG_DB"
    docker compose start api collector
    log "restored. The previous database is kept as ${PG_DB}_old; drop it when happy:"
    log "  docker compose exec postgres psql -U $PG_USER -d postgres -c 'drop database ${PG_DB}_old'"
    ;;
  *)
    sed -n '2,8p' "$0"
    exit 1
    ;;
esac
