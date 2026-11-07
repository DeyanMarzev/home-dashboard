import { linearFit } from '@home/shared';
import { useMemo } from 'react';
import { EChart, type ChartOption } from './EChart.js';
import { token } from './theme.js';

/** Scatter with a dashed least-squares trend line (ScatterChart in docs/05). */
export function ScatterChart({
  points,
  color,
  xUnit,
  yUnit,
  xName,
  height = 240,
  ariaLabel,
}: {
  points: readonly (readonly [number, number])[];
  color: string;
  xUnit: string;
  yUnit: string;
  xName: string;
  height?: number;
  ariaLabel: string;
}) {
  const option = useMemo<ChartOption>(() => {
    const muted = token('--text-muted');
    const fit = linearFit(points);
    const xs = points.map(([x]) => x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return {
      animation: false,
      grid: { left: 40, right: 14, top: 18, bottom: 40 },
      xAxis: {
        type: 'value',
        scale: true,
        name: xName,
        nameLocation: 'middle',
        nameGap: 26,
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLabel: { color: muted, fontSize: 11, formatter: (v: number) => `${v} ${xUnit}` },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: token('--border-strong') } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        name: yUnit,
        nameTextStyle: { color: muted, fontSize: 11 },
        axisLabel: { color: muted, fontSize: 11 },
        splitLine: { lineStyle: { color: token('--grid') } },
      },
      series: [
        {
          type: 'scatter',
          data: points.map(([x, y]) => [x, y]),
          symbolSize: 12,
          itemStyle: { color, opacity: 0.85 },
          silent: true,
        },
        ...(fit
          ? [
              {
                type: 'line',
                data: [
                  [lo, fit.intercept + fit.slope * lo],
                  [hi, fit.intercept + fit.slope * hi],
                ],
                showSymbol: false,
                silent: true,
                lineStyle: { color: token('--text-secondary'), type: [5, 4], width: 1.5 },
              },
            ]
          : []),
      ],
    };
  }, [points, color, xUnit, yUnit, xName]);

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
