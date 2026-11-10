Thames Water account site responses (`/ajax/waterMeter/getMeters` and
`getSmartWaterMeterConsumptions` with `granularity=H`), in the format of the MIT-licensed
`thameswaterapi` client's tests (github.com/jelmer/thameswaterapi). Values are invented:
`thames-hourly.json` is 3–4 Nov 2026, litres per hour with the meter total (litres) after each
hour.

Replace with a capture from the owner's account once the Pi has Thames Water credentials:
`docker compose exec collector node dist/tools/thames-capture.js` (redacted).
