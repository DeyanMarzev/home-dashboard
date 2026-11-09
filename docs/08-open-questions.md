# 08 · Open questions

Not decided yet. Claude Code: when you reach a milestone that depends on one of these, build the interface and a fake, then ask the owner. Record the answer here and remove the question.

| # | Question | Blocks | Notes |
|---|---|---|---|
| 1 | What are the existing room sensors (model/firmware), and how do they send data today? Can they publish MQTT? | M3 real data | The MQTT topic contract is in `docs/03`. If they can't publish MQTT, add a bridge collector for whatever they do support. |
| 2 | Which rooms have which sensors? Does any room have more than temperature/humidity? | M3, M5 | Mockup assumes living room, kitchen, bedroom with temp/humidity/CO₂/pressure, plus the Nest in the hallway. |
| 4 | Energy tariff: unit rates and standing charges for electricity and gas; fixed or time-of-use? | M7 costs | Fixed rates can already be entered on the Energy page (Tariff → Edit rates). If time-of-use, `tariffs` needs time bands. |
| 5 | Home location for weather and carbon intensity (`HOME_LAT`, `HOME_LON`, postcode outcode). | M3 | Ask the owner to fill `.env`; don't hardcode. |
| 7 | Smart plugs: brand and which appliances? | Later | Shelly and Tapo have local APIs. |
| 8 | Boiler probes: fitted yet? 1-Wire IDs for flow and return? | M6 | Collector must run fine with no probes. |
| 13 | Thames Water account data: how does the account website load hourly usage (the request it makes and a sample response, personal details removed)? | M8 real data | The `thames` provider is a placeholder until then (`apps/collector/src/sources/thames_water/providers/thames.ts`); everything else runs on the `fake` provider. Easiest: browser dev tools → Network while opening the usage page. |
| 12 | Build images in CI (GitHub Actions, `linux/arm64`) or keep building on the Pi? | M10 | Building on the Pi works but is slow. |

## Decided

| # | Question | Answer (date) |
|---|---|---|
| 12a | Git hosting | GitHub. A public repo is fine; secrets stay in `.env` (git-ignored) and never enter the repo (2026-11-07). |
| 9 | Cloudflare Access allowed emails | `deyanmarzev@gmail.com` (2026-11-07). |
| 11 | Water: tariff or volume only? | Volume, and cost where possible: add a `water` rate (p/m³ + standing p/day) on the Energy page's tariff editor; costs show wherever one applies (2026-11-07). |
| 6 | Router make/model | Linksys MX4200 (Velop mesh). Local JNAP API (`POST http://<router>/JNAP/`, admin password): used for device counts (2026-11-07). |
| 3b | Bright data format | Confirmed with a capture from the owner's account: classifiers, kWh units and the zero padding for half-hours not yet received are as the provider assumes (2026-11-08). |
| 3 | Smart meter data source | Bright (Hildebrand Glowmarkt API) for electricity and gas. No solar export, no Glow in-home display (so no live feed) (2026-11-07). |
| 6b | Router device data | Captured from the MX4200 (2026-11-09): GetDevices3 + GetNetworkConnections2 give name, band, signal and link speed for the main router's clients; the satellite's clients only their band (the node actions aren't on this firmware). |
| 10 | Off-Pi backup destination | Google Drive, via `rclone` with the `drive.file` scope (it only sees the files it uploads). Setup in `docs/06` § 8 (2026-11-07). |
