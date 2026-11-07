/**
 * Prints the router's device list (devicelist/GetDevices3) with MAC addresses, IPs and names
 * redacted, to confirm the JNAP format and make a parser fixture. On the Pi:
 *   docker compose exec netprobe node dist/netprobe/router-capture.js > devices.json
 */
import { jnap } from './router.js';

const password = process.env.ROUTER_PASSWORD;
const base = process.env.ROUTER_URL || 'http://192.168.1.1';
if (!password)
  throw new Error('Set ROUTER_PASSWORD (and ROUTER_URL if the router is not 192.168.1.1)');

const output = await jnap(base, password, 'devicelist/GetDevices3', AbortSignal.timeout(30_000));
let n = 0;
const names = new Map<string, string>();
const redacted = JSON.stringify(
  output,
  (key, value: unknown) => {
    if (typeof value !== 'string') return value;
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value))
      return `00:00:00:00:00:${(++n % 256).toString(16).padStart(2, '0')}`;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return '192.168.1.x';
    if (['friendlyName', 'value', 'hostName'].includes(key)) {
      if (!names.has(value)) names.set(value, `device ${names.size + 1}`);
      return names.get(value);
    }
    return value;
  },
  2,
);
console.log(redacted);
