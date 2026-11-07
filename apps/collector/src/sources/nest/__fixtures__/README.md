These follow the documented SDM `devices.list` format (developers.google.com/nest/device-access,
"Thermostat" device guide) with ids redacted. Replace them with real captures once the Pi has
Nest credentials: `docker compose exec collector node dist/tools/nest-capture.js` prints the
current response with ids and names redacted.
