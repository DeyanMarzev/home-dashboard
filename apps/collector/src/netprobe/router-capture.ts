/**
 * Prints the router's device list and connection details (see ACTIONS) with MAC addresses
 * (as stable placeholders), IPs, names and serial numbers redacted (../tools/redact.ts), to
 * confirm the JNAP format and make a parser fixture. On the Pi:
 *   docker compose exec netprobe node dist/netprobe/router-capture.js > devices.json
 */
import { redactor } from '../tools/redact.js';
import { jnap } from './router.js';

const password = process.env.ROUTER_PASSWORD;
const base = process.env.ROUTER_URL || 'http://192.168.1.1';
if (!password)
  throw new Error('Set ROUTER_PASSWORD (and ROUTER_URL if the router is not 192.168.1.1)');

// The device list, plus the actions community clients use for per-device signal and link
// speed (the router's own clients, and every mesh node's Wi-Fi clients) and the mesh backhaul.
// Not officially documented: each is tried on its own, and a failure is recorded, not fatal.
const ACTIONS = [
  'devicelist/GetDevices3',
  'networkconnections/GetNetworkConnections2',
  'networkconnections/GetNetworkConnections',
  'nodes/networkconnections/GetNodesWirelessNetworkConnections2',
  'nodes/diagnostics/GetBackhaulInfo2',
  // The MX4200 answered _ErrorUnknownAction to the two above (2026-11-09); older names:
  'nodes/networkconnections/GetNodesWirelessNetworkConnections',
  'nodes/diagnostics/GetBackhaulInfo',
];
const captured: Record<string, unknown> = {};
for (const action of ACTIONS) {
  try {
    captured[action] = await jnap(base, password, action, AbortSignal.timeout(30_000));
  } catch (err) {
    captured[action] = { error: err instanceof Error ? err.message : String(err) };
  }
}
// One redactor for everything, so a MAC or id maps to the same placeholder in every action.
console.log(
  JSON.stringify(
    captured,
    redactor({ nameKeys: ['friendlyName', 'value', 'hostName'], nameLabel: 'device' }),
    2,
  ),
);
