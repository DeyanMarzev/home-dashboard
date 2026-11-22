// The app icons (docs/09 §1): the "Gauge" house, rendered from the SVG masters in
// ../icon-source/ into public/icons. Run after changing a master: `pnpm --filter @home/web icons`.
// The PNGs are committed; @resvg/resvg-js is only needed to regenerate them.
//
// Masters, on a 108-unit grid (the Android adaptive-icon grid, content inside the middle 66):
//   icon-full-108.svg    background + artwork, full bleed
//   icon-visible-72.svg  the same, cropped to the visible 72 units
//   icon-monochrome.svg  single-colour outline, for the notification badge
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SOURCE = new URL('../icon-source/', import.meta.url);
const OUT = new URL('../public/icons/', import.meta.url);

const master = (name) => readFileSync(new URL(`${name}.svg`, SOURCE), 'utf8');
/** The drawing inside a master's <svg> element. */
const inner = (svg) =>
  svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

const art = inner(master('icon-full-108'));
const mono = inner(master('icon-monochrome'));

const variants = {
  // Install prompts, desktop and browser tab: the visible area with rounded corners.
  rounded: svg(
    '18 18 72 72',
    `<clipPath id="r"><rect x="18" y="18" width="72" height="72" rx="16"/></clipPath>` +
      `<g clip-path="url(#r)">${art}</g>`,
  ),
  // iOS rounds its own corners.
  square: svg('18 18 72 72', art),
  // Android crops maskable icons to its launcher shape; the artwork already sits inside the
  // middle 80 % circle that every shape keeps.
  maskable: svg('0 0 108 108', art),
  // Notification badge: Android uses only its alpha, at 24 dp, so white on transparent and
  // cropped to the house so the lines stay thick enough.
  badge: svg('24 24 60 60', mono.replaceAll('#000', '#fff')),
};

const png = (text, size) =>
  new Resvg(text, { fitTo: { mode: 'width', value: size } }).render().asPng();

mkdirSync(OUT, { recursive: true });
const files = {
  'icon-192.png': png(variants.rounded, 192),
  'icon-512.png': png(variants.rounded, 512),
  'icon-maskable-512.png': png(variants.maskable, 512),
  'apple-touch-icon.png': png(variants.square, 180),
  'badge-96.png': png(variants.badge, 96),
  'icon.svg': variants.rounded,
};
for (const [name, data] of Object.entries(files)) writeFileSync(new URL(name, OUT), data);
console.log(`Wrote ${Object.keys(files).length} icons to ${OUT.pathname}`);
