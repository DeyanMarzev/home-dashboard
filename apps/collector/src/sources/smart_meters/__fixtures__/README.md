Recorded from the owner's Bright account on 2026-11-08 at 19:30 London with
`dist/tools/bright-capture.js`, then passed through `src/tools/redact.ts` (ids replaced
with placeholders, the address and other personal fields removed).

Everything about the format is as Bright sent it: fields, resource classifiers and units,
timestamps (start of each half-hour, UTC), number precision, and the padding. Bright had
data up to 01:00 on 8 Nov and returned integer `0` for every half-hour after that, up to the
request's `to`.

The usage values themselves are invented (same precision, plausible shape): the repo is
public, and real half-hourly usage shows when the house is occupied. Gas zeros before 01:00
are invented "no heating" half-hours, as happen in real data.
