import { formatNumber } from '@home/shared';
import { useMemo } from 'react';
import { EChart, type ChartOption } from './EChart.js';
import { token, tooltipStyle } from './theme.js';

export interface HourSeries {
  name: string;
  /** 24 values, index = hour of the day (London); null where there's no data. */
  values: readonly (number | null)[];
  color: string;
  dashed?: boolean;
}

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/** Lines over the hours of a typical day (00:00–23:00), e.g. average humidity by hour. */
export function HourChart({
  series,
  unit,
  digits = 0,
  valueBand,
  height = 220,
  ariaLabel,
}: {
  series: HourSeries[];
  unit: string;
  digits?: number;
  valueBand?: { from: number; to: number; color: string };
  height?: number;
  ariaLabel: string;
}) {
  const option = useMemo<ChartOption>(() => {
    const muted = token('--text-muted');
    return {
      animation: false,
      grid: { left: 40, right: 14, top: 10, bottom: 26 },
      xAxis: {
        type: 'category',
        data: HOURS,
        boundaryGap: false,
        axisLine: { lineStyle: { color: token('--border-strong') } },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11, interval: 2, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitNumber: 4,
        axisLabel: { color: muted, fontSize: 11, formatter: (v: number) => formatNumber(v, 0) },
        splitLine: { lineStyle: { color: token('--grid') } },
      },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(),
        formatter: (
          params: { name: string; marker: string; seriesName: string; value: number | null }[],
        ) =>
          [
            `Around ${params[0]?.name ?? ''}`,
            ...params
              .filter((p) => p.value !== null && p.value !== undefined)
              .map((p) => `${p.marker}${p.seriesName}: ${formatNumber(p.value!, digits)} ${unit}`),
          ].join('<br>'),
      },
      series: series.map((s, i) => ({
        type: 'line',
        name: s.name,
        data: [...s.values],
        showSymbol: false,
        connectNulls: true,
        smooth: 0.3,
        lineStyle: {
          color: s.color,
          width: s.dashed ? 1.5 : 2.5,
          type: s.dashed ? [5, 4] : 'solid',
        },
        itemStyle: { color: s.color },
        emphasis: { disabled: true },
        ...(i === 0 && valueBand
          ? {
              markArea: {
                silent: true,
                itemStyle: { color: valueBand.color },
                data: [[{ yAxis: valueBand.from }, { yAxis: valueBand.to }]],
              },
            }
          : {}),
      })),
    };
  }, [series, unit, digits, valueBand]);

  return <EChart option={option} height={height} ariaLabel={ariaLabel} />;
}
