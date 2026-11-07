import { useMemo } from 'react';
import { EChart, type ChartOption } from './EChart.js';
import { token } from './theme.js';

export interface BarSeries {
  name: string;
  color: string;
  values: (number | null)[];
}

/**
 * Bar chart (BarChart in docs/05): one series, or several stacked. Value labels on top for
 * up to 14 bars; optional dashed reference line (average, baseload).
 */
export function BarChart({
  labels,
  series,
  valueLabels,
  reference,
  formatAxis,
  height = 180,
  ariaLabel,
}: {
  labels: string[];
  series: BarSeries[];
  /** Text above each bar (or stack). */
  valueLabels?: string[];
  reference?: number;
  /** Show a value axis with this formatter (e.g. "£4"); hidden by default. */
  formatAxis?: (v: number) => string;
  height?: number;
  ariaLabel: string;
}) {
  const option = useMemo<ChartOption>(() => {
    const muted = token('--text-muted');
    const stacked = series.length > 1;
    return {
      animation: false,
      grid: { left: formatAxis ? 40 : 4, right: 4, top: valueLabels ? 22 : 10, bottom: 22 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLine: { lineStyle: { color: token('--border-strong') } },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        show: !!formatAxis,
        splitNumber: 3,
        axisLabel: { color: muted, fontSize: 11, formatter: formatAxis },
        splitLine: { lineStyle: { color: token('--grid') } },
        // Only force the top when a reference line must fit; otherwise ECharts picks a round one.
        ...(reference !== undefined
          ? { max: (v: { max: number }) => Math.max(v.max, reference) * 1.05 }
          : {}),
      },
      tooltip: stacked
        ? { trigger: 'axis', axisPointer: { type: 'shadow' }, textStyle: { fontSize: 12 } }
        : undefined,
      series: series.map((s, i) => {
        const top = i === series.length - 1;
        return {
          type: 'bar',
          name: s.name,
          data: s.values,
          stack: stacked ? 'total' : undefined,
          barCategoryGap: '28%',
          itemStyle: { color: s.color, borderRadius: top ? [4, 4, 0, 0] : 0 },
          silent: !stacked,
          label: {
            show: top && !!valueLabels && labels.length <= 14,
            position: 'top',
            color: token('--text'),
            fontSize: 11,
            fontWeight: 600,
            formatter: (p: { dataIndex: number }) => valueLabels?.[p.dataIndex] ?? '',
          },
          ...(i === 0 && reference !== undefined
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { color: token('--text-secondary'), type: [4, 4], width: 1 },
                  data: [{ yAxis: reference }],
                },
              }
            : {}),
        };
      }),
    };
  }, [labels, series, valueLabels, reference, formatAxis]);

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
