import { mqttReadingsCollector } from '../../mqtt-readings.js';
import { handleDeviceList } from './new-devices.js';

/**
 * The Pi's Wi-Fi link, latency/loss, device counts and channel scans, measured by the
 * netprobe container (host network) and published on home/net/wifi (docs/03 § wifi).
 * Its device list drives the new-device alert (docs/10 §5). Parsers and fixtures: src/netprobe/.
 */
export const wifi = mqttReadingsCollector('wifi', async (message, ctx) => {
  await handleDeviceList(message.devices, ctx.db, ctx.log);
});
