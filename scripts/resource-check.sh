#!/usr/bin/env bash
# Memory and CPU of each container against its limit (CLAUDE.md rule 8: limits are hard).
# Run under normal load (e.g. with the fake sensor running and a page open):
#   scripts/resource-check.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"
echo "Container            Memory used / limit      %     CPU"
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}' | sort | while IFS=$'\t' read -r name mem pct cpu; do
  flag=""
  [ "${pct%\%}" != "${pct}" ] && awk -v p="${pct%\%}" 'BEGIN { exit !(p > 80) }' && flag="  <- above 80 % of its limit"
  printf '%-20s %-24s %-6s %s%s\n' "$name" "$mem" "$pct" "$cpu" "$flag"
done
echo
free -h | sed -n '1,2p'
df -h / "$DATA_DIR" 2>/dev/null | sed '1!{/^Filesystem/d}'
docker info 2>&1 | grep -qi 'no memory limit support' && echo "WARNING: memory limits are NOT enforced (docs/06 § 2: enable the memory cgroup)" || true
