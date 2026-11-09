# 05 · Frontend

React + Vite + TypeScript, TanStack Query for data, React Router for pages, Apache ECharts for charts. Served by the API at `https://home.deyan.uk`. Later wrapped by Capacitor for Android, so: no browser-only APIs without a fallback, all URLs relative or from config, layouts must work at phone width (360–412 px).

The approved design is the HTML mockup in `docs/mockup/mockup/` (seven pages: `01-overview.html` … `07-system.html`, all sample data). Open them in a browser; spacing and colours are exact in their inline styles. The rules below capture it.

## Design tokens

```css
:root {
  --bg: #F3F4F1;          /* page */
  --surface: #FFFFFF;     /* cards */
  --surface-muted: #F6F7F4;
  --border: #E1E4DE;
  --border-strong: #CDD1CA;
  --grid: #ECEEE9;        /* chart gridlines */
  --text: #1B1F1D;
  --text-secondary: #3F4A44;
  --text-muted: #5A615C;  /* labels; passes 4.5:1 on white */

  --accent: #0F766E;      /* active controls, water, links */
  --heat: #C2410C;        /* indoor temp, gas, heating, boiler flow */
  --cool: #2563EB;        /* outdoor temp, electricity, boiler return */
  --good: #15803D;
  --warn: #B45309;
  --warn-text: #9A3412;
  --warn-bg: #FFF3EA;  --warn-border: #F5CDAF;

  /* freshness badges */
  --live-bg: #E3F2E7;    --live-text: #14532D;    --live-dot: #15803D;
  --delayed-bg: #FDF0E1; --delayed-text: #7C2D12;
  --late-bg: #FDE8E8;    --late-text: #991B1B;    --late-dot: #DC2626;

  --radius-card: 14px;
  --radius-control: 9px;
}
```

- Fonts: **Space Grotesk** (headings and big numbers, 500–700) and **Inter** (everything else, 400–600). Self-host the font files (no Google Fonts request at runtime, works offline in the Android app).
- Big numbers 34 px, card titles 18 px, labels 13 px, captions 12 px. Units are smaller and muted next to the number (`20.4°C`).
- Cards: white, 1 px border, 14 px radius, 16–20 px padding, 14 px gaps. No shadows, gradients or coloured left borders.
- Layout: max width 1360 px, 24 px side padding (16 px on phones). Rows are `flex-wrap` with `flex-basis` so cards stack on narrow screens. Wide tables scroll horizontally inside their card.
- Accessibility: real `<button>`/`<a>` elements, 44 px touch targets, charts have `aria-label` summaries, status is never shown by colour alone (dot + text, or icon + text).
- Dark mode: not in v1. Keep all colours as CSS variables so it can be added.

## Shared components

- **`FreshnessBadge`**: props `freshness`, `compact?`. Renders from `freshness.state` and `freshness.label` only.
  - live: green pill, 6 px dot, "Live".
  - delayed: amber pill, clock icon, label (compact: "1 day behind").
  - late: red pill, alert icon, "No data since 13:10".
  - Re-computes every 60 s client-side with the shared `freshness()` so a badge turns Late without a refetch.
- **`StatTile`**: label + badge row, big value + unit, one-line context. Optional status dot + text.
- **`Panel`**: card with title, badge next to the title, optional right-aligned meta text, body.
- **`TimeRangePills`**: 24h / 7d / 30d (page-specific options).
- **Charts** (ECharts wrappers, all themed from the tokens): `LineChart` (multi-series, optional dashed reference line, optional shaded bands e.g. "boiler firing"), `BarChart` (single or stacked, optional dashed average/baseline line, value labels on top for ≤ 14 bars), `ScatterChart` (with trend line), `Sparkline` (240×56, optional threshold line), `HBarList` (label, value, % bar).
- **`AlertStrip`**: amber (warning) or neutral (info) row from `events`.
- **`DataTable`**: simple table with status cells.

## Pages

Top bar on every page: page title, subtitle (date, "updated HH:mm"), section tabs (Overview, Rooms, Energy, Heating, Water, Wi-Fi, System), time range pills. On phones the tabs wrap; later they become a bottom nav in the Android app.

Freshness placement: on pages that mix sources, every tile and panel has its own badge. On pages where everything has the same freshness, a single badge in the page subtitle ("Whole page live" / "Whole page: data to 3 Nov · 3 days behind"). Overview and Energy show a one-line key under the header explaining Live vs Delayed.

1. **Overview**: alerts strip; tiles: indoor temp (+ Nest target), outdoor, avg humidity (+ dew point / mould risk), CO₂, energy for the latest complete day, water for the latest day; 24 h temperature chart (indoor, outdoor, Nest target dashed, boiler-firing bands); heating card (flow/return, condensing, minutes on, cycles); room cards; electricity for the latest day by hour with baseload line; gas last 7 days; grid carbon now + greenest window; water last 7 days + leak check; Pi health card; data sources table (from `/api/sources`).
2. **Rooms**: warmest / coolest / highest CO₂ / pressure trend tiles; one card per room (temp, humidity, CO₂, dew point, temperature and CO₂ sparklines with 1000 ppm line, one-line advice); 24 h comparison table (range, avg humidity, CO₂ peak, time above 1000 ppm, mould risk).
3. **Energy**: tiles (latest day cost, month to date + projection, electricity and gas for the last 7 days with % change); stacked daily cost (electricity + gas, 14 days); where electricity went (smart plugs vs unmonitored); baseload (W, £/year); carbon for the period; tariff table with edit.
4. **Heating**: tiles (hallway now / target / mode, boiler state, minutes on today, condensing %); today's schedule bar with "now" marker; flow/return 24 h with 55 °C line; "worth trying" tips (rule-based); boiler minutes per day (7 days); gas vs outdoor temperature scatter with trend.
5. **Water**: delayed banner; tiles (latest day, 7-day average, 28-day total + meter reading, leak check); hour-by-hour for the latest day; 28 days with average line; night-time leak check table.
6. **Wi-Fi**: device count + band split; quality summary; latency + loss; speed; devices over 24 h; signal by room (from sensors' RSSI); device list (weakest first, unknown devices highlighted); channel congestion; download speed 7 days.
7. **System**: CPU temp (24 h chart with 80 °C line), throttle flags, disk + growth + projection, memory, load, uptime; collectors table (from `/api/sources`); storage and backups; API stats; recent events.

Derived numbers shown in the UI (dew point, mould risk, costs, projections, baseload, condensing %) are computed in `packages/shared` or the API, with unit tests, never ad hoc in components.

## Data loading

- One TanStack Query hook per endpoint (`useLatest`, `useReadings`, `useSources`, ...).
- SSE client updates the query cache for live series; polling fallback every 60 s.
- Skeleton states while loading; a Late badge (not an empty chart) when a series has no recent data; a clear empty state when a source has never reported.

## Implementation notes (M5)

- **Where things are:** `apps/web/src/styles.css` (tokens and component classes, values from the mockup), `components/` (`FreshnessBadge`, `StatTile`/`Panel`/`ProgressBar` in `Cards.tsx`, `PageHeader`, `AlertStrip`, `Status`, charts in `components/charts/`), `pages/` (Overview, Rooms, System; Energy, Heating, Water and Wi-Fi show which sources they wait for), `api/` (fetch client, one hook per endpoint, SSE provider), `model/` (pure view models, unit-tested).
- **Fonts:** Inter and Space Grotesk variable fonts are bundled from `@fontsource-variable/*` (no requests to Google; works offline in the Android app).
- **Freshness on screen:** every badge is `retick(freshness, policy, now)` from `packages/shared`, using the source's `policy` from `/api/sources` and one shared clock that ticks every 30 s (`lib/now.tsx`). A badge therefore turns Late on its own, with no refetch. Panels built from several series combine them (worst wins). Sources disabled in the registry show "Not connected" instead.
- **Live data:** `api/live.tsx` opens `/api/stream`; `reading` events patch cached `/api/latest` responses, `freshness` events patch `/api/sources`, `event` events refetch events. While the stream is down, latest values poll every 60 s (every 5 min as a safety net otherwise). Charts refetch every 5 minutes.
- **Expired Cloudflare session:** requests use `redirect: 'manual'`; Access's login redirect shows a banner asking to reload, instead of failing silently.
- **Derived numbers** (`packages/shared`, tested): `dewPoint` (Magnus), `mouldRisk` (high: avg RH ≥ 70 % or coldest temperature < 3 °C above the dew point; watch: ≥ 60 % or < 5 °C), `co2Level` (< 800 good, < 1,000 fair, < 1,500 high, else very high), `pressureTrend` (±1.5 hPa over 3 h), `roomAdvice`, `decodeThrottle`/`piStatus`, `daysUntilFull`, `lowestWindow` (greenest 4 h), `describeWeather` (WMO codes). Thresholds are rules of thumb; tune them there.
- **Time range pills** live in the URL (`?range=7d`), so a reload or a shared link keeps them.
- **Bundle:** about 1 MB of JavaScript (330 KB gzipped), mostly ECharts. Fine for the Pi and the phone; code-split the charts later if first load ever feels slow.
- **Heating page (M6):** tiles, today's *observed* target temperatures (SDM exposes no schedule, so the rest of the day shows "Not known yet" and there's no "next change"), flow/return with the 55 °C line, rule-based tips and 7-day runtime from `/api/summary/heating`; the gas-vs-outdoor scatter waits for smart meter data (M7). The Overview's temperature chart draws boiler-firing bands from `hvac_heating` with the same `stateRuns` the API uses.
- **Energy page (M7):** tiles (latest day incl. standing charges, month to date and projection, electricity and gas for the last 7 days with change on the week before), daily cost stacked by fuel (excl. standing charges, as the mockup), baseload, carbon, and the tariff table with an editor (`components/TariffPanel.tsx`; validated with `TariffsPutSchema` before saving). "Where the electricity went" waits for smart plugs (question 7). The Overview's energy tile, hourly electricity (baseload dashed) and 7-day gas panels, and the Heating page's gas-vs-outdoor scatter (with a least-squares trend) use the same summary.
- **Water page (M8):** a banner explaining the delay (from the source's expected delay and last successful run), tiles (latest day with peak hour and cost, 7-day average and change, 28-day total with cost and meter reading, leak check), hour by hour for the latest day, 28 days with the average dashed, and the last 5 nights of the leak check. The Overview's water tile and 7-day panel use the same summary.
- **Wi-Fi page (M9):** tiles (devices with Wi-Fi/wired split and peak, overall Wi-Fi quality from every measured radio, latency and loss, broadband speed), devices over the range, signal by room (room sensors + the Pi; bands from `signalQuality` in `packages/shared`), channels and neighbours per band, 7 days of download speed. A weak room (fair/poor) shows as an info alert. The per-device table (router only): connected devices from the newest netprobe round, weakest signal first, then the satellite's clients (band only), then wired; 8 shown with "Show all"; "Connected since" from `device_band` in 15-minute buckets over the last 2 days ("Over 2 days" beyond); the mesh backhaul as a line above (`model/wifi.ts`). The Overview's Pi card shows the Pi's Wi-Fi signal when known.
- **Local runs against PGlite:** set `DB_POOL_MAX=1` (see `.env.example`).
- **Not shown yet:** the System page's API request statistics (no data source; it shows status, version, database and live-update state instead), Wi-Fi signal on the Pi card (M9; shows the database size instead).
- **Checking layouts:** headless Edge or Chrome at 1440 px and 390 px. Windows won't size a browser window below about 500 px, so test phone width inside a 390 px iframe.

