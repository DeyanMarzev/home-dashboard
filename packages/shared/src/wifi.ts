/** Wi-Fi signal bands used on the Wi-Fi page (docs/05 § Wi-Fi). */
export type SignalQuality = 'excellent' | 'good' | 'fair' | 'poor';

export const SIGNAL_LABELS: Record<SignalQuality, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

/** Excellent ≥ −55 dBm · Good to −67 · Fair to −75 · Poor below. */
export function signalQuality(dBm: number): SignalQuality {
  if (dBm >= -55) return 'excellent';
  if (dBm >= -67) return 'good';
  if (dBm >= -75) return 'fair';
  return 'poor';
}

/** Wi-Fi channel from a frequency in MHz (2.4, 5 and 6 GHz bands); null if not a Wi-Fi frequency. */
export function channelOf(freqMhz: number): { band: '2.4' | '5' | '6'; channel: number } | null {
  const f = Math.round(freqMhz);
  if (f === 2484) return { band: '2.4', channel: 14 };
  if (f >= 2412 && f <= 2472) return { band: '2.4', channel: (f - 2407) / 5 };
  if (f >= 5160 && f <= 5885) return { band: '5', channel: (f - 5000) / 5 };
  if (f >= 5955 && f <= 7115) return { band: '6', channel: (f - 5950) / 5 };
  return null;
}

/** Download/upload speed in Mbit/s from bytes moved and milliseconds taken. */
export function megabitsPerSecond(bytes: number, ms: number): number {
  return ms <= 0 ? 0 : (bytes * 8) / (ms / 1000) / 1_000_000;
}
