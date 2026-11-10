import type { PublishedTariff } from '@home/db';

/**
 * Thames Water's metered water rates: a yearly "Scheme of Charges", the same for every
 * metered household in the region, published on a public help page (no login). Patterns as
 * in the MIT-licensed `thameswaterapi` client; a changed page fails loudly.
 */
export const TARIFF_URL =
  'https://www.thameswater.co.uk/help/account-and-billing/understand-your-bill/metered-customers';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function find(text: string, pattern: RegExp, what: string): string {
  const m = pattern.exec(text);
  if (!m?.[1]) throw new Error(`Thames Water's rates page changed: couldn't find ${what}`);
  return m[1];
}

/**
 * Clean water + wastewater per m³, and both yearly fixed charges as a daily standing charge,
 * in pence. `surfaceWaterRebate`: the lower wastewater fixed charge for homes whose roof
 * water doesn't drain to the public sewer.
 */
export function parseThamesTariff(
  html: string,
  options: { surfaceWaterRebate?: boolean } = {},
): Omit<PublishedTariff, 'publisher'> {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ');
  const pounds = (pattern: RegExp, what: string) => Number(find(text, pattern, what));
  const clean = pounds(/£(\d+\.\d+) per m3 for clean water/, 'the clean water rate');
  const waste = pounds(/£(\d+\.\d+) per m3 for wastewater/, 'the wastewater rate');
  const waterFixed = pounds(/Water £(\d+\.\d+) Not applicable/, 'the water fixed charge');
  const wasteFixed = options.surfaceWaterRebate
    ? pounds(/Wastewater £\d+\.\d+ £(\d+\.\d+)/, 'the wastewater fixed charge with rebate')
    : pounds(/Wastewater £(\d+\.\d+) £/, 'the wastewater fixed charge');
  const [day, month, year] = find(
    text,
    /for wastewater as of (\d{1,2} [A-Za-z]+ \d{4})/,
    'the date the rates took effect',
  ).split(' ');
  const m = MONTHS.indexOf(month!.toLowerCase());
  if (m < 0) throw new Error(`Thames Water's rates page changed: unknown month "${month}"`);
  return {
    fuel: 'water',
    unitRatePence: Math.round((clean + waste) * 100 * 1000) / 1000,
    standingPence: Math.round((((waterFixed + wasteFixed) * 100) / 365) * 1000) / 1000,
    validFrom: `${year}-${String(m + 1).padStart(2, '0')}-${day!.padStart(2, '0')}`,
  };
}
