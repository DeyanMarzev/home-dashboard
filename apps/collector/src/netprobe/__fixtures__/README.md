Outputs of `iw` (link, scan), `ping -q` (iputils), `arp-scan --plain --quiet` and `ip route` in
their exact formats, with addresses changed. Replace with captures from the Pi:
`docker compose exec netprobe iw dev wlan0 link` and so on.

`arp-scan-vendors.txt`: `arp-scan --localnet --plain` without `--quiet` (the third column is the
maker from arp-scan's bundled IEEE list), in its documented format with invented addresses: a
duplicate answer ("(DUP: 2)"), a phone's private address ("(Unknown: locally administered)") and an
unknown maker. Replace with `docker compose exec netprobe arp-scan --localnet --plain` from the Pi.
