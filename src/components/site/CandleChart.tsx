import { useCallback, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Kline } from '@/lib/stockApi';
import { MA_COLORS, movingAverage } from '@/lib/stockApi';
import { cn } from '@/lib/utils';

interface CandleChartProps {
  klines: Kline[];
  /** viewBox 高度 */
  height?: number;
  /** 要绘制的均线窗口，如 [5, 10, 20] */
  maWindows?: number[];
  className?: string;
}

/** viewBox 宽度（配合 `w-full` 自适应缩放） */
const W = 1000;
/** 左 / 右 / 上 / 下留白 */
const PAD = { left: 6, right: 62, top: 14, bottom: 22 };
/** 价格主图占整体高度的比例，其余留给成交量副图 */
const PRICE_PANEL_RATIO = 0.74;
/** 副图与主图之间的间隙 */
const PANEL_GAP = 26;

/** A 股习惯：红涨绿跌。白底下用略深的红绿，保证对比度 */
const UP = '#e23b2e';
const DOWN = '#10a36e';

/** 网格 / 坐标轴 / 十字光标的浅色配色 */
const GRID = 'rgba(20,20,20,0.07)';
const AXIS_TEXT = 'rgba(20,20,20,0.45)';
const RULE = 'rgba(20,20,20,0.12)';
const CROSSHAIR = 'rgba(248,87,74,0.45)';
const CROSSHAIR_BAND = 'rgba(248,87,74,0.07)';

const fmtPrice = (v: number) => v.toFixed(2);

/**
 * 成交量格式化。
 *
 * ⚠️ 源值单位是**手**（1 手 = 100 股）。原来只输出「万/亿」不带单位，
 * 读者会把 4.53 万手误读成 4.53 万股（差 100 倍），故这里统一补上「手」字。
 */
const fmtVolume = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1e4 ? `${(n / 1e4).toFixed(2)}万手` : `${Math.round(n)}手`;
};

/** 生成折线 path，遇到 null 断开 */
function linePath(
  points: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number
): string {
  let d = '';
  let started = false;
  points.forEach((p, i) => {
    if (p === null || !Number.isFinite(p)) {
      started = false;
      return;
    }
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`;
    started = true;
  });
  return d;
}

/**
 * 蜡烛图（K 线）主图。
 *
 * - 红涨绿跌（A 股习惯）：阳线渐变亮、阴线渐变暗；
 * - 主图下方叠加成交量副图，柱色跟随当根 K 线方向；
 * - 鼠标 / 触摸移动时显示十字光标与悬浮明细（开高低收、涨跌幅、成交量）；
 * - 右侧固定「最新价」标线，方便一眼看到当前价位。
 *
 * 全部用 SVG + 少量 HTML 浮层实现，不引入任何图表依赖。
 */
export function CandleChart({
  klines,
  height = 380,
  maWindows = [5, 10, 20],
  className,
}: CandleChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const n = klines.length;
    const priceH = Math.round((height - PAD.top - PAD.bottom) * PRICE_PANEL_RATIO);
    const priceTop = PAD.top;
    const priceBottom = PAD.top + priceH;
    const volTop = priceBottom + PANEL_GAP;
    const volBottom = height - PAD.bottom;
    const volH = Math.max(24, volBottom - volTop);

    const innerW = W - PAD.left - PAD.right;
    const step = n > 0 ? innerW / n : innerW;
    const x = (i: number) => PAD.left + step * (i + 0.5);
    // 蜡烛实体占步长比例：参照 lightweight-charts 的 barSpacing 惯例，
    // 实体:间隙 ≈ 5:1；太密时退化为细线保证可辨。
    const bodyW = Math.max(1, Math.min(14, step * 0.72));

    // 价格轴范围：把均线也纳入，避免均线被裁切
    const maSeries = maWindows.map((w) =>
      movingAverage(klines.map((k) => k.close), w)
    );
    const values: number[] = [];
    klines.forEach((k) => {
      values.push(k.high, k.low);
    });
    maSeries.forEach((s) => s.forEach((v) => v !== null && values.push(v)));

    const max = values.length ? Math.max(...values) : 1;
    const min = values.length ? Math.min(...values) : 0;
    const span = max - min || max * 0.1 || 1;
    const top = max + span * 0.06;
    const bottom = min - span * 0.06;
    const y = (v: number) => priceTop + ((top - v) / (top - bottom || 1)) * priceH;

    const volMax = Math.max(...klines.map((k) => k.volume), 1);
    const volY = (v: number) => volBottom - (v / volMax) * volH;

    // 5 条价格网格
    const gridValues = [0, 0.25, 0.5, 0.75, 1].map(
      (r) => bottom + (top - bottom) * r
    );

    // x 轴日期刻度：最多 6 个
    const tickCount = Math.min(6, n);
    const tickIndexes = Array.from({ length: tickCount }, (_, i) =>
      tickCount === 1 ? 0 : Math.round((i / (tickCount - 1)) * (n - 1))
    ).filter((v, i, arr) => arr.indexOf(v) === i);

    const last = klines[n - 1];
    const prev = n > 1 ? klines[n - 2] : last;
    const lastUp = !last || !prev ? true : last.close >= prev.close;

    return {
      n, priceTop, priceBottom, volTop, volBottom, volH,
      x, y, volY, bodyW, step, gridValues, tickIndexes,
      maSeries, last, lastUp,
    };
  }, [klines, height, maWindows]);

  /** 把鼠标位置换算成 K 线下标 */
  const indexAt = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg || geom.n === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return null;
      const vx = ((clientX - rect.left) / rect.width) * W;
      const raw = Math.floor((vx - PAD.left) / geom.step);
      return Math.max(0, Math.min(geom.n - 1, raw));
    },
    [geom.n, geom.step]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      setHover(indexAt(e.clientX));
    },
    [indexAt]
  );

  if (!klines.length) {
    return (
      <div className='flex h-56 items-center justify-center text-sm text-ink-400'>
        暂无行情数据
      </div>
    );
  }

  const { n, x, y, volY, bodyW, gridValues, tickIndexes, maSeries, last, lastUp } =
    geom;
  const activeIndex = hover ?? n - 1;
  const active = klines[activeIndex];
  const activePrev = activeIndex > 0 ? klines[activeIndex - 1] : active;
  const activeChange = active.close - activePrev.close;
  const activeChangePct = activePrev.close
    ? (activeChange / activePrev.close) * 100
    : 0;
  const activeUp = activeChange >= 0;

  // 悬浮明细浮层位置（百分比定位，跟随自适应宽度）
  const tipLeftPct = (x(activeIndex) / W) * 100;
  const tipTopPct = (y(active.close) / height) * 100;
  const flip = tipLeftPct > 58;

  return (
    <div className={cn('relative select-none', className)}>
      {/* 均线图例 */}
      <div className='num pointer-events-none absolute left-2 top-1 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]'>
        {maWindows.map((w, i) => {
          const value = maSeries[i]?.[activeIndex];
          return (
            <span key={w} className='inline-flex items-center gap-1'>
              <span
                className='inline-block h-0.5 w-3 rounded-full'
                style={{ background: MA_COLORS[w] ?? '#6f6f6f' }}
              />
              <span className='text-ink-400'>MA{w}</span>
              <span className='text-ink-700'>
                {value == null ? '—' : fmtPrice(value)}
              </span>
            </span>
          );
        })}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        className='w-full touch-pan-y'
        style={{ height }}
        role='img'
        aria-label={`${active.date} 蜡烛图，收盘 ${fmtPrice(active.close)}`}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id='candle-up' x1='0' y1='0' x2='0' y2='1'>
            <stop offset='0%' stopColor={UP} stopOpacity='0.95' />
            <stop offset='100%' stopColor={UP} stopOpacity='0.6' />
          </linearGradient>
          <linearGradient id='candle-down' x1='0' y1='0' x2='0' y2='1'>
            <stop offset='0%' stopColor={DOWN} stopOpacity='0.95' />
            <stop offset='100%' stopColor={DOWN} stopOpacity='0.6' />
          </linearGradient>
        </defs>

        {/* 价格网格 + 右侧刻度 */}
        {gridValues.map((v) => (
          <g key={`grid-${v}`}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke={GRID}
              strokeDasharray='2 4'
            />
            <text
              x={W - PAD.right + 8}
              y={y(v) + 3.5}
              fontSize='11'
              className='num'
              fill={AXIS_TEXT}
            >
              {fmtPrice(v)}
            </text>
          </g>
        ))}

        {/* 十字光标（置于蜡烛之下，避免遮挡实体） */}
        {hover !== null ? (
          <>
            <rect
              x={x(hover) - geom.step / 2}
              y={geom.priceTop}
              width={geom.step}
              height={geom.volBottom - geom.priceTop}
              fill={CROSSHAIR_BAND}
            />
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(active.close)}
              y2={y(active.close)}
              stroke={CROSSHAIR}
              strokeDasharray='4 4'
            />
          </>
        ) : null}

        {/* 成交量副图 */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={geom.volBottom}
          y2={geom.volBottom}
          stroke={RULE}
        />
        {klines.map((k, i) => {
          const prevClose = i > 0 ? klines[i - 1].close : k.open;
          const up = k.close >= prevClose;
          const top = volY(k.volume);
          return (
            <rect
              key={`vol-${k.date}-${i}`}
              x={x(i) - bodyW / 2}
              y={top}
              width={bodyW}
              height={Math.max(geom.volBottom - top, 0.6)}
              fill={up ? UP : DOWN}
              opacity={hover === null || hover === i ? 0.42 : 0.18}
            />
          );
        })}
        <text x={PAD.left + 2} y={geom.volTop - 6} fontSize='10' fill={AXIS_TEXT}>
          成交量
        </text>

        {/* 蜡烛主体 + 影线 */}
        {klines.map((k, i) => {
          const prevClose = i > 0 ? klines[i - 1].close : k.open;
          const up = k.close >= prevClose;
          const color = up ? 'url(#candle-up)' : 'url(#candle-down)';
          const stroke = up ? UP : DOWN;
          const bodyTop = y(Math.max(k.open, k.close));
          const bodyBottom = y(Math.min(k.open, k.close));
          const bodyH = Math.max(bodyBottom - bodyTop, 1);
          return (
            <g
              key={`candle-${k.date}-${i}`}
              opacity={hover === null || hover === i ? 1 : 0.5}
            >
              <line
                x1={x(i)}
                x2={x(i)}
                y1={y(k.high)}
                y2={y(k.low)}
                stroke={stroke}
                strokeWidth='1'
              />
              <rect
                x={x(i) - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyH}
                fill={color}
                stroke={stroke}
                strokeWidth='0.6'
                rx='0.8'
              />
            </g>
          );
        })}

        {/* 均线 */}
        {maSeries.map((series, i) => (
          <path
            key={`ma-${maWindows[i]}`}
            d={linePath(series, x, y)}
            fill='none'
            stroke={MA_COLORS[maWindows[i]] ?? '#6f6f6f'}
            strokeWidth='1.3'
            strokeLinejoin='round'
            opacity='0.85'
          />
        ))}

        {/* 最新价标线 */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(last.close)}
          y2={y(last.close)}
          stroke={lastUp ? UP : DOWN}
          strokeWidth='0.9'
          strokeDasharray='6 4'
          opacity='0.7'
        />
        <g>
          <rect
            x={W - PAD.right + 3}
            y={y(last.close) - 8}
            width={PAD.right - 6}
            height={16}
            rx='3'
            fill={lastUp ? UP : DOWN}
          />
          <text
            x={W - PAD.right + 3 + (PAD.right - 6) / 2}
            y={y(last.close) + 3.5}
            fontSize='10.5'
            textAnchor='middle'
            className='num'
            fill='#ffffff'
            fontWeight='600'
          >
            {fmtPrice(last.close)}
          </text>
        </g>

        {/* x 轴日期 */}
        {tickIndexes.map((i) => (
          <text
            key={`x-${i}`}
            x={x(i)}
            y={height - 6}
            fontSize='10.5'
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            className='num'
            fill={AXIS_TEXT}
          >
            {klines[i].date.slice(5)}
          </text>
        ))}
      </svg>

      {/* 悬浮明细 */}
      {hover !== null ? (
        <div
          className='pointer-events-none absolute z-20 w-max rounded-md border border-ink-900/[0.08] bg-white/95 px-3 py-2 shadow-card backdrop-blur'
          style={{
            left: `${tipLeftPct}%`,
            top: `${tipTopPct}%`,
            transform: `translate(${flip ? 'calc(-100% - 14px)' : '14px'}, -50%)`,
          }}
        >
          <p className='num text-[11px] text-ink-400'>{active.date}</p>
          <div className='mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]'>
            <Row label='开' value={fmtPrice(active.open)} />
            <Row label='高' value={fmtPrice(active.high)} />
            <Row label='低' value={fmtPrice(active.low)} />
            <Row
              label='收'
              value={fmtPrice(active.close)}
              tone={activeUp ? 'up' : 'down'}
            />
          </div>
          <div className='mt-1.5 flex items-center justify-between gap-3 border-t border-ink-900/[0.08] pt-1.5 text-[11px]'>
            <span className='num text-ink-400'>{fmtVolume(active.volume)}</span>
            <span
              className={cn(
                'num font-semibold',
                activeUp ? 'text-bull' : 'text-bear'
              )}
            >
              {activeUp ? '+' : ''}
              {activeChange.toFixed(2)} ({activeUp ? '+' : ''}
              {activeChangePct.toFixed(2)}%)
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface RowProps {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}

function Row({ label, value, tone }: RowProps) {
  return (
    <span className='flex items-center gap-2'>
      <span className='text-ink-400'>{label}</span>
      <span
        className={cn(
          'num',
          tone === 'up' && 'text-bull',
          tone === 'down' && 'text-bear',
          !tone && 'text-ink-800'
        )}
      >
        {value}
      </span>
    </span>
  );
}

export default CandleChart;
