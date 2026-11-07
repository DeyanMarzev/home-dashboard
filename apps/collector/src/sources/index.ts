import type { Collector } from '../collector.js';
import { boilerProbes } from './boiler_probes/index.js';
import { carbonIntensity } from './carbon_intensity/index.js';
import { nest } from './nest/index.js';
import { openMeteo } from './open_meteo/index.js';
import { piStats } from './pi_stats/index.js';
import { roomSensors } from './room_sensors/index.js';
import { smartMeters } from './smart_meters/index.js';

/** Every collector module. A source runs when it's here AND enabled in config/sources.yaml. */
export const collectors: readonly Collector[] = [
  roomSensors,
  piStats,
  openMeteo,
  carbonIntensity,
  nest,
  boilerProbes,
  smartMeters,
];
