import { mqttReadingsCollector } from '../../mqtt-readings.js';

/**
 * The Pi's Wi-Fi link, latency/loss, device counts and channel scans, measured by the
 * netprobe container (host network) and published on home/net/wifi (docs/03 § wifi).
 * Parsers and fixtures: src/netprobe/.
 */
export const wifi = mqttReadingsCollector('wifi');
