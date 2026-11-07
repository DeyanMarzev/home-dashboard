# 08 · Open questions

Not decided yet. Claude Code: when you reach a milestone that depends on one of these, build the interface and a fake, then ask the owner. Record the answer here and remove the question.

| # | Question | Blocks | Notes |
|---|---|---|---|
| 1 | What are the existing room sensors (model/firmware), and how do they send data today? Can they publish MQTT? | M3 real data | The MQTT topic contract is in `docs/03`. If they can't publish MQTT, add a bridge collector for whatever they do support. |
| 2 | Which rooms have which sensors? Does any room have more than temperature/humidity? | M3, M5 | Mockup assumes living room, kitchen, bedroom with temp/humidity/CO₂/pressure, plus the Nest in the hallway. |
| 3 | Where will smart meter data come from (energy supplier API, Hildebrand Glowmarkt/Bright, n3rgy, other)? Owner has said it arrives 1 day late. Gas assumed the same. | M7 real data | Built (M7) with a `fake` provider: adding the real one is one file in `apps/collector/src/sources/smart_meters/providers/` (docs/03). |
| 4 | Energy tariff: unit rates and standing charges for electricity and gas; fixed or time-of-use? | M7 costs | Fixed rates can already be entered on the Energy page (Tariff → Edit rates). If time-of-use, `tariffs` needs time bands. |
| 5 | Home location for weather and carbon intensity (`HOME_LAT`, `HOME_LON`, postcode outcode). | M3 | Ask the owner to fill `.env`; don't hardcode. |
| 6 | Router make/model. Does it have an API for connected devices and signal strength? | M9 | Without one, device count comes from ARP scanning and signal per device isn't available. |
| 7 | Smart plugs: brand and which appliances? | Later | Shelly and Tapo have local APIs. |
| 8 | Boiler probes: fitted yet? 1-Wire IDs for flow and return? | M6 | Collector must run fine with no probes. |
| 10 | Off-Pi backup destination (Google Drive, OneDrive, Backblaze B2, NAS)? | M10 | Via `rclone`. |
| 11 | Water: is there a water tariff to show cost, or volume only? | M8 | Mockup shows volume only. |
| 12 | Build images in CI (GitHub Actions, `linux/arm64`) or keep building on the Pi? | M10 | Building on the Pi works but is slow. |

## Decided

| # | Question | Answer (date) |
|---|---|---|
| 12a | Git hosting | GitHub. A public repo is fine; secrets stay in `.env` (git-ignored) and never enter the repo (2026-11-07). |
| 9 | Cloudflare Access allowed emails | `deyanmarzev@gmail.com` (2026-11-07). |
