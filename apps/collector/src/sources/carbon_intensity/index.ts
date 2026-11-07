import type { PullCollector } from '../../collector.js';
import { requireSetting } from '../../env.js';
import { fetchJson } from '../../http.js';
import { parseCurrent, parseForecast } from './parse.js';

const BASE_URL = 'https://api.carbonintensity.org.uk';

/** NESO Carbon Intensity API, regional by postcode outcode. No API key. */
export const carbonIntensity: PullCollector = {
  id: 'carbon_intensity',
  kind: 'pull',
  async run(ctx) {
    const outcode = encodeURIComponent(
      requireSetting(ctx.env.HOME_POSTCODE_OUTCODE, 'HOME_POSTCODE_OUTCODE'),
    );
    // "2026-11-07T12:34Z": the API takes minute precision.
    const from = new Date().toISOString().slice(0, 16) + 'Z';
    const [current, forecast] = await Promise.all([
      fetchJson(new URL(`/regional/postcode/${outcode}`, BASE_URL), ctx.signal),
      fetchJson(
        new URL(`/regional/intensity/${from}/fw48h/postcode/${outcode}`, BASE_URL),
        ctx.signal,
      ),
    ]);
    await ctx.writeReadings([...parseCurrent(current), ...parseForecast(forecast)]);
  },
};
