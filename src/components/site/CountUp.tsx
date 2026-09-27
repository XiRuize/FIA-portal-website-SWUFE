import { useEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion, useInView } from '@/lib/useInView';
import { cn } from '@/lib/utils';

interface CountUpProps {
  /** 目标值，可以是 `"1200+"`、`"2015"`、`"98.6"` 这类带前后缀的字符串 */
  value: string;
  className?: string;
  /** 动画时长（毫秒） */
  duration?: number;
  /** 小数位；不传则按原字符串推断 */
  decimals?: number;
}

/** 把 `"1,200+ 名"` 拆成 前缀 / 数字 / 后缀 */
function parseValue(raw: string) {
  const match = raw.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const numericText = match[0];
  const decimals = numericText.includes('.')
    ? numericText.split('.')[1].length
    : 0;
  const target = Number(numericText.replace(/,/g, ''));
  if (!Number.isFinite(target)) return null;
  return {
    prefix: raw.slice(0, match.index ?? 0),
    suffix: raw.slice((match.index ?? 0) + numericText.length),
    target,
    decimals,
    grouped: numericText.includes(','),
  };
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * 数字滚动：进入视口后从 0 递增到目标值。
 *
 * 非数字内容（如「筹建中」）会原样展示，不做动画。
 */
export function CountUp({
  value,
  className,
  duration = 1500,
  decimals,
}: CountUpProps) {
  const { ref, inView } = useInView<HTMLSpanElement>({ threshold: 0.3 });
  const parsed = useMemo(() => parseValue(value), [value]);
  const [current, setCurrent] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!parsed) return;
    if (!inView) return;

    if (prefersReducedMotion()) {
      setCurrent(parsed.target);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setCurrent(parsed.target * easeOutExpo(progress));
      if (progress < 1) {
        frame.current = window.requestAnimationFrame(tick);
      } else {
        setCurrent(parsed.target);
      }
    };
    frame.current = window.requestAnimationFrame(tick);

    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, [inView, parsed, duration]);

  if (!parsed) {
    return (
      <span ref={ref} className={className}>
        {value}
      </span>
    );
  }

  const digits = decimals ?? parsed.decimals;
  const display = parsed.grouped
    ? current.toLocaleString('zh-CN', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : current.toFixed(digits);

  return (
    <span ref={ref} className={cn('num tabular-nums', className)}>
      {parsed.prefix}
      {display}
      {parsed.suffix}
    </span>
  );
}

export default CountUp;
