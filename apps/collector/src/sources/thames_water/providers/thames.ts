import type { WaterProvider } from './types.js';

/**
 * The real Thames Water account scraper. Not built yet: it needs a sample of the account
 * site's own usage data (and its login flow) from the owner's account. See docs/08.
 * When built: log in once per run, fetch hourly usage for [from, to), parse strictly (a
 * changed site must fail loudly, not store nonsense), and never log credentials or responses.
 */
export const thamesProvider: WaterProvider = {
  id: 'thames',
  fetch() {
    return Promise.reject(
      new Error(
        'The Thames Water provider isn’t built yet: it needs a sample of the account data (docs/08). Use WATER_PROVIDER=fake meanwhile.',
      ),
    );
  },
};
