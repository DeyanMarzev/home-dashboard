Outputs of `iw` (link, scan), `ping -q` (iputils), `arp-scan --plain --quiet` and `ip route` in
their exact formats, with addresses changed. Replace with captures from the Pi:
`docker compose exec netprobe iw dev wlan0 link` and so on.
