`thames-hourly-recorded.json`: the hourly response (`getSmartWaterMeterConsumptions`,
`granularity=H`) recorded from the owner's account on 2026-11-10 with
`dist/tools/thames-capture.js`, redacted. The format is exactly as received: asked for
4–9 Nov, the site returned whole days 4–7 Nov (96 lines, about 3 days behind), whole litres,
`Read` = the meter total after each hour (previous `Read` + this hour's `Usage`), no
estimated hours and no padding. The litres are invented: real hourly use shows when the house
is occupied, and the repo is public.

`thames-meters.json` and `thames-hourly.json`: the format of the MIT-licensed `thameswaterapi`
client's tests (github.com/jelmer/thameswaterapi), values invented; used to replay the whole
sign-in and fetch flow in the tests.
