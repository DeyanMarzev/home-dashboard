import type { PullCollector } from '../../collector.js';
import { requireSetting } from '../../env.js';
import { fetchJson } from '../../http.js';
import { OPEN_METEO_QUERY, parseOpenMeteo } from './parse.js';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

/** Current outdoor weather + 24 h temperature forecast. No API key. */
export const openMeteo: PullCollector = {
  id: 'open_meteo',
  kind: 'pull',
  async run(ctx) {
    const lat = requireSetting(ctx.env.HOME_LAT, 'HOME_LAT');
    const lon = requireSetting(ctx.env.HOME_LON, 'HOME_LON');
    const url = new URL(BASE_URL);
    url.search = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      ...OPEN_METEO_QUERY,
    }).toString();
    await ctx.writeReadings(parseOpenMeteo(await fetchJson(url, ctx.signal)));
  },
};
