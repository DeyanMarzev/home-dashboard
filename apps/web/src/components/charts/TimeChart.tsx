import { formatLondonDayMonth, formatLondonTime, formatNumber, formatWhen } from '@home/shared';
import { useMemo } from 'react';
import { EChart, type ChartOption } from './EChart.js';
import { token } from './theme.js';

export interface LineSeries {
  name: string;
  points: readonly (readonly [string, number])[];
  color: string;
  dashed?: boolean;
  /** Draw as steps (e.g. a thermostat target). */
  step?: boolean;
}

export interface TimeChartProps {
  series: LineSeries[];
  unit: string;
  /** Decimal places in labels and tooltips. */
  digits?: number;
  /** Dashed horizontal reference line, e.g. 80 °C or 1,000 ppm. */
  reference?: { value: number; color: string };
  /** Shaded spans, e.g. boiler firing: [start, end] ISO times. */
  bands?: readonly (readonly [string, string])[];
  /** Label times as HH:mm (≤ 2 days) or as dates. */
  spanSeconds: number;
  height?: number;
  ariaLabel: string;
}

/** Multi-series line chart over time (LineChart in docs/05), themed from the tokens. */
export function TimeChart({
  series,
  unit,
  digits = 1,
  reference,
  bands,
  spanSeconds,
  height = 232,
  ariaLabel,
}: TimeChartProps) {
  const option = useMemo<ChartOption>(() => {
    const muted = token('--text-muted');
    const axisLabel = (value: number) => {
      const d = new Date(value);
      return spanSeconds <= 2 * 86400 ? formatLondonTime(d) : formatLondonDayMonth(d);
    };
    return {
      animation: false,
      grid: { left: 40, right: 14, top: 10, bottom: 26 },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: token('--border-strong') } },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11, formatter: axisLabel, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitNumber: 4,
        // Keep a reference line (e.g. 80 °C throttling) on the chart even when the data is far below it.
        ...(reference
          ? { max: (v: { max: number }) => Math.ceil(Math.max(v.max, reference.value) + 1) }
          : {}),
        axisLabel: {
          color: muted,
          fontSize: 11,
          formatter: (v: number) => `${formatNumber(v, 0)}${unit === '°C' ? '°' : ''}`,
        },
        splitLine: { lineStyle: { color: token('--grid') } },
      },
      tooltip: {
        trigger: 'axis',
        textStyle: { fontFamily: 'inherit', fontSize: 12 },
        formatter: (
          params: {
            axisValue: number;
            marker: string;
            seriesName: string;
            value: [string, number];
          }[],
        ) =>
          [
            formatWhen(new Date(params[0]?.axisValue ?? 0)),
            ...params.map(
              (p) => `${p.marker}${p.seriesName}: ${formatNumber(p.value[1], digits)} ${unit}`,
            ),
          ].join('<br>'),
      },
      series: series.map((s, i) => ({
        type: 'line',
        name: s.name,
        data: s.points.map(([t, v]) => [t, v]),
        showSymbol: false,
        step: s.step ? 'end' : false,
        lineStyle: {
          color: s.color,
          width: s.dashed ? 1.5 : 2.5,
          type: s.dashed ? [5, 4] : 'solid',
        },
        itemStyle: { color: s.color },
        emphasis: { disabled: true },
        // Reference line and bands hang off the first series.
        ...(i === 0 && reference
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                label: { show: false },
                lineStyle: { color: reference.color, type: [5, 4], width: 1.5 },
                data: [{ yAxis: reference.value }],
              },
            }
          : {}),
        ...(i === 0 && bands?.length
          ? {
              markArea: {
                silent: true,
                itemStyle: { color: token('--heat-band') },
                data: bands.map(([from, to]) => [{ xAxis: from }, { xAxis: to }]),
              },
            }
          : {}),
      })),
    };
  }, [series, unit, digits, reference, bands, spanSeconds]);

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
