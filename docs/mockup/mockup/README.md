# Approved mockup

Static HTML of the approved "Home Dashboard Mockup" (seven pages). Open `01-overview.html` in a browser; the section tabs link between pages.

- This is the **visual reference** for `docs/05-frontend.md`: layout, spacing, colours, type sizes, chart styles, freshness badge placement.
- All numbers are **sample data**. Never copy values, dates or labels like "Live" / "3 days behind" into components; they come from the API and `packages/shared/freshness.ts`.
- Charts are hand-drawn SVG here. The real app uses Apache ECharts themed from the design tokens.
- Fonts load from Google Fonts in the mockup only; the app self-hosts Inter and Space Grotesk.
- If the mockup and `docs/05-frontend.md` disagree, the doc wins; ask the owner.

| File | Page |
|---|---|
| 01-overview.html | Overview |
| 02-rooms.html | Rooms |
| 03-energy.html | Energy |
| 04-heating.html | Heating |
| 05-water.html | Water |
| 06-wifi.html | Wi-Fi |
| 07-system.html | System |
