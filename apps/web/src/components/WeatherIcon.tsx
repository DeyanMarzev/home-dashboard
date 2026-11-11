import { describeWeather, weatherKind } from '@home/shared';

/** Stroke icons in the style of icons.tsx, coloured from the tokens. */
const stroke = {
  fill: 'none',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const SUN = 'var(--warn)';
const CLOUD = 'var(--chart-muted)';
const WET = 'var(--cool)';

/** A cloud whose base sits at y = `base` (24-unit box). */
const cloud = (base: number) =>
  `M7.5 ${base}h9a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7.3 ${base - 6.4}a3.2 3.2 0 0 0 .2 6.4z`;

function Sun({ cx = 12, cy = 12, r = 4, rays = 3 }) {
  const lines = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    return `M${cx + c * (r + 2)} ${cy + s * (r + 2)}L${cx + c * (r + 2 + rays)} ${cy + s * (r + 2 + rays)}`;
  });
  return (
    <g stroke={SUN}>
      <circle cx={cx} cy={cy} r={r} />
      <path d={lines.join('')} />
    </g>
  );
}

function Moon({ dx = 0, dy = 0, scale = 1 }) {
  return (
    <path
      stroke="var(--text-secondary)"
      transform={`translate(${dx} ${dy}) scale(${scale})`}
      d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"
    />
  );
}

/**
 * The weather for a WMO code, day or night. Decorative by default (the condition is written
 * next to it); pass `labelled` where the icon stands alone.
 */
export function WeatherIcon({
  code,
  isDay = true,
  size = 24,
  labelled = false,
}: {
  code: number;
  isDay?: boolean;
  size?: number;
  labelled?: boolean;
}) {
  const kind = weatherKind(code);
  const a11y = labelled
    ? { role: 'img', 'aria-label': describeWeather(code) }
    : { 'aria-hidden': true };
  let body;
  switch (kind) {
    case 'clear':
      body = isDay ? <Sun /> : <Moon />;
      break;
    case 'partly_cloudy':
      body = (
        <>
          {isDay ? <Sun cx={8.5} cy={8.5} r={3} rays={2} /> : <Moon dx={-2} dy={-2} scale={0.7} />}
          <path stroke={CLOUD} fill="var(--surface)" d={cloud(20)} />
        </>
      );
      break;
    case 'cloudy':
      body = <path stroke={CLOUD} d={cloud(18)} />;
      break;
    case 'fog':
      body = (
        <>
          <path stroke={CLOUD} d={cloud(13)} />
          <path stroke={CLOUD} d="M5 16.5h14M7 20h10" />
        </>
      );
      break;
    case 'drizzle':
      body = (
        <>
          <path stroke={CLOUD} d={cloud(14)} />
          <path stroke={WET} d="M8.5 17.5v1M12 18.5v1M15.5 17.5v1" />
        </>
      );
      break;
    case 'rain':
      body = (
        <>
          <path stroke={CLOUD} d={cloud(14)} />
          <path stroke={WET} d="M9 17l-1 3M12.5 17l-1 3M16 17l-1 3" />
        </>
      );
      break;
    case 'snow':
      body = (
        <>
          <path stroke={CLOUD} d={cloud(14)} />
          <path
            stroke={WET}
            d="M8.5 18.5h.01M12 20.5h.01M15.5 18.5h.01M10.2 21.5h.01M13.8 17.5h.01"
          />
        </>
      );
      break;
    case 'thunder':
      body = (
        <>
          <path stroke={CLOUD} d={cloud(14)} />
          <path stroke={SUN} d="M12.5 15l-2 3.5h3l-2 3.5" />
        </>
      );
      break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke} {...a11y}>
      {body}
    </svg>
  );
}
