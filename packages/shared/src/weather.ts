/** WMO weather interpretation codes (as Open-Meteo returns them) → short English text. */
const WMO: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

export function describeWeather(code: number): string {
  return WMO[code] ?? `Weather code ${code}`;
}

export type WeatherKind =
  'clear' | 'partly_cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder';

/** WMO code → the kind of weather an icon shows. Unknown codes count as cloudy. */
export function weatherKind(code: number): WeatherKind {
  if (code <= 1) return 'clear';
  if (code === 2) return 'partly_cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunder';
  return 'cloudy';
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** Wind direction (degrees, where it blows FROM) → one of 16 compass points. */
export function compassPoint(degrees: number): string {
  const i = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[i]!;
}
