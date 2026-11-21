// Draws the app icons (docs/09 §1): a plain house in --accent on --bg, written as PNGs into
// public/icons. No image libraries: the shapes are rasterised here with 4×4 supersampling.
// Run after changing the shape or colours: `pnpm --filter @home/web icons`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
const ACCENT = [0x0f, 0x76, 0x6e];
const BG = [0xf3, 0xf4, 0xf1];
const WHITE = [0xff, 0xff, 0xff];

// The house in a unit box (0..1): outline, and the door cut out of it.
const HOUSE = [
  [0.5, 0.1],
  [0.94, 0.47],
  [0.82, 0.47],
  [0.82, 0.9],
  [0.18, 0.9],
  [0.18, 0.47],
  [0.06, 0.47],
];
const DOOR = [
  [0.41, 0.62],
  [0.59, 0.62],
  [0.59, 0.9],
  [0.41, 0.9],
];

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Inside a square of side 1 with corners rounded by r (0 = plain square). */
function inRoundedSquare(x, y, r) {
  if (r === 0) return true;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * size: pixels; glyph: share of the side the house takes; bg: background colour or null for
 * transparent; fg: house colour; corner: background corner radius as a share of the side.
 */
function draw({ size, glyph, bg, fg, corner = 0 }) {
  const S = 4;
  const px = new Uint8Array(size * size * 4);
  const off = (1 - glyph) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let back = 0;
      let house = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (bg && inRoundedSquare(u, v, corner)) back++;
          const gu = (u - off) / glyph;
          const gv = (v - off) / glyph;
          if (inside(HOUSE, gu, gv) && !inside(DOOR, gu, gv)) house++;
        }
      }
      const n = S * S;
      const a = house / n;
      const b = bg ? back / n : 0;
      const alpha = a + b * (1 - a);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const value = alpha === 0 ? 0 : (fg[c] * a + (bg ? bg[c] : 0) * b * (1 - a)) / alpha;
        px[i + c] = Math.round(value);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const svgPoints = (poly) => poly.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

mkdirSync(OUT, { recursive: true });
const icons = {
  'icon-192.png': draw({ size: 192, glyph: 0.62, bg: BG, fg: ACCENT, corner: 0.22 }),
  'icon-512.png': draw({ size: 512, glyph: 0.62, bg: BG, fg: ACCENT, corner: 0.22 }),
  // Maskable: full bleed, the house inside the central 80 % circle launchers keep.
  'icon-maskable-512.png': draw({ size: 512, glyph: 0.5, bg: BG, fg: ACCENT }),
  // Android status bar: only the alpha channel is used.
  'badge-96.png': draw({ size: 96, glyph: 0.86, bg: null, fg: WHITE }),
  'apple-touch-icon.png': draw({ size: 180, glyph: 0.62, bg: BG, fg: ACCENT }),
};
for (const [name, data] of Object.entries(icons)) writeFileSync(new URL(name, OUT), data);
writeFileSync(
  new URL('icon.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" rx="22" fill="${hex(BG)}"/>` +
    `<g transform="translate(19 19) scale(0.62)"><path fill="${hex(ACCENT)}" fill-rule="evenodd" ` +
    `d="M${svgPoints(HOUSE)}Z M${svgPoints(DOOR)}Z"/></g></svg>\n`,
);
console.log(`Wrote ${Object.keys(icons).length + 1} icons to ${OUT.pathname}`);
