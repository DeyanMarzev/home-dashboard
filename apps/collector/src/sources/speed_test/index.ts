import { mqttReadingsCollector } from '../../mqtt-readings.js';

/** Daily broadband speed test run by netprobe, published on home/net/speed_test. */
export const speedTest = mqttReadingsCollector('speed_test');
