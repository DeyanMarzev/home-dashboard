Bright (Hildebrand Glowmarkt) responses in the format used by community clients (the
`glowmarkt` Rust crate, `pyglowmarkt`), ids redacted. The readings cover 5–6 Nov 2026 (UTC):
the 5th is complete; on the 6th only the first 20 half-hours have arrived and the rest are 0,
as Glowmarkt reports half-hours it hasn't received yet. Gas has one `null` half-hour.

Replace them with real captures once the Pi has Bright credentials:
`docker compose exec collector node dist/tools/bright-capture.js` prints the account's
resources and two days of readings with ids redacted.
