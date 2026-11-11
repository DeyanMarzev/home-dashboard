import type { PullCollector } from '../../collector.js';
import { requireSetting } from '../../env.js';
import { fetchJson } from '../../http.js';
import { AIR_QUALITY_QUERY, parseAirQuality } from './parse.js';

const BASE_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/** Outdoor air quality (UK DAQI) from Open-Meteo's CAMS model. No API key. */
export const airQuality: PullCollector = {
  id: 'air_quality',
  kind: 'pull',
  async run(ctx) {
    const url = new URL(BASE_URL);
    url.search = new URLSearchParams({
      latitude: String(requireSetting(ctx.env.HOME_LAT, 'HOME_LAT')),
      longitude: String(requireSetting(ctx.env.HOME_LON, 'HOME_LON')),
      ...AIR_QUALITY_QUERY,
    }).toString();
    await ctx.writeReadings(parseAirQuality(await fetchJson(url, ctx.signal)));
  },
};
