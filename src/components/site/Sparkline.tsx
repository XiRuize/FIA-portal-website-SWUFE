import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface SparklineProps {
  values: number[];
  /** 涨为 true（决定描边色），默认由首尾大小推断 */
  up?: boolean;
  className?: string;
  width?: number;
  height?: number;
  /** 是否绘制端点圆点 */
  dot?: boolean;
}

/**
 * 迷你走势线：股票池 / 行情条上的微型图表。
 *
 * 无坐标轴、无内边距，纯形状，用于快速扫读趋势。
 */
export function Sparkline({
  values,
  up,
  className,
  width = 64,
  height = 22,
  dot = false,
}: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return null;
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || max * 0.05 || 1;
    const stepX = width / (values.length - 1);
    const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
    let d = '';
    values.forEach((v, i) => {
      d += `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return { d, lastY: y(values[values.length - 1]), lastX: width };
  }, [values, width, height]);

  if (!path) return null;

  // 与蜡烛图保持同一套红涨绿跌配色（白底下取略深的红绿保证对比度）
  const rising = up ?? values[values.length - 1] >= values[0];
  const color = rising ? '#e23b2e' : '#10a36e';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden
    >
      <path
        d={path.d}
        fill='none'
        stroke={color}
        strokeWidth='1.4'
        strokeLinecap='round'
        strokeLinejoin='round'
        opacity='0.9'
      />
      {dot ? (
        <circle cx={path.lastX} cy={path.lastY} r='2' fill={color} />
      ) : null}
    </svg>
  );
}

export default Sparkline;
