/**
 * Prints the current SDM devices.list response with ids and names redacted, for a parser
 * fixture (src/sources/nest/__fixtures__). Run on the Pi:
 *   docker compose exec collector node dist/tools/nest-capture.js > devices.json
 */
import { loadCollectorEnv } from '../env.js';
import { fetchDevices } from '../sources/nest/index.js';

const env = loadCollectorEnv(process.env);
const body = await fetchDevices({ env, signal: AbortSignal.timeout(30_000) });
const redacted = JSON.stringify(
  body,
  (key, value: unknown) => {
    if (typeof value !== 'string') return value;
    if (key === 'name' || key === 'assignee' || key === 'parent')
      return value.replace(/\/[^/]+/g, '/REDACTED');
    if (key === 'customName') return '';
    return value;
  },
  2,
);
console.log(redacted);
