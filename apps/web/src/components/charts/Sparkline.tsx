import { useMemo } from 'react';
import { EChart, type ChartOption } from './EChart.js';
import { token } from './theme.js';

/** A 56 px trend line with an optional dashed threshold (Sparkline in docs/05). */
export function Sparkline({
  points,
  color,
  threshold,
  ariaLabel,
}: {
  points: readonly (readonly [string, number])[];
  color: string;
  threshold?: number;
  ariaLabel: string;
}) {
  const option = useMemo<ChartOption>(() => {
    const values = points.map(([, v]) => v);
    const lo = Math.min(...values, threshold ?? Infinity);
    const hi = Math.max(...values, threshold ?? -Infinity);
    const pad = (hi - lo) * 0.12 || 1;
    return {
      animation: false,
      grid: { left: 0, right: 0, top: 4, bottom: 4 },
      xAxis: { type: 'time', show: false },
      yAxis: { type: 'value', show: false, min: lo - pad, max: hi + pad },
      series: [
        {
          type: 'line',
          data: points.map(([t, v]) => [t, v]),
          showSymbol: false,
          silent: true,
          lineStyle: { color, width: 2 },
          ...(threshold !== undefined
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { color: token('--chart-muted'), type: [4, 3], width: 1 },
                  data: [{ yAxis: threshold }],
                },
              }
            : {}),
        },
      ],
    };
  }, [points, color, threshold]);

  return <EChart option={option} height={56} ariaLabel={ariaLabel} className="spark-chart" />;
}
