import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

// Tree-shaken: only what the dashboard draws (docs/05). Bar charts join with the Energy page.
echarts.use([
  LineChart,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
]);

export type ChartOption = echarts.EChartsCoreOption;

/** Owns one ECharts instance: created once, resized with its box, disposed on unmount. */
export function EChart({
  option,
  height,
  ariaLabel,
  className,
}: {
  option: ChartOption;
  height: number;
  ariaLabel: string;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const instance = echarts.init(node, undefined, { renderer: 'svg' });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={el}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ height, width: '100%' }}
    />
  );
}
