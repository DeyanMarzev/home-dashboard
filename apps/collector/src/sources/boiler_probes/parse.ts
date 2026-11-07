/**
 * DS18B20 readings from the Linux 1-Wire driver (docs/03 § boiler_probes). Newer kernels
 * expose `temperature` (millidegrees); older ones only `w1_slave`:
 *   "72 01 4b 46 7f ff 0e 10 57 : crc=57 YES\n72 01 4b 46 7f ff 0e 10 57 t=23125\n"
 */

/** 85 °C is the DS18B20's power-on value, read before a conversion finished: not a reading. */
const POWER_ON_MILLI = 85_000;
/** −127 °C is what the driver reports for a disconnected probe. */
const DISCONNECTED_MILLI = -127_000;

export class ProbeReadError extends Error {
  override name = 'ProbeReadError';
}

export function parseW1Temperature(text: string, file: 'temperature' | 'w1_slave'): number {
  let milli: number;
  if (file === 'temperature') {
    milli = Number(text.trim());
    if (!Number.isInteger(milli))
      throw new ProbeReadError(`unreadable temperature "${text.trim()}"`);
  } else {
    const [crcLine = '', valueLine = ''] = text.trim().split('\n');
    if (!/crc=[0-9a-f]{2} YES$/i.test(crcLine.trim()))
      throw new ProbeReadError('CRC check failed (noisy wiring?)');
    const match = /t=(-?\d+)\s*$/.exec(valueLine);
    if (!match) throw new ProbeReadError('no t= value in w1_slave');
    milli = Number(match[1]);
  }
  if (milli === POWER_ON_MILLI)
    throw new ProbeReadError('read 85 °C power-on value (conversion not finished)');
  if (milli <= DISCONNECTED_MILLI) throw new ProbeReadError('probe reports −127 °C (disconnected)');
  return Math.round(milli / 100) / 10;
}
