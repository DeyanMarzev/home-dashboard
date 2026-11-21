# 08 · Open questions

Not decided yet. Claude Code: when you reach a milestone that depends on one of these, build the interface and a fake, then ask the owner. Record the answer under "Decided" below and remove the question.

| # | Question | Blocks | Notes |
|---|---|---|---|
| 4 | Energy tariff: unit rates and standing charges for electricity and gas; fixed or time-of-use? | M7 costs | Fixed rates can already be entered on the Energy page (Tariff → Edit rates). If time-of-use, `tariffs` needs time bands. |
| 5 | Home location for weather and carbon intensity (`HOME_LAT`, `HOME_LON`, postcode outcode). | M3 | The owner lives in Walthamstow, London (outcode likely E17). Ask the owner to fill `.env`; don't hardcode. |
| 7 | Smart plugs: brand and which appliances? | Later | Shelly and Tapo have local APIs. |
| 8 | Boiler probes: fitted yet? 1-Wire IDs for flow and return? | M6 | Collector must run fine with no probes. |
| 9b | Who else should be allowed in through Cloudflare Access (emails), and which of them are admins (`ADMIN_EMAILS`)? | M11 | Multiple household members will use the app. Admins edit thresholds, tariffs and users; members manage their own notifications. Default: only the owner is admin. Ask when M11 gets there (owner, 21 Nov 2026). |
| 12 | Build images in CI (GitHub Actions, `linux/arm64`) or keep building on the Pi? | M10 | Building on the Pi works but is slow. |
| 13 | Are the default alert thresholds and defaults right? `docs/09` §3: CO₂ warning 1000 ppm / 15 min, urgent 1500 ppm / 10 min, clear 900; room cold 14 °C / 10 °C; humidity 70 % / 80 % off by default; Pi CPU 75 / 80 °C. `docs/10`: vacuum not charging (everyone), vacuum battery below 50 % for 6 h (everyone); weather warnings yellow and above (everyone, amber/red are urgent); new network device (admins only). | M11 | Build with these; the owner can change them later in Settings → Alert thresholds without a deploy. |
| 14 | Contact email for `VAPID_SUBJECT` (sent to push services, never shown to users). | M11 | Usually the owner's email. Ask when M11 gets there. |
| 15 | Does the owner want the external "Pi is down" check (healthchecks.io or similar), and how should it reach them (email, other)? | M11 step 6 | Optional; off when `HEALTHCHECK_PING_URL` is empty. Ask when M11 gets there. |
| 16 | How long should a Cloudflare Access sign-in last on phones before people have to log in again? | M11 | Set on the Access application (`docs/06` §5). Doesn't affect notification delivery. Ask when M11 gets there. |

## Decided

| # | Question | Answer (date) |
|---|---|---|
| 12a | Git hosting | GitHub. A public repo is fine; secrets stay in `.env` (git-ignored) and never enter the repo (2026-11-07). |
| 9 | Cloudflare Access allowed emails | `(owner email removed)` (2026-11-07). More people come with M11 (#9b). |
| 11 | Water: tariff or volume only? | Volume, and cost where possible: add a `water` rate (p/m³ + standing p/day) on the Water page's tariff editor; costs show wherever one applies (2026-11-07). |
| 6 | Router make/model | Linksys MX4200 (Velop mesh). Local JNAP API (`POST http://<router>/JNAP/`, admin password): used for device counts (2026-11-07). Not needed for new-device alerts, which use `arp-scan` (#19). |
| 3b | Bright data format | Confirmed with a capture from the owner's account: classifiers, kWh units and the zero padding for half-hours not yet received are as the provider assumes (2026-11-08). |
| 3 | Smart meter data source | Bright (Hildebrand Glowmarkt API) for electricity and gas. No solar export, no Glow in-home display (so no live feed) (2026-11-07). |
| 6b | Router device data | Captured from the MX4200 (2026-11-09): GetDevices3 + GetNetworkConnections2 give name, band, signal and link speed for the main router's clients; the satellite's clients only their band (the node actions aren't on this firmware). |
| 13a | Thames Water account data | Owner sees hourly use on the account site, 3 days behind (2026-11-10). Built by porting the `thameswaterapi` client's sign-in and endpoints (docs/03 § thames_water), confirmed with a capture from the owner's account the same day. |
| 1 | Room sensor hardware | ESP32 + BME280 + SenseAir S8 + TFT + Telegram bot; it had MQTT code but wasn't publishing. New firmware in `firmware/room-sensor/` publishes per the `docs/03` contract (2026-11-14). |
| 2 | Which rooms have sensors | The kitchen only for now (temperature, humidity, pressure, CO₂); the firmware takes the room and fitted sensors as settings, so more rooms are a copy and a rename (2026-11-14). |
| 10 | Off-Pi backup destination | Google Drive, via `rclone` with the `drive.file` scope (it only sees the files it uploads). Setup in `docs/06` § 8 (2026-11-07). |
| 17 | Robot vacuum make/model and how to reach it | Roborock S8, through the `roborock` helper container (python-roborock, read-only, one-time emailed-code sign-in). Built as source `roborock` (2026-11-15), battery and state added 2026-11-21 (`docs/03` § roborock). Only its notifications are still to come (M11, `docs/10` §3). |
| 18 | Met Office area for weather warnings | Walthamstow, London (London Borough of Waltham Forest). Region: London & South East England. Area filter: Waltham Forest (21 Nov 2026). Applied in `docs/10` §4. |
| 19 | New-device alerts: wired too? guests' phones? | Yes to both: alert for any new device on the network, wired or Wi-Fi, guests included. No wired devices are connected at the moment. The owner wants to know whenever a new device connects (21 Nov 2026). Applied in `docs/10` §5. |
| 20 | Phone app | An installed web app (PWA) with Web Push, not a Capacitor/Firebase Android app (21 Nov 2026). `docs/09`. |
| 21 | Vacuum on the Overview | No Overview tile: battery and state stay on the Misc page's Vacuum panel (21 Nov 2026). |
| 22 | Vacuum notifications | Notify for "not charging" (raised within an hour of the robot being found off its dock); keep "battery below 50 % for 6 h" as a backup (21 Nov 2026). `docs/10` §3. |
