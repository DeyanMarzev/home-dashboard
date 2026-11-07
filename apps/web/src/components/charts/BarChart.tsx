import { useMemo } from 'react';
import { EChart, type ChartOption } from './EChart.js';
import { token } from './theme.js';

export interface Bar {
  label: string;
  value: number;
  /** Text above the bar (shown for up to 14 bars, docs/05). */
  valueLabel?: string;
}

/** Single-series bar chart with optional value labels and a dashed reference line (BarChart in docs/05). */
export function BarChart({
  bars,
  color,
  reference,
  height = 180,
  ariaLabel,
}: {
  bars: Bar[];
  color: string;
  reference?: number;
  height?: number;
  ariaLabel: string;
}) {
  const option = useMemo<ChartOption>(() => {
    const muted = token('--text-muted');
    return {
      animation: false,
      grid: { left: 4, right: 4, top: 22, bottom: 22 },
      xAxis: {
        type: 'category',
        data: bars.map((b) => b.label),
        axisLine: { lineStyle: { color: token('--border-strong') } },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        show: false,
        max: (v: { max: number }) => Math.max(v.max, reference ?? 0) * 1.08 || 1,
      },
      series: [
        {
          type: 'bar',
          data: bars.map((b) => b.value),
          barCategoryGap: '28%',
          itemStyle: { color, borderRadius: [4, 4, 0, 0] },
          silent: true,
          label: {
            show: bars.length <= 14,
            position: 'top',
            color: token('--text'),
            fontSize: 11,
            fontWeight: 600,
            formatter: (p: { dataIndex: number }) =>
              bars[p.dataIndex]?.valueLabel ?? String(bars[p.dataIndex]?.value ?? ''),
          },
          ...(reference !== undefined
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
        },
      ],
    };
  }, [bars, color, reference]);

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
