/**
 * Prints the router's device list (devicelist/GetDevices3) with MAC addresses, IPs (v4 and v6),
 * names and serial numbers redacted (../tools/redact.ts), to confirm the JNAP format and make a parser fixture. On the Pi:
 *   docker compose exec netprobe node dist/netprobe/router-capture.js > devices.json
 */
import { redactor } from '../tools/redact.js';
import { jnap } from './router.js';

const password = process.env.ROUTER_PASSWORD;
const base = process.env.ROUTER_URL || 'http://192.168.1.1';
if (!password)
  throw new Error('Set ROUTER_PASSWORD (and ROUTER_URL if the router is not 192.168.1.1)');

const output = await jnap(base, password, 'devicelist/GetDevices3', AbortSignal.timeout(30_000));
console.log(
  JSON.stringify(
    output,
    redactor({ nameKeys: ['friendlyName', 'value', 'hostName'], nameLabel: 'device' }),
    2,
  ),
);
